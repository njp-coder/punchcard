import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entryHash } from './reconstruct.js';
import type { DraftEntry } from '../types.js';

/**
 * These cover the rule that a deletion hides the hours you saw, not the
 * (date, project) slot forever. Without it, deleting one merged row silently
 * swallowed every later Slack message that landed in the same slot.
 */
function draft(overrides: Partial<DraftEntry> = {}): DraftEntry {
  return {
    date: '2026-09-10',
    project: 'acme',
    description: 'testing',
    seconds: 3600,
    billable: true,
    startMs: Date.now(),
    provenance: { signalIds: [], summary: [], confidence: 'inferred' },
    key: 'd'.repeat(16),
    ...overrides,
  };
}

test('a deletion hash matches the entry it was taken from', () => {
  const e = draft();
  assert.equal(entryHash(e), entryHash(draft()));
});

test('changing duration or description changes the hash', () => {
  const original = entryHash(draft());
  assert.notEqual(entryHash(draft({ seconds: 7200 })), original);
  assert.notEqual(entryHash(draft({ description: 'something else' })), original);
});
