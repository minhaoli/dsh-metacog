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
import type { JudgmentRecord } from '../data/types.js'

/** One sampling stratum and the share of its records to inspect. */
export interface AuditStratum {
  readonly name: 'low' | 'medium' | 'high'
  /** Lower bound of the score, inclusive. */
  readonly from: number
  /** Upper bound of the score, exclusive, except for the top stratum. */
  readonly to: number
  /** Share of this stratum to sample, 0–1. */
  readonly rate: number
}

/**
 * The strata, as the design doc records them.
 *
 * Not configurable: the rates are a deliberate trade of inspection effort against
 * statistical power, and a deployment that lowered them would quietly stop being
 * able to calibrate while still looking like it was trying.
 */
export const AUDIT_STRATA: readonly AuditStratum[] = [
  { name: 'low', from: 0, to: 0.5, rate: 0.02 },
  { name: 'medium', from: 0.5, to: 0.875, rate: 0.15 },
  { name: 'high', from: 0.875, to: 1, rate: 1 },
]

/** A record selected for inspection, with the weight it must carry. */
export interface AuditedRecord {
  readonly judgmentId: string
  readonly stratum: AuditStratum['name']
  readonly score: number
  /** Share of the stratum that was sampled; `1 / rate` is the design weight. */
  readonly inclusionProbability: number
  /** Design weight: how many records in the stratum this one stands for. */
  readonly weight: number
}

/** Which stratum a score falls in, or `undefined` outside every band. */
export function stratumFor(score: number): AuditStratum | undefined {
  // A score outside [0,1] belongs to no stratum. Without this guard the top band's
  // inclusive upper bound would also swallow 1.5, and an out-of-range value would
  // be audited at 100% as if it were maximally risky.
  if (!Number.isFinite(score) || score < 0 || score > 1) return undefined
  // The top stratum is inclusive of its upper bound; the others are half-open, so
  // a score of exactly 0.5 belongs to `medium` and not to both.
  return AUDIT_STRATA.find(
    (stratum) => score >= stratum.from && (score < stratum.to || stratum.to === 1),
  )
}

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
export function selectAuditSample(
  records: readonly JudgmentRecord[],
  alreadyAudited: ReadonlySet<string> = new Set(),
): AuditedRecord[] {
  const out: AuditedRecord[] = []
  for (const record of records) {
    if (alreadyAudited.has(record.id)) continue
    const score = scoreOf(record)
    if (score === undefined) continue
    const stratum = stratumFor(score)
    if (stratum === undefined) continue
    // A deterministic hash of the id, spread over [0,1), compared against the
    // stratum's rate. Same id and same stratum always give the same verdict.
    const bucket = hashToUnit(record.id)
    if (bucket >= stratum.rate) continue
    out.push({
      judgmentId: record.id,
      stratum: stratum.name,
      score,
      inclusionProbability: stratum.rate,
      // Rounded to three decimals: the weight is a design quantity, and printing
      // 33.333333333333336 in a report implies a precision it does not have.
      weight: Math.round((1 / stratum.rate) * 1000) / 1000,
    })
  }
  return out
}

/**
 * The score a judgement was made on.
 *
 * Read from the drafted signal rather than recomputed: the draft is what the model
 * actually saw, and a recomputed score could differ from it after a config change.
 *
 * @param record - one judgement.
 */
function scoreOf(record: JudgmentRecord): number | undefined {
  const draft = record.draft
  if (draft === null || typeof draft !== 'object') return undefined
  const score = (draft as { score?: unknown }).score
  return typeof score === 'number' && Number.isFinite(score) ? score : undefined
}

/** A stable value in [0,1) derived from a string, by FNV-1a. */
function hashToUnit(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    // The multiply has to stay in 32 bits; `Math.imul` is the only way to do that
    // in JavaScript without losing the low bits to float precision.
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash / 0x100000000
}


/**
 * Describe what the sampler is currently able to do.
 *
 * The report prints this instead of a rate when the sample is too small to mean
 * anything, so "0 of 3 audited" never reads as "0% drift".
 *
 * @param sample - records selected so far.
 * @param audited - how many of them have actually been labelled.
 */
export function describeAudit(
  sample: readonly AuditedRecord[],
  audited: number,
): string {
  if (sample.length === 0) {
    return '本期没有抽到需要审计的记录'
  }
  if (audited === 0) {
    return `已抽到 ${sample.length} 条待审计，还没有标注结果`
  }
  const byStratum = new Map<string, number>()
  for (const record of sample) byStratum.set(record.stratum, (byStratum.get(record.stratum) ?? 0) + 1)
  const parts = [...byStratum.entries()].sort().map(([name, count]) => `${name} ${count}`)
  return `抽到 ${sample.length} 条（${parts.join('、')}），已标注 ${audited} 条`
}
