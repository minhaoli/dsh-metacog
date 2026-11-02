/**
 * Controlled structural editing: `goal_tree_edit` and `contradiction_tree_edit`.
 *
 * Both tools follow the same shape: read the current state at a caller-supplied
 * `expectedVersion`, apply the requested operations, re-validate the whole tree,
 * run the structural gate, then commit under CAS. A stale version is refused
 * rather than merged, because a metacognitive tree whose L0 changed underneath
 * an edit is not something a program should reconcile silently.
 *
 * @module dsh-metacog/tools/tree-edit
 */
import { randomUUID } from 'node:crypto'

import {
  ContradictionNodeSchema,
  ContradictionTypeSchema,
  ExplorationPolicySchema,
  GoalNodeSchema,
  GoalStatusSchema,
  MAX_GOAL_DEPTH,
  type ContradictionGoalLink,
  type ContradictionNode,
  type GoalNode,
  type GoalStatus,
} from '../data/types.js'
import { VersionConflictError } from '../data/store.js'
import {
  describeLeafActionability,
  inspectLeafActionability,
  leafActionabilityDetails,
} from '../analysis/collapse.js'
import {
  assertContradictionTreeShape,
  assertEvidence,
  assertGoalTreeShape,
  assertStructuralGate,
  computeChanges,
  contradictionsNeedingReview,
  GateError,
} from '../governance.js'
import { defineMetacogTool, loadProject, type ToolEnvironment } from './shared.js'
import type { ToolDefinition } from '../host.js'

/** Fields a caller may set on a goal. */
interface GoalPatch {
  title?: string
  description?: string
  status?: GoalStatus
  priority?: number
  successCriteria?: string[]
  evidence?: string[]
  relevantActivities?: string[]
  allowedMethods?: string[]
  excludedActivities?: string[]
  explorationPolicy?: 'allowed' | 'limited' | 'approval_required'
  /** Replacement path prefixes this goal owns; an empty array withdraws them. */
  paths?: string[]
  /** ISO timestamp; an empty string clears it back to "no deadline". */
  deadline?: string
  /** ISO timestamp; an empty string clears it back to "use createdAt". */
  startedAt?: string
}

/** A node to insert, addressed by its parent. */
interface GoalCreate extends GoalPatch {
  depth: number
  parentId: string
  title: string
}

/** Fields a caller may set on a contradiction. */
interface ContradictionPatch {
  title?: string
  description?: string
  poleA?: string
  poleB?: string
  type?: 'core' | 'main' | 'secondary' | 'unclassified'
  intensity?: number | null
  rationale?: string
  resolutionHint?: string
  evidence?: string[]
  primaryGoalId?: string
  relatedGoalIds?: string[]
  /**
   * Cross-goal links with an explicit weight (0–1).
   *
   * Preferred over `relatedGoalIds` when the strength matters; a bare id list
   * is read with `config.contradictions.defaultRelatedWeight`. Passing both is
   * refused, because two sources for one membership cannot be reconciled
   * silently.
   */
  relatedGoals?: { goalId: string; weight?: number }[]
  /**
   * Move this contradiction under another, or to the top level.
   *
   * Absent means "leave the parent alone"; `null` and an empty string both mean
   * "clear it" (the JSON schema cannot express null because the host validator
   * rejects type arrays, so an empty string is the wire form). The shape gate
   * rejects a missing parent and a parent chain that would loop.
   */
  parentId?: string | null
}

interface ContradictionCreate extends ContradictionPatch {
  title: string
  primaryGoalId: string
  poleA: string
  poleB: string
  evidence: string[]
  parentId?: string | null
}

/** Result of either edit tool. */
export interface EditResult {
  projectId: string
  version: number
  auditEntryId: string
  auditAction: string
  changedGoalIds: string[]
  changedContradictionIds: string[]
  reclassifiedContradictionIds: string[]
  addedGoalIds: string[]
  addedContradictionIds: string[]
  /**
   * Nodes that were deleted. Reported separately because a removal leaves no
   * trace in the surviving arrays: without this the reply and the audit entry
   * look identical to an edit that changed nothing.
   */
  removedGoalIds: string[]
  removedContradictionIds: string[]
  contradictionsNeedingReview: string[]
}

/**
 * Apply a patch to a goal, keeping identity and project binding intact.
 *
 * @param node - the existing node.
 * @param patch - caller-supplied changes.
 * @param now - timestamp for `updatedAt`.
 */
function applyGoalPatch(node: GoalNode, patch: GoalPatch, now: string): GoalNode {
  const alignment = {
    ...node.alignment,
    ...(patch.relevantActivities === undefined
      ? {}
      : { relevantActivities: patch.relevantActivities }),
    ...(patch.allowedMethods === undefined ? {} : { allowedMethods: patch.allowedMethods }),
    ...(patch.excludedActivities === undefined
      ? {}
      : { excludedActivities: patch.excludedActivities }),
    ...(patch.explorationPolicy === undefined
      ? {}
      : { explorationPolicy: patch.explorationPolicy }),
  }
  return GoalNodeSchema.parse({
    ...node,
    title: patch.title ?? node.title,
    description: patch.description ?? node.description,
    status: patch.status ?? node.status,
    priority: patch.priority ?? node.priority,
    successCriteria: patch.successCriteria ?? node.successCriteria,
    paths: patch.paths ?? node.paths,
    evidence: patch.evidence ?? node.evidence,
    // An empty string clears the field rather than storing "": the difference
    // between "no deadline" and "a deadline that is the empty string" matters to
    // every progress calculation downstream.
    ...(patch.deadline === undefined
      ? {}
      : patch.deadline.trim().length === 0
        ? { deadline: undefined }
        : { deadline: patch.deadline }),
    ...(patch.startedAt === undefined
      ? {}
      : patch.startedAt.trim().length === 0
        ? { startedAt: undefined }
        : { startedAt: patch.startedAt }),
    alignment,
    updatedAt: now,
  })
}

/** Cross-goal links with effective weights, validated before they reach the store. */
function buildRelatedGoals(
  entries: { goalId: string; weight?: number }[],
  defaultWeight: number,
  what: string,
): ContradictionGoalLink[] {
  const seen = new Set<string>()
  return entries.map((entry) => {
    const weight = entry.weight ?? defaultWeight
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
      throw new GateError(
        'INVALID_ARGS',
        `${what} has a cross-goal weight of ${weight}; a weight must be between 0 and 1 ` +
          '(the primary goal always counts as 1).',
        { weight },
      )
    }
    if (seen.has(entry.goalId)) {
      throw new GateError(
        'INVALID_ARGS',
        `${what} lists goal "${entry.goalId}" more than once; one goal has one weight per tension.`,
        { goalId: entry.goalId },
      )
    }
    seen.add(entry.goalId)
    return { goalId: entry.goalId, weight }
  })
}

/**
 * Resolve the related-goal fields of a patch into what the node stores.
 *
 * `relatedGoalIds` is the membership list and `relatedGoals` the optional
 * weights. When the caller replaces the ids, the old weights are dropped rather
 * than carried over: they belonged to a membership that no longer exists, and a
 * stale weight attached to a different goal is worse than the configured
 * default.
 */
function resolveRelatedGoals(
  patch: Pick<ContradictionPatch, 'relatedGoals' | 'relatedGoalIds'>,
  node: ContradictionNode,
  defaultWeight: number,
  what: string,
): { relatedGoalIds: string[]; relatedGoals: ContradictionGoalLink[] | undefined } {
  if (patch.relatedGoals !== undefined && patch.relatedGoalIds !== undefined) {
    throw new GateError(
      'INVALID_ARGS',
      `${what} passed both relatedGoals and relatedGoalIds; relatedGoals carries the weights, ` +
        'so pass only that one.',
      {},
    )
  }
  if (patch.relatedGoals !== undefined) {
    const relatedGoals = buildRelatedGoals(patch.relatedGoals, defaultWeight, what)
    return { relatedGoalIds: relatedGoals.map((link) => link.goalId), relatedGoals }
  }
  if (patch.relatedGoalIds !== undefined) {
    return { relatedGoalIds: patch.relatedGoalIds, relatedGoals: undefined }
  }
  return { relatedGoalIds: node.relatedGoalIds, relatedGoals: node.relatedGoals }
}

/**
 * Apply a patch to a contradiction.
 *
 * `trend` is deliberately absent from {@link ContradictionPatch}: it is derived
 * from recorded observations, so no edit tool can set it (spec 0.4 item 2).
 *
 * @param node - the existing node.
 * @param patch - caller-supplied changes.
 * @param now - timestamp for `updatedAt`.
 * @param defaultRelatedWeight - weight for a related link the patch does not weigh.
 */
function applyContradictionPatch(
  node: ContradictionNode,
  patch: ContradictionPatch,
  now: string,
  defaultRelatedWeight: number,
): ContradictionNode {
  const related = resolveRelatedGoals(
    patch,
    node,
    defaultRelatedWeight,
    `contradiction "${node.id}"`,
  )
  return ContradictionNodeSchema.parse({
    ...node,
    title: patch.title ?? node.title,
    description: patch.description ?? node.description,
    poleA: patch.poleA ?? node.poleA,
    poleB: patch.poleB ?? node.poleB,
    type: patch.type ?? node.type,
    // `0` is the wire encoding of "clear it": the schema cannot express null
    // because the host validator rejects type arrays.
    intensity:
      patch.intensity === undefined
        ? node.intensity
        : patch.intensity === 0
          ? null
          : patch.intensity,
    rationale: patch.rationale ?? node.rationale,
    resolutionHint: patch.resolutionHint ?? node.resolutionHint,
    evidence: patch.evidence ?? node.evidence,
    primaryGoalId: patch.primaryGoalId ?? node.primaryGoalId,
    relatedGoalIds: related.relatedGoalIds,
    relatedGoals: related.relatedGoals,
    // Empty string and null both clear the parent, matching the goal tools'
    // convention for "no value" on a field the JSON schema cannot mark nullable.
    parentId:
      patch.parentId === undefined
        ? node.parentId
        : patch.parentId === null || patch.parentId.trim() === ''
          ? null
          : patch.parentId,
    updatedAt: now,
  })
}

/**
 * Pick the audit action class implied by a change set.
 *
 * A core reclassification outranks everything, then L0, then L1, then lower
 * goals, so the audit trail names the most consequential thing that happened.
 *
 * @param changes - computed change set.
 * @param goals - the goal set before the change.
 * @param contradictions - the contradiction set before the change.
 */
function auditActionFor(
  changes: ReturnType<typeof computeChanges>,
  goals: GoalNode[],
  contradictions: ContradictionNode[],
): 'update_l0' | 'update_l1' | 'update_lower_goal' | 'update_core_contradiction' | 'reclassify_contradiction' {
  const goalById = new Map(goals.map((node) => [node.id, node]))
  const contradictionById = new Map(contradictions.map((node) => [node.id, node]))

  if (changes.reclassifiedContradictionIds.length > 0) return 'reclassify_contradiction'

  // Adding a tension is a contradiction change too. Without this the log said a
  // goal changed whenever a new contradiction appeared.
  if (changes.addedContradictionIds.length > 0) return 'reclassify_contradiction'
  if (changes.removedContradictionIds.length > 0) return 'reclassify_contradiction'

  const touchedCore = changes.changedContradictionIds.some((id) => {
    const node = contradictionById.get(id)
    return node !== undefined && node.type === 'core'
  })
  if (touchedCore) return 'update_core_contradiction'

  // A main or secondary contradiction is still a contradiction: reporting it as
  // `update_lower_goal` made the log say a goal changed when a tension did, and
  // a later reader cannot tell those two apart.
  if (changes.changedContradictionIds.length > 0) return 'reclassify_contradiction'

  const touchedRoot = changes.changedGoalIds.some((id) => goalById.get(id)?.depth === 0)
  if (touchedRoot) return 'update_l0'

  // A removed node is looked up in the *before* map, because it is gone from the
  // tree the caller just wrote. Deleting the root is the sharpest change there
  // is, so it must not fall through to the catch-all label.
  if (changes.removedGoalIds.some((id) => goalById.get(id)?.depth === 0)) return 'update_l0'

  const touchedStrategic = changes.changedGoalIds.some((id) => goalById.get(id)?.depth === 1)
  if (touchedStrategic) return 'update_l1'
  if (changes.removedGoalIds.some((id) => goalById.get(id)?.depth === 1)) return 'update_l1'

  return 'update_lower_goal'
}

/**
 * Register `goal_tree_edit`.
 *
 * @param env - shared tool environment.
 */
export function goalTreeEditTool(env: ToolEnvironment): ToolDefinition {
  return defineMetacogTool<EditResult>({
    name: 'goal_tree_edit',
    description:
      'Edit goal nodes under compare-and-set version control. Supports updating fields ' +
      '(including successCriteria and alignment rules), adding a child node and deleting a ' +
      'leaf. Changing a user-confirmed L0 requires userConfirmed: true plus a reason; any L1 ' +
      'change requires a reason and reports contradictions that now need re-evaluation. A ' +
      'stale expectedVersion is refused, never merged.',
    parameters: {
      type: 'object',
      properties: {
        expectedVersion: { type: 'integer', description: 'Version read from goal_tree_view.' },
        updates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              status: {
                type: 'string',
                enum: [...GoalStatusSchema.options],
              },
              priority: { type: 'integer' },
              successCriteria: { type: 'array', items: { type: 'string' } },
              paths: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Replacement path prefixes this goal owns, relative to the project root. An ' +
                  'empty array withdraws every claim. Matching is longest-prefix and ' +
                  'segment-aware, and it is many-to-many: several goals may own one path.',
              },
              evidence: { type: 'array', items: { type: 'string' } },
              relevantActivities: { type: 'array', items: { type: 'string' } },
              allowedMethods: { type: 'array', items: { type: 'string' } },
              excludedActivities: { type: 'array', items: { type: 'string' } },
              explorationPolicy: {
                type: 'string',
                enum: [...ExplorationPolicySchema.options],
              },
              deadline: {
                type: 'string',
                description:
                  'ISO timestamp this goal is due. Pass an empty string to clear it. Goals ' +
                  'without a deadline get no staged progress reminders.',
              },
              startedAt: {
                type: 'string',
                description:
                  'ISO timestamp work began. Reminder stages are fractions of startedAt→deadline, ' +
                  'so this decides when the 1/4, 1/2 and 3/4 checkpoints fall. Empty string ' +
                  'clears it back to createdAt.',
              },
            },
            required: ['id'],
          },
        },
        creates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              depth: { type: 'integer', minimum: 1, maximum: MAX_GOAL_DEPTH },
              parentId: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              successCriteria: { type: 'array', items: { type: 'string' } },
              paths: { type: 'array', items: { type: 'string' } },
              evidence: { type: 'array', items: { type: 'string' } },
            },
            required: ['depth', 'parentId', 'title'],
          },
        },
        removes: {
          type: 'array',
          description:
            'Ids of leaf goals to delete permanently. Refused when the node still has ' +
            'children, or when a contradiction still references it — a dangling link would ' +
            'leave the tree reporting a tension about a goal that no longer exists.',
          items: { type: 'string' },
        },
        reason: { type: 'string', description: 'Why this change is happening (audited).' },
        allowNonActionableLeaves: {
          type: 'boolean',
          description:
            'Accept an edit that leaves (or creates) a leaf with no checkable successCriteria. ' +
            'Default refuse: a leaf is the deepest, most concrete level, so one without a ' +
            'verifiable completion condition can never be judged done. Passing true additionally ' +
            'requires a non-empty reason. The check runs over the whole edited tree, not only the ' +
            'nodes this call touched, so a legacy leaf cannot escape it forever.',
        },
        userConfirmed: {
          type: 'boolean',
          description:
            'Required true when modifying a user-confirmed L0 root goal. Only set it when the ' +
            'user has actually confirmed the change in this conversation.',
        },
        actorHint: {
          type: 'string',
          enum: ['user', 'model'],
          description:
            'Who initiated this write. "user" makes the audit record user_confirmed; used by the ' +
            'slash commands, where the user typed the change themselves.',
        },
      },
      required: ['expectedVersion'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    async run(args, exec) {
      const input = (args ?? {}) as unknown as {
        expectedVersion?: number
        updates?: (GoalPatch & { id: string })[]
        creates?: GoalCreate[]
        removes?: string[]
        reason?: string
        allowNonActionableLeaves?: boolean
        userConfirmed?: boolean
        /**
         * Set to `'user'` when the write came from a command the user typed
         * themselves. The audit then records `user_confirmed` rather than
         * `manual_tool`, because "a model called this" and "the user did this"
         * are different facts about the same change.
         */
        actorHint?: 'user' | 'model'
      }
      if (typeof input.expectedVersion !== 'number') {
        throw new GateError('INVALID_ARGS', 'expectedVersion is required and must be an integer')
      }
      const { projectId, store } = await loadProject(env, exec)
      const current = await store.readState(projectId)
      if (current === undefined) {
        throw new GateError('NOT_INITIALIZED', 'no tree exists; run goal_tree_init first.')
      }
      if (current.confirmed !== true) {
        throw new GateError(
          'NOT_CONFIRMED',
          'the tree is still an unconfirmed draft; run goal_tree_confirm before editing it.',
        )
      }

      const now = new Date().toISOString()
      const goals: GoalNode[] = current.goals.map((node) => GoalNodeSchema.parse(node))

      // Updates first: a create may reference a node this call renames.
      for (const patch of input.updates ?? []) {
        const index = goals.findIndex((node) => node.id === patch.id)
        const existing = index < 0 ? undefined : goals[index]
        if (existing === undefined) {
          throw new GateError('UNKNOWN_GOAL', `goal "${patch.id}" does not exist`, {
            id: patch.id,
          })
        }
        if (patch.evidence !== undefined) {
          assertEvidence(patch.evidence, `goal "${patch.id}"`)
        }
        goals[index] = applyGoalPatch(existing, patch, now)
      }

      for (const create of input.creates ?? []) {
        const parent = goals.find((node) => node.id === create.parentId)
        if (parent === undefined) {
          throw new GateError(
            'UNKNOWN_GOAL',
            `cannot create "${create.title}": parent "${create.parentId}" does not exist`,
            { parentId: create.parentId },
          )
        }
        if (create.evidence !== undefined) {
          assertEvidence(create.evidence, `goal "${create.title}"`)
        }
        goals.push(
          GoalNodeSchema.parse({
            id: `G${create.depth}_${randomUUID()}`,
            projectId,
            parentId: create.parentId,
            depth: create.depth,
            title: create.title,
            description: create.description ?? '',
            status: create.status ?? 'active',
            priority: create.priority ?? 0,
            // A node the user creates in a confirmed tree is itself confirmed.
            confirmedByUser: true,
            successCriteria: create.successCriteria ?? [],
            paths: create.paths ?? [],
            alignment: {
              relevantActivities: create.relevantActivities ?? [],
              allowedMethods: create.allowedMethods ?? [],
              excludedActivities: create.excludedActivities ?? [],
            },
            evidence: create.evidence ?? [`confirmed by user: ${now}`],
            createdAt: now,
            updatedAt: now,
          }),
        )
      }

      for (const id of input.removes ?? []) {
        if (!goals.some((node) => node.id === id)) {
          throw new GateError('UNKNOWN_GOAL', `goal "${id}" does not exist`, { id })
        }
        const child = goals.find((node) => node.parentId === id)
        if (child !== undefined) {
          throw new GateError(
            'NOT_A_LEAF',
            `goal "${id}" still has child "${child.id}"; removing it would orphan a subtree. ` +
              'Remove or reparent the children first.',
            { id, childId: child.id },
          )
        }
        // Dangling links are caught after the loop by the whole-tree check
        // below, which reports every broken reference at once instead of only
        // the first one this loop happens to hit.
        goals.splice(
          goals.findIndex((node) => node.id === id),
          1,
        )
      }

      assertGoalTreeShape(goals)

      // Contradiction links must survive the goal edit: a removed goal leaves
      // dangling tension links, which the store would happily persist.
      const goalIds = new Set(goals.map((node) => node.id))
      const dangling = current.contradictions.filter(
        (node) =>
          !goalIds.has(node.primaryGoalId) ||
          node.relatedGoalIds.some((id) => !goalIds.has(id)),
      )
      if (dangling.length > 0) {
        throw new GateError(
          'CONTRADICTION_LINK_BROKEN',
          `this edit would leave contradictions pointing at removed goals: ` +
            `${dangling.map((node) => node.id).join(', ')}. Update those contradictions in ` +
            'contradiction_tree_edit first.',
          { contradictionIds: dangling.map((node) => node.id) },
        )
      }

      const changes = computeChanges(
        current.goals,
        goals,
        current.contradictions,
        current.contradictions,
      )
      assertStructuralGate(changes, current.goals, current.contradictions, {
        userConfirmed: input.userConfirmed,
        reason: input.reason,
      })

      // Hierarchical semantics last, after every structural and governance check
      // (tree shape, dangling contradiction links, and the structural gate that
      // reports CORE_RATIONALE_REQUIRED / L1_REASON_REQUIRED). Those describe a
      // caller's real bug in structure or authority; refusing here first would
      // mask them and send the caller to edit a criterion that was never the
      // problem. Ordering is part of the contract: the most fundamental failure
      // speaks first.
      //
      // This is not CRITERIA_REQUIRED (that gate lives on the confirm path and
      // asks whether an activity can be matched); this asks whether the deepest,
      // most concrete level is executable at all.
      //
      // Whole tree, not just the nodes this call touched. A legacy leaf that
      // escaped the rule would otherwise escape it forever — every later edit
      // would also look "unrelated" — and a tree whose leaves cannot be verified
      // keeps producing goals that are never finished or never closed. The cost
      // is that an old tree refuses its next structural edit until the offending
      // leaves are given criteria; the refusal names all of them in one pass, and
      // `allowNonActionableLeaves` parks that work deliberately, with a reason.
      const leafReport = inspectLeafActionability(goals)
      if (leafReport.issues.length > 0) {
        if (input.allowNonActionableLeaves !== true) {
          throw new GateError(
            'LEAF_NOT_ACTIONABLE',
            describeLeafActionability(leafReport),
            leafActionabilityDetails(leafReport),
          )
        }
        if ((input.reason ?? '').trim().length === 0) {
          throw new GateError(
            'REASON_REQUIRED',
            'allowNonActionableLeaves requires a non-empty reason; the audit entry is the only ' +
              'record that a leaf which cannot be verified was accepted on purpose. ' +
              `${leafReport.issues.length} leaf goals are currently not executable: ` +
              `${leafReport.issues.map((issue) => `"${issue.title}"`).join('; ')}.`,
            leafActionabilityDetails(leafReport),
          )
        }
      }

      const action = auditActionFor(changes, current.goals, current.contradictions)
      // Same reason as the contradiction tool: a removed goal has no surviving
      // record, so the audit is the only place it can be traced from.
      const targetIds = [
        ...new Set([...changes.changedGoalIds, ...changes.addedGoalIds, ...changes.removedGoalIds]),
      ]

      const result = await store.commit(projectId, {
        expectedVersion: input.expectedVersion,
        goals,
        contradictions: current.contradictions,
        reason: (input.reason ?? '').trim(),
        action,
        actor: input.userConfirmed === true || input.actorHint === 'user' ? 'user_confirmed' : 'manual_tool',
        targetIds,
        evidence: [...new Set(targetIds.flatMap((id) => goals.find((n) => n.id === id)?.evidence ?? []))],
      })

      return {
        projectId,
        version: result.state.version,
        auditEntryId: result.audit.id,
        auditAction: action,
        changedGoalIds: changes.changedGoalIds,
        changedContradictionIds: [],
        reclassifiedContradictionIds: [],
        addedGoalIds: changes.addedGoalIds,
        addedContradictionIds: [],
        removedGoalIds: changes.removedGoalIds,
        removedContradictionIds: [],
        // L1 changes invalidate tensions derived from the old strategy.
        contradictionsNeedingReview: contradictionsNeedingReview(
          current.contradictions,
          changes.changedGoalIds,
        ),
      }
    },
  })
}

/**
 * Register `contradiction_tree_edit`.
 *
 * @param env - shared tool environment.
 */
export function contradictionTreeEditTool(env: ToolEnvironment): ToolDefinition {
  return defineMetacogTool<EditResult>({
    name: 'contradiction_tree_edit',
    description:
      'Edit contradiction nodes under compare-and-set version control. Changing or ' +
      'reclassifying a confirmed core contradiction requires userConfirmed: true plus a ' +
      'reason. Intensity may be set here only with supporting evidence; trend cannot be set ' +
      'by any tool because it is computed from recorded observations. primaryGoalId and ' +
      'relatedGoalIds are independent of the contradiction tree\'s own parentId.',
    parameters: {
      type: 'object',
      properties: {
        expectedVersion: { type: 'integer' },
        updates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              poleA: { type: 'string' },
              poleB: { type: 'string' },
              type: {
                type: 'string',
                enum: [...ContradictionTypeSchema.options],
              },
              intensity: {
                type: 'integer',
                minimum: 0,
                maximum: 5,
                description:
                  '1–5; 0 clears it to null when evidence is insufficient. Omit to keep the ' +
                  'current value. Setting it here is for corrections only; ongoing ' +
                  'measurements belong in recorded observations.',
              },
              rationale: { type: 'string' },
              resolutionHint: { type: 'string' },
              evidence: { type: 'array', items: { type: 'string' } },
              primaryGoalId: { type: 'string' },
              relatedGoalIds: { type: 'array', items: { type: 'string' } },
              relatedGoals: {
                type: 'array',
                description:
                  '跨目标张力权重（0–1）；与 relatedGoalIds 二选一。未给 weight 的条目取配置默认权重。',
                items: {
                  type: 'object',
                  properties: {
                    goalId: { type: 'string' },
                    weight: { type: 'number', minimum: 0, maximum: 1 },
                  },
                  required: ['goalId'],
                  additionalProperties: false,
                },
              },
              parentId: {
                type: 'string',
                description:
                  '把这条矛盾挂到另一个矛盾下；空字符串表示移到顶层。父节点不存在或父链成环会被拒绝。',
              },
            },
            required: ['id'],
          },
        },
        creates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              poleA: { type: 'string' },
              poleB: { type: 'string' },
              type: { type: 'string', enum: [...ContradictionTypeSchema.options] },
              primaryGoalId: { type: 'string' },
              relatedGoalIds: { type: 'array', items: { type: 'string' } },
              evidence: { type: 'array', items: { type: 'string' } },
              rationale: { type: 'string' },
              resolutionHint: { type: 'string' },
              parentId: { type: 'string' },
            },
            required: ['title', 'poleA', 'poleB', 'primaryGoalId'],
          },
        },
        removes: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string' },
        userConfirmed: {
          type: 'boolean',
          description:
            'Required true when changing or reclassifying a confirmed core contradiction.',
        },
        actorHint: {
          type: 'string',
          enum: ['user', 'model'],
          description:
            'Who initiated this write. "user" makes the audit record user_confirmed; used by the ' +
            'slash commands, where the user typed the change themselves.',
        },
      },
      required: ['expectedVersion'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    async run(args, exec) {
      const input = (args ?? {}) as unknown as {
        expectedVersion?: number
        updates?: (ContradictionPatch & { id: string })[]
        creates?: ContradictionCreate[]
        removes?: string[]
        reason?: string
        userConfirmed?: boolean
        /** See `goal_tree_edit`: `'user'` records the audit actor as user_confirmed. */
        actorHint?: 'user' | 'model'
      }
      if (typeof input.expectedVersion !== 'number') {
        throw new GateError('INVALID_ARGS', 'expectedVersion is required and must be an integer')
      }
      const { projectId, store } = await loadProject(env, exec)
      const current = await store.readState(projectId)
      if (current === undefined) {
        throw new GateError('NOT_INITIALIZED', 'no tree exists; run goal_tree_init first.')
      }
      if (current.confirmed !== true) {
        throw new GateError(
          'NOT_CONFIRMED',
          'the tree is still an unconfirmed draft; run goal_tree_confirm before editing it.',
        )
      }

      const now = new Date().toISOString()
      const contradictions: ContradictionNode[] = current.contradictions.map((node) =>
        ContradictionNodeSchema.parse(node),
      )

      for (const patch of input.updates ?? []) {
        const index = contradictions.findIndex((node) => node.id === patch.id)
        const existing = index < 0 ? undefined : contradictions[index]
        if (existing === undefined) {
          throw new GateError('UNKNOWN_CONTRADICTION', `contradiction "${patch.id}" does not exist`, {
            id: patch.id,
          })
        }
        if (patch.evidence !== undefined) {
          assertEvidence(patch.evidence, `contradiction "${patch.id}"`)
        }
        const next = applyContradictionPatch(
          existing,
          patch,
          now,
          env.config.contradictions.defaultRelatedWeight,
        )
        // A core classification must always explain itself (spec 2.2 item 1).
        if (next.type === 'core' && next.rationale.trim().length === 0) {
          throw new GateError(
            'CORE_RATIONALE_REQUIRED',
            `contradiction "${patch.id}" is being classified core without a rationale tying ` +
              'it to the L0 root goal.',
            { id: patch.id },
          )
        }
        contradictions[index] = next
      }

      for (const create of input.creates ?? []) {
        assertEvidence(create.evidence ?? [], `contradiction "${create.title}"`)
        if ((create.type ?? 'unclassified') === 'core' && (create.rationale ?? '').trim().length === 0) {
          throw new GateError(
            'CORE_RATIONALE_REQUIRED',
            `new core contradiction "${create.title}" needs a rationale explaining its ` +
              'structural link to L0.',
            { title: create.title },
          )
        }
        if (create.relatedGoals !== undefined && create.relatedGoalIds !== undefined) {
          throw new GateError(
            'INVALID_ARGS',
            `new contradiction "${create.title}" passed both relatedGoals and relatedGoalIds; ` +
              'relatedGoals carries the weights, so pass only that one.',
            { title: create.title },
          )
        }
        const relatedGoals =
          create.relatedGoals === undefined
            ? undefined
            : buildRelatedGoals(
                create.relatedGoals,
                env.config.contradictions.defaultRelatedWeight,
                `new contradiction "${create.title}"`,
              )
        const relatedGoalIds =
          relatedGoals === undefined
            ? (create.relatedGoalIds ?? [])
            : relatedGoals.map((link) => link.goalId)
        contradictions.push(
          ContradictionNodeSchema.parse({
            id: `C_${randomUUID()}`,
            projectId,
            // Empty string and null both mean "top level"; the shape gate below
            // rejects a parent id that does not exist in the proposed tree.
            parentId:
              create.parentId === undefined ||
              create.parentId === null ||
              create.parentId.trim() === ''
                ? null
                : create.parentId,
            primaryGoalId: create.primaryGoalId,
            relatedGoalIds,
            relatedGoals,
            type: create.type ?? 'unclassified',
            confirmedByUser: true,
            title: create.title,
            description: create.description ?? '',
            poleA: create.poleA,
            poleB: create.poleB,
            intensity: null,
            // Trend always starts unknown: only observations may move it.
            trend: 'unknown',
            rationale: create.rationale ?? '',
            resolutionHint: create.resolutionHint ?? '',
            evidence: create.evidence,
            createdAt: now,
            updatedAt: now,
          }),
        )
      }

      for (const id of input.removes ?? []) {
        if (!contradictions.some((node) => node.id === id)) {
          throw new GateError('UNKNOWN_CONTRADICTION', `contradiction "${id}" does not exist`, {
            id,
          })
        }
        const child = contradictions.find((node) => node.parentId === id)
        if (child !== undefined) {
          throw new GateError(
            'NOT_A_LEAF',
            `contradiction "${id}" still has child "${child.id}"; reparent or remove it first.`,
            { id, childId: child.id },
          )
        }
        contradictions.splice(
          contradictions.findIndex((node) => node.id === id),
          1,
        )
      }

      assertContradictionTreeShape(contradictions, current.goals)

      const changes = computeChanges(
        current.goals,
        current.goals,
        current.contradictions,
        contradictions,
      )
      assertStructuralGate(changes, current.goals, current.contradictions, {
        userConfirmed: input.userConfirmed,
        reason: input.reason,
      })

      const action = auditActionFor(changes, current.goals, current.contradictions)
      // A removed id is the one target that no longer exists to be looked up
      // later, so leaving it out of the audit makes the deletion untraceable.
      const targetIds = [
        ...new Set([
          ...changes.changedContradictionIds,
          ...changes.addedContradictionIds,
          ...changes.removedContradictionIds,
        ]),
      ]

      const result = await store.commit(projectId, {
        expectedVersion: input.expectedVersion,
        goals: current.goals,
        contradictions,
        reason: (input.reason ?? '').trim(),
        action,
        actor: input.userConfirmed === true || input.actorHint === 'user' ? 'user_confirmed' : 'manual_tool',
        targetIds,
        evidence: [
          ...new Set(
            targetIds.flatMap((id) => contradictions.find((n) => n.id === id)?.evidence ?? []),
          ),
        ],
      })

      return {
        projectId,
        version: result.state.version,
        auditEntryId: result.audit.id,
        auditAction: action,
        changedGoalIds: [],
        changedContradictionIds: changes.changedContradictionIds,
        reclassifiedContradictionIds: changes.reclassifiedContradictionIds,
        addedGoalIds: [],
        addedContradictionIds: changes.addedContradictionIds,
        removedGoalIds: [],
        removedContradictionIds: changes.removedContradictionIds,
        contradictionsNeedingReview: [],
      }
    },
  })
}

export { VersionConflictError }
