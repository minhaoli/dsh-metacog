/**
 * End-to-end checks on the compiled contract: schema behaviour at the edges,
 * plus two realistic drift runs.
 *
 * Separate from `test/signals-contract.test.mjs` because that one asserts the
 * arithmetic of single calls; this one asserts that a plan a user would actually
 * write survives validation, and that a sustained drift of the shape we expect
 * lands at the level the doc promises.
 *
 * Run: node scripts/probe-signals.mjs   (after `npm run build`)
 */
import { DeclaredPlanSchema, SignalScoreSchema, aggregateStep, advanceEma, decideLevelFromScore } from '../lib/data/signals.js'

let pass = 0
let fail = 0
const chk = (label, condition, detail) => {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${label}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` -- ${detail}`}`)
  }
}

const THRESHOLDS = { thetaHintScore: 0.5, thetaCardScore: 0.875, consecutiveStepsForCard: 3, coverageFloor: 0.4 }

console.log('\n[zod] DeclaredPlan accepts a minimal valid plan')
const minimal = { id: 'p1', goal: '加元认知监控', declaredAt: new Date().toISOString() }
const r1 = DeclaredPlanSchema.safeParse(minimal)
chk('minimal plan parses', r1.success, JSON.stringify(r1.error?.issues))
chk('allowedTools defaults to []', r1.success && Array.isArray(r1.data.allowedTools) && r1.data.allowedTools.length === 0)
chk('steps defaults to []', r1.success && Array.isArray(r1.data.steps) && r1.data.steps.length === 0)

console.log('\n[zod] malformed plans are refused')
chk('missing goal is rejected', !DeclaredPlanSchema.safeParse({ id: 'p1', declaredAt: '2026-01-01T00:00:00Z' }).success)
chk('bad linkedGoalId is rejected', !DeclaredPlanSchema.safeParse({ ...minimal, linkedGoalId: 'has space/bad' }).success)
chk('unknown assert value is rejected', !DeclaredPlanSchema.safeParse({ ...minimal, steps: [{ intent: 'x', expects: { assert: 'tests-greenish' } }] }).success)

console.log('\n[zod] a step with an empty expects object is permitted by the schema')
chk(
  'schema permits expects:{}; the "never completes" rule lives in the matcher',
  DeclaredPlanSchema.safeParse({ ...minimal, steps: [{ intent: '看看情况', expects: {} }] }).success,
)

console.log('\n[zod] SignalScore discriminates on status')
chk('available parses', SignalScoreSchema.safeParse({ status: 'available', signal: 's3_tool_novel', score: 0.5 }).success)
chk('not_applicable without a reason is rejected', !SignalScoreSchema.safeParse({ status: 'not_applicable', signal: 's3_tool_novel' }).success)
chk(
  'not_applicable with a reason parses',
  SignalScoreSchema.safeParse({ status: 'not_applicable', signal: 's3_tool_novel', reason: 'no_allowed_tools' }).success,
)
chk('score above 1 is rejected', !SignalScoreSchema.safeParse({ status: 'available', signal: 's3_tool_novel', score: 1.5 }).success)
chk('negative score is rejected', !SignalScoreSchema.safeParse({ status: 'available', signal: 's3_tool_novel', score: -0.1 }).success)
chk('unknown signal id is rejected', !SignalScoreSchema.safeParse({ status: 'available', signal: 's9_made_up', score: 0.5 }).success)

console.log('\n[end-to-end] sustained full-coverage drift reaches Level 2 at step 7')
{
  let final = 0
  let consecutive = 0
  let firstL2 = null
  for (let step = 1; step <= 9; step += 1) {
    const agg = aggregateStep([
      { status: 'available', signal: 's3_tool_novel', score: 1, evidence: [] },
      { status: 'available', signal: 's2_class', score: 1, evidence: [] },
      { status: 'available', signal: 's4_plan_match', score: 1, evidence: [] },
      { status: 'available', signal: 's5_progress', score: 1, evidence: [] },
    ])
    final = advanceEma(final, agg, 0.4)
    consecutive = final >= THRESHOLDS.thetaCardScore ? consecutive + 1 : 0
    const level = decideLevelFromScore(final, agg, consecutive, THRESHOLDS)
    if (level === 2 && firstL2 === null) firstL2 = step
  }
  chk('first Level 2 at step 7', firstL2 === 7, `got ${firstL2}`)
}

console.log('\n[end-to-end] a plan-declaring session with no tool whitelist cannot escalate')
{
  // Only S4 available: coverage 0.25, below the floor, no matter the score.
  const agg = aggregateStep([{ status: 'available', signal: 's4_plan_match', score: 1, evidence: [] }])
  const level = decideLevelFromScore(1, agg, 99, THRESHOLDS)
  chk('coverage 0.25 keeps the level at 0 even with a perfect score', level === 0, `coverage=${agg.coverage}`)
}

console.log('\n[end-to-end] scope-only drift does escalate, because coverage 0.5 clears the floor')
{
  let final = 0
  let consecutive = 0
  for (let step = 1; step <= 10; step += 1) {
    const agg = aggregateStep([{ status: 'available', signal: 's3_tool_novel', score: 1, evidence: [] }])
    final = advanceEma(final, agg, 0.4)
    consecutive = final >= THRESHOLDS.thetaCardScore ? consecutive + 1 : 0
  }
  chk('scope-only sustained drift does reach the 3-consecutive condition', consecutive >= 3, `consecutive=${consecutive}`)
}

console.log('\n[end-to-end] an all-empty step carries the score rather than clearing it')
{
  let final = 0
  const drift = aggregateStep([{ status: 'available', signal: 's3_tool_novel', score: 1, evidence: [] }])
  final = advanceEma(final, drift, 0.4)
  const before = final
  final = advanceEma(final, aggregateStep([]), 0.4)
  chk('a step with no signal leaves final unchanged', Math.abs(final - before) < 1e-12, `${before} -> ${final}`)
}

console.log(`\npassed ${pass}, failed ${fail}`)
process.exit(fail === 0 ? 0 : 1)
