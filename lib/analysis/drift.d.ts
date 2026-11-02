/**
 * Deterministic drift detectors.
 *
 * Each detector answers one question about a project's own recorded history and
 * returns a *draft* signal: everything except `id` and `level`. Assigning a
 * level is the escalation machine's job ({@link module:dsh-metacog/analysis/escalation}),
 * because the level depends on how many same-class signals already exist and on
 * whether a pending intervention is already open — facts a detector should not
 * need to know.
 *
 * Two rules run through every detector here:
 *
 * - Nothing is inferred from an absence of data. A detector that cannot find
 *   evidence returns nothing rather than a low-confidence signal.
 * - Records without a timestamp are compared against the injected clock, never
 *   against wall-clock time, so tests are reproducible.
 *
 * @module dsh-metacog/analysis/drift
 */
import type { ActivityRecord, ContradictionNode, ContradictionObservation, DriftSignal, DriftSignalType, GoalNode, MonitorCategory, TreeState } from '../data/types.js';
import type { MetacogConfig } from '../config.js';
/** A signal before the escalation machine assigns its response level. */
export interface SignalDraft {
    observedAt: string;
    monitorCategory: MonitorCategory;
    signalType: DriftSignalType;
    relatedGoalIds: string[];
    relatedContradictionIds: string[];
    activityIds: string[];
    confidence: number;
    evidence: string[];
    /**
     * One or two Chinese lines for the user: what happened, why it matters, and
     * what can be done next.
     *
     * `rationale` below stays technical (rule names, thresholds, ids) for the
     * audit trail. The prompt block reads this field only.
     */
    hint: string;
    rationale: string;
}
/** Everything the detectors read. */
export interface DriftInput {
    state: TreeState;
    activities: readonly ActivityRecord[];
    observations: readonly ContradictionObservation[];
    signals: readonly DriftSignal[];
    config: MetacogConfig;
    now: Date;
}
/**
 * Stable identity of a signal class, used to count repeats and to decide
 * whether a pending intervention already covers this problem.
 *
 * The binding target (contradiction ids, else goal ids) is part of the key, so
 * three misaligned activities against *different* contradictions never add up
 * to one escalation.
 *
 * @param signalType - the detector that produced the signal.
 * @param relatedContradictionIds - contradictions the signal concerns.
 * @param relatedGoalIds - goals the signal concerns.
 * @returns a comparable key string.
 */
export declare function signalClassKey(signalType: DriftSignalType, relatedContradictionIds: readonly string[], relatedGoalIds: readonly string[]): string;
/**
 * Current intensity of a contradiction, or `null` when nothing supports a level.
 *
 * Reads the observation stream in the window and the node's own field, taking
 * the higher of the two. `null` is preserved rather than folded into 0: an
 * unobserved tension has an *unknown* intensity, and rendering it as 0 both
 * misinforms the reader and contradicts the `null` the tree view reports for
 * the same node.
 *
 * @param node - the contradiction.
 * @param observations - recorded observations.
 * @param windowMinutes - sliding window.
 */
export declare function currentIntensity(node: ContradictionNode, observations: readonly ContradictionObservation[], windowMinutes: number): number | null;
/**
 * Detect `goal_staleness` (spec 4.3 item 3).
 *
 * A goal is stale when no evidence was added and no aligned activity was
 * recorded for `staleDaysThreshold` days. The clock compared against is the
 * later of the goal's own `updatedAt` and its most recent aligned activity, so
 * a goal that is being worked on without being edited is not reported.
 *
 * @param input - current project facts.
 * @returns one draft per stale goal, or an empty array.
 */
export declare function detectGoalStaleness(input: DriftInput): SignalDraft[];
/**
 * Detect `core_bypass` (spec 4.3 item 2).
 *
 * Both halves must be real: a blocking contradiction that is intense and not
 * easing, *and* a run of recorded activity that avoids it. Either half alone is
 * not a bypass — a high-intensity contradiction the user is actively working on
 * is just a hard problem.
 *
 * @param input - current project facts.
 * @returns one draft per bypassing contradiction, or an empty array.
 */
export declare function detectCoreBypass(input: DriftInput): SignalDraft[];
/**
 * Detect `scope_drift` from a single already-judged activity.
 *
 * The activity record carries the verdict; this detector only decides whether
 * the verdict is strong enough and which blocking contradiction it aggravates,
 * so the escalation machine can bind repeats together.
 *
 * @param activity - the recorded activity.
 * @param input - current project facts.
 * @returns one draft per drift activity, or an empty array.
 */
export declare function detectScopeDrift(activity: ActivityRecord, input: DriftInput): SignalDraft[];
/**
 * Detect `contradiction_shift` (spec 4.3 item 4).
 *
 * The plugin cannot discover a new bottleneck by itself, so the caller supplies
 * one (`blockerHint` from its own reading of the work). This detector's job is
 * narrow and checkable: is that bottleneck already covered by a current `main`
 * node? If yes, nothing has shifted; if no, the structure lags the work.
 *
 * @param blockerHint - the bottleneck the caller believes is current.
 * @param input - current project facts.
 * @returns a draft when the structure has not caught up, else an empty array.
 */
export declare function detectContradictionShift(blockerHint: string, input: DriftInput): SignalDraft[];
/**
 * The blocking contradiction with the highest current intensity.
 *
 * Used by the Level 1 rule ("a main contradiction whose intensity has not
 * eased") and by the report's "main contradiction" line.
 *
 * @param input - current project facts.
 * @returns the node and its current intensity, or `undefined`.
 */
export declare function dominantContradiction(input: DriftInput): {
    node: ContradictionNode;
    intensity: number | null;
    trend: string;
} | undefined;
/**
 * Detect dated goals that are running out of time without recorded movement.
 *
 * This is the calendar's opinion, not the activity stream's. `goal_staleness`
 * asks whether anything touched a goal lately; this asks whether enough
 * happened given how much of the span is gone. A goal can be "recently touched"
 * and still be at 80% elapsed with nothing to show.
 *
 * Two deliberate narrowings:
 *
 * - Only a goal whose reminder condition fired produces a draft. A quarter-mark
 *   goal with progress is not news, and reporting it would train the user to
 *   ignore these signals.
 * - Only a depth this span is judged at is considered. A two-year root goal is
 *   not late because nothing happened this week.
 *
 * @param input - current project facts.
 * @returns one draft per dated goal that is behind schedule.
 */
export declare function detectDeadlineRisk(input: DriftInput): SignalDraft[];
/**
 * Detect the Level 1 condition "a blocking contradiction has not eased".
 *
 * This is a prompt-level nudge, not an intervention: it carries no activity and
 * exists so the injected prompt line can name a rising or stalled main
 * contradiction.
 *
 * @param input - current project facts.
 * @returns a draft when a blocking contradiction is intense and not falling.
 */
export declare function detectContradictionPressure(input: DriftInput): SignalDraft[];
/**
 * Goals that a drift signal could name, for prompt summaries.
 *
 * @param state - current tree.
 * @param ids - goal ids referenced by a signal or report.
 * @returns the matching goals, in tree order.
 */
export declare function goalsByIds(state: TreeState, ids: readonly string[]): GoalNode[];
