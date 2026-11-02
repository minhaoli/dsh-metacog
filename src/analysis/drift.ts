/**
 * Deterministic drift detectors.
 *
 * Each detector answers one question about a project's own recorded history and
 * returns a *draft* signal: everything except `id` and `level`. Assigning a
 * level is the escalation machine's job ({@link module:dsh-metacog/analysis/escalation}),
 * because the level depends on how many same-class signals already exist and on
 * whether a pending intervention is already open — facts a detector should not
 * need to know.
 *
 * Two rules run through every detector here:
 *
 * - Nothing is inferred from an absence of data. A detector that cannot find
 *   evidence returns nothing rather than a low-confidence signal.
 * - Records without a timestamp are compared against the injected clock, never
 *   against wall-clock time, so tests are reproducible.
 *
 * @module dsh-metacog/analysis/drift
 */
import type {
  ActivityRecord,
  ContradictionNode,
  ContradictionObservation,
  DriftSignal,
  DriftSignalType,
  GoalNode,
  MonitorCategory,
  TreeState,
} from '../data/types.js'
import type { MetacogConfig } from '../config.js'
import { computeTrend, observationsInWindow } from './trend.js'
import { evaluateProgress } from './progress.js'

/** A signal before the escalation machine assigns its response level. */
export interface SignalDraft {
  observedAt: string
  monitorCategory: MonitorCategory
  signalType: DriftSignalType
  relatedGoalIds: string[]
  relatedContradictionIds: string[]
  activityIds: string[]
  confidence: number
  evidence: string[]
  /**
   * One or two Chinese lines for the user: what happened, why it matters, and
   * what can be done next.
   *
   * `rationale` below stays technical (rule names, thresholds, ids) for the
   * audit trail. The prompt block reads this field only.
   */
  hint: string
  rationale: string
}

/** Everything the detectors read. */
export interface DriftInput {
  state: TreeState
  activities: readonly ActivityRecord[]
  observations: readonly ContradictionObservation[]
  signals: readonly DriftSignal[]
  config: MetacogConfig
  now: Date
}

/**
 * Stable identity of a signal class, used to count repeats and to decide
 * whether a pending intervention already covers this problem.
 *
 * The binding target (contradiction ids, else goal ids) is part of the key, so
 * three misaligned activities against *different* contradictions never add up
 * to one escalation.
 *
 * @param signalType - the detector that produced the signal.
 * @param relatedContradictionIds - contradictions the signal concerns.
 * @param relatedGoalIds - goals the signal concerns.
 * @returns a comparable key string.
 */
export function signalClassKey(
  signalType: DriftSignalType,
  relatedContradictionIds: readonly string[],
  relatedGoalIds: readonly string[],
): string {
  const contradictions = [...relatedContradictionIds].sort().join('+')
  if (contradictions.length > 0) return `${signalType}@c:${contradictions}`
  const goals = [...relatedGoalIds].sort().join('+')
  if (goals.length > 0) return `${signalType}@g:${goals}`
  return `${signalType}@unbound`
}

/**
 * Current intensity of a contradiction, or `null` when nothing supports a level.
 *
 * Reads the observation stream in the window and the node's own field, taking
 * the higher of the two. `null` is preserved rather than folded into 0: an
 * unobserved tension has an *unknown* intensity, and rendering it as 0 both
 * misinforms the reader and contradicts the `null` the tree view reports for
 * the same node.
 *
 * @param node - the contradiction.
 * @param observations - recorded observations.
 * @param windowMinutes - sliding window.
 */
export function currentIntensity(
  node: ContradictionNode,
  observations: readonly ContradictionObservation[],
  windowMinutes: number,
): number | null {
  const recent = observationsInWindow(observations, node.id, windowMinutes)
  let best: number | null = node.intensity
  for (const item of recent) {
    if (item.intensity === null) continue
    if (best === null || item.intensity > best) best = item.intensity
  }
  return best
}

/** Render an intensity for prose: the level, or "unknown" when unsupported. */
function describeIntensity(intensity: number | null): string {
  return intensity === null ? 'unknown (no observation recorded)' : String(intensity)
}
/** Whether a timestamp falls inside the configured sliding window. */
function inWindow(iso: string, now: Date, windowMinutes: number): boolean {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return false
  return at >= now.getTime() - windowMinutes * 60_000
}

/**
 * Contradictions the monitor treats as blocking: `main` and `core`.
 *
 * @param state - current tree.
 * @param confirmedOnly - skip nodes the user has not confirmed.
 */
function blockingContradictions(state: TreeState, confirmedOnly = true): ContradictionNode[] {
  return state.contradictions.filter(
    (node) =>
      (node.type === 'main' || node.type === 'core') && (!confirmedOnly || node.confirmedByUser),
  )
}

/**
 * Detect `goal_staleness` (spec 4.3 item 3).
 *
 * A goal is stale when no evidence was added and no aligned activity was
 * recorded for `staleDaysThreshold` days. The clock compared against is the
 * later of the goal's own `updatedAt` and its most recent aligned activity, so
 * a goal that is being worked on without being edited is not reported.
 *
 * @param input - current project facts.
 * @returns one draft per stale goal, or an empty array.
 */
export function detectGoalStaleness(input: DriftInput): SignalDraft[] {
  const { state, activities, config, now } = input
  const staleMs = config.thresholds.staleDaysThreshold * 86_400_000
  const drafts: SignalDraft[] = []

  for (const goal of state.goals) {
    if (!goal.confirmedByUser) continue
    // The root is never "stale": it is the statement the whole tree hangs from,
    // and it is re-examined through its children rather than by activity volume.
    if (goal.depth === 0) continue
    if (goal.status !== 'active' && goal.status !== 'at_risk') continue

    const alignedAt = activities
      .filter(
        (activity) =>
          (activity.decision === 'aligned' || activity.decision === 'exploratory') &&
          activity.candidateGoalIds.includes(goal.id),
      )
      .map((activity) => Date.parse(activity.timestamp))
      .filter((value) => !Number.isNaN(value))

    const editedAt = Date.parse(goal.updatedAt)
    const lastTouched = Math.max(
      Number.isNaN(editedAt) ? 0 : editedAt,
      ...(alignedAt.length > 0 ? alignedAt : [0]),
    )
    const idleDays = (now.getTime() - lastTouched) / 86_400_000
    if (idleDays < config.thresholds.staleDaysThreshold) continue
    if (now.getTime() - lastTouched < staleMs) continue

    drafts.push({
      observedAt: now.toISOString(),
      monitorCategory: 'goal_alignment',
      signalType: 'goal_staleness',
      relatedGoalIds: [goal.id],
      relatedContradictionIds: [],
      activityIds: [],
      confidence: 1,
      evidence: goal.evidence.slice(0, 5),
      hint: `目标「${goal.title}」已 ${idleDays.toFixed(0)} 天没有推进记录；确认它是否已完成，或用 metacog_revise_plan 调整。`,
      rationale:
        `depth-${goal.depth} goal "${goal.title}" has had no new evidence and no aligned activity ` +
        `for ${idleDays.toFixed(1)} days, above the configured ${config.thresholds.staleDaysThreshold}-day threshold, ` +
        `and is still "${goal.status}".`,
    })
  }
  return drafts
}

/**
 * Detect `core_bypass` (spec 4.3 item 2).
 *
 * Both halves must be real: a blocking contradiction that is intense and not
 * easing, *and* a run of recorded activity that avoids it. Either half alone is
 * not a bypass — a high-intensity contradiction the user is actively working on
 * is just a hard problem.
 *
 * @param input - current project facts.
 * @returns one draft per bypassing contradiction, or an empty array.
 */
export function detectCoreBypass(input: DriftInput): SignalDraft[] {
  const { state, activities, observations, config, now } = input
  const window = config.thresholds.windowMinutes
  const drafts: SignalDraft[] = []

  for (const node of blockingContradictions(state)) {
    const trend = computeTrend(observations, node.id, window)
    const intensity = currentIntensity(node, observations, window)
    // No reading means no bypass can be asserted: an unknown tension cannot be
    // "at high intensity".
    if (intensity === null) continue
    if (intensity < config.thresholds.highIntensityThreshold) continue
    if (trend.trend === 'falling') continue

    const goalIds = new Set([node.primaryGoalId, ...node.relatedGoalIds])
    const avoiding = activities.filter((activity) => {
      if (!inWindow(activity.timestamp, now, window)) return false
      if (activity.decision === 'aligned' || activity.decision === 'exploratory') return false
      // `scope_drift` is by definition an activity that serves no active goal.
      // Its `candidateGoalIds` may still name the goal whose *exclusion* rule it
      // hit — that is the clearest case of avoidance, not evidence of service.
      // `uncertain` records are kept unless they positively point at a goal the
      // contradiction binds, because an unjudged activity cannot be said to
      // avoid anything.
      if (activity.decision === 'scope_drift') return true
      return !activity.candidateGoalIds.some((id) => goalIds.has(id))
    })
    if (avoiding.length < config.thresholds.repeatThreshold) continue

    drafts.push({
      observedAt: now.toISOString(),
      monitorCategory: 'goal_alignment',
      signalType: 'core_bypass',
      relatedGoalIds: [...goalIds],
      relatedContradictionIds: [node.id],
      activityIds: avoiding.map((activity) => activity.id),
      confidence: Math.min(1, 0.6 + 0.1 * Math.min(avoiding.length, 4)),
      evidence: [...node.evidence.slice(0, 3), ...avoiding.flatMap((a) => a.evidence).slice(0, 3)],
      hint: `矛盾「${node.title}」强度 ${intensity} 且未缓解，近期活动却绕开了它；用 check_drift 核对它是否仍成立。`,
      rationale:
        `${node.type} contradiction "${node.title}" is at intensity ${describeIntensity(intensity)} ` +
        `(threshold ${config.thresholds.highIntensityThreshold}) with trend "${trend.trend}", ` +
        `while ${avoiding.length} recorded activities in the last ${window} minutes served ` +
        `neither it nor its goals. ${trend.rationale}`,
    })
  }
  return drafts
}

/**
 * Detect `scope_drift` from a single already-judged activity.
 *
 * The activity record carries the verdict; this detector only decides whether
 * the verdict is strong enough and which blocking contradiction it aggravates,
 * so the escalation machine can bind repeats together.
 *
 * @param activity - the recorded activity.
 * @param input - current project facts.
 * @returns one draft per drift activity, or an empty array.
 */
export function detectScopeDrift(activity: ActivityRecord, input: DriftInput): SignalDraft[] {
  if (activity.decision !== 'scope_drift') return []
  const { state, observations, config } = input
  const confidence = activity.alignmentConfidence ?? 0
  if (confidence < config.thresholds.minConfidence) return []

  // Bind to the blocking contradiction that the drift most plausibly aggravates:
  // prefer one whose goals intersect the (usually empty) candidate set, else the
  // most intense blocking node, so repeats of the same real problem share a key.
  const blocking = blockingContradictions(state)
  const scored = blocking
    .map((node) => {
      const trend = computeTrend(observations, node.id, config.thresholds.windowMinutes)
      const intensity = currentIntensity(node, observations, config.thresholds.windowMinutes)
      const overlap = activity.candidateGoalIds.some(
        (id) => id === node.primaryGoalId || node.relatedGoalIds.includes(id),
      )
      // Ranking treats an unknown intensity as 0 for ordering only; the value
      // carried into the signal stays `null` so the reader is not told a level
      // that no observation supports.
      return {
        node,
        intensity,
        rankWeight: intensity ?? 0,
        trend: trend.trend,
        score: (overlap ? 100 : 0) + (intensity ?? 0),
      }
    })
    .sort((left, right) => right.score - left.score)
  const bound = scored[0]

  return [
    {
      observedAt: activity.timestamp,
      monitorCategory: 'goal_alignment',
      signalType: 'scope_drift',
      relatedGoalIds: activity.candidateGoalIds,
      relatedContradictionIds: bound === undefined ? [] : [bound.node.id],
      activityIds: [activity.id],
      confidence,
      evidence: activity.evidence.slice(0, 5),
      hint: `活动「${activity.summary.slice(0, 20)}」被判偏离目标；若这是新需求，用 metacog_revise_plan 补进声明。`,
      rationale:
        `grade ${activity.observationGrade} activity "${activity.summary}" was judged out of ` +
        `scope with confidence ${confidence.toFixed(2)}. ${activity.rationale}` +
        (bound === undefined
          ? ''
          : ` It aggravates ${bound.node.type} contradiction "${bound.node.title}" ` +
            `(intensity ${describeIntensity(bound.intensity)}, trend ${bound.trend}).`),
    },
  ]
}

/**
 * Detect `contradiction_shift` (spec 4.3 item 4).
 *
 * The plugin cannot discover a new bottleneck by itself, so the caller supplies
 * one (`blockerHint` from its own reading of the work). This detector's job is
 * narrow and checkable: is that bottleneck already covered by a current `main`
 * node? If yes, nothing has shifted; if no, the structure lags the work.
 *
 * @param blockerHint - the bottleneck the caller believes is current.
 * @param input - current project facts.
 * @returns a draft when the structure has not caught up, else an empty array.
 */
export function detectContradictionShift(blockerHint: string, input: DriftInput): SignalDraft[] {
  const hint = normalizeText(blockerHint)
  if (hint.length === 0) return []
  const { state, now } = input
  const mains = state.contradictions.filter(
    (node) => node.type === 'main' && node.confirmedByUser,
  )
  const covered = mains.some((node) => {
    const haystack = normalizeText(
      [node.title, node.description, node.poleA, node.poleB].join(' '),
    )
    return haystack.includes(hint) || hint.includes(normalizeText(node.title))
  })
  if (covered) return []

  return [
    {
      observedAt: now.toISOString(),
      monitorCategory: 'structure_validity',
      signalType: 'contradiction_shift',
      relatedGoalIds: [],
      relatedContradictionIds: mains.map((node) => node.id),
      activityIds: [],
      confidence: 0.7,
      evidence: [],
      hint: `当前瓶颈「${blockerHint}」不在已确认的矛盾里；用 contradiction_tree_edit 补一条，或说明它属于哪条。`,
      rationale:
        `the current bottleneck is reported as "${blockerHint}", but no confirmed main ` +
        `contradiction covers it` +
        (mains.length === 0
          ? ' (the tree has no confirmed main contradiction at all).'
          : ` (current main: ${mains.map((node) => `"${node.title}"`).join(', ')}).`),
    },
  ]
}

/**
 * Lowercase and collapse whitespace for cross-language substring matching.
 *
 * @param value - raw text.
 */
function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[\s\u3000]+/g, ' ').trim()
}

/**
 * The blocking contradiction with the highest current intensity.
 *
 * Used by the Level 1 rule ("a main contradiction whose intensity has not
 * eased") and by the report's "main contradiction" line.
 *
 * @param input - current project facts.
 * @returns the node and its current intensity, or `undefined`.
 */
export function dominantContradiction(
  input: DriftInput,
): { node: ContradictionNode; intensity: number | null; trend: string } | undefined {
  const window = input.config.thresholds.windowMinutes
  const scored = blockingContradictions(input.state).map((node) => {
    const trend = computeTrend(input.observations, node.id, window)
    const intensity = currentIntensity(node, input.observations, window)
    return {
      node,
      intensity,
      trend: trend.trend,
      rank: node.type === 'core' ? 1 : 0,
      weight: intensity ?? 0,
    }
  })
  scored.sort((left, right) => right.weight - left.weight || right.rank - left.rank)
  return scored[0]
}

/**
 * Detect dated goals that are running out of time without recorded movement.
 *
 * This is the calendar's opinion, not the activity stream's. `goal_staleness`
 * asks whether anything touched a goal lately; this asks whether enough
 * happened given how much of the span is gone. A goal can be "recently touched"
 * and still be at 80% elapsed with nothing to show.
 *
 * Two deliberate narrowings:
 *
 * - Only a goal whose reminder condition fired produces a draft. A quarter-mark
 *   goal with progress is not news, and reporting it would train the user to
 *   ignore these signals.
 * - Only a depth this span is judged at is considered. A two-year root goal is
 *   not late because nothing happened this week.
 *
 * @param input - current project facts.
 * @returns one draft per dated goal that is behind schedule.
 */
export function detectDeadlineRisk(input: DriftInput): SignalDraft[] {
  const { state, activities, now } = input
  // Movement per goal comes from the activity stream only.
  //
  // Deliberately NOT from `goal.updatedAt`: setting a deadline is an edit, and
  // counting that as progress would let a user silence a deadline reminder just
  // by touching the goal. Progress means work was judged to serve this goal.
  const lastTouched = new Map<string, string>()
  for (const activity of activities) {
    if (activity.decision !== 'aligned' && activity.decision !== 'exploratory') continue
    for (const goalId of activity.candidateGoalIds) {
      const current = lastTouched.get(goalId)
      if (current === undefined || Date.parse(activity.timestamp) > Date.parse(current)) {
        lastTouched.set(goalId, activity.timestamp)
      }
    }
  }

  const { findings } = evaluateProgress(state.goals, { now, lastTouched })
  const drafts: SignalDraft[] = []
  for (const finding of findings) {
    if (!finding.shouldRemind) continue
    const goal = state.goals.find((node) => node.id === finding.goalId)
    if (goal === undefined) continue
    drafts.push({
      observedAt: now.toISOString(),
      monitorCategory: 'goal_alignment',
      signalType: 'deadline_risk',
      relatedGoalIds: [finding.goalId],
      relatedContradictionIds: [],
      activityIds: [],
      confidence: finding.stage === 'overdue' ? 1 : 0.8,
      evidence: goal.evidence.slice(0, 3),
      hint:
        `目标「${goal.title}」` +
        (finding.daysLeft === null
          ? '临近截止'
          : finding.daysLeft < 0
            ? `已过期 ${Math.abs(finding.daysLeft)} 天`
            : `还剩 ${finding.daysLeft} 天`) +
        '且没有推进；确认是否调整截止或收缩范围。',
      rationale: finding.message,
    })
  }
  return drafts
}

/**
 * Detect the Level 1 condition "a blocking contradiction has not eased".
 *
 * This is a prompt-level nudge, not an intervention: it carries no activity and
 * exists so the injected prompt line can name a rising or stalled main
 * contradiction.
 *
 * @param input - current project facts.
 * @returns a draft when a blocking contradiction is intense and not falling.
 */
export function detectContradictionPressure(input: DriftInput): SignalDraft[] {
  const dominant = dominantContradiction(input)
  if (dominant === undefined) return []
  // An unknown intensity cannot be "high": skip rather than compare null.
  if (dominant.intensity === null) return []
  if (dominant.intensity < input.config.thresholds.highIntensityThreshold) return []
  if (dominant.trend === 'falling') return []
  return [
    {
      observedAt: input.now.toISOString(),
      monitorCategory: 'structure_validity',
      signalType: 'contradiction_shift',
      relatedGoalIds: [dominant.node.primaryGoalId, ...dominant.node.relatedGoalIds],
      relatedContradictionIds: [dominant.node.id],
      activityIds: [],
      confidence: 0.6,
      evidence: dominant.node.evidence.slice(0, 3),
      hint: `矛盾「${dominant.node.title}」强度 ${dominant.intensity} 且没有缓解；用 contradiction_observe 记录新读数。`,
      rationale:
        `${dominant.node.type} contradiction "${dominant.node.title}" sits at intensity ` +
        `${dominant.intensity} with trend "${dominant.trend}" inside the ` +
        `${input.config.thresholds.windowMinutes}-minute window; it has not eased.`,
    },
  ]
}

/**
 * Goals that a drift signal could name, for prompt summaries.
 *
 * @param state - current tree.
 * @param ids - goal ids referenced by a signal or report.
 * @returns the matching goals, in tree order.
 */
export function goalsByIds(state: TreeState, ids: readonly string[]): GoalNode[] {
  const wanted = new Set(ids)
  return state.goals.filter((goal) => wanted.has(goal.id))
}
