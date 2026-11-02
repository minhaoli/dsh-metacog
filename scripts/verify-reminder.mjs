/**
 * 提醒去重的验证。
 *
 * 起因：第一版按「未读记录数」计数，于是每次复核都让总数重新越过阈值，
 * 同一条命令里重复提醒了四次 —— 提醒在报告自己的积压，而不是新证据。
 *
 * 现在的口径是「自上次提醒以来新落定的条数」。这个脚本证明三件事：
 * 1. 不足阈值时一条都不提醒；
 * 2. 越过阈值只提醒一次；
 * 3. 提醒后立刻置位，同一批记录不会再次触发。
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
const { remindIfLogIsLong } = await import(lib('analysis/judgment.js'))
const { parseConfig } = await import(lib('config.js'))



const root = await mkdtemp(join(tmpdir(), 'metacog-remind-'))
try {
  await writeFile(join(root, 'README.md'), '# 提醒去重验证\n')
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
      agent: { id: 'remind-test' },
    })

  await call('goal_tree_confirm', {
    expectedVersion: 0,
    l0: { title: '提醒验证的根目标', evidence: ['README.md'] },
    goals: [],
    contradictions: [],
    reason: '提醒去重验证基线',
  })

  const store = new MetacogStore(root, '.metacog')
  const projectId = deriveProjectId(root)
  const config = parseConfig({})
  const threshold = config.thresholds.judgmentLogThreshold
  console.log(`\n阈值 = ${threshold}`)

  /** 写一条已落定的判定记录。 */
  const seedSettled = async (index, status = 'dismissed') => {
    await store.appendJudgment(projectId, {
      id: `jdg_remind_${index}`,
      projectId,
      createdAt: new Date().toISOString(),
      activityIds: [],
      signalType: 'scope_drift',
      summary: `提醒测试记录 ${index}`,
      programReason: '测试用',
      status,
      ...(status === 'confirmed'
        ? { modelVerdict: 'drift', modelReason: '测试用' }
        : { modelVerdict: 'not_drift', modelReason: '测试用' }),
    })
  }

  console.log('\n=== 1. 空日志不提醒 ===')
  check('空日志返回空数组', (await remindIfLogIsLong(store, projectId, config)).length === 0)

  console.log('\n=== 2. 不足阈值不提醒 ===')
  for (let index = 0; index < threshold - 1; index += 1) await seedSettled(index)
  const below = await remindIfLogIsLong(store, projectId, config)
  check(`只有 ${threshold - 1} 条时不提醒`, below.length === 0, JSON.stringify(below))

  console.log('\n=== 3. 越过阈值提醒一次 ===')
  await seedSettled(threshold - 1)
  const first = await remindIfLogIsLong(store, projectId, config)
  check('越过阈值触发提醒', first.length === 1, JSON.stringify(first))
  check('提醒里报新增条数', String(first[0]).includes(`新增 ${threshold} 条`), String(first[0]))
  check('提醒里报累计条数', String(first[0]).includes(`累计 ${threshold} 条`), String(first[0]))
  check('提醒里报误报率', String(first[0]).includes('100%'), String(first[0]))

  console.log('\n=== 4. 同一批不重复提醒 ===')
  const second = await remindIfLogIsLong(store, projectId, config)
  check('立刻再问不再提醒', second.length === 0, JSON.stringify(second))

  console.log('\n=== 5. 只有新增累计到阈值才再提醒 ===')
  for (let index = 0; index < threshold - 1; index += 1) await seedSettled(1000 + index)
  const stillBelow = await remindIfLogIsLong(store, projectId, config)
  check('新增不足阈值不提醒', stillBelow.length === 0, JSON.stringify(stillBelow))
  await seedSettled(2000)
  const third = await remindIfLogIsLong(store, projectId, config)
  check('新增越过阈值再提醒', third.length === 1, JSON.stringify(third))
  check('第二次提醒报的是新增条数而非总数', String(third[0]).includes(`新增 ${threshold} 条`), String(third[0]))

  console.log('\n=== 6. 待复核记录不计入提醒 ===')
  for (let index = 0; index < threshold + 5; index += 1) {
    await store.appendJudgment(projectId, {
      id: `jdg_pending_${index}`,
      projectId,
      createdAt: new Date().toISOString(),
      activityIds: [],
      signalType: 'scope_drift',
      summary: `待复核记录 ${index}`,
      programReason: '测试用',
      status: 'pending',
    })
  }
  const withPending = await remindIfLogIsLong(store, projectId, config)
  check('待复核不触发提醒', withPending.length === 0, JSON.stringify(withPending))

  console.log('\n=== 7. 落盘后 notified 已置位 ===')
  const records = await store.readJudgments(projectId)
  const latest = new Map()
  for (const record of records) latest.set(record.id, record)
  const settled = [...latest.values()].filter((record) => record.status !== 'pending')
  check('所有已落定记录都已置位', settled.every((record) => record.notified === true), JSON.stringify(settled.filter((record) => !record.notified).map((record) => record.id)))

  console.log('\n=== 8. 确认记录也计入 ===')
  const beforeCount = (await store.readJudgments(projectId)).filter((r) => !r.notified && r.status !== 'pending').length
  for (let index = 0; index < threshold; index += 1) await seedSettled(3000 + index, 'confirmed')
  const confirmedReminder = await remindIfLogIsLong(store, projectId, config)
  check('确认记录同样触发提醒', confirmedReminder.length === 1, JSON.stringify(confirmedReminder))
  check('误报率随确认记录下降', !String(confirmedReminder[0]).includes('100%'), String(confirmedReminder[0]))
  void beforeCount
} finally {
  await rm(root, { recursive: true, force: true })
}

exit()
