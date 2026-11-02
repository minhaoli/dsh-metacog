/**
 * S4: how much of the declared plan actually happened.
 *
 * The only signal that asks a question none of the others can: of the steps the
 * session said it would take, how many were taken. S3 notices a tool outside the
 * whitelist, S2 notices a changed work pattern, S5 notices that nothing changed —
 * none of them notices that a specific promised step was quietly dropped.
 *
 * The score is `1 - completed / total`, so a plan with nothing done scores 1 and a
 * finished plan scores 0. Steps marked `optional` are excluded from the
 * denominator: a session should not accumulate drift for not doing something it
 * explicitly said was optional.
 *
 * @module dsh-metacog/analysis/signals/plan
 */
import type { DeclaredPlan, PlanStep, SignalScore } from '../../data/signals.js';
import type { CollectedToolResult } from '../../collect.js';
/**
 * What the matcher is allowed to look at.
 *
 * Kept separate from the trace so a step can be evaluated against a *window* — a
 * step may be satisfied by any call between its own start and the start of the
 * next step, not only by the call that happens to be current.
 */
export interface PlanWindow {
    /** Tools called in this window, in order. */
    tools: readonly string[];
    /** Arguments-derived paths touched in this window. */
    paths: readonly string[];
    /** Results seen in this window. */
    results: readonly CollectedToolResult[];
}
/** Why a step is or is not complete. */
export interface StepVerdict {
    /** Index of the step in the plan. */
    index: number;
    /** The step's human-readable intent. */
    intent: string;
    complete: boolean;
    /** Which expectation decided it, for the report. */
    because: string;
}
/**
 * Convert a glob to a regular expression.
 *
 * `*` does not cross a directory separator and `**` does. Both are anchored, so a
 * pattern matches a whole path rather than any substring of one — a pattern
 * `src/*.ts` must not match `other/src/deep/x.ts`.
 *
 * Windows separators are normalised to `/` before matching, and the comparison is
 * case-insensitive on that platform. Getting this wrong would make a plan
 * satisfied on Linux and violated on Windows for identical work.
 *
 * @param glob - the pattern.
 * @returns a matcher.
 */
export declare function globToRegExp(glob: string): RegExp;
/**
 * Decide whether one step is complete.
 *
 * Three rules, all deliberate:
 *
 * - Every supplied expectation must hold. A step that says "edit and pass tests"
 *   is not complete when only the edit happened.
 * - An empty `expects` is never complete. The alternative — treating "no
 *   constraint" as "always satisfied" — would make one unconstrained step zero
 *   the whole score, and the user has no way to know which step did it.
 * - A failed match is not drift. It means this step is not done yet; whether that
 *   is drift is the EMA's and the coverage floor's decision, not this function's.
 *
 * @param step - the declared step.
 * @param window - what happened during the step's window.
 * @param index - position in the plan.
 * @returns the verdict.
 */
export declare function evaluateStep(step: PlanStep, window: PlanWindow, index: number): StepVerdict;
/** What one plan step is judged against: a contiguous slice of the turn. */
export interface StepSlice {
    tools: readonly string[];
    paths: readonly string[];
    results: readonly CollectedToolResult[];
}
/**
 * Cut a turn into one window per plan step, in plan order.
 *
 * The collector records a flat sequence of calls per turn and does not say which
 * call belonged to which declared step. Anything finer than a *contiguous slice*
 * of that sequence would be a guess, and this is the wrong place to guess: it
 * would credit one step with work another step did.
 *
 * So: walk the steps in order, and for each take the shortest run of consecutive
 * calls — starting where the previous satisfied step ended — that satisfies its
 * `expects`. A satisfied step moves the cursor past its run; an unsatisfied one
 * leaves the cursor alone, so a later step may still claim those calls. That is
 * what makes a skipped middle step visible. Giving every step the whole turn, as
 * this used to, meant a call that satisfied step 3 also satisfied step 2, so
 * "step 2 was quietly dropped" could never be detected.
 *
 * Known limit, accepted: a plan carried out out of order is under-reported. If
 * step 3's calls come before step 2's, step 2 scans forward, finds nothing, and
 * stays incomplete even though the work happened. Reporting a step as missing
 * when only the order differed is the conservative error: the alternative,
 * searching backwards, would let one call complete two steps.
 *
 * @param steps - the plan's steps, in declared order.
 * @param slices - the turn's calls, in order.
 * @returns one window per step, index-aligned with `steps`; an unsatisfied step
 *   gets an empty window rather than the calls it failed to claim.
 */
export declare function segmentPlanWindows(steps: readonly PlanStep[], slices: readonly StepSlice[]): PlanWindow[];
/**
 * Score how much of the plan is done.
 *
 * Deliberately never cites `plan.goal`: the score is computed from the steps
 * alone, so a vague goal (`vagueGoal: true`) cannot make S4 absent or turn a
 * valid step judgement into a goal comparison. If a rationale is ever added
 * here, it must drop any goal quote when `plan.vagueGoal` is true.
 *
 * @param plan - the declared plan, or `undefined`.
 * @param windows - one window per step, in plan order.
 * @returns the S4 score in the shape the aggregator expects, plus the verdicts.
 */
export declare function scorePlanMatch(plan: DeclaredPlan | undefined, windows: readonly PlanWindow[]): {
    score: SignalScore;
    verdicts: StepVerdict[];
};
