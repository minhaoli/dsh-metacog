/**
 * Stage B acceptance: screening queues candidates, review publishes them.
 *
 * The behaviour under test is the split the user asked for — a rule hit is a
 * *candidate*, and only a second opinion turns it into a signal. The stub
 * subagent makes the review deterministic, so the assertions are about the
 * protocol rather than about any model's judgement.
 *
 * Run: node test/judgment-flow.test.mjs
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

const { apply } = await import(lib('index.js'))
const { MetacogStore } = await import(lib('data/store.js'))
const { deriveProjectId } = await import(lib('tools/shared.js'))
const { parseConfig } = await import(lib('config.js'))
const { runActivityCheck } = await import(lib('analysis/service.js'))
const { judgmentFromDraft, reviewPendingJudgments, remindIfLogIsLong, assessWindow, buildWindowPrompt } =
  await import(lib('analysis/judgment.js'))

/** A subagent that answers with whatever verdicts the test wants. */
function stubCtx(verdicts) {
  const tools = new Map()
  return {
    get(name) {
      if (name === 'workingDirectory') return { get: () => root, defaultDirectory: root }
      if (name === 'tools') return { register: (d) => (tools.set(d.name, d), () => {}) }
      if (name === 'agents') return { currentInitiator: () => ({ id: 'agent-test' }) }
      if (name === 'subagents') {
        return {
          list: () => ['stub'],
          resolveMaxDepth: () => 3,
          async startActivation() {
            return {
              childId: 'child-stub',
              result: Promise.resolve({
                output: [{ type: 'text', text: '{}' }],
                stopReason: 'completed',
                structured: { verdicts },
              }),
              dispose: async () => {},
            }
          },
        }
      }
      return undefined
    },
    logger: { debug() {}, info() {}, warn() {} },
    on: () => () => {},
    effect: () => {},
    tools: { register: () => () => {} },
    workingDirectory: { get: () => root, defaultDirectory: root },
  }
}

const root = await mkdtemp(join(tmpdir(), 'metacog-judgment-'))
try {
  await writeFile(join(root, 'README.md'), '# 判定项目\n\n一切服务于让监控可信。\n')

  // A confirmed tree, built through the real tool path.
  const host = stubCtx([])
  apply(host, {})
  const tools = new Map()
  const original = host.tools.register
  host.tools.register = (definition) => {
    tools.set(definition.name, definition)
    return original(definition)
  }
  // `apply` captured the object, so re-register explicitly for the test's needs.
  const mountCtx = host
  mountCtx.tools.register = (definition) => (tools.set(definition.name, definition), () => {})
  apply(mountCtx, {})

  const call = (name, args) =>
    tools.get(name).execute(args, {
      callId: 'c',
      name,
      arguments: args,
      signal: new AbortController().signal,
      agent: { id: 'agent-test' },
    })

  const confirmArgs = {
    expectedVersion: 0,
    l0: {
      title: '让监控结论可信',
      evidence: ['README.md'],
      // 本测试走「单条判定 → 候选草稿 → 发布信号」的链路，
      // 根目标服务的活动就是这类判定流。
      alignment: { relevantActivities: ['判定流转'] },
    },
    goals: [
      {
        depth: 1,
        title: '把判定建立在证据上',
        evidence: ['README.md'],
        successCriteria: ['每条判断可追溯'],
        alignment: { relevantActivities: ['判定流转'] },
      },
    ],
    contradictions: [],
    reason: '测试',
  }
  await call('goal_tree_confirm', { ...confirmArgs, preview: true, noDeadlineGoalRefs: ['*'] })
  const confirm = await call('goal_tree_confirm', {
    ...confirmArgs,
    userApproved: true,
    approvalNote: 'judgment 测试确认',
  })
  check('树已确认', confirm.ok === true, JSON.stringify(confirm).slice(0, 200))

  const store = new MetacogStore(root, '.metacog')
  const projectId = deriveProjectId(root)
  const config = parseConfig({})
  const state = await store.readState(projectId)

  console.log('\n=== B1: 单条判定不再直接发信号 ===')
  const outcome = await runActivityCheck(
    store,
    state,
    projectId,
    {
      summary: 'pwsh: 整理一个与项目无关的临时脚本',
      evidence: ['scratch/tmp.mjs'],
      source: 'tool_event',
      grade: 'A',
      sessionId: 'session-test',
      eventFingerprint: 'fp-1',
      toolName: 'pwsh',
      deferSignals: true,
    },
    config,
  )
  check('没有已发布信号', outcome.signals.length === 0, String(outcome.signals.length))
  check('候选被返回给调用方', Array.isArray(outcome.drafts), typeof outcome.drafts)
  check('磁盘上也没有信号', (await store.readSignals(projectId)).length === 0)

  console.log('\n=== B2: 模型判「不是漂移」→ 不发布 ===')
  const draft = {
    observedAt: new Date().toISOString(),
    monitorCategory: 'goal_alignment',
    signalType: 'scope_drift',
    relatedGoalIds: [],
    relatedContradictionIds: [],
    activityIds: [outcome.activity.id],
    confidence: 0.9,
    evidence: ['scratch/tmp.mjs'],
    rationale: '程序认为这次活动脱离目标',
  }
  const queued = judgmentFromDraft(projectId, draft, 'pwsh: 整理一个与项目无关的临时脚本')
  await store.appendJudgment(projectId, queued)
  check('候选已入队', (await store.readJudgments(projectId)).length === 1)

  const rejected = await reviewPendingJudgments({
    ctx: stubCtx([{ id: queued.id, isDrift: false, reason: '这是必要的临时脚本' }]),
    store,
    projectId,
    state,
    config,
  })
  check('复核跑了一条', rejected.reviewed === 1, String(rejected.reviewed))
  check('模型否决', rejected.dismissed === 1 && rejected.confirmed === 0)
  check('没有发布信号', (await store.readSignals(projectId)).length === 0)
  const afterReject = (await store.readJudgments(projectId))[0]
  check('记录状态为 dismissed', afterReject.status === 'dismissed', afterReject.status)
  check('保留了程序侧理由', afterReject.programReason.includes('程序认为'))
  check('记录了模型侧理由', afterReject.modelReason === '这是必要的临时脚本', afterReject.modelReason)

  console.log('\n=== B3: 模型也判漂移 → 才发布信号 ===')
  const queued2 = judgmentFromDraft(projectId, { ...draft, activityIds: [outcome.activity.id] }, '继续跑无关脚本')
  await store.appendJudgment(projectId, queued2)
  const accepted = await reviewPendingJudgments({
    ctx: stubCtx([{ id: queued2.id, isDrift: true, reason: '确实与所有目标无关' }]),
    store,
    projectId,
    state,
    config,
  })
  check('模型确认', accepted.confirmed === 1, String(accepted.confirmed))
  const signals = await store.readSignals(projectId)
  check('信号已发布', signals.length === 1, String(signals.length))
  check('信号类型正确', signals[0]?.signalType === 'scope_drift', String(signals[0]?.signalType))
  const afterAccept = (await store.readJudgments(projectId)).find((r) => r.id === queued2.id)
  check('记录状态为 confirmed', afterAccept.status === 'confirmed', afterAccept.status)

  console.log('\n=== B4: 没有模型可用时保留队列 ===')
  const queued3 = judgmentFromDraft(projectId, { ...draft }, '第三次无关活动')
  await store.appendJudgment(projectId, queued3)
  const noModel = await reviewPendingJudgments({
    ctx: {
      get: () => undefined,
      logger: { debug() {}, info() {}, warn() {} },
      on: () => () => {},
      effect: () => {},
      tools: { register: () => () => {} },
    },
    store,
    projectId,
    state,
    config,
  })
  check('报告不可用原因', typeof noModel.problem === 'string', String(noModel.problem))
  const stillPending = (await store.readJudgments(projectId)).find((r) => r.id === queued3.id)
  check('候选仍然等待复核', stillPending.status === 'pending', stillPending.status)

  console.log('\n=== B5: 日志攒够后提醒一次 ===')
  const hints = await remindIfLogIsLong(store, projectId, {
    ...config,
    thresholds: { ...config.thresholds, judgmentLogThreshold: 2 },
  })
  check('给出读日志的提醒', hints.length === 1 && hints[0].includes('判定日志'), JSON.stringify(hints))
  const again = await remindIfLogIsLong(store, projectId, {
    ...config,
    thresholds: { ...config.thresholds, judgmentLogThreshold: 2 },
  })
  console.log('\n=== B6: 整体偏移评估（手动触发入口的核心） ===')
  {
    const drifted = await assessWindow({
      ctx: stubCtx([{ id: 'x', isDrift: false, reason: '' }]),
      state,
      activities: [
        { summary: '整理无关的临时脚本', decision: 'scope_drift', timestamp: new Date().toISOString() },
        { summary: '又改了那个脚本', decision: 'scope_drift', timestamp: new Date().toISOString() },
      ],
    })
    // 桩子代理返回的是 {verdicts:[...]}，不是窗口评估的形状，应明确失败而不是猜。
    check('形状不符时明确失败', drifted.status === 'failed', JSON.stringify(drifted).slice(0, 160))

    const empty = await assessWindow({ ctx: stubCtx([]), state, activities: [] })
    check('没有活动时直接返回空', empty.status === 'empty', empty.status)

    const unavailable = await assessWindow({
      ctx: {
        get: () => undefined,
        logger: { debug() {}, info() {}, warn() {} },
        on: () => () => {},
        effect: () => {},
        tools: { register: () => () => {} },
      },
      state,
      activities: [{ summary: 'a', decision: 'aligned', timestamp: new Date().toISOString() }],
    })
    check('没有模型时报告不可用', unavailable.status === 'unavailable', JSON.stringify(unavailable).slice(0, 160))
  }

  console.log('\n=== B7: 评估提示词包含目标树与活动 ===')
  {
    const prompt = buildWindowPrompt(state, [
      { summary: '把判定的证据链补上', decision: 'aligned', timestamp: '2026-10-28T00:00:00.000Z' },
    ])
    check('包含根目标', prompt.includes('让监控结论可信'), prompt.slice(0, 80))
    check('包含活动摘要', prompt.includes('把判定的证据链补上'))
    check('包含程序当时判定', prompt.includes('[aligned]'))
    check('要求引用具体活动', prompt.includes('引用'), prompt.slice(-160))
    check('拿不准时倾向不报', prompt.includes('拿不准'))
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n=== Judgment 结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
