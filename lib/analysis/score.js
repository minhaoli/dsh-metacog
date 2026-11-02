/**
 * Score one collected turn through the v4 pipeline.
 *
 * This is the seam between the collector and the decision rule. It takes a turn's
 * trace, computes every signal that can be computed, replays the turn into steps,
 * advances the persisted EMA and returns the levels.
 *
 * The order matters and is not obvious, so it is stated here: a turn is not a
 * step. The collector emits one activity per turn, but the EMA advances once per
 * *tool call*, so a turn with four calls moves the smoothed score four times.
 * Aggregating per turn instead would make the score depend on how a session
 * happened to batch its work into messages, which is not a property of the work.
 *
 * @module dsh-metacog/analysis/score
 */
import { aggregateStep, advanceSignalState, decideLevelFromState, } from '../data/signals.js';
import { classifyTool, scoreClassDrift, scoreProgress, scoreToolNovelty, tracesFromActivity } from './signals/index.js';
import { scorePlanMatch, segmentPlanWindows } from './signals/plan.js';
import { scoreAlternatingLoop, scoreErrorStreak, scoreMonologue, scoreRepeatRate, } from './signals/behaviour.js';
/**
 * Score one collected turn.
 *
 * @param activity - the turn as collected.
 * @param projectId - owning project, which owns the persisted state.
 * @param plan - the plan in force, when one was declared.
 * @param previous - persisted state before this turn.
 * @param classHistory - action classes observed so far this session, oldest first.
 * @param ema - EMA parameters.
 * @param thresholds - response thresholds.
 * @param now - clock injection for tests.
 * @returns the scores, per-step decisions and the state after the turn.
 */
/**
 * Compute the model-behaviour signals for one turn.
 *
 * These read the turn's own tool sequence — repeats, failing retries, alternation,
 * narration without action — and answer "is the assistant stuck", not "does this
 * work serve the goal". They are reported on a separate dimension for that reason.
 *
 * A signal that fires becomes an `available` score; one that does not stays absent
 * rather than scoring zero, because "no loop detected" and "no evidence either
 * way" are different facts and the coverage floor depends on the difference.
 *
 * @param activity - the collected turn.
 */
function behaviourScoresFor(activity) {
    const results = activity.toolResults ?? [];
    const steps = results.map((result) => ({
        name: result.tool,
        // The digest captured when the call was seen. An empty one cannot match
        // another empty one: absent signatures would otherwise make every call look
        // identical and report a loop on data that was never recorded.
        signature: result.signature,
        failed: result.ok === null ? null : result.ok === false,
    }));
    const out = [];
    const push = (signal, finding) => {
        if (finding === undefined)
            return;
        out.push({ status: 'available', signal, score: finding.score, evidence: [...finding.evidence] });
    };
    push('b_repeat', scoreRepeatRate(steps));
    push('b_error_streak', scoreErrorStreak(steps));
    push('b_alternating', scoreAlternatingLoop(steps));
    // A turn with no tool call at all is a monologue unless it reported a completion.
    const hadToolCall = (activity.toolNames ?? []).length > 0;
    const claimedCompletion = /(done|complete|finished|完成|搞定)/i.test(activity.summary ?? '');
    push('b_monologue', scoreMonologue(hadToolCall, claimedCompletion));
    return out;
}
export function scoreTurn(activity, projectId, plan, previous, classHistory, ema, thresholds, now) {
    const traces = tracesFromActivity(activity);
    // S5 is computed for the turn as a whole: "did anything change in this turn"
    // is not a per-call question, and slicing it per call would make a turn that
    // edited one file in ten calls look like nine failures.
    const progressScore = scoreProgress(traces);
    // S2 is computed from the history *plus* this turn, so the newest classes are
    // included in what it compares. Feeding it the pre-turn history would make every
    // reading one turn stale.
    const turnClasses = traces.flatMap((t) => t.tools.map(classifyTool));
    const classScore = scoreClassDrift([...classHistory, ...turnClasses]);
    // S4 compares the plan against the turn, but not by handing every step the
    // whole turn. The collector records a flat sequence of calls and does not tag
    // them with the step they belong to, so the finest honest attribution is a
    // contiguous slice: `segmentPlanWindows` walks the steps in order and gives
    // each the shortest run of calls that satisfies it, starting where the previous
    // satisfied step ended. A step nobody satisfied leaves the cursor where it was,
    // which is what lets a later step still be recognised — and what makes a
    // skipped step visible at all.
    //
    // `paths` are real now: the collector captures each call's file-path arguments
    // alongside the tool name, so a `pathGlob` expectation is evaluated against the
    // calls that actually named a file rather than failing for lack of data.
    const planWindows = segmentPlanWindows(plan?.steps ?? [], traces);
    const planScore = scorePlanMatch(plan, planWindows);
    let state = previous;
    const steps = [];
    let peakLevel = 0;
    let peakStep;
    traces.forEach((trace, index) => {
        // S3 is the only genuinely per-call signal: "was THIS tool declared".
        const novelty = scoreToolNovelty(trace, plan);
        // S2, S4 and S5 describe the turn, so their value is applied to each step it
        // contains rather than being diluted across them. The alternative — dividing
        // a turn-level score by the step count — would make a long honest turn look
        // calmer than a short one doing the same thing.
        const behaviour = behaviourScoresFor(activity);
        const scores = [novelty, classScore, planScore.score, progressScore, ...behaviour];
        const aggregate = aggregateStep(scores);
        state = advanceSignalState(state, projectId, aggregate, ema, thresholds, now);
        const level = decideLevelFromState(state, thresholds);
        const step = { index: index + 1, tools: [...trace.tools], signals: scores, aggregate, final: state.final, level };
        steps.push(step);
        if (level > peakLevel) {
            peakLevel = level;
            peakStep = step;
        }
    });
    const finalState = state ?? {
        projectId,
        final: ema.initial,
        consecutiveHigh: 0,
        stepsSeen: 0,
        updatedAt: now.toISOString(),
    };
    return {
        steps,
        state: finalState,
        peakLevel,
        ...(peakStep === undefined ? {} : { peakStep }),
        ...(planScore.verdicts.length === 0 ? {} : { planVerdicts: planScore.verdicts }),
    };
}
