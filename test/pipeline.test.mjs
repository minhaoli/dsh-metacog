/**
 * End-to-end v4 pipeline test: collector output → signals → aggregate → EMA →
 * level, driven the way the mount drives it.
 *
 * This is the test that would have caught the thing the unit tests cannot: a
 * pipeline where every piece works and the assembled result still never fires,
 * because the coverage floor and the EMA ramp interact and neither piece knows
 * about the other.
 *
 * Run: node test/pipeline.test.mjs   (after `npm run build`)
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (p) => pathToFileURL(join(here, '..', 'lib', p)).href
const { scoreTurn } = await import(lib('analysis/score.js'))
const { classifyTool } = await import(lib('analysis/signals/index.js'))

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

const plan = (tools) => ({
  id: 'p1',
  goal: '做监控',
  allowedTools: tools,
  steps: [],
  declaredAt: '2026-10-29T00:00:00Z',
})

const activity = (toolNames, toolResults = []) => ({
  summary: 'turn',
  evidence: ['e'],
  grade: 'A',
  sessionId: 's1',
  fingerprint: `turn:s1:${toolNames.join('-')}`,
  source: 'turn',
  toolNames,
  toolResults,
})

console.log('\n[1] a declared-plan session with in-scope tools stays at level 0')

{
  let state
  let history = []
  let peak = 0
  for (let turn = 0; turn < 6; turn += 1) {
    const act = activity(['edit', 'edit'])
    const r = scoreTurn(act, 'proj', plan(['edit', 'write', 'read']), state, history, EMA, TH, new Date())
    state = r.state
    history = [...history, ...act.toolNames.map(classifyTool)].slice(-40)
    peak = Math.max(peak, r.peakLevel)
  }
  check('peak level stays 0 across six turns', peak === 0, String(peak))
  check('final stays low', state.final < 0.1, String(state.final))
}

console.log('\n[2] undeclared tools accumulate, and the card opens at the physical lower bound')

{
  let state
  let history = []
  let firstL1 = null
  let firstL2 = null
  // 8 turns x 1 out-of-scope call each. All signals max: S3=1, S2=1 (class flip),
  // S5=1 (no verifiable change).
  for (let turn = 1; turn <= 8; turn += 1) {
    const act = activity(['publish_secret'])
    const r = scoreTurn(act, 'proj', plan(['edit']), state, history, EMA, TH, new Date())
    state = r.state
    history = [...history, ...act.toolNames.map(classifyTool)].slice(-40)
    if (r.peakLevel >= 1 && firstL1 === null) firstL1 = turn
    if (r.peakLevel >= 2 && firstL2 === null) firstL2 = turn
  }
  check('a hint appears (level >= 1) at some point', firstL1 !== null, String(firstL1))
  check('the card does not open before step 5', (firstL2 ?? 99) >= 5, String(firstL2))
  check('and does open by step 7', firstL2 !== null && firstL2 <= 7, String(firstL2))
}

console.log('\n[3] no plan at all: S3 and S5 are gone, and S2 alone cannot see this drift')

{
  let state
  let history = []
  let peak = 0
  for (let turn = 0; turn < 10; turn += 1) {
    const act = activity(['publish_secret'])
    const r = scoreTurn(act, 'proj', undefined, state, history, EMA, TH, new Date())
    state = r.state
    history = [...history, ...act.toolNames.map(classifyTool)].slice(-40)
    peak = Math.max(peak, r.peakLevel)
  }
  check('level never leaves 0 without a plan', peak === 0, String(peak))
  // Coverage is 0, not 0.50: S2 is retired from scoring, so with no plan the
  // scope dimension has no member left; S3 needs a plan, and this call left S5
  // with no verifiable change to report. Nothing is measurable, which is why
  // nothing here can escalate. (A plan-less turn that *does* change something
  // reaches 0.25 — progress alone, still under the floor; that case is pinned in
  // test/signal-retirement.test.mjs.)
  check(
    'nothing is measurable: no plan, and S5 saw no change',
    state.lastAggregate.coverage === 0,
    String(state.lastAggregate.coverage),
  )
  // And yet the score stays at zero, which is the real finding: S2 measures the
  // *distribution of action classes*, and doing the same undeclared thing ten
  // times in a row is a perfectly stable distribution. Without S3 there is no
  // signal that can notice a repeated out-of-scope tool.
  check('but the score stays 0: a stable class distribution hides it entirely', state.final === 0, String(state.final))
  check(
    'S3 is absent for the documented reason',
    state.lastAggregate.absent.some((a) => a.signal === 's3_tool_novel' && a.status === 'no_declared_plan'),
  )
}

console.log('\n[3b] without a plan, a class flip is measured but no longer scored')

{
  let state
  let history = []
  let peak = 0
  // Six writes establish "this session writes", then it switches to publishing.
  const sequence = [['edit'], ['edit'], ['edit'], ['edit'], ['edit'], ['edit'], ['publish_secret'], ['publish_secret']]
  for (const tools of sequence) {
    const act = activity(tools)
    const r = scoreTurn(act, 'proj', undefined, state, history, EMA, TH, new Date())
    state = r.state
    history = [...history, ...act.toolNames.map(classifyTool)].slice(-40)
    peak = Math.max(peak, r.peakLevel)
  }
  // S2 used to be the one thing that could notice a plan-less session changing
  // shape. It is retired now, so the flip is still measured — and still carried
  // out on the aggregate — but it no longer moves the score.
  check('the flip no longer moves the score', state.final === 0, String(state.final))
  check(
    'though S2 still measured it',
    state.lastAggregate.retired.some((entry) => entry.signal === 's2_class' && entry.score > 0),
    JSON.stringify(state.lastAggregate.retired),
  )
}

console.log('\n[4] a turn with three tool calls advances the EMA three times')

{
  const act = activity(['a', 'b', 'c'])
  const r = scoreTurn(act, 'proj', plan(['a']), undefined, [], EMA, TH, new Date())
  check('three steps recorded', r.steps.length === 3, String(r.steps.length))
  check('final rises across the three steps', r.steps[0].final < r.steps[2].final, `${r.steps[0].final} vs ${r.steps[2].final}`)
  check('the first step is the declared tool, so S3 is 0 there', r.steps[0].aggregate.riskScore < r.steps[1].aggregate.riskScore)
}

console.log('\n[5] revision resets the score rather than charging the new plan for the old one')

{
  let state
  let history = []
  for (let turn = 0; turn < 4; turn += 1) {
    const act = activity(['publish_secret'])
    const r = scoreTurn(act, 'proj', plan(['edit']), state, history, EMA, TH, new Date())
    state = r.state
    history = [...history, ...act.toolNames.map(classifyTool)].slice(-40)
  }
  const before = state.final
  check('score built up before revision', before > 0.5, String(before))
  // A revision is simulated the way the tool does it: fresh state carrying the new plan.
  const revised = { projectId: 'proj', final: 0, consecutiveHigh: 0, stepsSeen: state.stepsSeen, plan: plan(['publish_secret']), updatedAt: new Date().toISOString() }
  const after = scoreTurn(activity(['publish_secret']), 'proj', revised.plan, revised, history, EMA, TH, new Date())
  check('after revision the same action is in scope, so the score falls', after.state.final < 0.35, String(after.state.final))
}

console.log('\n[6] an empty turn does not clear an accumulated score')

{
  let state
  for (let turn = 0; turn < 4; turn += 1) {
    const r = scoreTurn(activity(['publish_secret']), 'proj', plan(['edit']), state, [], EMA, TH, new Date())
    state = r.state
  }
  const before = state.final
  const empty = scoreTurn(activity([]), 'proj', plan(['edit']), state, [], EMA, TH, new Date())
  check('a turn with no recorded tools leaves final essentially unchanged', Math.abs(empty.state.final - before) < 1e-9, `${before} -> ${empty.state.final}`)
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
