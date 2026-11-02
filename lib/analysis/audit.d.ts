/**
 * Stratified audit: the mechanism that can produce the samples calibration needs.
 *
 * The feedback channels are dry. Measured on the real project: 406 judgements, 249
 * rejected, 0 confirmed. One class only, so `fitCalibration` refuses — correctly,
 * because a curve fitted to one class maps everything to one answer and looks like
 * a result.
 *
 * The way out is not a better algorithm, it is *sampling*: look at a slice of the
 * stream that the rules did not flag, and label it by hand. That produces the
 * missing class. The design doc records the shape (low risk 2%, medium 15%, high
 * 100%) and this module implements exactly that, plus the inverse-probability
 * weight each sampled record needs so the sampled set can be read as a picture of
 * the whole.
 *
 * The weighting is the part that is easy to get wrong and hard to notice: if the
 * high-risk stratum is sampled at 100% and the low at 2%, the raw sample is
 * overwhelmingly high-risk and any rate computed from it is wrong by construction.
 * `inclusionProbability` is what corrects that, and it is stored per record rather
 * than recomputed later, because the strata may change.
 *
 * @module dsh-metacog/analysis/audit
 */
import type { JudgmentRecord } from '../data/types.js';
/** One sampling stratum and the share of its records to inspect. */
export interface AuditStratum {
    readonly name: 'low' | 'medium' | 'high';
    /** Lower bound of the score, inclusive. */
    readonly from: number;
    /** Upper bound of the score, exclusive, except for the top stratum. */
    readonly to: number;
    /** Share of this stratum to sample, 0–1. */
    readonly rate: number;
}
/**
 * The strata, as the design doc records them.
 *
 * Not configurable: the rates are a deliberate trade of inspection effort against
 * statistical power, and a deployment that lowered them would quietly stop being
 * able to calibrate while still looking like it was trying.
 */
export declare const AUDIT_STRATA: readonly AuditStratum[];
/** A record selected for inspection, with the weight it must carry. */
export interface AuditedRecord {
    readonly judgmentId: string;
    readonly stratum: AuditStratum['name'];
    readonly score: number;
    /** Share of the stratum that was sampled; `1 / rate` is the design weight. */
    readonly inclusionProbability: number;
    /** Design weight: how many records in the stratum this one stands for. */
    readonly weight: number;
}
/** Which stratum a score falls in, or `undefined` outside every band. */
export declare function stratumFor(score: number): AuditStratum | undefined;
/**
 * Select the records to inspect this round.
 *
 * Deterministic in the record id, not random: a re-run of the same period must
 * select the same records, or "this was audited" would be a different set each
 * time the report was generated and the denominator would drift.
 *
 * Only settled-or-pending judgements with a numeric score are candidates. A record
 * whose score cannot be read is skipped rather than guessed at, because a guessed
 * score would put it in a stratum nobody chose.
 *
 * @param records - judgements to consider.
 * @param alreadyAudited - ids already inspected, so a record is not sampled twice.
 */
export declare function selectAuditSample(records: readonly JudgmentRecord[], alreadyAudited?: ReadonlySet<string>): AuditedRecord[];
/**
 * Describe what the sampler is currently able to do.
 *
 * The report prints this instead of a rate when the sample is too small to mean
 * anything, so "0 of 3 audited" never reads as "0% drift".
 *
 * @param sample - records selected so far.
 * @param audited - how many of them have actually been labelled.
 */
export declare function describeAudit(sample: readonly AuditedRecord[], audited: number): string;
