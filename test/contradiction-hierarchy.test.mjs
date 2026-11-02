/**
 * Contradiction-tree hierarchy.
 *
 * The tree used to be one flat layer: the derivation schema had no
 * `parentTempId`, so every derived contradiction landed at the top and
 * `parentId` was always null. These checks pin the two things that make the
 * hierarchy real — a derivation can express it, and confirm/view carry it
 * through to storage and back — plus the two shapes that must never survive:
 * a dangling parent and a parent chain that loops.
 *
 * Run: node test/contradiction-hierarchy.test.mjs   (after `npm run build`)
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libUrl = pathToFileURL(join(here, '..', 'lib', 'index.js')).href
const deriveUrl = pathToFileURL(join(here, '..', 'lib', 'analysis', 'derive.js')).href

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
const { DERIVATION_JSON_SCHEMA, DerivationOutputSchema, reviewDerivation } = await import(deriveUrl)

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
    agent: { id: 'agent-hierarchy-test' },
  })
}

/** One contradiction draft that passes the per-item quality gates. */
function draft(overrides) {
  return {
    tempId: 'c1',
    title: '根本张力',
    poleA: '先交付',
    poleB: '先打磨',
    constraintKind: 'resource',
    blocksGoalTempIds: ['g1'],
    consequence: '若只保留一份清单，三个月后无法回应审稿人的复算请求',
    evidence: ['README.md'],
    confidence: 0.7,
    mitigationHint: '',
    parentTempId: '',
    ...overrides,
  }
}

function review(contradictions) {
  return reviewDerivation(DerivationOutputSchema.parse({ contradictions }))
}

const root = await mkdtemp(join(tmpdir(), 'metacog-hierarchy-'))
try {
  await writeFile(join(root, 'README.md'), '# 层级项目\n\n用于验证矛盾树的层级。\n')
  const { tools } = createHost(root)

  console.log('\n=== H1: 推导 schema 可以表达父子矛盾 ===')
  const contradictionSchema = DERIVATION_JSON_SCHEMA.properties.contradictions.items
  const parentProp = contradictionSchema.properties.parentTempId
  check('parentTempId 是单一 string', parentProp?.type === 'string', String(parentProp?.type))
  check('说明空字符串是顶层', String(parentProp?.description).includes('""'))
  check('parentTempId 不是必填', !contradictionSchema.required.includes('parentTempId'))

  console.log('\n=== H2: 推导结果允许多层矛盾 ===')
  const nested = review([
    draft({ tempId: 'c1', title: '规则与实际执行脱节' }),
    draft({ tempId: 'c2', title: '两份清单各维护一套字段', parentTempId: 'c1' }),
    draft({ tempId: 'c3', title: '清单与代码里的字段名不一致', parentTempId: 'c2' }),
  ])
  check(
    '三层矛盾都被接受',
    nested.output.contradictions.length === 3,
    String(nested.output.contradictions.length),
  )
  check(
    '层级被保留',
    nested.output.contradictions.find((item) => item.tempId === 'c3')?.parentTempId === 'c2',
  )
  check('没有节点被层级拒绝', nested.rejections.length === 0, JSON.stringify(nested.rejections))

  console.log('\n=== H3: 孤儿父引用被拒绝 ===')
  const orphan = review([
    draft({ tempId: 'c1', title: '保留的根张力' }),
    draft({ tempId: 'c2', title: '指向不存在的父节点', parentTempId: 'c9' }),
    draft({ tempId: 'c3', title: '孤儿的下游', parentTempId: 'c2' }),
  ])
  check(
    '父节点不存在的矛盾被拒绝',
    orphan.rejections.some(
      (item) => item.tempId === 'c2' && item.code === 'ORPHAN_CONTRADICTION_PARENT',
    ),
    JSON.stringify(orphan.rejections),
  )
  check(
    '被拒父节点的子节点也被拒绝',
    orphan.rejections.some(
      (item) => item.tempId === 'c3' && item.code === 'ORPHAN_CONTRADICTION_PARENT',
    ),
  )
  check(
    '被拒节点不进入推导输出',
    orphan.output.contradictions.length === 1,
    String(orphan.output.contradictions.length),
  )
  check(
    '拒绝会变成待确认问题',
    orphan.questions.some((question) => question.includes('父矛盾引用无效')),
  )

  console.log('\n=== H4: 父链成环被拒绝 ===')
  const cycle = review([
    draft({ tempId: 'c1', title: '环上节点一', parentTempId: 'c2' }),
    draft({ tempId: 'c2', title: '环上节点二', parentTempId: 'c1' }),
  ])
  check(
    '两个环上节点都被拒绝',
    cycle.rejections.filter((item) => item.code === 'CONTRADICTION_CYCLE').length === 2,
    JSON.stringify(cycle.rejections),
  )
  check('环节点不进入推导输出', cycle.output.contradictions.length === 0)
  const self = review([draft({ tempId: 'c1', title: '指向自己的节点', parentTempId: 'c1' })])
  check('自引用也算环', self.rejections.some((item) => item.code === 'CONTRADICTION_CYCLE'))

  console.log('\n=== H5: confirm 把 parentTempId 落库为 parentId ===')
  const l0 = {
    title: '把这件事做成',
    evidence: ['README.md'],
    // This fixture has no goals, so the root is also the only leaf and owes the
    // executable-leaf contract a completion condition.
    successCriteria: ['each contradiction stores the parent link it was given'],
    alignment: { relevantActivities: ['层级验证'] },
  }
  const confirmArgs = {
    expectedVersion: 0,
    l0,
    contradictions: [
      {
        tempId: 'c1',
        title: '规则与实际执行脱节',
        poleA: '规则',
        poleB: '执行',
        evidence: ['README.md'],
        primaryGoalRef: '把这件事做成',
      },
      {
        tempId: 'c2',
        title: '两份清单各维护一套字段',
        poleA: '清单甲',
        poleB: '清单乙',
        evidence: ['README.md'],
        primaryGoalRef: '把这件事做成',
        parentTempId: 'c1',
      },
      {
        tempId: 'c3',
        title: '清单与代码字段名不一致',
        poleA: '清单',
        poleB: '代码',
        evidence: ['README.md'],
        primaryGoalRef: '把这件事做成',
        parentTempId: 'c2',
      },
    ],
    reason: '层级测试',
  }
  await call(tools, 'goal_tree_confirm', { ...confirmArgs, preview: true, noDeadlineGoalRefs: ['*'] })
  const confirmed = await call(tools, 'goal_tree_confirm', {
    ...confirmArgs,
    userApproved: true,
    approvalNote: '层级测试确认',
  })
  check('确认成功', confirmed.ok === true, JSON.stringify(confirmed).slice(0, 300))

  const view = await call(tools, 'goal_tree_view', {})
  check('视图能读出来', view.ok === true, JSON.stringify(view).slice(0, 300))
  const rootGoal = view.data?.goals?.find((goal) => goal.depth === 0)
  const byTitle = new Map((view.data?.contradictions ?? []).map((node) => [node.title, node]))
  const c1 = byTitle.get('规则与实际执行脱节')
  const c2 = byTitle.get('两份清单各维护一套字段')
  const c3 = byTitle.get('清单与代码字段名不一致')
  check(
    '三条矛盾都落库',
    view.data?.contradictions?.length === 3,
    String(view.data?.contradictions?.length),
  )
  check('顶层矛盾 parentId 为 null', c1?.parentId === null, String(c1?.parentId))
  check('第二层挂在第一层下', c2?.parentId === c1?.id, `${c2?.parentId} vs ${c1?.id}`)
  check('第三层挂在第二层下', c3?.parentId === c2?.id)
  check('tempId 没有被直接写进 parentId', c3?.parentId !== 'c2')
  check(
    '父链从近到远',
    JSON.stringify(c3?.parentChain) === JSON.stringify([c2?.id, c1?.id]),
    JSON.stringify(c3?.parentChain),
  )
  check('顶层没有父链', Array.isArray(c1?.parentChain) && c1.parentChain.length === 0)
  check('父节点带出直接子节点', Array.isArray(c1?.childIds) && c1.childIds.includes(c2?.id))
  check('中间层带出下一层', c2?.childIds?.includes(c3?.id) === true)
  check('叶子没有子节点', Array.isArray(c3?.childIds) && c3.childIds.length === 0)
  check(
    'primary 目标以 1.0 出现在 goalLinks',
    c1?.goalLinks?.some((link) => link.goalId === rootGoal?.id && link.weight === 1) === true,
    JSON.stringify(c1?.goalLinks),
  )
  check(
    '目标视图带出矛盾负担',
    rootGoal?.contradictionBurden?.count === 3,
    JSON.stringify(rootGoal?.contradictionBurden),
  )

  console.log('\n=== H6: confirm 拒绝孤儿父引用 ===')
  const version = view.data.version
  const orphanConfirm = await call(tools, 'goal_tree_confirm', {
    expectedVersion: version,
    l0,
    contradictions: [
      {
        title: '指向不存在的父节点',
        poleA: '甲',
        poleB: '乙',
        evidence: ['README.md'],
        primaryGoalRef: '把这件事做成',
        parentTempId: 'c9',
      },
    ],
    reason: '孤儿测试',
  })
  check(
    '孤儿父引用被拒绝',
    orphanConfirm.ok === false,
    JSON.stringify(orphanConfirm).slice(0, 300),
  )
  check(
    '错误码是 UNKNOWN_CONTRADICTION_REF',
    orphanConfirm.error?.code === 'UNKNOWN_CONTRADICTION_REF',
    String(orphanConfirm.error?.code),
  )

  console.log('\n=== H7: 编辑工具可以重挂与清空父节点 ===')
  const moved = await call(tools, 'contradiction_tree_edit', {
    expectedVersion: version,
    updates: [{ id: c3.id, parentId: '' }],
    reason: '把第三层移到顶层',
  })
  check('清空父节点成功', moved.ok === true, JSON.stringify(moved).slice(0, 300))
  const afterMove = await call(tools, 'goal_tree_view', {})
  const movedNode = afterMove.data?.contradictions?.find((node) => node.id === c3.id)
  check('parentId 被清空', movedNode?.parentId === null, String(movedNode?.parentId))
  check('父链也变空', Array.isArray(movedNode?.parentChain) && movedNode.parentChain.length === 0)
  check(
    '原父节点的子列表少了一个',
    afterMove.data?.contradictions?.find((node) => node.id === c2.id)?.childIds?.includes(c3.id) ===
      false,
  )

  const dangling = await call(tools, 'contradiction_tree_edit', {
    expectedVersion: afterMove.data.version,
    creates: [
      {
        title: '挂在不存在的父节点下',
        poleA: '甲',
        poleB: '乙',
        evidence: ['README.md'],
        primaryGoalId: rootGoal.id,
        parentId: 'C_missing',
      },
    ],
    reason: '孤儿 create 测试',
  })
  check(
    'create 的孤儿 parentId 被拒绝',
    dangling.ok === false,
    JSON.stringify(dangling).slice(0, 300),
  )
  check('拒绝来自树形状校验', dangling.error?.code === 'TREE_SHAPE', String(dangling.error?.code))
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n=== 层级结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
