import { randomUUID } from 'node:crypto';
import type { Signal } from '../types.js';
import { extractDuration, normalizeSpokenDuration } from '../util/time.js';
import { extractIssueKey } from './git.js';

/**
 * Quick capture: the only signal for work that leaves no digital trace — the
 * unscheduled call, the debugging session over someone's shoulder, the
 * incident you got pulled into.
 *
 * Declarative on purpose ("1h sprint review"), not a start/stop timer. Timers
 * are the failure mode of every time tracker ever built: people start them and
 * forget to stop them, and you wake up to a fourteen-hour entry.
 *
 *   1h sprint review
 *   30m pairing with @sam on PROJ-142
 *   2h client call #acme
 *   45m incident — payments API
 */
export function parseManualEntry(
  input: string,
  options: { at?: number; project?: string } = {},
): Signal | null {
  const text = input.trim();
  if (!text) return null;

  const found = findDuration(text);
  if (!found) return null;

  const description = found.description;

  // The declared duration is authoritative, so anchor it to end at `at`
  // (usually "now") rather than inventing a start time we don't know.
  const end = options.at ?? Date.now();
  const start = end - found.seconds * 1000;

  const hashtag = /#([\w-]+)/.exec(description);

  return {
    id: `manual:${randomUUID()}`,
    source: 'manual',
    confidence: 'attested',
    start,
    end,
    description: description || 'Untracked work',
    hints: {
      issueKey: extractIssueKey(description),
      project: options.project ?? hashtag?.[1],
    },
    detail: 'logged by you',
  };
}

/**
 * Strip the duration phrase out of a sentence, leaving the description.
 *
 * Works on the normalized form ("half an hour" becomes "30 minutes"), so the
 * phrase we remove may not appear verbatim in the original. We therefore
 * remove it from the normalized text and use that as the description — a small
 * loss of the user's exact wording, in exchange for accepting how people
 * actually speak.
 */
function findDuration(text: string): { seconds: number; description: string } | null {
  const found = extractDuration(text);
  if (!found || found.seconds <= 0) return null;

  const normalized = normalizeSpokenDuration(text);
  const description = normalized
    .replace(found.matched, ' ')
    // Connectives left dangling once the duration is gone: "spent 2 hours on
    // the migration" -> "the migration".
    .replace(/\b(i\s+was|i\s+have\s+been|i've\s+been|i\s+am|i'm|was|were)\b/g, ' ')
    .replace(/^\s*(and|then|just|today|on|in|of|for|to)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-–—:,.]\s*/, '');

  return { seconds: found.seconds, description };
}
