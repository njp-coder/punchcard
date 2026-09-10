import pc from 'picocolors';
import type { ReconstructResult, UnmappedHint } from '../engine/reconstruct.js';
import { isUnassigned } from '../engine/reconstruct.js';
import type { DraftEntry } from '../types.js';
import { daysBetween, formatDuration } from '../util/time.js';

/**
 * The review is the product.
 *
 * Everything upstream is inference; this is where a human looks at proposed
 * hours and decides whether to stand behind them. So every line shows *why* it
 * exists, and unaccounted time is shown loudly rather than quietly absorbed
 * into the nearest project.
 */
export function renderTimesheet(result: ReconstructResult, options: { verbose?: boolean } = {}): string {
  const out: string[] = [];
  const total = result.entries.reduce((sum, e) => sum + e.seconds, 0);
  const projects = new Set(result.entries.map((e) => e.project));

  out.push('');
  out.push(
    `  ${pc.bold(result.period.label)}   ${pc.dim(
      `${formatDuration(total)} · ${projects.size} project${projects.size === 1 ? '' : 's'}`,
    )}`,
  );
  out.push('');

  if (!result.entries.length) {
    out.push(pc.dim('  No evidence of work in this period.'));
    out.push(pc.dim('  Check that `repos` and `authors` in your config are right.'));
    out.push('');
    return out.join('\n');
  }

  const byDate = groupByDate(result.entries);
  const gapsByDate = new Map(result.gaps.map((g) => [g.date, g]));

  for (const date of daysBetween(result.period.start, result.period.end)) {
    const entries = byDate.get(date);
    const gap = gapsByDate.get(date);
    if (!entries && !gap) continue;

    const dayTotal = (entries ?? []).reduce((sum, e) => sum + e.seconds, 0);
    out.push(`  ${pc.bold(formatDay(date))}${pc.dim(`  ${formatDuration(dayTotal)}`)}`);

    for (const entry of entries ?? []) {
      out.push(`    ${renderEntry(entry)}`);
      for (const line of dedupe(entry.provenance.summary)) {
        out.push(pc.dim(`            ← ${line}`));
      }
    }

    if (gap) {
      out.push(
        `    ${pc.yellow('⚠')} ${pc.yellow(formatDuration(gap.seconds).padStart(7))}  ${pc.yellow(
          'unaccounted',
        )} ${pc.dim(`(target ${formatDuration(gap.targetSeconds)})`)}`,
      );
    }

    out.push('');
  }

  out.push(...renderFooter(result, options.verbose ?? false));
  out.push('');
  return out.join('\n');
}

function renderEntry(entry: DraftEntry): string {
  const duration = formatDuration(entry.seconds).padStart(7);
  const project = isUnassigned(entry.project) ? pc.yellow(entry.project) : pc.cyan(entry.project);

  const issue = entry.issueKey ? pc.dim(` [${entry.issueKey}]`) : '';
  const nonBillable = entry.billable ? '' : pc.dim(' (non-billable)');

  return `${duration}  ${project.padEnd(24)} ${entry.description}${issue}${nonBillable}`;
}

function renderFooter(result: ReconstructResult, verbose: boolean): string[] {
  const out: string[] = [];

  const unaccounted = result.gaps.reduce((sum, g) => sum + g.seconds, 0);
  if (unaccounted > 0) {
    out.push(
      pc.yellow(`  ⚠ ${formatDuration(unaccounted)} unaccounted across ${result.gaps.length} day(s).`),
    );
    out.push(
      pc.dim('    punchcard will not invent these hours. Log them with `punch log`, or leave them.'),
    );
    out.push('');
  }

  if (result.unmapped.length) {
    out.push(pc.yellow(`  ⚠ ${result.unmapped.length} unmapped source(s):`));
    for (const hint of verbose ? result.unmapped : result.unmapped.slice(0, 5)) {
      out.push(`    ${describeHint(hint)}`);
    }
    if (!verbose && result.unmapped.length > 5) {
      out.push(pc.dim(`    ...and ${result.unmapped.length - 5} more`));
    }
    out.push(pc.dim('    Run `punch map` to assign them. You will only be asked once.'));
    out.push('');
  }

  const inferred = result.entries.filter((e) => e.provenance.confidence === 'inferred').length;
  if (inferred) {
    out.push(
      pc.dim(
        `  ${inferred} of ${result.entries.length} entries have inferred durations. ` +
          'Connect WakaTime for measured editor time.',
      ),
    );
  }

  return out;
}

function describeHint(hint: UnmappedHint): string {
  const label =
    hint.kind === 'repo' ? 'repo' : hint.kind === 'issuePrefix' ? 'issue prefix' : 'meeting';
  return `${pc.dim(label.padEnd(13))} ${hint.value} ${pc.dim(`(${formatDuration(hint.seconds)})`)}`;
}

/* ------------------------------------------------------------------ */

function groupByDate(entries: DraftEntry[]): Map<string, DraftEntry[]> {
  const map = new Map<string, DraftEntry[]>();
  for (const entry of entries) {
    let group = map.get(entry.date);
    if (!group) map.set(entry.date, (group = []));
    group.push(entry);
  }
  for (const group of map.values()) group.sort((a, b) => b.seconds - a.seconds);
  return map;
}

function formatDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y!, m! - 1, d!);
  const weekday = dt.toLocaleDateString(undefined, { weekday: 'short' });
  const month = dt.toLocaleDateString(undefined, { month: 'short' });
  return `${weekday} ${String(d).padStart(2, '0')} ${month}`;
}

function dedupe(lines: string[]): string[] {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return [...counts].map(([line, n]) => (n > 1 ? `${line} ×${n}` : line));
}
