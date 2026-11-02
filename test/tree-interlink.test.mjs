/**
 * The two trees, interlinked.
 *
 * Until this point the goal tree and the contradiction tree were read
 * separately: a goal view could count its burden but not name the tensions, a
 * contradiction view knew a goal id but not what it meant, and a report put
 * goals in one section and tensions in another. These checks pin the three
 * places the link now exists — the goal view, the contradiction view and the
 * report's goal section — plus the two read-only paths added with them: the
 * detector sweep's goal-burden context and the report tool's `collapseDone`
 * exposure. Nothing here asserts an escalation change, because none was made.
 *
 * Run: node test/tree-interlink.test.mjs   (after `npm run build`)
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

function near(actual, expected) {
  return typeof actual === 'number' && Math.abs(actual - expected) < 1e-9
}

/** The section under one heading, up to the next `## ` heading. */
function sectionOf(markdown, heading) {
  const start = markdown.indexOf(heading)
  if (start < 0) return ''
  const rest = markdown.slice(start + heading.length)
  const next = rest.search(/^## /m)
  return next < 0 ? rest : rest.slice(0, next)
}

const { apply } = await import(lib('index.js'))
const { parseConfig } = await import(lib('config.js'))
const { MetacogStore } = await import(lib('data/store.js'))
const { goalContradictionContext, attachGoalBurdenContext } = await import(
  lib('analysis/service.js')
)

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
    agent: { id: 'agent-interlink-test' },
  })
}

const root = await mkdtemp(join(tmpdir(), 'metacog-interlink-'))
try {
  await writeFile(join(root, 'README.md'), '# 互通项目\n\n用于验证两棵树互通。\n')
  const { tools } = createHost(root)

  console.log('\n=== I1: 确认一棵目标树 + 一棵带权重关联的矛盾树 ===')
  const confirmArgs = {
    expectedVersion: 0,
    l0: {
      title: '根目标',
      evidence: ['README.md'],
      alignment: { relevantActivities: ['互通验证'] },
    },
    goals: [
      {
        title: '子目标',
        depth: 1,
        evidence: ['README.md'],
        alignment: { relevantActivities: ['互通验证'] },
      },
      {
        title: '孙目标',
        depth: 2,
        parentRef: '子目标',
        evidence: ['README.md'],
        successCriteria: ['孙目标可以被外部验证'],
        alignment: { relevantActivities: ['互通验证'] },
      },
    ],
    contradictions: [
      {
        title: '核心张力',
        poleA: '先做目标树',
        poleB: '先做矛盾树',
        evidence: ['README.md'],
        primaryGoalRef: '根目标',
        relatedGoals: [{ goalRef: '子目标', weight: 0.8 }],
        intensity: 4,
      },
      {
        title: '子目标张力',
        poleA: '先拆细',
        poleB: '先收敛',
        evidence: ['README.md'],
        primaryGoalRef: '子目标',
        relatedGoals: [{ goalRef: '孙目标', weight: 0.5 }],
        intensity: 2,
      },
    ],
    reason: '互通测试',
  }
  await call(tools, 'goal_tree_confirm', { ...confirmArgs, preview: true, noDeadlineGoalRefs: ['*'] })
  const confirmed = await call(tools, 'goal_tree_confirm', {
    ...confirmArgs,
    userApproved: true,
    approvalNote: '互通测试确认',
  })
  check('确认成功', confirmed.ok === true, JSON.stringify(confirmed).slice(0, 300))

  const view = await call(tools, 'goal_tree_view', {})
  check('视图能读出来', view.ok === true, JSON.stringify(view).slice(0, 300))
  const byGoalTitle = new Map(view.data.goals.map((goal) => [goal.title, goal]))
  const byContradictionTitle = new Map(
    view.data.contradictions.map((node) => [node.title, node]),
  )
  const rootGoal = byGoalTitle.get('根目标')
  const childGoal = byGoalTitle.get('子目标')
  const grandChildGoal = byGoalTitle.get('孙目标')
  const core = byContradictionTitle.get('核心张力')
  const childTension = byContradictionTitle.get('子目标张力')
  check('三个目标都在', rootGoal !== undefined && childGoal !== undefined && grandChildGoal !== undefined)

  console.log('\n=== I2: 目标视图带出矛盾的 id 与标题 ===')
  const rootTensions = rootGoal?.relatedContradictions ?? []
  check(
    '根目标列出核心张力（id + 标题）',
    rootTensions.some((item) => item.id === core?.id && item.title === '核心张力'),
    JSON.stringify(rootTensions),
  )
  check('根目标上它的权重是 1.0', rootTensions.find((item) => item.id === core?.id)?.weight === 1)
  check(
    '根目标的负担与列表一致',
    near(rootGoal?.contradictionBurden?.total, 4) && rootGoal?.contradictionBurden?.count === 1,
    JSON.stringify(rootGoal?.contradictionBurden),
  )

  const childTensions = childGoal?.relatedContradictions ?? []
  check(
    '子目标同时列出两条矛盾',
    childTensions.length === 2 &&
      childTensions.some((item) => item.id === core?.id && item.weight === 0.8) &&
      childTensions.some((item) => item.id === childTension?.id && item.weight === 1),
    JSON.stringify(childTensions),
  )
  check(
    '子目标的负担按权重相加',
    near(childGoal?.contradictionBurden?.total, 5.2) &&
      childGoal?.contradictionBurden?.count === 2,
    JSON.stringify(childGoal?.contradictionBurden),
  )
  check(
    '孙目标只被子目标张力关联',
    grandChildGoal?.relatedContradictions?.length === 1 &&
      grandChildGoal.relatedContradictions[0].id === childTension?.id &&
      grandChildGoal.relatedContradictions[0].weight === 0.5,
    JSON.stringify(grandChildGoal?.relatedContradictions),
  )
  check(
    '列表按分数从强到弱',
    childTensions[0]?.id === core?.id,
    JSON.stringify(childTensions.map((item) => item.id)),
  )

  console.log('\n=== I3: 矛盾视图带出目标链与关联目标标题 ===')
  check(
    '核心张力的 primary 目标链是根目标',
    JSON.stringify(core?.primaryGoalChain) ===
      JSON.stringify([{ id: rootGoal?.id, title: '根目标', depth: 0 }]),
    JSON.stringify(core?.primaryGoalChain),
  )
  check(
    '核心张力的关联目标带标题和权重',
    core?.relatedGoals?.length === 1 &&
      core.relatedGoals[0].id === childGoal?.id &&
      core.relatedGoals[0].title === '子目标' &&
      core.relatedGoals[0].weight === 0.8,
    JSON.stringify(core?.relatedGoals),
  )
  check(
    '子目标张力的目标链是根目标 → 子目标',
    JSON.stringify(childTension?.primaryGoalChain?.map((item) => item.title)) ===
      JSON.stringify(['根目标', '子目标']),
    JSON.stringify(childTension?.primaryGoalChain),
  )
  check(
    '目标链的 depth 也带出来',
    childTension?.primaryGoalChain?.[0]?.depth === 0 &&
      childTension?.primaryGoalChain?.[1]?.depth === 1,
    JSON.stringify(childTension?.primaryGoalChain),
  )

  console.log('\n=== I4: 判定 sweep 能读到目标的矛盾负担（只读上下文）===')
  const store = new MetacogStore(root, '.metacog')
  const state = await store.readState(view.data.projectId)
  check('能读回项目状态', state !== undefined)
  const config = parseConfig({})
  const context = goalContradictionContext(state, config)
  check(
    '根目标的上下文含核心张力',
    context.get(rootGoal.id)?.contradictions?.some((item) => item.title === '核心张力') === true,
    JSON.stringify(context.get(rootGoal.id)),
  )
  check(
    '子目标的上下文负担是 5.2',
    near(context.get(childGoal.id)?.total, 5.2),
    JSON.stringify(context.get(childGoal.id)),
  )
  const draft = {
    observedAt: new Date().toISOString(),
    monitorCategory: 'goal_alignment',
    signalType: 'scope_drift',
    relatedGoalIds: [childGoal.id],
    relatedContradictionIds: [],
    activityIds: [],
    confidence: 0.8,
    evidence: [],
    rationale: '测试信号',
  }
  const [annotated] = attachGoalBurdenContext([draft], state, config)
  check(
    '上下文被写进 rationale',
    annotated.rationale.includes('只读上下文') &&
      annotated.rationale.includes('核心张力') &&
      annotated.rationale.includes('5.2'),
    annotated.rationale,
  )
  check('置信度没有被改动', annotated.confidence === 0.8)
  check('等级字段没有被添加', annotated.level === undefined)

  console.log('\n=== I5: 报告的目标小节内显示关联矛盾 ===')
  const activity = await call(tools, 'check_drift', {
    activity: {
      summary: '互通验证：跑通目标树与矛盾树的互查',
      evidence: ['README.md'],
      grade: 'A',
      source: 'manual',
      candidateGoalIds: [childGoal.id],
    },
  })
  check('活动被记录', activity.ok === true, JSON.stringify(activity).slice(0, 300))

  const report = await call(tools, 'generate_report', { type: 'daily' })
  check('报告生成成功', report.ok === true, JSON.stringify(report).slice(0, 300))
  const markdown = report.data?.markdown ?? ''
  const goalSection = sectionOf(markdown, '## 按目标看活动')
  check('目标小节存在', goalSection.length > 0, markdown)
  check('目标小节列出子目标', goalSection.includes('子目标'), goalSection)
  check(
    '目标条目下出现关联矛盾标题',
    goalSection.includes('相关矛盾') &&
      goalSection.includes('核心张力') &&
      goalSection.includes('子目标张力'),
    goalSection,
  )
  check(
    '矛盾注记带强度',
    /核心张力（强度 4）/.test(goalSection) && /子目标张力（强度 2）/.test(goalSection),
    goalSection,
  )

  console.log('\n=== I6: generate_report 暴露 collapseDone（默认 false，仅呈现）===')
  const reportParams = tools.get('generate_report').parameters
  check(
    'collapseDone 是 boolean 参数',
    reportParams.properties.collapseDone?.type === 'boolean',
    JSON.stringify(reportParams.properties.collapseDone),
  )
  check(
    '描述说明它只影响呈现',
    String(reportParams.properties.collapseDone?.description).includes('Presentation only') &&
      String(reportParams.properties.collapseDone?.description).includes('Default false'),
    String(reportParams.properties.collapseDone?.description),
  )
  const expanded = await call(tools, 'generate_report', { type: 'daily', collapseDone: false })
  check('显式 false 生成成功', expanded.ok === true, JSON.stringify(expanded).slice(0, 200))
  const folded = await call(tools, 'generate_report', { type: 'daily', collapseDone: true })
  check('显式 true 生成成功', folded.ok === true, JSON.stringify(folded).slice(0, 200))
  check(
    '折叠后目标小节仍在',
    sectionOf(folded.data?.markdown ?? '', '## 按目标看活动').includes('子目标'),
    folded.data?.markdown,
  )
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n=== 互通结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
