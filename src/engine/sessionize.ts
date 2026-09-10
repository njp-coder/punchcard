import type { Config } from '../config.js';
import type { Signal } from '../types.js';
import { MINUTE } from '../util/time.js';

/**
 * Commits are points in time; timesheets need durations.
 *
 * We cluster a repo's commits into working sessions: consecutive commits less
 * than `gapMinutes` apart belong to the same stretch of work. A session starts
 * `preCommitMinutes` before its first commit — you were working before you
 * committed — and ends at its last commit.
 *
 * This is the fallback path. When WakaTime (or self-hosted wakapi) is
 * available it measures real editor time and supersedes all of this; git then
 * only answers *what* and *which project*, which it is far better at than
 * answering *how long*.
 */
export function sessionizeCommits(commits: Signal[], cfg: Config): Signal[] {
  const gap = cfg.sessionize.gapMinutes * MINUTE;
  const maxSession = cfg.sessionize.maxSessionMinutes * MINUTE;
  const preCommit = cfg.sessionize.preCommitMinutes * MINUTE;

  // Sessions are per-repo: committing to two repos in one afternoon is two
  // threads of work, not one interleaved blob.
  const byRepo = new Map<string, Signal[]>();
  for (const signal of commits) {
    const repo = signal.hints.repo ?? '(unknown)';
    let group = byRepo.get(repo);
    if (!group) byRepo.set(repo, (group = []));
    group.push(signal);
  }

  const sessions: Signal[] = [];

  for (const [repo, group] of byRepo) {
    const sorted = [...group].sort((a, b) => a.start - b.start);
    let cluster: Signal[] = [];

    const flush = () => {
      if (cluster.length) sessions.push(buildSession(repo, cluster, preCommit, maxSession));
      cluster = [];
    };

    for (const commit of sorted) {
      const previous = cluster[cluster.length - 1];
      if (previous && commit.start - previous.start > gap) flush();
      cluster.push(commit);
    }
    flush();
  }

  return sessions.sort((a, b) => a.start - b.start);
}

function buildSession(
  repo: string,
  cluster: Signal[],
  preCommit: number,
  maxSession: number,
): Signal {
  const first = cluster[0]!;
  const last = cluster[cluster.length - 1]!;

  const start = Math.max(first.start - preCommit, last.start - maxSession);
  const end = last.start;

  // Prefer the branch's issue key: it describes the whole session, whereas an
  // individual commit subject might mention an unrelated ticket in passing.
  const issueKey = cluster.find((c) => c.hints.issueKey)?.hints.issueKey;
  const branch = cluster.find((c) => c.hints.branch)?.hints.branch;
  const project = cluster.find((c) => c.hints.project)?.hints.project;

  const subjects = cluster.map((c) => c.description).filter(Boolean);

  return {
    id: `session:${repo}:${first.start}`,
    source: 'commit',
    confidence: 'inferred',
    start,
    end,
    description: summarize(subjects),
    hints: { repo, branch, issueKey, project },
    detail: `${cluster.length} commit${cluster.length === 1 ? '' : 's'}${
      branch ? ` on ${branch}` : ''
    }`,
  };
}

/**
 * A one-line summary of a session's commits.
 *
 * Deliberately dumb: joining subjects is honest and costs nothing. Turning
 * nine commit messages into one sentence a client can read is what the
 * optional LLM pass does — and it stays optional, because plenty of people
 * won't send commit messages to a third party.
 */
function summarize(subjects: string[]): string {
  const cleaned = subjects
    .map((s) => s.replace(/^\s*[A-Z][A-Z0-9]{1,9}-\d+[:\s]*/, '').trim())
    // Release chores describe no work: a line reading "0.5.4" on an invoice
    // tells a client nothing and crowds out the commits that do.
    .filter((s) => s && !/^v?\d+\.\d+(\.\d+)?(-[\w.]+)?$/.test(s))
    .filter((s) => !/^(bump|release|version)\b/i.test(s));

  if (!cleaned.length) return 'Development work';
  if (cleaned.length === 1) return cleaned[0]!;
  if (cleaned.length === 2) return `${cleaned[0]}; ${cleaned[1]}`;
  return `${cleaned[0]}; ${cleaned[1]} (+${cleaned.length - 2} more)`;
}
