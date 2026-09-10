import { SOURCE_PRIORITY, type Signal } from '../types.js';
import { DAY, localDate, startOfDay } from '../util/time.js';

/** Seconds of wall-clock awarded to one signal on one local date. */
export interface Allocation {
  signal: Signal;
  date: string;
  seconds: number;
}

/**
 * Resolve overlapping evidence into a single non-overlapping timeline.
 *
 * Two signals routinely claim the same minutes: you commit during a meeting,
 * WakaTime counts an editor open behind a call, a session you logged by hand
 * covers a calendar block. Billing both is how you end up claiming eleven hours
 * for a nine-hour day.
 *
 * We sweep the boundaries of every interval and award each atomic slice to the
 * single highest-priority signal covering it (see SOURCE_PRIORITY: a human
 * saying "it took 40 minutes" outranks a 60-minute calendar invite, which
 * outranks anything we inferred from commit timestamps).
 *
 * Because slices never overlap, total billed time can never exceed elapsed
 * wall-clock. That property is why this is a sweep and not a sum.
 */
export function resolveTimeline(signals: Signal[]): Allocation[] {
  const intervals = signals
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  if (!intervals.length) return [];

  const boundaries = new Set<number>();
  for (const signal of intervals) {
    boundaries.add(signal.start);
    boundaries.add(signal.end);
    // Split at local midnight so a session that runs past 00:00 is credited to
    // both dates instead of landing entirely on the day it started.
    for (
      let midnight = startOfDay(localDate(signal.start)) + DAY;
      midnight < signal.end;
      midnight += DAY
    ) {
      boundaries.add(midnight);
    }
  }

  const points = [...boundaries].sort((a, b) => a - b);
  const totals = new Map<string, Allocation>();

  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i]!;
    const to = points[i + 1]!;
    if (to <= from) continue;

    const winner = pickWinner(intervals, from, to);
    if (!winner) continue;

    const date = localDate(from);
    const mapKey = `${winner.id}|${date}`;
    const existing = totals.get(mapKey);

    if (existing) {
      existing.seconds += (to - from) / 1000;
    } else {
      totals.set(mapKey, { signal: winner, date, seconds: (to - from) / 1000 });
    }
  }

  return [...totals.values()].sort((a, b) => a.signal.start - b.signal.start);
}

/**
 * Highest-priority signal covering [from, to). Ties break toward the shorter
 * interval — a precise 30-minute claim is better evidence for those 30 minutes
 * than a vague three-hour one that happens to contain them.
 */
function pickWinner(intervals: Signal[], from: number, to: number): Signal | undefined {
  let best: Signal | undefined;
  let bestPriority = -1;
  let bestSpan = Infinity;

  for (const signal of intervals) {
    if (signal.start > from) break; // Sorted by start — nothing later can cover.
    if (signal.end < to) continue;

    const priority = SOURCE_PRIORITY[signal.source];
    const span = signal.end - signal.start;

    if (priority > bestPriority || (priority === bestPriority && span < bestSpan)) {
      best = signal;
      bestPriority = priority;
      bestSpan = span;
    }
  }

  return best;
}
