import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DraftEntry, Period } from '../types.js';
import { fromMarkdown, toMarkdown } from './markdown.js';

const period: Period = { start: '2026-09-09', end: '2026-09-09', label: 'test week' };

function entry(overrides: Partial<DraftEntry> = {}): DraftEntry {
  return {
    date: '2026-09-09',
    project: 'acme',
    description: 'OAuth token refresh',
    seconds: 2 * 3600,
    billable: true,
    startMs: Date.parse('2026-09-09T09:00:00'),
    provenance: { signalIds: [], summary: ['commit'], confidence: 'inferred' },
    key: 'a'.repeat(16),
    ...overrides,
  };
}

test('an untouched round-trip reports no changes', () => {
  const entries = [entry()];
  const markdown = toMarkdown(period, entries, []);
  const parsed = fromMarkdown(markdown, [entries[0]!.key]);

  assert.equal(parsed.edits.length, 1);
  assert.equal(parsed.deletedKeys.length, 0);
  assert.equal(parsed.problems.length, 0);
  assert.equal(parsed.edits[0]!.seconds, 2 * 3600);
  assert.equal(parsed.edits[0]!.project, 'acme');
  assert.equal(parsed.edits[0]!.description, 'OAuth token refresh');
});

test('the closing comment delimiter is not read as an entry', () => {
  // `-->` starts with a dash and looks exactly like a bullet.
  const markdown = toMarkdown(period, [entry()], []);
  assert.ok(markdown.includes('-->'));
  assert.deepEqual(fromMarkdown(markdown, [entry().key]).problems, []);
});

test('edited duration, project and description are all picked up', () => {
  const key = entry().key;
  const edited = `- 3h 30m  internal  Reworked the refresh flow  #${key}`;
  const parsed = fromMarkdown(edited, [key]);

  assert.equal(parsed.edits[0]!.seconds, 3.5 * 3600);
  assert.equal(parsed.edits[0]!.project, 'internal');
  assert.equal(parsed.edits[0]!.description, 'Reworked the refresh flow');
});

test('a removed line is reported as deleted', () => {
  const parsed = fromMarkdown('# Timesheet\n\n## 2026-09-09\n', ['a'.repeat(16)]);
  assert.deepEqual(parsed.deletedKeys, ['a'.repeat(16)]);
});

test('issue keys survive the round-trip', () => {
  const entries = [entry({ issueKey: 'PROJ-142' })];
  const parsed = fromMarkdown(toMarkdown(period, entries, []), [entries[0]!.key]);
  assert.equal(parsed.edits[0]!.issueKey, 'PROJ-142');
});

test('descriptions containing single spaces and semicolons survive', () => {
  const description = 'Fixed the race; then wrote a test for it';
  const entries = [entry({ description })];
  const parsed = fromMarkdown(toMarkdown(period, entries, []), [entries[0]!.key]);
  assert.equal(parsed.edits[0]!.description, description);
});

test('a hand-added line without an anchor is reported, not silently dropped', () => {
  const parsed = fromMarkdown('- 1h  acme  I typed this myself', []);
  assert.equal(parsed.edits.length, 0);
  assert.equal(parsed.problems.length, 1);
  assert.match(parsed.problems[0]!, /punch log/);
});

test('a typo in a duration leaves the entry alone rather than deleting it', () => {
  const key = 'b'.repeat(16);
  const parsed = fromMarkdown(`- ages  acme  something  #${key}`, [key]);

  assert.equal(parsed.edits.length, 0);
  assert.equal(parsed.problems.length, 1);
  // The line is still present, so this is a typo — not intent to delete.
  assert.deepEqual(parsed.deletedKeys, []);
});
