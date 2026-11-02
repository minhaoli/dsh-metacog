/**
 * Milestone C calibration: measuring the rules, and refusing to lie about them.
 *
 * The dangerous failure here is not an error — it is a plausible number. Platt
 * scaling fitted on a single-class sample produces a curve that maps everything
 * to ~0, and if that curve is stored as "the calibration" then every threshold
 * derived from it is wrong in a way nobody can see. Most of these tests are about
 * the refusal path for that reason.
 *
 * The fit itself is checked against a synthetic dataset with a known generating
 * function, so "did it recover the parameters" is answerable rather than "did it
 * return something".
 *
 * Run: node test/calibration.test.mjs   (after `npm run build`)
 */
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (p) => pathToFileURL(join(here, '..', 'lib', p)).href

const {
  MIN_CALIBRATION_SAMPLES,
  MIN_PER_CLASS,
  describeCalibration,
  extractCalibrationSamples,
  fitCalibration,
  reliabilityTable,
} = await import(lib('analysis/calibrate.js'))

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

/** A judgement record with just the fields this module reads. */
function record({ status, score, draftScore = true, createdAt = '2026-10-01T00:00:00.000Z' }) {
  return {
    id: 'j_' + Math.random().toString(36).slice(2, 8),
    projectId: 'p',
    createdAt,
    activityIds: [],
    signalType: 'scope_drift',
    summary: '',
    programReason: '',
    ...(draftScore && score !== undefined ? { draft: { score } } : {}),
    status,
  }
}

console.log('\n[refusal] no fit without both classes')

{
  // The plugin's real history at the time of writing: many dismissals, zero
  // confirmations. This must be refused, not fitted.
  const onlyNegatives = Array.from({ length: 200 }, (_, i) =>
    record({ status: 'dismissed', score: (i % 10) / 10 }),
  )
  const outcome = fitCalibration(extractCalibrationSamples(onlyNegatives))
  check('a single-class log is refused', outcome.status === 'insufficient', JSON.stringify(outcome.status))
  check('and the reason names the class problem', outcome.reason === 'single-class', outcome.reason)
  check('the counts are reported', outcome.negatives === 200 && outcome.positives === 0, JSON.stringify([outcome.positives, outcome.negatives]))
  check('and no curve is produced', outcome.a === undefined && outcome.b === undefined)

  const empty = fitCalibration([])
  check('an empty log is refused', empty.status === 'insufficient' && empty.reason === 'not-enough-samples', empty.reason)
}

{
  // Both classes present, but the positives are too few to identify a slope.
  const samples = [
    ...Array.from({ length: 100 }, (_, i) => ({ score: (i % 10) / 10, positive: false, at: '2026-10-01T00:00:00.000Z' })),
    ...Array.from({ length: 2 }, (_, i) => ({ score: 0.9 - i * 0.1, positive: true, at: '2026-10-02T00:00:00.000Z' })),
  ]
  const outcome = fitCalibration(samples)
  check('too few positives is refused', outcome.status === 'insufficient', outcome.status)
  check('with the specific shortfall', outcome.reason === 'not-enough-positives', outcome.reason)
}

{
  // Total is large enough but one class is under the floor.
  const samples = [
    ...Array.from({ length: MIN_CALIBRATION_SAMPLES }, (_, i) => ({ score: (i % 10) / 10, positive: false, at: '2026-10-01T00:00:00.000Z' })),
    ...Array.from({ length: MIN_PER_CLASS - 1 }, (_, i) => ({ score: 0.8 + i * 0.01, positive: true, at: '2026-10-02T00:00:00.000Z' })),
  ]
  const outcome = fitCalibration(samples)
  check('a class under the per-class floor is refused', outcome.status === 'insufficient', outcome.status)
}

console.log('\n[fit] recovers a known generating function')

{
  // Generate from p = sigmoid(4*score - 2) with a fixed pseudo-random stream, so
  // the test is deterministic and the true parameters are known.
  let seed = 12345
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const TRUE_A = 4
  const TRUE_B = -2
  const samples = []
  for (let i = 0; i < 600; i += 1) {
    const score = rand()
    const p = 1 / (1 + Math.exp(-(TRUE_A * score + TRUE_B)))
    samples.push({ score, positive: rand() < p, at: '2026-10-01T00:00:00.000Z' })
  }
  const outcome = fitCalibration(samples)
  check('it fits', outcome.status === 'fitted', JSON.stringify(outcome.status))
  check(
    'the slope is close to the generating value',
    Math.abs(outcome.a - TRUE_A) < 1.2,
    `a=${outcome.a?.toFixed(2)} expected ~${TRUE_A}`,
  )
  check(
    'the intercept is close to the generating value',
    Math.abs(outcome.b - TRUE_B) < 0.8,
    `b=${outcome.b?.toFixed(2)} expected ~${TRUE_B}`,
  )
  check('the fit reports its sample counts', outcome.samples === 600 && outcome.positives > 100 && outcome.negatives > 100, JSON.stringify([outcome.samples, outcome.positives, outcome.negatives]))

  // A higher score must map to a higher probability. This is the one property
  // the whole rest of the plugin relies on: riskScore already promises an
  // ordering, and calibration must not destroy it. The sigmoid is applied here
  // rather than by a helper, because nothing consumes a fitted curve yet — the
  // property belongs to the coefficients, and asserting on them is what keeps
  // this honest.
  const sigmoid = (score) => 1 / (1 + Math.exp(-(outcome.a * score + outcome.b)))
  const low = sigmoid(0.1)
  const mid = sigmoid(0.5)
  const high = sigmoid(0.9)
  check(
    'the map is monotone increasing',
    low < mid && mid < high,
    [low.toFixed(3), mid.toFixed(3), high.toFixed(3)].join(' / '),
  )
  check('every output is a probability', [low, mid, high].every((p) => p > 0 && p < 1))
}

console.log('\n[samples] only settled records with a stored score count')

{
  const records = [
    record({ status: 'pending', score: 0.9 }),
    record({ status: 'confirmed', score: 0.8 }),
    record({ status: 'dismissed', score: 0.2 }),
    record({ status: 'dismissed', score: undefined }),
    record({ status: 'dismissed', score: 0.5, draftScore: false }),
  ]
  const samples = extractCalibrationSamples(records)
  check('a pending record contributes nothing', samples.every((s) => s.score !== 0.9))
  check('only two of the five records yield a sample', samples.length === 2, String(samples.length))
  check('confirmed becomes positive', samples.some((s) => s.positive && s.score === 0.8))
  check('dismissed becomes negative', samples.some((s) => !s.positive && s.score === 0.2))
  check(
    'a record with no numeric score is skipped, not guessed',
    samples.every((s) => typeof s.score === 'number'),
  )
}

console.log('\n[reliability] the descriptive table')

{
  const samples = [
    { score: 0.05, positive: false, at: '2026-10-01T00:00:00.000Z' },
    { score: 0.15, positive: false, at: '2026-10-01T00:00:00.000Z' },
    { score: 0.95, positive: true, at: '2026-10-01T00:00:00.000Z' },
    { score: 1.0, positive: true, at: '2026-10-01T00:00:00.000Z' },
  ]
  const table = reliabilityTable(samples, 5)
  check('it returns one row per bucket', table.length === 5, String(table.length))
  check('an empty bucket has no rate rather than 0', table[2].rate === null, String(table[2].rate))
  check('the low bucket has no positives', table[0].positives === 0 && table[0].total === 2)
  check(
    'a score of exactly 1 lands in the top bucket',
    table[4].total === 2 && table[4].positives === 2,
    JSON.stringify(table[4]),
  )
}

console.log('\n[describe] one line the report can print')

{
  const refused = fitCalibration([{ score: 0.5, positive: false, at: '2026-10-01T00:00:00.000Z' }])
  const line = describeCalibration(refused, [{ score: 0.5, positive: false, at: '2026-10-01T00:00:00.000Z' }])
  check('a refusal says 未启用', line.includes('未启用'), line)
  check('and states what is missing', line.includes('正类') && line.includes('负类'), line)
  check('it does not claim a number it does not have', !line.includes('已拟合'), line)
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
