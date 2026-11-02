/**
 * Rule coverage: the audit blind spot created by the bypass path.
 *
 * A high-precision rule publishes a signal without a judgement record, so the
 * rule-health statistics never see it. These checks pin the provenance marker,
 * the coverage measurement, the report line that makes the blind spot readable,
 * and the deterministic sampling that can feed reviews back into the statistics.
 *
 * Run: node test/rule-coverage.test.mjs   (after `npm run build`)
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (path) => pathToFileURL(join(here, '..', 'lib', path)).href

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

const { parseConfig } = await import(lib('config.js'))
const { MetacogStore } = await import(lib('data/store.js'))
const { DriftSignalSchema } = await import(lib('data/types.js'))
const { publishDrafts } = await import(lib('analysis/service.js'))
const { assessRuleCoverage } = await import(lib('analysis/selfaudit.js'))
const {
  judgmentFromDraft,
  isBypassSampled,
  bypassSampleKey,
} = await import(lib('analysis/judgment.js'))
const { generateReport } = await import(lib('report.js'))

const config = parseConfig({})
const now = new Date('2026-10-31T12:00:00.000Z')

function draft(overrides = {}) {
  return {
    observedAt: now.toISOString(),
    monitorCategory: 'goal_alignment',
    signalType: 'core_bypass',
    relatedGoalIds: [],
    relatedContradictionIds: [],
    activityIds: [],
    confidence: 0.9,
    evidence: ['README.md'],
    hint: '高精度规则命中：测试用提示。',
    rationale: 'test rationale',
    ...overrides,
  }
}

function signal(overrides = {}) {
  return DriftSignalSchema.parse({
    id: `sig_${Math.random().toString(16).slice(2)}`,
    projectId: 'proj-coverage',
    observedAt: now.toISOString(),
    monitorCategory: 'goal_alignment',
    signalType: 'core_bypass',
    level: 1,
    relatedGoalIds: [],
    relatedContradictionIds: [],
    confidence: 0.9,
    ...overrides,
  })
}

const root = await mkdtemp(join(tmpdir(), 'metacog-rule-coverage-'))
try {
  console.log('\n=== A1: 来源标记 ===')
  const oldSignal = DriftSignalSchema.parse({
    id: 'sig_old',
    projectId: 'proj-coverage',
    observedAt: now.toISOString(),
    monitorCategory: 'goal_alignment',
    signalType: 'scope_drift',
    level: 1,
    confidence: 0.8,
    rationale: 'old record without reviewedBy',
  })
  check('旧信号读出为 review', oldSignal.reviewedBy === 'review', oldSignal.reviewedBy)

  const state = { projectId: 'proj-coverage', version: 1, confirmed: true, goals: [], contradictions: [] }
  const combos = [
    { mayEscalate: false, bypassed: false, level: 0, reviewedBy: 'review' },
    { mayEscalate: true, bypassed: false, level: 1, reviewedBy: 'review' },
    { mayEscalate: false, bypassed: true, level: 0, reviewedBy: 'bypass' },
    { mayEscalate: true, bypassed: true, level: 1, reviewedBy: 'bypass' },
  ]
  for (const [index, combo] of combos.entries()) {
    const projectId = `proj-combo-${index}`
    const store = new MetacogStore(join(root, `combo-${index}`), '.metacog')
    await publishDrafts(
      store,
      { ...state, projectId },
      projectId,
      [draft()],
      config,
      now,
      { mayEscalate: combo.mayEscalate, bypassed: combo.bypassed },
    )
    const stored = (await store.readSignals(projectId))[0]
    check(
      `组合 mayEscalate=${combo.mayEscalate} / bypassed=${combo.bypassed} 记录 level ${combo.level}`,
      stored?.level === combo.level,
      String(stored?.level),
    )
    check(
      `组合 mayEscalate=${combo.mayEscalate} / bypassed=${combo.bypassed} 记录 reviewedBy ${combo.reviewedBy}`,
      stored?.reviewedBy === combo.reviewedBy,
      String(stored?.reviewedBy),
    )
  }

  console.log('\n=== A2: 覆盖率统计 ===')
  const signals = [
    signal({ signalType: 'core_bypass', reviewedBy: 'bypass' }),
    signal({ signalType: 'core_bypass', reviewedBy: 'bypass' }),
    signal({ signalType: 'core_bypass', reviewedBy: 'bypass' }),
    signal({ signalType: 'core_bypass', reviewedBy: 'review' }),
    signal({ signalType: 'goal_staleness', reviewedBy: 'review' }),
    signal({ signalType: 'goal_staleness', reviewedBy: 'review' }),
  ]
  const sampledCore = judgmentFromDraft(
    'proj-coverage',
    draft({ signalType: 'core_bypass' }),
    'sampled core bypass',
    { sampled: true },
  )
  const normalCore = judgmentFromDraft(
    'proj-coverage',
    draft({ signalType: 'core_bypass' }),
    'normal core bypass',
  )
  const coverage = assessRuleCoverage(signals, [sampledCore, normalCore])
  const core = coverage.find((row) => row.signalType === 'core_bypass')
  const stale = coverage.find((row) => row.signalType === 'goal_staleness')
  check('core_bypass 直通 3 条', core?.bypassed === 3, JSON.stringify(core))
  check('core_bypass 已复核 1 条', core?.reviewed === 1, JSON.stringify(core))
  check('core_bypass 盲区 2 条（3 直通 - 1 抽样）', core?.unreviewedBypass === 2, JSON.stringify(core))
  check('core_bypass 被标为不可代表', core?.underrepresented === true, JSON.stringify(core))
  check('goal_staleness 无直通', stale?.bypassed === 0, JSON.stringify(stale))
  check('goal_staleness 盲区为 0', stale?.unreviewedBypass === 0, JSON.stringify(stale))
  check('goal_staleness 未被标不可代表', stale?.underrepresented === false, JSON.stringify(stale))
  check(
    '没有对应 judgment 的 review 信号不计入已复核',
    stale?.reviewed === 0,
    JSON.stringify(stale),
  )

  console.log('\n=== A3: 抽样配置与确定性 ===')
  const defaults = parseConfig({})
  check('bypassSampleRate 默认 0', defaults.judgment.bypassSampleRate === 0, String(defaults.judgment.bypassSampleRate))
  const half = parseConfig({ judgment: { bypassSampleRate: 0.5 } })
  check('profile 可覆盖抽样率', half.judgment.bypassSampleRate === 0.5, String(half.judgment.bypassSampleRate))

  const many = Array.from({ length: 20 }, (_, index) =>
    draft({ evidence: [`file-${index}.ts`], observedAt: new Date(now.getTime() + index * 1000).toISOString() }),
  )
  check('rate=0 不抽样', many.every((item) => isBypassSampled(item, 0) === false))
  check('rate=1 全部抽样', many.every((item) => isBypassSampled(item, 1) === true))
  const firstRun = many.filter((item) => isBypassSampled(item, 0.5)).map((item) => bypassSampleKey(item))
  const secondRun = many.filter((item) => isBypassSampled(item, 0.5)).map((item) => bypassSampleKey(item))
  check('两次抽样集合完全相同', JSON.stringify(firstRun) === JSON.stringify(secondRun), `${firstRun.length} vs ${secondRun.length}`)
  check('0.5 抽样有选中也有未选中', firstRun.length > 0 && firstRun.length < many.length, String(firstRun.length))

  const sampledRecord = judgmentFromDraft('proj-coverage', many[0], 'sample', { sampled: true })
  const normalRecord = judgmentFromDraft('proj-coverage', many[1], 'normal')
  check('抽样候选带 sampled 标记', sampledRecord.sampled === true)
  check('正常候选不被误标', normalRecord.sampled === false)

  console.log('\n=== A2: 覆盖率进入报告 ===')
  const reportStore = new MetacogStore(join(root, 'report'), '.metacog')
  const reportProject = 'proj-report'
  const reportState = { ...state, projectId: reportProject }
  for (const item of signals) {
    await reportStore.appendSignal(reportProject, { ...item, projectId: reportProject })
  }
  for (const record of [sampledCore, normalCore]) {
    await reportStore.appendJudgment(reportProject, {
      ...record,
      id: `${record.id}-${Math.random().toString(16).slice(2)}`,
      projectId: reportProject,
    })
  }
  const report = await generateReport({
    store: reportStore,
    state: reportState,
    projectId: reportProject,
    config,
    type: 'weekly',
    now,
  })
  check('报告含规则健康度小节', report.markdown.includes('## 规则健康度'), report.markdown)
  check('报告写出直通数量', report.markdown.includes('直通 3 条'), report.markdown)
  check('报告写出从未复核数量', report.markdown.includes('从未复核'), report.markdown)
  check('报告标记统计不可代表', report.markdown.includes('统计不可代表'), report.markdown)
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n=== Rule coverage 结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
