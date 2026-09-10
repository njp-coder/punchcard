import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PeriodConfig } from '../types.js';
import { resolvePeriod } from './period.js';
import { parseDuration, roundSeconds } from './time.js';

const weekly: PeriodConfig = { type: 'weekly', weekStart: 1 };

test('a weekly period starts on the configured day', () => {
  // 2026-09-10 is a Thursday; the Monday-start week begins 2026-09-07.
  const period = resolvePeriod(weekly, '2026-09-10');
  assert.equal(period.start, '2026-09-07');
  assert.equal(period.end, '2026-09-13');
});

test('weekStart 0 gives a Sunday-Saturday week', () => {
  const period = resolvePeriod({ type: 'weekly', weekStart: 0 }, '2026-09-10');
  assert.equal(period.start, '2026-09-06');
  assert.equal(period.end, '2026-09-12');
});

test('semi-monthly splits at the 15th', () => {
  const cfg: PeriodConfig = { type: 'semimonthly', weekStart: 1 };

  const first = resolvePeriod(cfg, '2026-09-08');
  assert.equal(first.start, '2026-09-01');
  assert.equal(first.end, '2026-09-15');

  const second = resolvePeriod(cfg, '2026-09-22');
  assert.equal(second.start, '2026-09-16');
  assert.equal(second.end, '2026-09-30');
});

test('semi-monthly handles February in a leap year', () => {
  const period = resolvePeriod({ type: 'semimonthly', weekStart: 1 }, '2028-02-20');
  assert.equal(period.end, '2028-02-29');
});

test('monthly covers the whole month', () => {
  const period = resolvePeriod({ type: 'monthly', weekStart: 1 }, '2026-09-10');
  assert.equal(period.start, '2026-09-01');
  assert.equal(period.end, '2026-09-30');
});

test('biweekly aligns to its anchor in both directions', () => {
  const cfg: PeriodConfig = { type: 'biweekly', weekStart: 1, anchor: '2026-09-07' };

  const onAnchor = resolvePeriod(cfg, '2026-09-10');
  assert.equal(onAnchor.start, '2026-09-07');
  assert.equal(onAnchor.end, '2026-09-20');

  // A date in the following fortnight belongs to the next cycle, not this one.
  const next = resolvePeriod(cfg, '2026-09-23');
  assert.equal(next.start, '2026-09-21');

  // And a date before the anchor still lands on a cycle boundary.
  const before = resolvePeriod(cfg, '2026-08-30');
  assert.equal(before.start, '2026-08-24');
});

test('parseDuration accepts the shapes people actually type', () => {
  assert.equal(parseDuration('1h'), 3600);
  assert.equal(parseDuration('90m'), 5400);
  assert.equal(parseDuration('1h30m'), 5400);
  assert.equal(parseDuration('1h 30m'), 5400);
  assert.equal(parseDuration('1.5h'), 5400);
  assert.equal(parseDuration('45'), 2700); // bare number is minutes
  assert.equal(parseDuration('lunch'), null);
  assert.equal(parseDuration(''), null);
});

test('rounding never rounds work down to nothing', () => {
  // A four-minute task at a 15-minute increment must not vanish.
  assert.equal(roundSeconds(4 * 60, 15), 15 * 60);
  assert.equal(roundSeconds(16 * 60, 15), 30 * 60);
  assert.equal(roundSeconds(30 * 60, 15), 30 * 60);
  assert.equal(roundSeconds(1234, 0), 1234); // disabled
});
