/**
 * Milestone C: turning `riskScore` into a probability, or refusing to.
 *
 * The design doc is unambiguous that `riskScore` is *not* a probability: it is a
 * weighted average of signal scores that only guarantees an ordering. Every
 * threshold in the plugin (`thetaHintScore`, `thetaCardScore`) therefore lives on
 * that uncalibrated scale, and the names say so.
 *
 * This module is the thing that would let them stop being uncalibrated. It is
 * built around one rule that overrides every other consideration here:
 *
 * **Without both classes, there is no fit.** Platt scaling is a two-parameter
 * logistic regression on labels. Fitted on data where every label is "not drift"
 * it drives both parameters toward a degenerate solution that maps every input to
 * a probability near zero — and that fit would be reported as a real calibration
 * curve. The plugin's own history is exactly that shape: 249 dismissals and 0
 * confirmations when this was written. A number produced from that is not a worse
 * calibration than the current thresholds; it is a fabricated one.
 *
 * So the contract is: {@link fitCalibration} returns `insufficient` and the
 * caller keeps the uncalibrated thresholds. That is not a failure state to work
 * around — it is the honest answer, and the one that keeps the existing
 * guarantees intact.
 *
 * What *is* done here, and is useful today, is the measurement: the realised
 * confirmation rate per score bucket. That is descriptive, needs no fit, and
 * tells the user whether calibration would even be possible — which buckets have
 * any positives at all.
 *
 * @module dsh-metacog/analysis/calibrate
 */
import type { JudgmentRecord } from '../data/types.js';
/**
 * Labels needed before a fit is attempted.
 *
 * The number is not arbitrary: Platt scaling estimates two parameters, and with
 * fewer than ~30 labels a single outlier moves the curve more than the signal
 * does. The design doc's own试点 target was 100 hand-labelled activities; 30 is
 * the floor below which `fitCalibration` refuses rather than the goal.
 */
export declare const MIN_CALIBRATION_SAMPLES = 30;
/**
 * Minimum positives (and negatives) required.
 *
 * Separate from the total: 200 dismissals and 2 confirmations clears the total
 * but cannot identify a slope. Both classes need enough mass for the fit to be
 * about the score rather than about the two lucky points.
 */
export declare const MIN_PER_CLASS = 10;
/** One labelled point: the score the program produced and the label it earned. */
export interface CalibrationSample {
    readonly score: number;
    /** `true` when a second opinion confirmed the drift. */
    readonly positive: boolean;
    readonly at: string;
}
/** Why a fit was refused, or `null` when one was produced. */
export type CalibrationRefusal = 'not-enough-samples' | 'single-class' | 'not-enough-positives' | 'not-enough-negatives';
/** The fitted logistic map `p = sigmoid(a * score + b)`. */
export interface CalibrationFit {
    readonly status: 'fitted';
    readonly a: number;
    readonly b: number;
    readonly samples: number;
    readonly positives: number;
    readonly negatives: number;
    /** Mean |predicted − observed| over the samples, for judging the fit. */
    readonly meanAbsoluteError: number;
}
/** The refusal case: says exactly why, and carries the counts that decided it. */
export interface CalibrationUnavailable {
    readonly status: 'insufficient';
    readonly reason: CalibrationRefusal;
    readonly samples: number;
    readonly positives: number;
    readonly negatives: number;
    /** What would have to change to make a fit possible. */
    readonly needs: string;
}
export type CalibrationOutcome = CalibrationFit | CalibrationUnavailable;
/**
 * Extract labelled samples from the judgement log.
 *
 * Only *settled* records contribute. A pending record has no second opinion, and
 * reading "pending" as a negative is the single easiest way to manufacture a
 * fake calibration: the log would look like 100% rejection simply because most
 * records have not been reviewed yet.
 *
 * The score is whatever the record carries. Historically `JudgmentRecord` has no
 * numeric score field — the program's statement lives in `programReason` — so
 * records without one are skipped rather than assigned a guess. This is why the
 * sample count is usually far below the record count, and why the result reports
 * it rather than papering over it.
 *
 * @param records - the project's judgement records.
 * @returns labelled samples, oldest first.
 */
export declare function extractCalibrationSamples(records: readonly JudgmentRecord[]): CalibrationSample[];
/**
 * Fit a logistic map from score to probability, or explain why not.
 *
 * Fitted by Newton's method on the log-likelihood, with a small L2 penalty so a
 * separable sample set produces a large-but-finite slope instead of infinity.
 * The penalty is deliberately weak (1e-3): it exists to keep the fit numerically
 * defined, not to regularise away a real effect.
 *
 * @param samples - labelled points from {@link extractCalibrationSamples}.
 * @returns the fit, or a refusal naming the specific shortfall.
 */
export declare function fitCalibration(samples: readonly CalibrationSample[]): CalibrationOutcome;
/** One score bucket's realised confirmation rate. */
export interface ReliabilityBucket {
    /** Inclusive lower bound of the bucket. */
    readonly from: number;
    /** Exclusive upper bound. */
    readonly to: number;
    readonly total: number;
    readonly positives: number;
    /** `positives / total`, or `null` for an empty bucket. */
    readonly rate: number | null;
}
/**
 * The reliability table: realised rate per score bucket.
 *
 * This is the descriptive half of calibration, and it needs no fit. It is worth
 * reporting even when a fit is refused, because it answers the question the
 * refusal raises — "how far from calibratable are we" — and shows which score
 * ranges have any positive evidence at all.
 *
 * Empty buckets keep `rate: null` rather than 0: a bucket with no samples has no
 * rate, and printing 0.00 there would read as "this rule never fires correctly".
 *
 * @param samples - labelled points.
 * @param bucketCount - how many equal-width buckets to use.
 */
export declare function reliabilityTable(samples: readonly CalibrationSample[], bucketCount?: number): ReliabilityBucket[];
/**
 * One line a report can print, whatever the outcome.
 *
 * Reports carried a hardcoded "本期未启用" placeholder for calibration. With this
 * module there is now something true to say in three different situations, and
 * the placeholder became a lie the moment the measurement existed.
 *
 * @param outcome - result of {@link fitCalibration}.
 * @param samples - the samples it was fitted on.
 */
export declare function describeCalibration(outcome: CalibrationOutcome, samples: readonly CalibrationSample[]): string;
