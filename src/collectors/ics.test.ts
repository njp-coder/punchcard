import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expandRrule, parseIcs, parseIcsDate, parseIcsDuration, unfold, zonedWallTimeToUtc } from './ics.js';

const WEEK_FROM = Date.parse('2026-09-07T00:00:00Z');
const WEEK_TO = Date.parse('2026-09-13T23:59:59Z');

function ics(body: string): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', body, 'END:VCALENDAR'].join('\r\n');
}

test('folded lines are rejoined before parsing', () => {
  // RFC 5545 wraps long values; a naive reader truncates meeting titles.
  const lines = unfold('SUMMARY:Quarterly planning\r\n  with the platform team\r\nEND:VEVENT');
  assert.equal(lines[0], 'SUMMARY:Quarterly planning with the platform team');
});

test('a simple timed event is parsed with real start and end', () => {
  const { events } = parseIcs(
    ics(
      [
        'BEGIN:VEVENT',
        'UID:a1',
        'SUMMARY:Sprint review',
        'DTSTART:20260909T140000Z',
        'DTEND:20260909T150000Z',
        'END:VEVENT',
      ].join('\r\n'),
    ),
    WEEK_FROM,
    WEEK_TO,
  );

  assert.equal(events.length, 1);
  assert.equal(events[0]!.summary, 'Sprint review');
  assert.equal(events[0]!.end - events[0]!.start, 3600 * 1000);
});

test('escaped commas in a summary are unescaped', () => {
  const { events } = parseIcs(
    ics(
      [
        'BEGIN:VEVENT',
        'UID:a2',
        'SUMMARY:Planning\\, design\\, and estimates',
        'DTSTART:20260909T140000Z',
        'DTEND:20260909T150000Z',
        'END:VEVENT',
      ].join('\r\n'),
    ),
    WEEK_FROM,
    WEEK_TO,
  );
  assert.equal(events[0]!.summary, 'Planning, design, and estimates');
});

test('a daily standup expands across the week', () => {
  const { events } = parseIcs(
    ics(
      [
        'BEGIN:VEVENT',
        'UID:standup',
        'SUMMARY:Standup',
        'DTSTART:20260907T090000Z',
        'DTEND:20260907T091500Z',
        'RRULE:FREQ=DAILY;COUNT=20',
        'END:VEVENT',
      ].join('\r\n'),
    ),
    WEEK_FROM,
    WEEK_TO,
  );

  // Seven days in the window, all 15 minutes.
  assert.equal(events.length, 7);
  for (const event of events) assert.equal(event.end - event.start, 15 * 60 * 1000);
});

test('EXDATE removes a cancelled occurrence', () => {
  const { events } = parseIcs(
    ics(
      [
        'BEGIN:VEVENT',
        'UID:standup',
        'SUMMARY:Standup',
        'DTSTART:20260907T090000Z',
        'DTEND:20260907T091500Z',
        'RRULE:FREQ=DAILY;COUNT=20',
        'EXDATE:20260909T090000Z',
        'END:VEVENT',
      ].join('\r\n'),
    ),
    WEEK_FROM,
    WEEK_TO,
  );

  assert.equal(events.length, 6);
  assert.ok(!events.some((e) => e.start === Date.parse('2026-09-09T09:00:00Z')));
});

test('a weekly rule on specific days emits only those days', () => {
  const starts = expandRrule(
    'FREQ=WEEKLY;BYDAY=TU,TH',
    Date.parse('2026-09-08T10:00:00Z'),
    WEEK_FROM,
    WEEK_TO,
  );
  assert.equal(starts.length, 2);
});

test('an unsupported rule is reported rather than approximated', () => {
  // Placing a meeting on the wrong day is worse than admitting we can't.
  const unsupported: string[] = [];
  const starts = expandRrule(
    'FREQ=MONTHLY;BYSETPOS=-1;BYDAY=FR',
    Date.parse('2026-09-25T10:00:00Z'),
    WEEK_FROM,
    Date.parse('2026-12-31T00:00:00Z'),
    unsupported,
  );
  assert.equal(unsupported.length, 1);
  assert.equal(starts.length, 1);
});

test('a rule with no COUNT or UNTIL cannot run away', () => {
  const starts = expandRrule(
    'FREQ=DAILY',
    Date.parse('2020-01-01T09:00:00Z'),
    WEEK_FROM,
    WEEK_TO,
  );
  assert.ok(starts.length <= 8, `expected a bounded expansion, got ${starts.length}`);
});

test('TZID wall time survives a DST change', () => {
  // 09:30 London is 08:30Z in summer and 09:30Z in winter. A fixed offset
  // would drift a recurring standup by an hour.
  const summer = zonedWallTimeToUtc([2026, 7, 15, 9, 30, 0], 'Europe/London');
  const winter = zonedWallTimeToUtc([2026, 12, 15, 9, 30, 0], 'Europe/London');

  assert.equal(new Date(summer!).toISOString(), '2026-07-15T08:30:00.000Z');
  assert.equal(new Date(winter!).toISOString(), '2026-12-15T09:30:00.000Z');
});

test('an unknown TZID falls back instead of throwing', () => {
  assert.equal(zonedWallTimeToUtc([2026, 9, 9, 9, 0, 0], 'Mars/Olympus'), null);
  assert.ok(parseIcsDate('20260909T090000', { TZID: 'Mars/Olympus' }));
});

test('all-day values are flagged', () => {
  assert.equal(parseIcsDate('20260909')?.allDay, true);
  assert.equal(parseIcsDate('20260909T090000Z')?.allDay, false);
});

test('DURATION supplies a length when DTEND is absent', () => {
  assert.equal(parseIcsDuration('PT1H30M'), 90 * 60 * 1000);
  assert.equal(parseIcsDuration('PT45M'), 45 * 60 * 1000);
  assert.equal(parseIcsDuration('P1D'), 86400 * 1000);

  const { events } = parseIcs(
    ics(
      [
        'BEGIN:VEVENT',
        'UID:d1',
        'SUMMARY:Retro',
        'DTSTART:20260909T140000Z',
        'DURATION:PT45M',
        'END:VEVENT',
      ].join('\r\n'),
    ),
    WEEK_FROM,
    WEEK_TO,
  );
  assert.equal(events[0]!.end - events[0]!.start, 45 * 60 * 1000);
});

test('status, transparency and declined attendance are exposed for filtering', () => {
  const { events } = parseIcs(
    ics(
      [
        'BEGIN:VEVENT',
        'UID:c1',
        'SUMMARY:Cancelled thing',
        'DTSTART:20260909T140000Z',
        'DTEND:20260909T150000Z',
        'STATUS:CANCELLED',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:c2',
        'SUMMARY:Free block',
        'DTSTART:20260909T160000Z',
        'DTEND:20260909T170000Z',
        'TRANSP:TRANSPARENT',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:c3',
        'SUMMARY:Declined invite',
        'DTSTART:20260910T160000Z',
        'DTEND:20260910T170000Z',
        'ATTENDEE;PARTSTAT=DECLINED;CN="Me":mailto:me@example.com',
        'END:VEVENT',
      ].join('\r\n'),
    ),
    WEEK_FROM,
    WEEK_TO,
  );

  assert.equal(events.find((e) => e.uid === 'c1')?.status, 'CANCELLED');
  assert.equal(events.find((e) => e.uid === 'c2')?.transparent, true);
  // A quoted CN containing a colon must not break parameter parsing.
  assert.equal(events.find((e) => e.uid === 'c3')?.partstat, 'DECLINED');
});
