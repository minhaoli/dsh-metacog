/**
 * The model-behaviour track.
 *
 * Four signals about the assistant rather than the user's work: a repeat loop, an
 * error-retry loop, an alternating loop, and narration without action.
 *
 * The property that matters most is the one a careless implementation loses: a
 * behaviour finding must NOT raise the goal-drift score. "The agent is stuck" and
 * "this work does not serve the goal" are different claims, and merging them would
 * make every loop look like a drift from the confirmed tree.
 *
 * Run: node test/behaviour-track.test.mjs   (after `npm run build`)
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (p) => pathToFileURL(join(here, '..', 'lib', p)).href

const {
  scoreRepeatRate,
  scoreErrorStreak,
  scoreAlternatingLoop,
  scoreMonologue,
  REPEAT_THRESHOLD,
  ERROR_STREAK_THRESHOLD,
  ALTERNATING_CYCLES,
} = await import(lib('analysis/signals/behaviour.js'))
const { aggregateStep, DIMENSION_WEIGHTS } = await import(lib('data/signals.js'))

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

/** One tool call. */
function step(name, signature = name, failed = false) {
  return { name, signature, failed }
}

console.log('\n[repeat] identical consecutive calls')

{
  check('two identical calls are not a loop', scoreRepeatRate([step('read'), step('read')]) === undefined)
  const three = scoreRepeatRate([step('read'), step('read'), step('read')])
  check(`${REPEAT_THRESHOLD} identical calls fire`, three !== undefined, JSON.stringify(three))
  check('with a non-zero score', three !== undefined && three.score > 0, String(three?.score))
  check('and evidence naming the tool', three !== undefined && three.evidence[0].includes('read'), three?.evidence[0])

  // Same tool, different arguments: that is progress, not a loop.
  check(
    'the same tool with different arguments is not a loop',
    scoreRepeatRate([step('read', 'a'), step('read', 'b'), step('read', 'c')]) === undefined,
  )
  // Interleaved calls break the run.
  check(
    'an interleaved call breaks the streak',
    scoreRepeatRate([step('read'), step('read'), step('grep'), step('read')]) === undefined,
  )
  // The score saturates rather than growing without bound.
  const many = scoreRepeatRate(Array.from({ length: 10 }, () => step('read')))
  check('a long loop saturates at 1', many !== undefined && many.score === 1, String(many?.score))
}

console.log('\n[error] the same call failing repeatedly')

{
  check('one failure is not a streak', scoreErrorStreak([step('pwsh', 'x', true)]) === undefined)
  check(
    'two failures are not a streak',
    scoreErrorStreak([step('pwsh', 'x', true), step('pwsh', 'x', true)]) === undefined,
  )
  const three = scoreErrorStreak([
    step('pwsh', 'x', true),
    step('pwsh', 'x', true),
    step('pwsh', 'x', true),
  ])
  check(`${ERROR_STREAK_THRESHOLD} failures fire`, three !== undefined, JSON.stringify(three))
  check('and name the command', three !== undefined && three.evidence[0].includes('pwsh'), three?.evidence[0])

  // A success resets the count: recovering is not looping.
  check(
    'a success resets the streak',
    scoreErrorStreak([
      step('pwsh', 'x', true),
      step('pwsh', 'x', true),
      step('pwsh', 'x', false),
      step('pwsh', 'x', true),
    ]) === undefined,
  )
  // An unknown outcome is not evidence of failure.
  check(
    'an unknown outcome does not count as a failure',
    scoreErrorStreak([
      step('pwsh', 'x', true),
      step('pwsh', 'x', null),
      step('pwsh', 'x', true),
    ]) === undefined,
    'null must neither continue nor break the streak',
  )
}

console.log('\n[alternating] two calls taking turns')

{
  const cycle = [step('edit', 'a'), step('test', 'b'), step('edit', 'a'), step('test', 'b'), step('edit', 'a'), step('test', 'b')]
  const found = scoreAlternatingLoop(cycle)
  check(`${ALTERNATING_CYCLES} cycles fire`, found !== undefined, JSON.stringify(found))
  check('with evidence', found !== undefined && found.evidence[0].includes('交替'), found?.evidence[0])

  check(
    'two cycles are not enough',
    scoreAlternatingLoop([step('edit', 'a'), step('test', 'b'), step('edit', 'a'), step('test', 'b')]) === undefined,
  )
  // A repeat loop is not an alternating loop: the two members must differ.
  check(
    'a repeat loop is not reported as alternating',
    scoreAlternatingLoop(Array.from({ length: 6 }, () => step('edit', 'a'))) === undefined,
  )
}

console.log('\n[monologue] narration without an action')

{
  check('no tool call and no completion fires', scoreMonologue(false, false) !== undefined)
  check('a tool call means it is not a monologue', scoreMonologue(true, false) === undefined)
  // A final answer looks identical to a monologue from the outside, so the turn's
  // own verdict decides.
  check('a claimed completion is not a monologue', scoreMonologue(false, true) === undefined)
}


console.log('\n[isolation] behaviour must not raise the goal-drift score')

{
  // This is the whole point of the separate dimension.
  const goalOnly = aggregateStep([
    { status: 'available', signal: 's3_tool_novel', score: 0.2, evidence: [] },
    { status: 'available', signal: 's4_plan_match', score: 0.2, evidence: [] },
    { status: 'available', signal: 's5_progress', score: 0.2, evidence: [] },
  ])
  const withBehaviour = aggregateStep([
    { status: 'available', signal: 's3_tool_novel', score: 0.2, evidence: [] },
    { status: 'available', signal: 's4_plan_match', score: 0.2, evidence: [] },
    { status: 'available', signal: 's5_progress', score: 0.2, evidence: [] },
    { status: 'available', signal: 'b_repeat', score: 1, evidence: ['looping'] },
  ])

  check('behaviour has zero weight', DIMENSION_WEIGHTS.behaviour === 0, String(DIMENSION_WEIGHTS.behaviour))
  check('the goal score is unchanged by a behaviour finding', withBehaviour.riskScore === goalOnly.riskScore, `${goalOnly.riskScore} vs ${withBehaviour.riskScore}`)
  check('the coverage is unchanged too', withBehaviour.coverage === goalOnly.coverage, `${goalOnly.coverage} vs ${withBehaviour.coverage}`)
  check('and the behaviour score is reported separately', withBehaviour.behaviourScore === 1, String(withBehaviour.behaviourScore))
  check('absent when nothing fired', goalOnly.behaviourScore === null, String(goalOnly.behaviourScore))

  // A behaviour-only step still has no goal evidence, so it cannot escalate a
  // goal-drift card — the dimension is not part of that decision.
  const behaviourOnly = aggregateStep([{ status: 'available', signal: 'b_repeat', score: 1, evidence: [] }])
  check('a behaviour-only step has no goal score', behaviourOnly.riskScore === null, String(behaviourOnly.riskScore))
  check('and zero goal coverage', behaviourOnly.coverage === 0, String(behaviourOnly.coverage))
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
