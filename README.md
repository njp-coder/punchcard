# punchcard

**Reconstruct your week from what you actually did, review it, then submit it.**

Timesheet automation for developers. Not another time tracker you'll forget to start — punchcard works *backwards*, from evidence you've already generated.

```
$ punch preview

  week of 2026-09-07   28h 15m · 3 projects

  Mon 08 Sep  6h 30m
     4h 00m  acme        OAuth token refresh; fix session race [PROJ-142]
            ← commit — 7 commits on feat/oauth-refresh
     1h 30m  acme        Sprint planning
            ← manual — logged by you
     1h 00m  internal    Reviewed webhook retry logic
            ← review — 3 PR reviews
    ⚠  1h 30m  unaccounted (target 8h)
```

Then `punch push` writes it to Toggl, Clockify, or Jira.

---

## Why this exists

Nobody suffers because the POST request is hard. They suffer because on Friday at 5pm they can't remember what they did on Tuesday.

So the hard part of this project isn't the API integrations — it's the **reconstruction engine**: turning git history, editor time, calendar events, and PR reviews into a defensible timesheet. The adapters are deliberately thin.

## Principles

**We never invent billable hours.** Evidence covers maybe 5.5 of an 8-hour day, every day. punchcard shows the gap as a gap. It does not quietly distribute it across your projects to make the numbers look tidy — if these hours are client-billed, padding them is fraud with *your* name on it. The tool proposes; you attest.

**Every entry shows its evidence.** Each line carries provenance — which commits, which meeting, which measurement. That makes review fast, makes the numbers trustworthy, and gives you receipts if a client ever disputes an invoice.

**Local-first.** Config in `~/.config/punchcard`, state in `~/.local/share/punchcard`, both plain text you can read and repair. No server, no account, nothing leaves your machine except the entries you explicitly push.

What's stored locally, and why:

| File | Contents |
|---|---|
| `manual.jsonl` | Your `punch log` entries. Append-only — these are attested by a human, so we never rewrite them. |
| `overrides.json` | Your edits from `punch review`, replayed over each fresh reconstruction. |
| `pushed.json` | Which entry went where, and what it looked like — this is what makes re-pushing safe. |
| `attestations.json` | What you approved, when, for team merges. |
| `cache.json` | Remote project lists. Aggressively cached: on a throttled workspace, naive metadata fetching burns the entire hourly budget before the first write. |

Reconstructed entries are deliberately **not** cached — git history is permanent, so a stored draft could only go stale. Evidence is recomputed every run; only your decisions persist.

**It asks once.** Every unmapped repo, issue prefix, or recurring meeting prompts a single time and is remembered. If punchcard asks you the same question twice, that's a bug.

**Re-running is always safe.** Pushes reconcile against what's already there instead of appending. Run it hourly, daily, or twice by accident — it converges. Double-billed hours is the one bug we won't ship.

**If you edit an entry, we never touch it again.** Your correction is better than our guess by definition.

## Install

```bash
npx punchcard init
```

Requires Node 20+.

## Usage

```bash
punch init                  # discover your repos, pick a destination
punch preview               # see the reconstructed week — never writes anything
punch ui                    # open the review UI in your browser
punch review                # or edit it in $EDITOR instead
punch log 1h sprint review  # capture work that leaves no digital trace
punch map                   # assign unmapped repos and issue prefixes
punch destinations          # list supported timesheet platforms
punch push --adapter jira   # write it, after you confirm
punch status                # one line: what's unlogged right now
```

### Calendars

Meetings are the largest block of hours git cannot see. punchcard reads them from **private iCal (ICS) URLs** rather than OAuth — Google and Outlook both publish a per-calendar secret address, so there is no app to register and no client secret (which an open-source tool could never ship anyway).

In Google Calendar: *Settings → your calendar → Secret address in iCal format*. In Outlook: *Settings → Calendar → Shared calendars → Publish*.

```yaml
calendars:
  - name: work
    url: env:WORK_CALENDAR_ICS   # the URL is itself a secret — keep it in the environment
```

Recurring events are expanded (daily standups, weekly syncs, fortnightly one-to-ones), TZID wall times survive DST changes, and these are skipped automatically: cancelled events, invitations you declined, events marked *free*, all-day entries (holidays, OOO, birthdays), and anything matching `calendarIgnore` — which defaults to lunch, PTO, OOO and similar.

Recurrence rules punchcard won't expand (`BYSETPOS`, `BYMONTHDAY`, `BYYEARDAY`) are **reported, not approximated** — a meeting placed on the wrong day is worse than one we admit we couldn't read.

### Slack

Type — or dictate — how you spent your time where you already are:

```
last one hour I was helping Priya with the deploy
spent 2 hours on the migration
half an hour debugging payments
```

Then pull it in: **Sync from Slack** in the Slack card of `punch ui`, or `punch sync` in a terminal.

Note that punchcard *polls* Slack rather than running a bot, so typing `punch sync` into Slack itself does nothing. There is nothing listening there; the pull happens from your machine. Messages with no duration ("I worked on the API today") are reported and skipped — punchcard never guesses a number.

It **polls with a user token** rather than running a bot: a slash-command bot needs a public webhook endpoint, which would mean hosting a server. Polling keeps everything local. By default it reads the DM you have with yourself — a private, zero-noise inbox.

Create the app from the manifest in this repo rather than clicking through the scopes UI. At [api.slack.com/apps](https://api.slack.com/apps) choose **Create an App → From a manifest** (not *Blank app*) and paste [`slack-app-manifest.yaml`](slack-app-manifest.yaml). `punch ui` shows the same manifest with a copy button.

Then **Install to Workspace** and copy the **User OAuth Token**, which starts with `xoxp-`.

Slack shows several credentials and only one is relevant. On **Basic Information** you will see *Client ID*, *Client Secret*, *Signing Secret* and *Verification Token*: **none of these are used**. They exist for apps that receive webhooks from Slack, and punchcard only reads. The token you need is on **OAuth & Permissions**:

| Token | Prefix | |
|---|---|---|
| App Configuration | `xoxe-` | For configuring apps. Expires in 12 hours. Not this. |
| Bot User OAuth | `xoxb-` | Acts as a bot, which is not in your self-DM. Not this. |
| **User OAuth** | `xoxp-` | Acts as you. **This one.** |

Paste it into the Slack card in `punch ui`, or set it in config:

```yaml
slack:
  token: env:SLACK_USER_TOKEN
  # channel: C0123ABCD   # omit to use your self-DM
```

If you change scopes later you must **reinstall** the app and copy the new token; Slack does not extend an existing token's permissions.

Re-syncing is idempotent — each Slack message carries a stable id, so the same hour is never imported twice.

### Time that has no ticket

Jira worklogs attach to an issue, never to a project, so meetings, admin and support have nowhere to go. By default punchcard **holds those hours back** and tells you, rather than guessing a ticket.

If your team keeps a catch-all issue, name it and that work routes there instead:

```yaml
adapters:
  jira:
    fallbackIssue: KAN-13   # meetings, admin, support
```

Assign real tickets either from the terminal with `punch issues`, or in the **Timesheet** tab of `punch ui`, which shows the same ranked candidates with a dropdown.

Assignments are remembered per **project and branch** (`branch:dashlytics:main`), not per branch alone. Every repository has a `main`, so keying on the branch by itself would send one project's hours to another project's ticket.

Opt-in only, and never silent. A fallback:

- **never overrides a real match** — a branch issue key, a remembered mapping, even a text suggestion all outrank it
- **is reported on every push** (`4 entry(s) (5h 30m) had no ticket and will go to KAN-13`)
- **keeps being offered for assignment** — `punch issues` still lists those entries, so a catch-all never becomes where hours go to be forgotten

Toggl and Clockify log against projects rather than issues, so they need none of this.

### The review UI

```bash
punch ui
```

Opens a local review interface in your browser: the week laid out by day, every entry editable inline (duration, project, description), unaccounted time highlighted with a box to log straight into it, provenance under each line, and a submit button.

It is **local only** — bound to `127.0.0.1`, gated by a token minted fresh each launch, and it dies when you Ctrl-C. Nothing is hosted and nothing phones home. The token is required on every API call because an unauthenticated localhost server is reachable by any page you happen to have open, and this one can write to a billing system.

No framework, no build step — it's one self-contained document, so `npx punchcard` stays a small install.

Every other command works without it. If you'd rather stay in the terminal, `punch review` does the same job in `$EDITOR`.

### Reviewing and editing in $EDITOR

`punch review` opens the week as markdown in your `$EDITOR`:

```markdown
## 2026-09-09  (4h 45m)

- 2h       sponsio       Put the install line where the first command is  #37e457327ef1
- 1h 30m   acme          Client call  #dc1d492c6278
- 45m      acme          Debugging payments  [PROJ-142]  #b82fc0210d54

  <!-- 3h 15m unaccounted. Add a line above to assign it. -->
```

Change a duration, reassign a project, rewrite a description, or delete a line to drop the entry. Save and close.

Chosen over a TUI or a local web UI because it's the interaction developers already know — you edit it the way you edit a commit message — and it keeps the no-server promise intact. It works over SSH.

**Your edits persist.** They're stored separately from the reconstruction, so new commits landing on the same day won't overwrite them. Revert a line to what punchcard originally proposed and it starts tracking evidence again.

### Quick capture

Some work leaves no trace: the unscheduled call, debugging over someone's shoulder, the incident you got pulled into. Log it in one shot:

```bash
punch log 1h sprint review
punch log 30m pairing with sam on PROJ-142
punch log 1h30m client call --date yesterday --project acme
```

Declarative, not a start/stop timer — timers are the failure mode of every time tracker ever built. People start them and forget to stop them.

### The nudge

Put this in your shell prompt or `.zshrc` and you'll never lose a Friday again:

```bash
punch status
# ⚠ 22h 45m logged · 5h 15m unaccounted · week of 2026-09-07
```

## How reconstruction works

```
collectors → signals → sessionize → timeline → reconstruct → review → adapter
```

1. **Collect.** Git commits across every configured repo and every ref — work on a branch you've since abandoned still happened.
2. **Sessionize.** Commits are *points in time*, not durations. Consecutive commits less than two hours apart become one working session, starting 45 minutes before the first commit. (When WakaTime is connected it measures real editor time and supersedes this; git then only answers *what* and *which project*, which it's far better at.)
3. **Resolve the timeline.** Signals overlap constantly — you commit during a meeting, an editor sits open behind a call. A sweep awards each slice of wall-clock to exactly one signal by priority:

   `manual > calendar > editor > review > tracker > commit`

   Because slices never overlap, billed time can never exceed elapsed time. You cannot claim eleven hours for a nine-hour day.
4. **Reconstruct.** Consolidate to one entry per (day, project, issue). Nobody wants a timesheet with nine lines reading "fix typo" — and a consolidated week is ~20 writes instead of ~70, which is the difference between fitting inside a throttled free-tier API budget and crawling for three hours.
5. **Review, then push.**

## Project mapping

The hardest part of any tool like this is knowing which project a piece of work belongs to. punchcard resolves in this order:

| Source | Example |
|---|---|
| Explicit | `punch log 1h call --project acme` |
| Issue key | `feature/PROJ-142-oauth` → `PROJ` → `acme` |
| Repo | `~/Documents/api` → `backend` |
| Meeting title | `Standup – Team A` → `team-a` |

This is why **Jira is the highest-accuracy destination** punchcard can write to: developers already put issue keys in branch names, so the mapping is free.

## Destinations

Run `punch destinations` to see these, or pick one during `punch init`.

| Adapter | Status | Notes |
|---|---|---|
| Toggl Track | ✅ v0.1 | Recommended first target — one token, no punitive free-tier limit |
| Jira worklogs | ✅ v0.1 | Free mapping via issue keys. Needs no Marketplace purchase. |
| Clockify | ✅ v0.1 | New free workspaces are throttled to ~30 requests/hour — push daily, not weekly |
| Tempo | 📋 planned | Real timesheet periods and approval workflow |
| CSV export | 📋 planned | The escape hatch for Workday, SAP, Deltek — no API needed, HR uploads once |

**Not supported, deliberately:** browser automation of enterprise portals. It's fragile, breaks monthly, and usually violates the platform's terms. CSV export is the honest path there.

## Configuration

`~/.config/punchcard/config.yaml`:

```yaml
period:
  type: weekly        # daily | weekly | biweekly | semimonthly | monthly
  weekStart: 1        # 0 = Sunday
  deadline: fri 17:00

targetHoursPerDay: 8
roundToMinutes: 15

authors:
  - you@example.com   # commits by anyone else are ignored

repos:
  - path: ~/code/api
    project: backend

mapping:
  repo:
    api: backend
  issuePrefix:
    PROJ: acme

adapters:
  toggl:
    apiToken: env:TOGGL_API_TOKEN   # env: indirection — never paste tokens here
```

Credentials use `env:` indirection so a config can be shared, committed, or pasted into an issue without leaking anything.

## Contributing

punchcard is open source and contributions are welcome. [ROADMAP.md](ROADMAP.md) lists what's wanted and roughly what each costs; nothing on it is claimed. [CONTRIBUTING.md](CONTRIBUTING.md) covers how collectors and adapters plug in, and the two rules every change has to hold.

Highest-impact unclaimed work right now: the **WakaTime collector** (turns every inferred duration into a measured one) and the **code review collector** (15-25% of a senior developer's week, invisible to their own commits).

## Roadmap

See [ROADMAP.md](ROADMAP.md) for what is shipped, what is next, and what is deliberately out of scope.

## License

MIT
