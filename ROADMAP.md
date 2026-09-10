# Roadmap

What punchcard does today, what it should do next, and roughly what each costs.

**These are open.** Nothing here is claimed. If you want to build one, open an issue saying so and go — see [CONTRIBUTING.md](CONTRIBUTING.md).

Every item has to hold the line on the two rules that make this tool trustworthy: **never invent billable hours**, and **every entry shows its evidence**. A feature that quietly pads a timesheet is not a feature.

---

## Shipped

| | |
|---|---|
| Git collector | All repos, all refs, author-filtered, issue keys from branch names |
| Sessionizer | Commit clusters into working sessions with a gap threshold |
| Timeline resolver | Overlap resolution by source priority; billed time can never exceed wall clock |
| Calendar collector | Private iCal URLs, recurrence expansion, TZID/DST, meeting filtering |
| Slack capture | Poll a self-DM or channel, natural-language durations, idempotent |
| Quick capture | `punch log`, declarative not timer-based |
| Review | Terminal, `$EDITOR` markdown round-trip, and a local web UI |
| Overrides | Your edits persist and survive new evidence |
| Reconciliation | Re-running converges instead of duplicating |
| Jira issue matching | Tiered resolution; a text match is never auto-pushed |
| Adapters | Toggl Track, Jira worklogs, Clockify |

---

## Next up

### WakaTime / wakapi collector
**Size: medium · Impact: highest**

Every duration punchcard produces today is *inferred* from commit clustering. WakaTime measures real editor time. With it, git answers *what* and *which project* (which it is very good at) and WakaTime answers *how long* (which commits cannot).

Should register as a `measured` signal so it outranks `commit` in the timeline resolver. Must support self-hosted [wakapi](https://github.com/muety/wakapi), not just the hosted service.

### Code review collector
**Size: medium · Impact: high**

PR reviews are 15-25% of a senior developer's week and are completely invisible to their own commits. The GitHub API hands you timestamped review events for free. GitLab equivalent alongside it.

This is arguably the most *differentiating* item on the list: no other timesheet tool counts the time you spent reviewing someone else's code.

### CSV export
**Size: small · Impact: high**

The escape hatch for Workday, SAP, Deltek, Replicon and every other enterprise portal with no usable API. Generate a file, a person uploads it once. No scraping, no browser automation, no terms-of-service problem.

Also the fast path for bulk historical writes on rate-limited destinations.

### Scheduled runs
**Size: small · Impact: medium**

`punch schedule --daily 17:00`, writing a launchd plist or systemd timer.

**Draft and notify, never auto-submit.** Submitting hours nobody looked at is exactly what this tool exists not to do.

### Retroactive backfill
**Size: small · Impact: medium**

`punch backfill --since 2026-06-01`. Git history is permanent, so punchcard can reconstruct months you never logged. Resumable and idempotent, because on a throttled destination it may take hours.

Preview should be instant and offline; only the push is slow.

---

## Wanted, unclaimed

### More destinations
- **Tempo** — real timesheet periods and approval workflow; where the enterprise pain is. Tempo worklogs are a superset of Jira's, so this extends the Jira adapter rather than replacing it.
- **Harvest** — agency and consultancy side. Clean API.
- **Linear** — issue-based like Jira, so the issue matcher already applies.

### More sources
- **Git commit trailers** — `Time-spent: 45m` in a commit message. Zero infrastructure, already in the workflow.
- **Slack emoji capture** — react with ⏱ on any message to log against it, including someone else's "sprint review starting now".
- **Slack huddles** — real start and end times via the API, for the meetings that never make it onto a calendar.
- **iOS Shortcut** — capture while walking out of a meeting.
- **PagerDuty / incidents** — on-call time is real, billable, and never recorded.

### Engine
- **Fuller RRULE support** — `BYSETPOS`, `BYMONTHDAY`, `BYYEARDAY`. Currently reported as unexpandable rather than approximated, which is correct but incomplete.
- **Optional LLM parser fallback** — only when the deterministic parser fails, only via an OpenAI-compatible endpoint so Ollama, LM Studio, Groq and xAI all work through one path. Local by default: work logs are confidential. **The model may only extract a duration a human stated, never estimate one.**
- **Learned gap suggestions** — after a few weeks, "you usually assign unaccounted Tuesday time to X". Suggest, never fill.

### Team
- **`punch merge`** — each developer approves their own slice locally; merge bundles them into one file for an admin. Must refuse to include a slice nobody attested to.
- **Centralized mode** — reconstruct a team from the GitHub org API with nobody installing anything. Powerful, and surveillance-shaped, so it needs opt-in from the people being measured, not just from their manager.

### Interface
- **TUI review** — for people who never want to leave the terminal.
- **Keyboard-first web review** — j/k navigation, inline edit without reaching for the mouse.
- **Better mobile layout** — the entry grid does not collapse well under 700px yet.

---

## Deliberately not planned

**Browser automation of enterprise portals.** Workday, SAP, Deltek and friends have no usable API, and driving their UI is fragile, breaks monthly, and generally violates their terms. CSV export is the honest path.

**Auto-submitting without review.** Not a missing feature. It is the thing the tool refuses to do.

**Estimating hours from thin air.** No heuristic, no model, no "you probably worked 8 hours". Unaccounted time stays unaccounted until a human says otherwise.
