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

import type { DriftSignal, JudgmentRecord } from '../data/types.js'

/** Samples a rule needs before its rate means anything. */
export const MIN_RULE_SAMPLES = 10

/** Rejection rate above which a rule is reported as noisy. */
export const NOISY_RULE_THRESHOLD = 0.5

/** What one rule looks like from the log's point of view. */
export interface RuleHealth {
  readonly signalType: string
  /** Candidates this rule produced. */
  readonly candidates: number
  /** Candidates a model confirmed. */
  readonly confirmed: number
  /** Candidates a model rejected. */
  readonly dismissed: number
  /** Candidates still waiting for a second opinion. */
  readonly pending: number
  /** `dismissed / (confirmed + dismissed)`, or null before anything is settled. */
  readonly falsePositiveRate: number | null
  readonly verdict: 'healthy' | 'noisy' | 'insufficient'
  /**
   * Rejections counted by the reason the model gave, most frequent first.
   *
   * A bare rejection rate says a rule is wrong; this says *how* it is wrong.
   * "Rejected because the activity matched no goal" and "rejected because it hit
   * an exclusion rule" call for opposite fixes — the first needs the goal tree to
   * state what counts, the second needs the exclusion list corrected. Empty on
   * records written before the field existed.
   */
  readonly byWhy: { why: string; count: number }[]
}

/**
 * Aggregate the judgement log by rule.
 *
 * @param records - every judgement record for one project.
 * @returns one row per rule, noisiest first.
 */
export function assessRules(records: readonly JudgmentRecord[]): RuleHealth[] {
  const byType = new Map<
    string,
    { confirmed: number; dismissed: number; pending: number; why: Map<string, number> }
  >()

  for (const record of records) {
    const bucket = byType.get(record.signalType) ?? {
      confirmed: 0,
      dismissed: 0,
      pending: 0,
      why: new Map<string, number>(),
    }
    if (record.status === 'confirmed') bucket.confirmed += 1
    else if (record.status === 'dismissed') {
      bucket.dismissed += 1
      // Only rejections carry a "why": a confirmation means the rule was right,
      // and its reason describes the drift rather than a defect in the rule.
      if (record.modelWhy !== undefined) {
        bucket.why.set(record.modelWhy, (bucket.why.get(record.modelWhy) ?? 0) + 1)
      }
    } else bucket.pending += 1
    byType.set(record.signalType, bucket)
  }

  const rows: RuleHealth[] = []
  for (const [signalType, bucket] of byType) {
    const settled = bucket.confirmed + bucket.dismissed
    const rate = settled === 0 ? null : bucket.dismissed / settled
    rows.push({
      signalType,
      candidates: settled + bucket.pending,
      confirmed: bucket.confirmed,
      dismissed: bucket.dismissed,
      pending: bucket.pending,
      falsePositiveRate: rate,
      verdict:
        settled < MIN_RULE_SAMPLES
          ? 'insufficient'
          : rate !== null && rate > NOISY_RULE_THRESHOLD
            ? 'noisy'
            : 'healthy',
      byWhy: [...bucket.why.entries()]
        .map(([why, count]) => ({ why, count }))
        .sort((left, right) => right.count - left.count),
    })
  }

  return rows.sort((left, right) => {
    const leftRate = left.falsePositiveRate ?? -1
    const rightRate = right.falsePositiveRate ?? -1
    if (leftRate !== rightRate) return rightRate - leftRate
    return right.candidates - left.candidates
  })
}

/** How much of one rule's output was reviewed, and how much never was. */
export interface RuleCoverage {
  readonly signalType: string
  /** Signals published after a model review. */
  readonly reviewed: number
  /** Signals published directly by a high-precision rule. */
  readonly bypassed: number
  /**
   * Bypassed signals that never received a review sample.
   *
   * This is the blind spot's size: the rule's conclusions are in the stream and
   * no model ever looked at them, so `assessRules` cannot say whether the rule
   * is right.
   */
  readonly unreviewedBypass: number
  /** True when bypassed signals outnumber reviewed ones. */
  readonly underrepresented: boolean
}

/**
 * Identity shared by a signal and the draft a judgement was made from.
 *
 * Judgement records carry the draft, not the signal id (the signal does not
 * exist yet when the candidate is queued), so this is the only join available.
 * Missing pieces yield `undefined`, which never matches.
 */
function coverageKey(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as {
    signalType?: unknown
    observedAt?: unknown
    activityIds?: unknown
  }
  if (typeof candidate.signalType !== 'string' || typeof candidate.observedAt !== 'string') {
    return undefined
  }
  const activityIds = Array.isArray(candidate.activityIds)
    ? candidate.activityIds.filter((id): id is string => typeof id === 'string')
    : []
  return `${candidate.signalType}::${candidate.observedAt}::${activityIds.join(',')}`
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
export function assessRuleCoverage(
  signals: readonly DriftSignal[],
  judgments: readonly JudgmentRecord[],
): RuleCoverage[] {
  const judgedKeys = new Set<string>()
  for (const record of judgments) {
    const key = coverageKey(record.draft)
    if (key !== undefined) judgedKeys.add(key)
  }

  const byType = new Map<string, { reviewed: number; bypassed: number }>()
  for (const signal of signals) {
    const bucket = byType.get(signal.signalType) ?? { reviewed: 0, bypassed: 0 }
    if (signal.reviewedBy === 'bypass') {
      bucket.bypassed += 1
    } else {
      const key = coverageKey(signal)
      if (key !== undefined && judgedKeys.has(key)) bucket.reviewed += 1
    }
    byType.set(signal.signalType, bucket)
  }

  const sampled = new Map<string, number>()
  for (const record of judgments) {
    if (record.sampled !== true) continue
    sampled.set(record.signalType, (sampled.get(record.signalType) ?? 0) + 1)
  }

  const rows: RuleCoverage[] = []
  for (const [signalType, bucket] of byType) {
    const unreviewedBypass = Math.max(0, bucket.bypassed - (sampled.get(signalType) ?? 0))
    rows.push({
      signalType,
      reviewed: bucket.reviewed,
      bypassed: bucket.bypassed,
      unreviewedBypass,
      underrepresented: bucket.bypassed > bucket.reviewed,
    })
  }
  return rows.sort(
    (left, right) =>
      right.unreviewedBypass - left.unreviewedBypass || right.bypassed - left.bypassed,
  )
}
