import type { DraftEntry, Gap, Period } from '../types.js';
import { formatDuration, parseDuration } from '../util/time.js';

/**
 * The editable review: render the timesheet as markdown, let the user edit it
 * in $EDITOR, parse it back.
 *
 * Chosen over a TUI or a local web server because it's the interaction
 * developers already know — you edit it the way you edit a commit message —
 * and because it keeps the local-first promise completely intact. No server,
 * no browser, works over SSH.
 *
 * Line format, deliberately forgiving:
 *
 *   - 2h 15m  acme  OAuth token refresh  [PROJ-142]  #a1b2c3d4e5f60718
 *
 * The trailing #key is how an edited line finds its way back to the entry it
 * came from. Delete the whole line to drop the entry.
 */

const ENTRY_LINE = /^\s*[-*]\s+(.+?)\s{2,}#([0-9a-f]{16})\s*$/;

export function toMarkdown(period: Period, entries: DraftEntry[], gaps: Gap[]): string {
  const out: string[] = [];

  out.push(`# Timesheet: ${period.label}`);
  out.push('');
  out.push('<!--');
  out.push('  Edit durations, projects, and descriptions below, then save and close.');
  out.push('  Delete a line to drop that entry. Keep the trailing #id; it is the anchor.');
  out.push('  Format:  - <duration>  <project>  <description>  [ISSUE-KEY]  #id');
  out.push('  Nothing is written to any timesheet system until you run `punch push`.');
  out.push('-->');
  out.push('');

  const byDate = new Map<string, DraftEntry[]>();
  for (const entry of entries) {
    let group = byDate.get(entry.date);
    if (!group) byDate.set(entry.date, (group = []));
    group.push(entry);
  }

  const gapByDate = new Map(gaps.map((g) => [g.date, g]));
  const dates = [...new Set([...byDate.keys(), ...gapByDate.keys()])].sort();

  for (const date of dates) {
    const dayEntries = (byDate.get(date) ?? []).sort((a, b) => b.seconds - a.seconds);
    const total = dayEntries.reduce((sum, e) => sum + e.seconds, 0);

    out.push(`## ${date}  (${formatDuration(total)})`);
    out.push('');

    for (const entry of dayEntries) {
      const issue = entry.issueKey ? `  [${entry.issueKey}]` : '';
      out.push(
        `- ${formatDuration(entry.seconds)}  ${entry.project}  ${entry.description}${issue}  #${entry.key}`,
      );
    }

    const gap = gapByDate.get(date);
    if (gap) {
      out.push('');
      out.push(
        `  <!-- ${formatDuration(gap.seconds)} unaccounted. Add a line above to assign it. -->`,
      );
    }

    out.push('');
  }

  if (!dates.length) {
    out.push('_No evidence of work in this period._');
    out.push('');
  }

  return out.join('\n');
}

export interface ParsedEdit {
  key: string;
  seconds: number;
  project: string;
  description: string;
  issueKey?: string;
}

export interface ParseResult {
  edits: ParsedEdit[];
  /** Keys present in the original but gone from the edited text. */
  deletedKeys: string[];
  /** Lines we couldn't understand, reported rather than silently dropped. */
  problems: string[];
}

export function fromMarkdown(text: string, originalKeys: string[]): ParseResult {
  const edits: ParsedEdit[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // Comment delimiters, including the closing `-->`, which otherwise looks
    // exactly like a bullet to the check below.
    if (line.startsWith('<!--') || line.startsWith('-->') || line.endsWith('-->')) continue;
    if (!line.startsWith('-') && !line.startsWith('*')) continue;

    const match = ENTRY_LINE.exec(raw);
    if (!match) {
      // A bullet without an anchor is almost always someone adding a line by
      // hand. Tell them how to do it rather than dropping it silently.
      problems.push(
        `Ignored (no #id anchor): ${line.slice(0, 70)}` +
          (line.length > 70 ? '...' : '') +
          '. Use `punch log` to add new entries.',
      );
      continue;
    }

    const [, body, key] = match;

    // Mark it seen before parsing. A line we can't read is a typo, not a
    // deletion — treating "- ages  acme  ..." as intent to delete would throw
    // away the entry over a slip of the keyboard.
    seen.add(key!);

    const parsed = parseBody(body!);
    if (!parsed) {
      problems.push(`Could not read duration/project from: ${line.slice(0, 70)} (left unchanged).`);
      continue;
    }

    edits.push({ key: key!, ...parsed });
  }

  return {
    edits,
    deletedKeys: originalKeys.filter((key) => !seen.has(key)),
    problems,
  };
}

/** `2h 15m  acme  Fixed the thing  [PROJ-142]` -> its parts. */
function parseBody(body: string): Omit<ParsedEdit, 'key'> | null {
  const issueMatch = /\s*\[([A-Z][A-Z0-9]{1,9}-\d+)\]\s*$/.exec(body);
  const issueKey = issueMatch?.[1];
  const withoutIssue = issueMatch ? body.slice(0, issueMatch.index) : body;

  // Two-or-more spaces separate the columns, so descriptions can contain
  // single spaces freely.
  const columns = withoutIssue.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
  if (columns.length < 2) return null;

  const seconds = parseDuration(columns[0]!);
  if (seconds === null || seconds <= 0) return null;

  const project = columns[1]!;
  const description = columns.slice(2).join(' ').trim();

  return { seconds, project, description, issueKey };
}
