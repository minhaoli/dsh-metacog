/**
 * Behavioural tests for the three implemented signals.
 *
 * Each signal has one thing it must never do: report a number when it could not
 * measure. Every absence path is asserted explicitly, because the failure mode
 * there is silent — a missing signal that reads as zero makes the monitor look
 * calm exactly when it is blind.
 *
 * Run: node test/signals-impl.test.mjs   (after `npm run build`)
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'analysis', 'signals', 'index.js')).href)
const { scoreToolNovelty, scoreClassDrift, scoreProgress, classifyTool, tracesFromActivity, ACTION_CLASSES } = mod

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

const plan = (tools) => ({ id: 'p1', goal: 'g', allowedTools: tools, steps: [], declaredAt: '2026-10-29T00:00:00Z' })

console.log('\n[S3] tool novelty')

check('no plan is an absence, not a zero', scoreToolNovelty({ tools: ['edit'], results: [] }, undefined).status === 'not_applicable')
check(
  'and the reason names the missing plan',
  scoreToolNovelty({ tools: ['edit'], results: [] }, undefined).reason === 'no_declared_plan',
)
check(
  'an empty whitelist is a distinct reason',
  scoreToolNovelty({ tools: ['edit'], results: [] }, plan([])).reason === 'no_allowed_tools',
)
check('every tool inside the whitelist scores 0', scoreToolNovelty({ tools: ['edit', 'read'], results: [] }, plan(['edit', 'read'])).score === 0)
check('one tool outside scores 1', scoreToolNovelty({ tools: ['edit', 'publish'], results: [] }, plan(['edit'])).score === 1)
check(
  'the evidence names the offending tool',
  scoreToolNovelty({ tools: ['publish'], results: [] }, plan(['edit'])).evidence[0].includes('publish'),
)
check('an empty step is an absence, not compliance', scoreToolNovelty({ tools: [], results: [] }, plan(['edit'])).status === 'not_applicable')

console.log('\n[S2] class distribution')

check('all classes accounted for', ACTION_CLASSES.length === 6)
check('read maps to READ', classifyTool('read') === 'READ')
check('grep maps to READ', classifyTool('grep') === 'READ')
check('edit maps to WRITE', classifyTool('edit') === 'WRITE')
check('write maps to WRITE', classifyTool('write') === 'WRITE')
check('pwsh maps to COMPUTE', classifyTool('pwsh') === 'COMPUTE')
check('web_search maps to NETWORK', classifyTool('web_search') === 'NETWORK')
check('send_message maps to COMMUNICATE', classifyTool('send_message') === 'COMMUNICATE')
check('an unknown tool maps to SYSTEM rather than throwing', classifyTool('some_new_tool') === 'SYSTEM')

check('too little history is an absence', scoreClassDrift(['WRITE', 'WRITE']).status === 'not_applicable')
check('and says why', scoreClassDrift(['WRITE']).reason === 'insufficient_history')

// Baseline of 5 writes, then continue writing: no drift.
const steady = ['WRITE', 'WRITE', 'WRITE', 'WRITE', 'WRITE', 'WRITE', 'WRITE', 'WRITE', 'WRITE', 'WRITE']
check('a session that keeps doing the same thing scores 0', scoreClassDrift(steady).score === 0)

// Baseline writes, then only reads: the class set changes entirely.
const pivoted = ['WRITE', 'WRITE', 'WRITE', 'WRITE', 'WRITE', 'READ', 'READ', 'READ', 'READ', 'READ']
const pivotScore = scoreClassDrift(pivoted)
check('a session that stops writing and only reads scores 1', pivotScore.score === 1, JSON.stringify(pivotScore))

// Partial overlap.
const mixed = ['WRITE', 'WRITE', 'WRITE', 'WRITE', 'WRITE', 'WRITE', 'READ', 'WRITE', 'READ', 'WRITE']
check('partial overlap scores between 0 and 1', mixed !== undefined && scoreClassDrift(mixed).score >= 0 && scoreClassDrift(mixed).score <= 1)

console.log('\n[S5] progress')

check('no steps is an absence', scoreProgress([]).status === 'not_applicable')

// A write counts as a change.
const wrote = [{ tools: ['edit'], results: [] }]
check('a write tool counts as progress, so score is 0', scoreProgress(wrote).score === 0)

// Nothing but reads, with results that say nothing: this is the case that must
// not be reported as "no change" — the data cannot tell.
const readOnlyNoResults = [{ tools: ['read'], results: [] }]
check(
  'reading with no result content is an absence, not a drift finding',
  scoreProgress(readOnlyNoResults).status === 'not_applicable',
  JSON.stringify(scoreProgress(readOnlyNoResults)),
)

// A passing test after a failing one is progress.
const tested = [
  { tools: ['pwsh'], results: [{ tool: 'pwsh', ok: true, excerpt: '10 passed', outcome: 'tests-pass' }] },
]
check('a passing test run counts as progress', scoreProgress(tested).score === 0)

// Pure reads whose results exist but say nothing outcome-like: measured, and no change.
const readWithDullResult = [
  { tools: ['read'], results: [{ tool: 'read', ok: true, excerpt: 'file contents', outcome: null }] },
  { tools: ['read'], results: [{ tool: 'read', ok: true, excerpt: 'more contents', outcome: null }] },
]
const dull = scoreProgress(readWithDullResult)
check('results exist but show no change, so the score is 1', dull.status === 'available' && dull.score === 1, JSON.stringify(dull))

// Half the steps changed something.
const half = [
  { tools: ['edit'], results: [] },
  { tools: ['read'], results: [{ tool: 'read', ok: true, excerpt: 'x', outcome: null }] },
]
const halfScore = scoreProgress(half)
check('one of two steps changed something, so the score is 0.5', Math.abs(halfScore.score - 0.5) < 1e-9, String(halfScore.score))

console.log('\n[traces] replaying a turn into steps')

const turnWithThree = { toolNames: ['read', 'edit', 'pwsh'], toolResults: [{ tool: 'pwsh', ok: true, excerpt: 'ok', outcome: 'tests-pass' }] }
const traces = tracesFromActivity(turnWithThree)
check('three tool names produce three steps', traces.length === 3)
check('each step holds its own tool', traces[0].tools[0] === 'read' && traces[1].tools[0] === 'edit' && traces[2].tools[0] === 'pwsh')
check('results attach to the last step only', traces[2].results.length === 1 && traces[0].results.length === 0)

const emptyTurn = { toolNames: [], toolResults: [] }
check('a turn with no tools is one empty step', tracesFromActivity(emptyTurn).length === 1)

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
