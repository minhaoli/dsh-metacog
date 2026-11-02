/**
 * Tree-shaped text for the two trees this plugin builds.
 *
 * A depth-flat listing is not a tree: showing every L2 after every L1 makes a
 * reader think each L2 hangs under all L1s. This module rebuilds the forest
 * from `parentId` and renders it with indentation, so the printed structure is
 * the structure that was actually stored.
 *
 * It is deliberately tolerant of bad data — a preview is exactly where broken
 * parent links surface, and the renderer must show them instead of hanging:
 *
 * - an orphan (`parentId` names no node) becomes a root, marked `[孤立]`;
 * - a cycle is broken at one node, marked `[环断]`, and never walked forever;
 * - siblings sort by `createdAt`, then title, so two renders of the same tree
 *   are identical.
 *
 * @module dsh-metacog/analysis/tree-text
 */

/** The minimum shape any renderable node must expose. */
export interface TreeNodeLike {
  readonly id: string
  readonly parentId: string | null
  readonly title: string
  /** Creation timestamp used as the primary sibling order. */
  readonly createdAt?: string
}

/** One node in the rebuilt forest. */
export interface ForestNode<T extends TreeNodeLike> {
  readonly node: T
  readonly children: ForestNode<T>[]
  /** `parentId` named a node that is not present; attached at the root. */
  readonly orphaned: boolean
  /** This node's parent link was cut to break a cycle. */
  readonly cycleBroken: boolean
}

/** Result of rebuilding a flat node list into a forest. */
export interface BuildTreeResult<T extends TreeNodeLike> {
  readonly roots: ForestNode<T>[]
  /** Nodes whose parent was missing; also present in `roots`. */
  readonly orphans: T[]
  /** Ids whose parent chain formed a cycle; one of each was cut at the root. */
  readonly cycleIds: string[]
  readonly warnings: string[]
}

/** Compare two siblings stably: creation time, then title, then id. */
function compareSiblings<T extends TreeNodeLike>(left: T, right: T): number {
  const leftAt = left.createdAt ?? ''
  const rightAt = right.createdAt ?? ''
  if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1
  const byTitle = left.title.localeCompare(right.title)
  if (byTitle !== 0) return byTitle
  return left.id.localeCompare(right.id)
}

/**
 * Rebuild the forest from flat nodes.
 *
 * @param nodes - flat nodes with `id` / `parentId` / `title`.
 * @returns roots, orphans, cycle ids and human-readable warnings.
 */
export function buildTree<T extends TreeNodeLike>(nodes: readonly T[]): BuildTreeResult<T> {
  const byId = new Map<string, T>()
  const warnings: string[] = []
  for (const node of nodes) {
    if (byId.has(node.id)) warnings.push(`重复节点 id「${node.id}」：保留最后一个`)
    byId.set(node.id, node)
  }

  const originalParent = new Map<string, string | null>()
  const orphans: T[] = []
  for (const node of nodes) {
    const parentId = node.parentId
    if (parentId === null || parentId === '') {
      originalParent.set(node.id, null)
      continue
    }
    if (!byId.has(parentId)) {
      originalParent.set(node.id, null)
      orphans.push(node)
      warnings.push(`孤立节点「${node.title}」：父节点 ${parentId} 不存在，已挂到根`)
      continue
    }
    originalParent.set(node.id, parentId)
  }

  // Cycle detection: walk each parent chain once. A node seen while still
  // "visiting" closes a cycle; cut the first node of that cycle from its parent
  // so the walk from a root terminates.
  const state = new Map<string, 1 | 2>()
  const cycleIds: string[] = []
  const cutRoots = new Set<string>()
  for (const id of byId.keys()) {
    if (state.get(id) === 2) continue
    const path: string[] = []
    let cursor: string | null = id
    while (cursor !== null && state.get(cursor) !== 2) {
      if (state.get(cursor) === 1) {
        const start = path.indexOf(cursor)
        const cycle = start >= 0 ? path.slice(start) : [cursor]
        cycleIds.push(...cycle)
        const cut = cycle[0] ?? cursor
        cutRoots.add(cut)
        warnings.push(`检测到环（${cycle.join(' → ')}），已在「${byId.get(cut)?.title ?? cut}」处断开`)
        break
      }
      state.set(cursor, 1)
      path.push(cursor)
      cursor = originalParent.get(cursor) ?? null
    }
    for (const item of path) state.set(item, 2)
  }

  const effectiveParent = new Map<string, string | null>()
  for (const [id, parent] of originalParent) {
    effectiveParent.set(id, cutRoots.has(id) ? null : parent)
  }

  const childrenByParent = new Map<string, T[]>()
  const roots: T[] = []
  for (const node of nodes) {
    const parent = effectiveParent.get(node.id) ?? null
    if (parent === null) {
      roots.push(node)
      continue
    }
    const siblings = childrenByParent.get(parent) ?? []
    siblings.push(node)
    childrenByParent.set(parent, siblings)
  }

  const orphanIds = new Set(orphans.map((node) => node.id))
  const cycleSet = new Set(cycleIds)
  const visited = new Set<string>()

  const make = (node: T): ForestNode<T> => {
    if (visited.has(node.id)) {
      // Defensive: a malformed graph must not recurse forever.
      warnings.push(`节点「${node.title}」被重复挂载，已跳过`)
      return { node, children: [], orphaned: false, cycleBroken: false }
    }
    visited.add(node.id)
    const children = (childrenByParent.get(node.id) ?? []).slice().sort(compareSiblings).map(make)
    return {
      node,
      children,
      orphaned: orphanIds.has(node.id),
      cycleBroken: cutRoots.has(node.id) || (cycleSet.has(node.id) && cutRoots.has(node.id)),
    }
  }

  return {
    roots: roots.slice().sort(compareSiblings).map(make),
    orphans,
    cycleIds,
    warnings,
  }
}

/** Options for {@link renderTreeText}. */
export interface RenderTreeOptions {
  /** Prefix placed before a root line; defaults to an empty string. */
  readonly rootPrefix?: string
}

/**
 * Render a forest as indented plain text.
 *
 * Children use `├─` / `└─` connectors; a parent's vertical bar continues only
 * while it has later siblings. Markers are appended to the title so a broken
 * parent link is visible in the text the user reads, not only in a warning
 * list they may not scroll to.
 *
 * @param forest - roots returned by {@link buildTree}.
 * @param options - rendering knobs.
 * @returns one line per node, depth represented by indentation.
 */
export function renderTreeText<T extends TreeNodeLike>(
  forest: readonly ForestNode<T>[],
  options: RenderTreeOptions = {},
): string {
  const rootPrefix = options.rootPrefix ?? ''
  const lines: string[] = []
  const walk = (entry: ForestNode<T>, prefix: string, isLast: boolean, isRoot: boolean): void => {
    const marker = entry.orphaned ? ' [孤立]' : entry.cycleBroken ? ' [环断]' : ''
    if (isRoot) lines.push(`${rootPrefix}${entry.node.title}${marker}`)
    else lines.push(`${prefix}${isLast ? '└─ ' : '├─ '}${entry.node.title}${marker}`)
    // A root has no connector of its own, but its children still need to sit
    // visibly inside it; without this the first level would start at column 0
    // and look like another root.
    const childPrefix = isRoot ? (rootPrefix.length > 0 ? rootPrefix : '   ') : `${prefix}${isLast ? '   ' : '│  '}`
    entry.children.forEach((child, index) => {
      walk(child, childPrefix, index === entry.children.length - 1, false)
    })
  }
  forest.forEach((root, index) => walk(root, '', index === forest.length - 1, true))
  return lines.join('\n')
}
