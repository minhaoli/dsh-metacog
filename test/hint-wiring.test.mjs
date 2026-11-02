/**
 * Hint end-to-end wiring.
 *
 * D wrote the hints; this suite pins that they reach the user. A hint that is
 * generated but dropped on the way to the signal record, the intervention card,
 * the prompt block or the check_drift output is indistinguishable from no hint
 * at all.
 *
 * Run: node test/hint-wiring.test.mjs   (after `npm run build`)
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

const CHINESE = /[\u4e00-\u9fff]/

const { apply } = await import(lib('index.js'))
const { parseConfig } = await import(lib('config.js'))
const { MetacogStore } = await import(lib('data/store.js'))
const { DriftSignalSchema, InterventionRecordSchema } = await import(lib('data/types.js'))
const { level1Hint, pendingInterventionHint, coverageHint } = await import(
  lib('analysis/escalation.js')
)
const { renderPromptBlock } = await import(lib('report.js'))
const { evaluateCall } = await import(lib('gate.js'))
const { realtimeHint } = await import(lib('schedule.js'))
const { publishDrafts, buildIntervention } = await import(lib('analysis/service.js'))

const config = parseConfig({})

/** Mount the plugin against a minimal host and keep what it registers. */
function createHost(projectRoot) {
  const tools = new Map()
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return this.workingDirectory
      if (name === 'tools') return this.tools
      return undefined
    },
    logger: { debug() {}, info() {}, warn() {} },
    on: () => () => {},
    effect: () => {},
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    workingDirectory: { get: () => projectRoot, defaultDirectory: projectRoot },
  }
  apply(ctx, {})
  return { ctx, tools }
}

async function call(tools, name, args) {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`tool "${name}" was never registered`)
  return definition.execute(args, {
    callId: `call-${Math.random().toString(16).slice(2)}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
    agent: { id: 'agent-hint-wiring' },
  })
}

const root = await mkdtemp(join(tmpdir(), 'metacog-hint-wiring-'))
try {
  await writeFile(join(root, 'README.md'), '# 提示接线项目\n\n用于验证 hint 端到端。\n')
  const { tools } = createHost(root)

  console.log('\n=== W1: 确认一棵树，准备触发 scope_drift ===')
  const confirmArgs = {
    expectedVersion: 0,
    l0: {
      title: '根目标',
      evidence: ['README.md'],
      successCriteria: ['根目标可以被外部验证'],
      alignment: { relevantActivities: ['完全不相关的判据'] },
    },
    reason: '接线测试',
  }
  await call(tools, 'goal_tree_confirm', { ...confirmArgs, preview: true, noDeadlineGoalRefs: ['*'] })
  const confirmed = await call(tools, 'goal_tree_confirm', {
    ...confirmArgs,
    userApproved: true,
    approvalNote: '接线测试确认',
  })
  check('确认成功', confirmed.ok === true, JSON.stringify(confirmed).slice(0, 300))
  const view = await call(tools, 'goal_tree_view', {})
  const projectId = view.data.projectId
  const state = await new MetacogStore(root, '.metacog').readState(projectId)
  check('状态可读', state !== undefined)

  const drift = (summary) =>
    call(tools, 'check_drift', {
      activity: {
        summary,
        evidence: ['README.md'],
        grade: 'A',
        source: 'manual',
      },
    })

  console.log('\n=== W2: draft 的 hint 落库，且 check_drift 同时返回 hint 与 rationale ===')
  const first = await drift('写点别的东西')
  check('第一次判定成功', first.ok === true, JSON.stringify(first).slice(0, 300))
  const signal = first.data?.signals?.[0]
  check('产生了 scope_drift 信号', signal?.signalType === 'scope_drift', JSON.stringify(signal))
  check('工具输出带 hint', typeof signal?.hint === 'string' && signal.hint.length > 0, JSON.stringify(signal))
  check('hint 是具体内容而非兜底', signal?.hint?.includes('被判偏离目标') === true, signal?.hint)
  check('工具输出仍保留 rationale', typeof signal?.rationale === 'string' && signal.rationale.length > 0)
  check(
    '工具输出带 escalationHint',
    typeof signal?.escalationHint === 'string' && signal.escalationHint.length > 0,
    signal?.escalationHint,
  )
  check(
    '工具输出带 verdictHint',
    typeof first.data?.verdictHint === 'string' && first.data.verdictHint.length > 0,
    first.data?.verdictHint,
  )

  const store = new MetacogStore(root, '.metacog')
  const storedSignals = await store.readSignals(projectId)
  const storedSignal = storedSignals.find((item) => item.id === signal?.id)
  check('信号已落库', storedSignal !== undefined)
  check('落库的 hint 与工具输出一致', storedSignal?.hint === signal?.hint, `${storedSignal?.hint} vs ${signal?.hint}`)
  check('落库仍保留 rationale', (storedSignal?.rationale?.length ?? 0) > 0)

  console.log('\n=== W3: 开卡后 InterventionRecord.hint 与信号一致 ===')
  await drift('继续写别的东西')
  const third = await drift('还是在写别的东西')
  check('第三次判定成功', third.ok === true, JSON.stringify(third).slice(0, 300))
  const opened = third.data?.interventions?.[0]
  check('重复达到阈值后开卡', opened !== undefined, JSON.stringify(third.data?.interventions))
  check('卡片带 hint', typeof opened?.hint === 'string' && opened.hint.length > 0, JSON.stringify(opened))
  check('卡片 hint 是具体内容', opened?.hint?.includes('被判偏离目标') === true, opened?.hint)
  const thirdSignal = third.data?.signals?.[0]
  check('卡片 hint 来自信号 hint', opened?.hint === thirdSignal?.hint, `${opened?.hint} vs ${thirdSignal?.hint}`)

  const storedInterventions = await store.readInterventions(projectId)
  const storedCard = storedInterventions.find((item) => item.id === opened?.id)
  check('卡片已落库且带 hint', storedCard?.hint === opened?.hint, JSON.stringify(storedCard?.hint))
  check(
    'pendingDecisions 用中文 hint',
    third.data?.pendingDecisions?.some((item) => item.hint?.includes('被判偏离目标')) === true,
    JSON.stringify(third.data?.pendingDecisions),
  )

  console.log('\n=== W4: prompt block 显示具体 hint，而不是兜底句 ===')
  const block = renderPromptBlock(state, [], [level1Hint(storedSignal)], config)
  check('prompt block 含具体 hint', block.includes('被判偏离目标'), block)
  check('prompt block 不再出现兜底句', !block.includes('发现一处需要留意的偏离'), block)
  check('prompt block 不把 rationale 当 hint', !block.includes('grade A activity'), block)

  console.log('\n=== W5: 旧数据走中文兜底，不回退英文 ===')
  const legacySignal = DriftSignalSchema.parse({
    id: 'sig_legacy',
    projectId,
    observedAt: new Date().toISOString(),
    monitorCategory: 'goal_alignment',
    signalType: 'scope_drift',
    level: 1,
    relatedGoalIds: [],
    relatedContradictionIds: [],
    confidence: 0.9,
    rationale: 'TECHNICAL RATIONALE ONLY',
  })
  const legacyLine = level1Hint(legacySignal)
  check('旧信号提示是中文', CHINESE.test(legacyLine), legacyLine)
  check('旧信号提示不含英文 rationale', !legacyLine.includes('TECHNICAL RATIONALE'), legacyLine)
  check('旧信号走兜底句', legacyLine.includes('check_drift'), legacyLine)

  const legacyCard = InterventionRecordSchema.parse({
    id: 'iv_legacy',
    projectId,
    signalId: 'sig_legacy',
    level: 2,
    promptSummary: 'TECHNICAL PROMPT SUMMARY',
    createdAt: new Date().toISOString(),
  })
  const legacyCardLine = pendingInterventionHint(legacyCard)
  check('旧卡片提示是中文', CHINESE.test(legacyCardLine), legacyCardLine)
  check('旧卡片提示不含 promptSummary', !legacyCardLine.includes('TECHNICAL PROMPT'), legacyCardLine)

  console.log('\n=== W5b: 旧 draft（没有 hint 字段）回放不崩、不写空串 ===')
  const legacyDraft = {
    observedAt: new Date().toISOString(),
    monitorCategory: 'goal_alignment',
    signalType: 'scope_drift',
    relatedGoalIds: [],
    relatedContradictionIds: [],
    activityIds: [],
    confidence: 0.9,
    evidence: ['README.md'],
    rationale: 'LEGACY DRAFT RATIONALE',
  }
  let replayError
  try {
    await publishDrafts(store, state, projectId, [legacyDraft], config, new Date())
  } catch (error) {
    replayError = error
  }
  check('旧 draft 回放不抛异常', replayError === undefined, String(replayError))
  const replayed = (await store.readSignals(projectId)).find((item) =>
    item.rationale.includes('LEGACY DRAFT RATIONALE'),
  )
  check('旧 draft 仍能写入信号', replayed !== undefined)
  check('缺失 hint 不写成空字符串', replayed?.hint === undefined, JSON.stringify(replayed?.hint))
  const replayedLine = replayed === undefined ? '' : level1Hint(replayed)
  check('旧信号提示走中文兜底', CHINESE.test(replayedLine) && !replayedLine.includes('LEGACY DRAFT'), replayedLine)

  console.log('\n=== W5c: 旧信号开卡不崩、卡片不写空 hint ===')
  const legacyCardSignal = DriftSignalSchema.parse({
    id: 'sig_legacy_card',
    projectId,
    observedAt: new Date().toISOString(),
    monitorCategory: 'goal_alignment',
    signalType: 'scope_drift',
    level: 2,
    relatedGoalIds: [],
    relatedContradictionIds: [],
    confidence: 0.9,
    rationale: 'LEGACY CARD RATIONALE',
  })
  let cardError
  let legacyCard2
  try {
    legacyCard2 = buildIntervention(legacyCardSignal, state, new Date())
  } catch (error) {
    cardError = error
  }
  check('旧信号开卡不抛异常', cardError === undefined, String(cardError))
  check('旧卡片没有 hint 字段', legacyCard2?.hint === undefined, JSON.stringify(legacyCard2?.hint))
  check('旧卡片仍有技术 promptSummary', (legacyCard2?.promptSummary?.length ?? 0) > 0)

  console.log('\n=== W6: 覆盖率不足时 prompt block 有解释 ===')
  const coverageNote = coverageHint(0.25, config.signals.coverageFloor, false)
  check('低覆盖返回说明', typeof coverageNote === 'string' && coverageNote.length > 0, String(coverageNote))
  const coverageBlock = renderPromptBlock(undefined, [], [coverageNote], config)
  check('prompt block 出现覆盖率说明', coverageBlock.includes('没有声明计划'), coverageBlock)
  check('说明里有具体数字', coverageBlock.includes('25%'), coverageBlock)
  check('覆盖足够时不返回说明', coverageHint(0.5, config.signals.coverageFloor, false) === undefined)

  console.log('\n=== W7: Level 3 拦截消息优先 hint，且含解除方式 ===')
  const l3 = InterventionRecordSchema.parse({
    id: 'iv_l3',
    projectId,
    signalId: 'sig_legacy',
    level: 3,
    status: 'pending',
    promptSummary: 'TECHNICAL PROMPT SUMMARY',
    hint: '核心矛盾强度未降，已重复出现；先处理这张卡片再继续。',
    suggestedActions: ['continue'],
    createdAt: new Date().toISOString(),
  })
  await store.appendIntervention(projectId, l3)
  const gate = await evaluateCall(
    { name: 'write', agent: { id: 'agent-gate', session: { id: 'session-gate' } } },
    {
      ctx: {},
      config,
      storeForSession: async () => ({ store, projectId }),
    },
  )
  check('拦截决定是 deny', gate.decision.kind === 'deny', JSON.stringify(gate.decision))
  check('拦截消息含卡片 hint', gate.decision.reason.includes('核心矛盾强度未降'), gate.decision.reason)
  check('拦截消息不含 promptSummary', !gate.decision.reason.includes('TECHNICAL PROMPT'), gate.decision.reason)
  check('拦截消息给出解除工具', gate.decision.reason.includes('resolve_intervention'), gate.decision.reason)
  for (const option of ['continue', 'realign', 'modify_goals', 'dismiss']) {
    check(`拦截消息列出 ${option}`, gate.decision.reason.includes(option), gate.decision.reason)
  }

  console.log('\n=== W8: 实时判定 hint 含动作且受长度约束 ===')
  const realtime = realtimeHint(0.42, '子目标', '可能换了方向')
  check('实时 hint 是中文', CHINESE.test(realtime), realtime)
  check('实时 hint 含目标标题', realtime.includes('子目标'), realtime)
  check('实时 hint 含可执行动作', realtime.includes('metacog_revise_plan'), realtime)
  check('实时 hint 不超过 60 字', realtime.length <= 60, `${realtime.length}：${realtime}`)
  const longRealtime = realtimeHint(0.12, '一个非常非常长的目标标题'.repeat(3), '理由'.repeat(30))
  check('超长实时 hint 被截断', longRealtime.length <= 60, `${longRealtime.length}`)
  check('截断后仍保留动作', longRealtime.includes('metacog_revise_plan'), longRealtime)
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n=== Hint wiring 结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
