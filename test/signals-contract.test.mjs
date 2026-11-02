/**
 * Milestone 0 contract test: the signal aggregation, the EMA and the level
 * decision must behave the way the design doc says they do.
 *
 * These are the numbers a later milestone will be built on, and most of them
 * were derived by hand into prose first. So the assertions here are written
 * against *computed* values rather than against whatever the implementation
 * happens to return — a test that echoes the implementation proves nothing when
 * the thing under test is a formula.
 *
 * Run: node test/signals-contract.test.mjs
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const modUrl = pathToFileURL(join(here, '..', 'lib', 'data', 'signals.js')).href
const signals = await import(modUrl)

const {
  aggregateStep,
  advanceEma,
  decideLevelFromScore,
  DIMENSION_WEIGHTS,
  DIMENSION_SIGNALS,
} = signals

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

function close(label, actual, expected, tolerance = 1e-9) {
  const ok = typeof actual === 'number' && Math.abs(actual - expected) <= tolerance
  check(label, ok, `expected ${expected}, got ${actual}`)
}

/** Shorthand for an available signal score. */
const ok = (signal, score) => ({ status: 'available', signal, score, evidence: [] })
/** Shorthand for an absent signal score. */
const na = (signal, reason = 'no_declared_plan') => ({ status: 'not_applicable', signal, reason, detail: '' })

const THRESHOLDS = {
  thetaHintScore: 0.5,
  thetaCardScore: 0.875,
  consecutiveStepsForCard: 3,
  coverageFloor: 0.4,
}

console.log('\n[1] dimension coverage can only take five values')

// The doc claims {0, 0.25, 0.5, 0.75, 1}. Prove it by enumerating every
// non-empty subset of the three dimensions.
const dims = Object.keys(DIMENSION_WEIGHTS)
const seen = new Set()
for (let mask = 0; mask < 1 << dims.length; mask += 1) {
  const scores = []
  for (let i = 0; i < dims.length; i += 1) {
    const signal = DIMENSION_SIGNALS[dims[i]][0]
    scores.push((mask >> i) & 1 ? ok(signal, 0.6) : na(signal))
  }
  const agg = aggregateStep(scores)
  seen.add(Number(agg.coverage.toFixed(10)))
}
check(
  'coverage takes exactly five distinct values',
  JSON.stringify([...seen].sort((a, b) => a - b)) === JSON.stringify([0, 0.25, 0.5, 0.75, 1]),
  JSON.stringify([...seen].sort((a, b) => a - b)),
)

console.log('\n[2] the coverage floor admits plan+progress, not just scope')

const planAndProgress = aggregateStep([na('s3_tool_novel'), na('s2_class'), ok('s4_plan_match', 0.9), ok('s5_progress', 0.9)])
close('S4+S5 coverage is 0.50', planAndProgress.coverage, 0.5)
check('S4+S5 clears coverageFloor 0.4 (so the doc\'s claim holds)', planAndProgress.coverage >= THRESHOLDS.coverageFloor)

const planOnly = aggregateStep([na('s3_tool_novel'), na('s2_class'), ok('s4_plan_match', 0.9)])
close('S4 alone coverage is 0.25', planOnly.coverage, 0.25)
check('S4 alone is blocked by the floor', planOnly.coverage < THRESHOLDS.coverageFloor)
check('S5 alone is also blocked by the floor', aggregateStep([ok('s5_progress', 0.9)]).coverage < THRESHOLDS.coverageFloor)

console.log('\n[3] a dimension takes the max of its signals, not the mean')

// scope is S3 + S2. One out-of-scope tool must not be diluted by an in-scope class.
const scopeMax = aggregateStep([ok('s3_tool_novel', 1), ok('s2_class', 0)])
close('scope score is max(1, 0) = 1', scopeMax.dimensions.find((d) => d.dimension === 'scope').score, 1)

console.log('\n[4] riskScore is the weighted mean over AVAILABLE dimensions only')

const allThree = aggregateStep([ok('s3_tool_novel', 1), ok('s4_plan_match', 0), ok('s5_progress', 0)])
// (0.5*1 + 0.25*0 + 0.25*0) / 1.0 = 0.5
close('scope-only drift with full coverage scores 0.5', allThree.riskScore, 0.5)

const scopeOnly = aggregateStep([ok('s3_tool_novel', 1)])
// (0.5*1) / 0.5 = 1  -- the divisor is available weight, not total weight
close('scope-only drift with 0.5 coverage still scores 1.0', scopeOnly.riskScore, 1)

check('riskScore is null when nothing is measurable', aggregateStep([na('s3_tool_novel')]).riskScore === null)

console.log('\n[5] a step with no signal carries the previous EMA forward')

const empty = aggregateStep([])
close('advanceEma leaves final unchanged on a null step', advanceEma(0.7, empty, 0.4), 0.7)
check(
  'decay on missing data would have changed it (this is the behaviour being ruled out)',
  Math.abs(0.4 * 0.7 - 0.7) > 1e-9,
)

console.log('\n[6] the EMA response curve, recomputed from the recurrence')

function curve(seq, beta = 0.4, initial = 0) {
  let final = initial
  const out = []
  for (const r of seq) {
    const agg = r === null ? aggregateStep([]) : aggregateStep([ok('s3_tool_novel', r)])
    final = advanceEma(final, agg, beta)
    out.push(Number(final.toFixed(4)))
  }
  return out
}

// Doc table: single-step burst peaks at 0.400 then decays.
// Compared at 3 decimals because the doc table rounds there; comparing the
// 4-decimal values would fail on the doc's own rounding, not on a real defect.
check(
  'single-step burst: 0.400, 0.240, 0.144, 0.086, 0.052',
  JSON.stringify(curve([1, 0, 0, 0, 0]).map((v) => Number(v.toFixed(3)))) ===
    JSON.stringify([0.4, 0.24, 0.144, 0.086, 0.052]),
)
// Doc table: sustained r=1 climbs 0.400, 0.640, 0.784, 0.870, 0.922.
check(
  'sustained drift: 0.400, 0.640, 0.784, 0.870, 0.922',
  JSON.stringify(curve([1, 1, 1, 1, 1]).map((v) => Number(v.toFixed(3)))) ===
    JSON.stringify([0.4, 0.64, 0.784, 0.87, 0.922]),
)

console.log('\n[7] the doc\'s "card opens at step 7" claim')

const sustained = curve([1, 1, 1, 1, 1, 1, 1, 1, 1], 0.4)
let firstHigh = null
for (let i = 0; i < sustained.length; i += 1) {
  if (sustained[i] >= THRESHOLDS.thetaCardScore) {
    firstHigh = i + 1
    break
  }
}
check('first step at or above thetaCardScore is step 5', firstHigh === 5, `got ${firstHigh}`)

// Level 2 also needs consecutive steps; find the first window of 3.
let firstCard = null
for (let i = 2; i < sustained.length; i += 1) {
  if (
    sustained[i] >= THRESHOLDS.thetaCardScore &&
    sustained[i - 1] >= THRESHOLDS.thetaCardScore &&
    sustained[i - 2] >= THRESHOLDS.thetaCardScore
  ) {
    firstCard = i + 1
    break
  }
}
check('the first 3-consecutive window completes at step 7', firstCard === 7, `got ${firstCard}`)

const fast = curve([1, 1, 1, 1, 1, 1, 1, 1, 1], 0.5)
check('with beta=0.5 the card threshold is met by step 3', fast[2] >= THRESHOLDS.thetaCardScore, `got ${fast[2]}`)

console.log('\n[8] single-step burst never reaches Level 1')

{
  const agg = aggregateStep([ok('s3_tool_novel', 1)])
  const final = advanceEma(0, agg, 0.4)
  close('burst peak is 0.400', final, 0.4)
  check('and 0.400 is below thetaHintScore 0.500', final < THRESHOLDS.thetaHintScore)
  check('so decideLevelFromScore returns 0', decideLevelFromScore(final, agg, 1, THRESHOLDS) === 0)
}

console.log('\n[9] the coverage floor is checked inside decideLevelFromScore')

{
  const agg = aggregateStep([ok('s4_plan_match', 1)])
  close('plan-only coverage is 0.25', agg.coverage, 0.25)
  check(
    'a perfect score with 0.25 coverage still cannot escalate',
    decideLevelFromScore(1, agg, 99, THRESHOLDS) === 0,
  )
}

console.log('\n[10] level assignment follows the band table')

{
  const agg = aggregateStep([ok('s3_tool_novel', 0.6), ok('s4_plan_match', 0.6), ok('s5_progress', 0.6)])
  close('full coverage', agg.coverage, 1)
  check('final 0.49 is L0', decideLevelFromScore(0.49, agg, 99, THRESHOLDS) === 0)
  check('final 0.50 is L1', decideLevelFromScore(0.5, agg, 99, THRESHOLDS) === 1)
  check('final 0.87 is L1', decideLevelFromScore(0.87, agg, 99, THRESHOLDS) === 1)
  check('final 0.875 with 3 consecutive highs is L2', decideLevelFromScore(0.875, agg, 3, THRESHOLDS) === 2)
  check('final 0.875 with only 2 consecutive highs is L1', decideLevelFromScore(0.875, agg, 2, THRESHOLDS) === 1)
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
