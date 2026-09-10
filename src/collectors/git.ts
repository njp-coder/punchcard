import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import type { Period, Signal } from '../types.js';

const exec = promisify(execFile);

/** ASCII unit/record separators — safe against any commit message content. */
const FIELD = '\x1f';
const RECORD = '\x1e';

export interface Commit {
  hash: string;
  /** Author timestamp, epoch ms. */
  at: number;
  subject: string;
  repo: string;
  branch?: string;
  issueKey?: string;
}

/** PROJ-142 style keys, the thing that makes Jira mapping nearly free. */
const ISSUE_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/;

export function extractIssueKey(...sources: (string | undefined)[]): string | undefined {
  for (const source of sources) {
    if (!source) continue;
    // Branch names are often lowercase; commit subjects usually aren't.
    const match = ISSUE_KEY.exec(source) ?? ISSUE_KEY.exec(source.toUpperCase());
    if (match) return match[1];
  }
  return undefined;
}

/**
 * Read commits authored by the user across every configured repo.
 *
 * Note this reads *all* refs, not just the current branch: work on a branch you
 * have since switched away from still happened, and reconstructing last month
 * from HEAD alone would silently lose it.
 */
export async function collectGit(cfg: Config, period: Period): Promise<Signal[]> {
  const signals: Signal[] = [];

  for (const repo of cfg.repos) {
    if (!existsSync(join(repo.path, '.git'))) {
      process.stderr.write(`  skipped ${repo.path} (not a git repository)\n`);
      continue;
    }

    const authors = cfg.authors.length ? cfg.authors : await gitIdentity(repo.path);
    if (!authors.length) {
      process.stderr.write(`  skipped ${repo.path} (no git identity; set \`authors\` in config)\n`);
      continue;
    }

    const commits = await readCommits(repo.path, period, authors);
    const repoName = basename(repo.path);

    for (const commit of commits) {
      signals.push({
        id: `git:${commit.hash}`,
        source: 'commit',
        // A commit proves work happened, not how long it took. The sessionizer
        // turns these points into durations; until then, zero-length.
        confidence: 'inferred',
        start: commit.at,
        end: commit.at,
        description: commit.subject,
        hints: {
          repo: repoName,
          branch: commit.branch,
          issueKey: commit.issueKey,
          project: repo.project,
        },
      });
    }
  }

  return signals;
}

async function readCommits(repoPath: string, period: Period, authors: string[]): Promise<Commit[]> {
  const format = ['%H', '%at', '%s', '%S'].join(FIELD) + RECORD;

  const args = [
    '-C',
    repoPath,
    'log',
    '--all',
    '--source',
    '--no-merges',
    `--since=${period.start}T00:00:00`,
    `--until=${period.end}T23:59:59`,
    `--pretty=format:${format}`,
    ...authors.map((a) => `--author=${a}`),
  ];

  let stdout: string;
  try {
    // Busy monorepos can produce a lot of output; give it room.
    ({ stdout } = await exec('git', args, { maxBuffer: 64 * 1024 * 1024 }));
  } catch (err) {
    process.stderr.write(`  git log failed in ${repoPath}: ${(err as Error).message}\n`);
    return [];
  }

  const repo = basename(repoPath);
  const commits: Commit[] = [];

  for (const record of stdout.split(RECORD)) {
    const line = record.trim();
    if (!line) continue;

    const [hash, at, subject, ref] = line.split(FIELD);
    if (!hash || !at) continue;

    // `--source` reports whichever ref reached the commit first, which is
    // often a tag. A tag is not a branch and carries no issue key, so ignore
    // it rather than showing "3 commits on refs/tags/v0.5.3" in the review.
    const branch =
      ref && !ref.startsWith('refs/tags/')
        ? ref.replace(/^refs\/(heads|remotes)\//, '')
        : undefined;
    commits.push({
      hash,
      at: Number(at) * 1000,
      subject: subject?.trim() ?? '',
      repo,
      branch,
      issueKey: extractIssueKey(subject, branch),
    });
  }

  return commits.sort((a, b) => a.at - b.at);
}

async function gitIdentity(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await exec('git', ['-C', repoPath, 'config', 'user.email']);
    const email = stdout.trim();
    return email ? [email] : [];
  } catch {
    return [];
  }
}

/**
 * Find git repositories under a root, for `punch init`. Shallow by design —
 * scanning an entire home directory is slow and turns up vendored checkouts.
 */
export async function discoverRepos(root: string, maxDepth = 3): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable directory — not worth failing discovery over.
    }

    if (entries.some((e) => e.name === '.git')) {
      found.push(dir);
      return; // Don't descend into a repo looking for nested ones.
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      await walk(join(dir, entry.name), depth + 1);
    }
  }

  await walk(root, 0);
  return found;
}
