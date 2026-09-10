/** Local-time helpers. Everything user-facing is local; only APIs see UTC. */

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Epoch ms -> local calendar date, YYYY-MM-DD. */
export function localDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** YYYY-MM-DD -> epoch ms at local midnight. */
export function startOfDay(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!, 0, 0, 0, 0).getTime();
}

export function endOfDay(date: string): number {
  return startOfDay(date) + DAY - 1;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return localDate(new Date(y!, m! - 1, d! + n).getTime());
}

export function daysBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let cur = start;
  // Guard against a malformed range spinning forever.
  for (let i = 0; i < 400 && cur <= end; i++) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

/** 0 = Sunday .. 6 = Saturday, in local time. */
export function dayOfWeek(date: string): number {
  return new Date(startOfDay(date)).getDay();
}

export function isWeekend(date: string): boolean {
  const d = dayOfWeek(date);
  return d === 0 || d === 6;
}

/** Local wall-clock time as HH:MM. */
export function localTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Turn spoken-English quantities into digits so the duration matcher can see
 * them: "half an hour", "an hour and a half", "last one hour", "a couple of
 * hours".
 *
 * This exists because of how people actually report time in chat — and even
 * more so when dictating. Nobody says "one h thirty m" out loud, so a parser
 * that only accepts "1h30m" rejects most of what a developer would type into
 * Slack after a meeting.
 */
export function normalizeSpokenDuration(input: string): string {
  let s = ` ${input.toLowerCase()} `;

  // Compound fractions first — they must not be split by the rules below.
  s = s.replace(/\b(an?\s+)?hour\s+and\s+a\s+half\b/g, ' 90 minutes ');
  s = s.replace(/\bhalf\s+an?\s+hour\b/g, ' 30 minutes ');
  s = s.replace(/\b(a\s+)?quarter\s+(of\s+)?an?\s+hour\b/g, ' 15 minutes ');
  s = s.replace(/\bhalf\s+a\s+day\b/g, ' 4 hours ');

  // "a couple of hours" / "a few minutes". "few" stays deliberately absent for
  // hours: guessing 3 billable hours from a vague word is exactly the kind of
  // invention this tool refuses to do.
  s = s.replace(/\ba\s+couple\s+(of\s+)?/g, ' 2 ');

  const WORDS: Record<string, string> = {
    one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
    seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
    fifteen: '15', twenty: '20', thirty: '30', forty: '40', fortyfive: '45', sixty: '60',
  };
  for (const [word, digit] of Object.entries(WORDS)) {
    s = s.replace(new RegExp(`\\b${word}\\b`, 'g'), digit);
  }

  // A bare article before a unit means one: "an hour", "a minute".
  s = s.replace(/\ban?\s+(hour|hr|minute|min)\b/g, ' 1 $1');

  return s.replace(/\s+/g, ' ').trim();
}

/** A duration found inside a longer sentence, with the text it consumed. */
export interface FoundDuration {
  seconds: number;
  /** The phrase to strip when deriving a description. */
  matched: string;
}

/**
 * Units are listed longest-first, and the trailing guard is `(?![a-z])` rather
 * than `\b`: in "1h30m" there is no word boundary between "h" and "3", so a
 * `\b` silently skips the hours and reads the whole thing as 30 minutes.
 */
const DURATION_PATTERN =
  /(?:\b(?:for|last|past|spent|about|around|roughly|approx\.?|approximately)\s+)?(\d+(?:\.\d+)?)\s*(hours|hour|hrs|hr|h|minutes|minute|mins|min|m)(?![a-z])/g;

/**
 * Find the first duration in a sentence, tolerating natural phrasing.
 *
 * Returns the consumed phrase too, so callers can strip it and keep the rest
 * as the description: "last 1 hour helping Priya" -> 1h, "helping Priya".
 */
export function extractDuration(input: string): FoundDuration | null {
  const normalized = normalizeSpokenDuration(input);

  DURATION_PATTERN.lastIndex = 0;
  let total = 0;
  let matched = '';
  let previousEnd = -1;

  let match: RegExpExecArray | null;
  while ((match = DURATION_PATTERN.exec(normalized)) !== null) {
    const value = parseFloat(match[1]!);
    const unit = match[2]!;
    const seconds = unit.startsWith('h') ? value * 3600 : value * 60;

    // Only join adjacent parts ("1 hour 30 minutes"). A second duration later
    // in the sentence describes different work, not the same block.
    if (matched && match.index > previousEnd + 2) break;

    total += seconds;
    matched = matched ? `${matched} ${match[0]}` : match[0];
    previousEnd = match.index + match[0].length;
  }

  return total > 0 ? { seconds: Math.round(total), matched: matched.trim() } : null;
}

/**
 * Parse human durations: "1h", "90m", "1h30m", "1.5h", "45", "half an hour".
 * A bare number is minutes. Returns seconds, or null if unparseable.
 */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;

  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 60);

  return extractDuration(s)?.seconds ?? null;
}

/** Seconds -> "2h 30m" / "45m" / "0m". Used everywhere in the review. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/** Decimal hours, the unit most timesheet APIs actually want. */
export function toHours(seconds: number): number {
  return Math.round((seconds / 3600) * 100) / 100;
}

/**
 * Round to the nearest increment (in minutes), which most clients require.
 * Rounds up so a 4-minute task doesn't vanish at a 15-minute increment.
 */
export function roundSeconds(seconds: number, incrementMinutes: number): number {
  if (incrementMinutes <= 0) return seconds;
  const inc = incrementMinutes * 60;
  return Math.ceil(seconds / inc) * inc;
}
