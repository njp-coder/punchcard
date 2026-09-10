import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import type { Confidence, DraftEntry, Gap, Period, Signal, Timesheet } from '../types.js';
import { daysBetween, isWeekend, localDate, roundSeconds, startOfDay } from '../util/time.js';
import { resolveTimeline, type Allocation } from './timeline.js';

export interface ReconstructResult extends Timesheet {
  /** Things we couldn't map to a project. The CLI prompts once, then remembers. */
  unmapped: UnmappedHint[];
}

export interface UnmappedHint {
  kind: 'repo' | 'issuePrefix' | 'meeting';
  value: string;
  seconds: number;
}

export const UNASSIGNED = '(unassigned)';

/**
 * Unmapped work keeps its source in the project label — `(unassigned) sponsio`
 * rather than a bare `(unassigned)`.
 *
 * Without this, every unmapped repo shares one bucket, so a day spent across
 * three projects collapses into a single line whose description is an
 * unreadable pile of five sessions. Keeping them distinct also makes
 * `punch map` legible: you're assigning one named thing at a time.
 */
function unassigned(source?: string): string {
  return source ? `${UNASSIGNED} ${source}` : UNASSIGNED;
}

export function isUnassigned(project: string): boolean {
  return project === UNASSIGNED || project.startsWith(`${UNASSIGNED} `);
}

/**
 * Turn raw evidence into a reviewable timesheet.
 *
 * Two rules govern this function, and they are the reason the project exists:
 *
 *  1. Entries are consolidated to one per (date, project, issue). Nobody wants
 *     a timesheet with nine lines reading "fix typo", and a consolidated week
 *     is ~20 writes instead of ~70 — which is the difference between fitting
 *     inside a throttled free-tier API budget and crawling for three hours.
 *
 *  2. Unexplained time becomes a Gap, never a padded entry. If this is
 *     client-billed, inventing hours nobody worked is fraud with the user's
 *     name on it. The tool proposes; the human attests.
 */
export function reconstruct(signals: Signal[], cfg: Config, period: Period): ReconstructResult {
  const allocations = resolveTimeline(signals);

  const buckets = new Map<string, Allocation[]>();
  const unmapped = new Map<string, UnmappedHint>();

  for (const allocation of allocations) {
    const resolved = resolveProject(allocation.signal, cfg);

    if (resolved.unmapped) {
      const mapKey = `${resolved.unmapped.kind}:${resolved.unmapped.value}`;
      const existing = unmapped.get(mapKey);
      if (existing) existing.seconds += allocation.seconds;
      else unmapped.set(mapKey, { ...resolved.unmapped, seconds: allocation.seconds });
    }

    // The issue key participates in identity: Jira and Tempo log against an
    // issue, so two issues on one project on one day are two worklogs.
    const issueKey = allocation.signal.hints.issueKey;
    const bucketKey = `${allocation.date}|${resolved.project}|${issueKey ?? ''}`;

    let bucket = buckets.get(bucketKey);
    if (!bucket) buckets.set(bucketKey, (bucket = []));
    bucket.push(allocation);
  }

  const entries: DraftEntry[] = [];

  for (const [bucketKey, group] of buckets) {
    const [date, project, issueKey] = bucketKey.split('|');
    const raw = group.reduce((sum, a) => sum + a.seconds, 0);
    const seconds = roundSeconds(raw, cfg.roundToMinutes);
    if (seconds <= 0) continue;

    entries.push({
      date: date!,
      project: project!,
      issueKey: issueKey || undefined,
      branch: group.find((a) => a.signal.hints.branch)?.signal.hints.branch,
      description: describe(group),
      seconds,
      billable: cfg.projects[project!]?.billable ?? false,
      // Clamp into the day: a session that began before midnight is credited
      // to this date from midnight, not from yesterday evening.
      startMs: Math.max(startOfDay(date!), Math.min(...group.map((a) => a.signal.start))),
      provenance: {
        signalIds: group.map((a) => a.signal.id),
        summary: group.map(provenanceLine),
        confidence: weakestConfidence(group),
      },
      key: entryKey(date!, project!, issueKey || undefined),
    });
  }

  entries.sort((a, b) => a.date.localeCompare(b.date) || a.project.localeCompare(b.project));

  return {
    period,
    entries,
    gaps: computeGaps(entries, cfg, period),
    unmapped: [...unmapped.values()].sort((a, b) => b.seconds - a.seconds),
  };
}

/* ------------------------------------------------------------------ */
/* Project mapping                                                     */
/* ------------------------------------------------------------------ */

function resolveProject(
  signal: Signal,
  cfg: Config,
): { project: string; unmapped?: Omit<UnmappedHint, 'seconds'> } {
  // Explicit beats inferred, always.
  if (signal.hints.project) return { project: signal.hints.project };

  // An issue key is the strongest inference we have — it's why Jira is the
  // highest-accuracy destination this tool can write to.
  if (signal.hints.issueKey) {
    const prefix = signal.hints.issueKey.split('-')[0]!;
    const mapped = cfg.mapping.issuePrefix[prefix];
    if (mapped) return { project: mapped };
    // Fall back to the repo label when we have one: "(unassigned) api" is more
    // recognizable at review time than "(unassigned) PROJ".
    return {
      project: unassigned(signal.hints.repo ?? prefix),
      unmapped: { kind: 'issuePrefix', value: prefix },
    };
  }

  if (signal.hints.repo) {
    const mapped = cfg.mapping.repo[signal.hints.repo];
    if (mapped) return { project: mapped };
    return {
      project: unassigned(signal.hints.repo),
      unmapped: { kind: 'repo', value: signal.hints.repo },
    };
  }

  if (signal.source === 'calendar') {
    const title = signal.description;
    const mapped = cfg.mapping.meeting[title];
    if (mapped) return { project: mapped };

    // Group unmapped meetings by their calendar, not their title. Using the
    // title would repeat it as both project and description on every row, and
    // would scatter a day's meetings across one pseudo-project each. The
    // *mapping* prompt below is still per-title, so answering it splits them.
    return {
      project: unassigned(signal.hints.calendarId ?? 'meetings'),
      unmapped: { kind: 'meeting', value: title },
    };
  }

  return { project: UNASSIGNED };
}

/* ------------------------------------------------------------------ */
/* Descriptions, provenance, identity                                  */
/* ------------------------------------------------------------------ */

function describe(group: Allocation[]): string {
  // Longest-allocated signal first: the work you spent most of the day on
  // should lead the line a client eventually reads.
  const ordered = [...group].sort((a, b) => b.seconds - a.seconds);
  const parts: string[] = [];

  for (const allocation of ordered) {
    const text = allocation.signal.description.trim();
    if (text && !parts.includes(text)) parts.push(text);
    if (parts.length === 3) break;
  }

  const description = parts.join('; ');
  return description.length > 240 ? `${description.slice(0, 237)}...` : description;
}

function provenanceLine(allocation: Allocation): string {
  const { signal } = allocation;
  // Rendered as a chip in the UI and after an arrow in the terminal, so the
  // separator is a plain colon rather than a dash in either surface.
  return signal.detail ? `${signal.source}: ${signal.detail}` : signal.source;
}

function weakestConfidence(group: Allocation[]): Confidence {
  const rank: Record<Confidence, number> = { attested: 3, measured: 2, inferred: 1 };
  return group.reduce<Confidence>((worst, a) => {
    return rank[a.signal.confidence] < rank[worst] ? a.signal.confidence : worst;
  }, 'attested');
}

/**
 * Stable identity for a consolidated entry, so re-running reconciles instead
 * of appending. Description and duration deliberately do *not* participate:
 * when they change we want an update, not a duplicate.
 */
export function entryKey(date: string, project: string, issueKey?: string): string {
  return createHash('sha256')
    .update(`${date}|${project}|${issueKey ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

/** Hash of the mutable payload, used to detect that a human edited our entry. */
export function entryHash(entry: DraftEntry): string {
  return createHash('sha256')
    .update(`${entry.seconds}|${entry.description}`)
    .digest('hex')
    .slice(0, 16);
}

/* ------------------------------------------------------------------ */
/* Gaps                                                                */
/* ------------------------------------------------------------------ */

/**
 * Exported because gaps must be recomputed after user overrides are applied —
 * editing an entry up to 3h changes what's left unaccounted, and a stale gap
 * number is worse than no gap number.
 */
export function computeGaps(entries: DraftEntry[], cfg: Config, period: Period): Gap[] {
  const target = cfg.targetHoursPerDay * 3600;
  if (target <= 0) return [];

  const byDate = new Map<string, number>();
  for (const entry of entries) {
    byDate.set(entry.date, (byDate.get(entry.date) ?? 0) + entry.seconds);
  }

  const gaps: Gap[] = [];
  const today = localDate(Date.now());

  for (const date of daysBetween(period.start, period.end)) {
    // A day that hasn't happened yet isn't unaccounted for. Reporting "8h
    // missing" every Monday for the rest of the week trains people to ignore
    // the warning that matters.
    if (date > today) continue;

    const logged = byDate.get(date) ?? 0;

    // A weekend with no evidence is a weekend, not a gap. A weekend you
    // actually worked shows up because there's evidence for it.
    if (isWeekend(date) && logged === 0) continue;

    const missing = target - logged;
    // Sub-quarter-hour differences are rounding noise, not unaccounted work.
    if (missing >= 15 * 60) gaps.push({ date, seconds: missing, targetSeconds: target });
  }

  return gaps;
}
