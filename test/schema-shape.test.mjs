/**
 * Schema-shape guards.
 *
 * The host validates a structured-output schema before it runs a subagent, and
 * its validator rejects a **type array** — `type: ['string', 'null']` fails with
 * `JsonSchemaError: ... type must be a single type string`. That took derivation
 * down entirely: the tool could not start the subagent, so every project got
 * `discovery-only` instead of a tree.
 *
 * Nullable fields are therefore encoded explicitly (empty string, or 0) instead of
 * unions. This file walks every schema the plugin hands the host and fails if a
 * type array ever comes back.
 *
 * Run: node test/schema-shape.test.mjs
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

/** Collect every `type` that is an array, with a path precise enough to fix it. */
function findTypeArrays(node, path, found) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((item, index) => findTypeArrays(item, `${path}[${index}]`, found))
    return
  }
  for (const [key, value] of Object.entries(node)) {
    const next = path.length === 0 ? key : `${path}.${key}`
    if (key === 'type' && Array.isArray(value)) {
      found.push(`${next} = ${JSON.stringify(value)}`)
      continue
    }
    findTypeArrays(value, next, found)
  }
}

const { apply } = await import(libUrl)
const { DERIVATION_JSON_SCHEMA } = await import(deriveUrl)

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
    agent: { id: 'agent-schema-test' },
  })
}

const root = await mkdtemp(join(tmpdir(), 'metacog-schema-'))
try {
  await writeFile(join(root, 'README.md'), '# 测试项目\n\n一个用于验证 schema 形状的项目。\n')
  const { tools } = createHost(root)

  console.log('\n=== S1: 工具参数 schema 不得含 type 数组 ===')
  // 20 = the original 14, two v4 plan tools, purge, the milestone archive,
  // the criteria drafter, and the plugin's own question tool.
  check('工具全部注册', tools.size === 20, `got ${tools.size}`)
  const offenders = []
  for (const [name, definition] of tools) {
    check(`${name} 的 parameters 是 object`, definition.parameters?.type === 'object', String(definition.parameters?.type))
    const found = []
    findTypeArrays(definition.parameters, name, found)
    offenders.push(...found)
  }
  check('没有任何 type 数组', offenders.length === 0, offenders.join(' | '))

  console.log('\n=== S2: 推导输出 schema 不得含 type 数组 ===')
  const derivationOffenders = []
  findTypeArrays(DERIVATION_JSON_SCHEMA, 'derivation', derivationOffenders)
  check('推导 schema 干净', derivationOffenders.length === 0, derivationOffenders.join(' | '))

  const goalProps = DERIVATION_JSON_SCHEMA.properties.goals.items.properties
  check('parentTempId 是单一 string', goalProps.parentTempId.type === 'string', String(goalProps.parentTempId.type))
  check('parentTempId 说明了根节点约定', String(goalProps.parentTempId.description).includes('""'))
  check(
    'parentTempId 不属于必填（根节点可省略）',
    !DERIVATION_JSON_SCHEMA.properties.goals.items.required.includes('parentTempId'),
  )
  check(
    'contradictions 也保持单一类型',
    DERIVATION_JSON_SCHEMA.properties.contradictions.items.properties.constraintKind.type === 'string',
  )

  console.log('\n=== S3: intensity 用 0 表示"无法判断"，落库为 null ===')
  const confirmArgs = {
    expectedVersion: 0,
    l0: {
      title: '把这件事做成',
      evidence: ['README.md'],
      // A single-node tree makes the root a leaf, so it carries the completion
      // condition the leaf contract asks for.
      successCriteria: ['every tool schema declares one type per field'],
      // 本测试校验工具 schema 的形状（单一类型、intensity 0 → null），
      // 根目标服务的活动就是这类 schema 校验。
      alignment: { relevantActivities: ['schema 形状校验'] },
    },
    contradictions: [
      {
        title: '速度与质量的张力',
        poleA: '先交付',
        poleB: '先打磨',
        evidence: ['README.md'],
        primaryGoalRef: '把这件事做成',
      },
    ],
    reason: 'schema 测试',
  }
  await call(tools, 'goal_tree_confirm', { ...confirmArgs, preview: true, noDeadlineGoalRefs: ['*'] })
  const confirmed = await call(tools, 'goal_tree_confirm', {
    ...confirmArgs,
    userApproved: true,
    approvalNote: 'schema 测试确认',
  })
  check('确认成功', confirmed.ok === true, JSON.stringify(confirmed).slice(0, 300))

  const view = await call(tools, 'goal_tree_view', {})
  const contradictionId = view.data?.contradictions?.[0]?.id
  check('拿到矛盾 id', typeof contradictionId === 'string', String(contradictionId))

  const unknown = await call(tools, 'contradiction_observe', {
    contradictionId,
    intensity: 0,
    rationale: '当前没有证据支持任何档位。',
  })
  check('intensity=0 被接受', unknown.ok === true, JSON.stringify(unknown).slice(0, 300))
  check('intensity=0 落库为 null', unknown.data?.intensity === null, String(unknown.data?.intensity))

  const concrete = await call(tools, 'contradiction_observe', {
    contradictionId,
    intensity: 4,
    rationale: '交付压力明显更大。',
  })
  check('intensity=4 保持为 4', concrete.data?.intensity === 4, String(concrete.data?.intensity))

  const rejected = await call(tools, 'contradiction_observe', {
    contradictionId,
    intensity: 9,
    rationale: '越界值。',
  })
  check('越界 intensity 被拒绝', rejected.ok === false, JSON.stringify(rejected).slice(0, 200))

  console.log('\n=== S4: contradiction_tree_edit 的 intensity 同样是单一类型 ===')
  const editParams = tools.get('contradiction_tree_edit').parameters
  const intensitySchema = editParams.properties.updates.items.properties.intensity
  check('intensity 是 integer', intensitySchema.type === 'integer', String(intensitySchema.type))
  check('intensity 允许 0（清空语义）', intensitySchema.minimum === 0, String(intensitySchema.minimum))

  const cleared = await call(tools, 'contradiction_tree_edit', {
    expectedVersion: view.data.version,
    updates: [{ id: contradictionId, intensity: 0 }],
  })
  check('编辑 intensity=0 成功', cleared.ok === true, JSON.stringify(cleared).slice(0, 300))
  const after = await call(tools, 'goal_tree_view', {})
  const clearedNode = after.data?.contradictions?.find((node) => node.id === contradictionId)
  check('人工值被清空为 null', clearedNode?.intensityEdited === null, String(clearedNode?.intensityEdited))
  // 前面已经写过 intensity=4 的观察，投影优先采用观察流，因此显示值仍是 4。
  check('显示值来自观察流', clearedNode?.intensity === 4, String(clearedNode?.intensity))
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n=== Schema 结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
