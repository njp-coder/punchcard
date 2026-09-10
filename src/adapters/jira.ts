import type { Config } from '../config.js';
import { resolveSecret } from '../config.js';
import type { IssueCandidate } from '../engine/issues.js';
import { cacheGet, cacheSet } from '../store.js';
import type {
  Adapter,
  DraftEntry,
  Period,
  PreflightResult,
  RemoteEntry,
  RemoteProject,
} from '../types.js';
import { HttpClient } from './http.js';

/**
 * Jira Cloud native worklogs.
 *
 * The highest-accuracy destination punchcard can write to, because developers
 * already put issue keys in branch names — so the project-mapping problem that
 * every other adapter needs a lookup table for solves itself here.
 *
 * Native worklogs, not Tempo: every Jira instance has them, whereas Tempo is a
 * separate purchase with a separate API and token. Tempo worklogs are a
 * superset, so that adapter extends this one rather than replacing it.
 */
export class JiraAdapter implements Adapter {
  readonly name = 'jira';

  private readonly http: HttpClient;
  private readonly config: Record<string, string>;
  private accountId?: string;

  constructor(cfg: Config) {
    this.config = cfg.adapters.jira ?? {};

    const site = this.config.site;
    if (!site) {
      throw new Error('adapters.jira.site is required (e.g. your-team.atlassian.net)');
    }

    const email = resolveSecret(this.config.email, 'jira.email');
    const token = resolveSecret(this.config.apiToken, 'jira.apiToken');

    this.http = new HttpClient({
      baseUrl: `https://${site.replace(/^https?:\/\//, '').replace(/\/$/, '')}`,
      headers: {
        Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
        Accept: 'application/json',
      },
      minIntervalMs: 200,
      onThrottle: (waitMs, reason) =>
        process.stderr.write(`  jira throttled (${reason}); waiting ${Math.round(waitMs / 1000)}s\n`),
    });
  }

  /**
   * A catch-all issue for work that legitimately has no ticket: meetings,
   * admin, support. Opt-in only. Jira cannot log time against a project, so
   * without this those hours can never reach Jira at all.
   */
  get fallbackIssue(): string | undefined {
    return this.config.fallbackIssue;
  }

  async preflight(): Promise<PreflightResult> {
    const notes: string[] = [];
    try {
      const me = await this.http.get<{ accountId: string; displayName: string }>(
        '/rest/api/3/myself',
      );
      this.accountId = me.accountId;
      notes.push(`authenticated as ${me.displayName}`);
      notes.push('worklogs are written against the issue key on each entry');
      if (this.fallbackIssue) {
        notes.push(`non-ticket work goes to ${this.fallbackIssue}`);
      }
      return { ok: true, notes };
    } catch (err) {
      notes.push((err as Error).message);
      notes.push('check adapters.jira.site, .email and .apiToken (an API token, not a password)');
      return { ok: false, notes };
    }
  }

  async listProjects(): Promise<RemoteProject[]> {
    const page = await this.http.get<{ values: Array<{ key: string; name: string }> }>(
      '/rest/api/3/project/search?maxResults=100',
    );
    return (page.values ?? []).map((p) => ({ id: p.key, name: p.name }));
  }

  /**
   * Issues worth matching work against: yours, and anything recently touched.
   *
   * Kept to a small, current pool rather than the whole backlog — matching
   * against thousands of stale tickets produces confident-looking nonsense,
   * and the work you're logging is almost always on something live.
   */
  async listIssues(): Promise<IssueCandidate[]> {
    const cached = cacheGet<IssueCandidate[]>('jira:issues');
    if (cached) return cached;

    // Parenthesised explicitly: `A AND B OR C AND D` relies on operator
    // precedence, and the new search endpoint is stricter about bounded
    // queries than the one it replaced.
    const jql = encodeURIComponent(
      'assignee = currentUser() AND (statusCategory != Done OR updated >= -30d) ' +
        'ORDER BY updated DESC',
    );

    const search = await this.searchIssues<{
      key: string;
      fields: {
        summary: string;
        status?: { name: string };
        assignee?: { accountId: string };
        updated?: string;
      };
    }>(jql, 'summary,status,assignee,updated');

    const candidates: IssueCandidate[] = (search.issues ?? []).map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status?.name,
      mine: issue.fields.assignee?.accountId === this.accountId,
      updatedAt: issue.fields.updated ? Date.parse(issue.fields.updated) : undefined,
    }));

    // Short TTL: sprints move, and a stale candidate list produces confident
    // matches against tickets that were closed days ago.
    cacheSet('jira:issues', candidates, 6 * 3600 * 1000);
    return candidates;
  }

  async listEntries(period: Period): Promise<RemoteEntry[]> {
    if (!this.accountId) await this.preflight();

    // One JQL search for issues we touched, then worklogs from those. Reading
    // every worklog in the instance is not an option at any reasonable size.
    const jql = encodeURIComponent(
      `worklogAuthor = currentUser() AND worklogDate >= "${period.start}" AND worklogDate <= "${period.end}"`,
    );

    const search = await this.searchIssues<{ id: string; key: string }>(jql, 'key');

    const out: RemoteEntry[] = [];

    for (const issue of search.issues ?? []) {
      const worklogs = await this.http.get<{ worklogs: JiraWorklog[] }>(
        `/rest/api/3/issue/${issue.key}/worklog`,
      );

      for (const worklog of worklogs.worklogs ?? []) {
        if (worklog.author?.accountId !== this.accountId) continue;

        const date = worklog.started.slice(0, 10);
        if (date < period.start || date > period.end) continue;

        out.push({
          id: `${issue.key}/${worklog.id}`,
          date,
          seconds: worklog.timeSpentSeconds,
          description: plainText(worklog.comment),
        });
      }
    }

    return out;
  }

  /**
   * Issue search, via the endpoint that still exists.
   *
   * Atlassian removed `GET /rest/api/3/search` outright (CHANGE-2046); it now
   * returns 410 Gone. The replacement is `/rest/api/3/search/jql`, which pages
   * with an opaque `nextPageToken` rather than `startAt`/`total`.
   *
   * We deliberately read a single page. punchcard needs your current issues,
   * not your backlog, and there are widespread reports of the new endpoint's
   * `isLast` never turning true while `nextPageToken` chains forever. One
   * bounded request cannot get stuck in that loop.
   */
  private async searchIssues<T>(
    encodedJql: string,
    fields: string,
    maxResults = 100,
  ): Promise<{ issues: T[] }> {
    return this.http.get<{ issues: T[]; nextPageToken?: string; isLast?: boolean }>(
      `/rest/api/3/search/jql?jql=${encodedJql}&fields=${fields}&maxResults=${maxResults}`,
    );
  }

  async createEntry(draft: DraftEntry): Promise<void> {
    const issueKey = this.requireIssue(draft);
    await this.http.post(`/rest/api/3/issue/${issueKey}/worklog`, this.body(draft));
  }

  async updateEntry(remoteId: string, draft: DraftEntry): Promise<void> {
    const [issueKey, worklogId] = remoteId.split('/');
    await this.http.put(`/rest/api/3/issue/${issueKey}/worklog/${worklogId}`, this.body(draft));
  }

  async deleteEntry(remoteId: string): Promise<void> {
    const [issueKey, worklogId] = remoteId.split('/');
    await this.http.delete(`/rest/api/3/issue/${issueKey}/worklog/${worklogId}`);
  }

  private body(draft: DraftEntry): Record<string, unknown> {
    return {
      timeSpentSeconds: draft.seconds,
      started: jiraTimestamp(draft.startMs),
      comment: toAdf(draft.description),
    };
  }

  private requireIssue(draft: DraftEntry): string {
    if (!draft.issueKey) {
      throw new Error(
        `${draft.date} ${draft.project}: no issue key. Jira worklogs attach to an issue. ` +
          'name the issue in a branch or commit, or log it with `punch log ... PROJ-142`.',
      );
    }
    return draft.issueKey;
  }
}

interface JiraWorklog {
  id: string;
  started: string;
  timeSpentSeconds: number;
  author?: { accountId: string };
  comment?: unknown;
}

/**
 * Jira wants `2026-09-09T14:30:00.000+0100` — no colon in the offset, and it
 * rejects a trailing `Z`. Date.toISOString() produces neither, which is a
 * reliable source of 400s.
 */
function jiraTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, '0');

  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}${pad(
    Math.abs(offsetMinutes) % 60,
  )}`;

  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(
      d.getMilliseconds(),
      3,
    )}${offset}`
  );
}

/**
 * The v3 API takes comments as Atlassian Document Format, not a plain string.
 * Passing a string here is the single most common way to get a 400 from this
 * endpoint.
 */
function toAdf(text: string): Record<string, unknown> {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: text || 'Work logged' }] }],
  };
}

/** Flatten an ADF comment back to text for reconciliation. */
function plainText(comment: unknown): string {
  if (!comment) return '';
  if (typeof comment === 'string') return comment;

  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const record = node as { text?: string; content?: unknown[] };
    if (typeof record.text === 'string') parts.push(record.text);
    for (const child of record.content ?? []) walk(child);
  };

  walk(comment);
  return parts.join('').trim();
}
