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
import { type DeclaredPlan, type EmaConfig, type ResponseThresholds, type SignalState, type SignalScore, type StepAggregate } from '../data/signals.js';
import { type ActionClass } from './signals/index.js';
import { type StepVerdict } from './signals/plan.js';
import type { CollectedActivity } from '../collect.js';
/** One step's decision, kept for the report and for debugging. */
export interface ScoredStep {
    /** 1-based position of this step within the turn. */
    index: number;
    /** Tools called in this step. */
    tools: string[];
    /** The signal scores that fed this step. */
    signals: SignalScore[];
    /** The aggregate for this step. */
    aggregate: StepAggregate;
    /** `final` after this step. */
    final: number;
    /** Level decided for this step. */
    level: 0 | 1 | 2 | 3;
}
/** The result of scoring one turn. */
export interface TurnScore {
    /** One entry per tool call in the turn. */
    steps: ScoredStep[];
    /** State after the whole turn. */
    state: SignalState;
    /** The highest level any step in this turn reached. */
    peakLevel: 0 | 1 | 2 | 3;
    /** The step that reached `peakLevel`, when any did. */
    peakStep?: ScoredStep;
    /** Per-step verdicts for the declared plan, when there was one. */
    planVerdicts?: StepVerdict[];
}
export declare function scoreTurn(activity: CollectedActivity, projectId: string, plan: DeclaredPlan | undefined, previous: SignalState | undefined, classHistory: readonly ActionClass[], ema: EmaConfig, thresholds: ResponseThresholds, now: Date): TurnScore;
