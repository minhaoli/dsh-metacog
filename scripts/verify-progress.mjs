/**
 * 时间线与进度的验证。
 *
 * 两条规则是这个模块的全部价值：
 * 1. 提醒点是跨度的分数（1/4、1/2、3/4），不是固定日期。两周的目标和两年的目标
 *    都得到四个检查点，不同的是它们落在哪天。
 * 2. 长时间跨度的目标不能用日粒度考核。两年的根目标今天没动静不是停滞。
 *
 * 所以这里重点验证：分档边界、跨度决定层级、有推进时不提醒、逾期与日期错误。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChecker, libUrl } from './_harness.mjs'

/** A path inside `lib/`, resolved relative to this checkout. */
const lib = (p) => libUrl('lib', p)
const { check, counts, exit } = createChecker()
const { apply } = await import(lib('index.js'))
const { MetacogStore } = await import(lib('data/store.js'))
const { deriveProjectId } = await import(lib('tools/shared.js'))
const { stageFor, depthsForSpan, evaluateProgress, summarizeProgress } = await import(
  lib('analysis/progress.js')
)
const { detectDeadlineRisk } = await import(lib('analysis/drift.js'))
const { parseGoalCommand } = await import(lib('commands/edit.js'))



console.log('=== 1. 分档边界 ===')
check('0 是 early', stageFor(0) === 'early', stageFor(0))
check('0.24 还是 early', stageFor(0.24) === 'early', stageFor(0.24))
check('0.25 正好进 quarter', stageFor(0.25) === 'quarter', stageFor(0.25))
check('0.49 仍在 quarter', stageFor(0.49) === 'quarter', stageFor(0.49))
check('0.5 进 half', stageFor(0.5) === 'half', stageFor(0.5))
check('0.75 进 three-quarter', stageFor(0.75) === 'three-quarter', stageFor(0.75))
check('1 及以上是 overdue', stageFor(1) === 'overdue', stageFor(1))
check('负数视为未开始', stageFor(-0.1) === 'not-started', stageFor(-0.1))

console.log('\n=== 2. 跨度决定检查层级 ===')
const shortDepths = depthsForSpan(7)
const midDepths = depthsForSpan(30)
const longDepths = depthsForSpan(365)
check('短跨度只看深层目标', !shortDepths.includes(0) && !shortDepths.includes(1), JSON.stringify(shortDepths))
check('短跨度包含叶子层', shortDepths.includes(3), JSON.stringify(shortDepths))
check('中跨度看中层', midDepths.includes(1) && midDepths.includes(2), JSON.stringify(midDepths))
check('长跨度只看战略层', longDepths.includes(0) && longDepths.includes(1), JSON.stringify(longDepths))
check('长跨度不看叶子', !longDepths.includes(3), JSON.stringify(longDepths))

console.log('\n=== 3. 有推进时不提醒 ===')
const now = new Date('2026-10-28T12:00:00.000Z')
/** Build a goal with a span from `startedAt` to `deadline`. */
const goal = (overrides) => ({
  id: 'G1',
  projectId: 'p',
  parentId: 'L0',
  depth: 2,
  title: '某目标',
  description: '',
  status: 'active',
  priority: 0,
  confirmedByUser: true,
  successCriteria: [],
  alignment: {
    relevantActivities: [],
    allowedMethods: [],
    excludedActivities: [],
    explorationPolicy: 'limited',
  },
  evidence: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
})

// 40-day span, 25 days in → 62% elapsed → half stage.
const halfGoal = goal({
  startedAt: '2026-09-18T00:00:00.000Z',
  deadline: '2026-10-28T00:00:00.000Z',
})
const withProgress = evaluateProgress([halfGoal], {
  now,
  lastTouched: new Map([['G1', '2026-10-25T00:00:00.000Z']]),
})
check('走到一半', withProgress.findings[0]?.stage === 'overdue' || withProgress.findings[0]?.stage === 'three-quarter', String(withProgress.findings[0]?.stage))
check('有推进就不提醒', withProgress.findings[0]?.shouldRemind === false, String(withProgress.findings[0]?.shouldRemind))
check('消息说明有推进', String(withProgress.findings[0]?.message).includes('有推进记录'), String(withProgress.findings[0]?.message))

const withoutProgress = evaluateProgress([halfGoal], {
  now,
  lastTouched: new Map([['G1', '2026-09-18T00:00:00.000Z']]),
})
check('没推进则提醒', withoutProgress.findings[0]?.shouldRemind === true, String(withoutProgress.findings[0]?.shouldRemind))
check('消息说明没推进', String(withoutProgress.findings[0]?.message).includes('没有推进记录'), String(withoutProgress.findings[0]?.message))

console.log('\n=== 4. 层级不匹配时不提醒 ===')
// A 365-day root goal with no movement: long span, depth 0, so it IS checked,
// but a 7-day leaf goal checked against depth 0 rules is not.
const longRoot = goal({
  id: 'G0',
  depth: 0,
  parentId: null,
  title: '两年的根目标',
  startedAt: '2026-01-01T00:00:00.000Z',
  deadline: '2027-01-01T00:00:00.000Z',
})
const longRootResult = evaluateProgress([longRoot], {
  now,
  lastTouched: new Map([['G0', '2026-01-01T00:00:00.000Z']]),
})
check('长跨度根目标被检查', longRootResult.findings.length === 1, String(longRootResult.findings.length))
check('长跨度根目标在 3/4 档', longRootResult.findings[0]?.stage === 'three-quarter', String(longRootResult.findings[0]?.stage))
check('长跨度根目标会提醒', longRootResult.findings[0]?.shouldRemind === true, String(longRootResult.findings[0]?.shouldRemind))

const shortLeafNoRemind = goal({
  id: 'G9',
  depth: 0,
  parentId: null,
  title: '短跨度的根目标',
  startedAt: '2026-10-20T00:00:00.000Z',
  deadline: '2026-10-30T00:00:00.000Z',
})
const shortRootResult = evaluateProgress([shortLeafNoRemind], {
  now,
  lastTouched: new Map([['G9', '2026-10-20T00:00:00.000Z']]),
})
check('短跨度的根目标不提醒（层级不匹配）', shortRootResult.findings[0]?.shouldRemind === false, String(shortRootResult.findings[0]?.shouldRemind))

console.log('\n=== 5. 逾期与日期错误 ===')
const overdue = goal({
  startedAt: '2026-09-01T00:00:00.000Z',
  deadline: '2026-10-20T00:00:00.000Z',
})
const overdueResult = evaluateProgress([overdue], {
  now,
  lastTouched: new Map([['G1', '2026-09-01T00:00:00.000Z']]),
})
check('识别为逾期', overdueResult.findings[0]?.stage === 'overdue', String(overdueResult.findings[0]?.stage))
check('逾期天数正确', Math.round(overdueResult.findings[0]?.daysLeft ?? 0) === -8, String(overdueResult.findings[0]?.daysLeft))
check('逾期会提醒', overdueResult.findings[0]?.shouldRemind === true, String(overdueResult.findings[0]?.shouldRemind))
check('消息含逾期天数', String(overdueResult.findings[0]?.message).includes('逾期 8 天'), String(overdueResult.findings[0]?.message))

const badDates = goal({
  startedAt: '2026-10-20T00:00:00.000Z',
  deadline: '2026-10-01T00:00:00.000Z',
})
const badResult = evaluateProgress([badDates], { now, lastTouched: new Map() })
check('截止早于开始被抓', String(badResult.findings[0]?.message).includes('需要修正'), String(badResult.findings[0]?.message))

console.log('\n=== 6. 没有截止时间的目标 ===')
const undated = goal({ id: 'G5', title: '没有日期的目标' })
const undatedResult = evaluateProgress([undated], { now, lastTouched: new Map() })
check('不产生 finding', undatedResult.findings.length === 0, String(undatedResult.findings.length))
check('计入 undated', undatedResult.undated === 1, String(undatedResult.undated))

console.log('\n=== 7. 汇总 ===')
const summary = summarizeProgress(overdueResult.findings, 3)
check('逾期单独成列', summary.overdue.length === 1, String(summary.overdue.length))
check('提醒列表不含逾期', summary.remind.every((f) => f.stage !== 'overdue'), JSON.stringify(summary.remind.map((f) => f.stage)))
check('undated 透传', summary.undated === 3, String(summary.undated))

console.log('\n=== 8. 命令支持 --deadline ===')
const parsed = parseGoalCommand('某目标 --deadline=2026-11-30 --reason="定截止"')
check('日期被解析', typeof parsed.fields.deadline === 'string', String(parsed.fields.deadline))
check('日期归一为 ISO', String(parsed.fields.deadline).startsWith('2026-11-30T'), String(parsed.fields.deadline))
const isoParsed = parseGoalCommand('某目标 --deadline=2026-11-30T10:00:00.000Z --reason="x"')
check('完整 ISO 也接受', isoParsed.fields.deadline === '2026-11-30T10:00:00.000Z', String(isoParsed.fields.deadline))
let badDateRejected = false
try {
  parseGoalCommand('某目标 --deadline=下个月 --reason="x"')
} catch (error) {
  badDateRejected = String(error).includes('--deadline')
}
check('非法日期被拒', badDateRejected, 'not refused')

console.log('\n=== 9. 工具层：设置 deadline 并触发信号 ===')
const root = await mkdtemp(join(tmpdir(), 'metacog-progress-'))
try {
  await writeFile(join(root, 'README.md'), '# 进度验证\n')
  const tools = new Map()
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return { get: () => root, defaultDirectory: root }
      if (name === 'tools') return this.tools
      if (name === 'sessions') return { get: () => undefined, list: () => [] }
      return undefined
    },
    logger: { debug() {}, info() {}, warn() {} },
    on: () => () => {},
    effect: () => {},
    tools: { register: (d) => (tools.set(d.name, d), () => tools.delete(d.name)) },
    workingDirectory: { get: () => root, defaultDirectory: root },
  }
  apply(ctx, {})
  const call = (name, args) =>
    tools.get(name).execute(args, {
      callId: `c-${Math.random().toString(16).slice(2)}`,
      name,
      arguments: args,
      signal: new AbortController().signal,
      agent: { id: 'progress-test', session: { id: 'session-p', header: { cwd: root } } },
    })

  const store = new MetacogStore(root, '.metacog')
  const projectId = deriveProjectId(root)
  await call('goal_tree_confirm', {
    expectedVersion: 0,
    l0: { title: '进度验证的根目标', evidence: ['README.md'] },
    goals: [{ title: '有截止的目标', evidence: ['README.md'], depth: 1 }],
    contradictions: [],
    reason: '进度验证基线',
  })

  const view = await call('goal_tree_view', {})
  const goalId = view.data.goals.find((g) => g.depth === 1).id
  // A span that is already 80% gone, so the deadline check fires immediately.
  const startedAt = new Date(Date.now() - 80 * 86_400_000).toISOString()
  const deadline = new Date(Date.now() + 20 * 86_400_000).toISOString()

  const edited = await call('goal_tree_edit', {
    expectedVersion: 1,
    reason: '给目标定截止时间',
    updates: [{ id: goalId, deadline, startedAt }],
  })
  check('设置截止成功', edited.ok === true, JSON.stringify(edited).slice(0, 200))

  // A deadline change moves every progress checkpoint, so it must appear as a
  // real change. When it did not, the edit landed with an empty changedGoalIds
  // and the audit could not name the goal that moved.
  check(
    '改 deadline 被识别为变更',
    Array.isArray(edited.data?.changedGoalIds) && edited.data.changedGoalIds.includes(goalId),
    JSON.stringify(edited.data?.changedGoalIds),
  )
  const afterEdit = await store.readState(projectId)
  const dated = afterEdit.goals.find((g) => g.id === goalId)
  check('deadline 已落盘', dated?.deadline === deadline, String(dated?.deadline))
  check('startedAt 已落盘', dated?.startedAt === startedAt, String(dated?.startedAt))

  const staticCheck = await call('check_drift', {})
  check('静态检查成功', staticCheck.ok === true, JSON.stringify(staticCheck).slice(0, 200))
  const deadlineSignals = (staticCheck.data?.signals ?? []).filter(
    (signal) => signal.signalType === 'deadline_risk',
  )
  check('产生 deadline_risk 信号', deadlineSignals.length === 1, JSON.stringify((staticCheck.data?.signals ?? []).map((s) => s.signalType)))
  check('信号指向该目标', deadlineSignals[0]?.relatedGoalIds.includes(goalId), JSON.stringify(deadlineSignals[0]?.relatedGoalIds))
  check('信号理由是进度描述', String(deadlineSignals[0]?.rationale).includes('时间'), String(deadlineSignals[0]?.rationale))

  console.log('\n--- 清除截止时间 ---')
  const cleared = await call('goal_tree_edit', {
    expectedVersion: afterEdit.version,
    reason: '取消截止时间',
    updates: [{ id: goalId, deadline: '' }],
  })
  check('清除成功', cleared.ok === true, JSON.stringify(cleared).slice(0, 200))
  const afterClear = await store.readState(projectId)
  check('deadline 已清除', afterClear.goals.find((g) => g.id === goalId)?.deadline === undefined, String(afterClear.goals.find((g) => g.id === goalId)?.deadline))

  const noSignal = await call('check_drift', {})
  const stillThere = (noSignal.data?.signals ?? []).filter((s) => s.signalType === 'deadline_risk')
  check('清除后不再产生新信号', stillThere.length === 0, JSON.stringify(stillThere.map((s) => s.signalType)))

  console.log('\n--- 直接调用检测器 ---')
  const direct = detectDeadlineRisk({
    state: afterEdit,
    activities: [],
    observations: [],
    signals: [],
    config: { thresholds: { windowMinutes: 120 } },
    now: new Date(),
  })
  check('检测器能直接跑', Array.isArray(direct), typeof direct)
} finally {
  await rm(root, { recursive: true, force: true })
}

exit()
