import { z } from 'zod';
import { type ActivityRecord, type AuditAction, type AuditActor, type AuditLogEntry, type ContradictionObservation, type DriftSignal, type GeneratedReport, type GoalNode, type ContradictionNode, type InterventionRecord, type JudgmentRecord, type ProjectContext, type TreeSnapshot, type TreeState } from './types.js';
import { type SignalState } from './signals.js';
/**
 * One realtime verdict record.
 *
 * A separate stream from `signals/` on purpose: a signal is a rule detector's
 * output, a verdict is a model's holistic read of a window. They answer
 * different questions, and mixing them would let one chain's threshold
 * contaminate the other's history.
 */
export declare const VerdictRecordSchema: z.ZodObject<{
    id: z.ZodString;
    projectId: z.ZodString;
    at: z.ZodString;
    windowStart: z.ZodString;
    windowEnd: z.ZodString;
    match: z.ZodNullable<z.ZodNumber>;
    goalId: z.ZodNullable<z.ZodString>;
    reason: z.ZodString;
    expectNext: z.ZodString;
    fulfilled: z.ZodNullable<z.ZodBoolean>;
    provider: z.ZodString;
    model: z.ZodString;
    elapsedMs: z.ZodNumber;
    inputChars: z.ZodNumber;
    outputChars: z.ZodNumber;
}, z.core.$strip>;
export type VerdictRecord = z.infer<typeof VerdictRecordSchema>;
/** Everything a caller supplies; the store mints `id` when it is absent. */
export type VerdictRecordInput = Omit<VerdictRecord, 'id'> & {
    readonly id?: string;
};
/** CAS rejection: the caller's `expectedVersion` did not match the store. */
export declare class VersionConflictError extends Error {
    readonly projectId: string;
    readonly expectedVersion: number;
    readonly actualVersion: number;
    readonly code = "VERSION_CONFLICT";
    constructor(projectId: string, expectedVersion: number, actualVersion: number);
}
/** Structural precondition the caller cannot satisfy by retrying unchanged. */
export declare class StoreInvariantError extends Error {
    readonly code = "STORE_INVARIANT";
    constructor(message: string);
}
/**
 * Canonical serialization for hashing: keys sorted, no whitespace.
 *
 * Hash stability must not depend on property insertion order, so the audit
 * chain hashes this projection rather than `JSON.stringify` of the raw object.
 *
 * @param value - JSON value to canonicalize.
 */
export declare function canonicalize(value: unknown): string;
/**
 * Compute an audit entry's SHA-256 hash.
 *
 * @param entry - the entry without its own `entryHash`.
 * @returns lowercase hex digest.
 */
export declare function computeAuditHash(entry: Omit<AuditLogEntry, 'entryHash'>): string;
/** Result of verifying a project's audit chain. */
export interface AuditVerification {
    /** Whether every link and hash checked out. */
    valid: boolean;
    /** Number of entries examined. */
    entries: number;
    /** Human-readable reasons, empty when `valid`. */
    problems: string[];
}
/** What a caller must supply to commit a structural change. */
export interface CommitRequest {
    /** Version the caller read; must equal the stored version. */
    expectedVersion: number;
    /** Goal nodes after the change. */
    goals: GoalNode[];
    /** Contradiction nodes after the change. */
    contradictions: ContradictionNode[];
    /** Why this change is happening; recorded in the snapshot and audit log. */
    reason: string;
    /** Audit action class. */
    action: AuditAction;
    /** Who is acting. */
    actor: AuditActor;
    /** Node ids the change touched. */
    targetIds: string[];
    /** Evidence supporting the change. */
    evidence?: string[];
    /** Mark the project confirmed (used by `goal_tree_confirm`). */
    markConfirmed?: boolean;
}
/** Outcome of a successful commit. */
export interface CommitResult {
    /** The new tree state. */
    state: TreeState;
    /** The snapshot written for the new version. */
    snapshot: TreeSnapshot;
    /** The audit entry appended for the new version. */
    audit: AuditLogEntry;
}
/**
 * Per-project persistence facade.
 *
 * One instance is created per project root; every method takes or derives a
 * `projectId`, and the id is part of every path, so cross-project reads are
 * structurally impossible rather than merely discouraged.
 */
export declare class MetacogStore {
    readonly projectRoot: string;
    readonly storageSubdir: string;
    /** Absolute directory holding this project's persisted state. */
    readonly root: string;
    private readonly queued;
    /**
     * @param projectRoot - absolute project root directory.
     * @param storageSubdir - relative directory for this plugin's state.
     */
    constructor(projectRoot: string, storageSubdir: string);
    private statePath;
    private snapshotDir;
    private snapshotPath;
    private milestoneArchiveDir;
    private fileBaselinePath;
    private observationsPath;
    private activitiesPath;
    private signalsPath;
    private signalStatePath;
    /**
     * Read the cross-step signal state, or `undefined` before the first step.
     *
     * Absence is meaningful and is preserved: a project with no state has never
     * been scored, which is different from a project scored at zero.
     *
     * @param projectId - owning project.
     */
    readSignalState(projectId: string): Promise<SignalState | undefined>;
    /**
     * Persist the cross-step signal state.
     *
     * Written whole rather than appended: the state is a single current value, and
     * an append log would make every read replay the whole history to find it.
     *
     * @param state - validated state.
     */
    writeSignalState(state: SignalState): Promise<SignalState>;
    private signalsArchiveDir;
    private activitiesArchiveDir;
    private interventionsPath;
    private judgmentsPath;
    private auditPath;
    private reportsPath;
    private verdictsPath;
    /**
     * Serialize every mutation of one project.
     *
     * Two tool calls (or a tool call and a periodic check) can reach this store
     * concurrently in the same process; without a per-project queue both would
     * read the same version and the second rename would silently win. The queue
     * makes read-check-write atomic within the process, and {@link commit}'s
     * version comparison covers everything else.
     *
     * @param projectId - project whose lock to take.
     * @param operation - work to run under the lock.
     */
    private withProjectLock;
    /**
     * Read a project's current tree state.
     *
     * @param projectId - project to read.
     * @returns the state, or `undefined` when the project has never been initialised.
     */
    readState(projectId: string): Promise<TreeState | undefined>;
    /**
     * Initialise a project's tree state, or overwrite an unconfirmed draft.
     *
     * `goal_tree_init` uses this to replace the candidate tree; a project that is
     * already confirmed refuses re-initialisation so a stray call cannot discard
     * user-confirmed structure.
     *
     * @param projectId - project to initialise.
     * @param goals - candidate goal nodes.
     * @param contradictions - candidate contradiction nodes.
     * @param options.force - replace an existing unconfirmed draft.
     * @returns the new state at version 0 (confirmation bumps it to 1).
     */
    initialize(projectId: string, goals: GoalNode[], contradictions: ContradictionNode[], options?: {
        force?: boolean;
        projectContext?: ProjectContext;
    }): Promise<TreeState>;
    /**
     * Clear a confirmed tree so it can be derived again from scratch.
     *
     * Re-derivation is normally refused because the tree is the yardstick: an
     * activity judged aligned against "T3" yesterday would refer to a goal that no
     * longer exists today. That reasoning holds for *drift*, not for a user who
     * says the project itself is being restated — so the refusal is lifted under
     * two conditions that a stray call cannot satisfy by accident:
     *
     * - `expectedVersion` must equal the stored version, which proves the caller
     *   read the current tree before discarding it;
     * - the previous tree is copied to `rebuilds/<projectId>/` and the reset is
     *   recorded as a `tree_reset` audit entry, so the discard is reversible and
     *   visible in the chain.
     *
     * The version number is deliberately not rewound. Snapshots are stored per
     * version, so reusing a number would overwrite the tree that was just
     * replaced; the next confirmation simply commits the version after it.
     *
     * Observation, activity and signal streams are left untouched: they are
     * append-only history, and records naming contradictions from the replaced
     * tree simply never match the new ids.
     *
     * @param projectId - project to reset.
     * @param options.expectedVersion - version the caller believes is current.
     * @param options.reason - why the tree is being discarded; written to the audit log.
     * @returns the cleared state, the backup path and the audit entry id.
     * @throws {VersionConflictError} when `expectedVersion` is stale.
     * @throws {StoreInvariantError} when there is no confirmed tree to reset.
     */
    resetForRebuild(projectId: string, options: {
        expectedVersion: number;
        reason: string;
    }): Promise<{
        state: TreeState;
        backupPath: string;
        auditEntryId: string;
    }>;
    /**
     * Rewrite a tree written before goals carried `depth`.
     *
     * Reading already tolerates the legacy `level` field, so this is not what makes an
     * old project usable — it is what makes the conversion auditable. Without it, the
     * old records would be silently reinterpreted on every read and the audit chain
     * would keep no trace of the change.
     *
     * Idempotent: a project that already carries `depth` is left untouched.
     *
     * @param projectId - project to migrate.
     * @returns whether a migration was written.
     */
    migrateLegacyTree(projectId: string): Promise<boolean>;
    /**
     * Read the stored project context.
     *
     * @param projectId - project to read.
     * @returns the context, or `undefined` when never supplied.
     */
    readProjectContext(projectId: string): Promise<ProjectContext | undefined>;
    /**
     * Store or replace the project context without touching the tree.
     *
     * Deliberately not a versioned structural change: the context describes the
     * setting the tree lives in, and editing it must not invalidate confirmed
     * nodes or produce snapshots that differ only in prose.
     *
     * @param projectId - project to update.
     * @param context - the new context.
     * @returns the context as stored.
     */
    setProjectContext(projectId: string, context: ProjectContext): Promise<ProjectContext>;
    /**
     * Read the dedicated metacognitive session id.
     *
     * Kept beside the project state rather than inside it: the binding must exist
     * *before* any tree does, because the session is where the tree gets derived.
     * Storing it on `TreeState` would create a chicken-and-egg requirement.
     *
     * @param projectId - project to read.
     * @returns the session id, or `undefined` when none was recorded.
     */
    readMetacogSessionId(projectId: string): Promise<string | undefined>;
    /**
     * Record the dedicated metacognitive session id.
     *
     * Deliberately independent of the tree: initialisation binds the session
     * first, then derives the tree inside it.
     *
     * @param projectId - project to update.
     * @param sessionId - the session that owns initialisation.
     */
    setMetacogSessionId(projectId: string, sessionId: string): Promise<void>;
    /**
     * Read when the monitor last reported back to the user.
     *
     * A judgement window is not a fixed period. "The last 24 hours" re-judges work
     * the user already answered and skips work older than a day that was never
     * judged at all. The honest boundary is the previous report: everything that
     * happened since then, and nothing before it.
     *
     * @param projectId - project to read.
     * @returns ISO timestamp of the last report, or `undefined` when never reported.
     */
    readCheckpoint(projectId: string): Promise<string | undefined>;
    /**
     * Record that the monitor has just reported to the user.
     *
     * Written only after a report actually reached them: moving the boundary on a
     * failed call would silently drop the activities it never judged.
     *
     * @param projectId - project to update.
     * @param at - ISO timestamp of the report.
     */
    setCheckpoint(projectId: string, at: string): Promise<void>;
    /**
     * Read the realtime verdict window start.
     *
     * A separate file from the report checkpoint on purpose: the 5-minute
     * verdict and the 25-minute sweep cover different questions and must not
     * advance each other's window. Sharing one would make whichever runs first
     * silently starve the other of activities.
     *
     * @param projectId - project to read.
     * @returns ISO timestamp of the last realtime tick, or `undefined`.
     */
    readRealtimeCheckpoint(projectId: string): Promise<string | undefined>;
    /**
     * Record the end of the last realtime window.
     *
     * Written only after a successful verdict or an idle window, never after a
     * failed call: a failure must retry the same activities on the next tick.
     *
     * @param projectId - project to update.
     * @param at - ISO timestamp of the tick.
     */
    setRealtimeCheckpoint(projectId: string, at: string): Promise<void>;
    /**
     * Append one realtime verdict record.
     *
     * Kept out of the `signals/` stream deliberately: a verdict is a model's
     * holistic read, a signal is a rule detector's finding. The two chains keep
     * separate histories so neither threshold contaminates the other.
     *
     * @param input - verdict fields; `id` is minted when absent.
     * @returns the validated record as written.
     */
    appendVerdict(input: VerdictRecordInput): Promise<VerdictRecord>;
    /**
     * Read a project's verdict stream, optionally bounded by `at`.
     *
     * @param projectId - owning project.
     * @param options.since - inclusive lower bound on `at`.
     * @param options.until - inclusive upper bound on `at`.
     * @returns records oldest first.
     */
    readVerdicts(projectId: string, options?: {
        since?: Date;
        until?: Date;
    }): Promise<VerdictRecord[]>;
    /**
     * Commit a structural change under CAS.
     *
     * Performs, in one project-locked critical section: version comparison, state
     * write, snapshot write, audit append. A mismatch throws
     * {@link VersionConflictError} and touches nothing.
     *
     * @param projectId - project to mutate.
     * @param request - the change and its audit metadata.
     * @returns the committed state, snapshot and audit entry.
     * @throws {VersionConflictError} when `expectedVersion` is stale.
     */
    commit(projectId: string, request: CommitRequest): Promise<CommitResult>;
    /**
     * Read one historical snapshot.
     *
     * Reports bind to the version they were generated against, so this must keep
     * working after later versions exist.
     *
     * @param projectId - project to read.
     * @param version - snapshot version.
     * @returns the snapshot, or `undefined` when that version was never written.
     */
    readSnapshot(projectId: string, version: number): Promise<TreeSnapshot | undefined>;
    /**
     * List every snapshot written for a project.
     *
     * Read-only and unbounded by design: the number of snapshots is the number of
     * structural changes, which reports need in full to compare a period's start
     * against its end.
     *
     * @param projectId - project to read.
     * @returns snapshots oldest version first.
     */
    listSnapshots(projectId: string): Promise<TreeSnapshot[]>;
    /**
     * Read the audit chain for a project.
     *
     * @param projectId - project to read.
     * @returns entries oldest first.
     */
    readAuditLog(projectId: string): Promise<AuditLogEntry[]>;
    /**
     * Append one audit entry, linking it to the previous entry's hash.
     *
     * Not exported as a tool and not reachable from the interaction layer: the
     * only way an entry enters the log is through a governed commit.
     *
     * @param projectId - project to append to.
     * @param fields - the entry minus id/timestamp/hashes.
     * @returns the appended entry.
     */
    private appendAudit;
    /**
     * Verify a project's audit chain end to end.
     *
     * Checks three things per entry: the recomputed hash equals the stored one,
     * `prevHash` equals the previous entry's `entryHash`, and the very first
     * entry links to {@link GENESIS_HASH}.
     *
     * @param projectId - project to verify.
     * @returns verification outcome with concrete problems listed.
     */
    verifyAuditChain(projectId: string): Promise<AuditVerification>;
    /**
     * Append an audit entry for an event that does not change the tree.
     *
     * `resolve_intervention` is the case this exists for: recording a user's
     * decision is auditable (spec 2.4 lists the action) but leaves both trees
     * untouched, so it must not consume a version. `beforeVersion` and
     * `afterVersion` are therefore identical, and the hash chain still extends.
     *
     * @param projectId - project to append to.
     * @param fields - the entry minus id/timestamp/hashes/versions.
     * @returns the appended entry.
     */
    appendStandaloneAudit(projectId: string, fields: Omit<AuditLogEntry, 'id' | 'projectId' | 'timestamp' | 'prevHash' | 'entryHash' | 'beforeVersion' | 'afterVersion'>): Promise<AuditLogEntry>;
    /**
     * Append a contradiction observation.
     *
     * @param projectId - owning project.
     * @param observation - validated observation record.
     */
    appendObservation(projectId: string, observation: ContradictionObservation): Promise<ContradictionObservation>;
    /**
     * Read a project's observation stream.
     *
     * @param projectId - owning project.
     * @param options.since - inclusive lower bound on `observedAt`.
     * @returns observations oldest first.
     */
    readObservations(projectId: string, options?: {
        since?: Date;
    }): Promise<ContradictionObservation[]>;
    /**
     * Append an activity record.
     *
     * @param projectId - owning project.
     * @param record - validated activity record.
     */
    appendActivity(projectId: string, record: ActivityRecord): Promise<ActivityRecord>;
    /**
     * Read a project's activity stream.
     *
     * @param projectId - owning project.
     * @param options.since - inclusive lower bound on `timestamp`.
     */
    readActivities(projectId: string, options?: {
        since?: Date;
    }): Promise<ActivityRecord[]>;
    /**
     * Find an activity by its dedupe fingerprint.
     *
     * @param projectId - owning project.
     * @param eventFingerprint - fingerprint to look for.
     * @returns the existing record, or `undefined`.
     */
    findActivityByFingerprint(projectId: string, eventFingerprint: string): Promise<ActivityRecord | undefined>;
    /**
     * Append a drift signal.
     *
     * @param projectId - owning project.
     * @param signal - validated signal record.
     */
    appendSignal(projectId: string, signal: DriftSignal): Promise<DriftSignal>;
    /**
     * Read a project's drift signal stream.
     *
     * @param projectId - owning project.
     * @param options.since - inclusive lower bound on `observedAt`.
     */
    readSignals(projectId: string, options?: {
        since?: Date;
    }): Promise<DriftSignal[]>;
    /**
     * Move every stored signal into an archive file and empty the live stream.
     *
     * Signals are evidence of what the rules once said, so deleting them would erase
     * the only record of how the monitor behaved. Keeping them live is equally wrong:
     * a batch produced by a collector that no longer exists keeps inflating every
     * level count and repeat tally, which is how 1459 stale `scope_drift` rows made
     * the escalation statistics meaningless.
     *
     * The archive is one file per run, named by the moment it was taken, so the
     * history stays readable and nothing is overwritten.
     *
     * @param projectId - owning project.
     * @param reason - why the archive is being taken; recorded beside the data.
     * @returns how many signals moved, and where they went.
     */
    archiveSignals(projectId: string, reason: string): Promise<{
        archived: number;
        path: string | null;
    }>;
    /**
     * Move the activity stream into a dated archive and empty it.
     *
     * Mirrors `archiveSignals`, with one difference that matters: emptying this stream
     * breaks the link from every past judgement back to the activity it judged. The
     * judgement rows keep their `activityIds`, and those ids now point at an archive
     * rather than at the live stream. That is why the tool makes it opt-in.
     *
     * @param projectId - owning project.
     * @param reason - why, stored beside the archive.
     * @returns how many moved and where.
     */
    archiveActivities(projectId: string, reason: string): Promise<{
        archived: number;
        path: string | null;
    }>;
    /**
     * Write a milestone snapshot: the tree, plus the judgement statistics that go
     * with it.
     *
     * The tree already snapshots itself on every commit, so the tree alone is not
     * worth archiving twice. What this adds is the *pairing* — which tree the
     * statistics were measured against. Six months from now the interesting question
     * is not "what did the tree say" but "when we changed the tree, did the
     * judgements get better", and that cannot be answered from either half alone.
     *
     * Not called automatically. A milestone is a decision: the user confirmed new
     * structure, or a phase ended, or the thresholds changed. Stamping one on every
     * commit would produce a directory nobody reads.
     *
     * @param projectId - owning project.
     * @param label - short human name for this milestone.
     * @param note - why it was taken.
     * @returns where it landed, and the version it captured.
     */
    archiveMilestone(projectId: string, label: string, note: string): Promise<{
        path: string;
        version: number;
    }>;
    /**
     * List the milestones archived for a project, newest first.
     *
     * Archive was write-only: a milestone could be recorded but never read back, so
     * "did the judgement improve after the tree changed" had both halves on disk and
     * no way to compare them.
     *
     * A file that fails to parse is skipped rather than throwing: one corrupt entry
     * must not make the whole history unreadable.
     *
     * @param projectId - owning project.
     * @returns summaries, newest first.
     */
    listMilestones(projectId: string): Promise<{
        path: string;
        label: string;
        note: string;
        archivedAt: string;
        version: number;
        counts: Record<string, number>;
    }[]>;
    /**
     * Read one archived milestone in full, including the tree it captured.
     *
     * @param projectId - owning project.
     * @param path - absolute path from {@link listMilestones}.
     * @returns the stored document, or `undefined` when it cannot be read.
     */
    readMilestone(projectId: string, path: string): Promise<Record<string, unknown> | undefined>;
    /**
     * Read the stored file baseline for a project.
     *
     * Kept out of the activity stream on purpose: it is derived state, not evidence.
     * A corrupt baseline should cost one missed diff, not a corrupt judgement history,
     * so a parse failure is treated as "no baseline yet" rather than propagated.
     *
     * @param projectId - owning project.
     * @returns the baseline, or `undefined` when there is none.
     */
    readFileBaseline(projectId: string): Promise<Record<string, {
        size: number;
        hash: string;
    }> | undefined>;
    /**
     * Replace the stored file baseline.
     *
     * @param projectId - owning project.
     * @param baseline - the fingerprint map to store.
     */
    writeFileBaseline(projectId: string, baseline: Record<string, {
        size: number;
        hash: string;
    }>): Promise<void>;
    /**
     * Read every intervention record for a project.
     *
     * Interventions are stored as an append-only stream of versions; the latest
     * record for an id wins, so a `pending` record superseded by a `resolved` one
     * resolves to the latter.
     *
     * @param projectId - owning project.
     * @returns current records, deduplicated to the newest version per id.
     */
    readInterventions(projectId: string): Promise<InterventionRecord[]>;
    /**
     * Append one version of an intervention record.
     *
     * @param projectId - owning project.
     * @param record - validated intervention record.
     */
    appendIntervention(projectId: string, record: InterventionRecord): Promise<InterventionRecord>;
    /**
     * Read a project's drift-candidate log.
     *
     * Stored as an append-only stream of versions: a candidate is written once as
     * `pending` and re-appended once the model settles it, so the original program
     * verdict survives after the decision is made.
     *
     * @param projectId - owning project.
     * @returns current records, deduplicated to the newest version per id.
     */
    readJudgments(projectId: string): Promise<JudgmentRecord[]>;
    /**
     * Append one version of a judgement record.
     *
     * @param projectId - owning project.
     * @param record - validated record.
     */
    appendJudgment(projectId: string, record: JudgmentRecord): Promise<JudgmentRecord>;
    /**
     * Append a generated report.
     *
     * @param projectId - owning project.
     * @param report - validated report.
     */
    appendReport(projectId: string, report: GeneratedReport): Promise<GeneratedReport>;
    /**
     * Read a project's reports.
     *
     * @param projectId - owning project.
     * @returns reports oldest first.
     */
    readReports(projectId: string): Promise<GeneratedReport[]>;
}
