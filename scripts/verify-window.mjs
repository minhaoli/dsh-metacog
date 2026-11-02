/**
 * 检查点增量窗口的验证。
 *
 * 窗口的语义是「自上次汇报以来」，不是「最近 24 小时」。固定周期会重复评判
 * 用户已经回答过的工作，同时漏掉更早但从未被评判的工作。
 *
 * 这个脚本证明四件事：
 * 1. 首次检查（无检查点）取全部活动；
 * 2. 有检查点后只取检查点之后的活动；
 * 3. 检查点只在判定成功时推进；
 * 4. 判定为空或失败时检查点不动，那些活动留到下次。
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



const root = await mkdtemp(join(tmpdir(), 'metacog-window-'))
try {
  await writeFile(join(root, 'README.md'), '# 检查点窗口验证\n')
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
      agent: { id: 'window-test' },
    })

  await call('goal_tree_confirm', {
    expectedVersion: 0,
    l0: { title: '窗口验证的根目标', evidence: ['README.md'] },
    goals: [],
    contradictions: [],
    reason: '检查点窗口验证基线',
  })

  const store = new MetacogStore(root, '.metacog')
  const projectId = deriveProjectId(root)

  const seedActivity = async (index, isoTime) => {
    await store.appendActivity(projectId, {
      id: `act_window_${index}`,
      eventFingerprint: `window:${index}`,
      projectId,
      sessionId: 'session-window-test',
      timestamp: isoTime,
      source: 'user_input',
      observationGrade: 'A',
      summary: `窗口测试活动 ${index}`,
      evidence: [],
      candidateGoalIds: [],
      alignmentConfidence: 1,
      decision: 'aligned',
      rationale: '测试用',
    })
  }

  const windowOf = async (checkpoint) => {
    const all = await store.readActivities(projectId)
    return checkpoint === undefined
      ? all
      : all.filter((item) => Date.parse(item.timestamp) > Date.parse(checkpoint))
  }

  console.log('\n=== 1. 首次检查取全部活动 ===')
  await seedActivity(0, '2026-10-20T01:00:00.000Z')
  await seedActivity(1, '2026-10-21T01:00:00.000Z')
  await seedActivity(2, '2026-10-22T01:00:00.000Z')
  const noCheckpoint = await store.readCheckpoint(projectId)
  check('还没有检查点', noCheckpoint === undefined, String(noCheckpoint))
  const firstWindow = await windowOf(noCheckpoint)
  check('首次窗口包含全部 3 条', firstWindow.length === 3, String(firstWindow.length))

  console.log('\n=== 2. 有检查点后只取之后的活动 ===')
  const checkpointAt = '2026-10-21T12:00:00.000Z'
  await store.setCheckpoint(projectId, checkpointAt)
  const saved = await store.readCheckpoint(projectId)
  check('检查点已落盘', saved === checkpointAt, String(saved))

  const secondWindow = await windowOf(saved)
  check('窗口只剩检查点之后的 1 条', secondWindow.length === 1, String(secondWindow.length))
  check('留下的正是最新那条', secondWindow[0]?.summary.includes('窗口测试活动 2'), String(secondWindow[0]?.summary))

  console.log('\n=== 3. 检查点边界是严格大于 ===')
  await seedActivity(3, checkpointAt)
  const boundary = await windowOf(saved)
  check('恰好在检查点时刻的活动不计入', boundary.length === 1, String(boundary.length))

  console.log('\n=== 4. 推进检查点后旧活动不再出现 ===')
  await seedActivity(4, '2026-10-23T01:00:00.000Z')
  const beforeAdvance = await windowOf(saved)
  check('推进前窗口有 2 条', beforeAdvance.length === 2, String(beforeAdvance.length))
  await store.setCheckpoint(projectId, '2026-10-22T12:00:00.000Z')
  const afterAdvance = await windowOf(await store.readCheckpoint(projectId))
  check('推进后窗口只剩 1 条', afterAdvance.length === 1, String(afterAdvance.length))
  check('剩下的是最新那条', afterAdvance[0]?.summary.includes('窗口测试活动 4'), String(afterAdvance[0]?.summary))

  console.log('\n=== 5. 没有新活动时窗口为空 ===')
  await store.setCheckpoint(projectId, '2026-10-25T00:00:00.000Z')
  const emptyWindow = await windowOf(await store.readCheckpoint(projectId))
  check('窗口为空', emptyWindow.length === 0, String(emptyWindow.length))

  console.log('\n=== 6. 检查点独立于树版本 ===')
  const stateBefore = await store.readState(projectId)
  await store.setCheckpoint(projectId, '2026-10-26T00:00:00.000Z')
  const stateAfter = await store.readState(projectId)
  check('推进检查点不改树版本', stateAfter.version === stateBefore.version, `${stateBefore.version} -> ${stateAfter.version}`)
  check('推进检查点不改目标', stateAfter.goals.length === stateBefore.goals.length, String(stateAfter.goals.length))

  console.log('\n=== 7. 检查点不写审计 ===')
  const auditBefore = await store.readAuditLog(projectId)
  await store.setCheckpoint(projectId, '2026-10-27T00:00:00.000Z')
  const auditAfter = await store.readAuditLog(projectId)
  check('审计条目数未变', auditAfter.length === auditBefore.length, `${auditBefore.length} -> ${auditAfter.length}`)

  console.log('\n=== 8. 检查点按项目隔离 ===')
  const otherRoot = await mkdtemp(join(tmpdir(), 'metacog-window-other-'))
  try {
    const otherStore = new MetacogStore(otherRoot, '.metacog')
    const otherId = deriveProjectId(otherRoot)
    const missing = await otherStore.readCheckpoint(otherId)
    check('别的项目读不到本项目的检查点', missing === undefined, String(missing))
  } finally {
    await rm(otherRoot, { recursive: true, force: true })
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

exit()
