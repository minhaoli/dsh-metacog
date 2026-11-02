/** One tool call and what came back, in the order the host reported them. */
export interface BehaviourStep {
    readonly name: string;
    /** A stable digest of the arguments, so "same call" does not need the payload. */
    readonly signature: string;
    /** Whether the call failed. `null` when the host did not say. */
    readonly failed: boolean | null;
}
/** How many identical calls in a row count as a loop. */
export declare const REPEAT_THRESHOLD = 3;
/** How many identical failures in a row count as a retry loop. */
export declare const ERROR_STREAK_THRESHOLD = 3;
/** How many alternations (A,B,A,B) count as an alternating loop. */
export declare const ALTERNATING_CYCLES = 3;
/** A score in 0..1 with the evidence that produced it. */
export interface BehaviourFinding {
    readonly score: number;
    readonly evidence: readonly string[];
}
/**
 * Identical consecutive calls with the same arguments.
 *
 * Three is the smallest count that is not plausibly a legitimate retry: two can be
 * a transient failure, three identical attempts almost never are.
 *
 * @param steps - the turn's calls in order.
 */
export declare function scoreRepeatRate(steps: readonly BehaviourStep[]): BehaviourFinding | undefined;
/**
 * Consecutive failures of the same call.
 *
 * A single failure is normal and must never count: every agent retries a transient
 * error once. What this catches is retrying without changing anything.
 *
 * @param steps - the turn's calls in order.
 */
export declare function scoreErrorStreak(steps: readonly BehaviourStep[]): BehaviourFinding | undefined;
/**
 * Two calls alternating: A,B,A,B,A,B.
 *
 * Distinct from a repeat loop because the agent *is* changing something — it just
 * returns to the state it came from, which is the shape of "undo, redo, undo".
 *
 * @param steps - the turn's calls in order.
 */
export declare function scoreAlternatingLoop(steps: readonly BehaviourStep[]): BehaviourFinding | undefined;
/**
 * Narration without an action.
 *
 * The turn produced assistant text but no tool call at all. That is not always
 * bad — a final answer looks the same — so this only fires when the turn *also*
 * carried no completion marker, which the caller decides. The signal therefore
 * takes the turn's own verdict rather than guessing from text length.
 *
 * @param hadToolCall - whether any tool ran in this turn.
 * @param claimedCompletion - whether the turn looks like a finished answer.
 */
export declare function scoreMonologue(hadToolCall: boolean, claimedCompletion: boolean): BehaviourFinding | undefined;
