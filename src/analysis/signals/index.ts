/**
 * The five signal implementations.
 *
 * Each one answers a single question about a step and returns a `SignalScore`:
 * a number in [0, 1], or an explicit reason it has none. None of them may return
 * zero to mean "I could not tell" — that is what the absence branch is for, and
 * collapsing the two turns a monitor that sees nothing into a monitor that sees
 * nothing wrong.
 *
 * What is deliberately *not* here: any combination or thresholding. Aggregation
 * lives in `data/signals.ts` and thresholds in config, so a signal can be tested,
 * swapped or turned off without touching the decision rule.
 *
 * @module dsh-metacog/analysis/signals
 */
import type { CollectedActivity, CollectedToolResult } from '../../collect.js'
import { planAllowedTools, type DeclaredPlan, type SignalAbsenceReason, type SignalId, type SignalScore } from '../../data/signals.js'

/**
 * One step's raw material: the tools a turn called, in order, and their results.
 *
 * A step is one tool call (see the design doc, 2.2). The collector produces turn
 * level activities, so the signal layer replays each turn into one step per tool
 * call. `toolNames` may be empty when a record predates the field, which is why
 * the signals distinguish "no tools" from "not recorded".
 */
export interface StepTrace {
  /** Tools called in this step, in order. */
  tools: readonly string[]
  /** Results seen in this step. */
  results: readonly CollectedToolResult[]
  /**
   * File paths this step's call named.
   *
   * Carried per step rather than per turn because S4 judges a plan step against
   * a slice of the turn: a `pathGlob` expectation is about the call that touched
   * the file, not about everything the turn happened to open.
   */
  paths: readonly string[]
}

/**
 * Split a turn activity into one trace per tool call.
 *
 * The turn's results are attached to the last step rather than distributed: the
 * host does not tag a result with the call that produced it in every adapter, and
 * guessing the pairing would attribute a passing test run to whichever command
 * happened to precede it. Attaching them to the final step is the conservative
 * choice — it can only understate an earlier step's progress, never overstate it.
 *
 * @param activity - collected turn activity.
 * @returns one trace per tool call; a single empty trace when none were recorded.
 */
export function tracesFromActivity(activity: CollectedActivity): StepTrace[] {
  const tools = activity.toolNames ?? []
  const results = activity.toolResults ?? []
  // Absent for records collected before paths were captured; the per-step
  // fallback keeps the two lists aligned either way.
  const paths = activity.toolPaths ?? []
  if (tools.length === 0) return [{ tools: [], results, paths: [] }]
  return tools.map((tool, index) => ({
    tools: [tool],
    results: index === tools.length - 1 ? results : [],
    paths: paths[index] ?? [],
  }))
}

/**
 * Build a score for a signal that can be measured.
 *
 * @param signal - signal id.
 * @param score - value in [0, 1].
 * @param evidence - what the number came from.
 * @returns the score object.
 */
function available(signal: SignalId, score: number, evidence: string[]): SignalScore {
  return { status: 'available', signal, score, evidence }
}

/**
 * Build a score for a signal that has no value, and say why.
 *
 * @param signal - signal id.
 * @param reason - why there is no value.
 * @param detail - sentence for the report.
 * @returns the absence object.
 */
function absent(signal: SignalId, reason: SignalAbsenceReason, detail = ''): SignalScore {
  return { status: 'not_applicable', signal, reason, detail }
}

/**
 * S3: did this step use a tool the session did not declare?
 *
 * The only signal with an external reference point, and the reference is a
 * caution rather than an endorsement: Ring 12's tight-scope row reaches 0.843 F1
 * by declaring a narrow manifest, at the cost of 0 out of 60 benign controls
 * surviving. So this is a high-recall, low-precision filter — it will flag
 * ordinary work, and the aggregation is what keeps that from becoming an alarm.
 *
 * Binary by construction. A "how far outside the whitelist" gradient would be
 * invented precision: the benchmark only ever measured in-or-out.
 *
 * The binary outcome is deliberate but the *wording* is not: the rationale ends
 * up in the prompt block, where "越界工具：x" reads as a verdict and invites the
 * model to defend itself. It is rewritten as a statement plus the action that
 * resolves it, because a tool outside the declaration is usually a new
 * requirement rather than a violation.
 *
 * The tool set is `planAllowedTools`, not `plan.allowedTools`: a session that
 * declared only structured steps has already said which tools it expects to
 * call, and demanding a second copy of that list was the main reason plans went
 * undeclared.
 *
 * @param trace - this step's tools.
 * @param plan - the session's declared plan, when there is one.
 * @returns the score, or an explicit absence.
 */
export function scoreToolNovelty(trace: StepTrace, plan: DeclaredPlan | undefined): SignalScore {
  if (plan === undefined) return absent('s3_tool_novel', 'no_declared_plan', '本次会话没有声明计划，无法判断工具是否越界')
  const allowedTools = planAllowedTools(plan)
  if (allowedTools.length === 0) {
    return absent(
      's3_tool_novel',
      'no_allowed_tools',
      '计划里既没有 allowedTools，步骤也没有写 expects.tool，S3 取不到值',
    )
  }
  if (trace.tools.length === 0) {
    return absent('s3_tool_novel', 'data_not_collected', '这一步没有记录到工具调用')
  }

  const allowed = new Set(allowedTools)
  const novel = trace.tools.filter((tool) => !allowed.has(tool))
  if (novel.length === 0) {
    return available('s3_tool_novel', 0, [`本步工具 ${trace.tools.join('、')} 均在声明范围内`])
  }
  return available('s3_tool_novel', 1, [
    `本步用了声明之外的 ${novel.join('、')}（本次声明：${allowedTools.join('、')}）。` +
      `这不等于违规，可能只是出现了新需求：若它确实属于本次工作，用 metacog_revise_plan 把 ` +
      `${novel.join('、')} 补进 allowedTools，或补一步说明它的用途；若不属于，就不要继续用它。`,
  ])
}

/**
 * Coarse action classes.
 *
 * Deliberately small. A finer taxonomy would need a per-tool table that drifts
 * out of date every time the host adds a tool, and S2 only needs enough
 * resolution to notice "this session stopped writing and started reading".
 */
export const ACTION_CLASSES = ['READ', 'WRITE', 'COMPUTE', 'NETWORK', 'COMMUNICATE', 'SYSTEM'] as const
export type ActionClass = (typeof ACTION_CLASSES)[number]

/**
 * Map a tool name to an action class.
 *
 * Unknown tools map to `SYSTEM` rather than throwing: a new host tool is not an
 * error, and dropping it would silently shrink the distribution that S2 measures.
 *
 * @param toolName - tool to classify.
 * @returns its class.
 */
export function classifyTool(toolName: string): ActionClass {
  const name = toolName.toLowerCase()
  if (/^(read|glob|grep|list_dir|ls)$/.test(name) || name.includes('read_document') || name.includes('scan')) {
    return 'READ'
  }
  if (name === 'edit' || name === 'write' || name.endsWith('_edit') || name.includes('apply_patch')) return 'WRITE'
  if (name === 'pwsh' || name === 'bash' || name === 'shell' || name.includes('run_command')) return 'COMPUTE'
  if (name.includes('web') || name.includes('fetch') || name.includes('search')) return 'NETWORK'
  if (name === 'send_message' || name === 'ask_user_question') return 'COMMUNICATE'
  return 'SYSTEM'
}

/**
 * S2: has the mix of action classes drifted from the session's baseline?
 *
 * Measured as `1 - Jaccard(current classes, baseline classes)`. Jaccard on the
 * *set* of classes rather than a distance between frequency vectors, because the
 * set version needs far fewer observations to be meaningful: a session that
 * normally writes and today only reads has a class-set change immediately, while
 * a frequency comparison would need dozens of steps before the difference
 * cleared its own noise.
 *
 * The baseline is the first `BASELINE_STEPS` steps of the session — the shape it
 * settled into before any drift could have started. Fewer than
 * `MIN_HISTORY_STEPS` and this reports absence rather than comparing a step
 * against itself.
 *
 * @param history - classes observed so far in this session, oldest first.
 * @returns the score, or an explicit absence.
 */
export function scoreClassDrift(history: readonly ActionClass[]): SignalScore {
  if (history.length < MIN_HISTORY_STEPS) {
    return absent(
      's2_class',
      'insufficient_history',
      `只有 ${history.length} 步历史，不足以建立动作类别基线`,
    )
  }

  const baseline = new Set(history.slice(0, BASELINE_STEPS))
  const recent = new Set(history.slice(-RECENT_STEPS))

  const intersection = [...recent].filter((c) => baseline.has(c)).length
  const union = new Set([...baseline, ...recent]).size
  if (union === 0) return absent('s2_class', 'data_not_collected', '类别集合为空')

  const jaccard = intersection / union
  return available('s2_class', 1 - jaccard, [
    `基线类别 {${[...baseline].join('、')}}，最近 {${[...recent].join('、')}}，Jaccard ${jaccard.toFixed(2)}`,
  ])
}

/** Steps used to establish what a session normally does. */
export const BASELINE_STEPS = 5
/** Steps compared against that baseline. */
export const RECENT_STEPS = 5
/** Below this, S2 has no baseline worth comparing against. */
export const MIN_HISTORY_STEPS = 6

/**
 * S5: did this step verifiably change anything?
 *
 * Self-invented, with no benchmark backing at all — the benchmark's `s5_paraphrase`
 * is a different signal (paraphrase stability), and no amount of citation makes
 * it support this one.
 *
 * "Verifiably changed" is narrow on purpose: a file was written, a test went from
 * failing to passing, a build started succeeding. Merely calling a tool is not
 * progress — that is exactly the failure mode this detects ("lots of activity,
 * nothing changed").
 *
 * @param traces - this turn's steps, oldest first.
 * @returns the score, or an explicit absence.
 */
export function scoreProgress(traces: readonly StepTrace[]): SignalScore {
  if (traces.length === 0) return absent('s5_progress', 'data_not_collected', '没有可判定的步骤')

  const writeTools = new Set(['edit', 'write', 'multi_edit', 'better_edit', 'apply_patch'])
  let changed = 0
  let sawResults = false
  const notes: string[] = []

  for (const trace of traces) {
    // A write tool counts as a change, unless its result says the write failed.
    // The earlier version assumed the tools layer had already rejected no-op
    // writes; it has not, and the refusal comes back in the result as
    // `isError: true` → `ok: false`. Without this check a permission-denied edit
    // read as progress and pulled the progress dimension toward "healthy", which is
    // the opposite of what "did anything actually change" asks.
    if (trace.tools.some((tool) => writeTools.has(tool) || tool.endsWith('_edit'))) {
      if (trace.results.some((result) => result.ok === false)) {
        // A refusal is information: we looked, and nothing changed. Marking this as
        // "saw results" keeps the step out of the not-applicable branch below —
        // "the write was rejected" and "we could not tell" are different facts, and
        // only the second may abstain.
        sawResults = true
        notes.push(`写被拒绝 ${trace.tools.join('、')}`)
        continue
      }
      changed += 1
      notes.push(`写工具 ${trace.tools.join('、')}`)
      continue
    }
    for (const result of trace.results) {
      sawResults = true
      if (result.outcome === 'tests-pass' || result.outcome === 'build-pass') {
        // One step, one count: the denominator is the number of traces, so a step
        // that produced both a passing test and a build is still a single step
        // that changed something. Counting each result separately would let one
        // busy call outweigh several empty ones.
        changed += 1
        notes.push(`${result.tool}：${result.outcome}`)
        break
      }
    }
  }

  // No results at all and no writes: the data does not say "nothing changed", it
  // says we could not look. Reporting a high score here would manufacture drift
  // out of missing instrumentation.
  if (!sawResults && changed === 0) {
    return absent('s5_progress', 'data_not_collected', '本 turn 没有工具返回内容，无法判断是否产生实际变化')
  }

  const ratio = changed / traces.length
  return available('s5_progress', 1 - ratio, [
    notes.length === 0 ? `${traces.length} 步中 0 步产生可验证变化` : `${traces.length} 步中 ${changed} 步有变化：${notes.join('；')}`,
  ])
}
