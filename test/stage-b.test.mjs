/**
 * Stage B verification: data model, persistence isolation, CAS concurrency
 * control and the hash-chained audit log.
 *
 * Exercises the compiled store against real temporary directories — no mocked
 * filesystem — so atomic writes, restart recovery and corruption detection are
 * verified against actual disk behaviour.
 *
 * Run: node test/stage-b.test.mjs
 */
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const storeUrl = pathToFileURL(join(here, '..', 'lib', 'data', 'store.js')).href
const typesUrl = pathToFileURL(join(here, '..', 'lib', 'data', 'types.js')).href

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

/** Build a goal node with sensible defaults for tests. */
function goal(id, overrides = {}) {
  const now = new Date().toISOString()
  return {
    id,
    projectId: 'p1',
    parentId: null,
    level: 'L1',
    title: `goal ${id}`,
    description: '',
    status: 'active',
    priority: 0,
    confirmedByUser: true,
    successCriteria: ['criterion'],
    alignment: {
      relevantActivities: [],
      allowedMethods: [],
      excludedActivities: [],
      explorationPolicy: 'limited',
    },
    evidence: ['docs/readme.md'],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

/** Build a contradiction node with sensible defaults for tests. */
function contradiction(id, overrides = {}) {
  const now = new Date().toISOString()
  return {
    id,
    projectId: 'p1',
    parentId: null,
    primaryGoalId: 'L1_a',
    relatedGoalIds: [],
    type: 'main',
    confirmedByUser: true,
    title: `contradiction ${id}`,
    description: '',
    poleA: 'a',
    poleB: 'b',
    intensity: 3,
    trend: 'unknown',
    rationale: '',
    resolutionHint: '',
    evidence: ['docs/readme.md'],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

const temporaries = []

/** Create an isolated temporary project root. */
async function makeProject() {
  const dir = await mkdtemp(join(tmpdir(), 'metacog-stageb-'))
  temporaries.push(dir)
  return dir
}

console.log('=== Stage B: 数据模型、持久化隔离、CAS 并发控制与哈希链审计 ===')

const { MetacogStore, VersionConflictError, StoreInvariantError, computeAuditHash } = await import(
  storeUrl
)
const { GENESIS_HASH } = await import(typesUrl)

console.log('\n-- B1: 初始化与版本起点 --')
{
  const root = await makeProject()
  const store = new MetacogStore(root, '.metacog')
  const state = await store.initialize('p1', [goal('L0_root', { level: 'L0' }), goal('L1_a')], [])
  check('初始化成功', state !== undefined)
  checkEqual('初始 version 为 0', state.version, 0)
  checkEqual('初始为未确认草稿', state.confirmed, false)
  checkEqual('目标数量正确', state.goals.length, 2)

  const reread = await store.readState('p1')
  checkEqual('重新读取 version 一致', reread?.version, 0)
  checkEqual('重新读取目标一致', reread?.goals.length, 2)

  let threw = false
  try {
    await store.initialize('p1', [goal('x')], [])
  } catch (error) {
    threw = error instanceof StoreInvariantError
  }
  check('重复初始化未确认草稿被拒绝', threw)

  const forced = await store.initialize('p1', [goal('L0_root', { level: 'L0' })], [], {
    force: true,
  })
  checkEqual('force 可替换草稿', forced.goals.length, 1)
}

console.log('\n-- B2: CAS 并发冲突拦截 --')
{
  const root = await makeProject()
  const store = new MetacogStore(root, '.metacog')
  await store.initialize('p1', [goal('L1_a')], [])

  const first = await store.commit('p1', {
    expectedVersion: 0,
    goals: [goal('L1_a', { title: 'changed' })],
    contradictions: [],
    reason: 'first edit',
    action: 'update_lower_goal',
    actor: 'manual_tool',
    targetIds: ['L1_a'],
  })
  checkEqual('首次提交后 version 为 1', first.state.version, 1)

  let conflict
  try {
    await store.commit('p1', {
      expectedVersion: 0,
      goals: [goal('L1_a', { title: 'stale write' })],
      contradictions: [],
      reason: 'stale',
      action: 'update_lower_goal',
      actor: 'manual_tool',
      targetIds: ['L1_a'],
    })
  } catch (error) {
    conflict = error
  }
  check('过期 expectedVersion 抛错', conflict !== undefined)
  check('错误类型为 VersionConflictError', conflict instanceof VersionConflictError)
  checkEqual('错误码正确', conflict?.code, 'VERSION_CONFLICT')
  checkEqual('报告期望版本', conflict?.expectedVersion, 0)
  checkEqual('报告实际版本', conflict?.actualVersion, 1)

  const after = await store.readState('p1')
  check('冲突后状态未被静默覆盖', after.goals[0].title === 'changed', after.goals[0].title)
  checkEqual('冲突后版本未变', after.version, 1)
}

console.log('\n-- B3: 同一版本并发写入只有一个成功 --')
{
  const root = await makeProject()
  const store = new MetacogStore(root, '.metacog')
  await store.initialize('p1', [goal('L1_a')], [])

  const attempts = Array.from({ length: 5 }, (_, index) =>
    store
      .commit('p1', {
        expectedVersion: 0,
        goals: [goal('L1_a', { title: `writer-${index}` })],
        contradictions: [],
        reason: `concurrent ${index}`,
        action: 'update_lower_goal',
        actor: 'manual_tool',
        targetIds: ['L1_a'],
      })
      .then(
        () => 'ok',
        (error) => (error instanceof VersionConflictError ? 'conflict' : 'other'),
      ),
  )
  const results = await Promise.all(attempts)
  checkEqual('恰好一个成功', results.filter((r) => r === 'ok').length, 1)
  checkEqual('其余全部冲突', results.filter((r) => r === 'conflict').length, 4)
  const final = await store.readState('p1')
  checkEqual('最终版本只递增一次', final.version, 1)
}

console.log('\n-- B4: 跨项目隔离 --')
{
  const root = await makeProject()
  const store = new MetacogStore(root, '.metacog')
  await store.initialize('p1', [goal('L1_a', { projectId: 'p1', title: 'project one' })], [])
  await store.initialize('p2', [goal('L1_b', { projectId: 'p2', title: 'project two' })], [])

  const one = await store.readState('p1')
  const two = await store.readState('p2')
  checkEqual('p1 只看到自己的目标', one.goals.map((g) => g.id), ['L1_a'])
  checkEqual('p2 只看到自己的目标', two.goals.map((g) => g.id), ['L1_b'])
  checkEqual('p1 标题未串到 p2', two.goals[0].title, 'project two')

  await store.commit('p1', {
    expectedVersion: 0,
    goals: [goal('L1_a', { title: 'p1 v1' })],
    contradictions: [],
    reason: 'p1 edit',
    action: 'update_lower_goal',
    actor: 'manual_tool',
    targetIds: ['L1_a'],
  })
  const twoAfter = await store.readState('p2')
  checkEqual('p1 提交不影响 p2 版本', twoAfter.version, 0)

  await store.appendActivity('p1', {
    id: 'act1',
    eventFingerprint: 'fp1',
    projectId: 'p1',
    sessionId: 's1',
    timestamp: new Date().toISOString(),
    source: 'manual',
    observationGrade: 'A',
    summary: 'p1 activity',
    evidence: [],
    candidateGoalIds: [],
    alignmentConfidence: 0.9,
    decision: 'aligned',
    rationale: '',
  })
  checkEqual('p1 有活动记录', (await store.readActivities('p1')).length, 1)
  checkEqual('p2 无活动记录', (await store.readActivities('p2')).length, 0)

  let mismatch = false
  try {
    await store.appendActivity('p2', {
      id: 'act2',
      eventFingerprint: 'fp2',
      projectId: 'p1',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      source: 'manual',
      observationGrade: 'A',
      summary: 'wrong project',
      evidence: [],
      candidateGoalIds: [],
      alignmentConfidence: 0.9,
      decision: 'aligned',
      rationale: '',
    })
  } catch (error) {
    mismatch = error instanceof StoreInvariantError
  }
  check('写入时 projectId 不符被拒绝', mismatch)
}

console.log('\n-- B5: 审计日志哈希链 --')
{
  const root = await makeProject()
  const store = new MetacogStore(root, '.metacog')
  await store.initialize('p1', [goal('L0_root', { level: 'L0' })], [])

  await store.commit('p1', {
    expectedVersion: 0,
    goals: [goal('L0_root', { level: 'L0' })],
    contradictions: [],
    reason: 'confirmed',
    action: 'init_trees',
    actor: 'user_confirmed',
    targetIds: ['L0_root'],
    markConfirmed: true,
  })
  await store.commit('p1', {
    expectedVersion: 1,
    goals: [goal('L0_root', { level: 'L0', title: 'revised' })],
    contradictions: [],
    reason: 'l0 revised',
    action: 'update_l0',
    actor: 'user_confirmed',
    targetIds: ['L0_root'],
    evidence: ['user confirmed on 2026-10-27'],
  })

  const log = await store.readAuditLog('p1')
  checkEqual('审计条目数量', log.length, 2)
  checkEqual('创世记录 prevHash 为 GENESIS', log[0].prevHash, GENESIS_HASH)
  checkEqual('第二条 prevHash 链接第一条', log[1].prevHash, log[0].entryHash)
  checkEqual('beforeVersion 正确', log[1].beforeVersion, 1)
  checkEqual('afterVersion 正确', log[1].afterVersion, 2)
  checkEqual('action 正确', log[1].action, 'update_l0')
  checkEqual('actor 正确', log[1].actor, 'user_confirmed')

  const verification = await store.verifyAuditChain('p1')
  check('哈希链校验通过', verification.valid, verification.problems.join('; '))
  checkEqual('校验条目数', verification.entries, 2)

  const { entryHash, ...rest } = log[1]
  checkEqual('entryHash 可由字段复算', computeAuditHash(rest), entryHash)
}

console.log('\n-- B6: 审计日志防篡改检测 --')
{
  const root = await makeProject()
  const store = new MetacogStore(root, '.metacog')
  await store.initialize('p1', [goal('L0_root', { level: 'L0' })], [])
  await store.commit('p1', {
    expectedVersion: 0,
    goals: [goal('L0_root', { level: 'L0' })],
    contradictions: [],
    reason: 'one',
    action: 'init_trees',
    actor: 'user_confirmed',
    targetIds: ['L0_root'],
    markConfirmed: true,
  })
  await store.commit('p1', {
    expectedVersion: 1,
    goals: [goal('L0_root', { level: 'L0', title: 'edited' })],
    contradictions: [],
    reason: 'two',
    action: 'update_l0',
    actor: 'user_confirmed',
    targetIds: ['L0_root'],
  })

  const auditPath = join(root, '.metacog', 'audit', 'p1.jsonl')
  const original = await readFile(auditPath, 'utf8')
  const lines = original.trim().split('\n')
  const tampered = JSON.parse(lines[0])
  tampered.reason = 'tampered reason'
  lines[0] = JSON.stringify(tampered)
  await writeFile(auditPath, `${lines.join('\n')}\n`, 'utf8')

  const verification = await store.verifyAuditChain('p1')
  check('篡改后校验失败', verification.valid === false)
  check(
    '问题定位到首条记录',
    verification.problems.some((p) => p.includes('entry 0')),
    verification.problems.join('; '),
  )
  check(
    '报告 entryHash 不匹配',
    verification.problems.some((p) => p.includes('entryHash')),
    verification.problems.join('; '),
  )
}

console.log('\n-- B7: 重启恢复（新实例读同一磁盘） --')
{
  const root = await makeProject()
  const first = new MetacogStore(root, '.metacog')
  await first.initialize('p1', [goal('L1_a')], [])
  await first.commit('p1', {
    expectedVersion: 0,
    goals: [goal('L1_a', { title: 'persisted' })],
    contradictions: [contradiction('C1')],
    reason: 'persist test',
    action: 'init_trees',
    actor: 'user_confirmed',
    targetIds: ['L1_a', 'C1'],
    markConfirmed: true,
  })

  // A fresh instance simulates plugin reload / process restart.
  const second = new MetacogStore(root, '.metacog')
  const state = await second.readState('p1')
  check('重启后版本保留', state.version === 1, String(state?.version))
  check('重启后目标标题保留', state.goals[0].title === 'persisted', state?.goals?.[0]?.title)
  check('重启后矛盾树保留', state.contradictions.length === 1)
  check('重启后确认态保留', state.confirmed === true)

  const snapshot = await second.readSnapshot('p1', 1)
  check('快照可读', snapshot !== undefined)
  checkEqual('快照绑定版本', snapshot.version, 1)
  checkEqual('快照含目标', snapshot.goals.length, 1)
  checkEqual('快照含矛盾', snapshot.contradictions.length, 1)

  const verification = await second.verifyAuditChain('p1')
  check('重启后审计链仍有效', verification.valid, verification.problems.join('; '))

  // CAS still works against recovered state.
  let conflict = false
  try {
    await second.commit('p1', {
      expectedVersion: 0,
      goals: [],
      contradictions: [],
      reason: 'stale after restart',
      action: 'update_lower_goal',
      actor: 'manual_tool',
      targetIds: [],
    })
  } catch (error) {
    conflict = error instanceof VersionConflictError
  }
  check('重启后过期版本仍被拦截', conflict)
}

console.log('\n-- B8: 快照版本历史留存 --')
{
  const root = await makeProject()
  const store = new MetacogStore(root, '.metacog')
  await store.initialize('p1', [goal('L1_a')], [])
  for (let index = 0; index < 3; index += 1) {
    await store.commit('p1', {
      expectedVersion: index,
      goals: [goal('L1_a', { title: `revision ${index}` })],
      contradictions: [],
      reason: `edit ${index}`,
      action: 'update_lower_goal',
      actor: 'manual_tool',
      targetIds: ['L1_a'],
    })
  }
  const current = await store.readState('p1')
  checkEqual('当前版本为 3', current.version, 3)

  const v1 = await store.readSnapshot('p1', 1)
  check('旧版本快照仍可读', v1 !== undefined)
  checkEqual('v1 保留当时的标题', v1.goals[0].title, 'revision 0')
  const v3 = await store.readSnapshot('p1', 3)
  checkEqual('v3 为最新内容', v3.goals[0].title, 'revision 2')
  checkEqual('不存在的版本返回 undefined', await store.readSnapshot('p1', 99), undefined)
}

console.log('\n-- B9: 观察流、干预流与报告持久化 --')
{
  const root = await makeProject()
  const store = new MetacogStore(root, '.metacog')
  await store.initialize('p1', [goal('L1_a')], [contradiction('C1')])

  const base = Date.now()
  for (let index = 0; index < 3; index += 1) {
    await store.appendObservation('p1', {
      id: `obs${index}`,
      projectId: 'p1',
      sessionId: 's1',
      contradictionId: 'C1',
      observedAt: new Date(base + index * 60_000).toISOString(),
      intensity: 4 - index,
      computedTrend: 'unknown',
      evidence: [`evidence-${index}`],
      confidence: 0.8,
      rationale: '',
    })
  }
  const observations = await store.readObservations('p1')
  checkEqual('观察记录数量', observations.length, 3)
  const recent = await store.readObservations('p1', { since: new Date(base + 90_000) })
  checkEqual('since 过滤生效', recent.length, 1)

  // Intervention versions: pending then resolved → latest wins.
  const createdAt = new Date().toISOString()
  await store.appendIntervention('p1', {
    id: 'iv1',
    projectId: 'p1',
    signalId: 'sig1',
    level: 2,
    status: 'pending',
    promptSummary: 'check alignment',
    suggestedActions: ['continue'],
    createdAt,
  })
  await store.appendIntervention('p1', {
    id: 'iv1',
    projectId: 'p1',
    signalId: 'sig1',
    level: 2,
    status: 'resolved',
    promptSummary: 'check alignment',
    suggestedActions: ['continue'],
    decision: 'realign',
    rationale: 'user chose to realign',
    createdAt,
    decidedAt: new Date().toISOString(),
  })
  const interventions = await store.readInterventions('p1')
  checkEqual('干预去重为最新版本', interventions.length, 1)
  checkEqual('最新状态为 resolved', interventions[0].status, 'resolved')
  checkEqual('保留用户决策', interventions[0].decision, 'realign')

  await store.appendReport('p1', {
    id: 'r1',
    projectId: 'p1',
    type: 'daily',
    generatedAt: new Date().toISOString(),
    periodStart: new Date(base).toISOString(),
    periodEnd: new Date(base + 86_400_000).toISOString(),
    goalTreeVersion: 0,
    observationIds: ['obs0', 'obs1'],
    signalIds: [],
    interventionIds: ['iv1'],
    markdown: '# daily',
  })
  const reports = await store.readReports('p1')
  checkEqual('报告已持久化', reports.length, 1)
  checkEqual('报告绑定生成时版本', reports[0].goalTreeVersion, 0)
}

console.log('\n-- B10: 损坏文件被显式拒绝而非静默重置 --')
{
  const root = await makeProject()
  const store = new MetacogStore(root, '.metacog')
  await store.initialize('p1', [goal('L1_a')], [])
  await mkdir(join(root, '.metacog', 'state'), { recursive: true })
  await writeFile(join(root, '.metacog', 'state', 'p1.json'), '{ not json', 'utf8')

  let caught
  try {
    await store.readState('p1')
  } catch (error) {
    caught = error
  }
  check('损坏 JSON 抛 StoreInvariantError', caught instanceof StoreInvariantError, String(caught))
  check(
    '错误信息指出损坏路径',
    String(caught?.message).includes('corrupt JSON'),
    String(caught?.message),
  )
}

console.log('\n-- B11: 无状态项目提交被拒绝 --')
{
  const root = await makeProject()
  const store = new MetacogStore(root, '.metacog')
  let caught
  try {
    // Version 0 is a legitimate first commit (derivation confirms directly,
    // without writing an intermediate draft). A non-zero version against a
    // project with no tree is the conflict worth guarding.
    await store.commit('never-initialised', {
      expectedVersion: 3,
      goals: [],
      contradictions: [],
      reason: 'x',
      action: 'init_trees',
      actor: 'system_auto',
      targetIds: [],
    })
  } catch (error) {
    caught = error
  }
  // A project with no tree accepts only expectedVersion 0 as its first commit;
  // any other version is a conflict, not an invariant violation.
  check('未初始化项目提交被拒绝', caught instanceof VersionConflictError, String(caught))
}

// Cleanup every temporary project root created above.
for (const dir of temporaries) {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n=== Stage B 结果: ${passed} passed, ${failed} failed ===`)
process.exitCode = failed === 0 ? 0 : 1
