import type { Period, PeriodConfig } from '../types.js';
import { addDays, dayOfWeek, localDate, startOfDay } from './time.js';

/**
 * Timesheet periods are messier than "a week". We support the shapes people
 * are actually forced to submit against, including semi-monthly, which is
 * common for US contractors and which nothing else seems to handle.
 */
export function resolvePeriod(cfg: PeriodConfig, ref: string = 'current'): Period {
  const today = localDate(Date.now());

  if (/^\d{4}-\d{2}-\d{2}$/.test(ref)) return periodContaining(cfg, ref);
  if (ref === 'current' || ref === 'this') return periodContaining(cfg, today);
  if (ref === 'last' || ref === 'previous') {
    const current = periodContaining(cfg, today);
    return periodContaining(cfg, addDays(current.start, -1));
  }
  if (ref === 'today') return { start: today, end: today, label: today };
  if (ref === 'yesterday') {
    const y = addDays(today, -1);
    return { start: y, end: y, label: y };
  }
  throw new Error(
    `Unrecognized period "${ref}". Use current, last, today, yesterday, or YYYY-MM-DD.`,
  );
}

function periodContaining(cfg: PeriodConfig, date: string): Period {
  switch (cfg.type) {
    case 'daily':
      return { start: date, end: date, label: date };

    case 'weekly': {
      const start = weekStartFor(date, cfg.weekStart);
      const end = addDays(start, 6);
      return { start, end, label: `week of ${start}` };
    }

    case 'biweekly': {
      const anchor = cfg.anchor ?? weekStartFor(date, cfg.weekStart);
      const anchorStart = weekStartFor(anchor, cfg.weekStart);
      const thisWeek = weekStartFor(date, cfg.weekStart);
      const weeksApart = Math.round(
        (startOfDay(thisWeek) - startOfDay(anchorStart)) / (7 * 24 * 3600 * 1000),
      );
      // Floor toward the anchor so periods before it align too.
      const offset = ((weeksApart % 2) + 2) % 2;
      const start = addDays(thisWeek, -7 * offset);
      return { start, end: addDays(start, 13), label: `fortnight of ${start}` };
    }

    case 'semimonthly': {
      const [y, m, d] = date.split('-').map(Number);
      const firstHalf = d! <= 15;
      const start = firstHalf ? `${pad(y!)}-${pad2(m!)}-01` : `${pad(y!)}-${pad2(m!)}-16`;
      const end = firstHalf ? `${pad(y!)}-${pad2(m!)}-15` : lastDayOfMonth(y!, m!);
      return { start, end, label: `${start} → ${end}` };
    }

    case 'monthly': {
      const [y, m] = date.split('-').map(Number);
      return {
        start: `${pad(y!)}-${pad2(m!)}-01`,
        end: lastDayOfMonth(y!, m!),
        label: `${pad(y!)}-${pad2(m!)}`,
      };
    }
  }
}

function weekStartFor(date: string, weekStart: number): string {
  const dow = dayOfWeek(date);
  const delta = ((dow - weekStart) % 7 + 7) % 7;
  return addDays(date, -delta);
}

function lastDayOfMonth(y: number, m: number): string {
  // Day 0 of the next month is the last day of this one.
  return localDate(new Date(y, m, 0).getTime());
}

const pad = (n: number) => String(n).padStart(4, '0');
const pad2 = (n: number) => String(n).padStart(2, '0');
