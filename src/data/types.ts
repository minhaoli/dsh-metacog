/**
 * Canonical data model for the metacognitive monitor.
 *
 * Every structure the spec defines lives here exactly once, as a zod schema
 * plus the inferred TypeScript type. The schema is the source of truth: it
 * validates both what a tool accepts and what a store returns, so a corrupted
 * or hand-edited state file is rejected at the boundary instead of silently
 * flowing into the analyser.
 *
 * Persistence never trusts a caller's object shape. Tools parse their input
 * through these schemas, the analyser builds values through these schemas, and
 * the store re-parses on read.
 *
 * @module dsh-metacog/data/types
 */
import { z } from 'zod'

/** ISO-8601 timestamp string that JavaScript can actually parse. */
export const IsoTimestampSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'must be an ISO-8601 timestamp' })

/** Non-empty identifier with no path separators, so it is safe as a filename. */
export const SafeIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/, { message: 'ids may only contain letters, digits, "_" and "-"' })

/** Deepest goal the program accepts. A sanity limit, not a semantic one. */
export const MAX_GOAL_DEPTH = 9

/**
 * Depth of a goal: 0 is the root, larger is closer to executable work.
 *
 * Depth is a property of the content, not a constant of the design. The same
 * project reads as two levels at a coarse grain and five at a fine one, so a fixed
 * ladder forced the user either to merge (losing information) or to split
 * (manufacturing empty nodes). The `L0`–`L3` names are gone for the same reason:
 * they encoded a position that the tree itself can state.
 */
export const GoalDepthSchema = z.number().int().min(0).max(MAX_GOAL_DEPTH)
export type GoalDepth = z.infer<typeof GoalDepthSchema>

/**
 * Where each legacy level lands after migration.
 *
 * Kept beside the schema so the store's lazy normalisation and any explicit
 * migration read the same table.
 */
export const LEGACY_LEVEL_DEPTH: Readonly<Record<string, number>> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
}

export const GoalStatusSchema = z.enum([
  'draft',
  'active',
  'at_risk',
  'blocked',
  'done',
  'deprecated',
])
export type GoalStatus = z.infer<typeof GoalStatusSchema>

export const ExplorationPolicySchema = z.enum(['allowed', 'limited', 'approval_required'])
export type ExplorationPolicy = z.infer<typeof ExplorationPolicySchema>

/**
 * How day-to-day work is judged against a goal.
 *
 * Deliberately separate from `successCriteria`: that field answers "when is the
 * goal complete", this one answers "which activities plausibly move it".
 * Confusing the two is what makes a monitor cry wolf over necessary dependency
 * work.
 */
export const GoalAlignmentSchema = z.object({
  /** Activity kinds or ranges that plausibly advance this goal. */
  relevantActivities: z.array(z.string().min(1)).default([]),
  /** Permitted techniques, research or experimental methods. */
  allowedMethods: z.array(z.string().min(1)).default([]),
  /** Explicitly irrelevant activities or over-engineering directions. */
  excludedActivities: z.array(z.string().min(1)).default([]),
  /** How much unregistered exploration this goal tolerates. */
  explorationPolicy: ExplorationPolicySchema.default('limited'),
})
export type GoalAlignment = z.infer<typeof GoalAlignmentSchema>

export const GoalNodeSchema = z.object({
  id: SafeIdSchema,
  projectId: z.string().min(1),
  parentId: SafeIdSchema.nullable().default(null),
  depth: GoalDepthSchema,
  title: z.string().min(1),
  description: z.string().default(''),
  status: GoalStatusSchema.default('draft'),
  priority: z.number().int().default(0),
  /** Unconfirmed nodes are candidates: never a basis for a hard alarm. */
  confirmedByUser: z.boolean().default(false),
  /** Verifiable completion criteria (spec 0.3 item 1). */
  successCriteria: z.array(z.string().min(1)).default([]),
  /** Activity alignment rules (spec 0.3 item 2). */
  alignment: GoalAlignmentSchema.prefault({}),
  /**
   * Path prefixes this goal owns, relative to the project root.
   *
   * A task usually lives in a fixed directory, so an activity's file paths are
   * evidence of which goal it serves. Deliberately many-to-many: one path may
   * belong to several goals, and one goal may own several paths, because a
   * person is free to mix unrelated work inside one directory.
   *
   * Matching is longest-prefix-first and segment-aware. An activity that matches
   * no goal is `unbound`, which is *not* drift: "I cannot place this" and "this
   * is off-target" are different claims, and collapsing them is how a monitor
   * reports departure it never established.
   */
  paths: z.array(z.string().min(1)).default([]),
  /** Traceable support: paths, symbols, commits, confirmations (spec 0.3 item 3). */
  evidence: z.array(z.string().min(1)).default([]),
  /**
   * When this goal is due, if it has a date at all.
   *
   * Optional on purpose: most goals are open-ended, and inventing a deadline for
   * them would make every progress reminder meaningless. Only a goal the user
   * actually dated gets staged reminders.
   */
  deadline: IsoTimestampSchema.optional(),
  /**
   * When work on this goal started.
   *
   * Needed alongside `deadline` because the reminder stages are fractions of the
   * *span*, not of the calendar: a two-week goal and a two-month goal should not
   * both be reminded at the same absolute dates. Defaults to `createdAt` when
   * absent, which is what the derivation path leaves behind.
   */
  startedAt: IsoTimestampSchema.optional(),
  /**
   * When this goal reached `done`, if it did.
   *
   * Separate from `status` because the achievement section of a report is a
   * timeline: "done" says where the goal is, `doneAt` says when it got there, and
   * only the second one can be sorted against other completions. Set by
   * `update_goal` when the status transitions into `done`; cleared if it leaves.
   */
  doneAt: IsoTimestampSchema.optional(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
})
export type GoalNode = z.infer<typeof GoalNodeSchema>

export const ContradictionTypeSchema = z.enum(['core', 'main', 'secondary', 'unclassified'])

export const TrendDirectionSchema = z.enum(['rising', 'stable', 'falling', 'unknown'])
export type TrendDirection = z.infer<typeof TrendDirectionSchema>

/** Intensity band: an integer 1–5, or null when evidence is insufficient. */
export const IntensitySchema = z.union([z.number().int().min(1).max(5), z.null()])

/**
 * One goal a tension presses on, and how hard.
 *
 * `weight` is a fraction of full pressure: 1 means the tension is a first-class
 * problem for that goal, 0.5 means it constrains the goal without defining it.
 * The primary goal always weighs 1; weights are what make a cross-goal tension
 * comparable between the goals it touches.
 */
export const ContradictionGoalLinkSchema = z.object({
  goalId: SafeIdSchema,
  weight: z.number().min(0).max(1),
})
export type ContradictionGoalLink = z.infer<typeof ContradictionGoalLinkSchema>

export const ContradictionNodeSchema = z.object({
  id: SafeIdSchema,
  projectId: z.string().min(1),
  /** The contradiction tree's own parent link, independent of goal links. */
  parentId: SafeIdSchema.nullable().default(null),
  /** Primary goal this tension belongs to. */
  primaryGoalId: SafeIdSchema,
  /** Other goals the same tension also constrains (cross-goal tension). */
  relatedGoalIds: z.array(SafeIdSchema).default([]),
  /**
   * Optional weight overrides for the links in `relatedGoalIds`.
   *
   * `relatedGoalIds` stays the membership list — every existing reader (shape
   * validation, review detection, the old tool parameters) knows only that. This
   * field adds how hard each membership presses, and only for the links someone
   * actually weighted; a goal without an entry here is read with
   * `config.contradictions.defaultRelatedWeight`. Optional rather than
   * defaulted, because it is an override layer, not a required field: a node
   * written before weights existed carries no key at all, and every hand-built
   * node literal stays valid.
   */
  relatedGoals: z.array(ContradictionGoalLinkSchema).optional(),
  type: ContradictionTypeSchema.default('unclassified'),
  confirmedByUser: z.boolean().default(false),
  title: z.string().min(1),
  description: z.string().default(''),
  /** One pole of the tension. */
  poleA: z.string().default(''),
  /** The opposing pole. */
  poleB: z.string().default(''),
  intensity: IntensitySchema.default(null),
  /**
   * Trend is derived from historical observations, never hand-written.
   * Starts `unknown` until a window of observations exists.
   */
  trend: TrendDirectionSchema.default('unknown'),
  /** Why this classification holds; `core` must tie back to L0. */
  rationale: z.string().default(''),
  resolutionHint: z.string().default(''),
  evidence: z.array(z.string().min(1)).default([]),
  /**
   * When this tension was resolved, if it was.
   *
   * The contradiction tree has no `resolved` status: a tension stops being
   * observed, and the trend falls to `stable`. That is not the same as being
   * solved, so resolution is recorded explicitly here rather than inferred from a
   * trend. The achievement timeline reads this and nothing else.
   */
  resolvedAt: IsoTimestampSchema.optional(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}).transform((node) => {
  // A node written with only the weighted form must not lose those links for
  // the readers that predate weights: `relatedGoalIds` is the membership list
  // they all use, so it is derived from both fields here, once, instead of in
  // every reader. Nodes that already agree are returned untouched.
  const missing = (node.relatedGoals ?? []).filter(
    (link) => !node.relatedGoalIds.includes(link.goalId),
  )
  if (missing.length === 0) return node
  return { ...node, relatedGoalIds: [...node.relatedGoalIds, ...missing.map((link) => link.goalId)] }
})
export type ContradictionNode = z.infer<typeof ContradictionNodeSchema>

/**
 * The parts of a contradiction that goal weighting reads.
 *
 * Structural rather than `ContradictionNode` so the pure functions below can be
 * unit-tested with plain objects and reused by projections that do not carry a
 * whole node. A full `ContradictionNode` satisfies it.
 */
export interface ContradictionLinkSource {
  primaryGoalId: string
  relatedGoalIds?: readonly string[]
  relatedGoals?: readonly ContradictionGoalLink[]
}

/** The weight knobs the burden calculation reads (a subset of the plugin config). */
export interface ContradictionWeightSettings {
  /** Weight a related link gets when the node carries none of its own. */
  defaultRelatedWeight: number
  /**
   * When false, per-node weights are ignored and every related link gets the
   * default: one project-wide answer instead of a per-tension one.
   */
  allowNodeOverride?: boolean
}

/** One tension's share of a goal's burden. */
export interface ContradictionBurdenContribution {
  contradictionId: string
  weight: number
  /** The node's stored reading; null means no evidence has been recorded yet. */
  intensity: number | null
  /** `intensity × weight`; 0 when intensity is null. */
  score: number
}

/**
 * Aggregated contradiction pressure on one goal.
 *
 * `total` is the sum of `intensity × weight` over every unresolved tension that
 * touches the goal. It is a relative burden score — meaningful when comparing
 * goals inside one project, not a physical quantity. A tension with no intensity
 * reading contributes 0 and is counted in `unmeasured`, so `total` is a floor
 * rather than a measurement whenever `unmeasured > 0`.
 */
export interface GoalContradictionBurden {
  goalId: string
  total: number
  /** Tensions that touch this goal and are still unresolved. */
  count: number
  /** The strongest single contribution. */
  peak: number
  /** Tensions counted in `count` that have no intensity reading yet. */
  unmeasured: number
  /** Strongest first. */
  contributions: ContradictionBurdenContribution[]
}

/** A contradiction plus the reading the burden needs; a full node satisfies it. */
export interface ContradictionBurdenSource extends ContradictionLinkSource {
  id: string
  intensity: number | null
  resolvedAt?: string
}

const unitWeight = (value: number): number => Math.min(1, Math.max(0, value))

/**
 * Resolve a contradiction's goal links to effective weights.
 *
 * Three sources merge, in precedence order:
 *
 * 1. `primaryGoalId` — always weight 1: the tension belongs to that goal.
 * 2. `relatedGoals` — explicit weights, honoured only when node overrides are
 *    allowed (`allowNodeOverride !== false`).
 * 3. `relatedGoalIds` — the pre-weight field. Every id not already covered gets
 *    `defaultRelatedWeight`, which is why an old node keeps working unchanged
 *    and why changing the configured default changes the answer for it.
 *
 * The result contains no goal twice and never lists the primary goal as a
 * related link.
 */
export function contradictionGoalLinks(
  node: ContradictionLinkSource,
  settings: ContradictionWeightSettings,
): ContradictionGoalLink[] {
  const fallback = unitWeight(settings.defaultRelatedWeight)
  const overrides = settings.allowNodeOverride !== false
  const explicit = new Map<string, number>()
  for (const link of node.relatedGoals ?? []) {
    if (link.goalId === node.primaryGoalId) continue
    if (overrides && !explicit.has(link.goalId)) explicit.set(link.goalId, unitWeight(link.weight))
  }

  const links: ContradictionGoalLink[] = [{ goalId: node.primaryGoalId, weight: 1 }]
  const seen = new Set<string>([node.primaryGoalId])
  for (const link of node.relatedGoals ?? []) {
    if (seen.has(link.goalId)) continue
    seen.add(link.goalId)
    links.push({ goalId: link.goalId, weight: explicit.get(link.goalId) ?? fallback })
  }
  for (const goalId of node.relatedGoalIds ?? []) {
    if (seen.has(goalId)) continue
    seen.add(goalId)
    links.push({ goalId, weight: fallback })
  }
  return links
}

/** How hard one tension presses on one goal; 0 when it does not touch it. */
export function contradictionGoalWeight(
  node: ContradictionLinkSource,
  goalId: string,
  settings: ContradictionWeightSettings,
): number {
  return contradictionGoalLinks(node, settings).find((link) => link.goalId === goalId)?.weight ?? 0
}

/**
 * Compute one goal's contradiction burden.
 *
 * Pure: the same nodes and settings always give the same number, so it can be
 * unit-tested without a store and fed straight into goal recommendation.
 * Resolved tensions are excluded — they remain in the tree as history but no
 * longer press on the goal.
 *
 * @param goalId - goal whose burden is wanted.
 * @param contradictions - every contradiction in the project.
 * @param settings - weight knobs, normally `config.contradictions`.
 * @returns the aggregated burden, with a per-tension breakdown.
 */
export function computeGoalContradictionBurden(
  goalId: string,
  contradictions: readonly ContradictionBurdenSource[],
  settings: ContradictionWeightSettings,
): GoalContradictionBurden {
  const contributions: ContradictionBurdenContribution[] = []
  let unmeasured = 0
  for (const node of contradictions) {
    if (node.resolvedAt !== undefined) continue
    const link = contradictionGoalLinks(node, settings).find((entry) => entry.goalId === goalId)
    if (link === undefined) continue
    if (node.intensity === null) unmeasured += 1
    contributions.push({
      contradictionId: node.id,
      weight: link.weight,
      intensity: node.intensity,
      score: (node.intensity ?? 0) * link.weight,
    })
  }
  contributions.sort((left, right) => right.score - left.score)
  return {
    goalId,
    total: contributions.reduce((sum, item) => sum + item.score, 0),
    count: contributions.length,
    peak: contributions[0]?.score ?? 0,
    unmeasured,
    contributions,
  }
}

export const ContradictionObservationSchema = z.object({
  id: SafeIdSchema,
  projectId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  contradictionId: SafeIdSchema,
  observedAt: IsoTimestampSchema,
  intensity: IntensitySchema.default(null),
  /** Trend computed from the prior observations inside the window. */
  computedTrend: TrendDirectionSchema.default('unknown'),
  evidence: z.array(z.string().min(1)).default([]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().default(''),
})
export type ContradictionObservation = z.infer<typeof ContradictionObservationSchema>

export const ObservationGradeSchema = z.enum(['A', 'B', 'C'])
export type ObservationGrade = z.infer<typeof ObservationGradeSchema>

/**
 * How one activity was judged against the tree.
 *
 * `unbound` is a statement about the *tree's* coverage, not about the activity's
 * direction: no goal claims any path the activity touched. It is not a weaker
 * `scope_drift` and must never be read as one — an activity nobody can place has
 * not been shown to serve anything else, so calling it drift would assert
 * something the judge never established. It is also not `uncertain`, which says
 * "I had too little to go on"; `unbound` says "I looked and the tree has no
 * claim on this", and the difference is what makes path-coverage measurable.
 *
 * Records written before this value existed carry only the first four. Some of
 * their `uncertain` rows were in truth unbound activities; that cannot be
 * recovered, so they are deliberately neither migrated nor guessed at.
 */
export const AlignmentDecisionSchema = z.enum([
  'aligned',
  'exploratory',
  'scope_drift',
  'uncertain',
  'unbound',
])
export type AlignmentDecision = z.infer<typeof AlignmentDecisionSchema>

export const MonitorCategorySchema = z.enum([
  'goal_alignment',
  'structure_validity',
  'judgment_quality',
])
export type MonitorCategory = z.infer<typeof MonitorCategorySchema>

export const DriftSignalTypeSchema = z.enum([
  'scope_drift',
  'core_bypass',
  'goal_staleness',
  'contradiction_shift',
  'repeated_failure_loop',
  /**
   * A dated goal is approaching or past its deadline with no recorded movement.
   *
   * Distinct from `goal_staleness`, which asks "has anything touched this goal
   * recently" without knowing whether the goal has a date at all. This one is
   * about the calendar: the question is not whether work happened, but whether
   * enough of it happened given how much time is left.
   */
  'deadline_risk',
])
export type DriftSignalType = z.infer<typeof DriftSignalTypeSchema>

export const ResponseLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
])
export type ResponseLevel = z.infer<typeof ResponseLevelSchema>

export const ActivitySourceSchema = z.enum(['tool_event', 'user_input', 'manual', 'turn'])
export type ActivitySource = z.infer<typeof ActivitySourceSchema>

export const ActivityRecordSchema = z.object({
  id: SafeIdSchema,
  /** Dedupe fingerprint: session+callId, session+seq, or a content hash. */
  eventFingerprint: z.string().min(1),
  projectId: z.string().min(1),
  sessionId: z.string().min(1),
  timestamp: IsoTimestampSchema,
  source: ActivitySourceSchema,
  observationGrade: ObservationGradeSchema,
  summary: z.string().min(1),
  evidence: z.array(z.string().min(1)).default([]),
  candidateGoalIds: z.array(SafeIdSchema).default([]),
  alignmentConfidence: z.union([z.number().min(0).max(1), z.null()]).default(null),
  decision: AlignmentDecisionSchema,
  rationale: z.string().default(''),
  /**
   * What the turn actually did, at tool-call granularity.
   *
   * Optional rather than defaulting to `[]` because the two absences mean
   * different things: `[]` says "this turn called no tools", `undefined` says
   * "this record predates the v4 collector and cannot be scored at all".
   * Collapsing them would make every historical record look like a quiet turn,
   * which is the failure mode the trajectory signals are least able to survive.
   *
   * Declared inline rather than importing the collector's type: this module sits
   * at the bottom of the dependency graph, and a store schema that imported
   * upward would make the collector impossible to test on its own.
   */
  trace: z
    .object({
      /** Every tool called in the turn, in order, noise tools included. */
      toolNames: z.array(z.string().min(1)).default([]),
      /** Tool results the turn produced, capped by the collector. */
      toolResults: z
        .array(
          z.object({
            tool: z.string().min(1),
            ok: z.union([z.boolean(), z.null()]).default(null),
            excerpt: z.string().default(''),
            outcome: z.enum(['tests-pass', 'tests-fail', 'build-pass', 'build-fail']).nullable().default(null),
            /**
             * A short digest of the call's arguments.
             *
             * Without it "the same call twice" is indistinguishable from "the same
             * tool twice", which is the difference between a stuck loop and normal
             * iteration. Defaults to empty for records written before it existed;
             * an absent signature reads as "unknown", not as a match with every
             * other absent one.
             */
            signature: z.string().default(''),
          }),
        )
        .default([]),
    })
    .optional(),
})
export type ActivityRecord = z.infer<typeof ActivityRecordSchema>

export const DriftSignalSchema = z.object({
  id: SafeIdSchema,
  projectId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  observedAt: IsoTimestampSchema,
  monitorCategory: MonitorCategorySchema,
  signalType: DriftSignalTypeSchema,
  level: ResponseLevelSchema,
  relatedGoalIds: z.array(SafeIdSchema).default([]),
  relatedContradictionIds: z.array(SafeIdSchema).default([]),
  activityIds: z.array(SafeIdSchema).default([]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().min(1)).default([]),
  /**
   * One or two Chinese lines a person can act on.
   *
   * Separate from `rationale` on purpose: the same string cannot both name the
   * exact threshold that fired for an auditor and tell the user what to do next.
   * Optional because the persist path (`service.ts`) constructs this record
   * field by field; wiring `hint` through it belongs to the task that owns that
   * file. The prompt channel falls back to a generic Chinese line rather than
   * showing the technical rationale.
   */
  hint: z.string().optional(),
  /**
   * How this signal reached the stream.
   *
   * `review` means a model second opinion preceded it (every signal written
   * before this field existed took that path, hence the default). `bypass`
   * means a high-precision rule published it directly. The distinction is what
   * lets the self-audit measure rules whose results are trusted without review.
   */
  reviewedBy: z.enum(['review', 'bypass']).default('review'),
  rationale: z.string().default(''),
  /** The pending intervention this signal escalated into, when any. */
  interventionId: SafeIdSchema.optional(),
})
export type DriftSignal = z.infer<typeof DriftSignalSchema>

export const InterventionDecisionSchema = z.enum([
  'continue',
  'realign',
  'modify_goals',
  'dismiss',
])
export type InterventionDecision = z.infer<typeof InterventionDecisionSchema>

export const InterventionStatusSchema = z.enum(['pending', 'resolved', 'superseded'])

export const InterventionLevelSchema = z.union([z.literal(2), z.literal(3)])

export const InterventionRecordSchema = z.object({
  id: SafeIdSchema,
  projectId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  signalId: SafeIdSchema,
  level: InterventionLevelSchema,
  status: InterventionStatusSchema.default('pending'),
  promptSummary: z.string().min(1),
  /**
   * Chinese one-or-two-line version of the same decision, for the prompt block
   * and the card header.
   *
   * Optional because records written before the split carry only
   * `promptSummary`; readers fall back to a generic Chinese line rather than
   * showing the technical summary to the user.
   */
  hint: z.string().optional(),
  suggestedActions: z.array(z.string().min(1)).default([]),
  decision: InterventionDecisionSchema.optional(),
  rationale: z.string().optional(),
  createdAt: IsoTimestampSchema,
  decidedAt: IsoTimestampSchema.optional(),
})
export type InterventionRecord = z.infer<typeof InterventionRecordSchema>

/** How one drift candidate was settled. */
export const JudgmentStatusSchema = z.enum(['pending', 'confirmed', 'dismissed'])

/**
 * One drift candidate, and what the program and a model each made of it.
 *
 * Written when a rule fires. It does not become a signal at that moment: a rule
 * judging a string like `pwsh (tool call)` produces mostly noise, so the operator
 * only hears about tension the program and a model agree on. The second verdict
 * arrives in an hourly batch rather than per activity, because judging one tool
 * call at a time is both expensive and blind to what the hour was about.
 *
 * The record outlives its decision on purpose. A log of what the rules got wrong
 * is the only evidence that can say whether they are improving.
 */
export const JudgmentRecordSchema = z.object({
  id: SafeIdSchema,
  projectId: z.string().min(1),
  createdAt: IsoTimestampSchema,
  /** Activity that triggered the candidate; empty for project-wide checks. */
  activityIds: z.array(SafeIdSchema).default([]),
  /** Signal class the program wanted to raise. */
  signalType: DriftSignalTypeSchema,
  /** Human-readable statement of what the program saw. */
  summary: z.string().default(''),
  /** Why the program called it drift. Kept even when the model disagrees. */
  programReason: z.string().default(''),
  /** The signal as the program drafted it, replayed verbatim on confirmation. */
  draft: z.unknown().optional(),
  /**
   * True when this candidate is a statistical sample of a bypassed signal.
   *
   * It is not evidence that the rule looked suspicious: the signal already
   * escalated directly, and this record exists only so the model's verdict can
   * enter the rule-health sample. Without the flag, a sampled candidate would
   * be indistinguishable from a normal queued one.
   */
  sampled: z.boolean().default(false),
  status: JudgmentStatusSchema.default('pending'),
  /** What the model said, once it has looked. */
  modelVerdict: z.enum(['drift', 'not_drift']).optional(),
  modelReason: z.string().optional(),
  /**
   * Which named rule the model's verdict rested on.
   *
   * Stored separately from `modelReason` because this is the half that can be
   * counted: "how often does the model reject us for hitting an excluded
   * activity" is a question about the rules, and free-form prose cannot answer
   * it. Absent on records written before this field existed.
   */
  modelWhy: z
    .enum([
      'no-matching-goal',
      'missed-success-criteria',
      'outside-allowed-methods',
      'hit-excluded-activity',
      'contradicts-goal',
      'unclear',
    ])
    .optional(),
  /** What the model suggested doing instead. Empty when it had nothing to add. */
  modelHowToAdjust: z.string().optional(),
  /** The model's own 0–1 confidence in this verdict. */
  modelConfidence: z.number().min(0).max(1).optional(),
  decidedAt: IsoTimestampSchema.optional(),
  /** True once the user has been told this entry exists. */
  notified: z.boolean().default(false),
})
export type JudgmentRecord = z.infer<typeof JudgmentRecordSchema>

/**
 * Normalise a goal node written before `depth` existed.
 *
 * Reading is deliberately lenient: a project initialised under the `L0`–`L3`
 * ladder must stay readable after the upgrade, otherwise an old tree would read as
 * corrupt and the only way forward would be rebuilding it by hand. The conversion
 * happens in memory here; it reaches disk the next time the tree is committed.
 *
 * @param raw - one record as stored.
 * @returns the same record, carrying `depth` when only `level` was present.
 */
function normaliseLegacyGoal(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object') return raw
  const node = raw as Record<string, unknown>
  if (typeof node.depth === 'number') return node
  const legacy = node.level
  if (typeof legacy !== 'string') return node
  const mapped = LEGACY_LEVEL_DEPTH[legacy]
  return mapped === undefined ? node : { ...node, depth: mapped }
}

/** A goal list that tolerates records written before `depth` existed. */
export const GoalNodeListSchema = z.preprocess(
  (value) => (Array.isArray(value) ? value.map(normaliseLegacyGoal) : value),
  z.array(GoalNodeSchema),
)

export const TreeSnapshotSchema = z.object({
  version: z.number().int().nonnegative(),
  projectId: z.string().min(1),
  createdAt: IsoTimestampSchema,
  reason: z.string().default(''),
  goals: GoalNodeListSchema,
  contradictions: z.array(ContradictionNodeSchema),
})
export type TreeSnapshot = z.infer<typeof TreeSnapshotSchema>

export const AuditActorSchema = z.enum(['user_confirmed', 'system_auto', 'manual_tool'])
export type AuditActor = z.infer<typeof AuditActorSchema>

export const AuditActionSchema = z.enum([
  'init_trees',
  /**
   * A confirmed tree was cleared so it can be derived again from scratch.
   *
   * Recorded with `beforeVersion === afterVersion`: the reset does not create a
   * new tree version, it removes the current one, and the version number is
   * reused by the confirmation that follows. Keeping the number stable is what
   * preserves every already-written snapshot.
   */
  'tree_reset',
  'update_l0',
  'update_l1',
  'update_lower_goal',
  'update_core_contradiction',
  'reclassify_contradiction',
  'resolve_intervention',
  'migrate_goal_depth',
  /**
   * A candidate tree was folded into the main tree.
   *
   * Distinct from `tree_reset` and from an ordinary edit: a reset removes the
   * yardstick, an edit adjusts it, a merge reconciles two of them. A later
   * reader asking "why does this node exist" needs to know it arrived from a
   * separate derivation rather than from the original one.
   */
  'merge_trees',
  /**
   * The monitor's record was cleared for this project.
   *
   * The tree survives; what moved aside is the evidence — activities, signals,
   * judgements, observations, reports. Recorded because a later reader comparing
   * counts across time needs to know the gap was deliberate rather than a
   * collection failure.
   */
  'purge',
])
export type AuditAction = z.infer<typeof AuditActionSchema>

export const AuditLogEntrySchema = z.object({
  id: SafeIdSchema,
  projectId: z.string().min(1),
  timestamp: IsoTimestampSchema,
  actor: AuditActorSchema,
  action: AuditActionSchema,
  beforeVersion: z.number().int().nonnegative(),
  afterVersion: z.number().int().nonnegative(),
  targetIds: z.array(SafeIdSchema).default([]),
  reason: z.string().default(''),
  evidence: z.array(z.string().min(1)).default([]),
  /** Previous entry's `entryHash`; `GENESIS` for the first record. */
  prevHash: z.string().min(1),
  /** SHA-256 over this entry's canonical fields plus `prevHash`. */
  entryHash: z.string().min(1),
})
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>

export const GeneratedReportSchema = z.object({
  id: SafeIdSchema,
  projectId: z.string().min(1),
  type: z.enum(['daily', 'weekly', 'monthly']),
  generatedAt: IsoTimestampSchema,
  periodStart: IsoTimestampSchema,
  periodEnd: IsoTimestampSchema,
  /** The `TreeSnapshot.version` this report was generated against. */
  goalTreeVersion: z.number().int().nonnegative(),
  observationIds: z.array(SafeIdSchema).default([]),
  signalIds: z.array(SafeIdSchema).default([]),
  interventionIds: z.array(SafeIdSchema).default([]),
  markdown: z.string(),
})
export type GeneratedReport = z.infer<typeof GeneratedReportSchema>

/** Marker used as `prevHash` on the first audit record of a project. */
export const GENESIS_HASH = 'GENESIS'

/**
 * Who the project belongs to and what surrounds it.
 *
 * Derivation cannot work without this. A model reading only the files can see
 * *what is being done*, but not *why it matters* — that lives in the user's
 * role, the intent behind the work, the constraints pressing on it, and who
 * consumes the result. Without this layer the model can only restate document
 * headings, which is transcription, not derivation.
 *
 * Stored on the project rather than passed per call: it is stable information,
 * and re-typing it every session is how it ends up omitted.
 */
export const ProjectContextSchema = z.object({
  /** The user's role in this project. */
  role: z.string().default(''),
  /** Why the project exists, in the user's own words. */
  intent: z.string().default(''),
  /** Known constraints: deadline, budget, headcount, compliance. */
  constraints: z.array(z.string()).default([]),
  /** Who consumes or is affected by the result. */
  stakeholders: z.array(z.string()).default([]),
  /**
   * What the project actually is, read from its own documents.
   *
   * Deliberately separate from `role`/`intent`: those describe the person, and a
   * model that only asks the user ends up with a goal tree that reflects what the
   * user *says* the project is rather than what the files show it doing. The two
   * layers are stored apart so a disagreement between them stays visible.
   */
  projectSummary: z.string().default(''),
  /** Which phase the documents indicate the project is in. */
  stage: z.string().default(''),
  /** What has to be handed over, and to whom. */
  deliverables: z.array(z.string()).default([]),
  updatedAt: IsoTimestampSchema.optional(),
})
export type ProjectContext = z.infer<typeof ProjectContextSchema>

/**
 * Persisted tree state for one project.
 *
 * `version` is the single monotonic counter guarding structural writes; every
 * mutation compares the caller's `expectedVersion` against it before writing.
 */
export const TreeStateSchema = z.object({
  projectId: z.string().min(1),
  version: z.number().int().nonnegative(),
  /** Whether `goal_tree_confirm` has run at least once for this project. */
  confirmed: z.boolean().default(false),
  /** Who this project belongs to; required input for derivation. */
  projectContext: ProjectContextSchema.optional(),
  /**
   * The dedicated conversation where this project's goals are derived and later
   * reviewed.
   *
   * Stored rather than looked up by title alone because a user may rename the
   * conversation afterwards; the id keeps the binding intact. The title remains
   * the fallback key when the id is missing (imported project, cleared store).
   */
  metacogSessionId: z.string().min(1).optional(),
  /**
   * Absolute path this project was derived from.
   *
   * Stored so a later process can rebuild the store without guessing: the project
   * id is a one-way hash of the path, so given only the id there is no way back.
   * Without this, a restart with no tool call leaves the periodic sweep with an
   * empty project list and it silently stops — the monitor looks alive and does
   * nothing.
   */
  projectRoot: z.string().min(1).optional(),
  goals: GoalNodeListSchema.default([]),
  contradictions: z.array(ContradictionNodeSchema).default([]),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
})
export type TreeState = z.infer<typeof TreeStateSchema>
