import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DraftEntry } from '../types.js';
import {
  partitionByIssue,
  rankCandidates,
  resolveIssue,
  type IssueCandidate,
} from './issues.js';

const candidates: IssueCandidate[] = [
  { key: 'PROJ-142', summary: 'OAuth token refresh races on concurrent requests', mine: true },
  { key: 'PROJ-77', summary: 'Add pagination to the customer list', mine: true },
  { key: 'OPS-9', summary: 'Upgrade the CI runners to Ubuntu 24', mine: false },
];

function entry(overrides: Partial<DraftEntry> = {}): DraftEntry {
  return {
    date: '2026-09-09',
    project: 'acme',
    description: 'Fix the token refresh race condition',
    seconds: 3600,
    billable: true,
    startMs: Date.now(),
    provenance: { signalIds: [], summary: [], confidence: 'inferred' },
    key: 'k'.repeat(16),
    ...overrides,
  };
}

test('an issue key from the branch is certain and needs no matching', () => {
  const result = resolveIssue(entry({ issueKey: 'PROJ-500' }), candidates, {});
  assert.equal(result.confidence, 'certain');
  assert.equal(result.issueKey, 'PROJ-500');
});

test('a remembered branch mapping is certain and beats any text match', () => {
  const result = resolveIssue(
    entry(),
    candidates,
    { 'branch:acme:feature/oauth': 'PROJ-999' },
    'feature/oauth',
  );
  assert.equal(result.confidence, 'certain');
  assert.equal(result.issueKey, 'PROJ-999');
});

test('branch mappings are scoped per project', () => {
  // Every repository has a main branch. Keying on the branch alone would send
  // one project's main-branch hours to another project's ticket.
  const mappings = { 'branch:acme:main': 'PROJ-1', 'branch:other:main': 'OTH-1' };

  const acme = resolveIssue(entry({ project: 'acme' }), candidates, mappings, 'main');
  const other = resolveIssue(entry({ project: 'other' }), candidates, mappings, 'main');

  assert.equal(acme.issueKey, 'PROJ-1');
  assert.equal(other.issueKey, 'OTH-1');
});

test('a strong text match is only ever a suggestion, never certain', () => {
  const result = resolveIssue(entry(), candidates, {});
  assert.equal(result.confidence, 'suggested');
  assert.equal(result.issueKey, 'PROJ-142');
  // Never auto-pushed: a worklog on the wrong ticket corrupts sprint reporting.
  assert.notEqual(result.confidence, 'certain');
});

test('unrelated work resolves to unknown rather than the nearest ticket', () => {
  const result = resolveIssue(
    entry({ description: 'Write the quarterly board deck' }),
    candidates,
    {},
  );
  assert.equal(result.confidence, 'unknown');
  assert.equal(result.issueKey, undefined);
});

test('shared filler vocabulary does not manufacture a match', () => {
  // "Fix the bug" vs "Fix the pagination bug" must not score as a match on
  // "fix" and "the" alone.
  const ranked = rankCandidates('Fix the bug', [
    { key: 'X-1', summary: 'Fix the bug in checkout' },
  ]);
  assert.ok((ranked[0]?.score ?? 0) < 0.34, `expected weak score, got ${ranked[0]?.score}`);
});

test('matching survives word endings', () => {
  const ranked = rankCandidates('Refreshing the oauth tokens', [
    { key: 'PROJ-142', summary: 'OAuth token refresh races' },
  ]);
  assert.ok((ranked[0]?.score ?? 0) > 0.3, `expected a match, got ${ranked[0]?.score}`);
});

test('your own in-progress issues outrank equally similar ones', () => {
  const ranked = rankCandidates('pagination on the customer list', [
    { key: 'A-1', summary: 'Add pagination to the customer list', mine: false },
    { key: 'B-2', summary: 'Add pagination to the customer list', mine: true, status: 'In Progress' },
  ]);
  assert.equal(ranked[0]?.key, 'B-2');
});

test('a configured fallback catches work that has no ticket', () => {
  const result = resolveIssue(
    entry({ description: 'Sprint planning' }),
    candidates,
    {},
    undefined,
    'KAN-13',
  );
  assert.equal(result.confidence, 'fallback');
  assert.equal(result.issueKey, 'KAN-13');
});

test('the fallback never overrides a real match', () => {
  // A branch issue key, a remembered mapping, and even a text suggestion all
  // outrank the catch-all.
  const explicit = resolveIssue(entry({ issueKey: 'PROJ-9' }), candidates, {}, undefined, 'KAN-13');
  assert.equal(explicit.issueKey, 'PROJ-9');

  const suggested = resolveIssue(entry(), candidates, {}, undefined, 'KAN-13');
  assert.equal(suggested.confidence, 'suggested');
  assert.equal(suggested.issueKey, 'PROJ-142');
});

test('fallback entries are pushed but still reported for assignment', () => {
  const e = entry({ description: 'Sprint planning' });
  const resolutions = new Map([
    [e.key, resolveIssue(e, candidates, {}, undefined, 'KAN-13')],
  ]);

  const split = partitionByIssue(resolutions, [e]);
  assert.equal(split.ready.length, 1, 'hours reach Jira');
  assert.equal(split.ready[0]!.issueKey, 'KAN-13');
  assert.equal(split.usedFallback.length, 1, 'and the user is told about it');
  assert.equal(split.needsIssue.length, 0);
});

test('without a fallback configured, unticketed work is still held back', () => {
  const e = entry({ description: 'Sprint planning' });
  const resolutions = new Map([[e.key, resolveIssue(e, candidates, {})]]);

  const split = partitionByIssue(resolutions, [e]);
  assert.equal(split.ready.length, 0);
  assert.equal(split.needsIssue.length, 1);
});

test('alternatives are offered even when nothing is confident enough', () => {
  const result = resolveIssue(entry({ description: 'pagination tweaks' }), candidates, {});
  assert.ok(result.alternatives.length > 0);
  assert.equal(result.alternatives[0]?.key, 'PROJ-77');
});
