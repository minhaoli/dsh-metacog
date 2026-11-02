/**
 * The second opinion on drift.
 *
 * A rule that fires on the string `pwsh (tool call)` is guessing. Rather than
 * teaching every rule to understand prose, the program keeps doing what it is
 * good at — cheap, deterministic, exhaustive screening — and a model looks only at
 * the candidates it produces, in one batch per review interval.
 *
 * Two consequences are deliberate:
 *
 * 1. **Nothing is published on a single rule hit.** A candidate becomes a signal
 *    only when the model agrees, which is what makes an hourly cadence honest
 *    instead of a delay before the same noise.
 * 2. **The model is told to prefer "not drift".** A missed drift costs one quiet
 *    hour; a false alarm costs the user's trust in the whole monitor.
 *
 * @module dsh-metacog/analysis/judgment
 */

import { randomUUID } from 'node:crypto'

import type { DriftSignalType, JudgmentRecord, TreeState } from '../data/types.js'
import type { MetacogConfig } from '../config.js'
import type { MetacogStore } from '../data/store.js'
import type { HostAgent, HostContext } from '../host.js'
import { activateStructured } from './activate.js'
import { clampHint } from './escalation.js'
import { publishDrafts } from './service.js'
import type { SignalDraft } from './drift.js'
import { RealtimeFailureReminder } from './verdict.js'

/** Schema the model must satisfy. Single types only: the host rejects type arrays. */
export const JUDGMENT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          isDrift: { type: 'boolean' },
          /**
           * Which named rule the activity failed to satisfy.
           *
           * `reason` stays free-form for the human reading it; this field is the
           * machine-readable half, so rejections can be counted by cause. A
           * monitor that cannot say *why* it rejected something cannot learn
           * from its own rejections.
           */
          why: {
            type: 'string',
            enum: [
              'no-matching-goal',
              'missed-success-criteria',
              'outside-allowed-methods',
              'hit-excluded-activity',
              'contradicts-goal',
              'unclear',
            ],
          },
          /** Concrete next step: what would make this activity serve a goal. */
          howToAdjust: { type: 'string' },
          /** 0-1; below the configured floor the verdict is not acted on. */
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['id', 'isDrift', 'why', 'howToAdjust', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
} as const

/** Why a reviewer called an activity drift. Machine-readable so it can be counted. */
export type DriftWhy =
  | 'no-matching-goal'
  | 'missed-success-criteria'
  | 'outside-allowed-methods'
  | 'hit-excluded-activity'
  | 'contradicts-goal'
  | 'unclear'

/** One candidate, reduced to what the reviewer needs. */
export interface JudgmentCandidate {
  readonly id: string
  readonly signalType: string
  readonly summary: string
  readonly programReason: string
}

/** Verdict on one candidate. */
interface Verdict {
  readonly id: string
  readonly isDrift: boolean
  readonly why: DriftWhy
  readonly howToAdjust: string
  readonly confidence: number
  readonly reason: string
}

/**
 * Build the review prompt.
 *
 * The goal tree is compressed to depth, title and success criteria: the reviewer
 * needs to know what the project is *for*, and the rest of the node (evidence,
 * timestamps) would only dilute that.
 *
 * @param state - the confirmed tree.
 * @param candidates - queued candidates, already capped by the caller.
 */
export function buildJudgmentPrompt(
  state: TreeState,
  candidates: readonly JudgmentCandidate[],
): string {
  const goals = [...state.goals]
    .sort((left, right) => left.depth - right.depth)
    .map((goal) => {
      const criteria =
        goal.successCriteria.length === 0 ? '' : `（验收：${goal.successCriteria.join('；')}）`
      return `${'  '.repeat(goal.depth)}${goal.depth} ${goal.title}${criteria}`
    })
    .join('\n')

  const lines = candidates
    .map(
      (candidate) =>
        `- id: ${candidate.id}\n  类型：${candidate.signalType}\n  活动：${candidate.summary}\n  程序理由：${candidate.programReason}`,
    )
    .join('\n')

  return `你在复核一个项目的漂移判定。程序规则给出的候选只看了字符串，经常误报；你的任务是逐条判断它到底是不是真的偏离。

目标树（数字是深度）：
${goals}

候选：
${lines}

判断标准：
- 活动直接推进某个目标，或属于该目标明确允许的方法 → 不是漂移。
- 活动与所有目标都无关，且不是任何目标必需的配套工作（测试、构建、配置、格式化）→ 是漂移。
- 拿不准就判「不是漂移」：漏报的代价是一小时的安静，误报的代价是用户不再相信整个监控。

每个候选还要给出三个字段，它们不是装饰：

- why：命中了哪条规则才判成漂移。只能是下面之一，不要自创：
  no-matching-goal（对不上任何目标）/ missed-success-criteria（该目标的验收条件没满足）/
  outside-allowed-methods（不在允许方法里）/ hit-excluded-activity（撞了排除项）/
  contradicts-goal（与该目标直接冲突）/ unclear（确实说不清）
- howToAdjust：一句话说清「怎么做才算服务于目标」。要具体到动作，
  例如「把这次改动接到 L1 的验收条件上，并补一条活动证据」，
  不要写「请调整方向」这种空话。如果结论是目标本身该改，就直接说改哪个目标。
  这段话会直接给用户看，所以：不超过 60 字；不提内部代号（如 s3_tool_novel、
  theta、coverageFloor 这类名字）；不指责，说「这和声明的不一样，可能是新需求」；
  动作必须是真实存在的工具或操作（metacog_revise_plan、goal_tree_edit、
  check_drift，或在设置卡里调整阈值）。reason 也遵守同样的口径。
- confidence：0 到 1。低于 0.6 的判定不会被执行，只会留在记录里，所以拿不准就报低。

只返回 JSON：{"verdicts":[{"id":"...","isDrift":false,"why":"unclear","howToAdjust":"...","confidence":0.8,"reason":"..."}]}，每个候选一条，不要遗漏。`
}

/** What one review pass did. */
export interface ReviewOutcome {
  /** Candidates examined. */
  readonly reviewed: number
  /** Candidates the model also called drift, now published as signals. */
  readonly confirmed: number
  /** Candidates the model rejected. */
  readonly dismissed: number
  /** Hints worth showing the user, including the log reminder. */
  readonly hints: string[]
  /** Present when the pass could not run. */
  readonly problem?: string
}

/**
 * Candidates per model call.
 *
 * Sized so a normal backlog costs one or two calls rather than a dozen: the first
 * live run queued 119 at once, and 20 per call turned a single `/metacog-check`
 * into six sequential subagent round-trips.
 */
const MAX_PER_REVIEW = 50

/** Whether a draft may escalate without a model review. */
export type SignalPrecision = 'direct' | 'review'

/** Facts outside the draft that decide its precision (from the alignment verdict). */
export interface PrecisionContext {
  /** Set when the activity matched a goal's explicit `excludedActivities`. */
  readonly excludedByGoalId?: string
}

/** One row of the precision table. First matching row wins. */
export interface SignalPrecisionRule {
  readonly id: string
  readonly signalTypes: readonly DriftSignalType[]
  /** Why this rule does not need a second opinion. */
  readonly reason: string
  /** Extra fact the draft must carry, when the signal type alone is not enough. */
  readonly requires?: (draft: SignalDraft, context: PrecisionContext) => boolean
}

/**
 * Ordered precision table: the first row whose signal type matches decides.
 *
 * The bar for `direct` is "the fact is already in the record, so a model can
 * only add latency". Keyword guesses, single-tool-name mismatches and
 * contradiction-shift hints stay in `review` by falling through to the default.
 * A new rule belongs here, not in an `if` at a call site, so the answer to
 * "why does this rule not need review" is readable in one place.
 */
export const SIGNAL_PRECISION_RULES: readonly SignalPrecisionRule[] = [
  {
    id: 'excluded-activity',
    signalTypes: ['scope_drift'],
    requires: (_draft, context) => context.excludedByGoalId !== undefined,
    reason:
      '活动命中了目标显式声明的 excludedActivities；用户已提前判定这类活动越界，' +
      '规则命中就是事实，模型复核只会延迟。',
  },
  {
    id: 'core-bypass',
    signalTypes: ['core_bypass'],
    reason:
      '矛盾强度达到阈值且多步活动绕开它，两个事实都由记录推出；' +
      '这不是关键词猜测，复核不会改变结论。',
  },
]

/**
 * Decide one draft's precision.
 *
 * @param draft - rule draft from the detector sweep.
 * @param context - facts from the alignment verdict, when the draft came from one.
 * @param allowUnreviewed - explicit degradation: treat every draft as direct.
 * @returns `direct` only when a table row applies (or degradation is on).
 */
export function precisionOf(
  draft: SignalDraft,
  context: PrecisionContext = {},
  allowUnreviewed = false,
): SignalPrecision {
  if (allowUnreviewed) return 'direct'
  for (const rule of SIGNAL_PRECISION_RULES) {
    if (!rule.signalTypes.includes(draft.signalType)) continue
    if (rule.requires !== undefined && !rule.requires(draft, context)) continue
    return 'direct'
  }
  return 'review'
}

/**
 * Split a sweep's drafts into immediate signals and review candidates.
 *
 * @param drafts - detector output for one activity.
 * @param context - alignment facts that refine a rule's precision.
 * @param allowUnreviewed - explicit degradation switch.
 */
export function splitDraftsByPrecision(
  drafts: readonly SignalDraft[],
  context: PrecisionContext = {},
  allowUnreviewed = false,
): { direct: SignalDraft[]; review: SignalDraft[] } {
  const direct: SignalDraft[] = []
  const review: SignalDraft[] = []
  for (const draft of drafts) {
    if (precisionOf(draft, context, allowUnreviewed) === 'direct') direct.push(draft)
    else review.push(draft)
  }
  return { direct, review }
}

/** Reason recorded on candidates dropped because the queue hit its cap. */
export const JUDGMENT_BACKLOG_DROP_REASON = '因复核不可用丢弃积压（超过上限）'

/**
 * Cap the pending queue, settling the oldest records as dropped.
 *
 * The queue is read on every review attempt, so trimming here covers both
 * "review is unavailable" and "review is slow": either way the cap holds and
 * the drop is recorded on the judgment record itself, which is the audit trail
 * this module already writes.
 *
 * @param store - project store.
 * @param projectId - owning project.
 * @param limit - maximum pending records; must be positive.
 * @param now - clock injection for the settled timestamp.
 * @returns how many were dropped and their ids.
 */
export async function trimJudgmentBacklog(
  store: MetacogStore,
  projectId: string,
  limit: number,
  now: Date = new Date(),
): Promise<{ dropped: number; ids: string[] }> {
  const pending = (await store.readJudgments(projectId)).filter(
    (record) => record.status === 'pending',
  )
  if (pending.length <= limit) return { dropped: 0, ids: [] }
  const excess = pending.slice(0, pending.length - limit)
  for (const record of excess) {
    await store.appendJudgment(projectId, {
      ...record,
      status: 'dismissed',
      modelVerdict: 'not_drift',
      modelReason: JUDGMENT_BACKLOG_DROP_REASON,
      decidedAt: now.toISOString(),
    })
  }
  return { dropped: excess.length, ids: excess.map((record) => record.id) }
}

/** Options for {@link ReviewFailureNotifier}. */
export interface ReviewFailureNotifierOptions {
  readonly statePath: string
  readonly remind: (message: string) => void
  readonly now?: () => Date
}

/**
 * Make a review outage visible once per reason, re-arming on recovery.
 *
 * Reuses M1's `RealtimeFailureReminder` (persisted suppression, clear-on-success)
 * instead of adding a second state machine. Only the wording is ours: the
 * reminder's own message names an internal reason key, which is not what a user
 * should see.
 */
export class ReviewFailureNotifier {
  readonly #reminder: RealtimeFailureReminder

  constructor(options: ReviewFailureNotifierOptions) {
    this.#reminder = new RealtimeFailureReminder(options)
  }

  /**
   * Record one failure.
   *
   * @param problem - the reason `reviewPendingJudgments` reported.
   * @returns a Chinese hint only when this reason has not been shown yet.
   */
  noteFailure(problem: string): string | undefined {
    const key = /unavailable|no_model|no_adapter|no subagent|parent/i.test(problem)
      ? 'unavailable'
      : 'review_failed'
    if (!this.#reminder.recordFailure(key, problem)) return undefined
    return clampHint(
      '[metacog 复核] 自动复核当前不可用，判定已暂停；候选会保留，恢复后继续。',
    )
  }

  /** Record one success so a later failure of any kind re-arms. */
  noteSuccess(): boolean {
    return this.#reminder.recordSuccess()
  }

  /** Reasons currently suppressed, for status output and tests. */
  get suppressedKeys(): readonly string[] {
    return this.#reminder.suppressedKeys
  }
}

/**
 * Review queued candidates and publish the ones both sides call drift.
 *
 * @param options - host context, store, tree and configuration.
 */
export async function reviewPendingJudgments(options: {
  readonly ctx: HostContext
  readonly store: MetacogStore
  readonly projectId: string
  readonly state: TreeState
  readonly config: MetacogConfig
  readonly cwd?: string
  readonly now?: Date
  /** Agent to attribute the review child to; required outside a tool call. */
  readonly parent?: HostAgent
}): Promise<ReviewOutcome> {
  const { ctx, store, projectId, state, config } = options
  const now = options.now ?? new Date()

  // Cap first: an outage must not grow an unbounded queue, and trimming is
  // cheap enough to run on every attempt.
  await trimJudgmentBacklog(store, projectId, config.judgment.backlogLimit, now)

  const records = await store.readJudgments(projectId)
  const pending = records.filter((record) => record.status === 'pending')
  if (pending.length === 0) {
    return { reviewed: 0, confirmed: 0, dismissed: 0, hints: [] }
  }

  const batch = pending.slice(0, MAX_PER_REVIEW)
  const candidates: JudgmentCandidate[] = batch.map((record) => ({
    id: record.id,
    signalType: record.signalType,
    summary: record.summary,
    programReason: record.programReason,
  }))

  const outcome = await activateStructured(ctx, {
    prompt: buildJudgmentPrompt(state, candidates),
    schema: JUDGMENT_JSON_SCHEMA as unknown as Record<string, unknown>,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.parent === undefined ? {} : { parent: options.parent }),
    label: 'metacog-judgment',
    timeoutMs: 120_000,
  })

  if (outcome.status !== 'ok') {
    // The queue is kept: a machine without a subagent service must not silently
    // discard candidates, and the next tick can try again.
    return {
      reviewed: 0,
      confirmed: 0,
      dismissed: 0,
      hints: [],
      problem: outcome.reason,
    }
  }

  const verdicts = parseVerdicts(outcome.structured)
  if (verdicts === undefined) {
    return {
      reviewed: 0,
      confirmed: 0,
      dismissed: 0,
      hints: [],
      problem: 'the reviewer returned an answer that did not match the schema',
    }
  }

  const byId = new Map(verdicts.map((verdict) => [verdict.id, verdict]))
  let confirmed = 0
  let dismissed = 0
  const publishable: SignalDraft[] = []

  for (const record of batch) {
    const verdict = byId.get(record.id)
    if (verdict === undefined) {
      // A missing verdict is not consent: leave it pending for the next pass.
      continue
    }

    if (verdict.isDrift) {
      confirmed += 1
      const draft = record.draft as SignalDraft | undefined
      // A sampled candidate's signal already went out through the bypass path;
      // publishing it again on confirmation would double-count the drift. The
      // sample exists for the model's verdict, which is recorded below.
      if (draft !== undefined && record.sampled !== true) publishable.push(draft)
    } else {
      dismissed += 1
    }

    await store.appendJudgment(projectId, {
      ...record,
      status: verdict.isDrift ? 'confirmed' : 'dismissed',
      modelVerdict: verdict.isDrift ? 'drift' : 'not_drift',
      modelReason: verdict.reason,
      modelWhy: verdict.why,
      modelHowToAdjust: verdict.howToAdjust,
      modelConfidence: verdict.confidence,
      decidedAt: new Date().toISOString(),
    })
  }

  if (publishable.length > 0) {
    await publishDrafts(store, state, projectId, publishable, config, now)
  }

  return {
    reviewed: batch.length,
    confirmed,
    dismissed,
    hints: await remindIfLogIsLong(store, projectId, config),
  }
}

/** Read `{verdicts: [...]}` defensively. */
function parseVerdicts(payload: unknown): Verdict[] | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const raw = (payload as { verdicts?: unknown }).verdicts
  if (!Array.isArray(raw)) return undefined
  const WHYS: readonly DriftWhy[] = [
    'no-matching-goal',
    'missed-success-criteria',
    'outside-allowed-methods',
    'hit-excluded-activity',
    'contradicts-goal',
    'unclear',
  ]
  const verdicts: Verdict[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as {
      id?: unknown
      isDrift?: unknown
      why?: unknown
      howToAdjust?: unknown
      confidence?: unknown
      reason?: unknown
    }
    if (typeof entry.id !== 'string' || typeof entry.isDrift !== 'boolean') continue
    // The three explanation fields degrade to honest defaults rather than
    // dropping the verdict: a model that answered "is it drift" but fumbled the
    // follow-up still produced a usable judgement, and losing it would leave the
    // candidate queued forever.
    const why =
      typeof entry.why === 'string' && (WHYS as readonly string[]).includes(entry.why)
        ? (entry.why as DriftWhy)
        : 'unclear'
    const confidence =
      typeof entry.confidence === 'number' && Number.isFinite(entry.confidence)
        ? Math.max(0, Math.min(1, entry.confidence))
        : 0.5
    verdicts.push({
      id: entry.id,
      isDrift: entry.isDrift,
      why,
      howToAdjust: typeof entry.howToAdjust === 'string' ? entry.howToAdjust : '',
      confidence,
      reason: typeof entry.reason === 'string' ? entry.reason : '',
    })
  }
  return verdicts.length === 0 ? undefined : verdicts
}

/**
 * Ask the user to read the judgement log once it is worth reading.
 *
 * The log is the only evidence of whether the rules are improving, so it is
 * surfaced periodically rather than kept for a programmer to find.
 *
 * The unit is *newly settled since the last reminder*, not *unread entries*. The
 * first version counted unread records, which meant every review batch pushed the
 * total back over the threshold and the same reminder repeated four times in one
 * command — the reminder was reporting its own backlog rather than new evidence.
 *
 * @param store - project store.
 * @param projectId - owning project.
 * @param config - thresholds.
 */
export async function remindIfLogIsLong(
  store: MetacogStore,
  projectId: string,
  config: MetacogConfig,
): Promise<string[]> {
  const records = await store.readJudgments(projectId)
  const unread = records.filter((record) => !record.notified && record.status !== 'pending')
  // Only a genuinely new batch is worth a reminder. After the previous one, its
  // records were marked notified, so this count starts from zero again.
  if (unread.length < config.thresholds.judgmentLogThreshold) return []

  const decided = records.filter((record) => record.status !== 'pending')
  const dismissed = decided.filter((record) => record.status === 'dismissed').length
  const fresh = unread.length

  for (const record of unread) {
    await store.appendJudgment(projectId, { ...record, notified: true })
  }

  return [
    clampHint(
      `[metacog 判定日志] 新增 ${fresh} 条复核记录（累计 ${decided.length} 条，` +
        `${dismissed} 条被模型判为误报）。日志在 .metacog/judgments/ 下，可回看规则是否误判。`,
    ),
  ]
}

/** Build a queued candidate from one signal draft. */
export function judgmentFromDraft(
  projectId: string,
  draft: SignalDraft,
  summary: string,
  options: { sampled?: boolean } = {},
): JudgmentRecord {
  return {
    id: `jdg_${randomUUID()}`,
    projectId,
    createdAt: new Date().toISOString(),
    activityIds: [...draft.activityIds],
    signalType: draft.signalType,
    summary,
    programReason: draft.rationale,
    draft,
    // Distinguishes a statistical sample from a rule the program flagged.
    sampled: options.sampled === true,
    status: 'pending',
    notified: false,
  }
}

/** Stable fingerprint of a draft, used for deterministic bypass sampling. */
export function bypassSampleKey(draft: SignalDraft): string {
  return [
    draft.signalType,
    draft.observedAt,
    draft.relatedGoalIds.join(','),
    draft.relatedContradictionIds.join(','),
    draft.activityIds.join(','),
    draft.evidence.join('|'),
    draft.confidence.toFixed(3),
  ].join('::')
}

/** FNV-1a over the fingerprint: deterministic across runs and platforms. */
function stableHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/**
 * Decide whether a bypassed draft also becomes a review sample.
 *
 * Deterministic on purpose: the same draft always samples the same way, so a
 * project's audit coverage is reproducible and a test cannot flake. `0` never
 * samples and `1` always does, without going through the hash.
 *
 * @param draft - the bypassed draft.
 * @param rate - configured sample rate, 0–1.
 */
export function isBypassSampled(draft: SignalDraft, rate: number): boolean {
  if (rate <= 0) return false
  if (rate >= 1) return true
  const bucket = (stableHash(bypassSampleKey(draft)) % 10_000) / 10_000
  return bucket < rate
}

/** Schema for the holistic look at a period of work. */
export const WINDOW_JSON_SCHEMA = {
  type: 'object',
  properties: {
    drifted: { type: 'boolean' },
    reason: { type: 'string' },
    suggestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['drifted', 'reason'],
  additionalProperties: false,
} as const

/** What a window assessment concluded. */
export interface WindowAssessment {
  /** Whether the period as a whole looks off-target. */
  readonly drifted: boolean
  /** Why, citing concrete activities. */
  readonly reason: string
  /** Optional advice. Empty is a legitimate answer. */
  readonly suggestions: string[]
}

/** One activity as the reviewer sees it. */
export interface WindowActivity {
  readonly summary: string
  readonly decision: string
  readonly timestamp: string
}

/** At most this many activities go into one prompt. */
const MAX_WINDOW_ACTIVITIES = 40

/**
 * Build the prompt for a holistic assessment of a period.
 *
 * Distinct from the per-candidate prompt: this one asks whether the *shape* of the
 * period is right, which no single rule can answer. Per-activity verdicts are
 * handed over as context, not as the question.
 *
 * @param state - confirmed tree.
 * @param activities - period activities, oldest first.
 */
export function buildWindowPrompt(
  state: TreeState,
  activities: readonly WindowActivity[],
): string {
  const goals = [...state.goals]
    .sort((left, right) => left.depth - right.depth)
    .map((goal) => `${'  '.repeat(goal.depth)}${goal.depth} ${goal.title}`)
    .join('\n')

  const recent = activities.slice(-MAX_WINDOW_ACTIVITIES)
  const lines = recent
    .map((item) => `- [${item.decision}] ${item.summary.slice(0, 160)}`)
    .join('\n')

  return `你在判断一段时间的工作是否偏离了这个项目的目标。

目标树（数字是深度）：
${goals}

这段时间的活动（按时间顺序，方括号里是程序当时的判定）：
${lines}

请判断：这段工作整体上是在推进目标，还是已经偏离？理由要引用上面具体的活动，不要泛泛而谈。
若判断偏离，给出一条具体、可执行的建议（该回去做什么，或该调整哪个目标）；没偏离时建议可以留空。
拿不准就判「没有偏离」——误报的代价是用户不再相信监控。

只返回 JSON：{"drifted":false,"reason":"...","suggestions":[]}`
}

/**
 * Ask a model whether a period of work is on target.
 *
 * Used by the manual check command and by the periodic sweep when the rule queue
 * is quiet: rules only see single activities, and a period can go off-target
 * without any one activity looking wrong.
 *
 * @param options - host context, tree and the activities to judge.
 */
export async function assessWindow(options: {
  readonly ctx: HostContext
  readonly state: TreeState
  readonly activities: readonly WindowActivity[]
  readonly cwd?: string
  readonly label?: string
  /** Agent to attribute the review child to; required outside a tool call. */
  readonly parent?: HostAgent
}): Promise<
  | { readonly status: 'ok'; readonly assessment: WindowAssessment }
  | { readonly status: 'empty' }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string }
> {
  if (options.activities.length === 0) return { status: 'empty' }

  const outcome = await activateStructured(options.ctx, {
    prompt: buildWindowPrompt(options.state, options.activities),
    schema: WINDOW_JSON_SCHEMA as unknown as Record<string, unknown>,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.parent === undefined ? {} : { parent: options.parent }),
    label: options.label ?? 'metacog-window',
    timeoutMs: 120_000,
  })

  if (outcome.status !== 'ok') return outcome

  const payload = outcome.structured as
    | { drifted?: unknown; reason?: unknown; suggestions?: unknown }
    | null
  if (typeof payload !== 'object' || payload === null || typeof payload.drifted !== 'boolean') {
    return { status: 'failed', reason: 'the reviewer returned an answer that did not match the schema' }
  }

  return {
    status: 'ok',
    assessment: {
      drifted: payload.drifted,
      reason: typeof payload.reason === 'string' ? payload.reason : '',
      suggestions: Array.isArray(payload.suggestions)
        ? payload.suggestions.filter((item): item is string => typeof item === 'string')
        : [],
    },
  }
}
