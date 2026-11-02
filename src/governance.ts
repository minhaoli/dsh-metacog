/**
 * Structural change governance: the rules that decide whether a proposed tree
 * edit may reach the store at all.
 *
 * The spec's gate requirements live here rather than inside the tool
 * definitions, so every path that mutates structure — a tool call, a
 * confirmation, a future automated reclassification — passes the same checks.
 *
 * Three rules, each with a distinct failure mode:
 *
 * 1. L0 and confirmed `core` contradiction changes require an explicit
 *    `userConfirmed: true` plus a non-empty `reason`.
 * 2. L1 changes always require a reason and mark dependent contradictions for
 *    re-evaluation, because a strategy shift invalidates tensions derived from
 *    the old strategy.
 * 3. Tree shape invariants (exactly one L0, valid parents, no goal cycles) are
 *    validated regardless of who is acting.
 *
 * @module dsh-metacog/governance
 */
import { type ContradictionNode, type GoalNode } from './data/types.js'

/** A rejection with a stable code, rendered to the model as a refusal. */
export class GateError extends Error {
  readonly code: string
  constructor(
    code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'GateError'
    this.code = code
  }
}

/** Evidence that one node changed, keyed by kind. */
export interface ChangeSet {
  /** Goal ids whose content changed. */
  changedGoalIds: string[]
  /** Contradiction ids whose content changed. */
  changedContradictionIds: string[]
  /** Contradiction ids whose `type` changed. */
  reclassifiedContradictionIds: string[]
  /** Contradiction ids added. */
  addedContradictionIds: string[]
  /** Goal ids added. */
  addedGoalIds: string[]
  /**
   * Goal ids that existed before and are gone now.
   *
   * Removals leave no trace in the surviving arrays, so a caller comparing
   * before and after sees nothing at all unless the difference is stated here.
   */
  removedGoalIds: string[]
  /** Contradiction ids that existed before and are gone now. */
  removedContradictionIds: string[]
}

/** Fields compared when deciding whether a node genuinely changed. */
const GOAL_COMPARED_FIELDS = [
  'parentId',
  'depth',
  'title',
  'description',
  'status',
  'priority',
  'successCriteria',
  'alignment',
  'evidence',
  // A deadline change is a real change to the yardstick: it moves every
  // progress checkpoint for that goal. Leaving it out made the edit land with an
  // empty `changedGoalIds`, so the audit could not say which goal moved.
  'deadline',
  'startedAt',
] as const

const CONTRADICTION_COMPARED_FIELDS = [
  'parentId',
  'primaryGoalId',
  'relatedGoalIds',
  'type',
  'title',
  'description',
  'poleA',
  'poleB',
  'rationale',
  'resolutionHint',
  'evidence',
  'intensity',
] as const

/**
 * Stable JSON projection used for field comparison.
 *
 * @param value - any JSON value.
 */
function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableKey(item)}`)
  return `{${entries.join(',')}}`
}

/**
 * Compute which nodes a proposed tree actually changes.
 *
 * `confirmedByUser` and timestamps are excluded: flipping the confirmation bit
 * is what `goal_tree_confirm` does, and it must not count as an L0 content edit
 * requiring a second confirmation.
 *
 * @param beforeGoals - current goals.
 * @param afterGoals - proposed goals.
 * @param beforeContradictions - current contradictions.
 * @param afterContradictions - proposed contradictions.
 */
export function computeChanges(
  beforeGoals: GoalNode[],
  afterGoals: GoalNode[],
  beforeContradictions: ContradictionNode[],
  afterContradictions: ContradictionNode[],
): ChangeSet {
  const beforeGoalMap = new Map(beforeGoals.map((node) => [node.id, node]))
  const changedGoalIds: string[] = []
  const addedGoalIds: string[] = []

  for (const node of afterGoals) {
    const previous = beforeGoalMap.get(node.id)
    if (previous === undefined) {
      addedGoalIds.push(node.id)
      continue
    }
    for (const field of GOAL_COMPARED_FIELDS) {
      if (stableKey(previous[field]) !== stableKey(node[field])) {
        changedGoalIds.push(node.id)
        break
      }
    }
  }

  const beforeContradictionMap = new Map(beforeContradictions.map((node) => [node.id, node]))
  const changedContradictionIds: string[] = []
  const reclassifiedContradictionIds: string[] = []
  const addedContradictionIds: string[] = []

  for (const node of afterContradictions) {
    const previous = beforeContradictionMap.get(node.id)
    if (previous === undefined) {
      addedContradictionIds.push(node.id)
      continue
    }
    // Reclassification is the sharpest form of contradiction change.
    if (previous.type !== node.type) reclassifiedContradictionIds.push(node.id)
    for (const field of CONTRADICTION_COMPARED_FIELDS) {
      if (stableKey(previous[field]) !== stableKey(node[field])) {
        changedContradictionIds.push(node.id)
        break
      }
    }
  }

  const removedGoalIds = beforeGoals
    .map((node) => node.id)
    .filter((id) => !afterGoals.some((node) => node.id === id))
  const removedContradictionIds = beforeContradictions
    .map((node) => node.id)
    .filter((id) => !afterContradictions.some((node) => node.id === id))

  return {
    changedGoalIds,
    changedContradictionIds,
    reclassifiedContradictionIds,
    addedContradictionIds,
    addedGoalIds,
    removedGoalIds,
    removedContradictionIds,
  }
}

/** Caller-supplied authorization context for a structural write. */
export interface AuthorizationContext {
  /** Whether the user explicitly confirmed this exact change. */
  userConfirmed?: boolean
  /** Why the change is happening. */
  reason?: string
}

/**
 * Enforce the L0 / core-contradiction second-confirmation gate.
 *
 * @param changes - what the proposal would alter.
 * @param beforeGoals - current goals, for level lookup.
 * @param beforeContradictions - current contradictions, for type lookup.
 * @param authorization - the caller's confirmation claims.
 * @throws {GateError} `L0_CONFIRMATION_REQUIRED`, `CORE_CONFIRMATION_REQUIRED`,
 *   `REASON_REQUIRED`, or `L1_REASON_REQUIRED`.
 */
export function assertStructuralGate(
  changes: ChangeSet,
  beforeGoals: GoalNode[],
  beforeContradictions: ContradictionNode[],
  authorization: AuthorizationContext,
): void {
  const reason = (authorization.reason ?? '').trim()
  const goalById = new Map(beforeGoals.map((node) => [node.id, node]))
  const contradictionById = new Map(beforeContradictions.map((node) => [node.id, node]))

  // Only *confirmed* root edits are gated: a draft root is still a candidate, and
  // demanding a second confirmation to shape a draft would make init unusable.
  const touchesConfirmedRoot = changes.changedGoalIds.some((id) => {
    const node = goalById.get(id)
    return node !== undefined && node.depth === 0 && node.confirmedByUser
  })
  if (touchesConfirmedRoot) {
    if (authorization.userConfirmed !== true) {
      throw new GateError(
        'L0_CONFIRMATION_REQUIRED',
        'modifying the confirmed root goal requires userConfirmed: true. ' +
          'The root is the project\'s single stated reason for existing; the program will not ' +
          'rewrite it without an explicit confirmation from the user.',
        { targetIds: changes.changedGoalIds },
      )
    }
    if (reason.length === 0) {
      throw new GateError(
        'REASON_REQUIRED',
        'modifying the confirmed root goal requires a non-empty reason, ' +
          'which is recorded in the audit log.',
        { targetIds: changes.changedGoalIds },
      )
    }
  }

  // Core contradictions: text edits or reclassification both need confirmation.
  const touchesConfirmedCore = [
    ...changes.changedContradictionIds,
    ...changes.reclassifiedContradictionIds,
  ].some((id) => {
    const node = contradictionById.get(id)
    return node !== undefined && node.type === 'core' && node.confirmedByUser
  })
  if (touchesConfirmedCore) {
    if (authorization.userConfirmed !== true) {
      throw new GateError(
        'CORE_CONFIRMATION_REQUIRED',
        'modifying or reclassifying a confirmed core contradiction requires ' +
          'userConfirmed: true, because it changes the diagnosis of the project\'s ' +
          'structural tension.',
        {
          targetIds: [
            ...new Set([
              ...changes.changedContradictionIds,
              ...changes.reclassifiedContradictionIds,
            ]),
          ],
        },
      )
    }
    if (reason.length === 0) {
      throw new GateError(
        'REASON_REQUIRED',
        'modifying or reclassifying a confirmed core contradiction requires a ' +
          'non-empty reason explaining the new structural evidence.',
        { targetIds: changes.changedContradictionIds },
      )
    }
  }

  // Depth-1 changes always need a reason: a strategy shift must be explainable.
  const touchesStrategic = changes.changedGoalIds.some((id) => {
    const node = goalById.get(id)
    return node !== undefined && node.depth === 1
  })
  if (touchesStrategic && reason.length === 0) {
    throw new GateError(
      'L1_REASON_REQUIRED',
      'changing a depth-1 strategic goal requires a non-empty reason, which is ' +
        'recorded in the audit log and triggers re-evaluation of dependent ' +
        'contradictions.',
      { targetIds: changes.changedGoalIds },
    )
  }
}

/**
 * Validate the shape of a goal tree.
 *
 * @param goals - proposed goal nodes.
 * @throws {GateError} with code `TREE_SHAPE` describing the first violation.
 */
export function assertGoalTreeShape(goals: GoalNode[]): void {
  const byId = new Map<string, GoalNode>()
  for (const node of goals) {
    if (byId.has(node.id)) {
      throw new GateError('TREE_SHAPE', `duplicate goal id "${node.id}"`, { id: node.id })
    }
    byId.set(node.id, node)
  }

  const roots = goals.filter((node) => node.depth === 0)
  if (roots.length > 1) {
    throw new GateError(
      'TREE_SHAPE',
      `exactly one depth-0 root goal is allowed, found ${roots.length}: ` +
        `${roots.map((node) => node.id).join(', ')}. The root is the single reason the project exists.`,
      { ids: roots.map((node) => node.id) },
    )
  }

  for (const node of goals) {
    // The parent must exist and be strictly shallower. Not adjacent: real
    // derivations legitimately jump a layer, and forcing adjacency invents
    // intermediate nodes that exist only to satisfy the checker.
    if (node.parentId !== null) {
      const parent = byId.get(node.parentId)
      if (parent === undefined) {
        throw new GateError(
          'TREE_SHAPE',
          `goal "${node.id}" references missing parent "${node.parentId}"`,
          { id: node.id, parentId: node.parentId },
        )
      }
      if (parent.depth >= node.depth) {
        throw new GateError(
          'TREE_SHAPE',
          `goal "${node.id}" is at depth ${node.depth} and needs a parent shallower than that, ` +
            `but parent "${parent.id}" is at depth ${parent.depth}`,
          { id: node.id, parentId: parent.id, depth: node.depth, parentDepth: parent.depth },
        )
      }
    } else if (node.depth !== 0) {
      throw new GateError(
        'TREE_SHAPE',
        `goal "${node.id}" is at depth ${node.depth} and therefore needs a parent`,
        { id: node.id, depth: node.depth },
      )
    }
  }

  // Cycle detection: walk parents with a visited set per start node.
  for (const node of goals) {
    const seen = new Set<string>([node.id])
    let cursor = node.parentId
    while (cursor !== null) {
      if (seen.has(cursor)) {
        throw new GateError(
          'TREE_SHAPE',
          `goal parent chain contains a cycle involving "${node.id}" and "${cursor}"`,
          { id: node.id },
        )
      }
      seen.add(cursor)
      cursor = byId.get(cursor)?.parentId ?? null
    }
  }
}

/**
 * Validate the shape of a contradiction tree.
 *
 * Goal links are validated separately because they may reference goals that a
 * concurrent edit is adding; only existence against the *proposed* set counts.
 *
 * @param contradictions - proposed contradiction nodes.
 * @param goals - the proposed goal set those links must resolve against.
 * @throws {GateError} with code `TREE_SHAPE`.
 */
export function assertContradictionTreeShape(
  contradictions: ContradictionNode[],
  goals: GoalNode[],
): void {
  const byId = new Map<string, ContradictionNode>()
  for (const node of contradictions) {
    if (byId.has(node.id)) {
      throw new GateError('TREE_SHAPE', `duplicate contradiction id "${node.id}"`, {
        id: node.id,
      })
    }
    byId.set(node.id, node)
  }

  const goalIds = new Set(goals.map((node) => node.id))
  for (const node of contradictions) {
    if (!goalIds.has(node.primaryGoalId)) {
      throw new GateError(
        'TREE_SHAPE',
        `contradiction "${node.id}" has primaryGoalId "${node.primaryGoalId}" ` +
          `which is not a goal in this project`,
        { id: node.id, primaryGoalId: node.primaryGoalId },
      )
    }
    for (const relatedId of node.relatedGoalIds) {
      if (!goalIds.has(relatedId)) {
        throw new GateError(
          'TREE_SHAPE',
          `contradiction "${node.id}" lists relatedGoalId "${relatedId}" ` +
            `which is not a goal in this project`,
          { id: node.id, relatedGoalId: relatedId },
        )
      }
      if (relatedId === node.primaryGoalId) {
        throw new GateError(
          'TREE_SHAPE',
          `contradiction "${node.id}" lists its own primaryGoalId in ` +
            `relatedGoalIds; primary and related must be disjoint`,
          { id: node.id },
        )
      }
    }
    // Tree parent, when present, must be another contradiction.
    if (node.parentId !== null && !byId.has(node.parentId)) {
      throw new GateError(
        'TREE_SHAPE',
        `contradiction "${node.id}" references missing parent "${node.parentId}"`,
        { id: node.id, parentId: node.parentId },
      )
    }
  }

  // Cycle detection over the contradiction tree.
  for (const node of contradictions) {
    const seen = new Set<string>([node.id])
    let cursor = node.parentId
    while (cursor !== null) {
      if (seen.has(cursor)) {
        throw new GateError(
          'TREE_SHAPE',
          `contradiction parent chain contains a cycle involving "${node.id}"`,
          { id: node.id },
        )
      }
      seen.add(cursor)
      cursor = byId.get(cursor)?.parentId ?? null
    }
  }
}

/**
 * Contradictions that must be re-evaluated after a goal change.
 *
 * A tension is derived from a goal arrangement; when a goal it references moves
 * or changes, the tension's classification may no longer hold.
 *
 * @param contradictions - current contradictions.
 * @param changedGoalIds - goals whose content changed.
 * @returns ids needing a `contradiction_tree_edit` review.
 */
export function contradictionsNeedingReview(
  contradictions: ContradictionNode[],
  changedGoalIds: string[],
): string[] {
  if (changedGoalIds.length === 0) return []
  const touched = new Set(changedGoalIds)
  return contradictions
    .filter(
      (node) => touched.has(node.primaryGoalId) || node.relatedGoalIds.some((id) => touched.has(id)),
    )
    .map((node) => node.id)
}

/**
 * Verify that an evidence list contains at least one traceable entry.
 *
 * @param evidence - candidate evidence refs.
 * @throws {GateError} with code `EVIDENCE_REQUIRED`.
 */
export function assertEvidence(evidence: string[], what: string): void {
  const usable = evidence.filter((item) => item.trim().length > 0)
  if (usable.length === 0) {
    throw new GateError(
      'EVIDENCE_REQUIRED',
      `${what} needs at least one evidence entry (a file path, symbol, commit or ` +
        'recorded confirmation). A node without traceable support cannot be monitored.',
      { what },
    )
  }
}
