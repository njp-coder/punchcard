import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { configPath, dataDir, saveConfig } from '../config.js';
import { parseManualEntry } from '../collectors/manual.js';
import { SLACK_APP_MANIFEST } from '../collectors/slack.js';
import { executePush, planPush, relinkLedger } from '../engine/reconcile.js';
import { isUnassigned } from '../engine/reconstruct.js';
import {
  mappingKey,
  partitionByIssue,
  resolveIssue,
  type IssueCandidate,
} from '../engine/issues.js';
import { getIssueMappings, setIssueMapping } from '../store.js';
import { appendManualSignal, clearOverride, saveAttestation, setOverride } from '../store.js';
import type { DraftEntry, Period } from '../types.js';
import { createAdapter, configStub, ADAPTERS } from '../adapters/index.js';
import { resolvePeriod } from '../util/period.js';
import { startOfDay } from '../util/time.js';
import { PAGE } from './page.js';

export interface SourceCard {
  id: string;
  label: string;
  /**
   * Whether punchcard needs this to work at all. Surfaced because a setup
   * screen that lists six things without saying which matter reads as six
   * chores rather than one requirement and some optional upgrades.
   */
  requirement: 'required' | 'recommended' | 'optional';
  /** 'planned' means there is no code behind it yet — never shown as an option. */
  status: 'connected' | 'available' | 'planned';
  detail: string;
  covers: string;
  setup?: string;
  /** Keep the instructions on screen even once connected, for adding a second. */
  alwaysShowSetup?: boolean;
  /** Worked examples: [what you type, duration read, description recorded]. */
  example?: Array<[string, string | null, string]>;
  /** Names an in-UI connect flow, when one exists. */
  connect?: string;
}

export interface UiOptions {
  cfg: Config;
  port: number;
  buildTimesheet: (cfg: Config, period: Period) => Promise<{
    period: Period;
    entries: DraftEntry[];
    gaps: Array<{ date: string; seconds: number; targetSeconds: number }>;
    unmapped: Array<{ kind: string; value: string; seconds: number }>;
  }>;
}

/**
 * A local review UI.
 *
 * Bound to 127.0.0.1 and gated by a token minted fresh on each launch, because
 * an unauthenticated localhost server is reachable by any page the user happens
 * to have open — a site can't read cross-origin responses, but it can fire
 * requests, and this one can write to a billing system.
 *
 * The server is started by `punch ui` and dies with it. Nothing is hosted,
 * nothing phones home, and every other command still works without it.
 */
/**
 * The UI token, persisted across restarts.
 *
 * Minting a fresh token per launch silently invalidates every open tab and
 * bookmark, so restarting the server — which happens constantly during
 * development — presents as "I can't open the page" with no clue why. The
 * token is a local secret in a 0600 file in the user's own data directory,
 * which is the same trust boundary as the timesheet data sitting beside it.
 */
function loadOrCreateToken(): string {
  const path = join(dataDir(), 'ui-token');

  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (/^[0-9a-f]{32}$/.test(existing)) return existing;
  } catch {
    // No token yet, or unreadable — fall through and mint one.
  }

  const token = randomBytes(16).toString('hex');
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(path, token, { mode: 0o600 });
  } catch {
    // Can't persist it; the session still works, links just won't survive.
  }
  return token;
}

export async function startUi(options: UiOptions): Promise<{ url: string; close: () => void }> {
  const token = loadOrCreateToken();

  const server = createServer((req, res) => {
    handle(req, res, options, token).catch((err: Error) => {
      json(res, 500, { error: err.message });
    });
  });

  const port = await listen(server, options.port);
  return {
    url: `http://127.0.0.1:${port}/?t=${token}`,
    close: () => server.close(),
  };
}

function listen(server: ReturnType<typeof createServer>, preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (port: number, remaining: number) => {
      // Both listeners must be torn down between attempts. Leaving a stale
      // 'listening' callback registered means a later successful bind fires
      // every earlier callback too, and the first one wins the race —
      // reporting a port we never actually bound.
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE' && remaining > 0) attempt(port + 1, remaining - 1);
        else reject(err);
      };

      const onListening = () => {
        server.removeListener('error', onError);
        const address = server.address();
        // Ask the socket what it got, rather than trusting what we asked for.
        resolve(typeof address === 'object' && address ? address.port : port);
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    };

    attempt(preferred, 20);
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: UiOptions,
  token: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }

  if (!url.pathname.startsWith('/api/')) {
    json(res, 404, { error: 'not found' });
    return;
  }

  // Token in a header, not the query string, so it stays out of referrers.
  if (req.headers['x-punchcard-token'] !== token) {
    json(res, 401, { error: 'bad or missing token' });
    return;
  }

  const { cfg, buildTimesheet } = options;

  switch (`${req.method} ${url.pathname}`) {
    case 'GET /api/state': {
      const period = resolvePeriod(cfg.period, url.searchParams.get('period') ?? 'current');
      const result = await buildTimesheet(cfg, period);

      json(res, 200, {
        ...result,
        projects: Object.entries(cfg.projects).map(([id, p]) => ({ id, ...p })),
        targetHoursPerDay: cfg.targetHoursPerDay,
        sources: describeSources(cfg),
        calendars: (cfg.calendars ?? []).map((c, index) => ({
          index,
          name: c.name ?? 'calendar',
        })),
        slackManifest: SLACK_APP_MANIFEST,
        slackFields: [
          { key: 'token', hint: 'User OAuth Token (xoxp-...)', secret: true },
          { key: 'channel', hint: 'optional, defaults to your self-DM' },
        ],
        destinations: ADAPTERS.map((a) => ({
          id: a.id,
          label: a.label,
          blurb: a.blurb,
          stub: configStub(a),
          fields: a.fields,
          configured: Boolean(cfg.adapters[a.id]),
        })),
      });
      return;
    }

    case 'GET /api/issues': {
      const period = resolvePeriod(cfg.period, url.searchParams.get('period') ?? 'current');
      const adapter = createAdapter(cfg, url.searchParams.get('adapter') ?? undefined);

      if (!('listIssues' in adapter)) {
        json(res, 200, { supported: false, entries: [] });
        return;
      }

      const preflight = await adapter.preflight();
      if (!preflight.ok) {
        json(res, 400, { error: preflight.notes.join('; ') });
        return;
      }

      const [result, candidates] = await Promise.all([
        buildTimesheet(cfg, period),
        (adapter as unknown as { listIssues: () => Promise<IssueCandidate[]> }).listIssues(),
      ]);

      const mappings = getIssueMappings();

      // No fallback here, deliberately: this screen exists to find the real
      // ticket, so entries resting on a catch-all must still be offered.
      const entries = result.entries
        .filter((e) => !isUnassigned(e.project))
        .map((e) => ({ entry: e, res: resolveIssue(e, candidates, mappings, e.branch) }))
        .filter(({ res: r }) => r.confidence !== 'certain')
        .map(({ entry: e, res: r }) => ({
          key: e.key,
          date: e.date,
          seconds: e.seconds,
          description: e.description,
          branch: e.branch,
          project: e.project,
          suggestion: r.confidence === 'suggested' ? r.issueKey : undefined,
          alternatives: r.alternatives,
        }));

      json(res, 200, { supported: true, entries, candidateCount: candidates.length });
      return;
    }

    case 'POST /api/issue': {
      const body = await readJson<{
        key: string;
        branch?: string;
        project?: string;
        issueKey: string;
      }>(req);
      const issueKey = (body.issueKey ?? '').trim().toUpperCase();

      if (!/^[A-Z][A-Z0-9]{1,9}-\d+$/.test(issueKey)) {
        json(res, 400, { error: `"${body.issueKey}" is not an issue key, e.g. KAN-13.` });
        return;
      }

      // Remembered against the branch when there is one, otherwise against the
      // project. Passing an empty project here would collapse every branchless
      // entry onto a single mapping key.
      if (!body.project) {
        json(res, 400, { error: 'Missing project; cannot store the assignment safely.' });
        return;
      }

      setIssueMapping(mappingKey({ project: body.project }, body.branch), issueKey);
      json(res, 200, { ok: true });
      return;
    }

    case 'POST /api/entry': {
      const body = await readJson<{
        key: string;
        seconds?: number;
        project?: string;
        description?: string;
        deleted?: boolean;
      }>(req);

      if (body.deleted) setOverride(body.key, { deleted: true });
      else if (body.seconds === undefined && body.project === undefined && !body.description) {
        // An empty patch means "forget my edit" — the entry goes back to
        // tracking evidence.
        clearOverride(body.key);
      } else {
        setOverride(body.key, {
          seconds: body.seconds,
          project: body.project,
          description: body.description,
          ...(body.project ? { billable: cfg.projects[body.project]?.billable ?? true } : {}),
        });
      }

      json(res, 200, { ok: true });
      return;
    }

    case 'POST /api/log': {
      const body = await readJson<{ text: string; date?: string; project?: string }>(req);

      // Same anchoring rule as the CLI: stack retroactive logs backwards from
      // the end of the working day so they don't overlap each other.
      const at = body.date ? startOfDay(body.date) + 17 * 3600 * 1000 : Date.now();
      const signal = parseManualEntry(body.text, { at, project: body.project });

      if (!signal) {
        json(res, 400, { error: `No duration found in "${body.text}". Try "1h sprint review".` });
        return;
      }

      appendManualSignal(signal);
      json(res, 200, { ok: true });
      return;
    }

    case 'POST /api/calendar': {
      const body = await readJson<{ url: string; name?: string }>(req);
      const url = (body.url ?? '').trim();

      if (!/^https?:\/\//.test(url)) {
        json(res, 400, { error: 'That does not look like an iCal URL. It should start with https://' });
        return;
      }

      // Validate before saving: a URL that isn't a calendar should fail here,
      // while the user is looking at it, not silently on the next preview.
      try {
        const probe = await fetch(url, { headers: { Accept: 'text/calendar' } });
        if (!probe.ok) {
          json(res, 400, { error: `The calendar server said ${probe.status} ${probe.statusText}.` });
          return;
        }
        const text = await probe.text();
        if (!text.includes('BEGIN:VCALENDAR')) {
          json(res, 400, {
            error: 'That URL did not return an iCal feed. Check you copied the *secret* address.',
          });
          return;
        }
      } catch (err) {
        json(res, 400, { error: `Could not reach that URL: ${(err as Error).message}` });
        return;
      }

      cfg.calendars = [...(cfg.calendars ?? []), { url, name: body.name?.trim() || 'calendar' }];
      saveConfig(cfg);
      json(res, 200, { ok: true });
      return;
    }

    case 'POST /api/credentials': {
      const body = await readJson<{ target: string; values: Record<string, string> }>(req);
      const values = Object.fromEntries(
        Object.entries(body.values ?? {}).filter(([, v]) => String(v).trim()),
      ) as Record<string, string>;

      if (!Object.keys(values).length) {
        json(res, 400, { error: 'Nothing to save.' });
        return;
      }

      // Written in plain text to the local config, which is the same trust
      // boundary as the timesheet data already sitting beside it. The env:
      // indirection stays available for anyone who commits or shares a config.
      if (body.target === 'slack') {
        cfg.slack = { ...(cfg.slack ?? { token: '' }), ...values } as typeof cfg.slack;
      } else if (ADAPTERS.some((a) => a.id === body.target)) {
        cfg.adapters[body.target] = { ...(cfg.adapters[body.target] ?? {}), ...values };
      } else {
        json(res, 400, { error: `Unknown target "${body.target}".` });
        return;
      }

      saveConfig(cfg);
      json(res, 200, { ok: true, storedAt: configPath() });
      return;
    }

    case 'DELETE /api/calendar': {
      const body = await readJson<{ index: number }>(req);
      const calendars = cfg.calendars ?? [];

      if (body.index < 0 || body.index >= calendars.length) {
        json(res, 400, { error: 'No such calendar.' });
        return;
      }

      cfg.calendars = calendars.filter((_, i) => i !== body.index);
      saveConfig(cfg);
      json(res, 200, { ok: true });
      return;
    }

    case 'POST /api/sync': {
      // Pulling from Slack should not require dropping to a terminal. The
      // capture surface is Slack, the review surface is here; the CLI step in
      // between was an implementation detail leaking into the workflow.
      const { syncSlack } = await import('../collectors/slack.js');
      try {
        const outcome = await syncSlack(cfg);
        json(res, 200, outcome);
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
      return;
    }

    case 'POST /api/test': {
      const body = await readJson<{ adapter: string }>(req);
      try {
        const adapter = createAdapter(cfg, body.adapter);
        const preflight = await adapter.preflight();
        json(res, 200, preflight);
      } catch (err) {
        json(res, 200, { ok: false, notes: [(err as Error).message] });
      }
      return;
    }

    case 'POST /api/map': {
      const body = await readJson<{ source: string; kind: string; project: string }>(req);

      const table =
        body.kind === 'issuePrefix'
          ? cfg.mapping.issuePrefix
          : body.kind === 'meeting'
            ? cfg.mapping.meeting
            : cfg.mapping.repo;

      table[body.source] = body.project;
      cfg.projects[body.project] ??= { name: body.project, billable: true };
      saveConfig(cfg);

      json(res, 200, { ok: true });
      return;
    }

    case 'POST /api/push': {
      const body = await readJson<{ period?: string; adapter?: string; dryRun?: boolean }>(req);
      const period = resolvePeriod(cfg.period, body.period ?? 'current');
      const adapter = createAdapter(cfg, body.adapter);

      const preflight = await adapter.preflight();
      if (!preflight.ok) {
        json(res, 400, { error: preflight.notes.join('; ') });
        return;
      }

      const result = await buildTimesheet(cfg, period);
      let pushable = result.entries.filter((e) => !isUnassigned(e.project));

      // The same issue guard the CLI applies. Without it the UI reported
      // "4 created" for entries the CLI correctly refused, and a real push
      // would have failed every one of them at write time. Review and push
      // must never disagree about what is going to happen.
      let heldForIssue: Array<{ date: string; seconds: number; description: string }> = [];
      let usedFallback: Array<{ date: string; seconds: number; description: string }> = [];

      if ('listIssues' in adapter) {
        const candidates = await (
          adapter as unknown as { listIssues: () => Promise<IssueCandidate[]> }
        ).listIssues();

        const mappings = getIssueMappings();
        const fallback = (adapter as unknown as { fallbackIssue?: string }).fallbackIssue;

        const resolutions = new Map(
          pushable.map((e) => [e.key, resolveIssue(e, candidates, mappings, e.branch, fallback)]),
        );

        const split = partitionByIssue(resolutions, pushable);
        pushable = split.ready;
        usedFallback = split.usedFallback.map((e) => ({
          date: e.date,
          seconds: e.seconds,
          description: e.description,
        }));
        heldForIssue = split.needsIssue.map((e) => ({
          date: e.date,
          seconds: e.seconds,
          description: e.description,
        }));
      }

      if (!pushable.length) {
        json(res, 200, {
          created: 0, updated: 0, removed: 0, respected: 0, failed: [], heldForIssue, usedFallback,
        });
        return;
      }

      const remote = await adapter.listEntries(period);
      relinkLedger(adapter.name, pushable, remote, period);
      const plan = planPush(adapter.name, pushable, remote);

      const outcome = await executePush(adapter, plan, { dryRun: body.dryRun ?? false });

      if (!body.dryRun) {
        saveAttestation({
          period: period.label,
          approvedAt: Date.now(),
          digest: pushable.map((e) => e.key).join(','),
          entryCount: pushable.length,
          totalSeconds: pushable.reduce((sum, e) => sum + e.seconds, 0),
        });
      }

      json(res, 200, { ...outcome, notes: preflight.notes, heldForIssue, usedFallback });
      return;
    }

    default:
      json(res, 404, { error: 'not found' });
  }
}

/**
 * Where evidence comes from, and what each one still needs.
 *
 * Surfaced as first-class setup state because the review grid is meaningless
 * until sources are connected — git alone can only ever explain the hours you
 * spent committing, which is well under half a real working week.
 */
function describeSources(cfg: Config): SourceCard[] {
  const calendars = cfg.calendars ?? [];

  return [
    {
      id: 'git',
      label: 'Git',
      requirement: 'required',
      status: cfg.repos.length ? 'connected' : 'available',
      detail: cfg.repos.length
        ? `${cfg.repos.length} repositories · ${cfg.authors.length} author identity(s)`
        : 'No repositories configured yet.',
      covers: 'What you built, and which project it belongs to',
      setup: 'Set `repos` and `authors` in your config, or run `punch init`.',
    },
    {
      id: 'manual',
      label: 'Quick capture',
      requirement: 'required',
      status: 'connected',
      detail: 'Always on.',
      covers: 'Work that leaves no digital trace: calls, pairing, incidents',
      setup: 'Use `punch log 1h sprint review`, or the box on any unaccounted day.',
    },
    {
      id: 'calendar',
      label: 'Calendar',
      requirement: 'recommended',
      status: calendars.length ? 'connected' : 'available',
      detail: calendars.length
        ? `${calendars.length} calendar feed(s): ${calendars.map((c) => c.name ?? 'ics').join(', ')}`
        : 'Not connected. Meetings are roughly a quarter of most weeks.',
      covers: 'Meetings, which git cannot see',
      setup:
        'Add as many as you like. Google Calendar: Settings, your calendar, ' +
        '"Secret address in iCal format". Outlook: Settings, Calendar, ' +
        'Shared calendars, Publish, then copy the ICS link.',
      alwaysShowSetup: true,
      connect: 'calendar',
    },
    {
      id: 'review',
      label: 'Code review',
      requirement: 'optional',
      status: 'planned',
      detail: 'Will need a GitHub or GitLab token.',
      covers: 'PR reviews. Real work, invisible to your own commits.',
    },
    {
      id: 'editor',
      label: 'WakaTime',
      requirement: 'optional',
      status: 'planned',
      detail: 'Works with self-hosted wakapi too.',
      covers: 'Measured editor time, replacing durations punchcard currently infers',
    },
    {
      id: 'slack',
      label: 'Slack',
      requirement: 'optional',
      status: cfg.slack?.token ? 'connected' : 'available',
      detail: cfg.slack?.token
        ? `Reading ${cfg.slack.channel ? 'a channel' : 'your self-DM'}. Run \`punch sync\` to pull.`
        : 'Not connected. Type or dictate "last one hour helping Priya" and punchcard reads it.',
      covers: 'Logging from where you already are, in your own words',
      connect: 'slack',
      setup:
        'Create the app from the manifest below (Create an App, then "From a ' +
        'manifest"), install it, then open OAuth & Permissions and copy the User ' +
        'OAuth Token starting with xoxp-. Not the Client ID, Client Secret, ' +
        'Signing Secret or Verification Token on Basic Information: those are for ' +
        'apps that receive webhooks, and punchcard only reads.',
      example: [
        ['last one hour helping Priya with the deploy', '1h', 'helping Priya with the deploy'],
        ['spent 2 hours on the migration', '2h', 'the migration'],
        ['half an hour debugging payments', '30m', 'debugging payments'],
        ['I worked on the API today', null, 'skipped: no duration stated'],
      ],
    },
  ];
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  return (text ? JSON.parse(text) : {}) as T;
}
