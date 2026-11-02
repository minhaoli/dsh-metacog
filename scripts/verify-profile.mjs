/**
 * 项目背景（`projectProfile` / `projectContext`）的验证。
 *
 * 推导会产出两层背景，它们必须保持分开：
 * - 用户说的（role / intent / constraints / stakeholders），
 * - 文档显示的（projectSummary / stage / deliverables）。
 *
 * 两层冲突时是信息，不是错误，所以派生层永远不覆盖用户陈述层。
 *
 * 这里只测能真正测的东西：schema 契约、持久化往返、以及"存了能读回来"。
 * 合并逻辑嵌在 `goal_tree_init` 里且必须先跑一次子代理，所以它的方向由
 * `test/derivation-draft.test.mjs` 覆盖；此处复制一份合并只是为了让优先级
 * 语义在脚本里可见，不作为实现证据。
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
const { ProjectProfileSchema } = await import(lib('analysis/derive.js'))
const { ProjectContextSchema } = await import(lib('data/types.js'))



console.log('=== 1. 派生层 schema 的默认值 ===')
const emptyProfile = ProjectProfileSchema.parse({})
check('空对象给出空 summary', emptyProfile.summary === '', JSON.stringify(emptyProfile))
check('空对象给出空 stage', emptyProfile.stage === '', JSON.stringify(emptyProfile))
check(
  '空对象给出空 deliverables',
  Array.isArray(emptyProfile.deliverables) && emptyProfile.deliverables.length === 0,
  JSON.stringify(emptyProfile),
)

const fullProfile = ProjectProfileSchema.parse({
  summary: '一个 DSH 元认知监控插件',
  stage: '验证阶段',
  deliverables: ['插件包', '验证台账'],
})
check('完整 profile 被接受', fullProfile.summary.includes('元认知'), JSON.stringify(fullProfile))
check('deliverables 保持顺序', fullProfile.deliverables[0] === '插件包', JSON.stringify(fullProfile.deliverables))

console.log('\n=== 2. 用户陈述层 schema ===')
const ctxEmpty = ProjectContextSchema.parse({})
check('空 context 的 constraints 是数组', Array.isArray(ctxEmpty.constraints), JSON.stringify(ctxEmpty))
check('空 context 的 stakeholders 是数组', Array.isArray(ctxEmpty.stakeholders), JSON.stringify(ctxEmpty))
const ctxFull = ProjectContextSchema.parse({
  role: '插件作者',
  intent: '给 DSH 加一层元认知监控',
  constraints: ['不引入外部依赖'],
  stakeholders: ['我自己'],
})
check('完整 context 被接受', ctxFull.role === '插件作者', JSON.stringify(ctxFull))

console.log('\n=== 3. 背景持久化往返 ===')
const root = await mkdtemp(join(tmpdir(), 'metacog-profile-'))
try {
  await writeFile(join(root, 'README.md'), '# 项目背景验证\n')
  const tools = new Map()
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return { get: () => root, defaultDirectory: root }
      if (name === 'tools') return this.tools
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
      agent: { id: 'profile-test' },
    })

  await call('goal_tree_confirm', {
    expectedVersion: 0,
    l0: { title: '背景验证的根目标', evidence: ['README.md'] },
    goals: [],
    contradictions: [],
    reason: '背景验证基线',
  })

  const store = new MetacogStore(root, '.metacog')
  const projectId = deriveProjectId(root)

  const beforeAny = await store.readProjectContext(projectId)
  check('从未写过背景时读到 undefined', beforeAny === undefined, JSON.stringify(beforeAny))

  const written = await store.setProjectContext(projectId, {
    role: '插件作者',
    intent: '给 DSH 加一层元认知监控',
    constraints: ['不引入外部依赖'],
    stakeholders: ['我自己'],
    projectSummary: '一个 DSH 元认知监控插件',
    stage: '验证阶段',
    deliverables: ['插件包', '验证台账'],
  })
  check('写入返回带 updatedAt', typeof written.updatedAt === 'string', JSON.stringify(written))

  const readBack = await store.readProjectContext(projectId)
  check('用户层 role 读回', readBack?.role === '插件作者', String(readBack?.role))
  check('用户层 intent 读回', readBack?.intent.includes('元认知'), String(readBack?.intent))
  check('用户层 constraints 读回', readBack?.constraints?.[0] === '不引入外部依赖', JSON.stringify(readBack?.constraints))
  check('派生层 summary 读回', readBack?.projectSummary.includes('元认知'), String(readBack?.projectSummary))
  check('派生层 stage 读回', readBack?.stage === '验证阶段', String(readBack?.stage))
  check('派生层 deliverables 读回', readBack?.deliverables?.[1] === '验证台账', JSON.stringify(readBack?.deliverables))

  console.log('\n=== 4. 写背景不改动树版本 ===')
  const stateBefore = await store.readState(projectId)
  const versionBefore = stateBefore.version
  await store.setProjectContext(projectId, {
    role: '换了个角色',
    intent: '换个意图',
    constraints: [],
    stakeholders: [],
    projectSummary: '',
    stage: '',
    deliverables: [],
  })
  const stateAfter = await store.readState(projectId)
  check('版本没有被背景编辑推进', stateAfter.version === versionBefore, `${versionBefore} -> ${stateAfter.version}`)
  check('目标数量未变', stateAfter.goals.length === stateBefore.goals.length, String(stateAfter.goals.length))
  check('目标标题未变', stateAfter.goals[0].title === stateBefore.goals[0].title, stateAfter.goals[0].title)

  console.log('\n=== 5. 覆盖写只留最新一份 ===')
  const finalCtx = await store.readProjectContext(projectId)
  check('role 是最后一次写入的值', finalCtx?.role === '换了个角色', String(finalCtx?.role))
  check('旧 summary 已被清空', finalCtx?.projectSummary === '', String(finalCtx?.projectSummary))

  console.log('\n=== 6. 没有树时写背景被拒 ===')
  const bareRoot = await mkdtemp(join(tmpdir(), 'metacog-profile-bare-'))
  try {
    const bareStore = new MetacogStore(bareRoot, '.metacog')
    let refused = false
    try {
      await bareStore.setProjectContext(deriveProjectId(bareRoot), {
        role: 'r',
        intent: 'i',
        constraints: [],
        stakeholders: [],
        projectSummary: '',
        stage: '',
        deliverables: [],
      })
    } catch (error) {
      refused = String(error).includes('no tree state')
    }
    check('无树时写背景被拒', refused, 'not refused')
  } finally {
    await rm(bareRoot, { recursive: true, force: true })
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

exit()
