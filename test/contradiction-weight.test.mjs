/**
 * Cross-goal contradiction weights and the goal burden they feed.
 *
 * `relatedGoalIds` is the membership list every existing reader uses; weights are
 * an override layer on top of it. These checks pin the three things the design
 * promises — the primary goal is always 1.0, a legacy node reads at the
 * configured default (so changing the config changes the answer), and the
 * burden is a pure function that can be unit-tested without a store — plus the
 * tool paths that write and read weights.
 *
 * Run: node test/contradiction-weight.test.mjs   (after `npm run build`)
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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

function throws(fn) {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

/** Floating-point equality for scores built from weights. */
function near(actual, expected) {
  return typeof actual === 'number' && Math.abs(actual - expected) < 1e-9
}

const { parseConfig } = await import(lib('config.js'))
const { computeGoalContradictionBurden, contradictionGoalLinks, contradictionGoalWeight } =
  await import(lib('data/types.js'))
const { apply } = await import(lib('index.js'))

/** A contradiction as the weighting reads it. */
function node(overrides) {
  return {
    id: 'C1',
    primaryGoalId: 'G0',
    relatedGoalIds: [],
    intensity: 4,
    ...overrides,
  }
}

const SETTINGS = { defaultRelatedWeight: 0.5 }

console.log('\n=== W1: primary 恒为 1.0，老数据按默认权重 ===')
{
  const links = contradictionGoalLinks(node({ relatedGoalIds: ['G1'] }), SETTINGS)
  check('primary 权重是 1.0', links.find((link) => link.goalId === 'G0')?.weight === 1)
  check(
    '只有 relatedGoalIds 的老节点取默认权重',
    links.find((link) => link.goalId === 'G1')?.weight === 0.5,
  )
  check('没有多余的链接', links.length === 2, JSON.stringify(links))
}

console.log('\n=== W2: 显式权重覆盖默认权重 ===')
{
  const links = contradictionGoalLinks(
    node({ relatedGoalIds: ['G1', 'G2'], relatedGoals: [{ goalId: 'G1', weight: 0.25 }] }),
    SETTINGS,
  )
  check('显式权重生效', links.find((link) => link.goalId === 'G1')?.weight === 0.25)
  check('未加权的 id 仍取默认', links.find((link) => link.goalId === 'G2')?.weight === 0.5)
  check('同一目标只出现一次', links.filter((link) => link.goalId === 'G1').length === 1)
}

console.log('\n=== W3: primary 不会被 relatedGoals 降权 ===')
{
  const links = contradictionGoalLinks(
    node({ relatedGoals: [{ goalId: 'G0', weight: 0.1 }, { goalId: 'G1', weight: 0.3 }] }),
    SETTINGS,
  )
  check('primary 仍是 1.0', links.find((link) => link.goalId === 'G0')?.weight === 1)
  check('primary 只出现一次', links.filter((link) => link.goalId === 'G0').length === 1)
}

console.log('\n=== W4: 配置可以关闭节点级覆盖 ===')
{
  const off = contradictionGoalLinks(
    node({ relatedGoals: [{ goalId: 'G1', weight: 0.25 }] }),
    { defaultRelatedWeight: 0.5, allowNodeOverride: false },
  )
  check('关闭后统一用默认权重', off.find((link) => link.goalId === 'G1')?.weight === 0.5)
}

console.log('\n=== W5: 负担 = Σ intensity × weight ===')
{
  const contradictions = [
    node({ id: 'C1', primaryGoalId: 'G0', intensity: 4 }),
    node({
      id: 'C2',
      primaryGoalId: 'G1',
      relatedGoals: [{ goalId: 'G0', weight: 0.5 }],
      intensity: 2,
    }),
    node({ id: 'C3', primaryGoalId: 'G0', relatedGoalIds: ['G1'], intensity: 3 }),
  ]
  const g0 = computeGoalContradictionBurden('G0', contradictions, SETTINGS)
  check('G0 负担 = 4 + 1 + 3', near(g0.total, 8), String(g0.total))
  check('G0 计数 3', g0.count === 3, String(g0.count))
  check('G0 峰值 4', g0.peak === 4, String(g0.peak))
  check('没有未测量的张力', g0.unmeasured === 0, String(g0.unmeasured))
  check(
    '贡献按分数降序',
    g0.contributions[0].score === 4 && g0.contributions[g0.contributions.length - 1].score === 1,
    JSON.stringify(g0.contributions.map((item) => item.score)),
  )
  const g1 = computeGoalContradictionBurden('G1', contradictions, SETTINGS)
  check('G1 负担 = 2 + 1.5', near(g1.total, 3.5), String(g1.total))
  check('G1 计数 2', g1.count === 2, String(g1.count))
  const g2 = computeGoalContradictionBurden('G2', contradictions, SETTINGS)
  check('无关目标负担为 0', g2.count === 0 && g2.total === 0)
}

console.log('\n=== W6: 没有强度读数的张力计入 unmeasured，但不贡献分数 ===')
{
  const burden = computeGoalContradictionBurden('G0', [node({ id: 'C4', intensity: null })], SETTINGS)
  check('null intensity 贡献 0', burden.total === 0, String(burden.total))
  check('但计入 unmeasured', burden.unmeasured === 1, String(burden.unmeasured))
  check('仍然计入触及次数', burden.count === 1, String(burden.count))
}

console.log('\n=== W7: 已解决的张力不再计入负担 ===')
{
  const burden = computeGoalContradictionBurden(
    'G0',
    [node({ id: 'C5', intensity: 5, resolvedAt: '2026-01-01T00:00:00.000Z' })],
    SETTINGS,
  )
  check('已解决的不计入', burden.count === 0 && burden.total === 0)
}

console.log('\n=== W8: 改配置后同一份老数据的结果随之变化 ===')
{
  const legacy = node({ id: 'C6', primaryGoalId: 'G9', relatedGoalIds: ['G1'], intensity: 3 })
  check(
    '默认 0.5 时负担 1.5',
    near(computeGoalContradictionBurden('G1', [legacy], { defaultRelatedWeight: 0.5 }).total, 1.5),
  )
  check(
    '默认 1.0 时负担 3',
    near(computeGoalContradictionBurden('G1', [legacy], { defaultRelatedWeight: 1 }).total, 3),
  )
}

console.log('\n=== W9: 配置项走 zod 校验且有默认值 ===')
{
  const base = parseConfig({})
  check('默认 defaultRelatedWeight 是 0.5', base.contradictions.defaultRelatedWeight === 0.5)
  check('默认允许节点级覆盖', base.contradictions.allowNodeOverride === true)
  const overridden = parseConfig({ contradictions: { defaultRelatedWeight: 0.8 } })
  check('profile 可以覆盖默认权重', overridden.contradictions.defaultRelatedWeight === 0.8)
  check(
    '越界权重被 zod 拒绝',
    throws(() => parseConfig({ contradictions: { defaultRelatedWeight: 1.5 } })),
  )
  check(
    '负权重被 zod 拒绝',
    throws(() => parseConfig({ contradictions: { defaultRelatedWeight: -0.1 } })),
  )
}

/** Mount the plugin against a minimal host and keep what it registers. */
function createHost(projectRoot, config) {
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
  apply(ctx, config)
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
    agent: { id: 'agent-weight-test' },
  })
}

const root = await mkdtemp(join(tmpdir(), 'metacog-weight-'))
try {
  await writeFile(join(root, 'README.md'), '# 权重项目\n\n用于验证跨目标权重。\n')
  // The profile value is the point of this block: nothing in the code hardcodes
  // 0.9, so a burden that reads 0.9 proves the config reached the calculation.
  const { tools } = createHost(root, { contradictions: { defaultRelatedWeight: 0.9 } })

  console.log('\n=== W10: profile 配置经工具链影响目标负担 ===')
  const confirmArgs = {
    expectedVersion: 0,
    l0: {
      title: '根目标',
      evidence: ['README.md'],
      alignment: { relevantActivities: ['权重验证'] },
    },
    goals: [
      {
        title: '子目标',
        depth: 1,
        evidence: ['README.md'],
        // A single child under the root makes this node the leaf, so it owes the
        // executable-leaf contract a completion condition.
        successCriteria: ['primary 的负担等于强度乘以 1.0'],
        alignment: { relevantActivities: ['权重验证'] },
      },
    ],
    contradictions: [
      {
        title: '跨目标张力',
        poleA: '甲',
        poleB: '乙',
        evidence: ['README.md'],
        primaryGoalRef: '根目标',
        relatedGoalRefs: ['子目标'],
        intensity: 4,
      },
    ],
    reason: '权重测试',
  }
  await call(tools, 'goal_tree_confirm', { ...confirmArgs, preview: true, noDeadlineGoalRefs: ['*'] })
  const confirmed = await call(tools, 'goal_tree_confirm', {
    ...confirmArgs,
    userApproved: true,
    approvalNote: '权重测试确认',
  })
  check('确认成功', confirmed.ok === true, JSON.stringify(confirmed).slice(0, 300))

  const view = await call(tools, 'goal_tree_view', {})
  const rootGoal = view.data?.goals?.find((goal) => goal.depth === 0)
  const childGoal = view.data?.goals?.find((goal) => goal.title === '子目标')
  const contradictionId = view.data?.contradictions?.[0]?.id
  check(
    'primary 的负担是 intensity × 1.0',
    near(rootGoal?.contradictionBurden?.total, 4),
    JSON.stringify(rootGoal?.contradictionBurden),
  )
  check(
    'related 的负担用 profile 的 0.9',
    near(childGoal?.contradictionBurden?.total, 3.6),
    JSON.stringify(childGoal?.contradictionBurden),
  )
  check(
    'view 的 goalLinks 带出有效权重',
    view.data?.contradictions?.[0]?.goalLinks?.find((link) => link.goalId === childGoal?.id)
      ?.weight === 0.9,
    JSON.stringify(view.data?.contradictions?.[0]?.goalLinks),
  )

  console.log('\n=== W11: 显式权重写入并影响负担 ===')
  const explicit = await call(tools, 'contradiction_tree_edit', {
    expectedVersion: view.data.version,
    updates: [{ id: contradictionId, relatedGoals: [{ goalId: childGoal.id, weight: 0.25 }] }],
    reason: '显式权重',
  })
  check('显式权重写入成功', explicit.ok === true, JSON.stringify(explicit).slice(0, 300))

  const afterExplicit = await call(tools, 'goal_tree_view', {})
  const childAfter = afterExplicit.data?.goals?.find((goal) => goal.title === '子目标')
  const edited = afterExplicit.data?.contradictions?.[0]
  check(
    '负担随显式权重变化',
    near(childAfter?.contradictionBurden?.total, 1),
    JSON.stringify(childAfter?.contradictionBurden),
  )
  check(
    'goalLinks 反映显式权重',
    edited?.goalLinks?.find((link) => link.goalId === childGoal.id)?.weight === 0.25,
    JSON.stringify(edited?.goalLinks),
  )
  check('relatedGoalIds 与 relatedGoals 同步', edited?.relatedGoalIds?.includes(childGoal.id) === true)

  const stateDir = join(root, '.metacog', 'state')
  const stateFiles = await readdir(stateDir)
  const state = JSON.parse(await readFile(join(stateDir, stateFiles[0]), 'utf8'))
  check(
    '磁盘上 relatedGoals 带权重',
    state.contradictions?.[0]?.relatedGoals?.find((link) => link.goalId === childGoal.id)?.weight ===
      0.25,
    JSON.stringify(state.contradictions?.[0]?.relatedGoals),
  )

  console.log('\n=== W12: 老参数 relatedGoalIds 仍然可用，权重回到配置默认 ===')
  const legacy = await call(tools, 'contradiction_tree_edit', {
    expectedVersion: afterExplicit.data.version,
    updates: [{ id: contradictionId, relatedGoalIds: [childGoal.id] }],
    reason: '回到老参数',
  })
  check('只传 relatedGoalIds 成功', legacy.ok === true, JSON.stringify(legacy).slice(0, 300))
  const legacyView = await call(tools, 'goal_tree_view', {})
  const childLegacy = legacyView.data?.goals?.find((goal) => goal.title === '子目标')
  check(
    '老参数写入后权重取 profile 默认 0.9',
    near(childLegacy?.contradictionBurden?.total, 3.6),
    JSON.stringify(childLegacy?.contradictionBurden),
  )

  console.log('\n=== W13: 越界权重与重复来源被拒绝 ===')
  const badWeight = await call(tools, 'contradiction_tree_edit', {
    expectedVersion: legacyView.data.version,
    updates: [{ id: contradictionId, relatedGoals: [{ goalId: childGoal.id, weight: 2 }] }],
    reason: '越界权重',
  })
  check('越界权重被拒绝', badWeight.ok === false, JSON.stringify(badWeight).slice(0, 300))
  check('错误码是 INVALID_ARGS', badWeight.error?.code === 'INVALID_ARGS', String(badWeight.error?.code))

  const bothFields = await call(tools, 'contradiction_tree_edit', {
    expectedVersion: legacyView.data.version,
    updates: [
      {
        id: contradictionId,
        relatedGoals: [{ goalId: childGoal.id, weight: 0.5 }],
        relatedGoalIds: [childGoal.id],
      },
    ],
    reason: '两个来源',
  })
  check('同时传 relatedGoals 与 relatedGoalIds 被拒绝', bothFields.ok === false)
  check(
    '错误码是 INVALID_ARGS',
    bothFields.error?.code === 'INVALID_ARGS',
    String(bothFields.error?.code),
  )
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n=== 权重结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
