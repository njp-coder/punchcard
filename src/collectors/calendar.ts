import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import { resolveSecret } from '../config.js';
import { cacheGet, cacheSet } from '../store.js';
import type { Period, Signal } from '../types.js';
import { endOfDay, startOfDay } from '../util/time.js';
import { extractIssueKey } from './git.js';
import { parseIcs, type IcsEvent } from './ics.js';

/**
 * Meetings, from private iCal URLs.
 *
 * This is the single largest block of hours git cannot see. A developer's week
 * is routinely a quarter meetings, and without this the reconstruction can only
 * ever explain the time spent committing.
 *
 * Calendar events are `measured`, not `inferred`: unlike a commit cluster, an
 * event carries a real start and a real end.
 */
export async function collectCalendar(cfg: Config, period: Period): Promise<Signal[]> {
  const calendars = cfg.calendars ?? [];
  if (!calendars.length) return [];

  const from = startOfDay(period.start);
  const to = endOfDay(period.end);
  const signals: Signal[] = [];

  for (const calendar of calendars) {
    let text: string;
    try {
      text = await fetchIcs(resolveSecret(calendar.url, `calendars.${calendar.name ?? 'ics'}.url`));
    } catch (err) {
      process.stderr.write(`  calendar "${calendar.name ?? 'ics'}" failed: ${(err as Error).message}\n`);
      continue;
    }

    const { events, unsupported } = parseIcs(text, from, to);

    if (unsupported.length) {
      process.stderr.write(
        `  ${unsupported.length} recurrence rule(s) in "${calendar.name ?? 'ics'}" could not be ` +
          'expanded and were treated as single events.\n',
      );
    }

    for (const event of events) {
      const skip = shouldSkip(event, cfg);
      if (skip) continue;

      signals.push({
        id: `cal:${hash(`${calendar.name}:${event.uid}:${event.start}`)}`,
        source: 'calendar',
        // A calendar event has a real start and end, unlike a commit cluster.
        confidence: 'measured',
        start: event.start,
        end: event.end,
        description: event.summary,
        hints: {
          calendarId: calendar.name,
          issueKey: extractIssueKey(event.summary),
          project: calendar.project,
        },
        detail: `meeting${event.attendeeCount ? ` · ${event.attendeeCount} attendees` : ''}`,
      });
    }
  }

  return signals;
}

/**
 * Which events are not work.
 *
 * Without this the calendar imports lunch, birthdays, out-of-office and every
 * declined invitation you never attended — and a timesheet that bills a client
 * for someone else's birthday is worse than no calendar at all.
 */
function shouldSkip(event: IcsEvent, cfg: Config): boolean {
  if (event.status === 'CANCELLED') return true;

  // You declined it, so you weren't there.
  if (event.partstat === 'DECLINED') return true;

  // Marked "free" — visible on the calendar, but not time spent.
  if (event.transparent) return true;

  // All-day entries are holidays, OOO and birthdays, not eight-hour meetings.
  if (event.allDay) return true;

  const minutes = (event.end - event.start) / 60000;
  if (minutes <= 0) return true;

  // A "meeting" longer than a working day is a marker, not an event you sat in.
  if (minutes > (cfg.calendarMaxMinutes ?? 480)) return true;

  const title = event.summary.toLowerCase();
  for (const pattern of cfg.calendarIgnore ?? DEFAULT_IGNORE) {
    if (title.includes(pattern.toLowerCase())) return true;
  }

  return false;
}

/**
 * Titles that are almost never billable work. Overridable in config, because
 * one team's "focus" block is another's actual deep work.
 */
export const DEFAULT_IGNORE = [
  'lunch',
  'ooo',
  'out of office',
  'holiday',
  'birthday',
  'pto',
  'vacation',
  'do not book',
  'busy',
];

async function fetchIcs(url: string): Promise<string> {
  const key = `ics:${hash(url)}`;

  // Short TTL: calendars change through the day, but re-fetching on every
  // `punch status` in a shell prompt would be rude to the provider.
  const cached = cacheGet<string>(key);
  if (cached) return cached;

  if (!/^https?:\/\//.test(url)) {
    throw new Error('calendar url must be an http(s) iCal address');
  }

  const response = await fetch(url, {
    headers: { Accept: 'text/calendar,text/plain;q=0.9,*/*;q=0.8' },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  if (!text.includes('BEGIN:VCALENDAR')) {
    throw new Error('that URL did not return an iCal feed. Check you copied the secret address');
  }

  cacheSet(key, text, 15 * 60 * 1000);
  return text;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
