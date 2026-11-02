/**
 * The three report sections that used to print "not enabled".
 *
 * Each one was a placeholder because the number behind it did not exist yet. Two
 * of them can now be computed from data already in the store, and the third — the
 * threshold derivation — genuinely cannot, so it keeps an honest refusal instead of
 * a fabricated figure.
 *
 * The distinction that matters: a section may say "not enough data", but it must
 * never say "not enabled" when the reason is "nothing happened this period". A
 * reader cannot tell those apart, and the second one is good news.
 *
 * @module dsh-metacog/analysis/sections
 */
import type { ActivityRecord, JudgmentRecord } from '../data/types.js';
/** One rejection reason and how often it was cited. */
export interface WhyCount {
    readonly why: string;
    readonly count: number;
    /** Share of the settled judgements, 0–1. */
    readonly share: number;
}
/**
 * Group the model's rejection reasons.
 *
 * Only settled judgements with a named reason are counted. A pending record has no
 * verdict, and a record with a free-text reason but no `modelWhy` predates the
 * field — counting either as a category would invent a bucket.
 *
 * @param judgments - every judgement, settled or not.
 * @returns per-reason counts, most frequent first, plus the denominator.
 */
export declare function undecidableReasons(judgments: readonly JudgmentRecord[]): {
    rows: readonly WhyCount[];
    settled: number;
    unlabelled: number;
};
/**
 * How much of the period's activity was actually inspected by the model.
 *
 * This is the audit-coverage number the report used to leave blank. It is not
 * stratified sampling — that is a separate mechanism — but it is the honest
 * denominator: "of the N activities recorded, M were reviewed, K were not".
 *
 * @param activities - the period's activities.
 * @param judgments - judgements created in the same period.
 */
export declare function auditCoverage(activities: readonly ActivityRecord[], judgments: readonly JudgmentRecord[]): {
    recorded: number;
    reviewed: number;
    share: number;
    undecided: number;
    sampled: number;
    sampleNote: string;
};
/**
 * Whether the thresholds in force were derived or guessed.
 *
 * They were guessed: the values are engineering estimates on an uncalibrated
 * score, and `fitCalibration` refuses to fit while only one class exists. This
 * function exists so the report can say *why* rather than leaving a blank, and so
 * the answer changes automatically once a calibration exists.
 *
 * @param calibrated - whether a calibration curve is in force.
 * @param samples - settled samples available to a fit.
 */
export declare function thresholdProvenance(calibrated: boolean, samples: number): {
    derived: boolean;
    note: string;
};
