/**
 * Function F acceptance: the judgement log as a measure of rule quality.
 *
 * The numbers here are the plugin's only answer to "are the rules getting better",
 * so the arithmetic has to be right at the boundaries: no settled samples, exactly
 * the sample floor, and a rule that is perfect.
 *
 * Run: node test/selfaudit.test.mjs
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const url = pathToFileURL(join(here, '..', 'lib', 'analysis', 'selfaudit.js')).href

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

const { assessRules, MIN_RULE_SAMPLES } = await import(url)

/** Build n records of one signal type with a given outcome. */
function make(signalType, status, count, startIndex = 0) {
  return Array.from({ length: count }, (_, index) => ({
    id: `jdg_${signalType}_${status}_${startIndex + index}`,
    projectId: 'p',
    createdAt: '2026-10-28T00:00:00.000Z',
    activityIds: [],
    signalType,
    summary: 's',
    programReason: 'r',
    status,
    notified: false,
  }))
}

console.log('\n=== F1: 空日志 ===')
{
  const rows = assessRules([])
  check('没有规则行', rows.length === 0)
  check('没有行可渲染', rows.length === 0)
}

console.log('\n=== F2: 误报率与判定 ===')
{
  const rows = assessRules([
    ...make('scope_drift', 'dismissed', 18),
    ...make('scope_drift', 'confirmed', 2),
  ])
  const row = rows[0]
  check('只有一行', rows.length === 1)
  check('候选数为 20', row.candidates === 20, String(row.candidates))
  check('误报率为 0.9', row.falsePositiveRate === 0.9, String(row.falsePositiveRate))
  check('判为噪声', row.verdict === 'noisy', row.verdict)
}

console.log('\n=== F3: 样本不足不下结论 ===')
{
  const rows = assessRules(make('goal_staleness', 'dismissed', MIN_RULE_SAMPLES - 1))
  check('判为样本不足', rows[0].verdict === 'insufficient', rows[0].verdict)
}

console.log('\n=== F4: 恰好到样本下限即可判定 ===')
{
  const good = assessRules(make('core_bypass', 'confirmed', MIN_RULE_SAMPLES))
  check('零误报判为健康', good[0].verdict === 'healthy', good[0].verdict)
  check('误报率为 0', good[0].falsePositiveRate === 0, String(good[0].falsePositiveRate))
}

console.log('\n=== F5: 待复核的不计入误报率 ===')
{
  const rows = assessRules([
    ...make('scope_drift', 'dismissed', 4),
    ...make('scope_drift', 'confirmed', 6),
    ...make('scope_drift', 'pending', 9),
  ])
  const row = rows[0]
  check('候选数包含待定', row.candidates === 19, String(row.candidates))
  check('待定单独计数', row.pending === 9, String(row.pending))
  check('误报率只算已结算', row.falsePositiveRate === 0.4, String(row.falsePositiveRate))
}

console.log('\n=== F6: 噪声高的规则排在前面 ===')
{
  const rows = assessRules([
    ...make('a_clean', 'confirmed', 12),
    ...make('b_noisy', 'dismissed', 12),
  ])
  check('第一行是噪声规则', rows[0].signalType === 'b_noisy', rows[0].signalType)
  check('两行都在', rows.length === 2)
}

console.log('\n=== F7: 整体误报率 ===')
{
  const rows = assessRules([
    ...make('x', 'dismissed', 6),
    ...make('y', 'confirmed', 2),
  ])
  // The overall rate is the pooled share of rejections across every rule, not the
  // mean of the per-rule rates: a rule with 2 candidates must not weigh the same
  // as one with 100. Computed here from the rows, because the helper that used to
  // do it had no production caller.
  const dismissed = rows.reduce((sum, row) => sum + (row.dismissed ?? 0), 0)
  const settled = rows.reduce((sum, row) => sum + (row.dismissed ?? 0) + (row.confirmed ?? 0), 0)
  const overall = settled === 0 ? null : dismissed / settled
  check('整体为 0.75', overall === 0.75, String(overall))
}

console.log(`\n=== Selfaudit 结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
