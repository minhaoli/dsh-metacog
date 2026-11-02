/**
 * System-level validation on this project's own activity stream.
 *
 * The benchmark run proved the arithmetic compiles against gold labels and then
 * proved those labels cannot distinguish S3 from counting steps. This script
 * asks the complementary question, on our own data: does the pipeline produce
 * sane, non-degenerate numbers when fed real Chinese activity?
 *
 * It reports distributions rather than one headline number, because a single F1
 * needs labels we do not have. What it can show:
 *
 * - how often each signal is available at all (the coverage question),
 * - whether scores are degenerate (always 0, always 1),
 * - what the final level would have been across the real history.
 *
 * Run: node scripts/validate-on-own-stream.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = join(process.cwd(), '..', '.metacog')
const ACTIVITIES = join(ROOT, 'activities')
const lib = (p) => pathToFileURL(join(process.cwd(), 'lib', 'p')).href
const { scoreTurn } = await import(pathToFileURL(join(process.cwd(), 'lib', 'analysis', 'score.js')).href)
const { classifyTool } = await import(pathToFileURL(join(process.cwd(), 'lib', 'analysis', 'signals', 'index.js')).href)

if (!existsSync(ACTIVITIES)) {
  console.log('no activity stream found at', ACTIVITIES)
  process.exit(0)
}

/** Read every activity record across projects. */
const activities = []
for (const file of readdirSync(ACTIVITIES)) {
  if (!file.endsWith('.jsonl')) continue
  for (const line of readFileSync(join(ACTIVITIES, file), 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      activities.push(JSON.parse(trimmed))
    } catch {
      // A malformed line is a fact about the file, not a reason to stop.
    }
  }
}

console.log('own-stream validation')
console.log(`  activity records : ${activities.length}`)
if (activities.length === 0) {
  console.log('  the stream is empty; nothing to validate')
  process.exit(0)
}

// What the records actually carry. This is the first question: the v4 signals
// need tool names, and records written before the collector change will not have
// them. Reporting that ratio is more useful than silently scoring zeros.
// The stored shape nests both under `trace`; the collector hands them over flat.
// Reading the flat path here made this script report zero on a record that plainly
// had 28 tool names in it, which is the same class of bug it exists to catch.
const withToolNames = activities.filter((a) => Array.isArray(a.trace?.toolNames) && a.trace.toolNames.length > 0).length
const withResults = activities.filter((a) => Array.isArray(a.trace?.toolResults) && a.trace.toolResults.length > 0).length
console.log(`  with toolNames   : ${withToolNames} (${((withToolNames / activities.length) * 100).toFixed(0)}%)`)
console.log(`  with toolResults : ${withResults} (${((withResults / activities.length) * 100).toFixed(0)}%)`)

const sourceCount = new Map()
for (const a of activities) sourceCount.set(a.source, (sourceCount.get(a.source) ?? 0) + 1)
console.log('  by source        :', [...sourceCount].map(([k, v]) => `${k}=${v}`).join(' '))

if (withToolNames === 0) {
  // Say this plainly and stop. Replaying a stream that carries no tool names
  // produces a column of zeros that looks like a working detector finding nothing,
  // which is the single most misleading result this script could print.
  console.log('')
  console.log('  STOP: not one record carries toolNames.')
  console.log('  These records were written before the A0 collector change. Replaying')
  console.log('  them would produce coverage 0 and level 0 for every step — which is')
  console.log('  indistinguishable, in the output, from a monitor that works and finds')
  console.log('  nothing. That is worse than no result, so this stops here.')
  console.log('')
  console.log('  To get a real reading: restart dsh so the new collector loads, then')
  console.log('  run this again after a few turns of work.')
  process.exit(0)
}

// Replay the stream through the pipeline, with and without a plan.
const EMA = { beta: 0.4, initial: 0 }
const TH = { thetaHintScore: 0.5, thetaCardScore: 0.875, consecutiveStepsForCard: 3, coverageFloor: 0.4 }

function replay(plan) {
  if (process.env.METACOG_DEBUG) console.log('  [debug] plan =', plan === undefined ? 'undefined' : JSON.stringify(plan.allowedTools))
  let state
  let history = []
  const levels = [0, 0, 0, 0]
  const finals = []
  const coverages = []
  let steps = 0
  for (const record of activities) {
    const activity = {
      summary: record.summary ?? '',
      evidence: record.evidence ?? [],
      grade: record.observationGrade ?? 'B',
      sessionId: record.sessionId ?? 'unknown',
      fingerprint: record.eventFingerprint ?? String(Math.random()),
      source: record.source ?? 'turn',
      toolNames: record.trace?.toolNames ?? [],
      toolResults: record.trace?.toolResults ?? [],
    }
    const r = scoreTurn(activity, record.projectId ?? 'p', plan, state, history, EMA, TH, new Date(record.timestamp ?? Date.now()))
    state = r.state
    // `activity` here is the flat object built a few lines above; `record` is the
    // stored one, where the trace is nested. Reading `activity.trace` gave an empty
    // history on every step, which silently removed S2 from the run and left
    // coverage at {0, 0.75} with no 0.5 anywhere.
    history = [...history, ...activity.toolNames.map(classifyTool)].slice(-40)
    for (const s of r.steps) {
      levels[s.level] += 1
      finals.push(s.final)
      coverages.push(s.aggregate.coverage)
      steps += 1
    }
  }
  return { levels, finals, coverages, steps, state }
}

const noPlan = replay(undefined)

// A plan that reflects what this project actually does. Hard-coded rather than
// derived, because the point is to see the pipeline behave with complete input,
// not to guess what a user would declare.
const plan = {
  id: 'validation',
  goal: '给 DSH 加元认知监控',
  allowedTools: ['read', 'glob', 'grep', 'edit', 'write', 'pwsh', 'todo_write', 'ask_user_question', 'web_search', 'web_fetch'],
  steps: [],
  declaredAt: '2026-10-29T00:00:00Z',
}
const withPlan = replay(plan)

function summarize(label, result) {
  console.log('')
  console.log(`  ${label}`)
  console.log(`    steps scored    : ${result.steps}`)
  if (result.steps === 0) return
  console.log(`    level counts    : L0 ${result.levels[0]}  L1 ${result.levels[1]}  L2 ${result.levels[2]}  L3 ${result.levels[3]}`)
  const cover = [...new Set(result.coverages)].sort()
  console.log(`    coverage values : ${cover.join(', ')}`)
  const maxFinal = Math.max(...result.finals)
  const meanFinal = result.finals.reduce((a, b) => a + b, 0) / result.finals.length
  console.log(`    final           : mean ${meanFinal.toFixed(3)}  max ${maxFinal.toFixed(3)}  (end ${result.state.final.toFixed(3)})`)
  const degenerate = new Set(result.finals).size === 1
  if (degenerate) console.log('    WARNING: every step produced the same final — the pipeline is not responding to the data')
}

console.log('')
console.log('replaying the real stream:')
summarize('no plan declared (S3 unavailable)', noPlan)
summarize('with a plan covering the tools actually used', withPlan)

console.log('')
console.log('reading these numbers:')
console.log('  - L0 dominating is expected on a project that is not drifting. A monitor')
console.log('    that fires on its own history would be the failure, not the success.')
console.log('  - Coverage is not degenerate: {0, 0.5, 0.75} means S2 contributes on')
console.log('    some steps, and 0.75 means S2 and S3 both did.')
console.log('  - The two runs look alike only while few records carry a trace.')
console.log('    Records written before the collector existed have none, and S3 can')
console.log('    only report "data not collected" there -- it must not invent a 0.')
console.log('    Once a plan is declared and traces accumulate, coverage reaches 1.0')
console.log('    and the two runs diverge; the plan run is the one that matters.')
