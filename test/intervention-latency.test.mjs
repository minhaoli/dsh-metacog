/**
 * Intervention latency and review degradation.
 *
 * Two failure modes used to hide here: a high-precision rule waiting for an
 * hourly model review, and a review outage that looked like silence. This suite
 * pins the direct path (facts escalate immediately), the conservative path
 * (guesses still queue), the visible outage reminder, the backlog cap, the
 * degradation switch, and the configured latency target.
 *
 * Run: node test/intervention-latency.test.mjs   (after `npm run build`)
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (path) => pathToFileURL(join(here, '..', 'lib', path)).href

let passed = 0
let failed = 0
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
    return
  }
  failed += 1
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` -- ${detail}`}`)
}

const { parseConfig } = await import(lib('config.js'))
const { MetacogStore } = await import(lib('data/store.js'))
const { InterventionRecordSchema } = await import(lib('data/types.js'))
const {
  splitDraftsByPrecision,
  precisionOf,
  trimJudgmentBacklog,
  ReviewFailureNotifier,
  JUDGMENT_BACKLOG_DROP_REASON,
  judgmentFromDraft,
} = await import(lib('analysis/judgment.js'))
const { publishDrafts } = await import(lib('analysis/service.js'))
const { renderPromptBlock } = await import(lib('report.js'))
const { pendingInterventionHint } = await import(lib('analysis/escalation.js'))

const config = parseConfig({})
const projectId = 'proj-latency'

function draft(overrides = {}) {
  return {
    observedAt: new Date().toISOString(),
    monitorCategory: 'goal_alignment',
    signalType: 'core_bypass',
    relatedGoalIds: [],
    relatedContradictionIds: [],
    activityIds: [],
    confidence: 0.9,
    evidence: ['README.md'],
    hint: '高精度规则命中：测试用提示。',
    rationale: 'test rationale',
    ...overrides,
  }
}

const root = await mkdtemp(join(tmpdir(), 'metacog-latency-'))
try {
  const store = new MetacogStore(root, '.metacog')
  const state = { projectId, version: 1, confirmed: true, goals: [], contradictions: [] }

  console.log('\n=== E1: 高精度直通，低精度排队 ===')
  const highDraft = draft({ signalType: 'core_bypass' })
  const excludedDraft = draft({
    signalType: 'scope_drift',
    hint: '活动命中了目标显式声明的排除项。',
  })
  const lowDraft = draft({
    signalType: 'goal_staleness',
    hint: '目标已 10 天没有推进记录。',
    relatedGoalIds: ['G1'],
  })
  const plainScope = draft({ signalType: 'scope_drift' })

  check('core_bypass 判为直通', precisionOf(highDraft) === 'direct')
  check(
    '命中 excludedActivities 的 scope_drift 判为直通',
    precisionOf(excludedDraft, { excludedByGoalId: 'G1' }) === 'direct',
  )
  check('未命中排除项的 scope_drift 仍排队', precisionOf(plainScope) === 'review')
  check('目标陈旧仍排队', precisionOf(lowDraft) === 'review')

  const split = splitDraftsByPrecision([highDraft, excludedDraft, lowDraft], {
    excludedByGoalId: 'G1',
  })
  check('直通草稿有 2 条', split.direct.length === 2, String(split.direct.length))
  check('排队草稿有 1 条', split.review.length === 1, String(split.review.length))
  const plainSplit = splitDraftsByPrecision([plainScope])
  check('同一批之外的未命中排除项草稿仍排队', plainSplit.review.length === 1, String(plainSplit.review.length))

  const published = await publishDrafts(store, state, projectId, split.direct, config, new Date())
  check('直通草稿已发布为信号', published.signals.length === 2, String(published.signals.length))
  for (const draftItem of [...split.review, ...plainSplit.review]) {
    await store.appendJudgment(
      projectId,
      judgmentFromDraft(projectId, draftItem, draftItem.hint),
    )
  }
  const directSignals = await store.readSignals(projectId)
  check(
    '直通信号带上了 hint',
    directSignals.length === 2 && directSignals.every((item) => typeof item.hint === 'string'),
    JSON.stringify(directSignals.map((item) => item.hint)),
  )
  const pendingAfterSplit = (await store.readJudgments(projectId)).filter(
    (record) => record.status === 'pending',
  )
  check('低精度草稿停在 pending', pendingAfterSplit.length === 2, String(pendingAfterSplit.length))

  const gradeB = await publishDrafts(
    store,
    state,
    'proj-grade-b',
    [draft({ signalType: 'core_bypass' })],
    config,
    new Date(),
    { mayEscalate: false },
  )
  check('Grade B 直通仍记录信号', gradeB.signals.length === 1, String(gradeB.signals.length))
  check('Grade B 不开卡', gradeB.interventions.length === 0, String(gradeB.interventions.length))
  check('Grade B 信号停在 Level 0', gradeB.signals[0]?.signal.level === 0, String(gradeB.signals[0]?.signal.level))

  console.log('\n=== E2: allowUnreviewedEscalation 开关 ===')
  const strict = parseConfig({})
  const permissive = parseConfig({ judgment: { allowUnreviewedEscalation: true } })
  check('默认保守：低精度不直通', precisionOf(lowDraft, {}, strict.judgment.allowUnreviewedEscalation) === 'review')
  check('开启后低精度也直通', precisionOf(lowDraft, {}, permissive.judgment.allowUnreviewedEscalation) === 'direct')
  check(
    '默认 backlogLimit 是 200',
    strict.judgment.backlogLimit === 200,
    String(strict.judgment.backlogLimit),
  )
  check(
    '默认时效目标是 10 分钟',
    strict.judgment.maxLatencyMinutes === 10,
    String(strict.judgment.maxLatencyMinutes),
  )

  console.log('\n=== E2: 复核失败提醒（同原因一次，恢复后重新武装）===')
  const notifier = new ReviewFailureNotifier({
    statePath: join(root, '.metacog', 'judgment-review-failures.json'),
    remind: () => {},
  })
  const firstFailure = notifier.noteFailure('the review could not start: no subagent available')
  check('首次失败给出中文提醒', typeof firstFailure === 'string' && firstFailure.length > 0, String(firstFailure))
  check('提醒说明复核不可用', firstFailure.includes('自动复核当前不可用'), firstFailure)
  check('同原因再次失败不重复提醒', notifier.noteFailure('no subagent available') === undefined)
  notifier.noteSuccess()
  const afterRecovery = notifier.noteFailure('no subagent available')
  check('恢复后再失败会再提醒', typeof afterRecovery === 'string' && afterRecovery.length > 0, String(afterRecovery))

  console.log('\n=== E2: 积压上限：丢最旧并留痕 ===')
  const backlogStore = new MetacogStore(join(root, 'backlog'), '.metacog')
  const backlogProject = 'proj-backlog'
  const appended = []
  for (let index = 0; index < 5; index += 1) {
    const record = judgmentFromDraft(
      backlogProject,
      draft({ signalType: 'goal_staleness', relatedGoalIds: [`G${index}`], observedAt: new Date().toISOString() }),
      `candidate ${index}`,
    )
    appended.push(record.id)
    await backlogStore.appendJudgment(backlogProject, record)
  }
  const trim = await trimJudgmentBacklog(backlogStore, backlogProject, 3, new Date())
  check('超出上限时丢弃 2 条', trim.dropped === 2, String(trim.dropped))
  check('丢弃的是最旧的 2 条', JSON.stringify(trim.ids) === JSON.stringify(appended.slice(0, 2)), JSON.stringify(trim.ids))
  const afterTrim = await backlogStore.readJudgments(backlogProject)
  const stillPending = afterTrim.filter((record) => record.status === 'pending')
  check('pending 数量不超过上限', stillPending.length === 3, String(stillPending.length))
  const dropped = afterTrim.filter((record) => record.modelReason === JUDGMENT_BACKLOG_DROP_REASON)
  check('丢弃记录留痕', dropped.length === 2, String(dropped.length))
  check('丢弃记录被结算为 dismissed', dropped.every((record) => record.status === 'dismissed'))
  check('留痕原因说明是积压', dropped.every((record) => record.modelReason.includes('积压')))

  console.log('\n=== E3: 高置信偏离在配置的 N 分钟内可见 ===')
  const latencyStore = new MetacogStore(join(root, 'latency'), '.metacog')
  const latencyProject = 'proj-latency-visible'
  const hitAt = new Date()
  await publishDrafts(
    latencyStore,
    { ...state, projectId: latencyProject },
    latencyProject,
    [draft({ observedAt: hitAt.toISOString() })],
    config,
    hitAt,
  )
  const visible = await latencyStore.readSignals(latencyProject)
  check('高精度命中立即产生信号', visible.length === 1, String(visible.length))
  const ageMs = Date.now() - Date.parse(visible[0].observedAt)
  check(
    `信号在 ${config.judgment.maxLatencyMinutes} 分钟内可见`,
    ageMs >= 0 && ageMs <= config.judgment.maxLatencyMinutes * 60_000,
    `${ageMs}ms`,
  )

  console.log('\n=== 状态卡：复核模式与时效目标可见 ===')
  const strictBlock = renderPromptBlock(undefined, [], [], config)
  check('状态卡写明复核模式', strictBlock.includes('复核模式'), strictBlock)
  check('默认显示保守模式', strictBlock.includes('保守'), strictBlock)
  check('状态卡写有时效目标', strictBlock.includes(`${config.judgment.maxLatencyMinutes} 分钟`), strictBlock)
  const permissiveBlock = renderPromptBlock(undefined, [], [], permissive)
  check('开启降级后显示直通模式', permissiveBlock.includes('直通'), permissiveBlock)

  console.log('\n=== 状态卡：pending 只渲染一条 ===')
  const card = InterventionRecordSchema.parse({
    id: 'iv_latency',
    projectId,
    signalId: 'sig_latency',
    level: 2,
    promptSummary: 'TECHNICAL PROMPT SUMMARY',
    hint: '核心矛盾强度未降；先处理这张卡片。',
    createdAt: new Date().toISOString(),
  })
  const hintLine = pendingInterventionHint(card)
  const withHints = renderPromptBlock(undefined, [card], [hintLine], config)
  check(
    'hints 通道提供时只出现一条卡片提示',
    withHints.split('核心矛盾强度未降').length - 1 === 1,
    withHints,
  )
  check('不再出现英文 promptSummary', !withHints.includes('TECHNICAL PROMPT'), withHints)
  const fallbackBlock = renderPromptBlock(undefined, [card], [], config)
  check('无 hints 时用中文兜底渲染一次', fallbackBlock.split('核心矛盾强度未降').length - 1 === 1, fallbackBlock)
  check('兜底也不出现英文 promptSummary', !fallbackBlock.includes('TECHNICAL PROMPT'), fallbackBlock)
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n=== Latency 结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
