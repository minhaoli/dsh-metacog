/**
 * Derived-path acceptance: the successful derivation is persisted as a draft.
 *
 * Until now the only way to exercise a successful derivation was to run a real
 * model for several minutes. A host with a stubbed `subagents` service makes the
 * same code path testable in milliseconds — and this is the path that used to lose
 * its output entirely, because candidates lived only in the tool's return value.
 *
 * Run: node test/derivation-draft.test.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libUrl = pathToFileURL(join(here, '..', 'lib', 'index.js')).href

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

const { apply } = await import(libUrl)

/** The structured output a model would return for a three-level project. */
const STRUCTURED = {
  evidenceManifest: [
    { path: 'README.md', why: '说明项目意图', useful: true },
    { path: 'docs/plan.md', why: '给出阶段划分', useful: true },
  ],
  goals: [
    {
      tempId: 'g0',
      parentTempId: '',
      depth: 0,
      title: '让评审在不追问作者的情况下复现全部结论',
      derivation: 'README 的验收段要求第三方拿到仓库后能跑出同一张图，而当前只存档了汇总表。',
      evidence: ['README.md'],
      successCriteria: ['第三方按文档复现主要图表'],
      confidence: 0.8,
    },
    {
      tempId: 'g1',
      parentTempId: 'g0',
      depth: 1,
      title: '把原始试次数据与清洗脚本一起入库',
      derivation: 'docs/plan.md 的阶段二明确写了「数据可追溯」是复现的前置条件。',
      evidence: ['docs/plan.md'],
      successCriteria: ['原始数据与脚本在同一提交里'],
      confidence: 0.75,
    },
    {
      tempId: 'g1a',
      parentTempId: 'g1',
      depth: 2,
      title: '为清洗脚本补一组最小回归用例',
      derivation: 'docs/plan.md 指出上一次脚本改动引入过静默偏移，冒烟用例能挡住同类回归。',
      evidence: ['docs/plan.md'],
      successCriteria: ['用例覆盖偏移检测'],
      confidence: 0.7,
    },
  ],
  contradictions: [
    {
      tempId: 'c1',
      title: '归档完整性与提交体积的张力',
      poleA: '全量归档：原始试次一个不删',
      poleB: '提交体积：仓库超过 1GB 后克隆会让审稿人放弃',
      constraintKind: 'resource',
      blocksGoalTempIds: ['g1'],
      consequence: '若只删原始数据，三年后无法回应审稿人的复算请求',
      evidence: ['docs/plan.md'],
    },
  ],
  noContradictionFound: false,
  projectProfile: {
    summary: '一个需要第三方复现的实证项目，包含数据清洗与图表生成两段。',
    stage: '数据已清洗完，原始试次尚未入库',
    deliverables: ['可复现的仓库', '实验报告'],
  },
  openQuestions: ['仓库是否允许使用外部对象存储？'],
}

function createHost(projectRoot, captured) {
  const tools = new Map()
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return this.workingDirectory
      if (name === 'tools') return this.tools
      if (name === 'agents') {
        // deriveWithSubagent needs an initiator to attribute the child to.
        return { currentInitiator: () => ({ id: 'agent-test' }) }
      }
      if (name === 'subagents') {
        return {
          list: () => [{ id: 'stub-provider' }],
          resolveMaxDepth: () => 3,
          async startActivation(options) {
            captured.activation = options
            return {
              childId: 'child-stub',
              result: Promise.resolve({
                output: [{ type: 'text', text: JSON.stringify(STRUCTURED) }],
                stopReason: 'completed',
                structured: STRUCTURED,
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
    agent: { id: 'agent-test' },
  })
}

const root = await mkdtemp(join(tmpdir(), 'metacog-derived-'))
try {
  await writeFile(join(root, 'README.md'), '# 复现项目\n\n第三方应当能复现全部结论。\n')
  const { tools } = createHost(root, {})

  console.log('\n=== D1: 推导成功并把候选写入草稿 ===')
  const init = await call(tools, 'goal_tree_init', {})
  check('推导被采纳', init.ok === true, JSON.stringify(init).slice(0, 300))
  check('模式是 derived', init.data?.mode === 'derived', String(init.data?.mode))
  check('版本仍是 0', init.data?.version === 0, String(init.data?.version))
  check('返回 3 条候选', init.data?.goals?.length === 3, String(init.data?.goals?.length))
  check('开始调用子代理', init.data?.usage?.childId === 'child-stub', JSON.stringify(init.data?.usage))
  check(
    '子代理拿到 cwd 与结构化输出约束',
    init.data?.usage !== null && init.data?.usage !== undefined,
  )

  console.log('\n=== D1b: 用户陈述层不被派生层覆盖 ===')
  // Two layers of background, kept apart on purpose: what the user says the
  // project is, and what the documents show it is. A disagreement between them
  // is information, so the derived layer must only fill blanks.
  const ctxRoot = await mkdtemp(join(tmpdir(), 'metacog-derived-ctx-'))
  try {
    await writeFile(join(ctxRoot, 'README.md'), '# 复现项目\n\n第三方应当能复现全部结论。\n')
    const ctxHost = createHost(ctxRoot, {})
    const withCtx = await call(ctxHost.tools, 'goal_tree_init', {
      userContext: {
        role: '第一作者',
        intent: '让第三方在另一台机器上复现全部结论',
        constraints: ['不允许删除原始试次'],
        stakeholders: ['审稿人'],
      },
    })
    check('带用户背景的推导成功', withCtx.ok === true, JSON.stringify(withCtx).slice(0, 300))

    const ctxStatePath = join(ctxRoot, '.metacog', 'state')
    const ctxFiles = await (await import('node:fs/promises')).readdir(ctxStatePath)
    const ctxState = JSON.parse(await readFile(join(ctxStatePath, ctxFiles[0]), 'utf8'))
    const stored = ctxState.projectContext ?? {}
    check('用户层 role 保留', stored.role === '第一作者', String(stored.role))
    check('用户层 intent 保留', String(stored.intent).includes('复现'), String(stored.intent))
    check(
      '用户层 constraints 保留',
      stored.constraints?.[0] === '不允许删除原始试次',
      JSON.stringify(stored.constraints),
    )
    check('用户层 stakeholders 保留', stored.stakeholders?.[0] === '审稿人', JSON.stringify(stored.stakeholders))
    check(
      '派生层 summary 同时填入',
      String(stored.projectSummary).includes('第三方复现'),
      String(stored.projectSummary),
    )
    check(
      '派生层 deliverables 同时填入',
      stored.deliverables?.length === 2,
      JSON.stringify(stored.deliverables),
    )
    check(
      '两层同时存在且互不覆盖',
      stored.role === '第一作者' && String(stored.projectSummary).length > 0,
      JSON.stringify(stored).slice(0, 240),
    )
  } finally {
    await rm(ctxRoot, { recursive: true, force: true })
  }

  console.log('\n=== D2: 草稿落盘且不可当作标尺 ===')
  const view = await call(tools, 'goal_tree_view', {})
  check('视图能读出来', view.ok === true, JSON.stringify(view).slice(0, 200))
  check('草稿里有 3 个节点', view.data?.goals?.length === 3, String(view.data?.goals?.length))
  check('全部未确认', view.data?.goals?.every((g) => g.confirmed === false) === true)
  check('全部是 draft 状态', view.data?.goals?.every((g) => g.status === 'draft') === true)
  check('树整体未确认', view.data?.confirmed === false)

  const rootNode = view.data.goals.find((g) => g.depth === 0)
  const midNode = view.data.goals.find((g) => g.depth === 1)
  const leafNode = view.data.goals.find((g) => g.depth === 2)
  check('根节点没有父节点', rootNode?.parentId === null, String(rootNode?.parentId))
  check('第二层挂在根下', midNode?.parentId === rootNode?.id)
  check('第三层挂在第二层下', leafNode?.parentId === midNode?.id)

  const statePath = join(root, '.metacog', 'state')
  const names = (await import('node:fs/promises')).readdir(statePath)
  const files = await names
  check('状态文件存在', files.length === 1, JSON.stringify(files))
  const state = JSON.parse(await readFile(join(statePath, files[0]), 'utf8'))
  check('磁盘上确实有 3 个节点', state.goals.length === 3, String(state.goals.length))
  check('磁盘上仍未确认', state.confirmed === false)
  check(
    '矛盾没进草稿',
    state.contradictions.length === 0,
    String(state.contradictions.length),
  )
  check(
    '项目背景被写进上下文',
    state.projectContext?.projectSummary?.includes('第三方复现') === true,
    JSON.stringify(state.projectContext ?? null).slice(0, 200),
  )
  check(
    '阶段与交付物一并落盘',
    state.projectContext?.stage?.includes('数据已清洗') === true &&
      state.projectContext?.deliverables?.length === 2,
    JSON.stringify(state.projectContext ?? null).slice(0, 200),
  )
  check(
    '推导返回里带了项目背景',
    init.data?.projectProfile?.summary?.includes('第三方复现') === true,
    JSON.stringify(init.data?.projectProfile ?? null).slice(0, 160),
  )

  console.log('\n=== D3: 草稿不参与判定 ===')
  const drift = await call(tools, 'check_drift', {})
  const driftQuiet =
    drift.ok !== true || (Array.isArray(drift.data?.signals) && drift.data.signals.length === 0)
  check('未确认的草稿不产生任何漂移信号', driftQuiet, JSON.stringify(drift).slice(0, 240))

  console.log('\n=== D4: 确认后草稿被正式树替换 ===')
  const confirmArgs = {
    expectedVersion: 0,
    l0: {
      title: '让评审在不追问作者的情况下复现全部结论',
      evidence: ['README.md'],
      // 本测试验证「确认后草稿被正式树替换」，
      // 根目标服务的活动就是这类确认落库。
      alignment: { relevantActivities: ['确认落库'] },
    },
    goals: [
      {
        depth: 1,
        title: '把原始试次数据与清洗脚本一起入库',
        evidence: ['docs/plan.md'],
        alignment: { relevantActivities: ['数据归档'] },
        // 这个 depth-1 节点是叶子，叶子必须可验收；本用例验证的是
        // 「确认后草稿被正式树替换」，不是叶子闸门。
        successCriteria: ['原始数据与清洗脚本出现在同一次提交中'],
      },
    ],
    contradictions: [
      {
        title: '归档完整性与提交体积的张力',
        poleA: '全量归档',
        poleB: '提交体积',
        evidence: ['docs/plan.md'],
        primaryGoalRef: '让评审在不追问作者的情况下复现全部结论',
      },
    ],
    reason: '测试确认',
  }
  await call(tools, 'goal_tree_confirm', { ...confirmArgs, preview: true, noDeadlineGoalRefs: ['*'] })
  const confirm = await call(tools, 'goal_tree_confirm', {
    ...confirmArgs,
    userApproved: true,
    approvalNote: 'derivation 测试确认',
    allowUnconfirmedContext: true,
    reason: '测试夹具使用空背景',
  })
  check('确认成功', confirm.ok === true, JSON.stringify(confirm).slice(0, 300))

  const after = await call(tools, 'goal_tree_view', {})
  check('确认后树被标记为已确认', after.data?.confirmed === true)
  check('确认后的节点全部 confirmed', after.data?.goals?.every((g) => g.confirmed) === true)
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n=== Derived 结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
