import type { ActivityRecord, ContradictionObservation, DriftSignal, InterventionRecord, ResponseLevel, TreeState } from '../data/types.js';
import type { MetacogStore } from '../data/store.js';
import type { MetacogConfig } from '../config.js';
import { type ActivityInput, type AlignmentVerdict } from './alignment.js';
import { dominantContradiction, type SignalDraft } from './drift.js';
import { type EscalationDecision } from './escalation.js';
import { computeTrend } from './trend.js';
/** One tension's read-only share of a goal's contradiction context. */
export interface GoalContradictionRef {
    id: string;
    title: string;
    intensity: number | null;
    weight: number;
}
/**
 * The contradiction burden of one goal, as the detector sweep reads it.
 *
 * Read-only on purpose: this is context for a judgement, never an input to the
 * escalation rules. Levels, thresholds and repeat counting are computed exactly
 * as before; these numbers only let a reader — and the signal's own rationale —
 * know that the goal is already under tension.
 */
export interface GoalContradictionContext {
    total: number;
    count: number;
    peak: number;
    unmeasured: number;
    contradictions: GoalContradictionRef[];
}
/**
 * Build the goal → contradiction context for one detector sweep.
 *
 * Pure over the tree and config: no store access, so the sweep pays for it once
 * and the same state always yields the same context.
 *
 * @param state - current tree.
 * @param config - resolved configuration (weights live in `config.contradictions`).
 * @returns one entry per goal that at least one unresolved tension touches.
 */
export declare function goalContradictionContext(state: TreeState, config: MetacogConfig): Map<string, GoalContradictionContext>;
/**
 * Attach the goal contradiction burden to each draft's rationale.
 *
 * The burden is appended as context, not folded into confidence or level: a
 * detector's verdict must stay exactly what its own evidence says. Signals that
 * concern no goal, or goals no tension touches, are returned untouched.
 *
 * @param drafts - detector output for this sweep.
 * @param state - current tree.
 * @param config - resolved configuration.
 * @returns drafts with a read-only context clause where one exists.
 */
export declare function attachGoalBurdenContext(drafts: readonly SignalDraft[], state: TreeState, config: MetacogConfig): SignalDraft[];
/** A signal the service persisted, with its escalation decision attached. */
export interface RecordedSignal {
    signal: DriftSignal;
    decision: EscalationDecision;
}
/** Everything one `check_drift` run produced. */
export interface DriftCheckResult {
    /** The activity this run judged, when the caller supplied one. */
    activity?: ActivityRecord;
    /**
     * The judge's verdict, before it was narrowed to the record's vocabulary.
     *
     * Kept beside the record rather than folded into it because `ActivityRecord`'s
     * `decision` is a four-value enum and cannot say `unbound`. This is where that
     * distinction survives, and it is what a caller should read to learn whether
     * the activity was placed on the tree at all.
     */
    verdict?: AlignmentVerdict;
    /** True when the fingerprint was already recorded and nothing new happened. */
    duplicate: boolean;
    /** Signals appended by this run. */
    signals: RecordedSignal[];
    /** Candidates this run produced, present only when `deferSignals` was set. */
    drafts?: SignalDraft[];
    /** Interventions opened by this run. */
    interventions: InterventionRecord[];
    /** One-line Level 1 hints worth injecting in the next turn. */
    level1Hints: string[];
    /** Contradiction trends recomputed for the nodes this run touched. */
    trends: {
        contradictionId: string;
        title: string;
        trend: string;
        intensity: number | null;
        rationale: string;
    }[];
}
/**
 * Build a dedupe fingerprint for a tool-call event (spec 4.2 step 1).
 *
 * A tool call has a host-assigned `callId`, so the fingerprint needs no content
 * hash: the same call replayed collapses on identity, which is exactly the
 * idempotence the spec requires.
 *
 * @param sessionId - session that produced the call.
 * @param callId - host tool-call id.
 */
export declare function toolCallFingerprint(sessionId: string, callId: string): string;
/**
 * Build a fingerprint for a user message.
 *
 * @param sessionId - session that produced the message.
 * @param seq - monotonic message sequence inside the session.
 */
export declare function userMessageFingerprint(sessionId: string, seq: number | string): string;
/**
 * Build a content-addressed fingerprint for a manually reported activity.
 *
 * Manual reports have no host identity, so the same description submitted twice
 * must collapse on content. Text is normalized first so trailing whitespace or
 * incidental punctuation cannot manufacture a second record.
 *
 * @param sessionId - session reporting the activity.
 * @param summary - activity description.
 * @param evidence - supporting evidence lines.
 */
export declare function manualFingerprint(sessionId: string, summary: string, evidence: readonly string[]): string;
/** Arguments for {@link runActivityCheck}. */
export interface ActivityCheckRequest {
    /** Activity text as reported. */
    summary: string;
    /** Verifiable evidence lines. */
    evidence: string[];
    /**
     * File paths the activity touched, as recorded by the tool that touched them.
     *
     * Optional: a manual report, a conversation turn or a contradiction observation
     * has no file of its own, and an activity without paths must be judged exactly
     * as it was before path ownership existed.
     */
    paths?: string[];
    /** Source classification. */
    source: ActivityInput['source'];
    /** Observation grade the caller established. */
    grade: ActivityInput['grade'];
    /** Session that produced the activity. */
    sessionId: string;
    /** Dedupe fingerprint. */
    eventFingerprint: string;
    /** Tool name, when known. */
    toolName?: string;
    /**
     * Per-turn tool trace, when the collector produced one.
     *
     * Distinct from `toolName`: that one names a single filtered call for the rule
     * detectors, this one is the full ordered sequence including noise tools, which
     * is what the trajectory signals read. A record that carries the first but not
     * the second is from before the v4 collector, and must stay distinguishable
     * from a turn that genuinely called no tools.
     */
    trace?: {
        toolNames: string[];
        toolResults: {
            tool: string;
            ok: boolean | null;
            excerpt: string;
            outcome: 'tests-pass' | 'tests-fail' | 'build-pass' | 'build-fail' | null;
            /** Digest of the call's arguments; empty when it was not captured. */
            signature: string;
        }[];
    };
    /** Explicit candidate goals from the caller, honoured over the heuristic. */
    candidateGoalIds?: string[];
    /** A bottleneck the caller believes is now current (drives `contradiction_shift`). */
    blockerHint?: string;
    /**
     * Evaluate without publishing anything.
     *
     * Set by the live collector: a rule firing on one activity is a *candidate*,
     * settled later by a model in an hourly batch. Returning the drafts lets the
     * caller queue them instead of letting every rule hit reach the signal stream.
     */
    deferSignals?: boolean;
    /** Clock injection for tests. */
    now?: Date;
}
/**
 * Record an observed activity and run every drift detector over it.
 *
 * @param store - project store.
 * @param state - current tree state (read by the caller under its own CAS read).
 * @param projectId - project id.
 * @param request - the activity plus context.
 * @param config - resolved configuration.
 * @returns what this run appended, or `duplicate: true` for a replayed event.
 */
export declare function runActivityCheck(store: MetacogStore, state: TreeState, projectId: string, request: ActivityCheckRequest, config: MetacogConfig): Promise<DriftCheckResult>;
/**
 * Publish drafts that a second opinion has already endorsed.
 *
 * Kept separate from {@link runActivityCheck} because the two happen at different
 * times: screening is per activity, publishing is per review batch. Sharing
 * `persistDrafts` keeps repeat counting and escalation in one place either way.
 *
 * @param store - project store.
 * @param state - current confirmed tree.
 * @param projectId - owning project.
 * @param drafts - candidates the model also called drift.
 * @param config - thresholds.
 * @param now - timestamp for the publication.
 */
export declare function publishDrafts(store: MetacogStore, state: TreeState, projectId: string, drafts: readonly SignalDraft[], config: MetacogConfig, now: Date, options?: {
    mayEscalate?: boolean;
    bypassed?: boolean;
}): Promise<{
    signals: RecordedSignal[];
    interventions: InterventionRecord[];
    level1Hints: string[];
}>;
/**
 * Record a contradiction observation and return its computed trend.
 *
 * The trend is computed **before** the new observation is appended when the
 * caller asks for the trend of the history (which is the spec's definition:
 * `computedTrend` is derived from the prior window). The observation is then
 * persisted with that value, so the stored stream is self-describing.
 *
 * @param store - project store.
 * @param projectId - project id.
 * @param input - the observation to record.
 * @param config - resolved configuration.
 * @returns the stored observation and the node's trend after appending.
 */
export declare function recordObservation(store: MetacogStore, projectId: string, input: {
    contradictionId: string;
    observedAt: string;
    intensity: number | null;
    evidence: string[];
    confidence: number;
    rationale: string;
    sessionId?: string;
}, config: MetacogConfig): Promise<{
    observation: ContradictionObservation;
    trend: ReturnType<typeof computeTrend>;
}>;
/**
 * Recompute the trend of one contradiction from its stored stream, without
 * recording anything. Used by the read-only surfaces so a trend query never
 * mutates the history it reads.
 *
 * @param store - project store.
 * @param projectId - project id.
 * @param contradictionId - node to inspect.
 * @param config - resolved configuration.
 */
export declare function readContradictionTrend(store: MetacogStore, projectId: string, contradictionId: string, config: MetacogConfig): Promise<ReturnType<typeof computeTrend>>;
/**
 * Build the intervention record a Level 2/3 signal opens.
 *
 * @param signal - the escalated signal.
 * @param state - current tree, used to name goals and the blocking contradiction.
 * @param now - clock injection.
 */
export declare function buildIntervention(signal: DriftSignal, state: TreeState, now: Date): InterventionRecord;
/**
 * Summarise the current blocking contradiction for the prompt and reports.
 *
 * @param input - current project facts.
 */
export { dominantContradiction };
/** A level counted for reporting. */
export type LevelCounts = Record<ResponseLevel, number>;
/**
 * Run the checks that need no activity: goal staleness, contradiction pressure
 * and the optional contradiction-shift probe.
 *
 * Kept separate from {@link runActivityCheck} because it must never fabricate an
 * `ActivityRecord`: a static check observed nothing, and writing a phantom
 * activity would pollute the very drift statistics the report is built from.
 *
 * @param store - project store.
 * @param state - current tree state.
 * @param projectId - project id.
 * @param blockerHint - the bottleneck the caller believes is current, if any.
 * @param config - resolved configuration.
 * @param now - clock injection.
 * @param sessionId - session the check runs in, or `undefined` for a timer tick
 *   that runs outside any conversation.
 * @returns the appended signals and hints, with no activity.
 */
export declare function runStaticCheck(store: MetacogStore, state: TreeState, projectId: string, blockerHint: string | undefined, config: MetacogConfig, now: Date, sessionId: string | undefined): Promise<Omit<DriftCheckResult, 'activity' | 'duplicate'>>;
/**
 * Count signals by level, for a compact status line.
 *
 * @param signals - signals to count.
 */
export declare function countLevels(signals: readonly DriftSignal[]): LevelCounts;
