/**
 * 干预卡的功能验证：决策落盘、同类卡片让位、审计留痕、Level 3 门随状态解除。
 *
 * 起因：真实工作区里三张卡有两张已决策，第三张（glob 误判）一直挂着。
 * 需要证明 `resolve_intervention` 不只是写个字段，而是把整条链都走完：
 * 决策 → 同类卡片 superseded → 审计 → 回读 Level 3 门。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChecker, libUrl } from './_harness.mjs'

/** A path inside `lib/`, resolved relative to this checkout. */
const lib = (p) => libUrl('lib', p)
const { check, counts, exit } = createChecker()
const { apply } = await import(lib('index.js'))
const { MetacogStore } = await import(lib('data/store.js'))
const { deriveProjectId } = await import(lib('tools/shared.js'))



function createHost(root) {
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
  return { ctx, tools }
}

const root = await mkdtemp(join(tmpdir(), 'metacog-intervention-'))
try {
  await writeFile(join(root, 'README.md'), '# 干预卡验证\n')
  const { tools } = createHost(root)
  const call = (name, args) =>
    tools.get(name).execute(args, {
      callId: `c-${Math.random().toString(16).slice(2)}`,
      name,
      arguments: args,
      signal: new AbortController().signal,
      agent: { id: 'intervention-test' },
    })

  const store = new MetacogStore(root, '.metacog')
  const projectId = deriveProjectId(root)

  console.log('\n=== 准备：一棵确认树 + 一条矛盾 ===')
  const confirmed = await call('goal_tree_confirm', {
    expectedVersion: 0,
    l0: { title: '干预卡验证的根目标', evidence: ['README.md'] },
    goals: [],
    contradictions: [
      {
        title: '严格性 vs 速度',
        poleA: '严格',
        poleB: '快',
        evidence: ['README.md'],
        primaryGoalRef: '干预卡验证的根目标',
        type: 'main',
      },
    ],
    reason: '干预卡验证基线',
  })
  check('树已确认', confirmed.ok === true, JSON.stringify(confirmed).slice(0, 200))
  const tree = await call('goal_tree_view', {})
  const contradictionId =
    tree.data?.contradictions?.[0]?.id ?? tree.data?.tree?.contradictions?.[0]?.id
  check('能读到矛盾 id', typeof contradictionId === 'string', JSON.stringify(tree).slice(0, 400))

  /** 直接落一条信号 + 一张干预卡，绕开判定层，只验决策链。 */
  const seedCard = async (suffix, level, contradictionIds) => {
    const signalId = `sig_test_${suffix}`
    const interventionId = `iv_test_${suffix}`
    await store.appendSignal(projectId, {
      id: signalId,
      projectId,
      observedAt: new Date().toISOString(),
      monitorCategory: 'goal_alignment',
      signalType: 'scope_drift',
      level,
      relatedGoalIds: [],
      relatedContradictionIds: contradictionIds,
      summary: `测试信号 ${suffix}`,
      evidence: [],
      grade: 'A',
      confidence: 1,
      source: 'manual',
      alignment: 'scope_drift',
    })
    await store.appendIntervention(projectId, {
      id: interventionId,
      projectId,
      sessionId: 'test-session',
      signalId,
      level,
      status: 'pending',
      promptSummary: `测试干预卡 ${suffix}`,
      suggestedActions: ['continue', 'realign', 'modify_goals', 'dismiss'],
      createdAt: new Date().toISOString(),
    })
    return { signalId, interventionId }
  }

  console.log('\n=== 参数校验 ===')
  const a = await seedCard('a', 2, [contradictionId])
  const missingId = await call('resolve_intervention', {
    decision: 'dismiss',
    rationale: '缺 id',
  })
  check('缺 interventionId 被拒', missingId.ok === false, JSON.stringify(missingId).slice(0, 160))

  const badDecision = await call('resolve_intervention', {
    interventionId: a.interventionId,
    decision: 'ignore',
    rationale: '非法决策',
  })
  check('非法 decision 被拒', badDecision.ok === false, JSON.stringify(badDecision).slice(0, 160))

  const noReason = await call('resolve_intervention', {
    interventionId: a.interventionId,
    decision: 'dismiss',
    rationale: '   ',
  })
  check('空 rationale 被拒', noReason.ok === false, JSON.stringify(noReason).slice(0, 160))
  check(
    '拒绝理由指向 REASON_REQUIRED',
    String(JSON.stringify(noReason)).includes('REASON_REQUIRED') ||
      String(JSON.stringify(noReason)).includes('rationale'),
    JSON.stringify(noReason).slice(0, 200),
  )

  const unknown = await call('resolve_intervention', {
    interventionId: 'iv_does_not_exist',
    decision: 'dismiss',
    rationale: '不存在的卡',
  })
  check('未知卡片被拒', unknown.ok === false, JSON.stringify(unknown).slice(0, 160))

  const stillPending = await store.readInterventions(projectId)
  check(
    '校验失败没有改动记录',
    stillPending.filter((r) => r.id === a.interventionId).length === 1 &&
      stillPending.find((r) => r.id === a.interventionId).status === 'pending',
    JSON.stringify(stillPending.map((r) => [r.id, r.status])),
  )

  console.log('\n=== 正常决策：dismiss ===')
  const dismissed = await call('resolve_intervention', {
    interventionId: a.interventionId,
    decision: 'dismiss',
    rationale: '测试用：该信号为采集缺陷导致的误判',
  })
  check('决策成功', dismissed.ok === true, JSON.stringify(dismissed).slice(0, 240))
  const dv = dismissed.data ?? {}
  check('status 为 resolved', dv.status === 'resolved', String(dv.status))
  check('decision 回显 dismiss', dv.decision === 'dismiss', String(dv.decision))
  check('rationale 回显', String(dv.rationale).includes('采集缺陷'), String(dv.rationale))
  check('decidedAt 是 ISO 时间', /^\d{4}-\d{2}-\d{2}T/.test(String(dv.decidedAt)), String(dv.decidedAt))
  check('返回审计条目 id', typeof dv.auditEntryId === 'string' && dv.auditEntryId.length > 0, String(dv.auditEntryId))
  check(
    '明说树未被改动',
    String(dv.treeUnchanged).includes('not modified'),
    String(dv.treeUnchanged),
  )

  const replay = await store.readInterventions(projectId)
  const replayTarget = replay.find((r) => r.id === a.interventionId)
  check('落盘后 status 为 resolved', replayTarget.status === 'resolved', replayTarget.status)
  check('落盘后带 decision', replayTarget.decision === 'dismiss', String(replayTarget.decision))
  check('落盘后带 decidedAt', typeof replayTarget.decidedAt === 'string', String(replayTarget.decidedAt))

  const again = await call('resolve_intervention', {
    interventionId: a.interventionId,
    decision: 'continue',
    rationale: '重复决策应当被拒',
  })
  check('重复决策被拒', again.ok === false, JSON.stringify(again).slice(0, 200))
  check(
    '拒绝理由是 NOT_PENDING',
    String(JSON.stringify(again)).includes('NOT_PENDING'),
    JSON.stringify(again).slice(0, 200),
  )

  console.log('\n=== 审计链 ===')
  const auditRaw = await readFile(join(root, '.metacog', 'audit', `${projectId}.jsonl`), 'utf8')
  const auditLines = auditRaw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  const resolveEntry = auditLines.find((e) => e.id === dv.auditEntryId)
  check('审计里有该条目', resolveEntry !== undefined, String(dv.auditEntryId))
  check('审计 action 正确', resolveEntry?.action === 'resolve_intervention', String(resolveEntry?.action))
  check('审计 actor 为 user_confirmed', resolveEntry?.actor === 'user_confirmed', String(resolveEntry?.actor))
  check(
    '审计 targetIds 指向该卡',
    Array.isArray(resolveEntry?.targetIds) && resolveEntry.targetIds.includes(a.interventionId),
    JSON.stringify(resolveEntry?.targetIds),
  )
  check(
    '审计 reason 含决策与理由',
    String(resolveEntry?.reason).includes('dismiss') && String(resolveEntry?.reason).includes('采集缺陷'),
    String(resolveEntry?.reason),
  )

  console.log('\n=== 同类卡片让位 ===')
  const b = await seedCard('b', 2, [contradictionId])
  const c = await seedCard('c', 2, [contradictionId])
  const superseding = await call('resolve_intervention', {
    interventionId: b.interventionId,
    decision: 'realign',
    rationale: '测试用：同类卡片一并结案',
  })
  check('决策成功', superseding.ok === true, JSON.stringify(superseding).slice(0, 240))
  const supersededIds = superseding.data?.supersededIds ?? []
  check('返回被顶替的卡片', supersededIds.includes(c.interventionId), JSON.stringify(supersededIds))

  const afterSupersede = await store.readInterventions(projectId)
  const cardC = afterSupersede.find((r) => r.id === c.interventionId)
  check('同类卡片状态为 superseded', cardC?.status === 'superseded', String(cardC?.status))
  check('被顶替卡片没有 decision', cardC?.decision === undefined, String(cardC?.decision))

  console.log('\n=== Level 3 门 ===')
  const l3a = await seedCard('l3a', 3, [contradictionId])
  const pendingL3 = await store.readInterventions(projectId)
  const hasPendingL3 = pendingL3.some((r) => r.status === 'pending' && r.level === 3)
  check('存在待决 Level 3 卡', hasPendingL3 === true, JSON.stringify(pendingL3.map((r) => [r.id, r.status, r.level])))

  const l3resolve = await call('resolve_intervention', {
    interventionId: l3a.interventionId,
    decision: 'modify_goals',
    rationale: '测试用：结案后门应当落下',
  })
  check('Level 3 决策成功', l3resolve.ok === true, JSON.stringify(l3resolve).slice(0, 240))
  check(
    '结案后不再有待决 Level 3',
    l3resolve.data?.level3GateActive === false,
    String(l3resolve.data?.level3GateActive),
  )
  const afterL3 = await store.readInterventions(projectId)
  check(
    '落盘复核：无待决 Level 3',
    afterL3.some((r) => r.status === 'pending' && r.level === 3) === false,
    JSON.stringify(afterL3.map((r) => [r.id, r.status, r.level])),
  )

  console.log('\n=== 四种决策都可写入 ===')
  for (const decision of ['continue', 'realign', 'modify_goals', 'dismiss']) {
    const seeded = await seedCard(`d_${decision}`, 2, [])
    const out = await call('resolve_intervention', {
      interventionId: seeded.interventionId,
      decision,
      rationale: `测试用：验证 ${decision} 可写入`,
    })
    check(`decision=${decision} 被接受`, out.ok === true && out.data?.decision === decision, JSON.stringify(out).slice(0, 160))
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

exit()
