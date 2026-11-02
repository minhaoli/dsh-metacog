/**
 * Functional test: the behaviour track actually produces signals from a turn.
 *
 * The track was written and tested in isolation, which proved the arithmetic and
 * nothing else — no production code called it. This drives `scoreTurn` with a real
 * collected turn and asserts the signals come out of the pipeline, not just out of
 * the scorer.
 *
 * Run: node test/behaviour-wired.test.mjs   (after `npm run build`)
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (p) => pathToFileURL(join(here, '..', 'lib', p)).href

const { scoreTurn } = await import(lib('analysis/score.js'))
const { signatureOf, describeToolResult } = await import(lib('collect.js'))
const { parseConfig } = await import(lib('config.js'))
const { DIMENSION_WEIGHTS } = await import(lib('data/signals.js'))

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

/** One collected turn with the given tool names and results. */
function turn(toolNames, toolResults, summary = '') {
  return {
    id: 'act_test',
    eventFingerprint: 'fp_test',
    projectId: 'p1',
    sessionId: 's1',
    timestamp: new Date().toISOString(),
    source: 'turn',
    observationGrade: 'A',
    summary,
    evidence: [],
    candidateGoalIds: [],
    alignmentConfidence: null,
    decision: 'aligned',
    rationale: '',
    toolNames,
    toolResults,
  }
}

/** A result as the collector records it. */
function result(tool, ok, signature) {
  return { tool, ok, excerpt: '', outcome: null, signature }
}

console.log('\n[signature] the digest distinguishes arguments')

{
  const a = signatureOf({ path: 'a.txt' })
  const b = signatureOf({ path: 'b.txt' })
  check('different arguments give different digests', a !== b, `${a} vs ${b}`)
  check('the same arguments give the same digest', signatureOf({ path: 'a.txt' }) === a)
  // Key order must not matter: `{a,b}` and `{b,a}` are the same call.
  check(
    'key order does not change the digest',
    signatureOf({ a: 1, b: 2 }) === signatureOf({ b: 2, a: 1 }),
    `${signatureOf({ a: 1, b: 2 })} vs ${signatureOf({ b: 2, a: 1 })}`,
  )
  check('no arguments gives an empty digest', signatureOf(undefined) === '')
}

console.log('\n[collector] a result carries the signature of its call')

{
  const withSignature = describeToolResult('read', {
    content: 'ok',
    isError: false,
    signature: 'abc123',
  })
  check('the signature is stored', withSignature?.signature === 'abc123', JSON.stringify(withSignature))
  const without = describeToolResult('read', { content: 'ok', isError: false })
  check('an absent signature is empty, not undefined', without?.signature === '', JSON.stringify(without))
}

console.log('\n[production] a looping turn produces behaviour signals')

{
  const sig = signatureOf({ command: 'npm test' })
  const loop = turn(
    ['pwsh', 'pwsh', 'pwsh'],
    [result('pwsh', false, sig), result('pwsh', false, sig), result('pwsh', false, sig)],
  )
  const scored = scoreTurn(loop, 'p1', undefined, undefined, new Map(), { beta: 0.4, initial: 0 }, config.thresholds, new Date())
  const signals = scored.steps[0]?.signals ?? []
  const ids = signals.map((entry) => entry.signal)
  check('the repeat signal is produced', ids.includes('b_repeat'), JSON.stringify(ids))
  check('the error-streak signal is produced', ids.includes('b_error_streak'), JSON.stringify(ids))
  // The aggregate must expose it separately from the goal score.
  check('the aggregate carries a behaviour score', scored.steps[0]?.aggregate.behaviourScore !== null, String(scored.steps[0]?.aggregate.behaviourScore))
  check('behaviour has no weight in the goal dimensions', DIMENSION_WEIGHTS.behaviour === 0, String(DIMENSION_WEIGHTS.behaviour))
}

console.log('\n[quiet] a clean turn produces no behaviour signal')

{
  const clean = turn(
    ['read', 'edit', 'pwsh'],
    [
      result('read', true, signatureOf({ path: 'a' })),
      result('edit', true, signatureOf({ path: 'b' })),
      result('pwsh', true, signatureOf({ command: 'ls' })),
    ],
    'done',
  )
  const scored = scoreTurn(clean, 'p1', undefined, undefined, new Map(), { beta: 0.4, initial: 0 }, config.thresholds, new Date())
  const ids = (scored.steps[0]?.signals ?? []).map((entry) => entry.signal)
  check('no behaviour signal fires', ids.some((id) => id.startsWith('b_')) === false, JSON.stringify(ids))
  check('and the behaviour score is null', scored.steps[0]?.aggregate.behaviourScore === null, String(scored.steps[0]?.aggregate.behaviourScore))
}

console.log('\n[absent] unrecorded signatures do not fake a loop')

{
  // Three calls of the same tool with no signatures recorded. Treating empty
  // signatures as equal would report a loop on data nobody captured.
  const unknown = turn(
    ['read', 'read', 'read'],
    [result('read', true, ''), result('read', true, ''), result('read', true, '')],
  )
  const scored = scoreTurn(unknown, 'p1', undefined, undefined, new Map(), { beta: 0.4, initial: 0 }, config.thresholds, new Date())
  const ids = (scored.steps[0]?.signals ?? []).map((entry) => entry.signal)
  check('no repeat signal without signatures', ids.includes('b_repeat') === false, JSON.stringify(ids))
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
