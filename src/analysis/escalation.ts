/**
 * The Level 0–3 escalation state machine.
 *
 * Every threshold decision lives here, and every one of them is taken from
 * configuration rather than hard-coded at a call site, so an operator can retune
 * the monitor without touching code. The rules, in order:
 *
 * - Level 0: recorded silently. Everything that is not escalated stops here.
 * - Level 1: one in-context hint, no answer required. Triggered by a single
 *   high-confidence drift, or by a blocking contradiction that has not eased.
 * - Level 2: a pending intervention card. Needs `repeatThreshold` same-class
 *   high-confidence signals inside the window, and no open pending card for
 *   that class.
 * - Level 3: a gate. Needs a `core_bypass` that has itself repeated to the
 *   threshold, with the contradiction's observed intensity at or above 4, and
 *   no open pending card.
 *
 * The "no open pending card" precondition is what makes the ladder idempotent:
 * once a card is open, further signals of the same class are recorded at Level 1
 * instead of opening a second card, so a long drift produces one decision, not a
 * stack of them.
 *
 * @module dsh-metacog/analysis/escalation
 */
import type {
  DriftSignal,
  DriftSignalType,
  InterventionRecord,
  ResponseLevel,
} from '../data/types.js'
import type { MetacogConfig } from '../config.js'
import { signalClassKey } from './drift.js'

/** One escalation decision for one draft signal. */
export interface EscalationDecision {
  /** Level to record on the signal. */
  level: ResponseLevel
  /** Whether this decision opens a new intervention record. */
  openIntervention: boolean
  /** Same-class signals counted inside the window, including this one. */
  repeatCount: number
  /** Number of interventions already pending for this class, before deciding. */
  pendingForClass: number
  /**
   * One or two Chinese lines telling the user what happened and what to do.
   *
   * The prompt block reads this, never `rationale`: the latter names thresholds
   * and signal classes for the audit trail and reads as an accusation when shown
   * to a person.
   */
  hint: string
  /** One-sentence justification, quoting the thresholds that fired. */
  rationale: string
}

/** Everything the machine reads. */
export interface EscalationContext {
  /** The draft's signal class. */
  signalType: DriftSignalType
  relatedContradictionIds: readonly string[]
  relatedGoalIds: readonly string[]
  /** Confidence of the incoming signal. */
  confidence: number
  /** Highest observed intensity of its contradiction, when it has one. */
  intensity: number
  /** Whether the activity that produced it may escalate at all (grade gate). */
  mayEscalate: boolean
  /** Already-recorded signals, any age. */
  signals: readonly DriftSignal[]
  /** Current intervention records, deduplicated to newest per id. */
  interventions: readonly InterventionRecord[]
  config: MetacogConfig
  now: Date
}

/** Intensity at which a core bypass becomes a Level 3 gate (spec 4.4 item 4). */
export const LEVEL3_MIN_INTENSITY = 4

/**
 * Decide the response level for one draft signal.
 *
 * @param context - the draft plus the project's recorded history.
 * @returns the level, whether to open an intervention, and why.
 */
export function decideEscalation(context: EscalationContext): EscalationDecision {
  const { config, now } = context
  const key = signalClassKey(
    context.signalType,
    context.relatedContradictionIds,
    context.relatedGoalIds,
  )
  const windowStart = now.getTime() - config.thresholds.windowMinutes * 60_000

  const sameClassInWindow = context.signals.filter(
    (signal) =>
      signalClassKey(signal.signalType, signal.relatedContradictionIds, signal.relatedGoalIds) ===
        key &&
      Date.parse(signal.observedAt) >= windowStart &&
      signal.confidence >= config.thresholds.minConfidence,
  )
  const repeatCount = sameClassInWindow.length + 1

  const pendingForClass = context.interventions.filter(
    (record) =>
      record.status === 'pending' &&
      signalClassKey(
        signalTypeOf(record, context.signals),
        contradictionIdsOf(record, context.signals),
        goalIdsOf(record, context.signals),
      ) === key,
  ).length

  // Grade gate first: a grade B finding may never open a card.
  if (!context.mayEscalate) {
    return {
      level: 0,
      openIntervention: false,
      repeatCount,
      pendingForClass,
      rationale:
        'the observation grade for this activity permits recording and prompting only; ' +
        'Level 2/3 escalation is reserved for grade A evidence.',
      hint: '这次操作的证据等级不够，只记录不升级；补一条带文件或提交证据的活动可提高可信度。',
    }
  }

  if (context.confidence < config.thresholds.minConfidence) {
    return {
      level: 0,
      openIntervention: false,
      repeatCount,
      pendingForClass,
      rationale: `confidence ${context.confidence.toFixed(2)} is below the configured floor ${config.thresholds.minConfidence}; recorded silently.`,
      hint: '这次判定的把握不足，先静默记录；补足证据后会自动重新判断。',
    }
  }

  // Level 3: a core bypass that has repeated, at high intensity, with no card open.
  const isCoreBypass = context.signalType === 'core_bypass'
  if (isCoreBypass) {
    const priorBypasses = sameClassInWindow.filter(
      (signal) => signal.signalType === 'core_bypass',
    ).length
    const repeated = priorBypasses + 1 >= config.thresholds.repeatThreshold
    const intense = context.intensity >= LEVEL3_MIN_INTENSITY
    if (repeated && intense && pendingForClass === 0) {
      return {
        level: 3,
        openIntervention: true,
        repeatCount,
        pendingForClass,
        rationale:
          `core_bypass repeated ${priorBypasses + 1}x in the last ${config.thresholds.windowMinutes} ` +
          `minutes (threshold ${config.thresholds.repeatThreshold}) with the contradiction at ` +
          `intensity ${context.intensity} (Level 3 floor ${LEVEL3_MIN_INTENSITY}), and no pending ` +
          `intervention covers it: opening a blocking alignment check.`,
        hint: '同一类问题已重复出现且核心矛盾强度未降；先用 check_drift 确认，再决定是否继续。',
      }
    }
    if (repeated && intense) {
      return {
        level: 1,
        openIntervention: false,
        repeatCount,
        pendingForClass,
        rationale: `core_bypass meets the Level 3 conditions but ${pendingForClass} pending intervention(s) already cover this class; recorded as a Level 1 reminder instead of a second gate.`,
        hint: '已有待处理的卡片覆盖同类问题，这次只提醒；先处理那张卡片。',
      }
    }
  }

  // Level 2: repeated same-class high-confidence signals, no open card.
  if (repeatCount >= config.thresholds.repeatThreshold) {
    if (pendingForClass === 0) {
      return {
        level: 2,
        openIntervention: true,
        repeatCount,
        pendingForClass,
        rationale: `${repeatCount} same-class high-confidence signals in the last ${config.thresholds.windowMinutes} minutes reached the configured repeat threshold ${config.thresholds.repeatThreshold}; opening one intervention card.`,
        hint: '同类问题在短时间内重复出现，打开一张待决定卡片；用 check_drift 查看详情。',
      }
    }
    return {
      level: 1,
      openIntervention: false,
      repeatCount,
      pendingForClass,
      rationale: `${repeatCount} same-class signals reached the repeat threshold, but ${pendingForClass} intervention(s) are already pending for this class; adding a Level 1 reminder rather than a duplicate card.`,
      hint: '已有待处理的卡片覆盖同类问题，这次只提醒；先处理那张卡片。',
    }
  }

  // Level 1: a single high-confidence drift, or a contradiction that has not eased.
  const isPressureSignal =
    context.signalType === 'contradiction_shift' && context.relatedContradictionIds.length > 0
  if (isPressureSignal) {
    return {
      level: 1,
      openIntervention: false,
      repeatCount,
      pendingForClass,
      rationale: `a blocking contradiction is intense and has not eased inside the ${config.thresholds.windowMinutes}-minute window; surfaced as a Level 1 note in the next prompt.`,
      hint: '有一条矛盾强度未降；用 contradiction_observe 记录新读数，或调整相关目标。',
    }
  }
  if (context.confidence >= config.thresholds.minConfidence) {
    return {
      level: 1,
      openIntervention: false,
      repeatCount,
      pendingForClass,
      rationale: `a single high-confidence ${context.signalType} was recorded (${repeatCount}/${config.thresholds.repeatThreshold} toward an intervention); surfaced as a Level 1 note, no answer required.`,
      hint: '发现一处可能偏离目标的迹象；用 check_drift 查看详情，再决定是否调整。',
    }
  }

  return {
    level: 0,
    openIntervention: false,
    repeatCount,
    pendingForClass,
    rationale: 'below every escalation threshold; recorded silently at Level 0.',
    hint: '低于当前告警门槛，仅记录；可在设置卡里调整阈值。',
  }
}

/** Look up the signal a record refers to; returns `undefined` when unknown. */
function findSignal(
  record: InterventionRecord,
  signals: readonly DriftSignal[],
): DriftSignal | undefined {
  return signals.find((signal) => signal.id === record.signalId)
}

/** Signal type behind an intervention, via its originating signal. */
function signalTypeOf(
  record: InterventionRecord,
  signals: readonly DriftSignal[],
): DriftSignalType {
  return findSignal(record, signals)?.signalType ?? 'scope_drift'
}

/** Contradiction ids behind an intervention, via its originating signal. */
function contradictionIdsOf(
  record: InterventionRecord,
  signals: readonly DriftSignal[],
): readonly string[] {
  return findSignal(record, signals)?.relatedContradictionIds ?? []
}

/** Goal ids behind an intervention, via its originating signal. */
function goalIdsOf(
  record: InterventionRecord,
  signals: readonly DriftSignal[],
): readonly string[] {
  return findSignal(record, signals)?.relatedGoalIds ?? []
}

/**
 * Suggested actions attached to a Level 2/3 card (spec 4.4 item 3).
 *
 * @param level - 2 or 3.
 * @param signalType - the signal that opened the card.
 * @param goalTitles - readable names for the affected goals.
 * @param contradictionTitle - the blocking contradiction, when known.
 * @returns the candidate actions the user can choose between.
 */
export function suggestedActions(
  level: 2 | 3,
  signalType: DriftSignalType,
  goalTitles: readonly string[],
  contradictionTitle: string | undefined,
): string[] {
  const actions: string[] = [
    `continue: keep the current path and record why it serves ${goalTitles[0] ?? 'the confirmed goal'}`,
    'realign: return to the goal the confirmed tree names, dropping the current branch',
  ]
  if (contradictionTitle !== undefined) {
    actions.push(`reassess_main: re-evaluate the main contradiction "${contradictionTitle}"`)
  } else {
    actions.push('reassess_main: re-evaluate which contradiction currently blocks progress')
  }
  actions.push(
    signalType === 'scope_drift'
      ? 'register_branch: register the current branch as a new L2/L3 goal or an exploration whitelist entry'
      : 'register_branch: register the current work as a new goal or exploration entry',
  )
  if (level === 3) {
    actions.push(
      'gate: non-read-only tool calls stay blocked until this decision is recorded',
    )
  }
  return actions
}

/**
 * One hint's budget, in characters.
 *
 * The prompt block is read at a glance; a hint that needs a third line has
 * stopped being a hint and become the rationale it was split from.
 */
export const HINT_MAX_CHARS = 60

/**
 * Trim a hint to the budget, marking the cut rather than silently dropping text.
 *
 * @param text - candidate hint.
 * @param limit - character budget; defaults to {@link HINT_MAX_CHARS}.
 */
export function clampHint(text: string, limit = HINT_MAX_CHARS): string {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, Math.max(0, limit - 1))}…`
}

/**
 * Explain why a step was not escalated for lack of evidence coverage.
 *
 * The coverage floor is checked in the signal aggregator, which returns level 0
 * without saying anything. Silence there is indistinguishable from "the monitor
 * is broken": a session without a declared plan can sit at 0.25 coverage for a
 * long time, and the user never learns that the monitor was simply blind.
 *
 * @param coverage - available weight / total weight for this step (0–1).
 * @param floor - configured minimum coverage.
 * @param hasPlan - whether the session declared a plan.
 * @returns a Chinese explanation, or `undefined` when coverage is sufficient.
 */
export function coverageHint(
  coverage: number,
  floor: number,
  hasPlan: boolean,
): string | undefined {
  if (coverage >= floor) return undefined
  const percent = Math.round(coverage * 100)
  return clampHint(
    hasPlan
      ? `这一步的判据覆盖率只有 ${percent}%，不足以判断是否偏离；补齐步骤的 expects 后再看。`
      : `本次会话没有声明计划，只有 ${percent}% 的判据可用，暂不足以判断；先用 metacog_declare_plan 声明计划。`,
  )
}

/**
 * Render the one-line Level 1 hint injected into the prompt (spec 4.4 item 2).
 *
 * Only `signal.hint` is rendered. The technical `rationale` used to be appended
 * here, which put threshold names and signal classes in front of the model (and
 * the user) as if they were advice. Signals written before the split carry an
 * empty hint, so they get a generic Chinese line instead of the old English
 * sentence.
 *
 * @param signal - the Level 1 signal.
 * @returns a single short line.
 */
export function level1Hint(signal: DriftSignal): string {
  const body =
    signal.hint !== undefined && signal.hint.length > 0
      ? signal.hint
      : '发现一处需要留意的偏离，用 check_drift 查看详情。'
  return `[metacog L1] ${clampHint(body)}`
}

/**
 * Render the reminder injected while a Level 2/3 card is pending.
 *
 * Prefers the record's own Chinese hint; a record written before the split has
 * none, and its `promptSummary` is technical, so the fallback names the tool
 * that resolves the card rather than showing that summary.
 *
 * @param record - the pending intervention.
 * @returns a single short line naming the decision awaited.
 */
export function pendingInterventionHint(record: InterventionRecord): string {
  const gate = record.level === 3 ? '（未决定前非只读工具会被拦截）' : ''
  const body =
    record.hint !== undefined && record.hint.length > 0
      ? record.hint
      : '有一张待决定的卡片，用 resolve_intervention 处理。'
  // The id stays: `resolve_intervention` takes it, so the line is actionable.
  return `[metacog L${record.level}] 待决定卡片 ${record.id}：${clampHint(body)}${gate}`
}
