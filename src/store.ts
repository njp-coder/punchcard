import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.js';
import type { Period, Signal } from './types.js';

/**
 * Local, plain-JSON state. Deliberately not a database:
 *
 *  - nothing leaves the machine, and the user can read and repair it by hand
 *  - no native dependency, so `npx punchcard` works everywhere
 *
 * If this ever gets slow it can be swapped for SQLite behind these functions,
 * but a decade of one developer's timesheets is a few megabytes.
 */

function ensureDir(): string {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson<T>(file: string, fallback: T): T {
  const path = join(ensureDir(), file);
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    // A corrupt cache should never be fatal — the evidence is reproducible.
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(join(ensureDir(), file), JSON.stringify(value, null, 2), 'utf8');
}

/* ------------------------------------------------------------------ */
/* Manual capture ledger                                               */
/* ------------------------------------------------------------------ */

const MANUAL_LOG = 'manual.jsonl';

/**
 * Append-only, because these are the highest-confidence signals in the system:
 * a human explicitly stated them. We never rewrite history here.
 */
export function appendManualSignal(signal: Signal): void {
  appendFileSync(join(ensureDir(), MANUAL_LOG), `${JSON.stringify(signal)}\n`, 'utf8');
}

/**
 * Every manual signal id we already hold.
 *
 * Slack messages carry a stable per-message timestamp id, so re-syncing is
 * idempotent — without this, every sync would re-import the same hours.
 */
export function knownSignalIds(): Set<string> {
  const path = join(ensureDir(), MANUAL_LOG);
  if (!existsSync(path)) return new Set();

  const ids = new Set<string>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      ids.add((JSON.parse(line) as Signal).id);
    } catch {
      // Torn line — skip it rather than losing the whole ledger.
    }
  }
  return ids;
}

/** Every manual signal on file, unfiltered by period. */
export function existingManualSignals(): Signal[] {
  const path = join(ensureDir(), MANUAL_LOG);
  if (!existsSync(path)) return [];

  const out: Signal[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Signal);
    } catch {
      // Torn line; skip it rather than losing the ledger.
    }
  }
  return out;
}

export function readManualSignals(period: Period): Signal[] {
  const path = join(ensureDir(), MANUAL_LOG);
  if (!existsSync(path)) return [];

  const from = new Date(`${period.start}T00:00:00`).getTime();
  const to = new Date(`${period.end}T23:59:59.999`).getTime();

  const out: Signal[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const signal = JSON.parse(line) as Signal;
      if (signal.start >= from && signal.start <= to) out.push(signal);
    } catch {
      // Skip a torn line rather than losing the whole ledger.
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Push ledger — what we wrote, where, and what it looked like         */
/* ------------------------------------------------------------------ */

export interface PushRecord {
  remoteId: string;
  /** Hash of the entry as we pushed it, to detect later human edits. */
  hash: string;
  pushedAt: number;
}

type PushLedger = Record<string, Record<string, PushRecord>>;

const PUSH_LEDGER = 'pushed.json';

export function getPushRecord(adapter: string, key: string): PushRecord | undefined {
  return readJson<PushLedger>(PUSH_LEDGER, {})[adapter]?.[key];
}

export function recordPush(adapter: string, key: string, record: PushRecord): void {
  const ledger = readJson<PushLedger>(PUSH_LEDGER, {});
  (ledger[adapter] ??= {})[key] = record;
  writeJson(PUSH_LEDGER, ledger);
}

export function forgetPush(adapter: string, key: string): void {
  const ledger = readJson<PushLedger>(PUSH_LEDGER, {});
  delete ledger[adapter]?.[key];
  writeJson(PUSH_LEDGER, ledger);
}

/* ------------------------------------------------------------------ */
/* Overrides — your corrections to what we guessed                     */
/* ------------------------------------------------------------------ */

export interface Override {
  seconds?: number;
  description?: string;
  project?: string;
  billable?: boolean;
  /** You deleted this line during review. We won't propose it again. */
  deleted?: boolean;
  /**
   * What the entry looked like when you deleted it.
   *
   * A deletion hides the hours you actually saw, not the bucket forever. New
   * evidence landing in the same (date, project) slot later would otherwise
   * disappear silently, which for a tool that promises never to drop hours is
   * the worst possible failure.
   */
  deletedHash?: string;
  editedAt: number;
}

const OVERRIDES = 'overrides.json';

/**
 * Reconstruction is recomputed from evidence on every run — git history is
 * permanent, so caching drafts would only let them go stale.
 *
 * But that leaves nowhere for *your* corrections to live. This is that place:
 * a thin layer of human decisions, keyed by entry, replayed over each fresh
 * reconstruction. Fix a description once and it stays fixed, even as new
 * commits land on the same day.
 */
export function getOverrides(): Record<string, Override> {
  return readJson<Record<string, Override>>(OVERRIDES, {});
}

export function setOverride(key: string, override: Omit<Override, 'editedAt'>): void {
  const all = getOverrides();
  all[key] = { ...all[key], ...override, editedAt: Date.now() };
  writeJson(OVERRIDES, all);
}

export function clearOverride(key: string): void {
  const all = getOverrides();
  delete all[key];
  writeJson(OVERRIDES, all);
}

/* ------------------------------------------------------------------ */
/* Issue mappings — which Jira ticket a piece of work belongs to       */
/* ------------------------------------------------------------------ */

const ISSUE_MAPPINGS = 'issues.json';

/**
 * Remembered branch -> issue assignments.
 *
 * Separate from project mappings because the lifetime is different: a repo
 * belongs to a project for years, whereas a branch belongs to one ticket for a
 * week. Keeping them apart stops a stale branch mapping from quietly
 * redirecting a whole project's hours.
 */
export function getIssueMappings(): Record<string, string> {
  return readJson<Record<string, string>>(ISSUE_MAPPINGS, {});
}

export function setIssueMapping(key: string, issueKey: string): void {
  const all = getIssueMappings();
  all[key] = issueKey;
  writeJson(ISSUE_MAPPINGS, all);
}

/* ------------------------------------------------------------------ */
/* Attestation                                                         */
/* ------------------------------------------------------------------ */

export interface Attestation {
  period: string;
  approvedAt: number;
  /** Hash over the approved entries, so a merge can detect tampering. */
  digest: string;
  entryCount: number;
  totalSeconds: number;
}

const ATTESTATIONS = 'attestations.json';

/**
 * A record that a human looked at these specific hours and said yes.
 *
 * This exists so a team merge (`punch merge`) can refuse to bundle a slice
 * nobody approved. Generating plausible hours is easy; the whole point of this
 * tool is that a person still signs for them.
 */
export function saveAttestation(a: Attestation): void {
  const all = readJson<Record<string, Attestation>>(ATTESTATIONS, {});
  all[a.period] = a;
  writeJson(ATTESTATIONS, all);
}

export function getAttestation(period: string): Attestation | undefined {
  return readJson<Record<string, Attestation>>(ATTESTATIONS, {})[period];
}

/* ------------------------------------------------------------------ */
/* Metadata cache                                                      */
/* ------------------------------------------------------------------ */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const CACHE = 'cache.json';

/**
 * Projects and tasks change roughly never, but on a throttled free workspace a
 * naive metadata fetch burns the entire hourly budget before the first write.
 * Cache aggressively; `punch sync` busts it.
 */
export function cacheGet<T>(key: string): T | undefined {
  const entry = readJson<Record<string, CacheEntry<T>>>(CACHE, {})[key];
  if (!entry || entry.expiresAt < Date.now()) return undefined;
  return entry.value;
}

export function cacheSet<T>(key: string, value: T, ttlMs = 7 * 24 * 3600 * 1000): void {
  const all = readJson<Record<string, CacheEntry<unknown>>>(CACHE, {});
  all[key] = { value, expiresAt: Date.now() + ttlMs };
  writeJson(CACHE, all);
}

export function cacheClear(): void {
  writeJson(CACHE, {});
}
