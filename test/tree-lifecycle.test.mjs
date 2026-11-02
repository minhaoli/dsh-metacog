/**
 * Tree lifecycle verification: candidate-tree initialization, explicit confirmation,
 * and controlled structural editing.
 *
 * Every case drives the *registered tools* through their real `execute` path
 * against a real temporary project directory, so what is verified is the
 * behaviour a model would actually observe — including the refusal codes —
 * rather than the internals of any single module.
 *
 * Run: node test/tree-lifecycle.test.mjs
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libUrl = pathToFileURL(join(here, '..', 'lib', 'index.js')).href
const storeUrl = pathToFileURL(join(here, '..', 'lib', 'data', 'store.js')).href
const sharedUrl = pathToFileURL(join(here, '..', 'lib', 'tools', 'shared.js')).href
const scannerUrl = pathToFileURL(join(here, '..', 'lib', 'evidence', 'scanner.js')).href

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

function checkEqual(label, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  check(label, a === b, `expected ${b}, got ${a}`)
}

const { apply, getMount } = await import(libUrl)

/**
 * Build a host whose tool registry records what the plugin registers, and
 * whose working directory points at a real project root.
 */
function createHost(projectRoot) {
  const tools = new Map()
  const logs = []
  const ctx = {
  get(name) {
    if (name === 'workingDirectory') return this.workingDirectory
    if (name === 'timer') return this.timer
    if (name === 'systemPrompt') return this.systemPrompt
    if (name === 'tools') return this.tools
    if (name === 'fs') return this.fs
    return undefined
  },
    logger: {
      debug: (...args) => logs.push(['debug', ...args]),
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
    },
    on: () => () => {},
    effect: () => {},
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    workingDirectory: {
      get: () => projectRoot,
      defaultDirectory: projectRoot,
    },
  }
  return { ctx, tools, logs }
}

/** Run a registered tool the way the host would, returning its outcome. */
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

/** Read the rejection code from a tool outcome. */
function codeOf(outcome) {
  return outcome?.ok === false ? outcome.error.code : `ok(${JSON.stringify(outcome?.data)})`
}

/**
 * Create a project fixture with a README that states an L0, two L1 sections and
 * one documented trade-off.
 */
async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), 'metacog-stagec-'))
  await writeFile(
    join(root, 'README.md'),
    [
      '# Metacog Demo Project',
      '',
      'A demo used to verify goal-tree initialization.',
      '',
      '## Goal alignment monitoring',
      '',
      'Tracks whether current activity advances confirmed goals.',
      '',
      '## Structure validity monitoring',
      '',
      'Tracks whether the goal tree still describes the real problem.',
      '',
      '## Design tension',
      '',
      'The design trades delivery speed vs architectural verifiability.',
      '',
    ].join('\n'),
  )
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(
    join(root, 'docs', 'design.md'),
    [
      '# Design notes',
      '',
      '## Observation storage',
      '',
      'Append-only observation stream for trend computation.',
      '',
    ].join('\n'),
  )
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'metacog-demo', version: '1.0.0' }, null, 2),
  )
  return root
}

/** A confirmed L1 the tests can reuse. */
function l1(title, overrides = {}) {
  return {
    title,
    evidence: ['README.md'],
    successCriteria: [`${title} is verifiably delivered`],
    relevantActivities: ['reading papers about alignment monitoring'],
    allowedMethods: ['static analysis'],
    ...overrides,
  }
}

/** Confirm a standard tree and return the resulting version. */
async function confirmStandard(tools, l0Title = 'Metacog Demo Project') {
  const confirmArgs = {
    expectedVersion: 0,
    l0: {
      title: l0Title,
      description: 'demo root',
      evidence: ['README.md'],
      // 本阶段测的是树的落库与编辑（确认、版本、审计、L0/L1 门控），
      // 根目标服务的活动就是这类树生命周期维护。
      alignment: { relevantActivities: ['树生命周期维护'] },
    },
    goals: [l1('Goal alignment monitoring'), l1('Structure validity monitoring')],
    contradictions: [
      {
        title: 'delivery speed vs architectural verifiability',
        poleA: 'delivery speed',
        poleB: 'architectural verifiability',
        evidence: ['README.md'],
        type: 'main',
        primaryGoalRef: 'Goal alignment monitoring',
        relatedGoalRefs: ['Structure validity monitoring'],
      },
    ],
    reason: 'user reviewed the scanned candidates',
  }
  await call(tools, 'goal_tree_confirm', { ...confirmArgs, preview: true, noDeadlineGoalRefs: ['*'] })
  return call(tools, 'goal_tree_confirm', {
    ...confirmArgs,
    userApproved: true,
    approvalNote: 'stage-c 确认',
  })
}

const fixtures = []
async function withProject(fn) {
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root)
  apply(host.ctx, {})
  const mount = getMount(host.ctx)
  try {
    return await fn({ root, ...host, mount })
  } finally {
    const disposers = []
    void disposers
  }
}

try {
  // ---------------------------------------------------------------- C1
  console.log('\n-- C1: init 现在走推导路径，无模型时诚实降级 --')
  // The mechanical scanner this case used to exercise has been replaced by the
  // derivation pipeline. What matters now is that init still reports what it
  // found on disk and refuses to fabricate a tree when no model is available.
  await withProject(async ({ root, tools }) => {
    const init = await call(tools, 'goal_tree_init', {})
    check('goal_tree_init 成功', init.ok === true, codeOf(init))
    checkEqual('草稿版本为 0', init.data.version, 0)
    check(
      '项目 id 由路径派生',
      typeof init.data.projectId === 'string' && init.data.projectId.includes('metacog-stagec'),
    )

    // No subagents service in the mock host, so the degraded path runs.
    checkEqual('降级模式标记正确', init.data.mode, 'discovery-only')
    check('降级时仍报告扫描结果', typeof init.data.materials === 'object')
    check('降级时不编造目标', Array.isArray(init.data.goals) && init.data.goals.length === 0)
    check(
      '降级原因写明',
      init.data.warnings.some((w) => w.includes('subagents') || w.includes('不支持')),
      JSON.stringify(init.data.warnings),
    )
    check('降级时列出候选文档', Array.isArray(init.data.inspectedPaths))

    // A failed derivation writes nothing: no state means "not initialised",
    // which is the honest representation. An empty draft would instead read as
    // "this project has no objectives".
    const view = await call(tools, 'goal_tree_view', {})
    checkEqual('降级后没有树可看', codeOf(view), 'NOT_INITIALIZED')
  })

  // --------------------------------------------------------------- C1b
  console.log('\n-- C1b: 空目录下 init 的返回值仍是合法 JSON --')
  // A project with no documents still has to return a serialisable payload:
  // `undefined` anywhere in the result fails the host's lossless-JSON check,
  // which only shows up in a real session.
  await withProject(async ({ tools, root }) => {
    const { rm } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await rm(join(root, 'README.md'), { force: true })
    await rm(join(root, 'package.json'), { force: true })
    await rm(join(root, 'docs'), { recursive: true, force: true })

    const init = await call(tools, 'goal_tree_init', {})
    check('空目录下 init 成功', init.ok === true, codeOf(init))
    check('空目录不产出目标', init.data.goals.length === 0)

    // The value the registry receives must survive a lossless round trip.
    const roundTrip = JSON.parse(JSON.stringify(init.data))
    checkEqual('返回值是无损 JSON', roundTrip, init.data)
    check(
      '返回值里没有 undefined 属性',
      !JSON.stringify(init.data).includes('undefined'),
      JSON.stringify(init.data),
    )
  })

  // ---------------------------------------------------------------- C2
  console.log('\n-- C2: 确认落库生成 version 1、快照与创世审计 --')
  await withProject(async ({ tools }) => {
    const init = await call(tools, 'goal_tree_init', {})
    const confirm = await confirmStandard(tools)
    check('goal_tree_confirm 成功', confirm.ok === true, codeOf(confirm))
    checkEqual('确认后版本为 1', confirm.data.version, 1)
    check('创世审计条目返回 id', typeof confirm.data.auditEntryId === 'string' && confirm.data.auditEntryId.length > 0)

    const view = await call(tools, 'goal_tree_view', {})
    check('确认后 confirmed=true', view.data.confirmed === true)
    check('确认节点为 active', view.data.goals.every((g) => g.status === 'active'))
    check('确认节点 confirmedByUser=true', view.data.goals.every((g) => g.confirmed === true))
    checkEqual('审计链校验通过且有一条记录', view.data.audit, { entries: 1, valid: true })
    check('跨目标关联：relatedGoalIds 已记录', view.data.contradictions[0].relatedGoalIds.length === 1)
    check('矛盾 primaryGoalId 不等于 related', view.data.contradictions[0].relatedGoalIds[0] !== view.data.contradictions[0].primaryGoalId)
    void init
  })

  // ---------------------------------------------------------------- C3
  console.log('\n-- C3: 证据约束与确认参数校验 --')
  await withProject(async ({ tools }) => {
    await call(tools, 'goal_tree_init', {})
    const noEvidence = await call(tools, 'goal_tree_confirm', {
      expectedVersion: 0,
      l0: { title: 'Root', evidence: [] },
    })
    checkEqual('无证据 L0 被拒绝', codeOf(noEvidence), 'EVIDENCE_REQUIRED')

    const noL0 = await call(tools, 'goal_tree_confirm', { expectedVersion: 0 })
    checkEqual('缺少 L0 被拒绝', codeOf(noL0), 'L0_REQUIRED')

    const badRef = await call(tools, 'goal_tree_confirm', {
      expectedVersion: 0,
      l0: {
        title: 'Root',
        evidence: ['README.md'],
        // 负向用例：这条断言的是「矛盾引用不存在目标」，
        // 目标本身仍需判据，否则会先撞上 CRITERIA_REQUIRED。
        alignment: { relevantActivities: ['树生命周期维护'] },
      },
      contradictions: [
        {
          title: 'x vs y',
          poleA: 'x',
          poleB: 'y',
          evidence: ['README.md'],
          primaryGoalRef: 'nonexistent goal',
        },
      ],
    })
    checkEqual('未知目标引用被拒绝', codeOf(badRef), 'UNKNOWN_GOAL_REF')

    const coreNoRationale = await call(tools, 'goal_tree_confirm', {
      expectedVersion: 0,
      l0: {
        title: 'Root',
        evidence: ['README.md'],
        alignment: { relevantActivities: ['树生命周期维护'] },
      },
      contradictions: [
        {
          title: 'x vs y',
          poleA: 'x',
          poleB: 'y',
          evidence: ['README.md'],
          type: 'core',
          primaryGoalRef: 'Root',
        },
      ],
    })
    checkEqual('core 缺 rationale 被拒绝', codeOf(coreNoRationale), 'CORE_RATIONALE_REQUIRED')
  })

  // ---------------------------------------------------------------- C4
  console.log('\n-- C4: 结构形状校验（唯一 L0 / 层级相邻 / 无环） --')
  await withProject(async ({ tools }) => {
    await call(tools, 'goal_tree_init', {})
    await confirmStandard(tools)
    const view = await call(tools, 'goal_tree_view', {})
    const l1Node = view.data.goals.find((g) => g.depth === 1)

    // A second L0 would break the single-root invariant.
    const secondRoot = await call(tools, 'goal_tree_edit', {
      expectedVersion: 1,
      creates: [{ depth: 1, parentId: l1Node.id, title: 'Misplaced child' }],
      reason: 'exercise level adjacency',
    })
    checkEqual('L3 挂错层级被拒绝', codeOf(secondRoot), 'TREE_SHAPE')

    const ghostParent = await call(tools, 'goal_tree_edit', {
      expectedVersion: 1,
      creates: [{ depth: 2, parentId: 'L2_ghost', title: 'Orphan' }],
      reason: 'unknown parent',
    })
    checkEqual('父节点不存在被拒绝', codeOf(ghostParent), 'UNKNOWN_GOAL')
  })

  // ---------------------------------------------------------------- C5
  console.log('\n-- C5: L0 二次确认门控 --')
  await withProject(async ({ tools }) => {
    await call(tools, 'goal_tree_init', {})
    await confirmStandard(tools)
    const view = await call(tools, 'goal_tree_view', {})
    const l0 = view.data.goals.find((g) => g.depth === 0)

    const noFlag = await call(tools, 'goal_tree_edit', {
      expectedVersion: 1,
      updates: [{ id: l0.id, title: 'Rewritten root' }],
      reason: 'user asked to rewrite',
    })
    checkEqual('未传 userConfirmed 时 L0 修改被拒绝', codeOf(noFlag), 'L0_CONFIRMATION_REQUIRED')

    const withFlagNoReason = await call(tools, 'goal_tree_edit', {
      expectedVersion: 1,
      updates: [{ id: l0.id, title: 'Rewritten root' }],
      userConfirmed: true,
    })
    checkEqual('传 userConfirmed 但无 reason 被拒绝', codeOf(withFlagNoReason), 'REASON_REQUIRED')

    const ok = await call(tools, 'goal_tree_edit', {
      expectedVersion: 1,
      updates: [{ id: l0.id, title: 'Rewritten root', evidence: ['README.md', 'docs/design.md'] }],
      userConfirmed: true,
      reason: 'user explicitly confirmed the narrower root goal',
    })
    check('合规 L0 修改成功', ok.ok === true, codeOf(ok))
    checkEqual('L0 修改审计动作为 update_l0', ok.data.auditAction, 'update_l0')
    checkEqual('版本递增到 2', ok.data.version, 2)

    const after = await call(tools, 'goal_tree_view', {})
    check('L0 标题已更新', after.data.goals.find((g) => g.depth === 0).title === 'Rewritten root')
    checkEqual('审计链仍有效且新增一条', after.data.audit, { entries: 2, valid: true })

    // A rejected edit must leave the version untouched: the gate runs before commit.
    const rejected = await call(tools, 'goal_tree_edit', {
      expectedVersion: 2,
      updates: [{ id: l0.id, title: 'Sneaky rewrite' }],
      reason: 'no confirmation flag',
    })
    checkEqual('再次拒绝', codeOf(rejected), 'L0_CONFIRMATION_REQUIRED')
    const unchanged = await call(tools, 'goal_tree_view', {})
    checkEqual('被拒绝的修改不影响版本', unchanged.data.version, 2)
    checkEqual('被拒绝的修改不影响标题', unchanged.data.goals.find((g) => g.depth === 0).title, 'Rewritten root')
  })

  // ---------------------------------------------------------------- C6
  console.log('\n-- C6: core 矛盾受控保护 --')
  await withProject(async ({ tools }) => {
    await call(tools, 'goal_tree_init', {})
    const confirmArgs = {
      expectedVersion: 0,
      l0: {
        title: 'Root',
        evidence: ['README.md'],
        alignment: { relevantActivities: ['树生命周期维护'] },
      },
      goals: [l1('Alpha'), l1('Beta')],
      contradictions: [
        {
          title: 'speed vs verifiability',
          poleA: 'speed',
          poleB: 'verifiability',
          evidence: ['README.md'],
          type: 'core',
          primaryGoalRef: 'Alpha',
          rationale: 'derives from the L0 requirement to ship a verifiable monitor',
        },
      ],
      reason: 'initial confirmed tree',
    }
    await call(tools, 'goal_tree_confirm', { ...confirmArgs, preview: true, noDeadlineGoalRefs: ['*'] })
    const confirm = await call(tools, 'goal_tree_confirm', {
      ...confirmArgs,
      userApproved: true,
      approvalNote: 'core 测试确认',
    })
    check('带 rationale 的 core 确认成功', confirm.ok === true, codeOf(confirm))
    const view = await call(tools, 'goal_tree_view', {})
    const core = view.data.contradictions[0]

    const noFlag = await call(tools, 'contradiction_tree_edit', {
      expectedVersion: 1,
      updates: [{ id: core.id, title: 'renamed tension' }],
      reason: 'rename',
    })
    checkEqual('未确认时 core 文本修改被拒绝', codeOf(noFlag), 'CORE_CONFIRMATION_REQUIRED')

    const reclassNoFlag = await call(tools, 'contradiction_tree_edit', {
      expectedVersion: 1,
      updates: [{ id: core.id, type: 'main' }],
      reason: 'demote to main',
    })
    checkEqual('未确认时 core 重分类被拒绝', codeOf(reclassNoFlag), 'CORE_CONFIRMATION_REQUIRED')

    const ok = await call(tools, 'contradiction_tree_edit', {
      expectedVersion: 1,
      updates: [{ id: core.id, type: 'main', evidence: ['README.md', 'docs/design.md'] }],
      userConfirmed: true,
      reason: 'user confirmed the tension is no longer structural',
    })
    check('合规重分类成功', ok.ok === true, codeOf(ok))
    checkEqual('审计动作为 reclassify_contradiction', ok.data.auditAction, 'reclassify_contradiction')
    check('报告被重分类的矛盾 id', ok.data.reclassifiedContradictionIds.includes(core.id))

    const after = await call(tools, 'goal_tree_view', {})
    checkEqual('类型已变为 main', after.data.contradictions[0].type, 'main')
    checkEqual('审计链有效', after.data.audit.valid, true)
  })

  // ---------------------------------------------------------------- C7
  console.log('\n-- C7: L1 变更需原因并标记关联矛盾重评估 --')
  await withProject(async ({ tools }) => {
    await call(tools, 'goal_tree_init', {})
    await confirmStandard(tools)
    const view = await call(tools, 'goal_tree_view', {})
    const l1Node = view.data.goals.find((g) => g.depth === 1)

    const noReason = await call(tools, 'goal_tree_edit', {
      expectedVersion: 1,
      updates: [{ id: l1Node.id, title: 'Renamed strategy' }],
    })
    checkEqual('L1 变更缺 reason 被拒绝', codeOf(noReason), 'L1_REASON_REQUIRED')

    const ok = await call(tools, 'goal_tree_edit', {
      expectedVersion: 1,
      updates: [{ id: l1Node.id, title: 'Renamed strategy' }],
      reason: 'user narrowed the strategy after review',
    })
    check('带 reason 的 L1 变更成功', ok.ok === true, codeOf(ok))
    checkEqual('审计动作为 update_l1', ok.data.auditAction, 'update_l1')
    check(
      '返回需要重评估的矛盾',
      ok.data.contradictionsNeedingReview.length > 0,
      JSON.stringify(ok.data.contradictionsNeedingReview),
    )
  })

  // ---------------------------------------------------------------- C8
  console.log('\n-- C8: 树形编辑（新增 L2 / 叶子删除 / 非叶子拒绝） --')
  await withProject(async ({ tools }) => {
    await call(tools, 'goal_tree_init', {})
    await confirmStandard(tools)
    const view = await call(tools, 'goal_tree_view', {})
    const l1Node = view.data.goals.find((g) => g.depth === 1)

    const created = await call(tools, 'goal_tree_edit', {
      expectedVersion: 1,
      creates: [
        {
          depth: 2,
          parentId: l1Node.id,
          title: 'Observation store',
          evidence: ['docs/design.md'],
          // A new node has no children, so it is a leaf and owes the executable
          // contract a checkable completion condition.
          successCriteria: ['observations persist with their observation grade'],
        },
      ],
      reason: 'register a workflow module under the strategy',
    })
    check('新增 L2 成功', created.ok === true, codeOf(created))
    checkEqual('动作为 update_lower_goal', created.data.auditAction, 'update_lower_goal')

    const withL2 = await call(tools, 'goal_tree_view', {})
    const l2 = withL2.data.goals.find((g) => g.depth === 2)
    check('L2 的父节点正确', l2.parentId === l1Node.id)

    const removeParent = await call(tools, 'goal_tree_edit', {
      expectedVersion: 2,
      removes: [l1Node.id],
      reason: 'attempt to drop a subtree',
    })
    checkEqual('删除非叶子被拒绝', codeOf(removeParent), 'NOT_A_LEAF')

    const removeLeaf = await call(tools, 'goal_tree_edit', {
      expectedVersion: 2,
      removes: [l2.id],
      reason: 'the module was folded into another one',
    })
    check('删除叶子成功', removeLeaf.ok === true, codeOf(removeLeaf))
    // A deleted node has no surviving record, so the reply and the audit are the
    // only places the deletion can be seen at all.
    check(
      '删除在返回里可见',
      Array.isArray(removeLeaf.data.removedGoalIds) && removeLeaf.data.removedGoalIds.includes(l2.id),
      JSON.stringify(removeLeaf.data.removedGoalIds),
    )

    const final = await call(tools, 'goal_tree_view', {})
    check('叶子已移除', final.data.goals.every((g) => g.depth !== 2))
  })

  // ---------------------------------------------------------------- C9
  console.log('\n-- C9: 并发版本冲突与草稿态保护 --')
  await withProject(async ({ tools }) => {
    await call(tools, 'goal_tree_init', {})
    await confirmStandard(tools)
    const before = await call(tools, 'goal_tree_view', {})
    const someL1 = before.data.goals.find((g) => g.depth === 1)

    // A well-formed edit against a stale version: every other check passes, so
    // the only thing that can reject it is the CAS comparison itself.
    const stale = await call(tools, 'goal_tree_edit', {
      expectedVersion: 0,
      updates: [{ id: someL1.id, title: 'Stale rename' }],
      reason: 'stale write',
    })
    checkEqual('过期版本被拒绝', codeOf(stale), 'VERSION_CONFLICT')
    checkEqual('冲突详情带实际版本', stale.error.details?.actualVersion, 1)
    checkEqual('冲突详情带期望版本', stale.error.details?.expectedVersion, 0)

    const stillOriginal = await call(tools, 'goal_tree_view', {})
    check('过期写入未产生任何修改', stillOriginal.data.goals.find((g) => g.id === someL1.id).title === someL1.title)
    checkEqual('版本未被过期写入推进', stillOriginal.data.version, 1)

    // Editing before confirmation must be impossible: drafts are shaped by confirm.
    const freshRoot = await mkdtemp(join(tmpdir(), 'metacog-stagec-draft-'))
    fixtures.push(freshRoot)
    await writeFile(join(freshRoot, 'README.md'), '# Draft Only\n\n## Section A\n')
    const host = createHost(freshRoot)
    apply(host.ctx, {})
    await call(host.tools, 'goal_tree_init', {})
    const draftEdit = await call(host.tools, 'goal_tree_edit', {
      expectedVersion: 0,
      creates: [{ depth: 2, parentId: 'nope', title: 'x' }],
      reason: 'edit before confirming',
    })
    // init no longer writes an empty draft, so there is nothing to edit yet.
    // The guard still holds: editing requires a tree.
    checkEqual('未确认树禁止编辑', codeOf(draftEdit), 'NOT_INITIALIZED')
  })

  // ---------------------------------------------------------------- C10
  console.log('\n-- C10: 重新初始化保护与跨项目隔离 --')
  await withProject(async ({ tools, root }) => {
    await call(tools, 'goal_tree_init', {})
    await confirmStandard(tools)
    // init no longer writes state, so the guard is exercised at the store layer
    // where it actually lives: a confirmed tree refuses re-initialisation.
    const { MetacogStore } = await import(storeUrl)
    const { deriveProjectId } = await import(sharedUrl)
    const store = new MetacogStore(root, '.metacog')
    const projectId = deriveProjectId(root)
    let refused
    try {
      await store.initialize(projectId, [], [], { force: true })
    } catch (error) {
      refused = error?.code
    }
    checkEqual('已确认项目拒绝重新初始化', refused, 'STORE_INVARIANT')

    const hostB = createHost(await mkdtemp(join(tmpdir(), 'metacog-stagec-b-')))
    fixtures.push(hostB.ctx.workingDirectory.defaultDirectory)
    await writeFile(join(hostB.ctx.workingDirectory.defaultDirectory, 'README.md'), '# Project B\n\n## Beta goals\n')
    apply(hostB.ctx, {})
    const initB = await call(hostB.tools, 'goal_tree_init', {})
    check('项目 B 独立初始化', initB.ok === true, codeOf(initB))

    // Project B needs its own confirmed tree; init alone no longer writes state.
    const confirmArgsB = {
      expectedVersion: 0,
      l0: {
        title: 'Project B root',
        description: 'beta',
        evidence: ['README.md'],
        // A root with no goals is also the only leaf, so it carries a checkable
        // completion condition as well as an alignment rule.
        successCriteria: ['project B reaches its own confirmed state independently'],
        // 跨项目隔离用例：B 的根目标同样需要判据。
        alignment: { relevantActivities: ['跨项目隔离验证'] },
      },
    }
    await call(hostB.tools, 'goal_tree_confirm', { ...confirmArgsB, preview: true, noDeadlineGoalRefs: ['*'] })
    const confirmB = await call(hostB.tools, 'goal_tree_confirm', {
      ...confirmArgsB,
      userApproved: true,
      approvalNote: '项目 B 确认',
    })
    check('项目 B 可以独立确认', confirmB.ok === true, codeOf(confirmB))

    const viewA = await call(tools, 'goal_tree_view', {})
    const viewB = await call(hostB.tools, 'goal_tree_view', {})
    check('两个项目 id 不同', viewA.data.projectId !== viewB.data.projectId, `${viewA.data.projectId} vs ${viewB.data.projectId}`)
    check('项目 A 保持已确认', viewA.data.confirmed === true)
    check('项目 B 也已确认但内容独立', viewB.data.goals[0].title === 'Project B root', JSON.stringify(viewB.data.goals.map((g) => g.title)))
    check('项目 A 的目标未被 B 覆盖', viewA.data.goals.every((g) => g.title !== 'Project B root'))
  })

  // --------------------------------------------------------------- C10b
  console.log('\n-- C10b: 初始化与监控分离 —— 树建立后不再重新推导 --')
  // A goal tree is the yardstick for judging alignment. Re-deriving it would
  // invalidate every past judgement, so init must refuse once confirmed and the
  // only allowed change channel is a user-stated revision.
  await withProject(async ({ tools }) => {
    await confirmStandard(tools)

    const reinit = await call(tools, 'goal_tree_init', {})
    checkEqual('已确认后拒绝重新推导', codeOf(reinit), 'ALREADY_INITIALIZED')
    check(
      '拒绝理由说明树是判据',
      String(reinit.error?.message ?? '').includes('yardstick'),
      String(reinit.error?.message ?? '').slice(0, 120),
    )
    check(
      '拒绝理由指向正确的入口',
      String(reinit.error?.message ?? '').includes('metacog_revise'),
      String(reinit.error?.message ?? '').slice(0, 200),
    )

    // 重建是允许的，但 `force` 单独不足以免除拒绝：清空一棵已确认的树还必须
    // 交出它当前的版本号，否则调用方无法证明自己读过即将被丢弃的那棵树。
    const forceOnly = await call(tools, 'goal_tree_init', { force: true })
    checkEqual('单独 force 仍被拒绝', codeOf(forceOnly), 'EXPECTED_VERSION_REQUIRED')
    check(
      '拒绝理由要求先读出当前版本',
      String(forceOnly.error?.message ?? '').includes('expectedVersion'),
      String(forceOnly.error?.message ?? '').slice(0, 200),
    )

    // The user-stated channel works.
    const view = await call(tools, 'goal_tree_view', {})
    const target = view.data.goals.find((g) => g.depth === 1)
    const revised = await call(tools, 'metacog_revise', {
      expectedVersion: view.data.version,
      reason: '用户告知：该战略目标已完成',
      revisions: [{ kind: 'goal_achieved', target: target.title }],
    })
    check('用户告知的变更被接受', revised.ok === true, codeOf(revised))
    checkEqual('版本递增', revised.data.version, view.data.version + 1)

    const after = await call(tools, 'goal_tree_view', {})
    checkEqual('目标状态已更新', after.data.goals.find((g) => g.id === target.id)?.status, 'done')
    check('审计链仍有效', after.data.audit.valid === true)
  })

  // ---------------------------------------------------------------- C11
  console.log('\n-- C11: 矛盾树编辑与目标关联校验 --')
  await withProject(async ({ tools }) => {
    await call(tools, 'goal_tree_init', {})
    await confirmStandard(tools)
    const view = await call(tools, 'goal_tree_view', {})
    const goals = view.data.goals

    const badPrimary = await call(tools, 'contradiction_tree_edit', {
      expectedVersion: 1,
      creates: [
        {
          title: 'orphan tension',
          poleA: 'a',
          poleB: 'b',
          primaryGoalId: 'L1_ghost',
          evidence: ['README.md'],
        },
      ],
      reason: 'exercise goal link validation',
    })
    checkEqual('primaryGoalId 不存在被拒绝', codeOf(badPrimary), 'TREE_SHAPE')

    const selfRelated = await call(tools, 'contradiction_tree_edit', {
      expectedVersion: 1,
      creates: [
        {
          title: 'self-referential tension',
          poleA: 'a',
          poleB: 'b',
          primaryGoalId: goals[1].id,
          relatedGoalIds: [goals[1].id],
          evidence: ['README.md'],
        },
      ],
      reason: 'exercise disjointness',
    })
    checkEqual('related 与 primary 重叠被拒绝', codeOf(selfRelated), 'TREE_SHAPE')

    const good = await call(tools, 'contradiction_tree_edit', {
      expectedVersion: 1,
      creates: [
        {
          title: 'breadth vs depth',
          poleA: 'breadth',
          poleB: 'depth',
          primaryGoalId: goals[1].id,
          relatedGoalIds: [goals[2].id],
          evidence: ['docs/design.md'],
          type: 'secondary',
        },
      ],
      reason: 'register a newly identified subordinate tension',
    })
    check('合规矛盾新增成功', good.ok === true, codeOf(good))
    const after = await call(tools, 'goal_tree_view', {})
    const added = after.data.contradictions.find((c) => c.title === 'breadth vs depth')
    check('新增矛盾初始 trend 为 unknown', added.trend === 'unknown', added?.trend)
    check('新增矛盾初始 intensity 为 null', added.intensity === null, String(added?.intensity))
  })

  // ---------------------------------------------------------------- C12
  console.log('\n-- C12: 编辑不得留下悬空矛盾链接 --')
  await withProject(async ({ tools }) => {
    await call(tools, 'goal_tree_init', {})
    await confirmStandard(tools)
    const view = await call(tools, 'goal_tree_view', {})
    // The confirmed contradiction links L1[1] and L1[2]; deleting either would
    // orphan it, which the edit tool must refuse.
    const related = view.data.goals.find((g) => g.id === view.data.contradictions[0].relatedGoalIds[0])
    const attempt = await call(tools, 'goal_tree_edit', {
      expectedVersion: 1,
      removes: [related.id],
      reason: 'try to delete a goal still referenced by a contradiction',
    })
    checkEqual('删除被矛盾引用的目标被拒绝', codeOf(attempt), 'CONTRADICTION_LINK_BROKEN')
    // A refused edit must leave the tree untouched, including the version.
    const after = await call(tools, 'goal_tree_view', {})
    checkEqual('拒绝后版本未变', after.data.version, 1)
    check(
      '拒绝后目标仍在',
      after.data.goals.some((g) => g.id === related.id),
      JSON.stringify(after.data.goals.map((g) => g.id)),
    )
  })
} finally {
  for (const root of fixtures) {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

console.log(`\n=== Tree lifecycle 结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
