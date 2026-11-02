/**
 * User-facing hints vs audit rationale.
 *
 * Every user-visible line used to be the same string as the audit evidence, so
 * it read like a log entry ("confidence 0.60 is below the configured floor") and
 * told the reader neither what happened nor what to do. This suite pins the
 * split: `hint` is Chinese, short, actionable and free of internal codes;
 * `rationale` stays technical; the prompt channel reads only `hint`.
 *
 * Run: node test/hint-readability.test.mjs   (after `npm run build`)
 */
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

const CHINESE = /[\u4e00-\u9fff]/
/** Internal names that must never reach a user-facing hint. */
const INTERNAL_CODES = [
  /s[1-5]_/,
  /theta/i,
  /coverageFloor/i,
  /DIMENSION_WEIGHTS/,
  /\bb_[a-z]/i,
  /scope_drift|core_bypass|goal_staleness|contradiction_shift|deadline_risk/,
]

function checkHint(label, hint) {
  check(`${label}：hint 非空`, typeof hint === 'string' && hint.trim().length > 0)
  check(`${label}：hint 是中文`, typeof hint === 'string' && CHINESE.test(hint), String(hint))
  check(
    `${label}：hint 不超过 60 字`,
    typeof hint === 'string' && hint.length <= 60,
    `${hint?.length}：${hint}`,
  )
  const leaked = INTERNAL_CODES.find((pattern) => pattern.test(String(hint)))
  check(`${label}：hint 不含内部代号`, leaked === undefined, `${leaked} in ${hint}`)
}

const { parseConfig } = await import(lib('config.js'))
const { judgeAlignment } = await import(lib('analysis/alignment.js'))
const {
  detectGoalStaleness,
  detectCoreBypass,
  detectScopeDrift,
  detectContradictionShift,
  detectDeadlineRisk,
  detectContradictionPressure,
} = await import(lib('analysis/drift.js'))
const {
  decideEscalation,
  level1Hint,
  pendingInterventionHint,
  coverageHint,
  clampHint,
  HINT_MAX_CHARS,
} = await import(lib('analysis/escalation.js'))
const { DriftSignalSchema, InterventionRecordSchema } = await import(lib('data/types.js'))

const projectId = 'proj-hints'
const now = new Date('2026-10-31T12:00:00.000Z')
const config = parseConfig({})
const ago = (days) => new Date(now.getTime() - days * 86_400_000).toISOString()
const minutesAgo = (minutes) => new Date(now.getTime() - minutes * 60_000).toISOString()

function goal(overrides = {}) {
  return {
    id: 'G1',
    projectId,
    parentId: 'G0',
    depth: 1,
    title: '子目标',
    description: '',
    status: 'active',
    priority: 0,
    confirmedByUser: true,
    successCriteria: [],
    paths: [],
    alignment: {
      relevantActivities: [],
      allowedMethods: [],
      excludedActivities: [],
      explorationPolicy: 'limited',
    },
    evidence: ['README.md'],
    createdAt: ago(30),
    updatedAt: ago(10),
    ...overrides,
  }
}

function contradiction(overrides = {}) {
  return {
    id: 'C1',
    projectId,
    parentId: null,
    primaryGoalId: 'G1',
    relatedGoalIds: [],
    type: 'main',
    confirmedByUser: true,
    title: '规则与实际执行脱节',
    description: '',
    poleA: '规则',
    poleB: '执行',
    intensity: 4,
    trend: 'unknown',
    rationale: '结构张力',
    resolutionHint: '',
    evidence: ['README.md'],
    createdAt: ago(20),
    updatedAt: ago(20),
    ...overrides,
  }
}

function activity(overrides = {}) {
  return {
    id: 'A1',
    eventFingerprint: 'fp-1',
    projectId,
    timestamp: minutesAgo(5),
    source: 'manual',
    observationGrade: 'A',
    summary: '随手改了点东西',
    evidence: ['src/a.ts'],
    candidateGoalIds: [],
    alignmentConfidence: 0.8,
    decision: 'scope_drift',
    rationale: '',
    ...overrides,
  }
}

console.log('\n=== H1: 每种 alignment 判定都有中文 hint ===')
{
  const whitelist = parseConfig({
    whitelistedActivities: [{ label: '读论文', summaryContains: ['读论文'], toolNames: [] }],
  })
  const baseGoals = [
    goal({
      id: 'G1',
      title: '子目标',
      paths: ['src'],
      alignment: {
        relevantActivities: ['调研'],
        allowedMethods: ['pytest'],
        excludedActivities: ['重构'],
        explorationPolicy: 'limited',
      },
    }),
  ]
  const verdicts = {
    '证据等级 C': judgeAlignment(
      { summary: 'x', evidence: [], grade: 'C', source: 'manual' },
      baseGoals,
      config,
    ),
    '没有已确认目标': judgeAlignment(
      { summary: 'x', evidence: ['a'], grade: 'A', source: 'manual' },
      [],
      config,
    ),
    白名单: judgeAlignment(
      { summary: '读论文', evidence: ['a'], grade: 'A', source: 'manual' },
      baseGoals,
      whitelist,
    ),
    路径归属: judgeAlignment(
      { summary: '改代码', evidence: ['src/a.ts'], grade: 'A', source: 'manual', paths: ['src/a.ts'] },
      baseGoals,
      config,
    ),
    '排除项（B 级）': judgeAlignment(
      { summary: '重构模块', evidence: ['a'], grade: 'B', source: 'manual' },
      baseGoals,
      config,
    ),
    '排除项（A 级）': judgeAlignment(
      { summary: '重构模块', evidence: ['a'], grade: 'A', source: 'manual' },
      baseGoals,
      config,
    ),
    '允许的探索': judgeAlignment(
      { summary: '调研方案', evidence: ['a'], grade: 'A', source: 'manual' },
      [goal({ alignment: { relevantActivities: ['调研'], allowedMethods: [], excludedActivities: [], explorationPolicy: 'allowed' } })],
      config,
    ),
    '有限探索': judgeAlignment(
      { summary: '调研方案', evidence: ['a'], grade: 'A', source: 'manual' },
      baseGoals,
      config,
    ),
    '需要批准': judgeAlignment(
      { summary: '调研方案', evidence: ['a'], grade: 'A', source: 'manual' },
      [goal({ alignment: { relevantActivities: ['调研'], allowedMethods: [], excludedActivities: [], explorationPolicy: 'approval_required' } })],
      config,
    ),
    无人认领的路径: judgeAlignment(
      { summary: '改代码', evidence: ['other/a.ts'], grade: 'A', source: 'manual', paths: ['other/a.ts'] },
      baseGoals,
      config,
    ),
    'B 级证据不足': judgeAlignment(
      { summary: '随便写写', evidence: ['a'], grade: 'B', source: 'manual' },
      baseGoals,
      config,
    ),
    确认偏离: judgeAlignment(
      { summary: '随便写写', evidence: ['a'], grade: 'A', source: 'manual' },
      baseGoals,
      config,
    ),
  }
  for (const [label, verdict] of Object.entries(verdicts)) {
    checkHint(`alignment/${label}`, verdict.hint)
    check(`alignment/${label}：rationale 保留技术细节`, verdict.rationale.length > 0)
  }
  check(
    'alignment 的 hint 与 rationale 是两条不同的文本',
    verdicts['确认偏离'].hint !== verdicts['确认偏离'].rationale,
  )
}

console.log('\n=== H2: 六个 detector 都产出中文 hint ===')
{
  const staleGoal = goal({ id: 'G1', title: '陈旧目标', updatedAt: ago(10) })
  const deadlineGoal = goal({
    id: 'G2',
    title: '临期目标',
    startedAt: ago(20),
    deadline: new Date(now.getTime() + 2 * 86_400_000).toISOString(),
    updatedAt: ago(20),
  })
  const state = {
    projectId,
    version: 1,
    confirmed: true,
    goals: [staleGoal, deadlineGoal],
    contradictions: [contradiction({ id: 'C1', primaryGoalId: 'G1' })],
  }
  const avoiding = [
    activity({ id: 'A1', decision: 'scope_drift', candidateGoalIds: [], timestamp: minutesAgo(5) }),
    activity({ id: 'A2', decision: 'scope_drift', candidateGoalIds: [], timestamp: minutesAgo(6) }),
    activity({ id: 'A3', decision: 'scope_drift', candidateGoalIds: [], timestamp: minutesAgo(7) }),
  ]
  const input = {
    state,
    activities: avoiding,
    observations: [],
    signals: [],
    config,
    now,
  }

  const drafts = {
    目标陈旧: detectGoalStaleness(input),
    核心被绕开: detectCoreBypass(input),
    范围偏离: detectScopeDrift(avoiding[0], input),
    瓶颈转移: detectContradictionShift('预算超支', input),
    截止风险: detectDeadlineRisk(input),
    矛盾压力: detectContradictionPressure(input),
  }
  for (const [label, list] of Object.entries(drafts)) {
    check(`detector/${label} 产出了信号`, Array.isArray(list) && list.length > 0, JSON.stringify(list))
    for (const draft of list) {
      checkHint(`detector/${label}`, draft.hint)
      check(`detector/${label}：rationale 保留技术细节`, draft.rationale.length > 0)
    }
  }
}

console.log('\n=== H3: 升级决策也带中文 hint ===')
{
  const base = {
    signalType: 'scope_drift',
    relatedContradictionIds: [],
    relatedGoalIds: ['G1'],
    confidence: 0.8,
    intensity: 0,
    mayEscalate: true,
    signals: [],
    interventions: [],
    config,
    now,
  }
  const prior = (index, signalType = 'scope_drift') => ({
    id: `sig_prior_${index}`,
    projectId,
    observedAt: minutesAgo(index + 1),
    monitorCategory: 'goal_alignment',
    signalType,
    level: 1,
    relatedGoalIds: ['G1'],
    relatedContradictionIds: signalType === 'core_bypass' ? ['C1'] : [],
    activityIds: [],
    confidence: 0.9,
    evidence: [],
    rationale: 'prior',
  })
  const cases = {
    '等级门槛': decideEscalation({ ...base, mayEscalate: false }),
    '把握不足': decideEscalation({ ...base, confidence: 0.3 }),
    单次提示: decideEscalation(base),
    '重复开卡': decideEscalation({ ...base, signals: [prior(1), prior(2)] }),
    '核心绕过': decideEscalation({
      ...base,
      signalType: 'core_bypass',
      relatedContradictionIds: ['C1'],
      intensity: 4,
      signals: [prior(1, 'core_bypass'), prior(2, 'core_bypass')],
    }),
    静默记录: decideEscalation({ ...base, confidence: 0.3, mayEscalate: true }),
  }
  for (const [label, decision] of Object.entries(cases)) {
    checkHint(`escalation/${label}`, decision.hint)
    check(`escalation/${label}：rationale 保留技术细节`, decision.rationale.length > 0)
  }
}

console.log('\n=== H4: prompt 通道只取 hint ===')
{
  const signal = DriftSignalSchema.parse({
    id: 'sig_1',
    projectId,
    observedAt: minutesAgo(1),
    monitorCategory: 'goal_alignment',
    signalType: 'goal_staleness',
    level: 1,
    relatedGoalIds: ['G1'],
    confidence: 0.9,
    hint: '目标「子目标」已 10 天没有推进记录；确认它是否已完成。',
    rationale: 'depth-1 goal "子目标" has had no aligned activity for 10.0 days.',
  })
  const line = level1Hint(signal)
  check('level1Hint 含 hint 原文', line.includes('已 10 天没有推进记录'), line)
  check('level1Hint 不含 rationale', !line.includes('depth-1'), line)
  check('level1Hint 不含内部信号类型', !line.includes('goal_staleness'), line)

  const legacy = DriftSignalSchema.parse({
    id: 'sig_2',
    projectId,
    observedAt: minutesAgo(1),
    monitorCategory: 'goal_alignment',
    signalType: 'scope_drift',
    level: 1,
    relatedGoalIds: ['G1'],
    confidence: 0.9,
    rationale: 'grade A activity "x" was judged out of scope with confidence 0.80.',
  })
  const legacyLine = level1Hint(legacy)
  check('没有 hint 的旧信号用中文兜底', CHINESE.test(legacyLine) && legacyLine.includes('check_drift'), legacyLine)
  check('旧信号也不会把 rationale 塞进 prompt', !legacyLine.includes('grade A activity'), legacyLine)

  const record = InterventionRecordSchema.parse({
    id: 'iv_1',
    projectId,
    signalId: 'sig_1',
    level: 2,
    promptSummary: 'scope_drift near goal G1: grade A activity ...',
    hint: '同类问题重复出现，打开一张待决定卡片；用 check_drift 查看详情。',
    createdAt: minutesAgo(1),
  })
  const recordLine = pendingInterventionHint(record)
  check('pending 提示优先用 hint', recordLine.includes('同类问题重复出现'), recordLine)
  check('pending 提示不回退到 promptSummary', !recordLine.includes('scope_drift'), recordLine)

  const legacyRecord = InterventionRecordSchema.parse({
    id: 'iv_2',
    projectId,
    signalId: 'sig_1',
    level: 2,
    promptSummary: 'scope_drift near goal G1: grade A activity ...',
    createdAt: minutesAgo(1),
  })
  const legacyRecordLine = pendingInterventionHint(legacyRecord)
  check('旧卡片用中文兜底', CHINESE.test(legacyRecordLine) && legacyRecordLine.includes('resolve_intervention'), legacyRecordLine)
  check('旧卡片也不回退到 promptSummary', !legacyRecordLine.includes('scope_drift'), legacyRecordLine)
}

console.log('\n=== H5: 长度上限与覆盖率解释 ===')
{
  check('长度上限是 60', HINT_MAX_CHARS === 60, String(HINT_MAX_CHARS))
  const clamped = clampHint('很长的提示'.repeat(30))
  check('超长 hint 被截断', clamped.length === 60, `${clamped.length}`)
  check('截断有标记', clamped.endsWith('…'), clamped)
  check('不超长的 hint 原样返回', clampHint('短提示') === '短提示')

  const noPlan = coverageHint(0.25, 0.4, false)
  checkHint('coverage/无计划', noPlan)
  check('无计划时说明缺少声明', noPlan.includes('没有声明计划'), noPlan)
  check('无计划时给出声明工具', noPlan.includes('metacog_declare_plan'), noPlan)
  check('无计划时给出覆盖率数字', noPlan.includes('25%'), noPlan)

  const withPlan = coverageHint(0.25, 0.4, true)
  checkHint('coverage/有计划', withPlan)
  check('有计划时说明覆盖率不足', withPlan.includes('覆盖率'), withPlan)
  check('覆盖率足够时不解释', coverageHint(0.5, 0.4, false) === undefined)
}

console.log('\n=== H6: 旧数据兼容 ===')
{
  const parsedSignal = DriftSignalSchema.parse({
    id: 'sig_old',
    projectId,
    observedAt: minutesAgo(1),
    monitorCategory: 'goal_alignment',
    signalType: 'scope_drift',
    level: 1,
    confidence: 0.8,
    rationale: 'old technical sentence',
  })
  check('旧信号没有 hint 也能解析', parsedSignal.hint === undefined)
  const parsedRecord = InterventionRecordSchema.parse({
    id: 'iv_old',
    projectId,
    signalId: 'sig_old',
    level: 2,
    promptSummary: 'old technical summary',
    createdAt: minutesAgo(1),
  })
  check('旧卡片没有 hint 也能解析', parsedRecord.hint === undefined)
}

console.log(`\n=== Hint 结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
