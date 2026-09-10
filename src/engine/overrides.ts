import { getOverrides } from '../store.js';
import type { DraftEntry } from '../types.js';
import { entryHash, entryKey } from './reconstruct.js';

/**
 * Replay your corrections over a freshly reconstructed timesheet.
 *
 * Applied *after* reconstruction rather than baked into it, so the two layers
 * stay separable: evidence is always recomputed from source and can never go
 * stale, while human decisions persist across runs. Delete this file and you
 * get pure machine output back.
 */
export function applyOverrides(entries: DraftEntry[]): DraftEntry[] {
  const overrides = getOverrides();
  if (!Object.keys(overrides).length) return entries;

  const out: DraftEntry[] = [];

  for (const entry of entries) {
    const override = overrides[entry.key];
    if (!override) {
      out.push(entry);
      continue;
    }

    if (override.deleted) {
      // Honour the deletion only while the entry still matches what was
      // deleted. Once new evidence changes it, it comes back rather than being
      // swallowed by a stale decision.
      if (!override.deletedHash || override.deletedHash === entryHash(entry)) continue;
    }

    const project = override.project ?? entry.project;

    out.push({
      ...entry,
      project,
      description: override.description ?? entry.description,
      seconds: override.seconds ?? entry.seconds,
      billable: override.billable ?? entry.billable,
      provenance: {
        ...entry.provenance,
        // An edited entry is attested by definition: you looked at it and
        // said what it should be. That outranks anything we inferred.
        confidence: 'attested',
        summary: [...entry.provenance.summary, 'edited by you'],
      },
      // Reassigning the project changes the entry's identity, so the key has
      // to follow — otherwise a push would update the old project's entry.
      key: project === entry.project ? entry.key : entryKey(entry.date, project, entry.issueKey),
    });
  }

  return out;
}

/** Entries whose key changed under override, so the old remote row can be cleaned up. */
export function remappedKeys(before: DraftEntry[], after: DraftEntry[]): string[] {
  const afterKeys = new Set(after.map((e) => e.key));
  return before.map((e) => e.key).filter((key) => !afterKeys.has(key));
}
