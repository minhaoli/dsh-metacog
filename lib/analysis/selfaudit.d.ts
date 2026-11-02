/**
 * Function F: how well do the rules actually judge?
 *
 * Every drift candidate is logged with two verdicts — the program's and a model's
 * — so the log is a labelled dataset the plugin produces for free. This module
 * turns it into one number per rule: of everything the rule called drift, how much
 * did a second opinion reject?
 *
 * That number is the only honest answer to "is the monitor getting better". Without
 * it, tuning a threshold is a guess and a noisy rule keeps costing the user's trust
 * without anyone noticing.
 *
 * Nothing here is a decision. A rule is reported as noisy; it is not silently
 * switched off, because a rule that looks bad on ten samples may be right on the
 * next hundred.
 *
 * @module dsh-metacog/analysis/selfaudit
 */
import type { DriftSignal, JudgmentRecord } from '../data/types.js';
/** Samples a rule needs before its rate means anything. */
export declare const MIN_RULE_SAMPLES = 10;
/** Rejection rate above which a rule is reported as noisy. */
export declare const NOISY_RULE_THRESHOLD = 0.5;
/** What one rule looks like from the log's point of view. */
export interface RuleHealth {
    readonly signalType: string;
    /** Candidates this rule produced. */
    readonly candidates: number;
    /** Candidates a model confirmed. */
    readonly confirmed: number;
    /** Candidates a model rejected. */
    readonly dismissed: number;
    /** Candidates still waiting for a second opinion. */
    readonly pending: number;
    /** `dismissed / (confirmed + dismissed)`, or null before anything is settled. */
    readonly falsePositiveRate: number | null;
    readonly verdict: 'healthy' | 'noisy' | 'insufficient';
    /**
     * Rejections counted by the reason the model gave, most frequent first.
     *
     * A bare rejection rate says a rule is wrong; this says *how* it is wrong.
     * "Rejected because the activity matched no goal" and "rejected because it hit
     * an exclusion rule" call for opposite fixes — the first needs the goal tree to
     * state what counts, the second needs the exclusion list corrected. Empty on
     * records written before the field existed.
     */
    readonly byWhy: {
        why: string;
        count: number;
    }[];
}
/**
 * Aggregate the judgement log by rule.
 *
 * @param records - every judgement record for one project.
 * @returns one row per rule, noisiest first.
 */
export declare function assessRules(records: readonly JudgmentRecord[]): RuleHealth[];
/** How much of one rule's output was reviewed, and how much never was. */
export interface RuleCoverage {
    readonly signalType: string;
    /** Signals published after a model review. */
    readonly reviewed: number;
    /** Signals published directly by a high-precision rule. */
    readonly bypassed: number;
    /**
     * Bypassed signals that never received a review sample.
     *
     * This is the blind spot's size: the rule's conclusions are in the stream and
     * no model ever looked at them, so `assessRules` cannot say whether the rule
     * is right.
     */
    readonly unreviewedBypass: number;
    /** True when bypassed signals outnumber reviewed ones. */
    readonly underrepresented: boolean;
}
/**
 * Measure each rule's review coverage, not just its rejection rate.
 *
 * `assessRules` only sees candidates that went through the queue. A rule that
 * escalates directly never produces one, so its health row is built from
 * nothing while its conclusions keep reaching the user. This function makes
 * that gap countable.
 *
 * A signal counts as reviewed only when a judgement record can be matched to
 * it; the join is the draft's signal type, observation time and activity ids.
 * Legacy signals whose judgement predates the stored draft stay uncounted
 * rather than being assumed reviewed.
 *
 * @param signals - recorded signals for the project (or the report period).
 * @param judgments - judgement records, including sampled ones.
 * @returns one row per rule, largest blind spot first.
 */
export declare function assessRuleCoverage(signals: readonly DriftSignal[], judgments: readonly JudgmentRecord[]): RuleCoverage[];
