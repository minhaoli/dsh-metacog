/**
 * 修订接口与 Level 3 硬门禁的功能验证。
 *
 * 两件事各自独立、互不依赖，但都属于"程序把住状态"这一条：
 * - `metacog_revise` 是树在确认之后唯一的合法变更通道，七种 kind 必须都能落地，
 *   且每一次都要走 CAS 与审计；没有任何一条能靠"猜"改到树。
 * - `gate.evaluateCall` 是 Level 3 卡片的硬拦截，它只在配置开启时真的拒绝，
 *   关闭时只影子计数；只读工具与 monitor 自己的决策工具永不被拦。
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
const { evaluateCall, installGate } = await import(lib('gate.js'))
const { applyRevisions } = await import(lib('analysis/revise.js'))



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

const root = await mkdtemp(join(tmpdir(), 'metacog-revise-gate-'))
try {
  await writeFile(join(root, 'README.md'), '# 修订与门禁验证\n')
  const { ctx, tools } = createHost(root)
  const call = (name, args) =>
    tools.get(name).execute(args, {
      callId: `c-${Math.random().toString(16).slice(2)}`,
      name,
      arguments: args,
      signal: new AbortController().signal,
      agent: { id: 'revise-gate-test' },
    })

  const store = new MetacogStore(root, '.metacog')
  const projectId = deriveProjectId(root)

  console.log('\n=== 准备：一棵两层树 + 一条 main 矛盾 ===')
  const confirmed = await call('goal_tree_confirm', {
    expectedVersion: 0,
    l0: { title: '修订验证的根目标', evidence: ['README.md'] },
    goals: [
      { title: '甲目标', evidence: ['README.md'], depth: 1 },
      { title: '乙目标', evidence: ['README.md'], depth: 1 },
      { title: '丙子目标', evidence: ['README.md'], depth: 2, parentRef: '甲目标' },
    ],
    contradictions: [
      {
        title: '严格性 vs 速度',
        poleA: '严格',
        poleB: '快',
        evidence: ['README.md'],
        primaryGoalRef: '修订验证的根目标',
        type: 'main',
      },
    ],
    reason: '修订与门禁验证基线',
  })
  check('树已确认', confirmed.ok === true, JSON.stringify(confirmed).slice(0, 200))
  const v0 = confirmed.data?.version
  check('确认后版本为 1', v0 === 1, String(v0))

  const tree = await call('goal_tree_view', {})
  const contradictions = tree.data?.contradictions ?? []
  const contradictionId = contradictions[0]?.id
  check('能读到矛盾 id', typeof contradictionId === 'string', JSON.stringify(tree).slice(0, 300))
  const goalList = tree.data?.goals ?? []
  const goalIds = new Map(goalList.map((g) => [g.title, g.id]))
  check('能读到三个目标 id', goalIds.size === 4, JSON.stringify([...goalIds.keys()]))

  console.log('\n=== 修订的前置校验 ===')
  const noVersion = await call('metacog_revise', {
    reason: '缺版本',
    revisions: [{ kind: 'goal_achieved', target: '甲目标' }],
  })
  check('缺 expectedVersion 被拒', noVersion.ok === false, JSON.stringify(noVersion).slice(0, 160))
  check(
    '拒绝理由是 INVALID_ARGS',
    String(JSON.stringify(noVersion)).includes('INVALID_ARGS'),
    JSON.stringify(noVersion).slice(0, 200),
  )

  const noReason = await call('metacog_revise', {
    expectedVersion: v0,
    reason: '   ',
    revisions: [{ kind: 'goal_achieved', target: '甲目标' }],
  })
  check('空 reason 被拒', noReason.ok === false, JSON.stringify(noReason).slice(0, 160))
  check(
    '拒绝理由是 REASON_REQUIRED',
    String(JSON.stringify(noReason)).includes('REASON_REQUIRED'),
    JSON.stringify(noReason).slice(0, 200),
  )

  const emptyRevisions = await call('metacog_revise', {
    expectedVersion: v0,
    reason: '空批次',
    revisions: [],
  })
  check('空 revisions 被拒', emptyRevisions.ok === false, JSON.stringify(emptyRevisions).slice(0, 160))

  const afterRejects = await call('goal_tree_view', {})
  check('校验失败没有升版本', afterRejects.data?.version === v0, String(afterRejects.data?.version))

  console.log('\n=== 七种 kind 逐一落地 ===')
  let version = v0

  // 1. goal_changed
  const changed = await call('metacog_revise', {
    expectedVersion: version,
    reason: '测试用：目标改名',
    revisions: [{ kind: 'goal_changed', target: '乙目标', newTitle: '乙目标（改名）', newDescription: '改过的描述' }],
  })
  check('goal_changed 成功', changed.ok === true, JSON.stringify(changed).slice(0, 240))
  check('goal_changed 升版本', changed.data?.version === version + 1, String(changed.data?.version))
  check(
    'goal_changed 报告改动 id',
    changed.data?.changedGoalIds?.includes(goalIds.get('乙目标')),
    JSON.stringify(changed.data?.changedGoalIds),
  )
  version = changed.data?.version
  const afterRename = await call('goal_tree_view', {})
  const renamed = (afterRename.data?.goals ?? []).find((g) => g.title === '乙目标（改名）')
  check('改名已落盘', renamed !== undefined, JSON.stringify((afterRename.data?.goals ?? []).map((g) => g.title)))
  check('描述已落盘', renamed?.description === '改过的描述', String(renamed?.description))

  // A description-only edit must not read "改为「(未改名)」": that phrasing makes
  // a successful edit look like a failure, and it was what the real tree showed.
  const descOnly = await call('metacog_revise', {
    expectedVersion: version,
    reason: '测试用：只改描述',
    revisions: [{ kind: 'goal_changed', target: '乙目标（改名）', newDescription: '只改描述，不动标题' }],
  })
  check('只改描述成功', descOnly.ok === true, JSON.stringify(descOnly).slice(0, 240))
  check(
    '只改描述不说「(未改名)」',
    String(descOnly.data?.applied?.[0] ?? '').includes('描述已更新') &&
      !String(descOnly.data?.applied?.[0] ?? '').includes('未改名'),
    String(descOnly.data?.applied?.[0]),
  )
  version = descOnly.data?.version
  const afterDescOnly = await call('goal_tree_view', {})
  check(
    '只改描述时标题未变',
    (afterDescOnly.data?.goals ?? []).find((g) => g.title === '乙目标（改名）') !== undefined,
    JSON.stringify((afterDescOnly.data?.goals ?? []).map((g) => g.title)),
  )

  // 2. goal_achieved
  const achieved = await call('metacog_revise', {
    expectedVersion: version,
    reason: '测试用：目标达成',
    revisions: [{ kind: 'goal_achieved', target: '乙目标（改名）' }],
  })
  check('goal_achieved 成功', achieved.ok === true, JSON.stringify(achieved).slice(0, 240))
  version = achieved.data?.version
  const afterAchieved = await call('goal_tree_view', {})
  const doneGoal = (afterAchieved.data?.goals ?? []).find((g) => g.title === '乙目标（改名）')
  check('状态变为 done', doneGoal?.status === 'done', String(doneGoal?.status))

  // 3. goal_shelved
  const shelved = await call('metacog_revise', {
    expectedVersion: version,
    reason: '测试用：目标暂停',
    revisions: [{ kind: 'goal_shelved', target: '丙子目标' }],
  })
  check('goal_shelved 成功', shelved.ok === true, JSON.stringify(shelved).slice(0, 240))
  version = shelved.data?.version
  const afterShelved = await call('goal_tree_view', {})
  const blockedGoal = (afterShelved.data?.goals ?? []).find((g) => g.title === '丙子目标')
  check('状态变为 blocked', blockedGoal?.status === 'blocked', String(blockedGoal?.status))

  // 4. contradiction_intensified
  const intensified = await call('metacog_revise', {
    expectedVersion: version,
    reason: '测试用：矛盾加剧',
    revisions: [{ kind: 'contradiction_intensified', target: contradictionId, intensity: 4 }],
  })
  check('contradiction_intensified 成功', intensified.ok === true, JSON.stringify(intensified).slice(0, 240))
  version = intensified.data?.version
  const afterIntensified = await call('goal_tree_view', {})
  const tension = (afterIntensified.data?.contradictions ?? []).find((c) => c.id === contradictionId)
  check('强度已写入', tension?.intensity === 4, String(tension?.intensity))
  check(
    'intensityEdited 反映手改值',
    tension?.intensityEdited === 4,
    String(tension?.intensityEdited),
  )

  // 5. contradiction_added
  const added = await call('metacog_revise', {
    expectedVersion: version,
    reason: '测试用：新增矛盾',
    revisions: [
      {
        kind: 'contradiction_added',
        create: {
          title: '覆盖 vs 完整',
          poleA: '覆盖',
          poleB: '完整',
          primaryGoalRef: '甲目标',
          type: 'secondary',
          consequence: '加测试会拖慢交付',
          rationale: '测试要花钱，交付也要花钱，这条张力不会因为更努力就消失',
          evidence: ['README.md'],
        },
      },
    ],
  })
  check('contradiction_added 成功', added.ok === true, JSON.stringify(added).slice(0, 240))
  version = added.data?.version
  const newContradictionId = added.data?.changedContradictionIds?.[0]
  check('返回新矛盾 id', typeof newContradictionId === 'string', String(newContradictionId))
  const afterAdded = await call('goal_tree_view', {})
  const addedNode = (afterAdded.data?.contradictions ?? []).find((c) => c.id === newContradictionId)
  check('新矛盾已落盘', addedNode?.title === '覆盖 vs 完整', String(addedNode?.title))
  check('新矛盾挂到甲目标', addedNode?.primaryGoalId === goalIds.get('甲目标'), String(addedNode?.primaryGoalId))
  check('新矛盾类型为 secondary', addedNode?.type === 'secondary', String(addedNode?.type))
  check('consequence 落进 description', addedNode?.description === '加测试会拖慢交付', String(addedNode?.description))
  check(
    'rationale 独立落盘，不复制 consequence',
    addedNode?.rationale === '测试要花钱，交付也要花钱，这条张力不会因为更努力就消失',
    String(addedNode?.rationale),
  )
  check(
    'description 与 rationale 不是同一句',
    addedNode?.description !== addedNode?.rationale,
    `${addedNode?.description} === ${addedNode?.rationale}`,
  )

  // 6. contradiction_resolved
  const resolved = await call('metacog_revise', {
    expectedVersion: version,
    reason: '测试用：矛盾已解决',
    revisions: [
      { kind: 'contradiction_resolved', target: newContradictionId, newDescription: '已用分层测试解决' },
    ],
  })
  check('contradiction_resolved 成功', resolved.ok === true, JSON.stringify(resolved).slice(0, 240))
  version = resolved.data?.version
  const afterResolved = await call('goal_tree_view', {})
  const resolvedNode = (afterResolved.data?.contradictions ?? []).find((c) => c.id === newContradictionId)
  check('已解决矛盾强度降到 1', resolvedNode?.intensity === 1, String(resolvedNode?.intensity))
  check(
    '已解决矛盾保留节点（未删除）',
    resolvedNode !== undefined,
    JSON.stringify((afterResolved.data?.contradictions ?? []).map((c) => c.title)),
  )

  // 7. root_changed
  const rootChanged = await call('metacog_revise', {
    expectedVersion: version,
    reason: '测试用：根目标改述',
    revisions: [{ kind: 'root_changed', newTitle: '修订验证的根目标（改述）', newDescription: '新的根描述' }],
  })
  check('root_changed 成功', rootChanged.ok === true, JSON.stringify(rootChanged).slice(0, 240))
  version = rootChanged.data?.version
  const afterRoot = await call('goal_tree_view', {})
  const rootNode = (afterRoot.data?.goals ?? []).find((g) => g.depth === 0)
  check('根目标改名落盘', rootNode?.title === '修订验证的根目标（改述）', String(rootNode?.title))
  check('根目标描述落盘', rootNode?.description === '新的根描述', String(rootNode?.description))

  console.log('\n=== 批次语义 ===')
  const mixed = await call('metacog_revise', {
    expectedVersion: version,
    reason: '测试用：好目标与坏目标同批',
    revisions: [
      { kind: 'goal_achieved', target: '甲目标' },
      { kind: 'goal_achieved', target: '不存在的目标' },
    ],
  })
  check('含坏目标的批次仍成功', mixed.ok === true, JSON.stringify(mixed).slice(0, 240))
  check(
    '坏目标进 skipped 而非抛错',
    Array.isArray(mixed.data?.skipped) && mixed.data.skipped.length === 1,
    JSON.stringify(mixed.data?.skipped),
  )
  check('好目标照常应用', mixed.data?.changedGoalIds?.length === 1, JSON.stringify(mixed.data?.changedGoalIds))
  version = mixed.data?.version

  const nothingMatched = await call('metacog_revise', {
    expectedVersion: version,
    reason: '测试用：一个都匹配不上',
    revisions: [{ kind: 'goal_achieved', target: '也不存在的目标' }],
  })
  check('全部未匹配时 ok 仍为 true', nothingMatched.ok === true, JSON.stringify(nothingMatched).slice(0, 200))
  check('全部未匹配时不升版本', nothingMatched.data?.version === version, String(nothingMatched.data?.version))
  check('全部未匹配时 auditEntryId 为空', nothingMatched.data?.auditEntryId === '', String(nothingMatched.data?.auditEntryId))

  console.log('\n=== 版本 CAS ===')
  const stale = await call('metacog_revise', {
    expectedVersion: 1,
    reason: '测试用：用过期版本改树',
    revisions: [{ kind: 'goal_achieved', target: '甲目标' }],
  })
  check('过期版本被拒', stale.ok === false, JSON.stringify(stale).slice(0, 200))
  check(
    '拒绝理由是 VERSION_CONFLICT',
    String(JSON.stringify(stale)).includes('VERSION_CONFLICT'),
    JSON.stringify(stale).slice(0, 240),
  )

  console.log('\n=== 审计链 ===')
  const auditRaw = await readFile(join(root, '.metacog', 'audit', `${projectId}.jsonl`), 'utf8')
  const auditLines = auditRaw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  // 一次确认 + 九次成功的修订（七种 kind 各一次，加上只改描述的一次，
  // 以及混合批次里成功的那一条）。批次里"全部未匹配"的那次不提交，所以不留痕：
  // 审计只记录真的发生过的结构变更，否则日志会声称一次从未发生的修订。
  check('审计条目数等于确认加九次修订', auditLines.length === 10, String(auditLines.length))
  check('每条审计都有 prevHash 字段', auditLines.every((e) => 'prevHash' in e), 'missing prevHash')
  let chainOk = auditLines[0]?.prevHash === 'GENESIS'
  for (let i = 1; i < auditLines.length; i += 1) {
    if (auditLines[i].prevHash !== auditLines[i - 1].entryHash) chainOk = false
  }
  check('prevHash 串成一条链', chainOk, JSON.stringify(auditLines.map((e) => [e.prevHash, e.entryHash])))
  check('审计 actor 全为 user_confirmed', auditLines.every((e) => e.actor === 'user_confirmed'), 'actor mismatch')

  // The action label has to distinguish a root rewrite from a lower-goal edit
  // from a contradiction change. Hard-coding `update_lower_goal` for every
  // revision made the log unable to answer "what was actually changed".
  const actions = auditLines.map((e) => e.action)
  check(
    '改根目标记 update_l0',
    actions.includes('update_l0'),
    JSON.stringify(actions),
  )
  check(
    '改矛盾记 reclassify_contradiction',
    actions.includes('reclassify_contradiction'),
    JSON.stringify(actions),
  )
  check(
    '解决矛盾记 resolve_intervention',
    actions.includes('resolve_intervention'),
    JSON.stringify(actions),
  )
  check(
    '改下层目标记 update_l1',
    actions.includes('update_l1'),
    JSON.stringify(actions),
  )
  check(
    '不是所有修订都记成同一个动作',
    new Set(actions).size >= 3,
    JSON.stringify([...new Set(actions)]),
  )
  const viewAfter = await call('goal_tree_view', {})
  check('goal_tree_view 报告审计链有效', viewAfter.data?.audit?.valid === true, JSON.stringify(viewAfter.data?.audit))
  check('审计条目数与视图一致', viewAfter.data?.audit?.entries === auditLines.length, String(viewAfter.data?.audit?.entries))
  check('版本与最后一条修订一致', viewAfter.data?.version === version, `${viewAfter.data?.version} vs ${version}`)

  console.log('\n=== 纯函数层：applyRevisions 不修改输入 ===')
  const state = await store.readState(projectId)
  const beforeTitle = state.goals[0].title
  const snapshot = JSON.stringify(state)
  applyRevisions(state, [{ kind: 'goal_changed', target: state.goals[0].id, newTitle: '不该生效' }], new Date().toISOString())
  check('输入 state 未被改写', JSON.stringify(state) === snapshot, 'state mutated')
  check('输入 state 标题未变', state.goals[0].title === beforeTitle, state.goals[0].title)

  console.log('\n=== Level 3 硬门禁 ===')
  const seedCard = async (suffix, level) => {
    const signalId = `sig_gate_${suffix}`
    const interventionId = `iv_gate_${suffix}`
    await store.appendSignal(projectId, {
      id: signalId,
      projectId,
      observedAt: new Date().toISOString(),
      monitorCategory: 'goal_alignment',
      signalType: 'scope_drift',
      level,
      relatedGoalIds: [],
      relatedContradictionIds: [],
      summary: `门禁测试信号 ${suffix}`,
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
      promptSummary: `门禁测试卡 ${suffix}`,
      suggestedActions: ['continue', 'realign', 'modify_goals', 'dismiss'],
      createdAt: new Date().toISOString(),
    })
    return { signalId, interventionId }
  }

  const storeForSession = async (sessionId) =>
    sessionId === 'gate-session' ? { store, projectId } : undefined
  const armedOptions = {
    ctx,
    config: { gate: { level3HardBlock: true, neverBlocked: ['resolve_intervention'] } },
    storeForSession,
  }
  const shadowOptions = {
    ctx,
    config: { gate: { level3HardBlock: false, neverBlocked: ['resolve_intervention'] } },
    storeForSession,
  }
  const gateCall = (name) => ({ name, arguments: {}, agent: { id: 'gate-session' } })

  // 没有待决 L3 时一律放行
  const noL3 = await evaluateCall(gateCall('write'), armedOptions)
  check('无待决 L3 时放行', noL3.decision.kind === 'allow', JSON.stringify(noL3))

  const l3 = await seedCard('l3', 3)
  const blocked = await evaluateCall(gateCall('write'), armedOptions)
  check('有待决 L3 时拒绝写工具', blocked.decision.kind === 'deny', JSON.stringify(blocked))
  check('门禁开启时不走影子', blocked.shadow === false, String(blocked.shadow))
  check(
    '拒绝理由点名卡片 id',
    String(blocked.decision.reason).includes(l3.interventionId),
    String(blocked.decision.reason),
  )
  check(
    '拒绝理由提示用 resolve_intervention',
    String(blocked.decision.reason).includes('resolve_intervention'),
    String(blocked.decision.reason),
  )

  const readAllowed = await evaluateCall(gateCall('read'), armedOptions)
  check('只读工具不被拦', readAllowed.decision.kind === 'allow', JSON.stringify(readAllowed))

  const decisionAllowed = await evaluateCall(gateCall('resolve_intervention'), armedOptions)
  check('决策工具本身不被拦', decisionAllowed.decision.kind === 'allow', JSON.stringify(decisionAllowed))

  const shadowed = await evaluateCall(gateCall('write'), shadowOptions)
  check('门禁关闭时仍返回 deny 判定', shadowed.decision.kind === 'deny', JSON.stringify(shadowed))
  check('门禁关闭时标记为影子', shadowed.shadow === true, String(shadowed.shadow))

  const unknownSession = await evaluateCall(
    { name: 'write', arguments: {}, agent: { id: 'not-a-metacog-session' } },
    armedOptions,
  )
  check('不属于本项目的会话不拦', unknownSession.decision.kind === 'allow', JSON.stringify(unknownSession))

  const noAgent = await evaluateCall({ name: 'write', arguments: {} }, armedOptions)
  check('没有 agent 时不拦', noAgent.decision.kind === 'allow', JSON.stringify(noAgent))

  const l2 = await seedCard('l2', 2)
  const l2Allowed = await evaluateCall(gateCall('write'), armedOptions)
  check('Level 2 卡片不硬拦', l2Allowed.decision.kind === 'deny' && String(l2Allowed.decision.reason).includes(l3.interventionId), JSON.stringify(l2Allowed).slice(0, 200))
  check('Level 2 卡片未被当成拦截理由', !String(l2Allowed.decision.reason).includes(l2.interventionId), String(l2Allowed.decision.reason))

  console.log('\n=== 门禁安装与统计 ===')
  const offArmed = installGate(armedOptions)
  check('安装后 armed 为 true', offArmed.stats.armed === true, String(offArmed.stats.armed))
  offArmed.dispose()
  const offShadow = installGate(shadowOptions)
  check('配置关闭时 armed 为 false', offShadow.stats.armed === false, String(offShadow.stats.armed))
  offShadow.dispose()

  console.log('\n=== 结案后门自动落下 ===')
  const decided = await call('resolve_intervention', {
    interventionId: l3.interventionId,
    decision: 'continue',
    rationale: '测试用：结案后门应当落下',
  })
  check('Level 3 决策成功', decided.ok === true, JSON.stringify(decided).slice(0, 240))
  const afterDecision = await evaluateCall(gateCall('write'), armedOptions)
  check('结案后写工具恢复放行', afterDecision.decision.kind === 'allow', JSON.stringify(afterDecision))

  const stillL2 = await evaluateCall(gateCall('write'), armedOptions)
  check('仅剩 Level 2 时不拦', stillL2.decision.kind === 'allow', JSON.stringify(stillL2))
} finally {
  await rm(root, { recursive: true, force: true })
}

exit()
