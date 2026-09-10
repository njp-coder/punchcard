/**
 * A focused iCalendar (RFC 5545) reader.
 *
 * We take calendars as private ICS URLs rather than through OAuth. Google and
 * Outlook both publish one per calendar, which means no app to register and no
 * client secret — something an open-source tool cannot ship anyway, and which
 * would otherwise force every user to create their own cloud project.
 *
 * Scope is deliberately the common real-world calendar: folded lines, TZID and
 * UTC times, all-day events, cancellations, free/busy transparency, and the
 * recurrence rules that standups and weekly syncs actually use. Exotic RRULE
 * features (BYSETPOS, BYMONTHDAY, BYYEARDAY) are not expanded — see
 * `unsupported` on the result rather than guessing at them.
 */

export interface IcsEvent {
  uid: string;
  summary: string;
  /** Epoch ms. */
  start: number;
  end: number;
  allDay: boolean;
  status?: string;
  /** TRANSP:TRANSPARENT means "free" — shown on the calendar but not busy. */
  transparent: boolean;
  /** PARTSTAT for the calendar owner, when the feed includes it. */
  partstat?: string;
  attendeeCount: number;
  organizer?: string;
  recurring: boolean;
}

export interface IcsParseResult {
  events: IcsEvent[];
  /** Rules we saw but chose not to expand, surfaced instead of silently dropped. */
  unsupported: string[];
}

/** Parse an ICS document and expand recurrences across [from, to] (epoch ms). */
export function parseIcs(text: string, from: number, to: number): IcsParseResult {
  const lines = unfold(text);
  const events: IcsEvent[] = [];
  const unsupported: string[] = [];

  let current: Record<string, { value: string; params: Record<string, string> }> | null = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }

    if (line === 'END:VEVENT') {
      if (current) {
        const parsed = buildEvents(current, from, to, unsupported);
        events.push(...parsed);
      }
      current = null;
      continue;
    }

    if (!current) continue;

    const parsed = parseLine(line);
    if (parsed) {
      // Keep the first occurrence of repeated properties except EXDATE, which
      // legitimately repeats and must accumulate.
      if (parsed.name === 'EXDATE' && current.EXDATE) {
        current.EXDATE.value += `,${parsed.value}`;
      } else if (!current[parsed.name] || parsed.name === 'ATTENDEE') {
        current[parsed.name] = { value: parsed.value, params: parsed.params };
        if (parsed.name === 'ATTENDEE') {
          current.__attendees = {
            value: String(Number(current.__attendees?.value ?? 0) + 1),
            params: {},
          };
        }
      }
    }
  }

  return { events: events.sort((a, b) => a.start - b.start), unsupported };
}

/* ------------------------------------------------------------------ */
/* Lexing                                                              */
/* ------------------------------------------------------------------ */

/**
 * RFC 5545 folds long lines by inserting CRLF followed by a single space or
 * tab. Unfolding must happen before anything else or SUMMARY values get cut in
 * half — which shows up as truncated meeting titles.
 */
export function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out: string[] = [];

  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }

  return out.filter((line) => line.trim().length > 0);
}

function parseLine(
  line: string,
): { name: string; value: string; params: Record<string, string> } | null {
  const colon = indexOfUnquoted(line, ':');
  if (colon < 0) return null;

  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);

  const [name, ...paramParts] = left.split(';');
  const params: Record<string, string> = {};

  for (const part of paramParts) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
    }
  }

  return { name: (name ?? '').toUpperCase(), value, params };
}

/** Colons appear inside quoted parameter values (mailto: URIs, for instance). */
function indexOfUnquoted(line: string, char: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === char && !quoted) return i;
  }
  return -1;
}

function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, ' ')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

export interface IcsDate {
  ms: number;
  allDay: boolean;
}

/**
 * Parse a DTSTART/DTEND value in any of the three forms RFC 5545 allows:
 * a floating local time, a UTC time ending in Z, or a wall time qualified by
 * TZID. The TZID case is the one that matters most — a recurring 09:30 standup
 * stays at 09:30 across a DST boundary, which a fixed offset would get wrong.
 */
export function parseIcsDate(value: string, params: Record<string, string> = {}): IcsDate | null {
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (date) {
    const [, y, m, d] = date;
    return { ms: new Date(Number(y), Number(m) - 1, Number(d)).getTime(), allDay: true };
  }

  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!dateTime) return null;

  const [, y, mo, d, h, mi, s, utc] = dateTime.map((part) => part) as string[];
  const parts = [Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s)] as const;

  if (utc) {
    return {
      ms: Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]),
      allDay: false,
    };
  }

  const tzid = params.TZID;
  if (tzid) {
    const ms = zonedWallTimeToUtc(parts, tzid);
    if (ms !== null) return { ms, allDay: false };
  }

  // Floating time: interpret in the machine's own zone, which is what the
  // spec intends and what the user sees in their calendar app.
  return {
    ms: new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]).getTime(),
    allDay: false,
  };
}

/**
 * Convert a wall-clock time in a named IANA zone to epoch ms.
 *
 * Done via Intl rather than a bundled tz database: correct across DST, and it
 * keeps punchcard dependency-free. Two passes because the offset itself
 * depends on the instant we're solving for.
 */
/**
 * Outlook publishes Windows timezone names, not IANA ones.
 *
 * Google emits `TZID:Europe/London`; Outlook emits `TZID:GMT Standard Time`.
 * Intl only understands the IANA form, so without this map an Outlook feed
 * silently falls back to the machine's own zone and every meeting lands at the
 * wrong time. Silently, which is the dangerous part: the hours look plausible.
 *
 * Covers the zones people actually work in. An unmapped name still falls back,
 * but `unmappedTimeZones` records it so the collector can say so out loud.
 */
const WINDOWS_TO_IANA: Record<string, string> = {
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Russian Standard Time': 'Europe/Moscow',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Arabian Standard Time': 'Asia/Dubai',
  'Arab Standard Time': 'Asia/Riyadh',
  'India Standard Time': 'Asia/Kolkata',
  'Sri Lanka Standard Time': 'Asia/Colombo',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'Singapore Standard Time': 'Asia/Singapore',
  'China Standard Time': 'Asia/Shanghai',
  'Taipei Standard Time': 'Asia/Taipei',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Central Standard Time': 'Australia/Darwin',
  'W. Australia Standard Time': 'Australia/Perth',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',
  'Newfoundland Standard Time': 'America/St_Johns',
  'Canada Central Standard Time': 'America/Regina',
  'SA Pacific Standard Time': 'America/Bogota',
  'SA Eastern Standard Time': 'America/Cayenne',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'Central America Standard Time': 'America/Guatemala',
  'Mexico Standard Time': 'America/Mexico_City',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'E. Africa Standard Time': 'Africa/Nairobi',
  'Egypt Standard Time': 'Africa/Cairo',
  'Morocco Standard Time': 'Africa/Casablanca',
  'Pakistan Standard Time': 'Asia/Karachi',
  'West Asia Standard Time': 'Asia/Tashkent',
  'Central Asia Standard Time': 'Asia/Almaty',
  'Iran Standard Time': 'Asia/Tehran',
  'Georgian Standard Time': 'Asia/Tbilisi',
  'Azerbaijan Standard Time': 'Asia/Baku',
  'Caucasus Standard Time': 'Asia/Yerevan',
  UTC: 'UTC',
  'UTC+12': 'Pacific/Auckland',
};

/** TZIDs we saw but could not resolve, so the collector can report them. */
export const unmappedTimeZones = new Set<string>();

export function normalizeTimeZone(tzid: string): string {
  const cleaned = tzid.replace(/^"|"$/g, '').trim();
  if (WINDOWS_TO_IANA[cleaned]) return WINDOWS_TO_IANA[cleaned]!;

  // Outlook sometimes prefixes its own zones, e.g. "tzone://Microsoft/Utc".
  const suffix = /tzone:\/\/Microsoft\/(.+)$/.exec(cleaned);
  if (suffix) return suffix[1] === 'Utc' ? 'UTC' : cleaned;

  return cleaned;
}

export function zonedWallTimeToUtc(
  [y, mo, d, h, mi, s]: readonly [number, number, number, number, number, number],
  rawTimeZone: string,
): number | null {
  const timeZone = normalizeTimeZone(rawTimeZone);

  try {
    const guess = Date.UTC(y, mo - 1, d, h, mi, s);
    const first = offsetAt(guess, timeZone);
    let ms = guess - first;

    const second = offsetAt(ms, timeZone);
    if (second !== first) ms = guess - second;

    return ms;
  } catch {
    // Record it so the collector can warn rather than silently shifting every
    // meeting in the feed by the difference between two timezones.
    unmappedTimeZones.add(rawTimeZone);
    return null;
  }
}

function offsetAt(ms: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }

  const asUtc = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour! === 24 ? 0 : parts.hour!,
    parts.minute!,
    parts.second!,
  );

  return asUtc - ms;
}

/* ------------------------------------------------------------------ */
/* Events and recurrence                                               */
/* ------------------------------------------------------------------ */

type Props = Record<string, { value: string; params: Record<string, string> }>;

function buildEvents(props: Props, from: number, to: number, unsupported: string[]): IcsEvent[] {
  const dtstart = props.DTSTART && parseIcsDate(props.DTSTART.value, props.DTSTART.params);
  if (!dtstart) return [];

  const dtend = props.DTEND && parseIcsDate(props.DTEND.value, props.DTEND.params);

  // An event with no DTEND but a DURATION, or neither, still has a length:
  // all-day defaults to 24h, timed defaults to zero and gets filtered later.
  const duration = dtend
    ? dtend.ms - dtstart.ms
    : props.DURATION
      ? parseIcsDuration(props.DURATION.value)
      : dtstart.allDay
        ? 24 * 3600 * 1000
        : 0;

  const base: Omit<IcsEvent, 'start' | 'end'> = {
    uid: props.UID?.value ?? `${dtstart.ms}`,
    summary: unescapeText(props.SUMMARY?.value ?? '(no title)'),
    allDay: dtstart.allDay,
    status: props.STATUS?.value,
    transparent: props.TRANSP?.value === 'TRANSPARENT',
    partstat: props.ATTENDEE?.params.PARTSTAT,
    attendeeCount: Number(props.__attendees?.value ?? 0),
    organizer: props.ORGANIZER?.value,
    recurring: Boolean(props.RRULE),
  };

  if (!props.RRULE) {
    // Range-filter here too. Recurring events are bounded by expandRrule, but
    // a one-off was previously returned whatever its date, so a calendar with
    // years of history reported totals far larger than the period itself.
    const start = dtstart.ms;
    const end = start + duration;
    if (end < from || start > to) return [];
    return [{ ...base, start, end }];
  }

  const excluded = new Set<number>();
  if (props.EXDATE) {
    for (const value of props.EXDATE.value.split(',')) {
      const parsed = parseIcsDate(value.trim(), props.EXDATE.params);
      if (parsed) excluded.add(parsed.ms);
    }
  }

  const starts = expandRrule(props.RRULE.value, dtstart.ms, from, to, unsupported);

  return starts
    .filter((start) => !excluded.has(start))
    .map((start) => ({ ...base, start, end: start + duration }));
}

/** ISO 8601 durations as used by DURATION, e.g. PT1H30M. */
export function parseIcsDuration(value: string): number {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim(),
  );
  if (!match) return 0;

  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const total =
    (Number(weeks ?? 0) * 7 * 86400 +
      Number(days ?? 0) * 86400 +
      Number(hours ?? 0) * 3600 +
      Number(minutes ?? 0) * 60 +
      Number(seconds ?? 0)) *
    1000;

  return sign === '-' ? -total : total;
}

const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/**
 * Expand the recurrence rules that real work calendars use: daily standups,
 * weekly syncs on specific days, fortnightly one-to-ones, monthly reviews.
 *
 * Bounded by the requested window, so a rule with no COUNT or UNTIL — very
 * common for standups — cannot run away.
 */
export function expandRrule(
  rule: string,
  dtstart: number,
  from: number,
  to: number,
  unsupported: string[] = [],
): number[] {
  const parts: Record<string, string> = {};
  for (const piece of rule.split(';')) {
    const eq = piece.indexOf('=');
    if (eq > 0) parts[piece.slice(0, eq).toUpperCase()] = piece.slice(eq + 1);
  }

  const freq = parts.FREQ;
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) {
    unsupported.push(rule);
    return [dtstart];
  }

  if (parts.BYSETPOS || parts.BYYEARDAY || parts.BYMONTHDAY) {
    // Rather than approximate, report it. A meeting placed on the wrong day
    // is worse than a meeting we admit we couldn't expand.
    unsupported.push(rule);
    return [dtstart];
  }

  const interval = Math.max(1, Number(parts.INTERVAL ?? 1));
  const count = parts.COUNT ? Number(parts.COUNT) : Infinity;
  const until = parts.UNTIL ? (parseIcsDate(parts.UNTIL)?.ms ?? Infinity) : Infinity;
  const byDay = parts.BYDAY
    ? parts.BYDAY.split(',').map((d) => WEEKDAYS[d.trim().slice(-2).toUpperCase()])
    : undefined;

  const out: number[] = [];
  const anchor = new Date(dtstart);
  let emitted = 0;

  // Hard iteration ceiling: a corrupt rule must not spin forever.
  for (let step = 0; step < 4000 && emitted < count; step++) {
    let occurrence: Date;

    if (freq === 'DAILY') {
      occurrence = new Date(dtstart);
      occurrence.setDate(anchor.getDate() + step * interval);
    } else if (freq === 'WEEKLY') {
      occurrence = new Date(dtstart);
      occurrence.setDate(anchor.getDate() + step * 7 * interval);
    } else if (freq === 'MONTHLY') {
      occurrence = new Date(dtstart);
      occurrence.setMonth(anchor.getMonth() + step * interval);
    } else {
      occurrence = new Date(dtstart);
      occurrence.setFullYear(anchor.getFullYear() + step * interval);
    }

    if (occurrence.getTime() > until) break;
    if (occurrence.getTime() > to && freq !== 'WEEKLY') break;
    if (occurrence.getTime() > to + 7 * 86400 * 1000) break;

    if (freq === 'WEEKLY' && byDay?.length) {
      // Emit each requested weekday within this week.
      const weekStart = new Date(occurrence);
      weekStart.setDate(occurrence.getDate() - occurrence.getDay());

      for (const day of byDay) {
        if (day === undefined) continue;
        const candidate = new Date(weekStart);
        candidate.setDate(weekStart.getDate() + day);
        candidate.setHours(
          anchor.getHours(),
          anchor.getMinutes(),
          anchor.getSeconds(),
          anchor.getMilliseconds(),
        );

        const ms = candidate.getTime();
        if (ms < dtstart || ms > until) continue;
        if (ms >= from && ms <= to) out.push(ms);
        emitted++;
        if (emitted >= count) break;
      }
      continue;
    }

    const ms = occurrence.getTime();
    if (ms >= from && ms <= to) out.push(ms);
    emitted++;
  }

  return [...new Set(out)].sort((a, b) => a - b);
}
