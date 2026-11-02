/**
 * 偏离解释的验证。
 *
 * 原实现只回答「是不是偏离」，理由是一段自由文本。问题在于：自由文本没法统计。
 * 如果规则总是因为「对不上任何目标」被驳回，该修的是目标树；如果总是因为
 * 「撞了排除项」被驳回，该修的是排除列表——两件事的修法相反。
 *
 * 所以这里验证的是：结构化字段能被解析、能落盘、能按原因统计、能渲染出来，
 * 而且旧记录（没有这些字段）不会崩。
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
const { JUDGMENT_JSON_SCHEMA, buildJudgmentPrompt } = await import(lib('analysis/judgment.js'))
const { assessRules, renderRuleHealth } = await import(lib('analysis/selfaudit.js'))
const { JudgmentRecordSchema } = await import(lib('data/types.js'))



console.log('=== 1. schema 包含三个解释字段 ===')
const verdictProps = JUDGMENT_JSON_SCHEMA.properties.verdicts.items.properties
check('有 isDrift', verdictProps.isDrift !== undefined, Object.keys(verdictProps).join(','))
check('有 why', verdictProps.why !== undefined, Object.keys(verdictProps).join(','))
check('有 howToAdjust', verdictProps.howToAdjust !== undefined, Object.keys(verdictProps).join(','))
check('有 confidence', verdictProps.confidence !== undefined, Object.keys(verdictProps).join(','))
check('保留 reason', verdictProps.reason !== undefined, Object.keys(verdictProps).join(','))
check(
  'why 是枚举而非自由文本',
  Array.isArray(verdictProps.why.enum) && verdictProps.why.enum.length === 6,
  JSON.stringify(verdictProps.why.enum),
)
check(
  'why 的六个取值都在',
  ['no-matching-goal', 'missed-success-criteria', 'outside-allowed-methods', 'hit-excluded-activity', 'contradicts-goal', 'unclear'].every(
    (value) => verdictProps.why.enum.includes(value),
  ),
  JSON.stringify(verdictProps.why.enum),
)
check(
  '三个字段都是必填',
  ['why', 'howToAdjust', 'confidence'].every((key) =>
    JUDGMENT_JSON_SCHEMA.properties.verdicts.items.required.includes(key),
  ),
  JSON.stringify(JUDGMENT_JSON_SCHEMA.properties.verdicts.items.required),
)

console.log('\n=== 2. prompt 要求给出解释 ===')
const prompt = buildJudgmentPrompt(
  {
    projectId: 'p',
    version: 1,
    confirmed: true,
    goals: [
      {
        id: 'G1',
        projectId: 'p',
        parentId: null,
        depth: 0,
        title: '根目标',
        description: '',
        status: 'active',
        priority: 0,
        confirmedByUser: true,
        successCriteria: ['有验收'],
        alignment: {
          relevantActivities: [],
          allowedMethods: [],
          excludedActivities: [],
          explorationPolicy: 'limited',
        },
        evidence: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    contradictions: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  [{ id: 'j1', signalType: 'scope_drift', summary: '某活动', programReason: '某理由' }],
)
check('prompt 提到 why', prompt.includes('why'), prompt.slice(0, 80))
check('prompt 列出可选原因', prompt.includes('no-matching-goal'), 'missing')
check('prompt 提到 howToAdjust', prompt.includes('howToAdjust'), 'missing')
check('prompt 提到 confidence', prompt.includes('confidence'), 'missing')
check('prompt 要求具体动作', prompt.includes('具体到动作'), 'missing')
check('prompt 说明低置信度的后果', prompt.includes('不会被执行'), 'missing')

console.log('\n=== 3. 判定记录能存这些字段 ===')
const withExplanation = JudgmentRecordSchema.parse({
  id: 'j1',
  projectId: 'p',
  createdAt: '2026-01-01T00:00:00.000Z',
  signalType: 'scope_drift',
  status: 'dismissed',
  modelVerdict: 'not_drift',
  modelReason: '这条活动其实在推进目标',
  modelWhy: 'no-matching-goal',
  modelHowToAdjust: '把该工作登记为 L1 的 relevantActivities',
  modelConfidence: 0.85,
})
check('why 落盘', withExplanation.modelWhy === 'no-matching-goal', String(withExplanation.modelWhy))
check('howToAdjust 落盘', String(withExplanation.modelHowToAdjust).includes('relevantActivities'), String(withExplanation.modelHowToAdjust))
check('confidence 落盘', withExplanation.modelConfidence === 0.85, String(withExplanation.modelConfidence))

const legacy = JudgmentRecordSchema.parse({
  id: 'j2',
  projectId: 'p',
  createdAt: '2026-01-01T00:00:00.000Z',
  signalType: 'scope_drift',
  status: 'dismissed',
  modelVerdict: 'not_drift',
  modelReason: '旧记录没有新字段',
})
check('旧记录仍可解析', legacy.modelWhy === undefined, String(legacy.modelWhy))
check('旧记录 confidence 缺省', legacy.modelConfidence === undefined, String(legacy.modelConfidence))

let badConfidenceRejected = false
try {
  JudgmentRecordSchema.parse({
    id: 'j3',
    projectId: 'p',
    createdAt: '2026-01-01T00:00:00.000Z',
    signalType: 'scope_drift',
    modelConfidence: 1.5,
  })
} catch {
  badConfidenceRejected = true
}
check('confidence 越界被拒', badConfidenceRejected, 'not rejected')

let badWhyRejected = false
try {
  JudgmentRecordSchema.parse({
    id: 'j4',
    projectId: 'p',
    createdAt: '2026-01-01T00:00:00.000Z',
    signalType: 'scope_drift',
    modelWhy: '自己编的原因',
  })
} catch {
  badWhyRejected = true
}
check('非法 why 被拒', badWhyRejected, 'not rejected')

console.log('\n=== 4. 按原因统计 ===')
const makeRecord = (id, status, why) => ({
  id,
  projectId: 'p',
  createdAt: '2026-01-01T00:00:00.000Z',
  signalType: 'scope_drift',
  status,
  ...(why === undefined ? {} : { modelWhy: why }),
})
const records = [
  ...Array.from({ length: 6 }, (_, i) => makeRecord(`a${i}`, 'dismissed', 'no-matching-goal')),
  ...Array.from({ length: 3 }, (_, i) => makeRecord(`b${i}`, 'dismissed', 'hit-excluded-activity')),
  ...Array.from({ length: 2 }, (_, i) => makeRecord(`c${i}`, 'confirmed')),
]
const health = assessRules(records)
check('一条规则一行', health.length === 1, String(health.length))
const row = health[0]
check('驳回总数正确', row.dismissed === 9, String(row.dismissed))
check('确认总数正确', row.confirmed === 2, String(row.confirmed))
check('byWhy 有两项', row.byWhy.length === 2, JSON.stringify(row.byWhy))
check('按次数降序', row.byWhy[0]?.why === 'no-matching-goal' && row.byWhy[0]?.count === 6, JSON.stringify(row.byWhy))
check('第二项是排除项', row.byWhy[1]?.why === 'hit-excluded-activity' && row.byWhy[1]?.count === 3, JSON.stringify(row.byWhy))
check('确认记录不计入 byWhy', row.byWhy.reduce((sum, entry) => sum + entry.count, 0) === 9, String(row.byWhy.reduce((sum, entry) => sum + entry.count, 0)))

const noWhyRecords = Array.from({ length: 12 }, (_, i) => makeRecord(`d${i}`, 'dismissed'))
const noWhyHealth = assessRules(noWhyRecords)
check('没有 why 时 byWhy 为空', noWhyHealth[0]?.byWhy.length === 0, JSON.stringify(noWhyHealth[0]?.byWhy))
check('驳回率仍然算得出', noWhyHealth[0]?.falsePositiveRate === 1, String(noWhyHealth[0]?.falsePositiveRate))

console.log('\n=== 5. 渲染 ===')
const rendered = renderRuleHealth(health)
check('渲染出规则行', rendered[0].includes('scope_drift'), rendered[0])
check('渲染出驳回原因', rendered[0].includes('驳回原因'), rendered[0])
check('原因带次数', rendered[0].includes('no-matching-goal 6'), rendered[0])
const plainRendered = renderRuleHealth(noWhyHealth)
check('没有原因时不多加一行', plainRendered.length === 1, JSON.stringify(plainRendered))

console.log('\n=== 6. 端到端：判定记录写入后能统计 ===')
const root = await mkdtemp(join(tmpdir(), 'metacog-explain-'))
try {
  await writeFile(join(root, 'README.md'), '# 解释验证\n')
  const tools = new Map()
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return { get: () => root, defaultDirectory: root }
      if (name === 'tools') return this.tools
      if (name === 'sessions') return { get: () => undefined, list: () => [] }
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
      agent: { id: 'explain-test', session: { id: 'session-e', header: { cwd: root } } },
    })

  const store = new MetacogStore(root, '.metacog')
  const projectId = deriveProjectId(root)
  await call('goal_tree_confirm', {
    expectedVersion: 0,
    l0: { title: '解释验证的根目标', evidence: ['README.md'] },
    goals: [],
    contradictions: [],
    reason: '解释验证基线',
  })

  await store.appendJudgment(projectId, {
    id: 'jdg_1',
    projectId,
    createdAt: new Date().toISOString(),
    signalType: 'scope_drift',
    summary: '某活动',
    programReason: '程序判为偏离',
    status: 'dismissed',
    modelVerdict: 'not_drift',
    modelReason: '实际在推进目标',
    modelWhy: 'missed-success-criteria',
    modelHowToAdjust: '给该目标补一条更具体的验收条件',
    modelConfidence: 0.9,
  })

  const stored = await store.readJudgments(projectId)
  const entry = stored.find((record) => record.id === 'jdg_1')
  check('why 写入磁盘', entry?.modelWhy === 'missed-success-criteria', String(entry?.modelWhy))
  check('howToAdjust 写入磁盘', String(entry?.modelHowToAdjust).includes('验收条件'), String(entry?.modelHowToAdjust))
  check('confidence 写入磁盘', entry?.modelConfidence === 0.9, String(entry?.modelConfidence))

  const audit = assessRules(stored)
  check('从磁盘读回也能统计', audit[0]?.byWhy[0]?.why === 'missed-success-criteria', JSON.stringify(audit[0]?.byWhy))

  const report = await call('generate_report', { type: 'weekly' })
  check('周报生成成功', report.ok === true, JSON.stringify(report).slice(0, 200))
  check('周报含规则健康度', String(report.data?.markdown).includes('规则健康度'), String(report.data?.markdown).slice(0, 120))
} finally {
  await rm(root, { recursive: true, force: true })
}

exit()
