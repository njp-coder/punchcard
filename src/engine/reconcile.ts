import { forgetPush, getPushRecord, recordPush } from '../store.js';
import type { Adapter, DraftEntry, Period, PushPlan, RemoteEntry } from '../types.js';
import { entryHash } from './reconstruct.js';

/**
 * Work out what to change on the remote, without ever double-writing.
 *
 * This is the reason punchcard writes via APIs rather than generating a CSV for
 * the recurring flow: a CSV import always appends, so re-running it duplicates
 * hours in a billing system. Reconciling lets `punch push` be run as often as
 * you like — hourly, daily, twice in a row by mistake — and converge.
 *
 * The local ledger maps our stable entry key to a remote id. For each draft:
 *
 *   no ledger record          -> create
 *   record, remote missing    -> create (someone deleted it upstream)
 *   record, remote unchanged  -> update if our draft changed, else no-op
 *   record, remote edited     -> respect it, and never touch it again
 *
 * That last case matters most. If a human corrected our guess, their number is
 * better than ours by definition, and silently overwriting it would teach them
 * never to trust the tool again.
 */
export function planPush(
  adapterName: string,
  drafts: DraftEntry[],
  remote: RemoteEntry[],
): PushPlan {
  const remoteById = new Map(remote.map((e) => [e.id, e]));
  const plan: PushPlan = { create: [], update: [], remove: [], respect: [] };
  const claimed = new Set<string>();

  for (const draft of drafts) {
    const record = getPushRecord(adapterName, draft.key);

    if (!record) {
      plan.create.push(draft);
      continue;
    }

    const existing = remoteById.get(record.remoteId);
    if (!existing) {
      // Deleted upstream. Drop the stale ledger row so we don't try to PUT a
      // dead id, and recreate.
      forgetPush(adapterName, draft.key);
      plan.create.push(draft);
      continue;
    }

    claimed.add(existing.id);

    // Did a human change this since we wrote it?
    const currentHash = hashRemote(existing);
    if (currentHash !== record.hash) {
      plan.respect.push(existing);
      continue;
    }

    if (entryHash(draft) !== record.hash) {
      plan.update.push({ remote: existing, draft });
    }
  }

  // Ours by ledger, but no longer proposed — the work got remapped to another
  // project, or the evidence behind it disappeared.
  const draftKeys = new Set(drafts.map((d) => d.key));
  for (const entry of remote) {
    if (claimed.has(entry.id)) continue;
    if (entry.key && !draftKeys.has(entry.key)) plan.remove.push(entry);
  }

  return plan;
}

/** Must match entryHash's shape so ledger comparisons are meaningful. */
function hashRemote(entry: RemoteEntry): string {
  return entryHash({
    seconds: entry.seconds,
    description: entry.description,
  } as DraftEntry);
}

export interface ExecuteOptions {
  dryRun: boolean;
  onProgress?: (message: string) => void;
}

export interface ExecuteResult {
  created: number;
  updated: number;
  removed: number;
  respected: number;
  failed: Array<{ key: string; error: string }>;
}

/**
 * Apply a plan. Every write is recorded in the ledger *immediately* after it
 * succeeds, so a run interrupted halfway — a closed laptop, a throttled free
 * workspace, a dropped connection — resumes without re-creating anything.
 */
export async function executePush(
  adapter: Adapter,
  plan: PushPlan,
  options: ExecuteOptions,
): Promise<ExecuteResult> {
  const result: ExecuteResult = {
    created: 0,
    updated: 0,
    removed: 0,
    respected: plan.respect.length,
    failed: [],
  };

  const log = options.onProgress ?? (() => {});

  for (const entry of plan.respect) {
    log(`  respecting your edit on ${entry.date} (${entry.description})`);
  }

  for (const draft of plan.create) {
    if (options.dryRun) {
      result.created++;
      continue;
    }
    try {
      await adapter.createEntry(draft);
      // We can't read the id back from a create on every API, so re-listing at
      // the next run repairs the ledger. Record what we can now.
      recordPush(adapter.name, draft.key, {
        remoteId: '',
        hash: entryHash(draft),
        pushedAt: Date.now(),
      });
      result.created++;
      log(`  + ${draft.date}  ${draft.project}`);
    } catch (err) {
      result.failed.push({ key: draft.key, error: (err as Error).message });
    }
  }

  for (const { remote, draft } of plan.update) {
    if (options.dryRun) {
      result.updated++;
      continue;
    }
    try {
      await adapter.updateEntry(remote.id, draft);
      recordPush(adapter.name, draft.key, {
        remoteId: remote.id,
        hash: entryHash(draft),
        pushedAt: Date.now(),
      });
      result.updated++;
      log(`  ~ ${draft.date}  ${draft.project}`);
    } catch (err) {
      result.failed.push({ key: draft.key, error: (err as Error).message });
    }
  }

  for (const entry of plan.remove) {
    if (options.dryRun) {
      result.removed++;
      continue;
    }
    try {
      await adapter.deleteEntry(entry.id);
      if (entry.key) forgetPush(adapter.name, entry.key);
      result.removed++;
      log(`  - ${entry.date}  ${entry.description}`);
    } catch (err) {
      result.failed.push({ key: entry.key ?? entry.id, error: (err as Error).message });
    }
  }

  return result;
}

/** Repair ledger rows whose remote id we couldn't capture at create time. */
export function relinkLedger(
  adapterName: string,
  drafts: DraftEntry[],
  remote: RemoteEntry[],
  _period: Period,
): void {
  const byDateAndDescription = new Map(remote.map((e) => [`${e.date}|${e.description}`, e]));

  for (const draft of drafts) {
    const record = getPushRecord(adapterName, draft.key);
    if (!record || record.remoteId) continue;

    const match = byDateAndDescription.get(`${draft.date}|${draft.description}`);
    if (match) {
      recordPush(adapterName, draft.key, {
        remoteId: match.id,
        hash: record.hash,
        pushedAt: record.pushedAt,
      });
    }
  }
}
