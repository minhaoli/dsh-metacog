/**
 * The five signal implementations.
 *
 * Each one answers a single question about a step and returns a `SignalScore`:
 * a number in [0, 1], or an explicit reason it has none. None of them may return
 * zero to mean "I could not tell" — that is what the absence branch is for, and
 * collapsing the two turns a monitor that sees nothing into a monitor that sees
 * nothing wrong.
 *
 * What is deliberately *not* here: any combination or thresholding. Aggregation
 * lives in `data/signals.ts` and thresholds in config, so a signal can be tested,
 * swapped or turned off without touching the decision rule.
 *
 * @module dsh-metacog/analysis/signals
 */
import type { CollectedActivity, CollectedToolResult } from '../../collect.js';
import { type DeclaredPlan, type SignalScore } from '../../data/signals.js';
/**
 * One step's raw material: the tools a turn called, in order, and their results.
 *
 * A step is one tool call (see the design doc, 2.2). The collector produces turn
 * level activities, so the signal layer replays each turn into one step per tool
 * call. `toolNames` may be empty when a record predates the field, which is why
 * the signals distinguish "no tools" from "not recorded".
 */
export interface StepTrace {
    /** Tools called in this step, in order. */
    tools: readonly string[];
    /** Results seen in this step. */
    results: readonly CollectedToolResult[];
    /**
     * File paths this step's call named.
     *
     * Carried per step rather than per turn because S4 judges a plan step against
     * a slice of the turn: a `pathGlob` expectation is about the call that touched
     * the file, not about everything the turn happened to open.
     */
    paths: readonly string[];
}
/**
 * Split a turn activity into one trace per tool call.
 *
 * The turn's results are attached to the last step rather than distributed: the
 * host does not tag a result with the call that produced it in every adapter, and
 * guessing the pairing would attribute a passing test run to whichever command
 * happened to precede it. Attaching them to the final step is the conservative
 * choice — it can only understate an earlier step's progress, never overstate it.
 *
 * @param activity - collected turn activity.
 * @returns one trace per tool call; a single empty trace when none were recorded.
 */
export declare function tracesFromActivity(activity: CollectedActivity): StepTrace[];
/**
 * S3: did this step use a tool the session did not declare?
 *
 * The only signal with an external reference point, and the reference is a
 * caution rather than an endorsement: Ring 12's tight-scope row reaches 0.843 F1
 * by declaring a narrow manifest, at the cost of 0 out of 60 benign controls
 * surviving. So this is a high-recall, low-precision filter — it will flag
 * ordinary work, and the aggregation is what keeps that from becoming an alarm.
 *
 * Binary by construction. A "how far outside the whitelist" gradient would be
 * invented precision: the benchmark only ever measured in-or-out.
 *
 * The binary outcome is deliberate but the *wording* is not: the rationale ends
 * up in the prompt block, where "越界工具：x" reads as a verdict and invites the
 * model to defend itself. It is rewritten as a statement plus the action that
 * resolves it, because a tool outside the declaration is usually a new
 * requirement rather than a violation.
 *
 * The tool set is `planAllowedTools`, not `plan.allowedTools`: a session that
 * declared only structured steps has already said which tools it expects to
 * call, and demanding a second copy of that list was the main reason plans went
 * undeclared.
 *
 * @param trace - this step's tools.
 * @param plan - the session's declared plan, when there is one.
 * @returns the score, or an explicit absence.
 */
export declare function scoreToolNovelty(trace: StepTrace, plan: DeclaredPlan | undefined): SignalScore;
/**
 * Coarse action classes.
 *
 * Deliberately small. A finer taxonomy would need a per-tool table that drifts
 * out of date every time the host adds a tool, and S2 only needs enough
 * resolution to notice "this session stopped writing and started reading".
 */
export declare const ACTION_CLASSES: readonly ["READ", "WRITE", "COMPUTE", "NETWORK", "COMMUNICATE", "SYSTEM"];
export type ActionClass = (typeof ACTION_CLASSES)[number];
/**
 * Map a tool name to an action class.
 *
 * Unknown tools map to `SYSTEM` rather than throwing: a new host tool is not an
 * error, and dropping it would silently shrink the distribution that S2 measures.
 *
 * @param toolName - tool to classify.
 * @returns its class.
 */
export declare function classifyTool(toolName: string): ActionClass;
/**
 * S2: has the mix of action classes drifted from the session's baseline?
 *
 * Measured as `1 - Jaccard(current classes, baseline classes)`. Jaccard on the
 * *set* of classes rather than a distance between frequency vectors, because the
 * set version needs far fewer observations to be meaningful: a session that
 * normally writes and today only reads has a class-set change immediately, while
 * a frequency comparison would need dozens of steps before the difference
 * cleared its own noise.
 *
 * The baseline is the first `BASELINE_STEPS` steps of the session — the shape it
 * settled into before any drift could have started. Fewer than
 * `MIN_HISTORY_STEPS` and this reports absence rather than comparing a step
 * against itself.
 *
 * @param history - classes observed so far in this session, oldest first.
 * @returns the score, or an explicit absence.
 */
export declare function scoreClassDrift(history: readonly ActionClass[]): SignalScore;
/** Steps used to establish what a session normally does. */
export declare const BASELINE_STEPS = 5;
/** Steps compared against that baseline. */
export declare const RECENT_STEPS = 5;
/** Below this, S2 has no baseline worth comparing against. */
export declare const MIN_HISTORY_STEPS = 6;
/**
 * S5: did this step verifiably change anything?
 *
 * Self-invented, with no benchmark backing at all — the benchmark's `s5_paraphrase`
 * is a different signal (paraphrase stability), and no amount of citation makes
 * it support this one.
 *
 * "Verifiably changed" is narrow on purpose: a file was written, a test went from
 * failing to passing, a build started succeeding. Merely calling a tool is not
 * progress — that is exactly the failure mode this detects ("lots of activity,
 * nothing changed").
 *
 * @param traces - this turn's steps, oldest first.
 * @returns the score, or an explicit absence.
 */
export declare function scoreProgress(traces: readonly StepTrace[]): SignalScore;
