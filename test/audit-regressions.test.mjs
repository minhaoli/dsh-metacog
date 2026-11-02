/**
 * Regression tests for the five defects the audit found.
 *
 * Each case here was a real behaviour, reproduced before the fix and pinned after
 * it. The point is not coverage in the abstract — every one of these was live in
 * code that already had a green suite, so each assertion is written to fail loudly
 * if the defect comes back.
 *
 * Run: node test/audit-regressions.test.mjs   (after `npm run build`)
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (p) => pathToFileURL(join(here, '..', 'lib', p)).href

const { scorePlanMatch } = await import(lib('analysis/signals/plan.js'))
const { scoreProgress } = await import(lib('analysis/signals/index.js'))
const { advanceSignalState, aggregateStep } = await import(lib('data/signals.js'))

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

const EMA = { beta: 0.4, initial: 0 }
const TH = { thetaHintScore: 0.5, thetaCardScore: 0.875, consecutiveStepsForCard: 3, coverageFloor: 0.4 }

console.log('\n[S4] an optional step in the middle does not shift the windows')

// Filtering to a bare array and indexing by the filtered position made the third
// step read the second window: a plan carried out completely scored 0.5.
{
  const plan = {
    id: 'p',
    goal: 'g',
    allowedTools: [],
    declaredAt: 'x',
    steps: [
      { intent: 'A edit', expects: { tool: 'edit' }, optional: false },
      { intent: 'B read', expects: { tool: 'read' }, optional: true },
      { intent: 'C pwsh', expects: { tool: 'pwsh' }, optional: false },
    ],
  }
  const windows = [
    { tools: ['edit'], paths: [], results: [] },
    { tools: ['read'], paths: [], results: [] },
    { tools: ['pwsh'], paths: [], results: [] },
  ]
  const r = scorePlanMatch(plan, windows)
  check('all three steps done scores 0', r.score.score === 0, String(r.score.score))
  check('the verdict carries the plan position, not the filtered one', r.verdicts[1].index === 2, String(r.verdicts[1].index))
  check('and names the right step', r.verdicts[1].intent === 'C pwsh')
}

{
  // Optional first: the required steps must still line up.
  const plan = {
    id: 'p',
    goal: 'g',
    allowedTools: [],
    declaredAt: 'x',
    steps: [
      { intent: 'optional', expects: { tool: 'read' }, optional: true },
      { intent: 'required', expects: { tool: 'edit' }, optional: false },
    ],
  }
  const r = scorePlanMatch(plan, [
    { tools: ['read'], paths: [], results: [] },
    { tools: ['edit'], paths: [], results: [] },
  ])
  check('a leading optional step does not hide the required one', r.score.score === 0, String(r.score.score))
}

console.log('\n[S5] a refused write is not progress')

{
  const refused = scoreProgress([
    { tools: ['edit'], results: [{ tool: 'edit', ok: false, excerpt: 'denied', outcome: null }] },
  ])
  check('a denied write scores as no change', refused.status === 'available' && refused.score === 1, JSON.stringify(refused))
  check('and the evidence says why', String(refused.evidence).includes('拒绝'))

  const wrote = scoreProgress([
    { tools: ['edit'], results: [{ tool: 'edit', ok: true, excerpt: 'ok', outcome: null }] },
  ])
  check('an allowed write scores as a change', wrote.score === 0, String(wrote.score))
}

console.log('\n[S5] readable results beat no results')

{
  // "we looked and nothing changed" and "we could not look" are different facts;
  // only the second may abstain.
  const noData = scoreProgress([{ tools: ['read'], results: [] }])
  check('a turn with no results at all abstains', noData.status === 'not_applicable', JSON.stringify(noData))
}

console.log('\n[L2] a step with no evidence does not earn credit toward a card')

{
  const high = aggregateStep([
    { status: 'available', signal: 's3_tool_novel', score: 1, evidence: [] },
    { status: 'available', signal: 's4_plan_match', score: 1, evidence: [] },
    { status: 'available', signal: 's5_progress', score: 1, evidence: [] },
  ])
  let state
  for (let i = 0; i < 6; i += 1) state = advanceSignalState(state, 'p', high, EMA, TH, new Date())
  check('the high run built up a counter', state.consecutiveHigh > 0, String(state.consecutiveHigh))
  const before = state.final

  const empty = aggregateStep([])
  for (let i = 0; i < 3; i += 1) state = advanceSignalState(state, 'p', empty, EMA, TH, new Date())

  check('three silent steps reset the counter', state.consecutiveHigh === 0, String(state.consecutiveHigh))
  check('but the score itself is carried, not decayed', Math.abs(state.final - before) < 1e-9, `${before} -> ${state.final}`)
}

{
  // The concrete failure this prevents: credits from a run of silent steps plus one
  // real step used to open L2 as though the drift had been continuous.
  const high = aggregateStep([{ status: 'available', signal: 's3_tool_novel', score: 1, evidence: [] }])
  const empty = aggregateStep([])
  let state
  for (let i = 0; i < 5; i += 1) state = advanceSignalState(state, 'p', high, EMA, TH, new Date())
  const creditsBefore = state.consecutiveHigh
  for (let i = 0; i < 5; i += 1) state = advanceSignalState(state, 'p', empty, EMA, TH, new Date())
  state = advanceSignalState(state, 'p', high, EMA, TH, new Date())
  check(
    'after five silent steps the counter restarts, not resumes',
    state.consecutiveHigh === 1,
    `${creditsBefore} -> ${state.consecutiveHigh}`,
  )
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
