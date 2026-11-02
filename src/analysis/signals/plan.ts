/**
 * S4: how much of the declared plan actually happened.
 *
 * The only signal that asks a question none of the others can: of the steps the
 * session said it would take, how many were taken. S3 notices a tool outside the
 * whitelist, S2 notices a changed work pattern, S5 notices that nothing changed —
 * none of them notices that a specific promised step was quietly dropped.
 *
 * The score is `1 - completed / total`, so a plan with nothing done scores 1 and a
 * finished plan scores 0. Steps marked `optional` are excluded from the
 * denominator: a session should not accumulate drift for not doing something it
 * explicitly said was optional.
 *
 * @module dsh-metacog/analysis/signals/plan
 */
import type { DeclaredPlan, PlanStep, SignalScore } from '../../data/signals.js'
import type { CollectedToolResult } from '../../collect.js'

/**
 * What the matcher is allowed to look at.
 *
 * Kept separate from the trace so a step can be evaluated against a *window* — a
 * step may be satisfied by any call between its own start and the start of the
 * next step, not only by the call that happens to be current.
 */
export interface PlanWindow {
  /** Tools called in this window, in order. */
  tools: readonly string[]
  /** Arguments-derived paths touched in this window. */
  paths: readonly string[]
  /** Results seen in this window. */
  results: readonly CollectedToolResult[]
}

/** Why a step is or is not complete. */
export interface StepVerdict {
  /** Index of the step in the plan. */
  index: number
  /** The step's human-readable intent. */
  intent: string
  complete: boolean
  /** Which expectation decided it, for the report. */
  because: string
}

/**
 * Convert a glob to a regular expression.
 *
 * `*` does not cross a directory separator and `**` does. Both are anchored, so a
 * pattern matches a whole path rather than any substring of one — a pattern
 * `src/*.ts` must not match `other/src/deep/x.ts`.
 *
 * Windows separators are normalised to `/` before matching, and the comparison is
 * case-insensitive on that platform. Getting this wrong would make a plan
 * satisfied on Linux and violated on Windows for identical work.
 *
 * @param glob - the pattern.
 * @returns a matcher.
 */
export function globToRegExp(glob: string): RegExp {
  const normalised = glob.replace(/\\/g, '/')
  let out = '^'
  for (let i = 0; i < normalised.length; i += 1) {
    const ch = normalised[i] ?? ''
    if (ch === '*') {
      if (normalised[i + 1] === '*') {
        out += '.*'
        i += 1
        // Swallow a following separator so `**/x` also matches `x`.
        if (normalised[i + 1] === '/') i += 1
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      continue
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  out += '$'
  return new RegExp(out, process.platform === 'win32' ? 'i' : '')
}

/**
 * Decide whether one step is complete.
 *
 * Three rules, all deliberate:
 *
 * - Every supplied expectation must hold. A step that says "edit and pass tests"
 *   is not complete when only the edit happened.
 * - An empty `expects` is never complete. The alternative — treating "no
 *   constraint" as "always satisfied" — would make one unconstrained step zero
 *   the whole score, and the user has no way to know which step did it.
 * - A failed match is not drift. It means this step is not done yet; whether that
 *   is drift is the EMA's and the coverage floor's decision, not this function's.
 *
 * @param step - the declared step.
 * @param window - what happened during the step's window.
 * @param index - position in the plan.
 * @returns the verdict.
 */
export function evaluateStep(step: PlanStep, window: PlanWindow, index: number): StepVerdict {
  const expects = step.expects
  const checks: { name: string; ok: boolean }[] = []

  if (expects.tool !== undefined) {
    checks.push({ name: `工具 ${expects.tool}`, ok: window.tools.includes(expects.tool) })
  }
  if (expects.pathGlob !== undefined) {
    const matcher = globToRegExp(expects.pathGlob)
    checks.push({ name: `路径 ${expects.pathGlob}`, ok: window.paths.some((p) => matcher.test(p.replace(/\\/g, '/'))) })
  }
  if (expects.assert !== undefined) {
    checks.push({ name: `结果 ${expects.assert}`, ok: assertHolds(expects.assert, window.results, window.tools) })
  }

  if (checks.length === 0) {
    return { index, intent: step.intent, complete: false, because: 'expects 为空，无法判定完成' }
  }

  const failed = checks.filter((c) => !c.ok)
  if (failed.length === 0) {
    return { index, intent: step.intent, complete: true, because: checks.map((c) => c.name).join('、') }
  }
  return { index, intent: step.intent, complete: false, because: `未满足：${failed.map((c) => c.name).join('、')}` }
}

/** What one plan step is judged against: a contiguous slice of the turn. */
export interface StepSlice {
  tools: readonly string[]
  paths: readonly string[]
  results: readonly CollectedToolResult[]
}

/**
 * Cut a turn into one window per plan step, in plan order.
 *
 * The collector records a flat sequence of calls per turn and does not say which
 * call belonged to which declared step. Anything finer than a *contiguous slice*
 * of that sequence would be a guess, and this is the wrong place to guess: it
 * would credit one step with work another step did.
 *
 * So: walk the steps in order, and for each take the shortest run of consecutive
 * calls — starting where the previous satisfied step ended — that satisfies its
 * `expects`. A satisfied step moves the cursor past its run; an unsatisfied one
 * leaves the cursor alone, so a later step may still claim those calls. That is
 * what makes a skipped middle step visible. Giving every step the whole turn, as
 * this used to, meant a call that satisfied step 3 also satisfied step 2, so
 * "step 2 was quietly dropped" could never be detected.
 *
 * Known limit, accepted: a plan carried out out of order is under-reported. If
 * step 3's calls come before step 2's, step 2 scans forward, finds nothing, and
 * stays incomplete even though the work happened. Reporting a step as missing
 * when only the order differed is the conservative error: the alternative,
 * searching backwards, would let one call complete two steps.
 *
 * @param steps - the plan's steps, in declared order.
 * @param slices - the turn's calls, in order.
 * @returns one window per step, index-aligned with `steps`; an unsatisfied step
 *   gets an empty window rather than the calls it failed to claim.
 */
export function segmentPlanWindows(
  steps: readonly PlanStep[],
  slices: readonly StepSlice[],
): PlanWindow[] {
  const windows: PlanWindow[] = []
  let cursor = 0

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (step === undefined) {
      windows.push({ tools: [], paths: [], results: [] })
      continue
    }
    if (cursor >= slices.length) {
      windows.push({ tools: [], paths: [], results: [] })
      continue
    }

    const tools: string[] = []
    const paths: string[] = []
    const results: CollectedToolResult[] = []
    let matched: PlanWindow | undefined

    for (let end = cursor; end < slices.length; end += 1) {
      const slice = slices[end]
      if (slice === undefined) continue
      tools.push(...slice.tools)
      paths.push(...slice.paths)
      results.push(...slice.results)
      if (evaluateStep(step, { tools, paths, results }, index).complete) {
        // Copy: the accumulators keep growing for the next candidate otherwise.
        matched = { tools: [...tools], paths: [...paths], results: [...results] }
        cursor = end + 1
        break
      }
    }

    windows.push(matched ?? { tools: [], paths: [], results: [] })
  }

  return windows
}

/**
 * Whether a checkable outcome holds in a window's results.
 *
 * `file-changed` is the awkward one: it is an assertion about the filesystem, not
 * about a result string, and the only evidence available here is that a write
 * tool ran and did not report an error. That is weaker than a real check but it
 * is not a guess — a write that failed produces `ok: false`, and a write with no
 * flag produces neither, so the test is "a successful write, or a write that did
 * not fail". Anything stricter would need the filesystem, which the matcher
 * deliberately does not touch.
 *
 * @param assertion - which outcome.
 * @param results - results in the window.
 * @param tools - tools called in the window.
 * @returns whether it holds.
 */
function assertHolds(
  assertion: 'tests-pass' | 'build-pass' | 'file-changed',
  results: readonly CollectedToolResult[],
  tools: readonly string[],
): boolean {
  if (assertion === 'file-changed') {
    const writeTools = new Set(['edit', 'write', 'multi_edit', 'better_edit', 'apply_patch'])
    const wrote = tools.some((t) => writeTools.has(t) || t.endsWith('_edit'))
    if (!wrote) return false
    // A write that explicitly failed does not count as a change.
    return !results.some((r) => r.ok === false && writeTools.has(r.tool))
  }
  return results.some((r) => r.outcome === assertion)
}

/**
 * Score how much of the plan is done.
 *
 * Deliberately never cites `plan.goal`: the score is computed from the steps
 * alone, so a vague goal (`vagueGoal: true`) cannot make S4 absent or turn a
 * valid step judgement into a goal comparison. If a rationale is ever added
 * here, it must drop any goal quote when `plan.vagueGoal` is true.
 *
 * @param plan - the declared plan, or `undefined`.
 * @param windows - one window per step, in plan order.
 * @returns the S4 score in the shape the aggregator expects, plus the verdicts.
 */
export function scorePlanMatch(
  plan: DeclaredPlan | undefined,
  windows: readonly PlanWindow[],
): { score: SignalScore; verdicts: StepVerdict[] } {
  if (plan === undefined) {
    return {
      score: { status: 'not_applicable', signal: 's4_plan_match', reason: 'no_declared_plan', detail: '没有声明计划，S4 取不到值' },
      verdicts: [],
    }
  }
  // Keep each step's original position. Filtering to a bare array and then
  // indexing `windows` by the filtered position shifts every step that follows an
  // optional one: with `[required, optional, required]` the third step read the
  // second window, was judged against the wrong tools, and a plan that had been
  // carried out completely scored 0.5. The same shifted index reached
  // `StepVerdict.index`, so the report named the wrong step as unfinished.
  const required = plan.steps
    .map((step, index) => ({ step, index }))
    .filter((entry) => !entry.step.optional)
  if (required.length === 0) {
    return {
      score: {
        status: 'not_applicable',
        signal: 's4_plan_match',
        reason: 'insufficient_history',
        detail: '计划里没有必做步骤，S4 无从判定',
      },
      verdicts: [],
    }
  }

  const verdicts = required.map(({ step, index }) =>
    evaluateStep(step, windows[index] ?? { tools: [], paths: [], results: [] }, index),
  )
  const done = verdicts.filter((v) => v.complete).length
  const score = 1 - done / verdicts.length

  return {
    score: {
      status: 'available',
      signal: 's4_plan_match',
      score,
      evidence: verdicts.map((v) => `${v.complete ? '✓' : '✗'} ${v.intent}${v.complete ? '' : `（${v.because}）`}`),
    },
    verdicts,
  }
}
