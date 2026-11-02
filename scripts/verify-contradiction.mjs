/**
 * `contradiction_tree_edit` 与 `contradiction_observe` 的验证。
 *
 * 两者各管一半的"矛盾怎么变"：编辑工具改节点本身，观察工具只往时间序列里
 * 追加读数、由程序算出趋势。分开是为了让"状态"和"证据"永远不混在一处。
 *
 * 这里重点盯住真机上暴露的三处审计缺陷：
 * - 改 main/secondary 矛盾被记成 `update_lower_goal`（那是改目标的动作名）；
 * - 新增矛盾同样被记成 `update_lower_goal`；
 * - 删除矛盾在返回值和审计里完全不可见。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createChecker, libUrl, mountHost } from './_harness.mjs'

const { apply } = await import(libUrl('lib', 'index.js'))
const { MetacogStore } = await import(libUrl('lib', 'data/store.js'))
const { deriveProjectId } = await import(libUrl('lib', 'tools/shared.js'))

const { check, exit } = createChecker()

const root = await mkdtemp(join(tmpdir(), 'metacog-contradiction-'))
try {
  await writeFile(join(root, 'README.md'), '# 矛盾编辑验证\n')
  const { tools } = mountHost(apply, root)
  const call = (name, args) =>
    tools.get(name).execute(args, {
      callId: `c-${Math.random().toString(16).slice(2)}`,
      name,
      arguments: args,
      signal: new AbortController().signal,
      agent: { id: 'contradiction-test' },
    })

  const store = new MetacogStore(root, '.metacog')
  const projectId = deriveProjectId(root)

  console.log('\n=== 准备：一棵树 + core / main / secondary 三条矛盾 ===')
  const confirmed = await call('goal_tree_confirm', {
    expectedVersion: 0,
    l0: { title: '矛盾编辑验证的根目标', evidence: ['README.md'] },
    goals: [{ title: '甲目标', evidence: ['README.md'], depth: 1 }],
    contradictions: [
      {
        title: '核心张力',
        poleA: 'A',
        poleB: 'B',
        evidence: ['README.md'],
        primaryGoalRef: '矛盾编辑验证的根目标',
        type: 'core',
        // A core contradiction is a structural diagnosis, so the tool demands a
        // rationale explaining how it follows from L0. Omitting it fails the
        // whole confirm, not just this node.
        rationale: '根目标要求可审计，这隐含判断权与写入权必须分离，因此这是结构性的',
      },
      {
        title: '主要张力',
        poleA: 'C',
        poleB: 'D',
        evidence: ['README.md'],
        primaryGoalRef: '甲目标',
        type: 'main',
      },
      {
        title: '次要张力',
        poleA: 'E',
        poleB: 'F',
        evidence: ['README.md'],
        primaryGoalRef: '甲目标',
        type: 'secondary',
      },
    ],
    reason: '矛盾编辑验证基线',
  })
  check('树已确认', confirmed.ok === true, JSON.stringify(confirmed).slice(0, 200))
  let version = confirmed.data?.version

  const view = await call('goal_tree_view', {})
  const contradictions = view.data?.contradictions ?? []
  const coreId = contradictions.find((c) => c.type === 'core')?.id
  const mainId = contradictions.find((c) => c.type === 'main')?.id
  const secondaryId = contradictions.find((c) => c.type === 'secondary')?.id
  check('能读到三条矛盾 id', [coreId, mainId, secondaryId].every((id) => typeof id === 'string'), JSON.stringify({ coreId, mainId, secondaryId }))

  console.log('\n=== 1. 改 main 矛盾的普通字段 ===')
  const mainEdit = await call('contradiction_tree_edit', {
    expectedVersion: version,
    reason: '补写 main 矛盾的 rationale',
    updates: [{ id: mainId, rationale: '这是结构性的，不会因为更努力而消失' }],
  })
  check('改 main 矛盾成功', mainEdit.ok === true, JSON.stringify(mainEdit).slice(0, 240))
  check(
    '改 main 矛盾记 reclassify_contradiction',
    mainEdit.data?.auditAction === 'reclassify_contradiction',
    String(mainEdit.data?.auditAction),
  )
  version = mainEdit.data?.version
  const afterMain = await call('goal_tree_view', {})
  const mainNode = (afterMain.data?.contradictions ?? []).find((c) => c.id === mainId)
  check('rationale 已落盘', mainNode?.rationale === '这是结构性的，不会因为更努力而消失', String(mainNode?.rationale))
  check('description 未被波及', mainNode?.description !== mainNode?.rationale, `${mainNode?.description} vs ${mainNode?.rationale}`)

  console.log('\n=== 2. 改 secondary 矛盾 ===')
  const secEdit = await call('contradiction_tree_edit', {
    expectedVersion: version,
    reason: '改次要矛盾的描述',
    updates: [{ id: secondaryId, description: '改过的后果描述' }],
  })
  check('改 secondary 矛盾成功', secEdit.ok === true, JSON.stringify(secEdit).slice(0, 240))
  check(
    '改 secondary 也记 reclassify_contradiction',
    secEdit.data?.auditAction === 'reclassify_contradiction',
    String(secEdit.data?.auditAction),
  )
  version = secEdit.data?.version

  console.log('\n=== 3. 改 core 矛盾需要显式确认 ===')
  const coreNoConfirm = await call('contradiction_tree_edit', {
    expectedVersion: version,
    reason: '未确认就改 core',
    updates: [{ id: coreId, title: '改名的核心张力' }],
  })
  check('未确认改 core 被拒', coreNoConfirm.ok === false, JSON.stringify(coreNoConfirm).slice(0, 200))
  check(
    '拒绝理由是 CORE_CONFIRMATION_REQUIRED',
    String(JSON.stringify(coreNoConfirm)).includes('CORE_CONFIRMATION_REQUIRED'),
    JSON.stringify(coreNoConfirm).slice(0, 240),
  )
  const afterRefuse = await call('goal_tree_view', {})
  check('拒绝后版本未变', afterRefuse.data?.version === version, String(afterRefuse.data?.version))

  const coreConfirmed = await call('contradiction_tree_edit', {
    expectedVersion: version,
    reason: '确认后改 core',
    updates: [{ id: coreId, title: '改名的核心张力' }],
    userConfirmed: true,
  })
  check('确认后改 core 成功', coreConfirmed.ok === true, JSON.stringify(coreConfirmed).slice(0, 240))
  check(
    '改 core 记 update_core_contradiction',
    coreConfirmed.data?.auditAction === 'update_core_contradiction',
    String(coreConfirmed.data?.auditAction),
  )
  version = coreConfirmed.data?.version

  console.log('\n=== 4. 新增矛盾 ===')
  const created = await call('contradiction_tree_edit', {
    expectedVersion: version,
    reason: '新增一条张力',
    creates: [
      {
        title: '新增的张力',
        poleA: 'G',
        poleB: 'H',
        primaryGoalId: (await call('goal_tree_view', {})).data?.goals?.find((g) => g.depth === 1)?.id,
        type: 'secondary',
        description: '后果描述',
        rationale: '结构性理由',
        evidence: ['README.md'],
      },
    ],
  })
  check('新增矛盾成功', created.ok === true, JSON.stringify(created).slice(0, 240))
  check(
    '新增矛盾记 reclassify_contradiction',
    created.data?.auditAction === 'reclassify_contradiction',
    String(created.data?.auditAction),
  )
  const newId = created.data?.addedContradictionIds?.[0]
  check('返回新矛盾 id', typeof newId === 'string', String(newId))
  version = created.data?.version
  const afterCreate = await call('goal_tree_view', {})
  const newNode = (afterCreate.data?.contradictions ?? []).find((c) => c.id === newId)
  check('新矛盾 description 与 rationale 不同', newNode?.description !== newNode?.rationale, `${newNode?.description} vs ${newNode?.rationale}`)

  console.log('\n=== 5. 删除矛盾可见 ===')
  const removed = await call('contradiction_tree_edit', {
    expectedVersion: version,
    reason: '删掉刚建的张力',
    removes: [newId],
  })
  check('删除成功', removed.ok === true, JSON.stringify(removed).slice(0, 240))
  check(
    '返回里报告被删的 id',
    Array.isArray(removed.data?.removedContradictionIds) && removed.data.removedContradictionIds.includes(newId),
    JSON.stringify(removed.data?.removedContradictionIds),
  )
  check(
    '删除记 reclassify_contradiction',
    removed.data?.auditAction === 'reclassify_contradiction',
    String(removed.data?.auditAction),
  )
  version = removed.data?.version
  const afterRemove = await call('goal_tree_view', {})
  check(
    '节点确实不在了',
    (afterRemove.data?.contradictions ?? []).every((c) => c.id !== newId),
    JSON.stringify((afterRemove.data?.contradictions ?? []).map((c) => c.id)),
  )
  check('矛盾数回到三条', (afterRemove.data?.contradictions ?? []).length === 3, String((afterRemove.data?.contradictions ?? []).length))

  // A removed node has no surviving record, so the audit is the only place the
  // deletion can be traced from. An empty targetIds made the removal
  // indistinguishable from a no-op.
  const auditAfterRemove = await store.readAuditLog(projectId)
  const removalEntry = auditAfterRemove[auditAfterRemove.length - 1]
  check(
    '删除的审计 targetIds 指向被删节点',
    Array.isArray(removalEntry?.targetIds) && removalEntry.targetIds.includes(newId),
    JSON.stringify(removalEntry?.targetIds),
  )

  console.log('\n=== 6. 删除有子节点的矛盾被拒 ===')
  // Evidence is mandatory: a node with no traceable support cannot be monitored,
  // so the tool refuses it outright rather than storing an unsupported claim.
  const l1GoalId = (await call('goal_tree_view', {})).data?.goals?.find((g) => g.depth === 1)?.id
  const parentCreated = await call('contradiction_tree_edit', {
    expectedVersion: version,
    reason: '建父子两条矛盾',
    creates: [
      {
        title: '父张力',
        poleA: 'I',
        poleB: 'J',
        primaryGoalId: l1GoalId,
        type: 'secondary',
        evidence: ['README.md'],
      },
    ],
  })
  check('建父矛盾成功', parentCreated.ok === true, JSON.stringify(parentCreated).slice(0, 240))
  version = parentCreated.data?.version
  const parentId = parentCreated.data?.addedContradictionIds?.[0]
  const childCreated = await call('contradiction_tree_edit', {
    expectedVersion: version,
    reason: '给父张力挂子节点',
    creates: [
      {
        title: '子张力',
        poleA: 'K',
        poleB: 'L',
        primaryGoalId: l1GoalId,
        type: 'secondary',
        parentId,
        evidence: ['README.md'],
      },
    ],
  })
  check('建子矛盾成功', childCreated.ok === true, JSON.stringify(childCreated).slice(0, 240))
  version = childCreated.data?.version
  const childId = childCreated.data?.addedContradictionIds?.[0]
  const removeParent = await call('contradiction_tree_edit', {
    expectedVersion: version,
    reason: '试图删有子节点的矛盾',
    removes: [parentId],
  })
  check('删有子节点的矛盾被拒', removeParent.ok === false, JSON.stringify(removeParent).slice(0, 200))
  check(
    '拒绝理由是 NOT_A_LEAF',
    String(JSON.stringify(removeParent)).includes('NOT_A_LEAF'),
    JSON.stringify(removeParent).slice(0, 240),
  )
  const cleanup = await call('contradiction_tree_edit', {
    expectedVersion: version,
    reason: '清理：先删子再删父',
    removes: [childId, parentId],
  })
  check('先子后父可以删', cleanup.ok === true, JSON.stringify(cleanup).slice(0, 200))
  version = cleanup.data?.version

  console.log('\n=== 7. 观察流：只追加，趋势由程序算 ===')
  const obsRoot = await mkdtemp(join(tmpdir(), 'metacog-observe-'))
  try {
    await writeFile(join(obsRoot, 'README.md'), '# 观察流验证\n')
    const obsHost = mountHost(apply, obsRoot)
    const obsCall = (name, args) =>
      obsHost.tools.get(name).execute(args, {
        callId: `o-${Math.random().toString(16).slice(2)}`,
        name,
        arguments: args,
        signal: new AbortController().signal,
        agent: { id: 'observe-test' },
      })
    await obsCall('goal_tree_confirm', {
      expectedVersion: 0,
      l0: { title: '观察流验证的根目标', evidence: ['README.md'] },
      goals: [],
      contradictions: [
        {
          title: '被观察的张力',
          poleA: 'M',
          poleB: 'N',
          evidence: ['README.md'],
          primaryGoalRef: '观察流验证的根目标',
          type: 'main',
        },
      ],
      reason: '观察流验证基线',
    })
    const obsView = await obsCall('goal_tree_view', {})
    const obsId = obsView.data?.contradictions?.[0]?.id
    const obsStore = new MetacogStore(obsRoot, '.metacog')
    const obsProjectId = deriveProjectId(obsRoot)

    const unknown = await obsCall('contradiction_observe', {
      contradictionId: 'C_does_not_exist',
      intensity: 3,
      rationale: '不存在的矛盾',
    })
    check('未知矛盾被拒', unknown.ok === false, JSON.stringify(unknown).slice(0, 160))
    check(
      '拒绝理由是 UNKNOWN_CONTRADICTION',
      String(JSON.stringify(unknown)).includes('UNKNOWN_CONTRADICTION'),
      JSON.stringify(unknown).slice(0, 200),
    )

    const emptyRationale = await obsCall('contradiction_observe', {
      contradictionId: obsId,
      intensity: 3,
      rationale: '   ',
    })
    check('空 rationale 被拒', emptyRationale.ok === false, JSON.stringify(emptyRationale).slice(0, 160))

    const first = await obsCall('contradiction_observe', {
      contradictionId: obsId,
      intensity: 3,
      rationale: '第一次读数',
      confidence: 0.8,
    })
    check('第一条观察成功', first.ok === true, JSON.stringify(first).slice(0, 240))
    check(
      '样本不足时趋势为 unknown',
      String(first.data?.trendNow) === 'unknown',
      JSON.stringify({ trendNow: first.data?.trendNow, samples: first.data?.sampleSize }),
    )

    for (const [intensity, rationale] of [[4, '第二次读数'], [5, '第三次读数']]) {
      await obsCall('contradiction_observe', { contradictionId: obsId, intensity, rationale, confidence: 0.9 })
    }
    const third = await obsCall('contradiction_observe', {
      contradictionId: obsId,
      intensity: 5,
      rationale: '第四次读数',
      confidence: 0.9,
    })
    check(
      '三条以上给出方向',
      ['rising', 'falling', 'stable'].includes(String(third.data?.trendNow)),
      JSON.stringify({ trendNow: third.data?.trendNow, samples: third.data?.sampleSize }),
    )

    const observations = await obsStore.readObservations(obsProjectId)
    check('观察流确实写入了 4 条', observations.length === 4, String(observations.length))
    check('每条都带 rationale', observations.every((o) => typeof o.rationale === 'string' && o.rationale.length > 0), 'missing rationale')

    const obsView2 = await obsCall('goal_tree_view', {})
    const obsNode = (obsView2.data?.contradictions ?? [])[0]
    check('视图从观察流读强度', obsNode?.intensityObserved === 5, String(obsNode?.intensityObserved))
    check('节点手改值仍为 null', obsNode?.intensityEdited === null, String(obsNode?.intensityEdited))

    const zero = await obsCall('contradiction_observe', {
      contradictionId: obsId,
      intensity: 0,
      rationale: '证据不足，不给出等级',
    })
    check('intensity=0 被接受', zero.ok === true, JSON.stringify(zero).slice(0, 200))
    const afterZero = await obsStore.readObservations(obsProjectId)
    check('0 存为 null', afterZero[afterZero.length - 1]?.intensity === null, String(afterZero[afterZero.length - 1]?.intensity))

    const obsAudit = await obsStore.readAuditLog(obsProjectId)
    check(
      '记录观察不写审计',
      obsAudit.every((entry) => entry.action !== 'contradiction_observe'),
      JSON.stringify([...new Set(obsAudit.map((e) => e.action))]),
    )
    const obsState = await obsStore.readState(obsProjectId)
    check('记录观察不改树版本', obsState.version === 1, String(obsState.version))
  } finally {
    await rm(obsRoot, { recursive: true, force: true })
  }

  console.log('\n=== 8. 审计链完整 ===')
  const auditRaw = await readFile(join(root, '.metacog', 'audit', `${projectId}.jsonl`), 'utf8')
  const auditLines = auditRaw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  let chainOk = auditLines[0]?.prevHash === 'GENESIS'
  for (let i = 1; i < auditLines.length; i += 1) {
    if (auditLines[i].prevHash !== auditLines[i - 1].entryHash) chainOk = false
  }
  check('哈希链完整', chainOk, JSON.stringify(auditLines.map((e) => e.action)))
  const actions = [...new Set(auditLines.map((e) => e.action))]
  check('审计里出现过 reclassify_contradiction', actions.includes('reclassify_contradiction'), JSON.stringify(actions))
  check('审计里出现过 update_core_contradiction', actions.includes('update_core_contradiction'), JSON.stringify(actions))
  check(
    '改矛盾不再被记成 update_lower_goal',
    auditLines
      .filter((e) => e.targetIds?.some((id) => String(id).startsWith('C_')))
      .every((e) => e.action !== 'update_lower_goal'),
    JSON.stringify(auditLines.filter((e) => e.targetIds?.some((id) => String(id).startsWith('C_'))).map((e) => [e.action, e.targetIds])),
  )
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
