/**
 * The review UI, served as a single self-contained document.
 *
 * No framework and no build step on purpose: `npx punchcard` should stay a
 * small, fast install, and a timesheet review is not a problem that needs a
 * bundler. Everything here is vanilla.
 */
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>punchcard</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfaf8;
    --panel: #ffffff;
    --ink: #1a1a18;
    --muted: #6b6a66;
    --line: #e6e3dd;
    --accent: #2f6f4e;
    --warn: #9a6a1a;
    --warn-bg: #fdf6e7;
    --danger: #a33;
    /* Shape scale, applied everywhere: surfaces 10px, controls 8px,
       pills full. A stray fourth radius is what makes a UI feel assembled
       rather than designed. */
    --radius: 10px;
    --radius-control: 8px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14140f;
      --panel: #1c1c18;
      --ink: #ece9e2;
      --muted: #948f85;
      --line: #2e2e28;
      --accent: #7fc4a0;
      --warn: #d8ab5c;
      --warn-bg: #241f14;
      --danger: #e08a86;
    }
  }
  * { box-sizing: border-box; }
  /* An element rule such as footer{display:flex} outranks the user-agent
     [hidden]{display:none}, so hiding by property silently fails without this.
     (No backticks in this file: the whole page is one template literal.) */
  [hidden] { display: none !important; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 15px/1.5 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
  }
  header {
    position: sticky; top: 0; z-index: 5;
    display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
    padding: 18px 28px;
    background: var(--bg);
    border-bottom: 1px solid var(--line);
  }
  h1 { font-size: 17px; margin: 0; letter-spacing: -0.01em; }
  h1 span { color: var(--muted); font-weight: 400; }
  .total { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--muted); }
  /* Capped so description fields do not sprawl across an ultrawide display,
     which leaves the duration and project columns visually unanchored. */
  main { max-width: 940px; margin: 0 auto; padding: 20px 28px 80px; }

  button, select, input {
    font: inherit; color: inherit;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-control);
    padding: 6px 10px;
  }
  button { cursor: pointer; }
  button:hover { border-color: var(--muted); }
  /* A timesheet is edited by keyboard. Without a visible ring you cannot tell
     which of forty inputs is focused. */
  :focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: var(--radius-control);
  }
  /* Tactile press: the only motion in the interface, and it is feedback for a
     real action rather than decoration. */
  button:active { transform: translateY(1px); }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
    button:active { transform: none; }
  }

  .sr-only {
    position: absolute; width: 1px; height: 1px;
    padding: 0; margin: -1px; overflow: hidden;
    clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }

  /* Column headers for the entry grid. A data grid labels its columns once;
     repeating a label above all forty rows is noise, and placeholder-as-label
     disappears the moment a value is typed. */
  .grid-head {
    display: grid;
    grid-template-columns: 88px 150px minmax(0, 1fr) 28px;
    gap: 10px;
    padding: 0 17px 4px;
    font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
    color: var(--muted);
  }
  /* The header has to follow the column it labels: durations are right-aligned
     numerics, so a left-aligned label over them reads as a misalignment. */
  .grid-head div:first-child { text-align: right; }

  .skeleton {
    height: 38px; margin-bottom: 8px; border-radius: var(--radius);
    background: var(--panel); border: 1px solid var(--line);
  }
  button.primary {
    background: var(--accent); border-color: var(--accent);
    color: #fff; font-weight: 500;
  }
  @media (prefers-color-scheme: dark) { button.primary { color: #10231a; } }
  button.primary:disabled { opacity: .45; cursor: not-allowed; }
  button.ghost { background: none; border-color: transparent; color: var(--muted); padding: 4px 6px; }
  button.ghost:hover { color: var(--danger); border-color: var(--line); }

  .tabs { display: flex; gap: 4px; }
  .tab {
    background: none; border: 1px solid transparent; color: var(--muted);
    padding: 5px 12px; border-radius: 999px; font-size: 13.5px;
  }
  .tab[aria-selected="true"] {
    background: var(--panel); border-color: var(--line); color: var(--ink); font-weight: 500;
  }

  .steps { list-style: none; margin: 0; padding: 0; }
  .steps > li { margin-bottom: 32px; }
  .steps > li > b { font-size: 15px; }
  .source {
    display: grid; grid-template-columns: 22px 1fr; gap: 12px;
    padding: 12px 14px; margin-bottom: 8px;
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  }
  .source .dot { font-size: 15px; line-height: 1.4; }
  .source.off { opacity: .72; }
  .source h4 { margin: 0 0 2px; font-size: 14px; }
  .source .covers { color: var(--muted); font-size: 13px; }
  .source .detail { color: var(--muted); font-size: 12.5px; margin-top: 4px; }
  .source.planned { opacity: .55; }
  .source .head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .badge {
    font-size: 11px; letter-spacing: .02em; text-transform: uppercase;
    padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line);
    color: var(--muted);
  }
  .badge.required { color: var(--accent); border-color: var(--accent); }
  .badge.recommended { color: var(--warn); border-color: var(--warn); }
  .group-label {
    font-size: 12px; text-transform: uppercase; letter-spacing: .04em;
    color: var(--muted); margin: 18px 0 8px;
  }
  .connect-row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .connect-row input { flex: 1 1 320px; }
  .example {
    margin-top: 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-control);
    overflow: hidden;
    font-size: 12.5px;
  }
  .example .ex-head {
    display: grid; grid-template-columns: 1fr 56px 1fr;
    gap: 10px; padding: 5px 10px;
    background: var(--bg);
    border-bottom: 1px solid var(--line);
    font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
    color: var(--muted);
  }
  .example .ex-row {
    display: grid; grid-template-columns: 1fr 56px 1fr;
    gap: 10px; padding: 5px 10px;
    align-items: baseline;
  }
  .example .ex-row + .ex-row { border-top: 1px solid var(--line); }
  .example .ex-dur {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    text-align: right; color: var(--accent);
  }
  .example .ex-skip { color: var(--muted); font-style: italic; }

  .snippet {
    margin-top: 8px; padding: 8px 10px; border-radius: 8px;
    background: var(--bg); border: 1px solid var(--line);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    white-space: pre; overflow-x: auto;
  }

  .day { margin-bottom: 18px; }
  .day + .day, .grid-head + .day { margin-top: 14px; }
  .day-head {
    display: flex; align-items: baseline; gap: 10px;
    padding: 0 10px 4px;
    margin-bottom: 2px;
    border-bottom: 1px solid var(--line);
  }
  .day-head b { font-size: 13px; font-weight: 600; }
  .day-head .sum { margin-left: auto; color: var(--muted); font-variant-numeric: tabular-nums; }

  .entry {
    display: grid;
    grid-template-columns: 88px 150px minmax(0, 1fr) 28px;
    gap: 4px 10px;
    align-items: center;
    padding: 5px 10px;
    border-radius: var(--radius-control);
  }
  /* Hairlines between rows inside a day, not a border box around each one.
     Elevation should mean something; forty identical cards means nothing. */
  .entry + .entry { border-top: 1px solid var(--line); }
  .entry:hover { background: var(--panel); }

  /* Controls are invisible until you reach for them. A timesheet is read far
     more often than it is edited, and three bordered boxes on every row turns
     a week of work into a wall of form furniture. */
  .entry input,
  .entry select {
    background: transparent;
    border: 1px solid transparent;
    padding: 4px 7px;
    width: 100%;
    min-width: 0;
  }
  .entry:hover input,
  .entry:hover select,
  .entry input:focus,
  .entry select:focus {
    background: var(--bg);
    border-color: var(--line);
  }
  .entry input.dur {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  .entry .desc { text-overflow: ellipsis; }

  /* Provenance sits on its own line under the description, always visible and
     deliberately quiet. Revealing it on hover reserved the space anyway, which
     is what made every row float apart. */
  .prov {
    grid-column: 3 / 4;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding-left: 7px;
    font-size: 11px;
    color: var(--muted);
  }
  .prov:empty { display: none; }
  .prov .tag {
    padding: 0 5px;
    border: 1px solid var(--line);
    border-radius: 999px;
    white-space: nowrap;
  }

  .unassigned { color: var(--warn); }

  .gap {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    margin: 2px 0 0; padding: 4px 10px;
    border-left: 2px solid var(--warn);
    color: var(--warn); font-size: 12.5px;
  }
  .gap form { display: flex; gap: 6px; margin-left: auto; }
  .gap input {
    padding: 3px 8px; font-size: 12.5px;
    background: var(--panel); border-color: var(--line);
  }
  .gap button { padding: 3px 9px; font-size: 12.5px; }

  .note { color: var(--muted); font-size: 13.5px; margin: 10px 0; }
  .banner {
    padding: 10px 12px; border-radius: var(--radius);
    border: 1px solid var(--line); background: var(--panel);
    margin-bottom: 20px;
  }
  .banner.warn { border-left: 3px solid var(--warn); }
  .banner h3 { margin: 0 0 6px; font-size: 14px; }
  .map-row { display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
  .map-row code { font-size: 13px; }

  footer {
    position: fixed; bottom: 0; left: 0; right: 0;
    display: flex; align-items: center; gap: 12px;
    padding: 12px 28px;
    background: var(--panel); border-top: 1px solid var(--line);
  }
  footer .msg { color: var(--muted); font-size: 13.5px; }
  .saving { color: var(--accent); }
</style>
</head>
<body>
<header>
  <h1>punchcard <span id="period-label"></span></h1>
  <nav class="tabs">
    <button class="tab" data-view="setup">Setup</button>
    <button class="tab" data-view="sheet">Timesheet</button>
  </nav>
  <select id="period">
    <option value="current">This period</option>
    <option value="last">Last period</option>
  </select>
  <div class="total" id="total"></div>
</header>

<main>
  <section id="setup" hidden>
    <ol class="steps">
      <li><b>1 · Connect what you did</b>
        <p class="note">Evidence punchcard reads. Git alone explains well under half a week.</p>
        <div id="sources"></div>
      </li>
      <li><b>2 · Choose where it goes</b>
        <p class="note">The timesheet system you submit to.</p>
        <div id="dests"></div>
      </li>
      <li><b>3 · Review, then submit</b>
        <p class="note">
          Nothing is ever written until you confirm. punchcard drafts the hours;
          you sign for them.
        </p>
      </li>
    </ol>
  </section>

  <section id="sheet">
    <div id="banners"></div>
    <div id="days"></div>
    <p class="note" id="empty" hidden>No evidence of work in this period.</p>
  </section>
</main>

<footer>
  <select id="destination"></select>
  <button id="dry">Dry run</button>
  <button class="primary" id="push">Review &amp; submit</button>
  <span class="msg" id="msg"></span>
</footer>

<script>
// Keep the token out of the address bar so it can't leak via screenshots or
// history. Stash it first, though:, or a plain page reload loses it and every API
// call 401s with no way back.
const urlToken = new URLSearchParams(location.search).get('t');
let token = urlToken || '';
try {
  if (urlToken) sessionStorage.setItem('punchcard-token', urlToken);
  else token = sessionStorage.getItem('punchcard-token') || '';
} catch (err) {
  // Private browsing can throw on storage access; the URL token still works.
}
if (urlToken) history.replaceState(null, '', location.pathname);

const $ = (id) => document.getElementById(id);
let state = null;
let currentView = 'sheet';
let unmappedExpanded = false;
let issueState = null;
let issuesExpanded = false;

async function api(path, options = {}) {
  const res = await fetch('/api/' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Punchcard-Token': token },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // The stored token belongs to an older server. Drop it so a reload with a
    // fresh link works instead of failing forever from cached state.
    try { sessionStorage.removeItem('punchcard-token'); } catch (err) {}
    throw new Error('This link is no longer valid. Run "punch ui" again and open the new link.');
  }
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

function fmt(seconds) {
  const total = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(total / 60), m = total % 60;
  return h && m ? h + 'h ' + m + 'm' : h ? h + 'h' : m + 'm';
}

function parseDur(text) {
  const s = String(text).trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 60);
  const re = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)/g;
  let total = 0, matched = false, match;
  while ((match = re.exec(s))) {
    matched = true;
    total += match[2][0] === 'h' ? parseFloat(match[1]) * 3600 : parseFloat(match[1]) * 60;
  }
  return matched ? Math.round(total) : null;
}

function isUnassigned(project) {
  return project === '(unassigned)' || project.startsWith('(unassigned) ');
}

function dayName(date) {
  const d = new Date(date + 'T12:00:00');
  return d.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' });
}

function msg(text, className = '') {
  $('msg').textContent = text;
  $('msg').className = 'msg ' + className;
}

function showSkeleton() {
  // Shaped like the rows that will replace it, so the layout does not jump
  // when real data lands.
  if (state) return;
  $('days').innerHTML = '<div class="skeleton"></div>'.repeat(4);
}

async function load() {
  showSkeleton();
  try {
    state = await api('state?period=' + $('period').value);

    // Populate the destination picker here rather than after load(). It used
    // to be filled in afterwards, which left its value empty during the first
    // load, so the issue-assignment lookup below was skipped and the panel
    // only ever appeared once the user touched the dropdown.
    fillDestinations();

    // Best-effort: an issue-based destination may not be configured, and that
    // must never stop the timesheet from rendering.
    issueState = null;
    const dest = $('destination').value;
    if (dest) {
      try {
        const found = await api('issues?period=' + $('period').value + '&adapter=' + dest);
        if (found.supported) issueState = found;
      } catch (err) { /* destination unreachable; the sheet still works */ }
    }

    render();
  } catch (err) {
    // Never fail silently: an empty page with no explanation is the worst
    // possible outcome, because it looks like the tool found no work.
    showFatal(err.message);
    throw err;
  }
}

function fillDestinations() {
  const select = $('destination');
  if (select.options.length) return; // Already built; keep the user's choice.

  for (const destination of state.destinations) {
    const option = document.createElement('option');
    option.value = destination.id;
    option.textContent = destination.label + (destination.configured ? '' : ' (not configured)');
    option.disabled = !destination.configured;
    select.appendChild(option);
  }

  // Default to the first configured destination so the timesheet is useful
  // immediately, rather than waiting for a selection that may never come.
  const first = state.destinations.find((d) => d.configured);
  if (first) select.value = first.id;

  const anyConfigured = Boolean(first);
  $('push').disabled = !anyConfigured;
  $('dry').disabled = !anyConfigured;
  if (!anyConfigured) msg('No destination configured. Editing still works.');
}

function showFatal(detail) {
  const help = /token|link/i.test(detail)
    ? 'Run <code>punch ui</code> in your terminal and open the link it prints.'
    : 'punchcard could not reach its local server. Is <code>punch ui</code> still running?';

  document.querySelector('main').innerHTML =
    '<div class="banner warn"><h3>Could not load your timesheet</h3>' +
    '<div class="note">' + help + '</div>' +
    '<div class="note" style="opacity:.7">' + escapeHtml(detail) + '</div></div>';
  document.querySelector('footer').hidden = true;
}

function setView(view) {
  currentView = view;
  $('setup').hidden = view !== 'setup';
  $('sheet').hidden = view !== 'sheet';
  $('period').hidden = view !== 'sheet';
  // The footer carries the status line, which setup actions write to, so it
  // stays visible; only the push controls are hidden outside the timesheet.
  $('destination').hidden = view !== 'sheet';
  $('dry').hidden = view !== 'sheet';
  $('push').hidden = view !== 'sheet';
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === view));
  }
}

function renderSetup() {
  const box = $('sources');
  box.innerHTML = '';

  // Grouped so "planned" can never be mistaken for something you can turn on.
  const groups = [
    ['Connected', state.sources.filter((s) => s.status === 'connected')],
    ['Available to connect', state.sources.filter((s) => s.status === 'available')],
    ['Planned, not available yet', state.sources.filter((s) => s.status === 'planned')],
  ];

  for (const [label, items] of groups) {
    if (!items.length) continue;
    const heading = document.createElement('div');
    heading.className = 'group-label';
    heading.textContent = label;
    box.appendChild(heading);
    for (const source of items) box.appendChild(sourceCard(source));

    if (label.indexOf('Planned') === 0) {
      const note = document.createElement('p');
      note.className = 'note';
      note.innerHTML =
        'These are not built yet. punchcard is open source, so they are open to ' +
        'anyone who wants them: see <code>ROADMAP.md</code> for what each involves, ' +
        'and <code>CONTRIBUTING.md</code> for how collectors plug in.';
      box.appendChild(note);
    }
  }

  renderDestinations();
}

function sourceCard(source) {
  const card = document.createElement('div');
  card.className = 'source' + (source.status === 'planned' ? ' planned' : '');

  const mark = source.status === 'connected' ? '\u2713' : '\u25cb';
  const badge = source.requirement === 'optional'
    ? ''
    : '<span class="badge ' + source.requirement + '">' + source.requirement + '</span>';

  card.innerHTML =
    '<div class="dot">' + mark + '</div>' +
    '<div><div class="head"><h4>' + escapeHtml(source.label) + '</h4>' + badge + '</div>' +
    '<div class="covers">' + escapeHtml(source.covers) + '</div>' +
    '<div class="detail">' + escapeHtml(source.detail) + '</div>' +
    (source.setup && (source.alwaysShowSetup || source.status !== 'connected')
      ? '<div class="detail">' + escapeHtml(source.setup) + '</div>'
      : '') +
    '</div>';

  const body = card.querySelector('div:last-child');

  if (source.connect === 'calendar' && source.status !== 'planned') {
    if (state.calendars.length) body.appendChild(calendarList());
    body.appendChild(calendarConnect());
  }

  if (source.example) body.appendChild(exampleBlock(source.example));

  if (source.connect === 'slack' && source.status !== 'planned') {
    if (source.status !== 'connected') body.appendChild(manifestBlock());
    body.appendChild(credentialForm('slack', state.slackFields));
    if (source.status === 'connected') body.appendChild(syncButton());
  }

  return card;
}

/** Pull anything logged in Slack, without leaving the page. */
function syncButton() {
  const wrap = document.createElement('div');
  wrap.style.marginTop = '10px';

  const button = document.createElement('button');
  button.className = 'primary';
  button.textContent = 'Sync from Slack';

  const outcome = document.createElement('div');
  outcome.className = 'detail';
  outcome.style.marginTop = '6px';

  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Syncing...';
    outcome.style.color = 'var(--muted)';
    outcome.textContent = 'Reading your Slack messages...';

    try {
      const r = await api('sync', { method: 'POST', body: '{}' });
      outcome.style.color = r.imported ? 'var(--accent)' : 'var(--muted)';
      outcome.textContent =
        (r.imported ? '\u2713 ' : '') + r.imported + ' imported, ' + r.skipped +
        ' already known (' + r.scanned + ' scanned).' +
        (r.unparsed && r.unparsed.length
          ? '  ' + r.unparsed.length + ' had no duration and were skipped.'
          : '');
      await load();
    } catch (err) {
      outcome.style.color = 'var(--danger)';
      outcome.textContent = '\u2717 ' + err.message;
    }

    button.disabled = false;
    button.textContent = 'Sync from Slack';
  });

  wrap.append(button, outcome);
  return wrap;
}

function calendarList() {
  const wrap = document.createElement('div');
  wrap.style.marginTop = '8px';

  for (const calendar of state.calendars) {
    const row = document.createElement('div');
    row.className = 'connect-row';
    row.style.gap = '6px';

    const label = document.createElement('span');
    label.className = 'detail';
    label.style.flex = '1 1 auto';
    label.textContent = calendar.name;

    const remove = document.createElement('button');
    remove.className = 'ghost';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      try {
        await api('calendar', {
          method: 'DELETE',
          body: JSON.stringify({ index: calendar.index }),
        });
        await load();
        msg('Removed ' + calendar.name + '.');
      } catch (err) { msg(err.message); }
    });

    row.append(label, remove);
    wrap.appendChild(row);
  }
  return wrap;
}

/**
 * Paste credentials straight into the local UI.
 *
 * This server is bound to 127.0.0.1 and the values land in the same local
 * config file the user would otherwise edit by hand, so typing a token here is
 * no more exposed than typing it into their editor. The env: indirection stays
 * available, and is still the right choice for a config you commit or share.
 */
/**
 * A worked example of what the integration actually does.
 *
 * Abstract descriptions of a capture surface never land; showing the exact
 * sentence someone would type and the entry it becomes does. The last row is
 * deliberately a rejection, because the rule that punchcard never guesses a
 * number is easier to see than to state.
 */
function exampleBlock(rows) {
  const wrap = document.createElement('div');
  wrap.className = 'example';

  const head = document.createElement('div');
  head.className = 'ex-head';
  head.innerHTML = '<div>You type in Slack</div><div>Time</div><div>Entry</div>';
  wrap.appendChild(head);

  for (const [typed, duration, recorded] of rows) {
    const row = document.createElement('div');
    row.className = 'ex-row';
    row.innerHTML =
      '<div>' + escapeHtml(typed) + '</div>' +
      '<div class="ex-dur">' + escapeHtml(duration || '-') + '</div>' +
      '<div' + (duration ? '' : ' class="ex-skip"') + '>' + escapeHtml(recorded) + '</div>';
    wrap.appendChild(row);
  }
  return wrap;
}

/** The app manifest, ready to paste into Slack's "From a manifest" flow. */
function manifestBlock() {
  const wrap = document.createElement('div');
  wrap.style.marginTop = '10px';

  const pre = document.createElement('div');
  pre.className = 'snippet';
  pre.style.maxHeight = '150px';
  pre.style.overflowY = 'auto';
  pre.textContent = state.slackManifest;

  const copy = document.createElement('button');
  copy.textContent = 'Copy manifest';
  copy.style.marginTop = '8px';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state.slackManifest);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy manifest'; }, 1500);
    } catch (err) {
      // Clipboard access can be refused; selecting the text still works.
      msg('Could not copy. Select the manifest above and copy it manually.');
    }
  });

  wrap.append(pre, copy);
  return wrap;
}

function credentialForm(target, fields) {
  const wrap = document.createElement('div');
  wrap.style.marginTop = '10px';

  const row = document.createElement('div');
  row.className = 'connect-row';
  const inputs = {};

  for (const field of fields) {
    const input = document.createElement('input');
    input.type = field.secret ? 'password' : 'text';
    input.placeholder = field.key + (field.hint ? ' (' + field.hint + ')' : '');
    input.setAttribute('aria-label', field.key);
    if (!field.secret) input.style.flex = '0 1 200px';
    inputs[field.key] = input;
    row.appendChild(input);
  }

  const save = document.createElement('button');
  save.textContent = 'Save';
  save.addEventListener('click', async () => {
    const values = {};
    for (const [key, input] of Object.entries(inputs)) values[key] = input.value;

    save.disabled = true;
    save.textContent = 'Saving...';
    try {
      const saved = await api('credentials', {
        method: 'POST',
        body: JSON.stringify({ target, values }),
      });
      note.style.color = 'var(--accent)';
      note.textContent = '\u2713 Saved to ' + saved.storedAt;
      await load();
    } catch (err) {
      note.style.color = 'var(--danger)';
      note.textContent = '\u2717 ' + err.message;
    }
    save.disabled = false;
    save.textContent = 'Save';
  });

  row.appendChild(save);
  wrap.appendChild(row);

  const note = document.createElement('div');
  note.className = 'detail';
  note.textContent =
    'Stored in plain text in your local config. Prefer env: indirection if you ' +
    'ever share or commit that file.';
  wrap.appendChild(note);

  return wrap;
}

function calendarConnect() {
  const row = document.createElement('div');
  row.className = 'connect-row';

  const url = document.createElement('input');
  url.type = 'url';
  url.placeholder = 'https://calendar.google.com/calendar/ical/.../basic.ics';
  url.setAttribute('aria-label', 'Private iCal URL');

  const name = document.createElement('input');
  name.placeholder = 'name';
  name.setAttribute('aria-label', 'Calendar name');
  name.style.flex = '0 0 110px';

  const add = document.createElement('button');
  add.textContent = 'Add calendar';

  const outcome = document.createElement('div');
  outcome.className = 'detail';
  outcome.style.marginTop = '6px';

  add.addEventListener('click', async () => {
    if (!url.value.trim()) return;
    add.disabled = true;
    add.textContent = 'Checking...';
    outcome.style.color = 'var(--muted)';
    outcome.textContent = 'Fetching the feed...';

    try {
      await api('calendar', {
        method: 'POST',
        body: JSON.stringify({ url: url.value.trim(), name: name.value.trim() }),
      });
      await load();
    } catch (err) {
      outcome.style.color = 'var(--danger)';
      outcome.textContent = '\u2717 ' + err.message;
      add.disabled = false;
      add.textContent = 'Add calendar';
    }
  });

  row.append(url, name, add);

  const wrap = document.createElement('div');
  wrap.append(row, outcome);
  return wrap;
}

function renderDestinations() {
  const dests = $('dests');
  dests.innerHTML = '';

  const anyConfigured = state.destinations.some((d) => d.configured);
  if (!anyConfigured) {
    const note = document.createElement('div');
    note.className = 'group-label';
    note.textContent = 'Pick one. punchcard needs somewhere to submit to.';
    dests.appendChild(note);
  }

  for (const destination of state.destinations) {
    const card = document.createElement('div');
    card.className = 'source';

    const badge = anyConfigured
      ? ''
      : '<span class="badge required">required</span>';

    card.innerHTML =
      '<div class="dot">' + (destination.configured ? '\u2713' : '\u25cb') + '</div>' +
      '<div><div class="head"><h4>' + escapeHtml(destination.label) + '</h4>' +
      (destination.configured ? '' : badge) + '</div>' +
      '<div class="covers">' + escapeHtml(destination.blurb || '') + '</div>' +
      (destination.configured
        ? ''
        : '<div class="snippet">' + escapeHtml(destination.stub || '') + '</div>') +
      '</div>';

    const body = card.querySelector('div:last-child');

    if (!destination.configured && destination.fields) {
      body.appendChild(credentialForm(destination.id, destination.fields));
    }

    const test = document.createElement('button');
    test.textContent = destination.configured ? 'Test connection' : 'Test once configured';
    test.disabled = !destination.configured;
    test.style.marginTop = '10px';

    // The result belongs next to the button that produced it. Writing it to
    // the footer status line put the answer several hundred pixels away from
    // the click, which reads as nothing having happened at all.
    const result = document.createElement('div');
    result.className = 'detail';
    result.style.marginTop = '6px';

    test.addEventListener('click', async () => {
      test.disabled = true;
      test.textContent = 'Testing...';
      result.textContent = 'Contacting ' + destination.label + '...';
      result.style.color = 'var(--muted)';

      try {
        const outcome = await api('test', {
          method: 'POST',
          body: JSON.stringify({ adapter: destination.id }),
        });

        result.style.color = outcome.ok ? 'var(--accent)' : 'var(--danger)';
        result.textContent =
          (outcome.ok ? '\u2713 Connected. ' : '\u2717 Failed. ') +
          (outcome.notes || []).join(' \u00b7 ');
      } catch (err) {
        result.style.color = 'var(--danger)';
        result.textContent = '\u2717 ' + err.message;
      }

      test.disabled = false;
      test.textContent = 'Test connection';
    });

    body.append(test, result);
    dests.appendChild(card);
  }
}

function render() {
  $('period-label').textContent = state.period.label;
  renderSetup();

  const total = state.entries.reduce((sum, e) => sum + e.seconds, 0);
  $('total').textContent = fmt(total);

  renderBanners();

  const dates = [...new Set([
    ...state.entries.map((e) => e.date),
    ...state.gaps.map((g) => g.date),
  ])].sort();

  $('empty').hidden = dates.length > 0;
  $('days').innerHTML = '';

  if (dates.length) {
    const head = document.createElement('div');
    head.className = 'grid-head';
    head.innerHTML = '<div>Duration</div><div>Project</div><div>Description</div><div></div>';
    $('days').appendChild(head);
  }

  for (const date of dates) {
    const entries = state.entries.filter((e) => e.date === date)
      .sort((a, b) => b.seconds - a.seconds);
    const gap = state.gaps.find((g) => g.date === date);
    const dayTotal = entries.reduce((sum, e) => sum + e.seconds, 0);

    const section = document.createElement('section');
    section.className = 'day';
    section.innerHTML =
      '<div class="day-head"><b>' + dayName(date) + '</b>' +
      '<span class="sum">' + fmt(dayTotal) + '</span></div>';

    for (const entry of entries) section.appendChild(entryRow(entry));
    if (gap) section.appendChild(gapRow(gap));

    $('days').appendChild(section);
  }
}

function entryRow(entry) {
  const row = document.createElement('div');
  row.className = 'entry';

  const duration = document.createElement('input');
  duration.type = 'text';
  duration.className = 'dur';
  duration.value = fmt(entry.seconds);
  duration.setAttribute('aria-label', 'Duration for ' + entry.description);

  const project = document.createElement('select');
  project.setAttribute('aria-label', 'Project for ' + entry.description);
  for (const option of projectOptions(entry.project)) {
    const el = document.createElement('option');
    el.value = option; el.textContent = option;
    el.selected = option === entry.project;
    project.appendChild(el);
  }
  if (isUnassigned(entry.project)) project.classList.add('unassigned');

  const description = document.createElement('input');
  description.type = 'text';
  description.className = 'desc';
  description.value = entry.description;
  description.setAttribute('aria-label', 'Description');
  description.title = entry.description;

  const remove = document.createElement('button');
  remove.className = 'ghost';
  remove.title = 'Drop this entry';
  remove.setAttribute('aria-label', 'Drop entry: ' + entry.description);
  remove.textContent = '✕';

  const save = async (patch) => {
    msg('Saving…', 'saving');
    try {
      await api('entry', { method: 'POST', body: JSON.stringify({ key: entry.key, ...patch }) });
      await load();
      msg('Saved.');
    } catch (err) { msg(err.message, 'saving'); }
  };

  duration.addEventListener('change', () => {
    const seconds = parseDur(duration.value);
    if (seconds === null || seconds <= 0) {
      // Reject rather than silently writing a zero-hour entry.
      duration.value = fmt(entry.seconds);
      msg('Could not read that duration. Try "2h 15m".');
      return;
    }
    save({ seconds, project: project.value, description: description.value });
  });

  project.addEventListener('change', () =>
    save({ seconds: entry.seconds, project: project.value, description: description.value }));

  description.addEventListener('change', () =>
    save({ seconds: entry.seconds, project: project.value, description: description.value }));

  remove.addEventListener('click', () => save({ deleted: true }));

  row.append(duration, project, description, remove);

  const prov = document.createElement('div');
  prov.className = 'prov';

  const unique = [...new Set(entry.provenance.summary)];
  for (const line of unique.slice(0, 2)) {
    prov.innerHTML += '<span class="tag">' + escapeHtml(line) + '</span>';
  }
  if (unique.length > 2) {
    const more = document.createElement('span');
    more.className = 'tag';
    more.textContent = '+' + (unique.length - 2) + ' more';
    more.title = unique.slice(2).join('\n');
    prov.appendChild(more);
  }
  row.appendChild(prov);

  return row;
}

function projectOptions(current) {
  const options = state.projects.map((p) => p.id);
  if (!options.includes(current)) options.unshift(current);
  return options;
}

function gapRow(gap) {
  const row = document.createElement('div');
  row.className = 'gap';
  row.innerHTML = '<span>' + fmt(gap.seconds) + ' unaccounted</span>';

  const form = document.createElement('form');

  const text = document.createElement('input');
  text.type = 'text';
  text.placeholder = 'e.g. 1h sprint review';
  text.size = 24;
  text.setAttribute('aria-label', 'Log time against ' + gap.date);

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Log it';

  form.append(text, submit);

  // Implicit form submission proved unreliable here, and pressing Enter after
  // typing a duration is the whole interaction, so drive it explicitly.
  text.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!text.value.trim()) return;
    msg('Saving…', 'saving');
    try {
      await api('log', { method: 'POST', body: JSON.stringify({ text: text.value, date: gap.date }) });
      await load();
      msg('Logged.');
    } catch (err) { msg(err.message); }
  });

  row.appendChild(form);
  return row;
}

function renderBanners() {
  const box = $('banners');
  box.innerHTML = '';

  if (state.unmapped.length) {
    // Cap the list. A busy calendar produces hundreds of distinct meeting
    // titles, and rendering all of them buries the timesheet under a wall of
    // inputs. They are sorted by time, so the ones worth naming come first.
    const SHOWN = 3;
    const shown = state.unmapped.slice(0, unmappedExpanded ? state.unmapped.length : SHOWN);
    const hidden = state.unmapped.length - shown.length;

    const banner = document.createElement('div');
    banner.className = 'banner warn';
    banner.innerHTML = '<h3>' + state.unmapped.length +
      ' unmapped source(s)</h3><div class="note">Assign each once and it is remembered. ' +
      'Anything you leave unmapped simply is not pushed.</div>';

    for (const hint of shown) {
      const row = document.createElement('div');
      row.className = 'map-row';
      row.innerHTML = '<code>' + escapeHtml(hint.value) + '</code>' +
        '<span class="note">' + hint.kind + ' · ' + fmt(hint.seconds) + '</span>';

      const input = document.createElement('input');
      input.placeholder = 'project name';
      const button = document.createElement('button');
      button.textContent = 'Map';

      button.addEventListener('click', async () => {
        if (!input.value.trim()) return;
        await api('map', {
          method: 'POST',
          body: JSON.stringify({ source: hint.value, kind: hint.kind, project: input.value.trim() }),
        });
        await load();
        msg('Mapped ' + hint.value + '.');
      });

      row.append(input, button);
      banner.appendChild(row);
    }

    if (hidden > 0) {
      const more = document.createElement('button');
      more.style.marginTop = '10px';
      more.textContent = 'Show ' + hidden + ' more';
      more.addEventListener('click', () => {
        unmappedExpanded = true;
        render();
      });
      banner.appendChild(more);
    }

    box.appendChild(banner);
  }

  if (issueState && issueState.entries.length) {
    const banner = document.createElement('div');
    banner.className = 'banner warn';
    banner.innerHTML =
      '<h3>' + issueState.entries.length + ' entry(s) need a Jira issue</h3>' +
      '<div class="note">Jira logs time against an issue, never a project. ' +
      'Assign one and the branch is remembered.</div>';

    // Same cap as the unmapped panel: these are stacked above the timesheet,
    // and four rows of controls each is enough to push the actual work off
    // the screen entirely.
    const ISSUES_SHOWN = 3;
    const shownIssues = issuesExpanded
      ? issueState.entries
      : issueState.entries.slice(0, ISSUES_SHOWN);

    for (const item of shownIssues) {
      const row = document.createElement('div');
      row.className = 'map-row';
      row.innerHTML =
        '<span class="detail" style="flex:1 1 260px">' +
        escapeHtml(item.date) + '  ' + fmt(item.seconds) + '  ' +
        escapeHtml(item.description.slice(0, 60)) +
        (item.branch ? ' <code>' + escapeHtml(item.branch) + '</code>' : '') +
        '</span>';

      const pick = document.createElement('select');
      pick.style.flex = '0 1 260px';
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = item.alternatives.length ? 'pick an issue...' : 'no similar issues';
      pick.appendChild(blank);

      for (const alt of item.alternatives) {
        const option = document.createElement('option');
        option.value = alt.key;
        option.textContent = alt.key + '  ' + alt.summary.slice(0, 42);
        pick.appendChild(option);
      }

      const typed = document.createElement('input');
      typed.placeholder = 'or type KAN-13';
      typed.setAttribute('aria-label', 'Issue key');
      typed.style.flex = '0 1 130px';

      const assign = document.createElement('button');
      assign.textContent = 'Assign';
      assign.addEventListener('click', async () => {
        const issueKey = (typed.value.trim() || pick.value).trim();
        if (!issueKey) return;
        try {
          await api('issue', {
            method: 'POST',
            body: JSON.stringify({
              key: item.key,
              branch: item.branch,
              project: item.project,
              issueKey,
            }),
          });
          await load();
          msg('Assigned ' + issueKey + '.');
        } catch (err) { msg(err.message); }
      });

      row.append(pick, typed, assign);
      banner.appendChild(row);
    }

    const hiddenIssues = issueState.entries.length - shownIssues.length;
    if (hiddenIssues > 0) {
      const more = document.createElement('button');
      more.style.marginTop = '10px';
      more.textContent = 'Show ' + hiddenIssues + ' more';
      more.addEventListener('click', () => { issuesExpanded = true; render(); });
      banner.appendChild(more);
    }

    box.appendChild(banner);
  }

  const totalGap = state.gaps.reduce((sum, g) => sum + g.seconds, 0);
  if (totalGap > 0) {
    const banner = document.createElement('div');
    banner.className = 'banner';
    banner.innerHTML = '<h3>' + fmt(totalGap) + ' unaccounted</h3>' +
      '<div class="note">punchcard will not invent these hours. ' +
      'Log them against a day below, or leave them.</div>';
    box.appendChild(banner);
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function push(dryRun) {
  const destination = $('destination').value;
  if (!destination) { msg('No destination configured.'); return; }

  const pushable = state.entries.filter((e) => !isUnassigned(e.project));
  const total = pushable.reduce((sum, e) => sum + e.seconds, 0);

  // The attestation gate: a machine drafted these hours, a human signs for them.
  if (!dryRun && !confirm(
    'Submit ' + fmt(total) + ' across ' + pushable.length + ' entries to ' + destination + '?'
  )) return;

  msg(dryRun ? 'Checking…' : 'Submitting…', 'saving');
  try {
    const result = await api('push', {
      method: 'POST',
      body: JSON.stringify({ period: $('period').value, adapter: destination, dryRun }),
    });
    const held = result.heldForIssue || [];
    const heldSeconds = held.reduce((sum, e) => sum + e.seconds, 0);
    const fallback = result.usedFallback || [];
    const fallbackSeconds = fallback.reduce((sum, e) => sum + e.seconds, 0);

    msg((dryRun ? 'Dry run: ' : '') + result.created + ' created, ' + result.updated +
        ' updated, ' + result.removed + ' removed' +
        (result.failed.length ? ', ' + result.failed.length + ' failed' : '') + '.' +
        // Held-back entries must be reported here too, or the UI silently
        // drops hours the CLI would have told you about.
        // Point at the panel on this page, not at a terminal command. The UI
        // telling you to go and use the CLI is the UI admitting defeat.
        (held.length
          ? '  ' + held.length + ' entry(s) (' + fmt(heldSeconds) +
            ') held back: assign an issue above.'
          : '') +
        // A catch-all must stay visible, or it quietly becomes where hours go
        // to be forgotten.
        (fallback.length
          ? '  ' + fallback.length + ' entry(s) (' + fmt(fallbackSeconds) +
            ') had no ticket and used your fallback issue.'
          : ''));
    // Take the user to the thing they now have to act on.
    if (held.length) {
      const panel = [...document.querySelectorAll('#banners .banner')]
        .find((b) => b.textContent.indexOf('need a Jira issue') !== -1);
      if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    if (!dryRun) await load();
  } catch (err) { msg(err.message); }
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => setView(tab.dataset.view));
}
$('period').addEventListener('change', load);
$('destination').addEventListener('change', load);
$('dry').addEventListener('click', () => push(true));
$('push').addEventListener('click', () => push(false));

load().then(() => {
  // Land on Setup until a destination exists: the grid is meaningless
  // before you've said where the hours are going.
  setView(state.destinations.some((d) => d.configured) ? 'sheet' : 'setup');
});
</script>
</body>
</html>`;
