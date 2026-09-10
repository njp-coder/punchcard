import type { Config } from '../config.js';
import { resolveSecret } from '../config.js';
import { cacheGet, cacheSet } from '../store.js';
import type {
  Adapter,
  DraftEntry,
  Period,
  PreflightResult,
  RemoteEntry,
  RemoteProject,
} from '../types.js';
import { HttpClient, HttpError } from './http.js';

const DEFAULT_BASE = 'https://api.clockify.me/api/v1';

/** Marks entries as ours, so they're identifiable even without the local ledger. */
export const PUNCHCARD_TAG = 'punchcard';

interface ClockifyUser {
  id: string;
  name: string;
  activeWorkspace: string;
  defaultWorkspace: string;
}

interface ClockifyProject {
  id: string;
  name: string;
  archived: boolean;
  clientName?: string;
}

interface ClockifyTimeEntry {
  id: string;
  description: string;
  billable: boolean;
  projectId: string | null;
  tagIds: string[] | null;
  timeInterval: { start: string; end: string | null; duration: string | null };
}

/**
 * Clockify.
 *
 * The awkward one, and worth knowing why before you pick it: newly created
 * **free** workspaces are limited to roughly thirty API requests per *hour*
 * for the entire workspace, while any paid plan allows fifty per *second*.
 * Same product, a six-thousand-fold difference, and nothing in the API tells
 * you which you have until you hit it.
 *
 * So this adapter is built to survive the bad case: metadata is cached hard,
 * writes are paced, and preflight says plainly what it observed rather than
 * letting a push die at entry twenty-two.
 */
export class ClockifyAdapter implements Adapter {
  readonly name = 'clockify';

  private readonly http: HttpClient;
  private readonly config: Record<string, string>;
  private workspaceId?: string;
  private userId?: string;
  private tagId?: string;

  constructor(cfg: Config) {
    this.config = cfg.adapters.clockify ?? {};
    const apiKey = resolveSecret(this.config.apiKey, 'clockify.apiKey');

    this.http = new HttpClient({
      // Regional instances exist (euc1.clockify.me and friends), so the host
      // has to be configurable rather than a constant.
      baseUrl: this.config.baseUrl ?? DEFAULT_BASE,
      headers: { 'X-Api-Key': apiKey },
      minIntervalMs: Number(this.config.minIntervalMs ?? 250),
      maxRetries: 6,
      onThrottle: (waitMs, reason) =>
        process.stderr.write(
          `  clockify throttled (${reason}); waiting ${Math.round(waitMs / 1000)}s. ` +
            'Free workspaces allow ~30 requests/hour.\n',
        ),
    });
  }

  async preflight(): Promise<PreflightResult> {
    const notes: string[] = [];

    try {
      const me = await this.http.get<ClockifyUser>('/user');
      this.userId = me.id;
      this.workspaceId =
        this.config.workspaceId || me.activeWorkspace || me.defaultWorkspace;

      notes.push(`authenticated as ${me.name}`);
      notes.push(`workspace ${this.workspaceId}`);
      notes.push(
        'if this is a new free workspace, expect ~30 writes/hour, so push daily rather than ' +
          'weekly, or export CSV instead',
      );

      return { ok: true, notes };
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 0;
      notes.push((err as Error).message);

      if (status === 401) notes.push('check adapters.clockify.apiKey (Profile settings → API key)');
      if (status === 429) {
        notes.push('already rate limited; a free workspace resets hourly');
      }

      return { ok: false, notes };
    }
  }

  async listProjects(): Promise<RemoteProject[]> {
    const wid = await this.requireWorkspace();

    // Cached hard: on a throttled workspace a naive project fetch can eat the
    // entire hourly budget before a single entry is written.
    const cached = cacheGet<RemoteProject[]>(`clockify:projects:${wid}`);
    if (cached) return cached;

    const projects = await this.http.get<ClockifyProject[]>(
      `/workspaces/${wid}/projects?page-size=200&archived=false`,
    );

    const mapped = (projects ?? [])
      .filter((p) => !p.archived)
      .map((p) => ({ id: p.id, name: p.name, clientName: p.clientName }));

    cacheSet(`clockify:projects:${wid}`, mapped);
    return mapped;
  }

  async listEntries(period: Period): Promise<RemoteEntry[]> {
    const wid = await this.requireWorkspace();
    if (!this.userId) await this.preflight();

    const start = `${period.start}T00:00:00Z`;
    const end = `${period.end}T23:59:59Z`;

    const entries = await this.http.get<ClockifyTimeEntry[]>(
      `/workspaces/${wid}/user/${this.userId}/time-entries` +
        `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&page-size=200`,
    );

    const tagId = await this.punchcardTagId().catch(() => undefined);

    return (entries ?? [])
      // Only ours. Hand-entered rows belong to the human and are never touched.
      .filter((e) => (tagId ? e.tagIds?.includes(tagId) : false))
      .map((e) => ({
        id: e.id,
        date: e.timeInterval.start.slice(0, 10),
        seconds: durationSeconds(e.timeInterval),
        description: e.description ?? '',
      }));
  }

  async createEntry(draft: DraftEntry): Promise<void> {
    const wid = await this.requireWorkspace();
    await this.http.post(`/workspaces/${wid}/time-entries`, await this.body(draft));
  }

  async updateEntry(remoteId: string, draft: DraftEntry): Promise<void> {
    const wid = await this.requireWorkspace();
    await this.http.put(`/workspaces/${wid}/time-entries/${remoteId}`, await this.body(draft));
  }

  async deleteEntry(remoteId: string): Promise<void> {
    const wid = await this.requireWorkspace();
    await this.http.delete(`/workspaces/${wid}/time-entries/${remoteId}`);
  }

  /**
   * Submit the period for approval.
   *
   * Clockify separates *logging* time from *submitting a timesheet*, which is
   * the right model — and it maps exactly onto punchcard's own split between
   * drafting hours and a human signing for them. Approvals are a paid feature,
   * so this fails cleanly on free plans.
   */
  async submitForApproval(period: Period): Promise<void> {
    const wid = await this.requireWorkspace();
    await this.http.post(`/workspaces/${wid}/approval-requests/TIMESHEET`, {
      start: `${period.start}T00:00:00Z`,
    });
  }

  private async body(draft: DraftEntry): Promise<Record<string, unknown>> {
    const tagId = await this.punchcardTagId().catch(() => undefined);

    return {
      start: new Date(draft.startMs).toISOString(),
      end: new Date(draft.startMs + draft.seconds * 1000).toISOString(),
      description: draft.description,
      billable: draft.billable,
      projectId: this.projectId(draft.project) ?? null,
      tagIds: tagId ? [tagId] : [],
    };
  }

  private projectId(project: string): string | null {
    return this.config[`project.${project}`] ?? null;
  }

  /**
   * Find (or create) the tag that marks our entries.
   *
   * Clockify tags are workspace-level objects referenced by id, so unlike
   * Toggl we can't just send a string. Cached indefinitely — the id never
   * changes, and rediscovering it costs requests we may not have.
   */
  private async punchcardTagId(): Promise<string | undefined> {
    if (this.tagId) return this.tagId;

    const wid = await this.requireWorkspace();
    const cacheKey = `clockify:tag:${wid}`;

    const cached = cacheGet<string>(cacheKey);
    if (cached) return (this.tagId = cached);

    const tags = await this.http.get<Array<{ id: string; name: string }>>(
      `/workspaces/${wid}/tags?page-size=200`,
    );

    let found = (tags ?? []).find((t) => t.name === PUNCHCARD_TAG)?.id;

    if (!found) {
      const created = await this.http.post<{ id: string }>(`/workspaces/${wid}/tags`, {
        name: PUNCHCARD_TAG,
      });
      found = created?.id;
    }

    if (found) {
      cacheSet(cacheKey, found, 365 * 24 * 3600 * 1000);
      this.tagId = found;
    }
    return found;
  }

  private async requireWorkspace(): Promise<string> {
    if (!this.workspaceId) await this.preflight();
    if (!this.workspaceId) {
      throw new Error('Could not determine Clockify workspace. Set adapters.clockify.workspaceId.');
    }
    return this.workspaceId;
  }
}

/**
 * Clockify reports length either as an explicit ISO duration or as a start/end
 * pair; a running entry has neither an end nor a duration.
 */
function durationSeconds(interval: {
  start: string;
  end: string | null;
  duration: string | null;
}): number {
  if (interval.duration) {
    const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(interval.duration);
    if (match) {
      const [, d, h, m, s] = match;
      return (
        Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0)
      );
    }
  }

  if (interval.end) {
    return Math.max(0, (Date.parse(interval.end) - Date.parse(interval.start)) / 1000);
  }

  return 0;
}

export { durationSeconds as clockifyDurationSeconds };
