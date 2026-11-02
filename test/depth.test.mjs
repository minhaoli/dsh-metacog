/**
 * Stage 1 acceptance: the goal tree has depth, not a fixed ladder.
 *
 * What is verified here is the behaviour the stage was introduced for — a tree may
 * be two levels or five, a parent only has to be *shallower* (not exactly one step
 * shallower), and a project written under the old `L0`–`L3` names still opens and
 * records its migration in the audit chain.
 *
 * Run: node test/depth.test.mjs
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libUrl = pathToFileURL(join(here, '..', 'lib', 'index.js')).href
const sharedUrl = pathToFileURL(join(here, '..', 'lib', 'tools', 'shared.js')).href
const governanceUrl = pathToFileURL(join(here, '..', 'lib', 'governance.js')).href
const storeUrl = pathToFileURL(join(here, '..', 'lib', 'data', 'store.js')).href

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
const { deriveProjectId } = await import(sharedUrl)
const { assertGoalTreeShape } = await import(governanceUrl)
const { MetacogStore } = await import(storeUrl)

/** Mount the plugin against a minimal host. */
function createHost(projectRoot) {
  const tools = new Map()
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return this.workingDirectory
      if (name === 'timer') return this.timer
      if (name === 'systemPrompt') return this.systemPrompt
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
    timer: { interval: () => () => {} },
    systemPrompt: {
      section: () => () => {},
      context: () => () => {},
    },
  }
  apply(ctx, {})
  return { tools }
}

async function call(tools, name, args) {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`tool "${name}" was never registered`)
  return definition.execute(args, {
    callId: `call-${Math.random().toString(16).slice(2)}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
    agent: { id: 'agent-depth-test' },
  })
}

function codeOf(outcome) {
  return outcome?.ok === false ? outcome.error.code : 'ok'
}

/** Run one case against a throwaway project. */
async function withProject(body) {
  const root = await mkdtemp(join(tmpdir(), 'metacog-depth-'))
  try {
    await writeFile(join(root, 'README.md'), '# 项目\n\n用于测试深度的项目。\n')
    await body({ root, ...createHost(root) })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Confirm through the two-stage gate so each case only states its tree. */
async function confirmTree(tools, args) {
  await call(tools, 'goal_tree_confirm', { ...args, preview: true, noDeadlineGoalRefs: ['*'] })
  return call(tools, 'goal_tree_confirm', { ...args, userApproved: true, approvalNote: 'depth 确认' })
}

const ROOT = {
  title: '把这件事真正做成',
  description: '',
  evidence: ['README.md'],
  // 本测试唯一的"活动"就是搭出任意深度的树，根目标同样服务于它。
  alignment: { relevantActivities: ['深度建模'] },
}

console.log('\n=== D1: 任意深度都能落库 ===')
await withProject(async ({ tools }) => {
  const confirmed = await confirmTree(tools, {
    expectedVersion: 0,
    l0: ROOT,
    goals: [
      { title: '第一层', evidence: ['README.md'], alignment: { relevantActivities: ['深度建模'] } },
      {
        title: '第二层',
        depth: 2,
        parentRef: '第一层',
        evidence: ['README.md'],
        alignment: { relevantActivities: ['深度建模'] },
      },
      {
        title: '第三层',
        depth: 3,
        parentRef: '第二层',
        evidence: ['README.md'],
        alignment: { relevantActivities: ['深度建模'] },
      },
      {
        title: '第四层',
        depth: 4,
        parentRef: '第三层',
        evidence: ['README.md'],
        alignment: { relevantActivities: ['深度建模'] },
        // The deepest node here is a leaf, so it carries a verifiable criterion;
        // this test is about depth, not about the leaf gate.
        successCriteria: ['第四层落库且可读回'],
      },
    ],
    reason: 'depth test',
  })
  check('确认成功', confirmed.ok === true, codeOf(confirmed))
  check('共四个目标（根 + 三层）... 实际五个', confirmed.data?.goals === 5, String(confirmed.data?.goals))

  const view = await call(tools, 'goal_tree_view', {})
  const goals = view.data.goals
  check('视图返回五个节点', goals.length === 5, String(goals.length))
  check(
    '深度是 0..4',
    JSON.stringify(goals.map((node) => node.depth).sort((a, b) => a - b)) === JSON.stringify([0, 1, 2, 3, 4]),
    JSON.stringify(goals.map((node) => node.depth)),
  )
  const byTitle = new Map(goals.map((node) => [node.title, node]))
  check('第三层的父节点是第二层', byTitle.get('第三层').parentId === byTitle.get('第二层').id)
  check('根节点没有父节点', byTitle.get('把这件事真正做成').parentId === null)
  check(
    'id 里带着深度，便于肉眼排查',
    goals.filter((node) => node.id.startsWith('G')).length === 5,
    JSON.stringify(goals.map((node) => node.id)),
  )
})

console.log('\n=== D2: 允许跨层，父节点只需更浅 ===')
await withProject(async ({ tools }) => {
  const confirmed = await confirmTree(tools, {
    expectedVersion: 0,
    l0: ROOT,
    goals: [
      { title: '第一层', evidence: ['README.md'], alignment: { relevantActivities: ['深度建模'] } },
      // 直接从 depth 1 跳到 depth 4：中间两层在用户心里是隐含的。
      {
        title: '第四层',
        depth: 4,
        parentRef: '第一层',
        evidence: ['README.md'],
        alignment: { relevantActivities: ['深度建模'] },
        // 跨层后它仍是叶子，叶子必须可验收；本用例考的是跨层，不是叶子闸门。
        successCriteria: ['跨层落库后能读回深度 4 的节点'],
      },
    ],
    reason: 'cross-layer',
  })
  check('跨层确认成功', confirmed.ok === true, codeOf(confirmed))
  const view = await call(tools, 'goal_tree_view', {})
  const deep = view.data.goals.find((node) => node.title === '第四层')
  const shallow = view.data.goals.find((node) => node.title === '第一层')
  check('跨层父子关系被保存', deep?.parentId === shallow?.id, JSON.stringify(view.data.goals))
})

console.log('\n=== D3: depth 省略时默认挂在根下 ===')
await withProject(async ({ tools }) => {
  const confirmed = await confirmTree(tools, {
    expectedVersion: 0,
    l0: ROOT,
    goals: [
      {
        title: '没写深度的目标',
        evidence: ['README.md'],
        alignment: { relevantActivities: ['深度建模'] },
        // 这是叶子，需要可验收条件；本用例考的是 depth 默认值。
        successCriteria: ['省略 depth 时落库为 depth 1'],
      },
    ],
    reason: 'default depth',
  })
  const view = await call(tools, 'goal_tree_view', {})
  const node = view.data.goals.find((item) => item.title === '没写深度的目标')
  check('确认成功', confirmed.ok === true, codeOf(confirmed))
  check('默认 depth 为 1', node?.depth === 1, String(node?.depth))
})

console.log('\n=== D4: 拒绝无法表达的层级 ===')
await withProject(async ({ tools }) => {
  const noParent = await confirmTree(tools, {
    expectedVersion: 0,
    l0: ROOT,
    goals: [
      {
        title: '深但没父',
        depth: 3,
        evidence: ['README.md'],
        alignment: { relevantActivities: ['深度建模'] },
      },
    ],
  })
  check('depth>1 缺 parentRef 被拒', codeOf(noParent) === 'PARENT_REQUIRED', codeOf(noParent))

  const badRef = await confirmTree(tools, {
    expectedVersion: 0,
    l0: ROOT,
    goals: [
      {
        title: '挂到不存在的地方',
        depth: 2,
        parentRef: '并不存在',
        evidence: ['README.md'],
        alignment: { relevantActivities: ['深度建模'] },
      },
    ],
  })
  check('未知 parentRef 被拒', codeOf(badRef) === 'UNKNOWN_GOAL_REF', codeOf(badRef))

  const tooDeep = await confirmTree(tools, {
    expectedVersion: 0,
    l0: ROOT,
    goals: [
      {
        title: '太深',
        depth: 10,
        parentRef: '把这件事真正做成',
        evidence: ['README.md'],
        alignment: { relevantActivities: ['深度建模'] },
      },
    ],
  })
  check('depth 超过上限被拒', codeOf(tooDeep) === 'INVALID_ARGS', codeOf(tooDeep))

  const shallowParent = await confirmTree(tools, {
    expectedVersion: 0,
    l0: ROOT,
    goals: [
      { title: '第一层', evidence: ['README.md'], alignment: { relevantActivities: ['深度建模'] } },
      {
        title: '同层子节点',
        depth: 1,
        parentRef: '第一层',
        evidence: ['README.md'],
        alignment: { relevantActivities: ['深度建模'] },
      },
    ],
  })
  check('子节点不比父节点更深时被拒', codeOf(shallowParent) === 'TREE_SHAPE', codeOf(shallowParent))
})

console.log('\n=== D5: 树形不变量由程序把住 ===')
{
  const node = (id, depth, parentId) => ({ id, depth, parentId })
  const codeOfThrow = (goals) => {
    try {
      assertGoalTreeShape(goals)
      return 'ok'
    } catch (error) {
      return error.code ?? String(error)
    }
  }

  check(
    '两个 depth-0 根被拒',
    codeOfThrow([node('a', 0, null), node('b', 0, null)]) === 'TREE_SHAPE',
    codeOfThrow([node('a', 0, null), node('b', 0, null)]),
  )
  check(
    '父节点不比子节点浅被拒',
    codeOfThrow([node('a', 0, null), node('b', 1, 'a'), node('c', 1, 'b')]) === 'TREE_SHAPE',
  )
  check('缺父节点被拒', codeOfThrow([node('a', 0, null), node('b', 1, 'ghost')]) === 'TREE_SHAPE')
  check('非零深度的孤儿被拒', codeOfThrow([node('a', 2, null)]) === 'TREE_SHAPE')
  check(
    '跨层是合法的',
    codeOfThrow([node('a', 0, null), node('b', 1, 'a'), node('c', 4, 'b')]) === 'ok',
  )
  check('环被拒', codeOfThrow([node('a', 1, 'b'), node('b', 2, 'a')]) === 'TREE_SHAPE')
}

console.log('\n=== D6: 旧格式（L0-L3）自动迁移且留痕 ===')
await withProject(async ({ root, tools }) => {
  const projectId = deriveProjectId(root)
  const now = new Date().toISOString()
  const base = {
    projectId,
    description: '',
    status: 'active',
    priority: 0,
    confirmedByUser: true,
    successCriteria: [],
    alignment: {},
    evidence: ['README.md'],
    createdAt: now,
    updatedAt: now,
  }
  // Written by hand: the exact shape the previous version persisted.
  const legacy = {
    projectId,
    version: 3,
    confirmed: true,
    goals: [
      { ...base, id: 'L0_root', parentId: null, level: 'L0', title: '旧根目标' },
      { ...base, id: 'L1_child', parentId: 'L0_root', level: 'L1', title: '旧子目标' },
    ],
    contradictions: [],
    createdAt: now,
    updatedAt: now,
  }
  await mkdir(join(root, '.metacog', 'state'), { recursive: true })
  await writeFile(join(root, '.metacog', 'state', `${projectId}.json`), JSON.stringify(legacy))

  const view = await call(tools, 'goal_tree_view', {})
  check('旧状态能读出来', view.ok === true, codeOf(view))
  check('版本号前移一次', view.data?.version === 4, String(view.data?.version))
  check(
    'level 被映射成 depth',
    JSON.stringify(view.data.goals.map((g) => [g.depth, g.title]).sort()) ===
      JSON.stringify([[0, '旧根目标'], [1, '旧子目标']]),
    JSON.stringify(view.data.goals.map((g) => [g.depth, g.title])),
  )
  check('迁移后仍是已确认状态', view.data?.confirmed === true)

  const store = new MetacogStore(root, '.metacog')
  const audit = await store.readAuditLog(projectId)
  const migration = audit.filter((entry) => entry.action === 'migrate_goal_depth')
  check('审计里有迁移记录', migration.length === 1, String(migration.length))
  check('迁移记录标明版本前后', migration[0]?.beforeVersion === 3 && migration[0]?.afterVersion === 4)
  check('审计链仍然完整', (await store.verifyAuditChain(projectId)).valid === true)

  const again = await call(tools, 'goal_tree_view', {})
  check('迁移是幂等的', again.data?.version === 4, String(again.data?.version))
  const auditAgain = await store.readAuditLog(projectId)
  check(
    '不会重复写迁移记录',
    auditAgain.filter((entry) => entry.action === 'migrate_goal_depth').length === 1,
  )
})

console.log(`\n=== Depth 结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
