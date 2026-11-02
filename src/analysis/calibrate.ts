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
import type { JudgmentRecord } from '../data/types.js'

/**
 * Labels needed before a fit is attempted.
 *
 * The number is not arbitrary: Platt scaling estimates two parameters, and with
 * fewer than ~30 labels a single outlier moves the curve more than the signal
 * does. The design doc's own试点 target was 100 hand-labelled activities; 30 is
 * the floor below which `fitCalibration` refuses rather than the goal.
 */
export const MIN_CALIBRATION_SAMPLES = 30

/**
 * Minimum positives (and negatives) required.
 *
 * Separate from the total: 200 dismissals and 2 confirmations clears the total
 * but cannot identify a slope. Both classes need enough mass for the fit to be
 * about the score rather than about the two lucky points.
 */
export const MIN_PER_CLASS = 10

/** One labelled point: the score the program produced and the label it earned. */
export interface CalibrationSample {
  readonly score: number
  /** `true` when a second opinion confirmed the drift. */
  readonly positive: boolean
  readonly at: string
}

/** Why a fit was refused, or `null` when one was produced. */
export type CalibrationRefusal =
  | 'not-enough-samples'
  | 'single-class'
  | 'not-enough-positives'
  | 'not-enough-negatives'

/** The fitted logistic map `p = sigmoid(a * score + b)`. */
export interface CalibrationFit {
  readonly status: 'fitted'
  readonly a: number
  readonly b: number
  readonly samples: number
  readonly positives: number
  readonly negatives: number
  /** Mean |predicted − observed| over the samples, for judging the fit. */
  readonly meanAbsoluteError: number
}

/** The refusal case: says exactly why, and carries the counts that decided it. */
export interface CalibrationUnavailable {
  readonly status: 'insufficient'
  readonly reason: CalibrationRefusal
  readonly samples: number
  readonly positives: number
  readonly negatives: number
  /** What would have to change to make a fit possible. */
  readonly needs: string
}

export type CalibrationOutcome = CalibrationFit | CalibrationUnavailable

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
export function extractCalibrationSamples(records: readonly JudgmentRecord[]): CalibrationSample[] {
  const samples: CalibrationSample[] = []
  for (const record of records) {
    if (record.status === 'pending') continue
    const score = scoreOf(record)
    if (score === null) continue
    samples.push({
      score,
      positive: record.status === 'confirmed',
      at: record.createdAt,
    })
  }
  return samples.sort((left, right) => left.at.localeCompare(right.at))
}

/**
 * The program's score for a record, when one was stored.
 *
 * `draft` is where the signal as drafted is kept verbatim, so the score is read
 * from there when it is a number. Anything else yields `null`; inventing a score
 * from the record's position or timestamp would produce a calibration curve
 * about the log rather than about the judgement.
 */
function scoreOf(record: JudgmentRecord): number | null {
  const draft = record.draft
  if (draft === null || typeof draft !== 'object') return null
  const candidate = (draft as { score?: unknown }).score
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) return null
  if (candidate < 0 || candidate > 1) return null
  return candidate
}

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
export function fitCalibration(samples: readonly CalibrationSample[]): CalibrationOutcome {
  const positives = samples.filter((sample) => sample.positive).length
  const negatives = samples.length - positives

  if (samples.length < MIN_CALIBRATION_SAMPLES) {
    return {
      status: 'insufficient',
      reason: 'not-enough-samples',
      samples: samples.length,
      positives,
      negatives,
      needs: `至少 ${MIN_CALIBRATION_SAMPLES} 条已结算且有分数的样本，现有 ${samples.length} 条。`,
    }
  }
  if (positives === 0 || negatives === 0) {
    return {
      status: 'insufficient',
      reason: 'single-class',
      samples: samples.length,
      positives,
      negatives,
      needs:
        '需要正负两类都有样本。只有一类时，拟合会把所有分数映射到同一个值，' +
        '那不是校准结果，是把当前阈值换成了一条常数曲线。',
    }
  }
  if (positives < MIN_PER_CLASS) {
    return {
      status: 'insufficient',
      reason: 'not-enough-positives',
      samples: samples.length,
      positives,
      negatives,
      needs: `正类至少 ${MIN_PER_CLASS} 条，现有 ${positives} 条。`,
    }
  }
  if (negatives < MIN_PER_CLASS) {
    return {
      status: 'insufficient',
      reason: 'not-enough-negatives',
      samples: samples.length,
      positives,
      negatives,
      needs: `负类至少 ${MIN_PER_CLASS} 条，现有 ${negatives} 条。`,
    }
  }

  const lambda = 1e-3
  let a = 1
  let b = 0
  // Newton iterations on the penalised log-likelihood. Six is enough at this
  // scale: the objective is strictly concave in (a, b), so this converges or the
  // data is separable, in which case the penalty bounds the step anyway.
  for (let iteration = 0; iteration < 25; iteration += 1) {
    let gradA = 0
    let gradB = 0
    let hessAA = 0
    let hessBB = 0
    let hessAB = 0
    for (const sample of samples) {
      const p = sigmoid(a * sample.score + b)
      const y = sample.positive ? 1 : 0
      const residual = y - p
      const weight = p * (1 - p)
      gradA += residual * sample.score
      gradB += residual
      hessAA -= weight * sample.score * sample.score
      hessBB -= weight
      hessAB -= weight * sample.score
    }
    gradA -= lambda * a
    gradB -= lambda * b
    hessAA -= lambda
    hessBB -= lambda

    // 2×2 solve. A near-zero determinant means the scores carry no spread, in
    // which case there is nothing to fit and the refusal above should have fired.
    //
    // The Hessian here is negative definite (`hessAA`, `hessBB` are both negative
    // sums), so the Newton step is `-H⁻¹g`. For `H = [[AA, AB], [AB, BB]]` that
    // works out to `(AB·gB − BB·gA)/det` and `(AB·gA − AA·gB)/det`; dropping the
    // sign turns a concave maximisation into a divergent one, which is how an
    // earlier version produced slopes around 1e11.
    const determinant = hessAA * hessBB - hessAB * hessAB
    if (Math.abs(determinant) < 1e-12) break
    const stepA = (hessAB * gradB - hessBB * gradA) / determinant
    const stepB = (hessAB * gradA - hessAA * gradB) / determinant
    a += stepA
    b += stepB
    if (Math.abs(stepA) < 1e-8 && Math.abs(stepB) < 1e-8) break
  }

  const error =
    samples.reduce((sum, sample) => {
      const predicted = sigmoid(a * sample.score + b)
      const observed = sample.positive ? 1 : 0
      return sum + Math.abs(predicted - observed)
    }, 0) / samples.length

  return {
    status: 'fitted',
    a,
    b,
    samples: samples.length,
    positives,
    negatives,
    meanAbsoluteError: error,
  }
}

/** The logistic function, clamped so an extreme slope cannot return exactly 0 or 1. */
function sigmoid(x: number): number {
  const value = 1 / (1 + Math.exp(-x))
  return Math.min(1 - 1e-9, Math.max(1e-9, value))
}

/** One score bucket's realised confirmation rate. */
export interface ReliabilityBucket {
  /** Inclusive lower bound of the bucket. */
  readonly from: number
  /** Exclusive upper bound. */
  readonly to: number
  readonly total: number
  readonly positives: number
  /** `positives / total`, or `null` for an empty bucket. */
  readonly rate: number | null
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
export function reliabilityTable(
  samples: readonly CalibrationSample[],
  bucketCount = 5,
): ReliabilityBucket[] {
  const buckets: ReliabilityBucket[] = []
  for (let index = 0; index < bucketCount; index += 1) {
    const from = index / bucketCount
    const to = (index + 1) / bucketCount
    // The last bucket includes its upper bound so a score of exactly 1 lands
    // somewhere instead of falling off the table.
    const members = samples.filter((sample) =>
      index === bucketCount - 1
        ? sample.score >= from && sample.score <= to
        : sample.score >= from && sample.score < to,
    )
    const positives = members.filter((sample) => sample.positive).length
    buckets.push({
      from,
      to,
      total: members.length,
      positives,
      rate: members.length === 0 ? null : positives / members.length,
    })
  }
  return buckets
}

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
export function describeCalibration(
  outcome: CalibrationOutcome,
  samples: readonly CalibrationSample[],
): string {
  if (outcome.status === 'insufficient') {
    return (
      `校准：未启用。${outcome.needs}` +
      `（正类 ${outcome.positives} / 负类 ${outcome.negatives}，已结算且有分数 ${outcome.samples} 条）`
    )
  }
  const buckets = reliabilityTable(samples)
  const withData = buckets.filter((bucket) => bucket.total > 0)
  const table = withData
    .map((bucket) => `${bucket.from.toFixed(1)}–${bucket.to.toFixed(1)}: ${pct(bucket.rate)}`)
    .join('，')
  return (
    `校准：已拟合（${outcome.samples} 条样本，正 ${outcome.positives} / 负 ${outcome.negatives}，` +
    `平均偏差 ${(outcome.meanAbsoluteError * 100).toFixed(1)} 个百分点）。实际命中率 ${table}`
  )
}

/** Percent, or a dash for an empty bucket. */
function pct(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`
}
