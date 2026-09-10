import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Signal, SourceKind } from '../types.js';
import { resolveTimeline } from './timeline.js';
import { HOUR, startOfDay } from '../util/time.js';

const DAY_START = startOfDay('2026-09-09');

function signal(
  source: SourceKind,
  startHour: number,
  endHour: number,
  id: string = source,
): Signal {
  return {
    id: `${id}:${startHour}`,
    source,
    confidence: 'inferred',
    start: DAY_START + startHour * HOUR,
    end: DAY_START + endHour * HOUR,
    description: `${source} ${startHour}-${endHour}`,
    hints: {},
  };
}

const hours = (allocations: { seconds: number }[]) =>
  allocations.reduce((sum, a) => sum + a.seconds, 0) / 3600;

test('non-overlapping signals keep their full durations', () => {
  const result = resolveTimeline([signal('commit', 9, 11), signal('commit', 13, 15)]);
  assert.equal(hours(result), 4);
});

test('total billed time never exceeds elapsed wall clock', () => {
  // Three signals claiming the same two hours must not bill six.
  const result = resolveTimeline([
    signal('commit', 9, 11, 'a'),
    signal('editor', 9, 11, 'b'),
    signal('calendar', 9, 11, 'c'),
  ]);
  assert.equal(hours(result), 2);
});

test('higher-priority sources win the overlapping slice', () => {
  // A meeting 10-11 inside a commit session 9-12: the meeting owns that hour.
  const result = resolveTimeline([signal('commit', 9, 12), signal('calendar', 10, 11)]);

  const calendar = result.find((a) => a.signal.source === 'calendar');
  const commit = result.find((a) => a.signal.source === 'commit');

  assert.equal(calendar?.seconds, 1 * 3600);
  assert.equal(commit?.seconds, 2 * 3600);
  assert.equal(hours(result), 3);
});

test('a human declaration outranks a calendar invite', () => {
  // Scheduled for an hour, you say it took 30 minutes. You are right.
  const result = resolveTimeline([signal('calendar', 10, 11), signal('manual', 10, 10.5)]);

  const manual = result.find((a) => a.signal.source === 'manual');
  const calendar = result.find((a) => a.signal.source === 'calendar');

  assert.equal(manual?.seconds, 0.5 * 3600);
  assert.equal(calendar?.seconds, 0.5 * 3600);
});

test('equal priority breaks toward the more precise claim', () => {
  // A tight 30-minute claim is better evidence than a vague 3-hour one.
  const result = resolveTimeline([signal('manual', 9, 12, 'vague'), signal('manual', 10, 10.5, 'tight')]);

  const tight = result.find((a) => a.signal.id.startsWith('tight'));
  assert.equal(tight?.seconds, 0.5 * 3600);
  assert.equal(hours(result), 3);
});

test('a session crossing midnight is split across both dates', () => {
  const overnight: Signal = {
    id: 'late',
    source: 'commit',
    confidence: 'inferred',
    start: DAY_START + 23 * HOUR,
    end: DAY_START + 25 * HOUR,
    description: 'late night',
    hints: {},
  };

  const result = resolveTimeline([overnight]);
  const dates = result.map((a) => a.date).sort();

  assert.deepEqual(dates, ['2026-09-09', '2026-09-10']);
  assert.equal(hours(result), 2);
});

test('zero-length signals are ignored', () => {
  const point = signal('commit', 10, 10);
  assert.deepEqual(resolveTimeline([point]), []);
});
