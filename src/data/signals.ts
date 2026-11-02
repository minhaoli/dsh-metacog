/**
 * The v4 signal contract: five signal scores, their three-state availability,
 * the aggregation that turns them into one number, and the plan a session
 * declares up front.
 *
 * Kept apart from `types.ts` on purpose. Everything here is *new* in v4 and
 * nothing here is persisted as project state; `types.ts` holds the structures a
 * store reads and writes, and mixing an unproven contract into it would make a
 * later revision of the contract look like a store migration.
 *
 * Two rules run through the whole file, and both are enforced by the types
 * rather than by a caller remembering them:
 *
 * - A score that cannot be computed is never `0`. Zero means "measured, and it
 *   is fine"; absence means "not measured". Collapsing the two is how a missing
 *   signal silently reads as a clean one.
 * - A score is not a probability. Nothing here is calibrated, so the type name
 *   says `Score` and every threshold derived from it is named `theta*Score`.
 *
 * @module dsh-metacog/data/signals
 */
import { z } from 'zod'

/**
 * Which signals v4 defines.
 *
 * The names are stable keys: they appear in the aggregation weights, in config,
 * and in a report. Adding one is a contract change, so the list is closed.
 *
 * `s1_semantic` used to be reserved here for a semantic-drift channel that was
 * never given a producer. It has been removed rather than left as a placeholder:
 * an id nothing emits is indistinguishable from a broken one, and a reader has to
 * open the aggregator to learn it carries no weight. Semantic drift is not planned.
 */
export const SignalIdSchema = z.enum([
  's2_class',
  's3_tool_novel',
  's4_plan_match',
  's5_progress',
  // The model-behaviour track. These watch the assistant rather than the user's
  // work: a looping or narrating agent produces no wrong goal judgement at all,
  // it simply does not advance. They carry their own dimension so a stalled agent
  // is not reported as "drifting from the goal", which is a different claim.
  'b_repeat',
  'b_error_streak',
  'b_alternating',
  'b_monologue',
])
export type SignalId = z.infer<typeof SignalIdSchema>

/**
 * Why a signal produced no score.
 *
 * Distinguishing these matters for the coverage floor and for the report: a
 * signal that is structurally inapplicable (no plan was declared) and one that
 * merely failed to run (embedding service down) both contribute no weight, but
 * only the first is a reason to ask the user for something.
 */
export const SignalAbsenceReasonSchema = z.enum([
  /** The session declared no plan, so this signal has nothing to compare against. */
  'no_declared_plan',
  /** The plan exists but lacks the field this signal needs. */
  'no_allowed_tools',
  /** The activity stream does not carry the data this signal reads. */
  'data_not_collected',
  /** The signal's own dependency failed (embedding call, file read). */
  'dependency_failed',
  /** Fewer than the minimum steps needed to compare against a baseline. */
  'insufficient_history',
])
export type SignalAbsenceReason = z.infer<typeof SignalAbsenceReasonSchema>

/**
 * One signal's result for one step: either a score in [0, 1], or an explicit
 * reason it has none.
 *
 * Modelled as a discriminated union rather than `{ score: number | null,
 * reason?: string }` so that reading `.score` without first checking
 * `status === 'available'` is a type error. The null-and-reason shape compiles
 * fine and produces `undefined + 0` at runtime, which is how a missing signal
 * becomes a silent zero.
 */
export const SignalScoreSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('available'),
    signal: SignalIdSchema,
    /** Measured value in [0, 1]; larger means more drift. */
    score: z.number().min(0).max(1),
    /** What the number was computed from, so a reader can check it. */
    evidence: z.array(z.string().min(1)).default([]),
  }),
  z.object({
    status: z.literal('not_applicable'),
    signal: SignalIdSchema,
    reason: SignalAbsenceReasonSchema,
    /** One sentence a report can show the user verbatim. */
    detail: z.string().default(''),
  }),
  z.object({
    status: z.literal('missing'),
    signal: SignalIdSchema,
    reason: SignalAbsenceReasonSchema,
    detail: z.string().default(''),
  }),
])
export type SignalScore = z.infer<typeof SignalScoreSchema>

/**
 * The three independent dimensions the five signals are folded into.
 *
 * Weighting happens here and not per signal, because S3 and S2 measure the same
 * thing at two grains: a tool outside the whitelist is a special case of a class
 * distribution shift, so giving both an independent weight double-counts one
 * event. S1 carries no weight at all and is used only when the other dimensions
 * are unavailable.
 */
export const AggregationDimensionSchema = z.enum(['scope', 'plan', 'progress', 'behaviour'])
export type AggregationDimension = z.infer<typeof AggregationDimensionSchema>

/**
 * Which signals feed which dimension. A dimension is available when at least one
 * of its signals is.
 */
export const DIMENSION_SIGNALS: Readonly<Record<AggregationDimension, readonly SignalId[]>> = {
  scope: ['s3_tool_novel', 's2_class'],
  plan: ['s4_plan_match'],
  progress: ['s5_progress'],
  behaviour: ['b_repeat', 'b_error_streak', 'b_alternating', 'b_monologue'],
}

/**
 * Signals that are still computed but no longer decide anything.
 *
 * S2 measures how far the mix of action classes has moved from the session's own
 * opening baseline. That baseline is the defect, not a tuning problem: it is
 * fixed to the first five steps, so the most ordinary working rhythm there is —
 * read for a while, then start writing — has an empty intersection with it, and
 * `1 - Jaccard` returns exactly 1.0. Weighted at 0.5 for the scope dimension
 * that lands on `thetaHintScore`, so a normal session is told it has drifted
 * before it has done anything wrong. No threshold fixes that; the comparison
 * itself is between two incomparable things.
 *
 * So it keeps running — the number is still worth reading in a report, and
 * computing it costs nothing — but it no longer reaches the aggregate, and in
 * particular it cannot dominate the scope dimension through `max()`.
 *
 * Re-enable it only when the baseline becomes *plan-relative* (what this session
 * said it would do, rather than what it happened to do first), which is the
 * comparison S2 was reaching for.
 *
 * Consequence of retiring it, stated once so it is not later discovered as a
 * mystery: a session that declares no plan now has only S3 for scope and only S4
 * for plan. With neither, the only available weight is progress at 0.25 — below
 * the 0.4 coverage floor — so the deterministic layer cannot escalate at all.
 * That is accepted on purpose (work that never declared an intent has not been
 * shown to deviate from one), but it is a real behaviour change and it is pinned
 * by `test/signal-retirement.test.mjs`.
 */
export const RETIRED_SIGNALS: ReadonlySet<SignalId> = new Set<SignalId>(['s2_class'])

/**
 * Dimension weights, held apart from the config schema so the constants the
 * aggregation is tested against live in one readable place.
 *
 * These are engineering estimates, not calibrated values. They are also the sole
 * input to `coverage`, which is why that number can only take five values.
 */
export const DIMENSION_WEIGHTS: Readonly<Record<AggregationDimension, number>> = {
  scope: 0.5,
  plan: 0.25,
  progress: 0.25,
  // Zero by design, and not a placeholder. The behaviour track answers a different
  // question from the other three — "is the agent stuck" rather than "does this
  // work serve the goal" — so it is reported on its own field instead of raising
  // the goal-drift score. A non-zero weight here would also change the five
  // possible values of `coverage` and reinterpret every threshold derived from it.
  behaviour: 0,
}

/**
 * One step's aggregation: the weighted score, how much of the weight was
 * actually available, and per-dimension detail.
 *
 * `coverage` is `availableWeight / totalWeight` and therefore can only be one of
 * {0, 0.25, 0.5, 0.75, 1}, given the weights above. It is *not* a probability and
 * not a confidence; it says how much of the intended evidence was present.
 */
export const StepAggregateSchema = z.object({
  /** Weighted mean over available dimensions, or null when none is available. */
  riskScore: z.number().min(0).max(1).nullable(),
  /** Weight of the dimensions that produced a score. */
  availableWeight: z.number().min(0).max(1),
  /** `availableWeight / 1`, spelled out rather than recomputed at call sites. */
  coverage: z.number().min(0).max(1),
  /**
   * The behaviour track's score, or null when nothing fired.
   *
   * Separate from `riskScore` on purpose: "the agent is looping" and "this work
   * does not serve the goal" are different findings, and a self-loop must not read
   * as goal drift. Consumers that only care about goal alignment ignore this field.
   */
  behaviourScore: z.number().min(0).max(1).nullable().default(null),
  /** Per-dimension scores that were available, for the report and for debugging. */
  dimensions: z
    .array(
      z.object({
        dimension: AggregationDimensionSchema,
        weight: z.number().min(0).max(1),
        score: z.number().min(0).max(1),
      }),
    )
    .default([]),
  /** Signals that contributed nothing, with why. */
  absent: z
    .array(
      z.object({
        signal: SignalIdSchema,
        status: SignalAbsenceReasonSchema,
      }),
    )
    .default([]),
  /**
   * Scores from {@link RETIRED_SIGNALS}, carried out rather than dropped.
   *
   * They take no part in `riskScore` or `coverage` — that is what retiring means
   * — but they are still measured, and a report that wants to say "the class mix
   * moved this much" needs the number. Deleting it here would have broken every
   * historical comparison the moment the signal stopped scoring, which is the
   * one outcome worse than a bad signal.
   */
  retired: z
    .array(
      z.object({
        signal: SignalIdSchema,
        score: z.number().min(0).max(1),
        evidence: z.array(z.string().min(1)).default([]),
      }),
    )
    .default([]),
})
export type StepAggregate = z.infer<typeof StepAggregateSchema>

/**
 * EMA parameters for the smoothed score.
 *
 * `beta` is the weight of the newest observation. The default of 0.4 is chosen
 * so a single-step burst peaks at 0.400 — below the 0.500 hint threshold — which
 * means a one-off excursion is recorded and not acted on. That is a deliberate
 * tradeoff, not an oversight: raising beta to 0.5 puts the burst peak exactly on
 * the threshold, which is a worse place to sit than clearly below it.
 */
export const EmaConfigSchema = z.object({
  beta: z.number().min(0).max(1).default(0.4),
  /** Value `final` starts from before any step has been observed. */
  initial: z.number().min(0).max(1).default(0),
})
export type EmaConfig = z.infer<typeof EmaConfigSchema>

/**
 * Response thresholds, deliberately named `Score` and not `Probability`.
 *
 * The two numbers are borrowed from v3's loss-matrix crossing points (0.500 for
 * silent→hint, 0.875 for hint→card), but v3 derived them under an assumption
 * that does not hold here: that the score they act on is a *calibrated*
 * probability. Ours is not, so these are starting values chosen for having a
 * defensible origin, not optimal decision boundaries. Renaming them to
 * `thetaCardProbability` would assert the calibration we do not have.
 */
export const ResponseThresholdsSchema = z.object({
  /** `final` at or above this earns a Level 1 hint. */
  thetaHintScore: z.number().min(0).max(1).default(0.5),
  /** `final` at or above this earns a Level 2 intervention card. */
  thetaCardScore: z.number().min(0).max(1).default(0.875),
  /** Consecutive steps at or above `thetaCardScore` before Level 2 opens. */
  consecutiveStepsForCard: z.number().int().min(1).default(3),
  /**
   * Minimum `coverage` for any escalation at all.
   *
   * Because coverage is discrete, 0.4 is not a tuned value: it admits any
   * combination worth at least 0.50 and rejects a single 0.25 dimension. Written
   * as a comparison rather than an equality so that changing the dimension
   * weights does not silently change what this gate means.
   */
  coverageFloor: z.number().min(0).max(1).default(0.4),
})
export type ResponseThresholds = z.infer<typeof ResponseThresholdsSchema>

/**
 * A declared plan: what this session intends to do, in a form a program can
 * check against what actually happened.
 *
 * The steps are structured, not prose. That is not a preference: the observed
 * side is generated by `collect.ts` from tool arguments, so a plan written in
 * free Chinese would share no strings with it, and plan matching would be
 * permanently zero. `intent` exists for the human reader and feeds no
 * computation.
 */
export const PlanStepSchema = z.object({
  /** Human-readable one-liner, shown in the card and the report. */
  intent: z.string().min(1),
  /**
   * What completing this step looks like. All supplied fields must match;
   * omitting a field means "no constraint on it".
   */
  expects: z.object({
    /** Tool name that must appear for this step to count as reached. */
    tool: z.string().min(1).optional(),
    /** Glob the touched path must match. */
    pathGlob: z.string().min(1).optional(),
    /** A checkable outcome rather than an action. */
    assert: z.enum(['tests-pass', 'build-pass', 'file-changed']).optional(),
  }),
  /** Marks a step whose evidence is enough on its own to consider it done. */
  optional: z.boolean().default(false),
})
export type PlanStep = z.infer<typeof PlanStepSchema>

/**
 * The plan itself.
 *
 * `allowedTools` is the field S3 reads, and it is the one the benchmark actually
 * validates: the 0.843 row comes from declaring a tool manifest, not from
 * detailed steps. So when a session can supply only one thing, it should be this
 * and not the step list.
 */
export const DeclaredPlanSchema = z.object({
  id: z.string().min(1),
  /** What this session is for, in one sentence. */
  goal: z.string().min(1),
  /** Which goal node this serves, when the session is working on one. */
  linkedGoalId: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
  /** ISO deadline for the plan as a whole, when it has one. */
  deadline: z.string().optional(),
  /** Tools this session permits itself. S3 flags anything outside this set. */
  allowedTools: z.array(z.string().min(1)).default([]),
  steps: z.array(PlanStepSchema).default([]),
  /** When the plan was declared. */
  declaredAt: z.string(),
  /** Set when the plan was revised; the declaration stays in the audit trail. */
  revisedAt: z.string().optional(),
  /**
   * Set when the goal was accepted as vague behind `allowVagueGoal`.
   *
   * Persisted rather than derived so a downstream reader cannot forget to ask:
   * S4, the model review and the "what are you doing today" prompt all compare
   * work against this sentence, and a vague one weakens every comparison. A
   * caller that wants to know only has to read the field.
   *
   * Defaults to `false`, which is also the correct answer for every plan written
   * before this existed: none of them were declared by accepting a vague goal.
   */
  vagueGoal: z.boolean().default(false),
  /** Why a vague goal was accepted; empty when the goal was concrete. */
  vagueGoalReason: z.string().default(''),
})
export type DeclaredPlan = z.infer<typeof DeclaredPlanSchema>

/**
 * The tool set a plan actually permits.
 *
 * An explicit `allowedTools` always wins: it is the field the benchmark
 * validates, and a session that took the trouble to name it means it. When there
 * is none, the step list is just as good a source — every step already names the
 * tool that completes it — and asking for both was the main reason sessions
 * declared neither. A step whose `expects` carries no `tool` contributes nothing:
 * an `assert`-only step says what finishing looks like, not what will be called.
 *
 * Deriving here rather than at the call site keeps one definition of "the tools
 * in force" for S3 and for the receipt a declaration returns; two would disagree
 * the first time one of them learned a new source.
 *
 * @param plan - the declared plan.
 * @returns the tools in force, deduplicated and in declaration order; empty when
 *   neither source names one.
 */
export function planAllowedTools(plan: DeclaredPlan): string[] {
  if (plan.allowedTools.length > 0) return [...plan.allowedTools]
  const fromSteps = new Set<string>()
  for (const step of plan.steps) {
    const tool = step.expects.tool
    if (tool !== undefined && tool.length > 0) fromSteps.add(tool)
  }
  return [...fromSteps]
}

/**
 * The cross-step state the EMA needs, one per project.
 *
 * This must be persisted, and that is not an optimisation. `final` is cumulative:
 * it is the memory that makes a slow drift visible at all. Held only in memory it
 * resets to zero on every restart, so a project that restarts often would never
 * accumulate enough to reach the card threshold no matter how it behaves — the
 * "3 consecutive steps" condition would be unmeetable, and the monitor would
 * quietly never escalate.
 *
 * `stepsSeen` is kept for a different reason: a card opened at step 7 of a run
 * that only ever saw 8 steps means something else than one opened at step 7 of
 * step 400, and without the count the report cannot say which happened.
 */
export const SignalStateSchema = z.object({
  projectId: z.string().min(1),
  /** Smoothed score carried between steps. */
  final: z.number().min(0).max(1).default(0),
  /** Consecutive steps at or above the card threshold, for the L2 condition. */
  consecutiveHigh: z.number().int().nonnegative().default(0),
  /** Steps observed since the state was created; a sanity figure for reports. */
  stepsSeen: z.number().int().nonnegative().default(0),
  /** Last step's aggregate, so a card can quote the numbers that opened it. */
  lastAggregate: StepAggregateSchema.optional(),
  /** Plan in force for this project, if one was declared. */
  planId: z.string().min(1).optional(),
  /**
   * The plan itself, not just its id.
   *
   * Stored here because the signals read the whitelist and the steps on every
   * step, and a separate plan file would be a second thing to keep consistent
   * with `planId`. One record, one write.
   */
  plan: DeclaredPlanSchema.optional(),
  updatedAt: z.string(),
})
export type SignalState = z.infer<typeof SignalStateSchema>

/**
 * Advance the persisted state by one step.
 *
 * Pure: takes the previous state and returns the next, so the caller owns
 * persistence and a test can replay a whole run without a store.
 *
 * @param previous - state before this step.
 * @param aggregate - this step's aggregation.
 * @param config - EMA parameters.
 * @param thresholds - response thresholds, for the consecutive counter.
 * @param now - timestamp to stamp.
 * @returns the state after this step.
 */
export function advanceSignalState(
  previous: SignalState | undefined,
  projectId: string,
  aggregate: StepAggregate,
  config: EmaConfig,
  thresholds: ResponseThresholds,
  now: Date,
): SignalState {
  const priorFinal = previous?.final ?? config.initial
  const final = advanceEma(priorFinal, aggregate, config.beta)
  // A step that measured nothing carries `final` forward, so a carried-over high
  // score is not evidence about *this* step. Counting it would let silent steps
  // accumulate credit toward a card the design says they cannot earn on their own:
  // the coverage floor rejects them individually at L0, yet the counter kept
  // climbing, and one real high step afterwards opened L2 as though the drift had
  // been continuous. "Consecutive" has to mean consecutive observations.
  const measurable = aggregate.riskScore !== null && aggregate.coverage >= thresholds.coverageFloor
  const isHigh = measurable && final >= thresholds.thetaCardScore
  return {
    projectId,
    final,
    // Reset rather than decay: the L2 condition is about *consecutive* steps, and
    // a step below the threshold genuinely breaks the run.
    consecutiveHigh: isHigh ? (previous?.consecutiveHigh ?? 0) + 1 : 0,
    stepsSeen: (previous?.stepsSeen ?? 0) + 1,
    lastAggregate: aggregate,
    ...(previous?.planId === undefined ? {} : { planId: previous.planId }),
    ...(previous?.plan === undefined ? {} : { plan: previous.plan }),
    updatedAt: now.toISOString(),
  }
}

/**
 * Decide the response level from a persisted state.
 *
 * Thin wrapper so callers do not hand-assemble the four arguments, and so the
 * coverage floor keeps being checked inside `decideLevelFromScore`.
 *
 * @param state - state after this step.
 * @param thresholds - configured thresholds.
 * @returns the level to record.
 */
export function decideLevelFromState(state: SignalState, thresholds: ResponseThresholds): 0 | 1 | 2 | 3 {
  if (state.lastAggregate === undefined) return 0
  return decideLevelFromScore(state.final, state.lastAggregate, state.consecutiveHigh, thresholds)
}

/**
 * Aggregate one step's signals into a single score and a coverage figure.
 *
 * A dimension's score is the maximum of its available signals. Maximum and not
 * mean, because the dimension asks "did anything leave the permitted scope" —
 * one out-of-scope tool is not diluted by the nine in-scope calls beside it.
 *
 * S1 is excluded from the weighted score entirely. It is the fallback: when no
 * dimension is available it is consulted alone, and when any dimension is
 * available it is ignored. Giving it a small weight instead would make it
 * present in every score while never being able to change a decision.
 *
 * @param scores - one entry per signal that was evaluated this step.
 * @param weights - dimension weights; defaults to the module constants.
 * @returns the aggregate, with `riskScore: null` when nothing was measurable.
 */
export function aggregateStep(
  scores: readonly SignalScore[],
  weights: Readonly<Record<AggregationDimension, number>> = DIMENSION_WEIGHTS,
): StepAggregate {
  const bySignal = new Map<SignalId, SignalScore>()
  for (const score of scores) bySignal.set(score.signal, score)

  const dimensions: StepAggregate['dimensions'] = []
  const absent: StepAggregate['absent'] = []
  const retired: StepAggregate['retired'] = []

  for (const dimension of Object.keys(weights) as AggregationDimension[]) {
    const members = DIMENSION_SIGNALS[dimension]
    let best: number | null = null
    for (const signal of members) {
      const entry = bySignal.get(signal)
      if (entry === undefined) continue
      // A retired signal is carried out of the loop, not through it. Letting it
      // reach `max()` is exactly the failure that retired it: S2 scoring 1.0 on a
      // normal read-then-write session would set the whole scope dimension, and
      // the dimension weight (0.5) would put the step on the hint threshold with
      // nothing wrong having happened.
      if (RETIRED_SIGNALS.has(signal)) {
        if (entry.status === 'available') {
          retired.push({ signal: entry.signal, score: entry.score, evidence: [...entry.evidence] })
        }
        continue
      }
      if (entry.status === 'available') {
        best = best === null ? entry.score : Math.max(best, entry.score)
      } else {
        absent.push({ signal: entry.signal, status: entry.reason })
      }
    }
    if (best !== null) dimensions.push({ dimension, weight: weights[dimension], score: best })
  }

  // The behaviour track is reported beside the score, not inside it.
  //
  // `coverage` is `availableWeight / totalWeight` over the *goal* dimensions, and
  // its five possible values are part of the contract. Folding a fourth weight in
  // would change that set and silently reinterpret every threshold derived from
  // it. It would also merge two different claims: "this work does not serve the
  // goal" and "the agent is stuck" are not the same finding, and a loop should not
  // raise the goal-drift score.
  //
  // So behaviour is removed before the weighted mean is taken, and reported on its
  // own field. The goal dimensions keep the exact arithmetic they had.
  const behaviourDimension = dimensions.find((entry) => entry.dimension === 'behaviour')
  const goalDimensions = dimensions.filter((entry) => entry.dimension !== 'behaviour')
  const goalAvailable = goalDimensions.reduce((sum, d) => sum + d.weight, 0)
  // Behaviour's weight is zero, so this sum is the same as before the track
  // existed; it is recomputed from the weights actually passed in rather than
  // hard-coded to 1, so a caller-supplied weight map still works.
  const totalWeight = (Object.keys(weights) as AggregationDimension[])
    .filter((dimension) => dimension !== 'behaviour')
    .reduce((sum, dimension) => sum + (weights[dimension] ?? 0), 0)

  return {
    riskScore:
      goalAvailable > 0
        ? goalDimensions.reduce((sum, d) => sum + d.weight * d.score, 0) / goalAvailable
        : null,
    availableWeight: goalAvailable,
    // Denominator excludes behaviour's weight for the same reason: including it
    // would make a step with no behaviour data look less covered than it is.
    coverage: totalWeight === 0 ? 0 : goalAvailable / totalWeight,
    dimensions: goalDimensions,
    absent,
    retired,
    behaviourScore: behaviourDimension === undefined ? null : behaviourDimension.score,
  }
}

/**
 * Advance the smoothed score by one step.
 *
 * A step with no measurable signal does not decay the score toward zero: it
 * carries it forward. Decaying on missing data would let a signal outage clear a
 * drift that is still happening, and would make the score depend on how often
 * collection happened to succeed.
 *
 * @param previous - `final` from the step before.
 * @param aggregate - this step's aggregation.
 * @param beta - weight of the newest observation.
 * @returns `final` for this step.
 */
export function advanceEma(previous: number, aggregate: StepAggregate, beta: number): number {
  if (aggregate.riskScore === null) return previous
  return beta * aggregate.riskScore + (1 - beta) * previous
}

/**
 * Decide the response level from a smoothed score.
 *
 * The coverage floor is checked here and not by the caller, so that "no
 * escalation without enough evidence" cannot be forgotten at one call site. The
 * grade gate is *not* checked here: it belongs to the caller, because this
 * function has no activity to inspect.
 *
 * @param final - smoothed score.
 * @param aggregate - this step's aggregation, for coverage.
 * @param consecutiveHigh - how many consecutive steps have been at or above the
 *   card threshold, including this one.
 * @param thresholds - configured thresholds.
 * @returns the level to record.
 */
export function decideLevelFromScore(
  final: number,
  aggregate: StepAggregate,
  consecutiveHigh: number,
  thresholds: ResponseThresholds,
): 0 | 1 | 2 | 3 {
  if (aggregate.coverage < thresholds.coverageFloor) return 0
  if (final >= thresholds.thetaCardScore && consecutiveHigh >= thresholds.consecutiveStepsForCard) return 2
  if (final >= thresholds.thetaHintScore) return 1
  return 0
}
