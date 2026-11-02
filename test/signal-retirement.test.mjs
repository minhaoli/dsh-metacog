/**
 * S2 is retired from scoring, not deleted from the pipeline.
 *
 * The claim defended here is narrow and deliberate: the class-drift number is
 * still computed, still readable, and takes no part in the decision. Its old
 * behaviour was structural, not a threshold problem — the baseline is the first
 * five steps, so "read for a while, then write" has an empty intersection with
 * it, `1 - Jaccard` returns 1.0, and at scope weight 0.5 that lands exactly on
 * `thetaHintScore`. A normal session was told it had drifted before doing
 * anything wrong.
 *
 * The last block pins the consequence that was accepted along with it: with no
 * declared plan, the only measurable dimension left is progress at 0.25, which
 * is under the coverage floor, so the deterministic layer cannot escalate at
 * all. That is on purpose — work that never declared an intent has not been
 * shown to deviate from one — but it is a behaviour change and it is asserted
 * here so nobody later reads it as a bug.
 *
 * Run: node test/signal-retirement.test.mjs   (after `npm run build`)
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (path) => pathToFileURL(join(here, '..', 'lib', path)).href

const { aggregateStep, decideLevelFromScore, RETIRED_SIGNALS, DIMENSION_WEIGHTS } = await import(
  lib('data/signals.js')
)
const { scoreClassDrift } = await import(lib('analysis/signals/index.js'))
const { scoreTurn } = await import(lib('analysis/score.js'))
const { parseConfig } = await import(lib('config.js'))

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

const config = parseConfig({})
const thresholds = {
  thetaHintScore: config.signals.thetaHintScore,
  thetaCardScore: config.signals.thetaCardScore,
  consecutiveStepsForCard: config.signals.consecutiveStepsForCard,
  coverageFloor: config.signals.coverageFloor,
}
const ema = { beta: config.signals.emaBeta, initial: 0 }

/** An available score. */
const ok = (signal, score) => ({ status: 'available', signal, score, evidence: [`${signal}: ${score}`] })
/** A signal that could not be computed. */
const na = (signal, reason) => ({ status: 'not_applicable', signal, reason, detail: '' })

// ------------------------------------------------------------------ the fix

console.log('\n[R1] a retired signal cannot set the scope dimension')

{
  check('s2_class is the retired signal', RETIRED_SIGNALS.has('s2_class'))
  check('s3_tool_novel is not', !RETIRED_SIGNALS.has('s3_tool_novel'))

  // The exact failure being retired: S2 at 1.0 beside an honest S3 of 0.
  const aggregate = aggregateStep([ok('s3_tool_novel', 0), ok('s2_class', 1)])
  const scope = aggregate.dimensions.find((entry) => entry.dimension === 'scope')
  check('scope stays at the honest S3 score', scope?.score === 0, JSON.stringify(scope))
  check('the scope weight is unchanged', scope?.weight === DIMENSION_WEIGHTS.scope, String(scope?.weight))

  const carried = aggregate.retired.find((entry) => entry.signal === 's2_class')
  check('the retired score is carried out', carried?.score === 1, JSON.stringify(carried))
  check('with the evidence it was computed from', carried?.evidence[0] === 's2_class: 1', JSON.stringify(carried?.evidence))
  check('and it never appears as a dimension', aggregate.dimensions.every((entry) => entry.score !== 1))

  // A retired signal alone must not make the dimension available at all: that
  // would restore 0.5 of weight to a signal that decides nothing.
  const onlyRetired = aggregateStep([ok('s2_class', 1)])
  check('a retired signal alone leaves scope unavailable', onlyRetired.dimensions.length === 0)
  check('so the step has no measurable risk', onlyRetired.riskScore === null)
  check('and no coverage', onlyRetired.coverage === 0)
  check('and it is not reported as absent either', onlyRetired.absent.length === 0)

  // Retiring is not deleting: the detector still runs.
  // Baseline is the first five steps and the comparison set is the last five,
  // so a session that read five files and then wrote five is the maximal case.
  const drift = scoreClassDrift([
    'READ', 'READ', 'READ', 'READ', 'READ',
    'WRITE', 'WRITE', 'WRITE', 'WRITE', 'WRITE',
  ])
  check('the class-drift detector still computes', drift.status === 'available', JSON.stringify(drift))
  check('and still reports the read-to-write jump as maximal', drift.score === 1, String(drift.score))
}

// ------------------------------------------------- the accepted consequence

console.log('\n[R1] without a plan the deterministic layer cannot escalate')

{
  const noPlan = aggregateStep([
    ok('s5_progress', 1),
    ok('s2_class', 1),
    na('s3_tool_novel', 'no_allowed_tools'),
    na('s4_plan_match', 'no_declared_plan'),
  ])
  check('coverage is the progress weight alone', Math.abs(noPlan.coverage - 0.25) < 1e-9, String(noPlan.coverage))
  check('which is under the floor', noPlan.coverage < thresholds.coverageFloor, String(noPlan.coverage))
  check('so even a perfect risk score cannot hint', decideLevelFromScore(1, noPlan, 3, thresholds) === 0)

  // End to end through the scorer, with a turn long enough for S2 to reach its
  // maximum: five reads establish the baseline, five writes are the recent set,
  // the two share no class, so `1 - Jaccard` is exactly 1.0. This is the ordinary
  // read-then-write session that used to be told it had drifted.
  const reads = ['read', 'read', 'read', 'read', 'read']
  const writes = ['write', 'write', 'write', 'write', 'write']
  const activity = {
    summary: '读了五个文件后开始写代码',
    evidence: ['src/a.ts'],
    grade: 'A',
    sessionId: 'session-retirement',
    fingerprint: 'turn:session-retirement:1',
    source: 'turn',
    toolNames: [...reads, ...writes],
    toolResults: [],
    toolPaths: [...reads, ...writes].map((_, index) => [`src/f${index}.ts`]),
  }
  const turn = scoreTurn(activity, 'proj-retirement', undefined, undefined, [], ema, thresholds, new Date())

  check('every step is scored', turn.steps.length === 10, String(turn.steps.length))
  check(
    'every step reports 0.25 coverage',
    turn.steps.every((step) => Math.abs(step.aggregate.coverage - 0.25) < 1e-9),
    JSON.stringify(turn.steps.map((step) => step.aggregate.coverage)),
  )
  const last = turn.steps[9]
  check('S2 was measured on the last step', last?.aggregate.retired.some((entry) => entry.signal === 's2_class'))
  check(
    'and scored 1.0 there — the old false positive',
    last?.aggregate.retired.find((entry) => entry.signal === 's2_class')?.score === 1,
    JSON.stringify(last?.aggregate.retired),
  )
  check('yet no step escalates', turn.peakLevel === 0, String(turn.peakLevel))
  check('and every level is zero', turn.steps.every((step) => step.level === 0))
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
