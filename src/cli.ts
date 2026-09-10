#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';
import { ADAPTERS, configStub, createAdapter, getAdapterInfo } from './adapters/index.js';
import {
  DEFAULT_CONFIG,
  configExists,
  configPath,
  expandPath,
  loadConfig,
  saveConfig,
  type Config,
} from './config.js';
import { collectCalendar } from './collectors/calendar.js';
import { collectGit, discoverRepos } from './collectors/git.js';
import { parseManualEntry } from './collectors/manual.js';
import {
  mappingKey,
  partitionByIssue,
  resolveIssue,
  type IssueCandidate,
  type IssueResolution,
} from './engine/issues.js';
import { applyOverrides } from './engine/overrides.js';
import { executePush, planPush, relinkLedger } from './engine/reconcile.js';
import {
  computeGaps,
  isUnassigned,
  reconstruct,
  type ReconstructResult,
} from './engine/reconstruct.js';
import { sessionizeCommits } from './engine/sessionize.js';
import { fromMarkdown, toMarkdown } from './review/markdown.js';
import { renderTimesheet } from './review/render.js';
import {
  appendManualSignal,
  clearOverride,
  getIssueMappings,
  setIssueMapping,
  readManualSignals,
  saveAttestation,
  setOverride,
} from './store.js';
import type { Adapter, Period, Signal } from './types.js';
import { resolvePeriod } from './util/period.js';
import { formatDuration, localDate, startOfDay } from './util/time.js';

const USAGE = `
${pc.bold('punchcard')}, reconstruct your week from what you actually did

  ${pc.bold('punch init')}                    set up config, discover your repos
  ${pc.bold('punch preview')} [period]        show the reconstructed timesheet (never writes)
  ${pc.bold('punch review')} [period]         edit the timesheet in $EDITOR before pushing
  ${pc.bold('punch ui')}                      open the review UI in your browser
  ${pc.bold('punch log')} <text>              capture work that leaves no trace
  ${pc.bold('punch push')} [period]           write entries to a destination
  ${pc.bold('punch map')}                     assign unmapped repos and issue prefixes
  ${pc.bold('punch issues')}                  assign entries to Jira issues
  ${pc.bold('punch sync')}                    pull time you logged in Slack
  ${pc.bold('punch destinations')}            list supported timesheet platforms
  ${pc.bold('punch projects')}                list projects on the destination
  ${pc.bold('punch status')}                  what's unlogged right now

${pc.dim('periods:')}  current (default), last, today, yesterday, YYYY-MM-DD
${pc.dim('flags:')}    --adapter <name>  --verbose  --yes  --dry-run

${pc.dim('examples:')}
  punch preview last
  punch log 1h sprint review
  punch log 30m pairing with sam on PROJ-142 --date yesterday
  punch push --adapter toggl
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const { flags, positional } = parseArgs(argv.slice(1));

  switch (command) {
    case 'init':
      return cmdInit();
    case 'preview':
      return cmdPreview(positional[0], flags);
    case 'review':
      return cmdReview(positional[0], flags);
    case 'ui':
      return cmdUi(flags);
    case 'destinations':
    case 'adapters':
      return cmdDestinations();
    case 'log':
      return cmdLog(positional, flags);
    case 'push':
      return cmdPush(positional[0], flags);
    case 'map':
      return cmdMap(positional, flags);
    case 'issues':
      return cmdIssues(flags);
    case 'sync':
      return cmdSync();
    case 'projects':
      return cmdProjects(flags);
    case 'status':
      return cmdStatus();
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n${USAGE}`);
      process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

/**
 * Collect -> sessionize -> reconstruct. Shared by preview and push so the two
 * can never disagree: what you review is exactly what gets written.
 */
async function buildTimesheet(cfg: Config, period: Period): Promise<ReconstructResult> {
  const commits = await collectGit(cfg, period);
  const sessions = sessionizeCommits(commits, cfg);
  const meetings = await collectCalendar(cfg, period);
  const manual = readManualSignals(period);

  const signals: Signal[] = [...sessions, ...meetings, ...manual];
  const result = reconstruct(signals, cfg, period);

  // Evidence is always recomputed; your corrections are replayed on top. Gaps
  // follow the corrections — editing an entry up to 3h changes what's left.
  const entries = applyOverrides(result.entries);
  return { ...result, entries, gaps: computeGaps(entries, cfg, period) };
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

async function cmdInit(): Promise<void> {
  if (configExists()) {
    process.stdout.write(`Config already exists at ${pc.cyan(configPath())}\n`);
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    process.stdout.write(`\n${pc.bold('Setting up punchcard')}\n\n`);

    const rootAnswer = await ask(rl, 
      `Where do your repos live? ${pc.dim('(~/Documents)')} `,
    );
    const root = expandPath(rootAnswer.trim() || '~/Documents');

    process.stdout.write(pc.dim(`\nScanning ${root}...\n`));
    const repos = await discoverRepos(root);
    process.stdout.write(pc.dim(`Found ${repos.length} repositories.\n\n`));

    const emailAnswer = await ask(rl, 
      'Your git author email (commits by anyone else are ignored): ',
    );
    const email = emailAnswer.trim();

    const hoursAnswer = await ask(rl, `Target hours per working day? ${pc.dim('(8)')} `);
    const hours = Number(hoursAnswer.trim()) || 8;

    // Destination is chosen here rather than left to config archaeology.
    process.stdout.write(`\n${pc.bold('Where do you submit timesheets?')}\n\n`);
    ADAPTERS.forEach((info, i) => {
      process.stdout.write(`  ${i + 1}. ${pc.bold(info.label)}\n     ${pc.dim(info.blurb)}\n`);
    });
    process.stdout.write(`  ${ADAPTERS.length + 1}. ${pc.dim('Decide later')}\n\n`);

    const choiceAnswer = await ask(rl, `Pick one ${pc.dim(`(1-${ADAPTERS.length + 1})`)} `);
    const chosen = ADAPTERS[Number(choiceAnswer.trim()) - 1];

    const cfg: Config = {
      ...DEFAULT_CONFIG,
      authors: email ? [email] : [],
      targetHoursPerDay: hours,
      repos: repos.map((path) => ({ path: path.replace(process.env.HOME ?? '', '~') })),
      adapters: chosen ? { [chosen.id]: stubFields(chosen.id) } : {},
    };

    saveConfig(cfg);

    process.stdout.write(`\n${pc.green('✓')} Wrote ${pc.cyan(configPath())}\n`);

    if (chosen) {
      process.stdout.write(
        `\n${pc.bold(chosen.label)} needs credentials. Fill these in:\n\n${pc.dim(
          configStub(chosen),
        )}\n`,
      );
    }

    process.stdout.write(`Next: ${pc.bold('punch preview')} to see your week.\n`);
    process.stdout.write(pc.dim('Nothing is written anywhere until you run `punch push`.\n\n'));
  } finally {
    rl.close();
  }
}

async function cmdPreview(periodRef: string | undefined, flags: Flags): Promise<void> {
  const cfg = loadConfig();
  const period = resolvePeriod(cfg.period, periodRef ?? 'current');
  const result = await buildTimesheet(cfg, period);
  process.stdout.write(renderTimesheet(result, { verbose: flags.verbose }));
}

async function cmdReview(periodRef: string | undefined, flags: Flags): Promise<void> {
  const cfg = loadConfig();
  const period = resolvePeriod(cfg.period, periodRef ?? 'current');
  const result = await buildTimesheet(cfg, period);

  if (!result.entries.length) {
    process.stdout.write(renderTimesheet(result, { verbose: flags.verbose }));
    return;
  }

  const before = new Map(result.entries.map((e) => [e.key, e]));
  const markdown = toMarkdown(period, result.entries, result.gaps);

  const edited = openInEditor(markdown, `punchcard-${period.start}.md`);
  if (edited === null) {
    process.stdout.write('No changes.\n');
    return;
  }

  const parsed = fromMarkdown(edited, [...before.keys()]);

  for (const problem of parsed.problems) {
    process.stdout.write(`${pc.yellow('!')} ${problem}\n`);
  }

  let changed = 0;

  for (const edit of parsed.edits) {
    const original = before.get(edit.key);
    if (!original) continue;

    const differs =
      edit.seconds !== original.seconds ||
      edit.project !== original.project ||
      edit.description !== original.description;

    if (!differs) {
      // Reverting a line back to what we proposed clears the override, so the
      // entry starts tracking fresh evidence again.
      clearOverride(edit.key);
      continue;
    }

    setOverride(edit.key, {
      seconds: edit.seconds,
      project: edit.project,
      description: edit.description,
      billable: cfg.projects[edit.project]?.billable ?? original.billable,
    });
    changed++;
  }

  for (const key of parsed.deletedKeys) {
    setOverride(key, { deleted: true });
    changed++;
  }

  if (!changed) {
    process.stdout.write('No changes.\n');
    return;
  }

  process.stdout.write(
    `${pc.green('✓')} ${changed} change(s) saved. ` +
      pc.dim('Your edits survive re-runs and are not overwritten by new commits.\n'),
  );

  const updated = await buildTimesheet(cfg, period);
  process.stdout.write(renderTimesheet(updated, { verbose: flags.verbose }));
}

async function cmdUi(flags: Flags): Promise<void> {
  const cfg = loadConfig();
  const { startUi } = await import('./ui/server.js');

  const { url, close } = await startUi({
    cfg,
    port: flags.port ?? 4321,
    buildTimesheet,
  });

  process.stdout.write(`\n${pc.bold('punchcard')} review UI\n\n`);
  process.stdout.write(`  ${pc.cyan(url)}\n\n`);
  process.stdout.write(pc.dim('  Local only (127.0.0.1), token-gated, dies when you stop it.\n'));
  process.stdout.write(pc.dim('  Ctrl-C to stop.\n\n'));

  if (!flags.noOpen) openBrowser(url);

  // Hold the process open until interrupted — the server is the whole command.
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      close();
      process.stdout.write('\nStopped.\n');
      resolve();
    });
  });
}

/** Best-effort browser launch; the URL is printed regardless. */
function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    execFileSync(command, [url], { stdio: 'ignore' });
  } catch {
    // Headless, or no handler registered. The printed URL still works.
  }
}

/**
 * Assign entries to Jira issues.
 *
 * Separate from `punch map` because it answers a different question: `map`
 * says which *project* work belongs to, this says which *ticket*. Jira needs
 * the ticket, and nothing else in the pipeline can supply it.
 */
async function cmdIssues(flags: Flags): Promise<void> {
  const cfg = loadConfig();
  const period = resolvePeriod(cfg.period, 'current');
  const adapter = createAdapter(cfg, flags.adapter ?? 'jira');

  if (!('listIssues' in adapter)) {
    throw new Error(`${adapter.name} does not log against issues, so there is nothing to assign.`);
  }

  const preflight = await adapter.preflight();
  if (!preflight.ok) {
    throw new Error(preflight.notes.join('; '));
  }

  const [result, candidates] = await Promise.all([
    buildTimesheet(cfg, period),
    (adapter as unknown as { listIssues: () => Promise<IssueCandidate[]> }).listIssues(),
  ]);

  process.stdout.write(pc.dim(`\n  ${candidates.length} open/recent issues to match against\n\n`));

  const mappings = getIssueMappings();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let assigned = 0;

  try {
    for (const entry of result.entries) {
      if (isUnassigned(entry.project)) continue;

      // Deliberately no fallback here: `punch issues` exists to find the real
      // ticket, so entries sitting on the catch-all must keep being offered.
      const resolution = resolveIssue(entry, candidates, mappings, entry.branch);
      if (resolution.confidence === 'certain') continue;

      process.stdout.write(
        `${pc.bold(entry.date)}  ${formatDuration(entry.seconds)}  ${entry.project}\n` +
          `  ${entry.description.slice(0, 90)}\n` +
          (entry.branch ? pc.dim(`  branch: ${entry.branch}\n`) : ''),
      );

      if (!resolution.alternatives.length) {
        process.stdout.write(pc.dim('  no similar issues found\n'));
      }

      resolution.alternatives.forEach((alt, i) => {
        const confidence = Math.round(alt.score * 100);
        process.stdout.write(
          `    ${i + 1}. ${pc.cyan(alt.key)} ${alt.summary.slice(0, 60)} ${pc.dim(`(${confidence}%)`)}\n`,
        );
      });

      const answer = (
        await ask(rl, `  Issue? ${pc.dim('(number, KEY-123, or blank to skip)')} `)
      ).trim();

      if (!answer) continue;

      const picked = /^\d+$/.test(answer)
        ? resolution.alternatives[Number(answer) - 1]?.key
        : answer.toUpperCase();

      if (!picked) {
        process.stdout.write(pc.yellow('  no such option, skipped\n\n'));
        continue;
      }

      const key = mappingKey(entry, entry.branch);
      setIssueMapping(key, picked);
      mappings[key] = picked;
      assigned++;

      process.stdout.write(`  ${pc.green('✓')} ${picked}\n\n`);
    }
  } finally {
    rl.close();
  }

  process.stdout.write(
    assigned
      ? `${pc.green('✓')} ${assigned} assignment(s) remembered.\n`
      : `${pc.dim('Nothing assigned.')}\n`,
  );
}

/**
 * Pull anything logged in Slack into the local ledger.
 *
 * Separate from `preview` on purpose: reconstruction must stay fast and work
 * offline, so the network is only touched when you ask for it.
 */
async function cmdSync(): Promise<void> {
  const cfg = loadConfig();
  const { syncSlack } = await import('./collectors/slack.js');

  const result = await syncSlack(cfg);

  process.stdout.write(
    `${pc.green('✓')} ${result.imported} imported, ${result.skipped} already known ` +
      `(${result.scanned} message(s) scanned)\n`,
  );

  if (result.unparsed.length) {
    process.stdout.write(
      pc.yellow(`\n  ${result.unparsed.length} message(s) had no duration and were skipped:\n`),
    );
    for (const text of result.unparsed.slice(0, 5)) {
      process.stdout.write(pc.dim(`    "${text}"\n`));
    }
    process.stdout.write(
      pc.dim('  punchcard never guesses a number. Say how long, e.g. "1h standup".\n'),
    );
  }
}

async function cmdDestinations(): Promise<void> {
  const configured = configExists() ? Object.keys(loadConfig().adapters) : [];

  process.stdout.write(`\n${pc.bold('Timesheet destinations')}\n\n`);

  for (const info of ADAPTERS) {
    const mark = configured.includes(info.id) ? pc.green('✓') : pc.dim('○');
    process.stdout.write(`  ${mark} ${pc.bold(info.label)} ${pc.dim(`(${info.id})`)}\n`);
    process.stdout.write(`    ${pc.dim(info.blurb)}\n\n`);
  }

  process.stdout.write(pc.dim('  Planned: Tempo, CSV export for HR upload.\n\n'));

  if (!configured.length) {
    process.stdout.write(`Add one to ${pc.cyan(configPath())}:\n\n`);
    process.stdout.write(pc.dim(configStub(ADAPTERS[0]!)));
    process.stdout.write('\n');
  }
}

async function cmdLog(positional: string[], flags: Flags): Promise<void> {
  loadConfig(); // Fail fast if unconfigured.

  const text = positional.join(' ');
  if (!text) {
    process.stderr.write('Usage: punch log 1h sprint review\n');
    process.exitCode = 1;
    return;
  }

  const at = flags.date ? retroactiveAnchor(resolveDate(flags.date)) : Date.now();
  const signal = parseManualEntry(text, { at, project: flags.project });

  if (!signal) {
    process.stderr.write(
      `Couldn't find a duration in "${text}".\n` +
        `Try: ${pc.bold('punch log 1h sprint review')} or ${pc.bold('punch log 30m standup')}\n`,
    );
    process.exitCode = 1;
    return;
  }

  appendManualSignal(signal);

  const duration = formatDuration((signal.end - signal.start) / 1000);
  process.stdout.write(
    `${pc.green('✓')} ${pc.bold(duration)}  ${signal.description} ${pc.dim(
      `(${localDate(signal.start)})`,
    )}\n`,
  );
}

async function cmdPush(periodRef: string | undefined, flags: Flags): Promise<void> {
  const cfg = loadConfig();
  const period = resolvePeriod(cfg.period, periodRef ?? 'current');
  const adapter = createAdapter(cfg, flags.adapter);

  const preflight = await adapter.preflight();
  for (const note of preflight.notes) process.stdout.write(pc.dim(`  ${note}\n`));
  if (!preflight.ok) {
    process.stderr.write(`\n${pc.red('✗')} ${adapter.name} preflight failed.\n`);
    process.exitCode = 1;
    return;
  }

  const result = await buildTimesheet(cfg, period);
  process.stdout.write(renderTimesheet(result, { verbose: flags.verbose }));

  const pushable = result.entries.filter((e) => !isUnassigned(e.project));
  const skipped = result.entries.length - pushable.length;

  if (skipped) {
    process.stdout.write(
      pc.yellow(`  ${skipped} entry(s) skipped, unmapped project. Run \`punch map\`.\n\n`),
    );
  }

  if (!pushable.length) {
    process.stdout.write('Nothing to push.\n');
    return;
  }

  // Issue-based destinations need a ticket per entry. Resolve what we can from
  // branches and remembered choices, and hold back the rest — pushing an hour
  // to the wrong ticket corrupts someone else's sprint reporting, and dropping
  // it silently is worse still.
  let ready = pushable;

  if ('listIssues' in adapter) {
    const candidates = await (
      adapter as unknown as { listIssues: () => Promise<IssueCandidate[]> }
    ).listIssues();

    const mappings = getIssueMappings();
    const fallback = (adapter as unknown as { fallbackIssue?: string }).fallbackIssue;

    const resolutions = new Map<string, IssueResolution>(
      pushable.map((e) => [e.key, resolveIssue(e, candidates, mappings, e.branch, fallback)]),
    );

    const split = partitionByIssue(resolutions, pushable);
    ready = split.ready;

    if (split.usedFallback.length) {
      const seconds = split.usedFallback.reduce((sum, e) => sum + e.seconds, 0);
      process.stdout.write(
        pc.dim(
          `  ${split.usedFallback.length} entry(s) (${formatDuration(seconds)}) had no ticket ` +
            `and will go to ${fallback}. Run \`punch issues\` to assign real ones.\n\n`,
        ),
      );
    }

    if (split.needsIssue.length) {
      const held = split.needsIssue.reduce((sum, e) => sum + e.seconds, 0);
      process.stdout.write(
        pc.yellow(
          `  ${split.needsIssue.length} entry(s) (${formatDuration(held)}) have no Jira issue ` +
            'and will NOT be pushed:\n',
        ),
      );

      for (const entry of split.needsIssue) {
        const suggestion = resolutions.get(entry.key)?.alternatives[0];
        process.stdout.write(
          `    ${entry.date}  ${formatDuration(entry.seconds).padStart(7)}  ` +
            `${entry.description.slice(0, 50)}` +
            (suggestion ? pc.dim(`  → maybe ${suggestion.key}?`) : '') +
            '\n',
        );
      }

      process.stdout.write(pc.dim('  Run `punch issues` to assign them.\n\n'));
    }

    if (!ready.length) {
      process.stdout.write('Nothing to push. Every entry needs an issue first.\n');
      return;
    }
  }

  const remote = await adapter.listEntries(period);
  relinkLedger(adapter.name, ready, remote, period);
  const plan = planPush(adapter.name, ready, remote);

  process.stdout.write(
    `  ${pc.bold('Plan')}: ${plan.create.length} create · ${plan.update.length} update · ` +
      `${plan.remove.length} remove · ${plan.respect.length} left alone\n\n`,
  );

  if (!plan.create.length && !plan.update.length && !plan.remove.length) {
    process.stdout.write(`${pc.green('✓')} ${adapter.name} already matches. Nothing to do.\n`);
    return;
  }

  if (flags.dryRun) {
    process.stdout.write(pc.dim('Dry run. Nothing written.\n'));
    return;
  }

  // The attestation gate. A machine drafted these hours; a human signs for them.
  if (!flags.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await ask(rl, 
      `Submit ${pc.bold(formatDuration(total(ready)))} to ${pc.bold(adapter.name)}? ${pc.dim(
        '(y/N)',
      )} `,
    );
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      process.stdout.write('Cancelled. Nothing written.\n');
      return;
    }
  }

  const outcome = await executePush(adapter, plan, {
    dryRun: false,
    onProgress: (message) => process.stdout.write(`${message}\n`),
  });

  saveAttestation({
    period: period.label,
    approvedAt: Date.now(),
    digest: ready.map((e) => e.key).join(','),
    entryCount: ready.length,
    totalSeconds: total(ready),
  });

  process.stdout.write(
    `\n${pc.green('✓')} ${outcome.created} created, ${outcome.updated} updated, ` +
      `${outcome.removed} removed.\n`,
  );

  if (outcome.failed.length) {
    process.stdout.write(pc.red(`\n${outcome.failed.length} failed:\n`));
    for (const failure of outcome.failed) {
      process.stdout.write(pc.red(`  ${failure.key}: ${failure.error}\n`));
    }
    process.stdout.write(pc.dim('Re-run `punch push` to retry; already-written entries are skipped.\n'));
    process.exitCode = 1;
  }
}

async function cmdMap(assignments: string[], flags: Flags): Promise<void> {
  const cfg = loadConfig();
  const period = resolvePeriod(cfg.period, 'current');
  const result = await buildTimesheet(cfg, period);

  // Non-interactive form: `punch map api=backend PROJ=acme`. Scriptable, and
  // reliable in ways piping answers into a prompt is not.
  if (assignments.length) {
    for (const assignment of assignments) {
      const [source, project] = assignment.split('=');
      if (!source || !project) {
        process.stderr.write(`${pc.yellow('!')} Skipping "${assignment}", expected source=project\n`);
        continue;
      }

      const hint = result.unmapped.find((h) => h.value === source);
      const kind = hint?.kind ?? (/^[A-Z][A-Z0-9]{1,9}$/.test(source) ? 'issuePrefix' : 'repo');

      const table =
        kind === 'repo'
          ? cfg.mapping.repo
          : kind === 'issuePrefix'
            ? cfg.mapping.issuePrefix
            : cfg.mapping.meeting;

      table[source] = project;
      cfg.projects[project] ??= { name: project, billable: true };
      process.stdout.write(`  ${pc.green('✓')} ${source} ${pc.dim(`(${kind})`)} → ${project}\n`);
    }

    saveConfig(cfg);
    process.stdout.write(`\n${pc.green('✓')} Saved to ${pc.cyan(configPath())}\n`);
    return;
  }

  if (!result.unmapped.length) {
    process.stdout.write(`${pc.green('✓')} Everything is mapped.\n`);
    return;
  }

  const known = Object.keys(cfg.projects);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    process.stdout.write(
      `\n${pc.dim('Each of these is asked once, then remembered in your config.\n\n')}`,
    );

    for (const hint of result.unmapped) {
      const label = hint.kind === 'issuePrefix' ? 'issue prefix' : hint.kind;
      const suggestion = known.length ? pc.dim(` [${known.join(', ')}]`) : '';

      const answer = await ask(rl, 
        `${pc.bold(hint.value)} ${pc.dim(`(${label}, ${formatDuration(hint.seconds)})`)} → project?${suggestion} `,
      );
      const project = answer.trim();
      if (!project) continue;

      const table =
        hint.kind === 'repo'
          ? cfg.mapping.repo
          : hint.kind === 'issuePrefix'
            ? cfg.mapping.issuePrefix
            : cfg.mapping.meeting;
      table[hint.value] = project;

      if (!cfg.projects[project]) {
        const billableAnswer = await ask(rl, `  Is ${pc.bold(project)} billable? ${pc.dim('(Y/n)')} `);
        cfg.projects[project] = {
          name: project,
          billable: !/^n(o)?$/i.test(billableAnswer.trim()),
        };
        known.push(project);
      }
    }
  } finally {
    rl.close();
  }

  saveConfig(cfg);
  process.stdout.write(`\n${pc.green('✓')} Saved to ${pc.cyan(configPath())}\n`);
  if (flags.verbose) process.stdout.write(pc.dim('Run `punch preview` to see the result.\n'));
}

async function cmdProjects(flags: Flags): Promise<void> {
  const cfg = loadConfig();
  const adapter = createAdapter(cfg, flags.adapter);

  const preflight = await adapter.preflight();
  if (!preflight.ok) {
    process.stderr.write(`${pc.red('✗')} ${preflight.notes.join('; ')}\n`);
    process.exitCode = 1;
    return;
  }

  const projects = await adapter.listProjects();
  process.stdout.write(`\n${pc.bold(adapter.name)} projects:\n\n`);
  for (const project of projects) {
    const client = project.clientName ? pc.dim(` · ${project.clientName}`) : '';
    process.stdout.write(`  ${pc.dim(project.id.padEnd(12))} ${project.name}${client}\n`);
  }
  process.stdout.write(
    pc.dim(`\nMap one with: adapters.${adapter.name}.project.<yourProject}: <id>\n\n`),
  );
}

async function cmdStatus(): Promise<void> {
  const cfg = loadConfig();
  const period = resolvePeriod(cfg.period, 'current');
  const result = await buildTimesheet(cfg, period);

  const unaccounted = result.gaps.reduce((sum, g) => sum + g.seconds, 0);
  const logged = total(result.entries);

  // Terse by design: this is meant for a shell prompt or a login banner, where
  // the nudge matters more than the detail.
  if (unaccounted > 0) {
    process.stdout.write(
      `${pc.yellow('⚠')} ${formatDuration(logged)} logged · ${pc.yellow(
        `${formatDuration(unaccounted)} unaccounted`,
      )} · ${result.period.label}\n`,
    );
  } else {
    process.stdout.write(
      `${pc.green('✓')} ${formatDuration(logged)} accounted for · ${result.period.label}\n`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

interface Flags {
  adapter?: string;
  port?: number;
  noOpen: boolean;
  date?: string;
  project?: string;
  verbose: boolean;
  yes: boolean;
  dryRun: boolean;
}

/** Flags that consume the following argument when not written as --name=value. */
const VALUED_FLAGS = new Set(['adapter', 'date', 'project', 'port']);

/**
 * Parse flags and positionals in one pass.
 *
 * The single pass matters: `punch log 1h client call --date yesterday` must
 * not fold "yesterday" into the description. Splitting this into two
 * independent filters is exactly how that bug happens.
 */
function parseArgs(args: string[]): { flags: Flags; positional: string[] } {
  const flags: Flags = { verbose: false, yes: false, dryRun: false, noOpen: false };
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    const [rawName, inline] = arg.slice(2).split('=');
    const name = rawName ?? '';

    let value = inline;
    if (value === undefined && VALUED_FLAGS.has(name)) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i++; // Consume it, so it never reaches `positional`.
      }
    }

    switch (name) {
      case 'adapter':
        flags.adapter = value;
        break;
      case 'date':
        flags.date = value;
        break;
      case 'project':
        flags.project = value;
        break;
      case 'verbose':
        flags.verbose = true;
        break;
      case 'yes':
      case 'y':
        flags.yes = true;
        break;
      case 'dry-run':
        flags.dryRun = true;
        break;
      case 'port':
        flags.port = Number(value) || undefined;
        break;
      case 'no-open':
        flags.noOpen = true;
        break;
      default:
        process.stderr.write(`${pc.yellow('!')} Ignoring unknown flag --${name}\n`);
    }
  }

  return { flags, positional };
}

/**
 * Open text in the user's editor and hand back what they saved.
 *
 * Returns null when nothing changed, so an accidental `:q` is a no-op rather
 * than a silent wipe of the timesheet.
 */
function openInEditor(content: string, filename: string): string | null {
  const editor = process.env.VISUAL || process.env.EDITOR || 'nano';
  const path = join(mkdtempSync(join(tmpdir(), 'punchcard-')), filename);

  writeFileSync(path, content, 'utf8');

  try {
    // Inherit stdio so full-screen editors (vim, nano) actually work.
    execFileSync(editor, [path], { stdio: 'inherit' });
  } catch {
    throw new Error(
      `Could not run editor "${editor}". Set $EDITOR to something available, e.g. ` +
        '`export EDITOR=vim`.',
    );
  }

  const edited = readFileSync(path, 'utf8');
  return edited === content ? null : edited;
}

/**
 * Ask a question, tolerating a closed stdin.
 *
 * `rl.question` never settles once the input stream ends, so a piped invocation
 * that runs out of lines — or a Ctrl-D at the prompt — hangs the process
 * forever and any work in progress is silently lost. Racing the close event
 * turns that into an ordinary empty answer.
 */
async function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  try {
    const closed = new Promise<string>((resolve) => rl.once('close', () => resolve('')));
    return await Promise.race([rl.question(question), closed]);
  } catch {
    // Closing mid-question rejects with "readline was closed". Treat it as an
    // empty answer so the caller can still save whatever was answered first.
    return '';
  }
}

/** Placeholder credential keys, so the config shows what still needs filling in. */
function stubFields(adapterId: string): Record<string, string> {
  const info = getAdapterInfo(adapterId);
  const out: Record<string, string> = {};
  for (const field of info?.fields ?? []) {
    out[field.key] = field.secret
      ? `env:${adapterId.toUpperCase()}_${field.key.replace(/([A-Z])/g, '_$1').toUpperCase()}`
      : '';
  }
  return out;
}

/** Nominal end of the working day for retroactive logs. */
const WORKDAY_END_HOUR = 17;

/**
 * Where to anchor a log for a past day.
 *
 * We don't know what time yesterday's sprint review actually happened, so we
 * stack retroactive entries backwards from the end of the working day. Naively
 * anchoring every one at 17:00 makes them overlap, and the timeline sweep then
 * awards those minutes to just one of them — so logging three things for
 * yesterday would silently lose two of them.
 */
function retroactiveAnchor(date: string): number {
  const dayEnd = startOfDay(date) + WORKDAY_END_HOUR * 3600 * 1000;

  const alreadyLogged = readManualSignals({ start: date, end: date, label: date })
    .filter((s) => localDate(s.start) === date)
    .reduce((sum, s) => sum + (s.end - s.start), 0);

  return dayEnd - alreadyLogged;
}

function resolveDate(ref: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(ref)) return ref;
  const today = localDate(Date.now());
  if (ref === 'today') return today;
  if (ref === 'yesterday') {
    return localDate(startOfDay(today) - 12 * 3600 * 1000);
  }
  throw new Error(`Unrecognized date "${ref}". Use today, yesterday, or YYYY-MM-DD.`);
}

function total(entries: { seconds: number }[]): number {
  return entries.reduce((sum, e) => sum + e.seconds, 0);
}

main().catch((err: Error) => {
  process.stderr.write(`\n${pc.red('✗')} ${err.message}\n\n`);
  process.exitCode = 1;
});
