/**
 * 归档信号的功能验证：历史不丢，统计归零。
 *
 * 起因：1459 条旧 `scope_drift` 信号来自已废弃的工具级采集，
 * 留着重则持续污染等级统计与重复计数，删掉又等于销毁监控行为的历史。
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createChecker, libUrl, mountHost } from './_harness.mjs'

const { apply } = await import(libUrl('lib', 'index.js'))
const { MetacogStore } = await import(libUrl('lib', 'data/store.js'))
const { deriveProjectId } = await import(libUrl('lib', 'tools/shared.js'))

const { check, counts, exit } = createChecker()

const root = await mkdtemp(join(tmpdir(), 'metacog-archive-'))
try {
  await writeFile(join(root, 'README.md'), '# 归档验证\n')
  const host = mountHost(apply, root)
  const { tools } = host
  const call = (name, args) =>
    tools.get(name).execute(args, {
      callId: `c-${Math.random().toString(16).slice(2)}`,
      name,
      arguments: args,
      signal: new AbortController().signal,
      agent: { id: 'archive-test' },
    })

  console.log('\n=== 准备：一棵确认树 + 三条旧信号 ===')
  const confirmed = await call('goal_tree_confirm', {
    expectedVersion: 0,
    l0: { title: '归档验证的根目标', evidence: ['README.md'] },
    goals: [],
    contradictions: [],
    reason: '归档验证基线',
  })
  check('树已确认', confirmed.ok === true, JSON.stringify(confirmed).slice(0, 160))

  const store = new MetacogStore(root, '.metacog')
  const projectId = deriveProjectId(root)
  for (let index = 0; index < 3; index += 1) {
    await store.appendSignal(projectId, {
      id: `sig_legacy_${index}`,
      projectId,
      observedAt: new Date(Date.now() - index * 1000).toISOString(),
      monitorCategory: 'goal_alignment',
      signalType: 'scope_drift',
      level: 1,
      relatedGoalIds: [],
      relatedContradictionIds: [],
      activityIds: [],
      confidence: 1,
      evidence: ['read: 旧采集器的工具级证据'],
      rationale: '旧规则在无语义摘要上的误判',
    })
  }
  check('信号流里有 3 条', (await store.readSignals(projectId)).length === 3)

  console.log('\n=== 1. 没有 reason 必须被拒 ===')
  const noReason = await call('metacog_archive_signals', {})
  check('拒绝且给出 INVALID_ARGS', noReason.ok === false && noReason.error.code === 'INVALID_ARGS', JSON.stringify(noReason).slice(0, 160))
  check('信号未被改动', (await store.readSignals(projectId)).length === 3)

  console.log('\n=== 2. 归档成功 ===')
  const archived = await call('metacog_archive_signals', { reason: '旧采集器产生的误判，与新口径无关' })
  check('归档成功', archived.ok === true, JSON.stringify(archived).slice(0, 200))
  check('报告归档 3 条', archived.data?.archived === 3, String(archived.data?.archived))
  check('给出归档路径', typeof archived.data?.path === 'string', String(archived.data?.path))

  console.log('\n=== 3. 活动流已清空，等级统计归零 ===')
  check('活动信号流为空', (await store.readSignals(projectId)).length === 0)
  const drift = await call('check_drift', {})
  const counts = drift.data?.levelCounts ?? {}
  const total = Object.values(counts).reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0)
  check('check_drift 不再计入旧信号', total === 0, JSON.stringify(counts))

  console.log('\n=== 4. 历史完整保留在归档里 ===')
  const archiveDir = join(root, '.metacog', 'signals-archive', projectId)
  const files = await readdir(archiveDir)
  const dataFile = files.find((name) => name.endsWith('.jsonl'))
  check('归档目录有数据文件', dataFile !== undefined, files.join(','))
  if (dataFile !== undefined) {
    const lines = (await readFile(join(archiveDir, dataFile), 'utf8')).split('\n').filter((l) => l.trim())
    check('归档保留全部 3 条', lines.length === 3, String(lines.length))
    const first = JSON.parse(lines[0])
    check('归档保留原始理由', String(first.rationale).includes('旧规则'), String(first.rationale))
  }
  const metaFile = files.find((name) => name.endsWith('.meta.json'))
  check('有说明文件', metaFile !== undefined, files.join(','))
  if (metaFile !== undefined) {
    const meta = JSON.parse(await readFile(join(archiveDir, metaFile), 'utf8'))
    check('说明记录了原因', String(meta.reason).includes('旧采集器'), String(meta.reason))
    check('说明记录了条数', meta.count === 3, String(meta.count))
  }

  console.log('\n=== 5. 空流时归档是幂等的 ===')
  const again = await call('metacog_archive_signals', { reason: '重复归档' })
  check('仍然成功', again.ok === true, JSON.stringify(again).slice(0, 160))
  check('报告 0 条', again.data?.archived === 0, String(again.data?.archived))
  check('没有产生新文件', (await readdir(archiveDir)).filter((n) => n.endsWith('.jsonl')).length === 1)

  console.log('\n=== 6. 归档后新信号仍可正常写入 ===')
  await store.appendSignal(projectId, {
    id: 'sig_new',
    projectId,
    observedAt: new Date().toISOString(),
    monitorCategory: 'goal_alignment',
    signalType: 'goal_staleness',
    level: 1,
    relatedGoalIds: [],
    relatedContradictionIds: [],
    activityIds: [],
    confidence: 0.8,
    evidence: ['README.md'],
    rationale: '新口径下的信号',
  })
  check('新信号写入成功', (await store.readSignals(projectId)).length === 1)
} finally {
  await rm(root, { recursive: true, force: true })
}

exit(`\n=== 归档验证：${counts.passed} 通过，${counts.failed} 失败 ===`)
