/**
 * 多树合并的验证。
 *
 * 前提：同一工作区只能有一棵树——它是所有对齐判断的尺子，两把尺子等于没有尺子。
 * 但项目会扩张，新扫描可能冒出一整块不属于任何现有节点的工作。合并是第三条路：
 * 保留主树、并入新节点、去重、留审计。
 *
 * 这里验证的重点不是"能合并"，而是"合并不会悄悄弄坏树"：
 * - 同名节点必须去重，不能分裂成两个 id；
 * - 候选树的引用要重定向，不能留悬空链接；
 * - 合并前的形状校验要能挡住环和断链；
 * - 不 confirm 时绝不写入。
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
const { mergeTrees, checkMergedShape, resolveRoot } = await import(lib('analysis/merge.js'))



/** Build a minimal TreeState for the pure-function tests. */
function tree(projectId, goals, contradictions = []) {
  const now = new Date().toISOString()
  return {
    projectId,
    version: 1,
    confirmed: true,
    goals: goals.map((goal) => ({
      projectId,
      parentId: null,
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
      createdAt: now,
      updatedAt: now,
      ...goal,
    })),
    contradictions,
    createdAt: now,
    updatedAt: now,
  }
}

console.log('=== 1. 根节点策略 ===')
check('默认保留主树根', resolveRoot('keep-main') === 'main', resolveRoot('keep-main'))
check('可选保留候选根', resolveRoot('take-candidate') === 'candidate', resolveRoot('take-candidate'))
check('未指定时也是主树', resolveRoot(undefined) === 'main', resolveRoot(undefined))

console.log('\n=== 2. 候选根降级为 L1 ===')
const main1 = tree('p1', [
  { id: 'L0_a', depth: 0, title: '主树的根' },
  { id: 'L1_a', depth: 1, parentId: 'L0_a', title: '主树已有的一层' },
])
const cand1 = tree('p1', [
  { id: 'L0_b', depth: 0, title: '候选树的根' },
  { id: 'L1_b', depth: 1, parentId: 'L0_b', title: '候选的新工作' },
])
const merged1 = mergeTrees(main1, cand1, { now: new Date().toISOString() })
check('只有一个根', merged1.goals.filter((g) => g.depth === 0).length === 1, String(merged1.goals.filter((g) => g.depth === 0).length))
check('候选根变成 depth 1', merged1.goals.find((g) => g.id === 'L0_b')?.depth === 1, String(merged1.goals.find((g) => g.id === 'L0_b')?.depth))
check('候选根挂在主根下', merged1.goals.find((g) => g.id === 'L0_b')?.parentId === 'L0_a', String(merged1.goals.find((g) => g.id === 'L0_b')?.parentId))
check('候选子节点保留', merged1.goals.some((g) => g.id === 'L1_b'), JSON.stringify(merged1.goals.map((g) => g.id)))
check('形状校验通过', checkMergedShape(merged1.goals).length === 0, JSON.stringify(checkMergedShape(merged1.goals)))
check('报告记录了新增', merged1.report.addedGoalIds.includes('L0_b') && merged1.report.addedGoalIds.includes('L1_b'), JSON.stringify(merged1.report.addedGoalIds))

console.log('\n=== 3. 同名节点去重 ===')
const main2 = tree('p2', [
  { id: 'L0_x', depth: 0, title: '根' },
  { id: 'L1_x', depth: 1, parentId: 'L0_x', title: '数据分析', description: '主树的说法' },
])
const cand2 = tree('p2', [
  { id: 'L0_y', depth: 0, title: '根' },
  { id: 'L1_y', depth: 1, parentId: 'L0_y', title: '数据分析', description: '候选的说法' },
])
const merged2 = mergeTrees(main2, cand2, { now: new Date().toISOString() })
const dataNodes = merged2.goals.filter((g) => g.title === '数据分析')
check('同名节点只有一个', dataNodes.length === 1, String(dataNodes.length))
check('保留主树的 id', dataNodes[0]?.id === 'L1_x', String(dataNodes[0]?.id))
check('保留主树的措辞', dataNodes[0]?.description === '主树的说法', String(dataNodes[0]?.description))
check('候选 id 被重映射', merged2.report.remappedReferences.some((r) => r.from === 'L1_y' && r.to === 'L1_x'), JSON.stringify(merged2.report.remappedReferences))
check('根同名也去重', merged2.goals.filter((g) => g.depth === 0).length === 1, String(merged2.goals.filter((g) => g.depth === 0).length))

console.log('\n=== 4. take-candidate 替换内容但保留 id ===')
const merged3 = mergeTrees(main2, cand2, { now: new Date().toISOString(), strategy: 'take-candidate' })
const replaced = merged3.goals.find((g) => g.title === '数据分析')
check('仍是同一个 id', replaced?.id === 'L1_x', String(replaced?.id))
check('描述换成候选的', replaced?.description === '候选的说法', String(replaced?.description))
check('报告记为替换', merged3.report.replacedGoalIds.includes('L1_x'), JSON.stringify(merged3.report.replacedGoalIds))

console.log('\n=== 5. 矛盾引用被重定向 ===')
const main4 = tree(
  'p4',
  [
    { id: 'L0_m', depth: 0, title: '根' },
    { id: 'L1_m', depth: 1, parentId: 'L0_m', title: '结构建模' },
  ],
  [],
)
const cand4 = tree(
  'p4',
  [
    { id: 'L0_c', depth: 0, title: '根' },
    { id: 'L1_c', depth: 1, parentId: 'L0_c', title: '结构建模' },
    { id: 'L1_c2', depth: 1, parentId: 'L0_c', title: '全新工作' },
  ],
  [
    {
      id: 'C_c1',
      projectId: 'p4',
      parentId: null,
      primaryGoalId: 'L1_c',
      relatedGoalIds: ['L1_c2'],
      type: 'main',
      confirmedByUser: true,
      title: '新工作带来的张力',
      description: '',
      poleA: 'A',
      poleB: 'B',
      intensity: null,
      trend: 'unknown',
      rationale: '',
      resolutionHint: '',
      evidence: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
)
const merged4 = mergeTrees(main4, cand4, { now: new Date().toISOString() })
const newTension = merged4.contradictions.find((c) => c.title === '新工作带来的张力')
check('矛盾被并入', newTension !== undefined, JSON.stringify(merged4.contradictions.map((c) => c.title)))
check('主目标指向主树的节点', newTension?.primaryGoalId === 'L1_m', String(newTension?.primaryGoalId))
check('关联目标保留', newTension?.relatedGoalIds.includes('L1_c2'), JSON.stringify(newTension?.relatedGoalIds))
check('形状仍然合法', checkMergedShape(merged4.goals).length === 0, JSON.stringify(checkMergedShape(merged4.goals)))

console.log('\n=== 6. 主目标没被并入的矛盾被跳过 ===')
const cand5 = tree(
  'p5',
  [{ id: 'L0_z', depth: 0, title: '根' }],
  [
    {
      id: 'C_dangling',
      projectId: 'p5',
      parentId: null,
      primaryGoalId: 'L1_不存在',
      relatedGoalIds: [],
      type: 'main',
      confirmedByUser: true,
      title: '指向不存在目标的矛盾',
      description: '',
      poleA: 'A',
      poleB: 'B',
      intensity: null,
      trend: 'unknown',
      rationale: '',
      resolutionHint: '',
      evidence: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
)
const merged5 = mergeTrees(main4, cand5, { now: new Date().toISOString() })
check(
  '悬空矛盾被跳过而非写入',
  merged5.contradictions.every((c) => c.title !== '指向不存在目标的矛盾'),
  JSON.stringify(merged5.contradictions.map((c) => c.title)),
)
check('跳过有原因', merged5.report.skipped.some((s) => s.reason.includes('primary goal')), JSON.stringify(merged5.report.skipped))

console.log('\n=== 7. 形状校验能挡住坏树 ===')
const twoRoots = [
  { id: 'L0_1', depth: 0, title: '根一', parentId: null },
  { id: 'L0_2', depth: 0, title: '根二', parentId: null },
]
check('两个根被抓', checkMergedShape(twoRoots).some((p) => p.includes('exactly one root')), JSON.stringify(checkMergedShape(twoRoots)))
const brokenParent = [
  { id: 'L0_1', depth: 0, title: '根', parentId: null },
  { id: 'L1_1', depth: 1, title: '子', parentId: 'L0_缺' },
]
check('父节点缺失被抓', checkMergedShape(brokenParent).some((p) => p.includes('missing parent')), JSON.stringify(checkMergedShape(brokenParent)))
const depthGap = [
  { id: 'L0_1', depth: 0, title: '根', parentId: null },
  { id: 'L2_1', depth: 2, title: '跳层', parentId: 'L0_1' },
]
check('跨层被抓', checkMergedShape(depthGap).some((p) => p.includes('depth 2 under')), JSON.stringify(checkMergedShape(depthGap)))

console.log('\n=== 8. 工具层：预览不写入 ===')
const root = await mkdtemp(join(tmpdir(), 'metacog-merge-'))
try {
  await writeFile(join(root, 'README.md'), '# 合并验证\n')
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
      agent: { id: 'merge-test', session: { id: 'session-m', header: { cwd: root } } },
    })

  const store = new MetacogStore(root, '.metacog')
  const projectId = deriveProjectId(root)
  await call('goal_tree_confirm', {
    expectedVersion: 0,
    l0: { title: '合并验证的根目标', evidence: ['README.md'] },
    goals: [{ title: '已有工作', evidence: ['README.md'], depth: 1 }],
    contradictions: [],
    reason: '合并验证基线',
  })

  const preview = await call('metacog_merge_tree', {
    expectedVersion: 1,
    reason: '预览：并入新扫描发现的一块工作',
    rootTitle: '合并验证的根目标',
    goals: [
      { id: 'N1', depth: 1, title: '新扫描发现的工作', evidence: ['README.md'] },
      { id: 'N2', depth: 2, parentId: 'N1', title: '它的子项' },
    ],
  })
  check('预览成功', preview.ok === true, JSON.stringify(preview).slice(0, 200))
  check('模式是 preview', preview.data?.mode === 'preview', String(preview.data?.mode))
  check('报告说会改动', preview.data?.wouldChange === true, String(preview.data?.wouldChange))
  check('预览带提示', String(preview.data?.note).includes('预览'), String(preview.data?.note))

  const afterPreview = await store.readState(projectId)
  check('预览没有写入', afterPreview.version === 1, String(afterPreview.version))
  check('预览没有新增节点', afterPreview.goals.length === 2, String(afterPreview.goals.length))

  const merged = await call('metacog_merge_tree', {
    expectedVersion: 1,
    reason: '并入新扫描发现的一块工作',
    rootTitle: '合并验证的根目标',
    goals: [
      { id: 'N1', depth: 1, title: '新扫描发现的工作', evidence: ['README.md'] },
      { id: 'N2', depth: 2, parentId: 'N1', title: '它的子项' },
    ],
    confirm: true,
  })
  check('确认后写入成功', merged.ok === true, JSON.stringify(merged).slice(0, 240))
  check('模式是 merged', merged.data?.mode === 'merged', String(merged.data?.mode))
  check('版本推进', merged.data?.version === 2, String(merged.data?.version))
  check('返回审计 id', String(merged.data?.auditEntryId).startsWith('audit_'), String(merged.data?.auditEntryId))

  const afterMerge = await store.readState(projectId)
  check('新节点已落盘', afterMerge.goals.some((g) => g.title === '新扫描发现的工作'), JSON.stringify(afterMerge.goals.map((g) => g.title)))
  check('子节点挂在它下面', afterMerge.goals.find((g) => g.title === '它的子项')?.parentId === 'N1', String(afterMerge.goals.find((g) => g.title === '它的子项')?.parentId))

  const audit = await store.readAuditLog(projectId)
  const mergeEntry = audit[audit.length - 1]
  check('审计 action 为 merge_trees', mergeEntry?.action === 'merge_trees', String(mergeEntry?.action))
  check('审计 reason 记录合并理由', String(mergeEntry?.reason).includes('新扫描'), String(mergeEntry?.reason))
  check('审计 targetIds 指向新增节点', mergeEntry?.targetIds.includes('N1'), JSON.stringify(mergeEntry?.targetIds))

  console.log('\n--- 重复合并同一棵候选树 ---')
  const again = await call('metacog_merge_tree', {
    expectedVersion: 2,
    reason: '再合并一次同样的候选树',
    rootTitle: '合并验证的根目标',
    goals: [{ id: 'N1', depth: 1, title: '新扫描发现的工作', evidence: ['README.md'] }],
    confirm: true,
  })
  check('重复合并不报错', again.ok === true, JSON.stringify(again).slice(0, 200))
  check('重复合并不升版本', again.data?.version === 2, String(again.data?.version))
  check('重复合并无审计条目', again.data?.auditEntryId === '', String(again.data?.auditEntryId))
  const afterAgain = await store.readState(projectId)
  check('节点没有重复', afterAgain.goals.filter((g) => g.title === '新扫描发现的工作').length === 1, String(afterAgain.goals.filter((g) => g.title === '新扫描发现的工作').length))

  console.log('\n--- 参数与前置校验 ---')
  const noReason = await call('metacog_merge_tree', { expectedVersion: 2, rootTitle: '根' })
  check('缺 reason 被拒', noReason.ok === false, JSON.stringify(noReason).slice(0, 160))
  check('拒绝理由是 REASON_REQUIRED', String(JSON.stringify(noReason)).includes('REASON_REQUIRED'), JSON.stringify(noReason).slice(0, 200))

  const noRoot = await call('metacog_merge_tree', { expectedVersion: 2, reason: 'x' })
  check('缺 rootTitle 被拒', noRoot.ok === false, JSON.stringify(noRoot).slice(0, 160))

  const stale = await call('metacog_merge_tree', {
    expectedVersion: 1,
    reason: '用过期版本合并',
    rootTitle: '根',
    goals: [{ id: 'N9', depth: 1, title: '九号' }],
    confirm: true,
  })
  check('过期版本被拒', stale.ok === false, JSON.stringify(stale).slice(0, 160))
  check('拒绝理由是 VERSION_CONFLICT', String(JSON.stringify(stale)).includes('VERSION_CONFLICT'), JSON.stringify(stale).slice(0, 200))

  const bareRoot = await mkdtemp(join(tmpdir(), 'metacog-merge-bare-'))
  try {
    const bareTools = new Map()
    const bareCtx = {
      get(name) {
        if (name === 'workingDirectory') return { get: () => bareRoot, defaultDirectory: bareRoot }
        if (name === 'tools') return this.tools
        if (name === 'sessions') return { get: () => undefined, list: () => [] }
        return undefined
      },
      logger: { debug() {}, info() {}, warn() {} },
      on: () => () => {},
      effect: () => {},
      tools: { register: (d) => (bareTools.set(d.name, d), () => bareTools.delete(d.name)) },
      workingDirectory: { get: () => bareRoot, defaultDirectory: bareRoot },
    }
    apply(bareCtx, {})
    const bareResult = await bareTools.get('metacog_merge_tree').execute(
      { expectedVersion: 0, reason: 'x', rootTitle: '根' },
      {
        callId: 'c1',
        name: 'metacog_merge_tree',
        arguments: {},
        signal: new AbortController().signal,
        agent: { id: 'a', session: { id: 's', header: { cwd: bareRoot } } },
      },
    )
    check('没有树时合并被拒', bareResult.ok === false, JSON.stringify(bareResult).slice(0, 160))
    check('拒绝理由是 NOT_CONFIRMED', String(JSON.stringify(bareResult)).includes('NOT_CONFIRMED'), JSON.stringify(bareResult).slice(0, 200))
  } finally {
    await rm(bareRoot, { recursive: true, force: true })
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

exit()
