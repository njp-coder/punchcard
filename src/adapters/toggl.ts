import type { Config } from '../config.js';
import { resolveSecret } from '../config.js';
import type {
  Adapter,
  DraftEntry,
  Period,
  PreflightResult,
  RemoteEntry,
  RemoteProject,
} from '../types.js';
import { HttpClient } from './http.js';

const BASE_URL = 'https://api.track.toggl.com/api/v9';

/** Marks entries as ours, so they can be found even if the local ledger is lost. */
export const PUNCHCARD_TAG = 'punchcard';

interface TogglMe {
  id: number;
  fullname: string;
  default_workspace_id: number;
}

interface TogglProject {
  id: number;
  name: string;
  active: boolean;
  client_name?: string;
}

interface TogglTimeEntry {
  id: number;
  description: string;
  start: string;
  duration: number;
  project_id: number | null;
  tags?: string[];
}

/**
 * Toggl Track (API v9).
 *
 * This is the reference adapter and the recommended first destination: auth is
 * a single token, the free tier has no punitive request budget, and so the
 * historical backfill demo works for everyone without a paid plan.
 */
export class TogglAdapter implements Adapter {
  readonly name = 'toggl';

  private readonly http: HttpClient;
  private readonly config: Record<string, string>;
  private workspaceId?: number;
  private userId?: number;

  constructor(cfg: Config) {
    this.config = cfg.adapters.toggl ?? {};
    const token = resolveSecret(this.config.apiToken, 'toggl.apiToken');

    this.http = new HttpClient({
      baseUrl: BASE_URL,
      headers: {
        // Toggl uses HTTP Basic with the literal string "api_token" as password.
        Authorization: `Basic ${Buffer.from(`${token}:api_token`).toString('base64')}`,
      },
      minIntervalMs: 250,
      onThrottle: (waitMs, reason) =>
        process.stderr.write(`  toggl throttled (${reason}); waiting ${Math.round(waitMs / 1000)}s\n`),
    });
  }

  async preflight(): Promise<PreflightResult> {
    const notes: string[] = [];
    try {
      const me = await this.http.get<TogglMe>('/me');
      this.userId = me.id;
      this.workspaceId = this.config.workspaceId
        ? Number(this.config.workspaceId)
        : me.default_workspace_id;

      notes.push(`authenticated as ${me.fullname}`);
      notes.push(`workspace ${this.workspaceId}`);
      return { ok: true, notes };
    } catch (err) {
      notes.push((err as Error).message);
      return { ok: false, notes };
    }
  }

  async listProjects(): Promise<RemoteProject[]> {
    const wid = await this.requireWorkspace();
    const projects = await this.http.get<TogglProject[]>(`/workspaces/${wid}/projects`);
    return (projects ?? [])
      .filter((p) => p.active)
      .map((p) => ({ id: String(p.id), name: p.name, clientName: p.client_name }));
  }

  async listEntries(period: Period): Promise<RemoteEntry[]> {
    // /me/time_entries is one call for the whole range — far cheaper than
    // paging per project, which matters on throttled destinations.
    const entries = await this.http.get<TogglTimeEntry[]>(
      `/me/time_entries?start_date=${period.start}&end_date=${nextDay(period.end)}`,
    );

    return (entries ?? [])
      .filter((e) => e.tags?.includes(PUNCHCARD_TAG))
      .map((e) => ({
        id: String(e.id),
        date: e.start.slice(0, 10),
        seconds: Math.max(0, e.duration),
        description: e.description ?? '',
        key: this.keyForRemoteId(String(e.id)),
      }));
  }

  async createEntry(draft: DraftEntry): Promise<void> {
    const wid = await this.requireWorkspace();
    await this.http.post(`/workspaces/${wid}/time_entries`, this.body(draft, wid));
  }

  async updateEntry(remoteId: string, draft: DraftEntry): Promise<void> {
    const wid = await this.requireWorkspace();
    await this.http.put(`/workspaces/${wid}/time_entries/${remoteId}`, this.body(draft, wid));
  }

  async deleteEntry(remoteId: string): Promise<void> {
    const wid = await this.requireWorkspace();
    await this.http.delete(`/workspaces/${wid}/time_entries/${remoteId}`);
  }

  /** Toggl expects a positive duration plus a start for a completed entry. */
  private body(draft: DraftEntry, workspaceId: number): Record<string, unknown> {
    return {
      created_with: 'punchcard',
      workspace_id: workspaceId,
      description: draft.description,
      start: new Date(draft.startMs).toISOString(),
      duration: draft.seconds,
      billable: draft.billable,
      tags: [PUNCHCARD_TAG],
      project_id: this.projectId(draft.project),
      user_id: this.userId,
    };
  }

  private projectId(project: string): number | null {
    const raw = this.config[`project.${project}`];
    return raw ? Number(raw) : null;
  }

  private async requireWorkspace(): Promise<number> {
    if (this.workspaceId === undefined) await this.preflight();
    if (this.workspaceId === undefined) {
      throw new Error('Could not determine Toggl workspace. Set adapters.toggl.workspaceId.');
    }
    return this.workspaceId;
  }

  /**
   * We deliberately don't recover the key from the remote entry.
   *
   * Encoding it in the description would put machine noise into text a client
   * eventually reads, and Toggl has no free-form metadata field. Instead
   * reconcile.ts drives matching from the local push ledger (key -> remote id),
   * and the tag above is what lets us still *find* our entries if that ledger
   * is ever lost.
   */
  private keyForRemoteId(_remoteId: string): string | undefined {
    return undefined;
  }
}

/** Toggl's end_date is exclusive. */
function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(y!, m! - 1, d! + 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(
    next.getDate(),
  ).padStart(2, '0')}`;
}
