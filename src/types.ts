/**
 * Core domain model.
 *
 * The pipeline is:
 *   collectors -> Signal[] -> sessionize -> timeline (overlap resolution)
 *              -> reconstruct -> DraftEntry[] -> review -> adapter.push
 *
 * Two invariants hold everywhere in this file:
 *
 *  1. Every DraftEntry carries its Provenance. If we can't say where an hour
 *     came from, we don't propose it.
 *  2. We never invent billable time. Unexplained hours surface as a Gap for a
 *     human to assign — see `reconstruct.ts`.
 */

/** Where a signal came from. Order matters: see SOURCE_PRIORITY below. */
export type SourceKind =
  | 'manual' // human explicitly declared it (punch log, Slack)
  | 'calendar' // real meeting with real start/end
  | 'editor' // WakaTime / wakapi durations
  | 'review' // PR reviews, review comments
  | 'tracker' // Jira/Linear transitions, comments
  | 'commit'; // git commits — points in time, inferred durations

/**
 * When two signals claim the same wall-clock minutes, the higher priority wins.
 * A human saying "the sprint review took 40 minutes" beats a calendar invite
 * that blocked out an hour, which beats anything we inferred from commits.
 */
export const SOURCE_PRIORITY: Record<SourceKind, number> = {
  manual: 100,
  calendar: 80,
  editor: 60,
  review: 40,
  tracker: 30,
  commit: 10,
};

/** How much we trust the duration attached to a signal. */
export type Confidence = 'attested' | 'measured' | 'inferred';

/**
 * A single piece of evidence that work happened, normalized across collectors.
 * Collectors emit these; nothing downstream knows what a git commit is.
 */
export interface Signal {
  id: string;
  source: SourceKind;
  confidence: Confidence;

  /** Wall-clock interval, in epoch ms. For point events start === end. */
  start: number;
  end: number;

  /** Human-readable description of the work, e.g. a commit subject. */
  description: string;

  /** Raw hints used later to map this signal onto a project/issue. */
  hints: {
    repo?: string;
    branch?: string;
    /** e.g. PROJ-142, harvested from branch names and commit messages. */
    issueKey?: string;
    calendarId?: string;
    attendees?: string[];
    /** Set directly by `punch log --project foo`. */
    project?: string;
  };

  /** Free-form detail shown in the review, e.g. "7 commits on feat/auth". */
  detail?: string;
}

/** Why we believe an entry, rendered under it during review. */
export interface Provenance {
  signalIds: string[];
  summary: string[];
  confidence: Confidence;
}

/**
 * A proposed timesheet entry, before it has been pushed anywhere.
 * Consolidated to one per (date, project) — see the rate-limit and UX
 * reasoning in the README.
 */
export interface DraftEntry {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  /** Resolved project id in *our* namespace, mapped per-adapter at push time. */
  project: string;
  /** Issue key when we have one; drives Jira/Tempo worklogs. */
  issueKey?: string;
  /** Branch the work happened on — the anchor for remembered issue mappings. */
  branch?: string;
  description: string;
  seconds: number;
  billable: boolean;

  /**
   * Epoch ms of the earliest evidence in this entry. Every destination API
   * demands a start time, and this is the honest one — inventing "09:00"
   * would put fiction in a billing record.
   */
  startMs: number;

  provenance: Provenance;

  /**
   * Stable identity for this entry across runs. Lets us reconcile instead of
   * blindly appending: same key -> update, missing key -> create, orphaned
   * key -> delete. Double-billed hours is the one bug we cannot ship.
   */
  key: string;
}

/** Time we could not explain. Never silently filled. */
export interface Gap {
  date: string;
  seconds: number;
  /** Hours the user expects to account for that day, from config. */
  targetSeconds: number;
}

export interface Timesheet {
  period: Period;
  entries: DraftEntry[];
  gaps: Gap[];
}

/* ------------------------------------------------------------------ */
/* Periods                                                             */
/* ------------------------------------------------------------------ */

export type PeriodType = 'daily' | 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';

export interface PeriodConfig {
  type: PeriodType;
  /** 0 = Sunday .. 6 = Saturday. Only meaningful for weekly/biweekly. */
  weekStart: number;
  /** Anchor for biweekly cycles, YYYY-MM-DD. */
  anchor?: string;
  /** Local deadline that drives the nudge, e.g. "fri 17:00". */
  deadline?: string;
}

export interface Period {
  /** Inclusive local dates, YYYY-MM-DD. */
  start: string;
  end: string;
  label: string;
}

/* ------------------------------------------------------------------ */
/* Adapters                                                            */
/* ------------------------------------------------------------------ */

export interface RemoteProject {
  id: string;
  name: string;
  clientName?: string;
}

/** An entry that already exists on the remote, used for reconciliation. */
export interface RemoteEntry {
  id: string;
  date: string;
  seconds: number;
  description: string;
  /** Our entry key, recovered from a tag/marker. Undefined = hand-entered. */
  key?: string;
}

export interface PushPlan {
  create: DraftEntry[];
  update: Array<{ remote: RemoteEntry; draft: DraftEntry }>;
  /** Ours, but no longer in the draft — the work was reassigned or removed. */
  remove: RemoteEntry[];
  /** Ours by key, but a human edited it. We leave these strictly alone. */
  respect: RemoteEntry[];
}

/**
 * Every destination implements this. Adapters are deliberately thin: the value
 * of this project is the reconstruction engine, not the HTTP calls.
 */
export interface Adapter {
  readonly name: string;

  /** Verify credentials and report anything the user needs to know upfront. */
  preflight(): Promise<PreflightResult>;

  listProjects(): Promise<RemoteProject[]>;

  /** Read back what's already there, so we can reconcile rather than append. */
  listEntries(period: Period): Promise<RemoteEntry[]>;

  createEntry(draft: DraftEntry): Promise<void>;
  updateEntry(remoteId: string, draft: DraftEntry): Promise<void>;
  deleteEntry(remoteId: string): Promise<void>;
}

export interface PreflightResult {
  ok: boolean;
  /** Human-facing notes, e.g. "Free workspace — ~28 writes/hour". */
  notes: string[];
  /** Observed write budget per hour, when the API tells us. */
  writesPerHour?: number;
}
