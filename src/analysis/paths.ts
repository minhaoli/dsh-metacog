/**
 * Activity-to-goal path binding.
 *
 * A goal may own path prefixes; an activity touches file paths. This module
 * answers exactly one question: which goal claims each touched path?
 *
 * The relation is many-to-many on purpose. One path may belong to several
 * goals, and one goal may own several paths, because people mix unrelated work
 * inside a single directory and a single task spans several directories.
 *
 * Three properties are load-bearing:
 *
 * 1. **Longest prefix wins.** `src/api` and `src` may both be owned; a path
 *    under `src/api` belongs to the narrower owner. Without this rule the
 *    answer would fall back to array order, which is not a decision anyone
 *    made, and the same tree would bind differently after a reorder.
 * 2. **Segment boundaries are respected.** `src/ab` must not match `src/abc`.
 *    A character-prefix test binds unrelated files, and a wrong binding is
 *    worse than no binding: it moves work onto a goal that never claimed it.
 * 3. **Unbound is not drift.** An activity that no goal claims is `unbound`.
 *    "I cannot place this" and "this is off-target" are different claims, and
 *    collapsing them is how a monitor reports departure it never established.
 *
 * Comparison is case-insensitive because the plugin's sessions run on Windows
 * by default, where `D:\Foo` and `d:\foo` are the same directory. Callers
 * should pass already-resolved, project-relative paths; `..` is left as a
 * literal segment rather than collapsed, because this module does not know the
 * project root and must not guess.
 *
 * @module dsh-metacog/analysis/paths
 */

/** The minimum a goal must expose to own paths. */
export interface PathOwner {
  id: string
  /** Path prefixes this goal owns, relative to the project root. */
  paths: readonly string[]
}

/**
 * Whether a whole activity is placed on the goal tree.
 *
 * `unbound` is a distinct outcome, not a weak form of "off-target".
 */
export type PathBindingKind = 'bound' | 'unbound'

/** How one touched path was placed. */
export interface PathBinding {
  /** The activity path as normalized for matching. */
  path: string
  kind: PathBindingKind
  /**
   * Goals whose prefix ties at the greatest depth, in goal order.
   *
   * More than one id means the path genuinely belongs to several goals and the
   * caller must not invent a winner. Empty exactly when `kind` is `unbound`.
   */
  goalIds: string[]
  /** Segment count of the winning prefix; 0 when unbound. */
  depth: number
}

/** The binding for every path one activity touched. */
export interface PathBindingReport {
  kind: PathBindingKind
  /** Union of the per-path winners, first-hit order, deduplicated. */
  goalIds: string[]
  /** Per-path detail, in input order. */
  bindings: PathBinding[]
  /** Paths no goal claimed. Empty does not mean "bound"; see `kind`. */
  unboundPaths: string[]
}

/**
 * Normalize a path for matching: forward slashes, no `.` segments, no
 * duplicate separators, no trailing separator.
 *
 * A leading `/` is preserved so an absolute prefix cannot match a
 * project-relative path by accident.
 *
 * @param value - a path as recorded by a tool or typed by a user.
 * @returns the normalized form, or `''` when nothing of substance remains.
 */
export function normalizePath(value: string): string {
  const slashed = value.replace(/\\/g, '/')
  const rooted = slashed.startsWith('/')
  const segments = slashed.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  const joined = segments.join('/')
  return rooted && joined.length > 0 ? `/${joined}` : joined
}

/**
 * Split a path into comparable segments.
 *
 * Matching works on segments rather than on strings so that segment boundaries
 * and case folding come for free in one place. The empty segment produced by a
 * leading `/` is kept as a sentinel, which makes an absolute path and a
 * relative path fail to match instead of silently overlapping.
 */
function segmentsOf(value: string): string[] {
  const normalized = normalizePath(value)
  if (normalized.length === 0) return []
  return normalized.split('/').map((segment) => segment.toLowerCase())
}

/** Whether every segment of `prefix` is the matching leading segment of `target`. */
function isSegmentPrefix(prefix: readonly string[], target: readonly string[]): boolean {
  if (prefix.length === 0 || prefix.length > target.length) return false
  for (let index = 0; index < prefix.length; index += 1) {
    if (prefix[index] !== target[index]) return false
  }
  return true
}

/**
 * Place one activity path on the goal tree.
 *
 * @param activityPath - a path the activity touched.
 * @param goals - candidate goals. The caller decides the set; pass the same
 *   confirmed, live goals the alignment judge considers, so the two answers
 *   cannot disagree about what is monitorable.
 * @returns every goal sharing the deepest matching prefix, or `unbound`.
 */
export function bindPath(activityPath: string, goals: readonly PathOwner[]): PathBinding {
  const target = segmentsOf(activityPath)
  const path = normalizePath(activityPath)
  let depth = 0
  let goalIds: string[] = []

  for (const goal of goals) {
    for (const owned of goal.paths) {
      const prefix = segmentsOf(owned)
      if (!isSegmentPrefix(prefix, target)) continue
      if (prefix.length > depth) {
        depth = prefix.length
        goalIds = [goal.id]
        continue
      }
      // A shorter prefix is a different (looser) claim, not a tie. Keeping the
      // deepest claim is the whole point of rule 1.
      if (prefix.length === depth && !goalIds.includes(goal.id)) goalIds.push(goal.id)
    }
  }

  return depth === 0
    ? { path, kind: 'unbound', goalIds: [], depth: 0 }
    : { path, kind: 'bound', goalIds, depth }
}

/**
 * Place every path one activity touched.
 *
 * The activity counts as `bound` when at least one of its paths is bound: a
 * task that reads one owned file has been placed. `unboundPaths` still reports
 * the remainder, because "this task is mine but it also touched a stray file"
 * is worth seeing without being called drift.
 *
 * @param activityPaths - paths the activity touched, in the order recorded.
 * @param goals - candidate goals; see {@link bindPath}.
 * @returns the per-path detail plus the union of bound goal ids.
 */
export function bindPaths(
  activityPaths: readonly string[],
  goals: readonly PathOwner[],
): PathBindingReport {
  const bindings = activityPaths.map((activityPath) => bindPath(activityPath, goals))
  const goalIds: string[] = []
  const unboundPaths: string[] = []

  for (const binding of bindings) {
    if (binding.kind === 'unbound') {
      unboundPaths.push(binding.path)
      continue
    }
    for (const id of binding.goalIds) {
      if (!goalIds.includes(id)) goalIds.push(id)
    }
  }

  return {
    kind: goalIds.length > 0 ? 'bound' : 'unbound',
    goalIds,
    bindings,
    unboundPaths,
  }
}
