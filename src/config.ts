import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import type { PeriodConfig } from './types.js';

export interface RepoConfig {
  path: string;
  /** Project this repo maps to. Omit and punchcard asks once, then remembers. */
  project?: string;
}

export interface ProjectConfig {
  name: string;
  billable: boolean;
  /** Per-adapter remote ids, filled in by `punch link`. */
  remote?: Record<string, string>;
}

export interface CalendarConfig {
  /** Private iCal URL. Use env: indirection — the URL is itself a secret. */
  url: string;
  name?: string;
  /** Pin every event from this calendar to one project. */
  project?: string;
}

export interface SlackConfig {
  /** User OAuth token (xoxp-...) with im:history + im:write scopes. */
  token: string;
  /** Channel id to read. Omit to use the DM you have with yourself. */
  channel?: string;
  lookbackDays?: number;
}

export interface Config {
  version: 1;
  period: PeriodConfig;

  /** Hours you're expected to account for on a working day. Drives Gap. */
  targetHoursPerDay: number;
  /** Client-mandated rounding. 0 disables. */
  roundToMinutes: number;

  repos: RepoConfig[];

  /**
   * Calendars, as private iCal URLs. Deliberately not OAuth: an open-source
   * tool cannot ship a client secret, and making every user register their own
   * cloud project would kill adoption. Google and Outlook both publish a
   * per-calendar secret address that works today.
   */
  calendars: CalendarConfig[];

  /**
   * Slack, polled with a user token rather than run as a bot: a slash-command
   * bot needs a public webhook endpoint, which would mean hosting a server.
   */
  slack?: SlackConfig;
  /** Titles containing any of these are never billed. See DEFAULT_IGNORE. */
  calendarIgnore?: string[];
  /** Anything longer than this is a marker, not a meeting you sat through. */
  calendarMaxMinutes?: number;
  /** Git identities that count as "you". Commits by anyone else are ignored. */
  authors: string[];

  projects: Record<string, ProjectConfig>;

  /**
   * The learning table. Every unmapped repo or issue prefix prompts once and
   * lands here. If punchcard ever asks the same question twice, it's a bug.
   */
  mapping: {
    repo: Record<string, string>;
    issuePrefix: Record<string, string>;
    /** Recurring meeting title -> project. Sticky once answered. */
    meeting: Record<string, string>;
  };

  sessionize: {
    /** Idle gap that ends a coding session. */
    gapMinutes: number;
    /** Hard cap on one inferred session, so a stale clock can't bill 11h. */
    maxSessionMinutes: number;
    /** Credited before the first commit of a session (thinking, setup). */
    preCommitMinutes: number;
  };

  adapters: Record<string, Record<string, string>>;
}

export const DEFAULT_CONFIG: Config = {
  version: 1,
  period: { type: 'weekly', weekStart: 1, deadline: 'fri 17:00' },
  targetHoursPerDay: 8,
  roundToMinutes: 15,
  repos: [],
  calendars: [],
  authors: [],
  projects: {},
  mapping: { repo: {}, issuePrefix: {}, meeting: {} },
  sessionize: { gapMinutes: 120, maxSessionMinutes: 240, preCommitMinutes: 45 },
  adapters: {},
};

/* ------------------------------------------------------------------ */
/* Paths — XDG, with sane macOS fallbacks.                             */
/* ------------------------------------------------------------------ */

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.trim() ? xdg : join(homedir(), '.config'), 'punchcard');
}

export function dataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  return join(xdg && xdg.trim() ? xdg : join(homedir(), '.local', 'share'), 'punchcard');
}

export function configPath(): string {
  return join(configDir(), 'config.yaml');
}

export function configExists(): boolean {
  return existsSync(configPath());
}

/* ------------------------------------------------------------------ */
/* Load / save                                                         */
/* ------------------------------------------------------------------ */

export function loadConfig(): Config {
  if (!configExists()) {
    throw new Error(`No config found at ${configPath()}. Run \`punch init\` first.`);
  }
  const raw = YAML.parse(readFileSync(configPath(), 'utf8')) ?? {};
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    ...raw,
    period: { ...DEFAULT_CONFIG.period, ...(raw.period ?? {}) },
    mapping: { ...DEFAULT_CONFIG.mapping, ...(raw.mapping ?? {}) },
    sessionize: { ...DEFAULT_CONFIG.sessionize, ...(raw.sessionize ?? {}) },
    projects: raw.projects ?? {},
    adapters: raw.adapters ?? {},
    repos: (raw.repos ?? []).map((r: RepoConfig) => ({ ...r, path: expandPath(r.path) })),
    calendars: raw.calendars ?? [],
    slack: raw.slack,
  };
  return cfg;
}

export function saveConfig(cfg: Config): void {
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), YAML.stringify(cfg), 'utf8');
}

export function expandPath(p: string): string {
  if (p.startsWith('~')) return join(homedir(), p.slice(1));
  return resolve(p);
}

/**
 * Resolve a config value that may indirect through the environment.
 *
 * Credentials are written as `env:TOGGL_API_TOKEN` so a config file can be
 * shared, committed, or pasted into an issue without leaking a token. A literal
 * value still works — we just don't encourage it.
 */
export function resolveSecret(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing credential: ${label}`);
  if (value.startsWith('env:')) {
    const name = value.slice(4);
    const found = process.env[name];
    if (!found) {
      throw new Error(`${label} points at $${name}, but that environment variable is not set.`);
    }
    return found;
  }
  return value;
}
