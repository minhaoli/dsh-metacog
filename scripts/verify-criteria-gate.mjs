/**
 * Verify the criteria gate on `goal_tree_confirm`.
 *
 * The gate exists because a goal with neither `relevantActivities` nor
 * `allowedMethods` can never be matched by an activity: every verdict for it
 * falls through to `scope_drift`, silently, forever. So the contract under test
 * is narrow and worth pinning down:
 *
 *   1. a tree whose goals carry no alignment criteria is refused, with
 *      `CRITERIA_REQUIRED`, and nothing is written;
 *   2. the refusal names the offending goals, so the caller can fix them;
 *   3. `successCriteria` alone does not satisfy the gate — that is the exact
 *      confusion that produced the current all-empty tree;
 *   4. `allowMissingCriteria: true` lets an intentional case through;
 *   5. a tree that does carry criteria is accepted.
 *
 * Usage: node scripts/verify-criteria-gate.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createChecker, libUrl, mountHost } from './_harness.mjs'

const lib = (name) => libUrl('lib', name)
const { apply } = await import(lib('index.js'))

const { check, exit } = createChecker('ok', { predicate: true })

/** A host good enough for the tool registry. */
function createHost(root) {
  return mountHost(apply, root, { sessions: { list: () => [], get: () => undefined } })
}

/** Call one tool and normalise the two outcomes.
 *
 * A refused tool call is a *value*, not an exception: `defineMetacogTool` turns a
 * `GateError` into `{ ok: false, error: { code, message } }`. The helper flattens
 * that so the assertions can talk about `code` and `message` directly.
 */
async function call(tools, name, args) {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`tool ${name} not registered`)
  try {
    const data = await tool.execute(args, {
      agent: undefined,
      session: undefined,
      signal: new AbortController().signal,
    })
    if (data !== null && typeof data === 'object' && data.ok === false && data.error !== undefined) {
      return { ok: false, code: data.error.code, message: String(data.error.message ?? '') }
    }
    return { ok: true, data }
  } catch (error) {
    return { ok: false, code: error?.code, message: String(error?.message ?? error) }
  }
}

async function withProject(body) {
  const root = await mkdtemp(join(tmpdir(), 'metacog-gate-'))
  try {
    await writeFile(join(root, 'README.md'), '# 项目\n\n用于验证判据门的项目。\n')
    const { ctx, tools } = createHost(root)
    apply(ctx, {})
    await body({ root, tools })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const L0 = { title: '把这件事做成', evidence: ['README.md'] }

console.log('\n=== G1: 无判据的树被拒绝 ===')
await withProject(async ({ root, tools }) => {
  const result = await call(tools, 'goal_tree_confirm', {
    expectedVersion: 0,
    l0: L0,
    goals: [
      { title: '第一层', evidence: ['README.md'] },
      { title: '第二层', depth: 2, parentRef: '第一层', evidence: ['README.md'] },
    ],
    reason: 'gate test',
  })
  check('确认被拒绝', result.ok === false, JSON.stringify(result).slice(0, 200))
  check('错误码是 CRITERIA_REQUIRED', result.code === 'CRITERIA_REQUIRED', String(result.code))
  check('错误信息点名了具体目标', /第一层/.test(result.message) && /第二层/.test(result.message), result.message)
  check('错误信息解释了 successCriteria 不算', /successCriteria/.test(result.message), result.message)

  // Nothing may reach the store: a refused confirmation must not half-write.
  const statePath = join(root, '.metacog', 'state')
  let stateFiles = []
  try {
    stateFiles = await readFile(join(statePath, 'nonexistent'), 'utf8').then(() => ['?'])
  } catch {
    stateFiles = []
  }
  const view = await call(tools, 'goal_tree_view', {})
  check('树上没有留下半成品', view.ok === false || (view.data?.version ?? 0) === 0, JSON.stringify(view.data ?? view).slice(0, 160))
})

console.log('\n=== G2: 只有 successCriteria 不够 ===')
await withProject(async ({ tools }) => {
  const result = await call(tools, 'goal_tree_confirm', {
    expectedVersion: 0,
    l0: { ...L0, successCriteria: ['能跑通'] },
    goals: [
      { title: '第一层', evidence: ['README.md'], successCriteria: ['测试全绿'] },
    ],
    reason: 'only successCriteria',
  })
  check('仍然被拒绝', result.ok === false, JSON.stringify(result).slice(0, 160))
  check('原因仍是 CRITERIA_REQUIRED', result.code === 'CRITERIA_REQUIRED', String(result.code))
})

console.log('\n=== G3: allowMissingCriteria 显式放行 ===')
await withProject(async ({ tools }) => {
  const result = await call(tools, 'goal_tree_confirm', {
    expectedVersion: 0,
    l0: L0,
    goals: [{ title: '第一层', evidence: ['README.md'] }],
    reason: 'intentional empty',
    allowMissingCriteria: true,
  })
  check('显式豁免后确认成功', result.ok === true, JSON.stringify(result).slice(0, 200))
})

console.log('\n=== G4: 带判据的树正常通过 ===')
await withProject(async ({ tools }) => {
  const result = await call(tools, 'goal_tree_confirm', {
    expectedVersion: 0,
    l0: { ...L0, alignment: { relevantActivities: ['项目立项'] } },
    goals: [
      {
        title: '第一层',
        evidence: ['README.md'],
        alignment: { relevantActivities: ['结构建模'], allowedMethods: ['typescript'] },
      },
    ],
    reason: 'with criteria',
  })
  check('确认成功', result.ok === true, JSON.stringify(result).slice(0, 200))

  const view = await call(tools, 'goal_tree_view', {})
  check('视图里能读回判据', JSON.stringify(view.data ?? {}).includes('结构建模'), JSON.stringify(view.data ?? {}).slice(0, 200))
})

console.log('\n=== G5: 只要一个字段非空就够 ===')
await withProject(async ({ tools }) => {
  const result = await call(tools, 'goal_tree_confirm', {
    expectedVersion: 0,
    // The root counts as a goal, so it needs one of the two as well; only the
    // non-root node is the subject of this case.
    l0: { ...L0, alignment: { allowedMethods: ['markdown'] } },
    goals: [
      {
        title: '只有允许方法',
        evidence: ['README.md'],
        alignment: { allowedMethods: ['python'] },
      },
    ],
    reason: 'allowedMethods only',
  })
  check('仅 allowedMethods 也通过', result.ok === true, JSON.stringify(result).slice(0, 200))
})

exit()
