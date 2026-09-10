# Contributing

punchcard is open source and contributions are genuinely welcome. [ROADMAP.md](ROADMAP.md) lists what's wanted; nothing on it is claimed.

## Getting started

```bash
git clone <your fork>
cd punchcard
npm install
npm run build
npm link          # gives you a global `punch` while developing
npm test
```

`punch preview` works against your own repos immediately after `punch init`. Nothing is written to any timesheet system until you run `punch push`, so it is safe to experiment.

## The two rules

Every change has to hold these. They are why anyone would trust this tool with billable hours.

**1. Never invent billable hours.** Evidence covers maybe 5.5 of an 8-hour day. punchcard shows the rest as a gap. Do not add a heuristic that distributes it, a model that estimates it, or a default that fills it. If these hours are client-billed, padding them is fraud with the user's name on it.

**2. Every entry shows its evidence.** If you add a signal source, it must produce provenance a human can read and check. "3h because we said so" is not acceptable output.

A useful test: if a client's auditor asked "where did this hour come from?", could the user answer from what's on screen?

## Adding a signal source

Collectors live in `src/collectors/`. A collector's only job is to turn something into `Signal[]`; nothing downstream knows what a git commit or a calendar event is.

```ts
export async function collectThing(cfg: Config, period: Period): Promise<Signal[]>
```

Decisions you need to make:

- **`confidence`** — `measured` if you have a real start and end (calendar, WakaTime). `inferred` if you are deriving a duration (commit clustering). `attested` only if a human explicitly stated it.
- **`source`** — add it to `SOURCE_PRIORITY` in `src/types.ts`. This decides who wins when two signals claim the same minutes. Think about where yours belongs before picking a number.
- **`hints`** — whatever helps map the work to a project or issue later.

Point events (a commit, a message) should be zero-length; let the sessionizer or the human supply duration.

## Adding a destination

Adapters live in `src/adapters/` and implement `Adapter` from `src/types.ts`. They are deliberately thin: the value of this project is the reconstruction engine, not the HTTP calls.

Requirements:

- **`preflight()` must be honest.** Report the plan tier, the rate limit, anything that will bite later. Clockify's adapter warns about the ~30 requests/hour free-workspace limit because failing at entry twenty-two with no explanation is worse than saying so upfront.
- **Mark your entries.** A tag, a marker, something. You must be able to tell your rows from hand-entered ones, and you must never modify a row a human created.
- **Never overwrite a human edit.** If an entry carries your marker but the payload no longer matches what you wrote, someone corrected it. Leave it alone.
- **Respect locked periods.** Once approved or submitted, entries are immutable. Detect and skip rather than erroring mid-run.
- Register it in `src/adapters/index.ts` with a `blurb` that says what the trade-off is.

## Tests

`node --test`, no framework. Run `npm test`.

Test the logic where a bug costs someone money:

- duration and date parsing (`src/util/time.test.ts`)
- period boundaries, especially semi-monthly and biweekly (`src/util/period.test.ts`)
- overlap resolution (`src/engine/timeline.test.ts`)
- issue matching (`src/engine/issues.test.ts`)
- ICS recurrence and DST (`src/collectors/ics.test.ts`)

Several of these tests exist because they caught real defects: a single shared word scoring as a confident Jira match, `1h30m` parsing as 30 minutes, retroactive logs cannibalising each other. Adding a test that encodes a near-miss is a genuinely useful contribution on its own.

## The UI

`src/ui/page.ts` is one self-contained document. No framework, no build step, on purpose: `npx punchcard` should stay a small, fast install.

Constraints if you touch it:

- The whole page is a single template literal. **No backticks anywhere in the file**, including in comments.
- Light and dark, both tested.
- Every input needs an accessible name. Placeholder-as-label is not a label.
- Keyboard focus must be visible. This is a data grid people edit by keyboard.
- Radius scale: surfaces 10px, controls 8px, pills full. Do not introduce a fourth.
- Numbers are monospace so columns of durations line up.

## Style

Match what's there. Comments explain *why*, especially where the code looks odd on purpose. Several non-obvious decisions are documented in place: why retroactive logs stack backwards from end of day, why the ICS unit regex uses a lookahead instead of `\b`, why reconstructed entries are never cached.

If you fix something subtle, leave a note saying what would break without it.

## Pull requests

- One concern per PR.
- Say what you verified, and what you did not. "Adapter written, untested against the live API, no credentials" is a fine and useful thing to write.
- If you change behaviour around hours, durations, or pushes, add a test.
