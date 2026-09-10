import type { DraftEntry } from '../types.js';

/**
 * Resolving work to a Jira issue.
 *
 * Jira worklogs attach to an issue, never to a project, so an entry without an
 * issue key simply cannot be pushed. That makes issue resolution the hardest
 * required step in the whole pipeline — and the one place where guessing wrong
 * is worse than admitting we don't know, because a worklog on the wrong ticket
 * corrupts someone else's sprint reporting.
 *
 * So this returns a confidence tier, and only `certain` is ever pushed without
 * a human confirming it.
 */

export interface IssueCandidate {
  key: string;
  summary: string;
  status?: string;
  /** Whether the issue is assigned to the current user. */
  mine?: boolean;
  updatedAt?: number;
}

/**
 * `fallback` is pushed like `certain`, but stays visible.
 *
 * A catch-all issue is a real answer for meetings and admin, which genuinely
 * belong to no ticket. It must never become a quiet dumping ground though, so
 * these entries keep being offered for real assignment every run.
 */
export type IssueConfidence = 'certain' | 'fallback' | 'suggested' | 'unknown';

export interface IssueResolution {
  issueKey?: string;
  confidence: IssueConfidence;
  reason: string;
  /** Ranked alternatives to offer when we're not certain. */
  alternatives: Array<{ key: string; summary: string; score: number }>;
}

/** Learned branch/repo -> issue assignments, so we ask at most once. */
export type IssueMappings = Record<string, string>;

/**
 * The key a remembered issue assignment is stored under.
 *
 * Scoped by project even when a branch is present, because branch names are
 * not unique across repositories. Keying on `main` alone would mean assigning
 * one project's main-branch work to a ticket silently redirected every other
 * project's main-branch hours to it too.
 */
export function mappingKey(entry: { project: string }, branch?: string): string {
  return branch ? `branch:${entry.project}:${branch}` : `project:${entry.project}`;
}

/**
 * Resolve one entry to an issue.
 *
 * Tiers, strongest first:
 *   1. An explicit key already extracted from a branch name or commit message.
 *   2. A remembered choice for this branch — you answered once, we don't ask again.
 *   3. A text match against your open issues, offered as a suggestion only.
 *   4. Nothing. The entry is held back rather than pushed somewhere wrong.
 */
export function resolveIssue(
  entry: DraftEntry,
  candidates: IssueCandidate[],
  mappings: IssueMappings,
  branch?: string,
  fallbackIssue?: string,
): IssueResolution {
  if (entry.issueKey) {
    return {
      issueKey: entry.issueKey,
      confidence: 'certain',
      reason: 'issue key found in branch or commit',
      alternatives: [],
    };
  }

  const remembered = mappings[mappingKey(entry, branch)];
  if (remembered) {
    return {
      issueKey: remembered,
      confidence: 'certain',
      reason: branch ? `you mapped ${branch} to ${remembered}` : `you mapped this to ${remembered}`,
      alternatives: [],
    };
  }

  const ranked = rankCandidates(entry.description, candidates);
  const best = ranked[0];

  // A weak textual overlap is not evidence. Two Jira summaries in the same
  // codebase share vocabulary constantly, so a low score means "I don't know",
  // not "probably this one".
  if (best && best.score >= 0.34) {
    return {
      issueKey: best.key,
      confidence: 'suggested',
      reason: `text match with ${best.key}: "${best.summary}"`,
      alternatives: ranked.slice(0, 5),
    };
  }

  // A configured catch-all beats holding the hours back entirely, but only
  // because the user named the issue themselves. It is never a default.
  if (fallbackIssue) {
    return {
      issueKey: fallbackIssue,
      confidence: 'fallback',
      reason: `no ticket matched, using your fallback issue ${fallbackIssue}`,
      alternatives: ranked.slice(0, 5),
    };
  }

  return {
    confidence: 'unknown',
    reason: 'no issue key in the branch, and nothing matched your open issues',
    alternatives: ranked.slice(0, 5),
  };
}

/**
 * Score candidate issues against an entry's description.
 *
 * Deliberately a simple lexical overlap rather than embeddings: it runs
 * offline, is explainable to the user ("matched on: refresh, token"), and the
 * candidate pool is small — your open issues, not the whole backlog. An
 * unexplainable match on a billing record is worse than no match.
 */
export function rankCandidates(
  description: string,
  candidates: IssueCandidate[],
): Array<{ key: string; summary: string; score: number }> {
  const words = tokenize(description);
  if (!words.size) return [];

  return candidates
    .map((candidate) => {
      const summaryWords = tokenize(candidate.summary);
      let overlap = 0;
      for (const word of summaryWords) if (words.has(word)) overlap++;

      // Dice coefficient: forgiving about length differences between a terse
      // issue summary and a run-on commit description.
      const denominator = words.size + summaryWords.size;
      let score = denominator ? (2 * overlap) / denominator : 0;

      // A single shared word is coincidence, not evidence. "Fix the bug" and
      // "Fix the bug in checkout" overlap on one token and would otherwise
      // score 0.67 — high enough to be offered as a match on a billing record.
      if (overlap < 2) score *= 0.45;

      // Your own in-progress work is likelier than someone else's backlog.
      if (candidate.mine) score *= 1.15;
      if (candidate.status && /progress/i.test(candidate.status)) score *= 1.1;

      // Deliberately uncapped: this ranks candidates, it isn't a probability,
      // and clamping to 1 would flatten the boosts above into ties.
      return { key: candidate.key, summary: candidate.summary, score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** Words worth matching on: no punctuation, no filler, nothing tiny. */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/[\s-]+/)
      .map((word) => word.trim())
      .filter((word) => word.length > 2 && !STOPWORDS.has(word))
      .map(stem),
  );
}

/**
 * Commit and ticket vocabulary that carries no signal. "Fix the bug" and
 * "Fix the login bug" would otherwise look like a strong match.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'then', 'than',
  'add', 'adds', 'added', 'fix', 'fixes', 'fixed', 'update', 'updates', 'updated',
  'change', 'changes', 'changed', 'remove', 'removes', 'removed', 'make', 'makes',
  'use', 'uses', 'used', 'was', 'are', 'not', 'but', 'its', 'have', 'has', 'more',
  'chore', 'feat', 'refactor', 'wip', 'merge', 'bump', 'release', 'version',
  'work', 'working', 'code', 'test', 'tests', 'file', 'files',
]);

/** Crude suffix stripping so "refreshing" and "refresh" match. */
function stem(word: string): string {
  return word
    .replace(/(ing|ed|es|s)$/, '')
    .replace(/(.)\1$/, '$1');
}

/**
 * Split entries by whether they can be pushed to an issue-based destination.
 *
 * Held-back entries are surfaced for assignment rather than dropped silently —
 * losing an hour without saying so is the worst possible failure for a tool
 * people bill from.
 */
export function partitionByIssue(
  resolutions: Map<string, IssueResolution>,
  entries: DraftEntry[],
): { ready: DraftEntry[]; needsIssue: DraftEntry[]; usedFallback: DraftEntry[] } {
  const ready: DraftEntry[] = [];
  const needsIssue: DraftEntry[] = [];
  const usedFallback: DraftEntry[] = [];

  for (const entry of entries) {
    const resolution = resolutions.get(entry.key);

    if (!resolution?.issueKey) {
      needsIssue.push(entry);
      continue;
    }

    if (resolution.confidence === 'certain') {
      ready.push({ ...entry, issueKey: resolution.issueKey });
    } else if (resolution.confidence === 'fallback') {
      // Pushed, and reported. Both matter: the hours are not lost, and the
      // user is reminded they are sitting on a catch-all.
      const routed = { ...entry, issueKey: resolution.issueKey };
      ready.push(routed);
      usedFallback.push(routed);
    } else {
      needsIssue.push(entry);
    }
  }

  return { ready, needsIssue, usedFallback };
}
