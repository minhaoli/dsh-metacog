/**
 * Untested-until-now surfaces: the checkpoint window, the daily monitor section,
 * and the `/metacog-check` command wiring.
 *
 * These three were written against a live host and had no test, which is exactly
 * the category that rots silently.
 *
 * Run: node test/check-window.test.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
const { generateReport } = await import(lib('report.js'))

/** Host with a commands registry so the slash command can be captured. */
function createHost(root) {
  const tools = new Map()
  const commands = new Map()
  const captured = []
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return { get: () => root, defaultDirectory: root }
      if (name === 'tools') return this.tools
      if (name === 'commands') return { register: (d) => (commands.set(d.name, d), () => commands.delete(d.name)) }
      // Deliberately empty: a slash command runs in the plugin's own context, where
      // there is no "current initiating agent". The command must supply the parent
      // itself rather than depending on this lookup.
      if (name === 'agents') return { currentInitiator: () => undefined, get: () => undefined }
      if (name === 'subagents') {
        return {
          list: () => ['stub'],
          resolveMaxDepth: () => 3,
          async startActivation(options) {
            captured.push(options.request?.parent)
            return {
              childId: 'child-stub',
              result: Promise.resolve({
                output: [{ type: 'text', text: '{}' }],
                stopReason: 'completed',
                structured: { drifted: true, reason: '三条活动都在调打印机接口', suggestions: ['先核完审核要点'] },
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
    tools: { register: (d) => (tools.set(d.name, d), () => tools.delete(d.name)) },
    workingDirectory: { get: () => root, defaultDirectory: root },
  }
  apply(ctx, {})
  return { ctx, tools, commands, captured }
}

const root = await mkdtemp(join(tmpdir(), 'metacog-window-'))
try {
  await writeFile(join(root, 'README.md'), '# 窗口测试\n')
  const { ctx, tools, commands, captured } = createHost(root)

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
      title: '让监控可信',
      evidence: ['README.md'],
      // The root is the only goal here, so it is also the leaf: it must state a
      // checkable completion condition, or no activity could ever be judged done.
      successCriteria: ['the checkpoint advances after a reported check'],
      // 本测试校验 /metacog-check 的检查点窗口，根目标服务的活动就是这类检查点报告。
      alignment: { relevantActivities: ['检查点报告'] },
    },
    goals: [],
    contradictions: [],
    reason: '测试',
  }
  await call('goal_tree_confirm', { ...confirmArgs, preview: true, noDeadlineGoalRefs: ['*'] })
  await call('goal_tree_confirm', { ...confirmArgs, userApproved: true, approvalNote: '测试确认' })

  const store = new MetacogStore(root, '.metacog')
  const projectId = deriveProjectId(root)
  const config = parseConfig({})

  console.log('\n=== W1: 检查点默认不存在，写入后可读回 ===')
  check('初始没有检查点', (await store.readCheckpoint(projectId)) === undefined)
  const stamp = '2026-10-28T01:00:00.000Z'
  await store.setCheckpoint(projectId, stamp)
  check('写回同一个时间', (await store.readCheckpoint(projectId)) === stamp)

  const raw = JSON.parse(
    await readFile(join(root, '.metacog', 'checkpoint', `${projectId}.json`), 'utf8'),
  )
  check('落盘字段是 lastReportAt', raw.lastReportAt === stamp, JSON.stringify(raw))

  console.log('\n=== W2: 命令已注册且说明提到目标 ===')
  const command = commands.get('metacog-check')
  check('/metacog-check 已注册', command !== undefined, [...commands.keys()].join(','))
  check('说明写明会问模型', String(command?.description).includes('模型'), String(command?.description))

  console.log('\n=== W3: 命令只提交检查点之后的活动 ===')
  {
    // Two activities: one before the checkpoint, one after.
    await store.appendActivity(projectId, {
      id: 'act_before',
      eventFingerprint: 'fp-before',
      projectId,
      sessionId: 's',
      timestamp: '2026-10-28T00:30:00.000Z',
      source: 'tool_event',
      observationGrade: 'A',
      summary: '检查点之前的工作',
      evidence: ['a'],
      candidateGoalIds: [],
      alignmentConfidence: 0.9,
      decision: 'aligned',
      rationale: 'r',
    })
    await store.appendActivity(projectId, {
      id: 'act_after',
      eventFingerprint: 'fp-after',
      projectId,
      sessionId: 's',
      timestamp: '2026-10-28T02:00:00.000Z',
      source: 'tool_event',
      observationGrade: 'A',
      summary: '检查点之后的工作',
      evidence: ['b'],
      candidateGoalIds: [],
      alignmentConfidence: 0.9,
      decision: 'scope_drift',
      rationale: 'r',
    })

    const result = await command.handler({
      agent: { id: 'agent-test', session: { header: { cwd: root } } },
      input: '',
    })
    check('命令返回成功', result.kind === 'success', JSON.stringify(result).slice(0, 200))
    check('给出偏离判定', String(result.text).includes('偏离'), String(result.text).slice(0, 120))
    check('引用模型给的理由', String(result.text).includes('打印机'), String(result.text).slice(0, 200))
    check('给出建议', String(result.text).includes('建议'), String(result.text).slice(0, 200))

    // Regression: the command must attribute the child to the invoking agent. When
    // it relied on `currentInitiator()` the whole review failed with
    // "no initiating agent is in context".
    check('子代理归属到发起命令的 agent', captured.at(-1)?.id === 'agent-test', JSON.stringify(captured.at(-1)))

    const moved = await store.readCheckpoint(projectId)
    check('成功后检查点被推进', moved !== stamp, String(moved))
  }

  console.log('\n=== W4: 日报含监控状态小节 ===')
  {
    const report = await generateReport({
      store,
      state: await store.readState(projectId),
      projectId,
      config,
      type: 'daily',
      now: new Date('2026-10-28T03:00:00.000Z'),
    })
    check('小节标题在', report.markdown.includes('## 监控状态'), report.markdown.slice(0, 200))
    // The rewritten report states the judged total and the four-way split on
    // one line; the old wording ("本期判定 N 条活动") is gone with 4.7.
    check(
      '写了判定条数与四类分布',
      /判定 \d+ 条：偏离 \d+、探索 \d+、待定 \d+、对齐 \d+/.test(report.markdown),
      report.markdown,
    )
    // `unbound` is the path-coverage number: "how many activities could no goal
    // claim". Folding it into 待定 would make the one figure that tells a reader
    // whether the tree needs more `paths` disappear without a trace.
    check('把「未归属」单列出来，不并进待定', /未归属 \d+/.test(report.markdown), report.markdown)
    check(
      '要么写复核统计，要么说明没有候选',
      report.markdown.includes('已复核') || report.markdown.includes('没有新的漂移候选'),
      report.markdown,
    )
  }

  console.log('\n=== W5: 没有新活动时命令如实说明 ===')
  {
    // Push the boundary past every fixture activity, which is what "the user has
    // already been told about everything" means.
    await store.setCheckpoint(projectId, '2026-10-28T09:00:00.000Z')
    const again = await command.handler({
      agent: { id: 'agent-test', session: { header: { cwd: root } } },
      input: '',
    })
    check('仍然成功返回', again.kind === 'success', JSON.stringify(again).slice(0, 160))
    check('说明没有新活动', String(again.text).includes('没有新活动'), String(again.text).slice(0, 160))
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n=== Window 结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
