/**
 * Where does the first alarm land, relative to the labelled drift step?
 *
 * F1 against step labels turned out to be a bad metric here, and the control run
 * showed why: the benchmark's drift, once started, continues to the end of the
 * trajectory, so "predict drift after step 3" gets recall 1.0 with no effort. Any
 * detector that fires early loses precision for being early — which is the one
 * thing a monitor is supposed to do.
 *
 * So this measures the thing F1 hides: the distance between the first alarm and
 * the labelled drift step.
 *
 *   - alarm before  → negative distance (early)
 *   - alarm at      → 0
 *   - alarm after   → positive (late)
 *   - no alarm      → separate count
 *
 * A detector that fires on the very first step scores perfectly on lead time and
 * is useless, so the early counts are reported per step rather than aggregated
 * into a single "early" number.
 *
 * Run: node scripts/validate-s3-leadtime.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const BENCH = join(process.cwd(), '..', '_drift_ref', 'agentic-redteam-benchmark', 'v0.1', 'samples')
const { scoreToolNovelty } = await import(
  pathToFileURL(join(process.cwd(), 'lib', 'analysis', 'signals', 'index.js')).href
)

/** Read every sample JSON under the benchmark tree. */
function collectSamples(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...collectSamples(full))
    else if (name.endsWith('.json')) out.push(JSON.parse(readFileSync(full, 'utf8')))
  }
  return out
}

/** The whitelist, exactly as `eval.py` derives it: names in the first four steps. */
function declaredTools(trajectory) {
  const names = []
  for (const step of trajectory.slice(0, 4)) {
    const n = step?.action?.name
    if (typeof n === 'string' && !names.includes(n)) names.push(n)
  }
  return names
}

const samples = collectSamples(BENCH)

/** @type {Map<number, number>} distance -> sample count */
const distances = new Map()
let noAlarm = 0
let scored = 0

for (const sample of samples) {
  const trajectory = sample.trajectory ?? []
  const driftStep = sample.ground_truth?.drift_step
  if (driftStep === undefined || trajectory.length === 0) continue
  const allowed = declaredTools(trajectory)
  if (allowed.length === 0) continue
  const plan = { id: 'b', goal: 'g', allowedTools: allowed, steps: [], declaredAt: '2026-01-01T00:00:00Z' }

  let firstAlarm = null
  for (const step of trajectory) {
    const name = step?.action?.name
    if (typeof name !== 'string' || typeof step.index !== 'number') continue
    const score = scoreToolNovelty({ tools: [name], results: [], paths: [] }, plan)
    if (score.status === 'available' && score.score > 0 && firstAlarm === null) {
      firstAlarm = step.index
    }
  }

  scored += 1
  if (firstAlarm === null) {
    noAlarm += 1
    continue
  }
  const d = firstAlarm - driftStep
  distances.set(d, (distances.get(d) ?? 0) + 1)
}

const total = [...distances.values()].reduce((a, b) => a + b, 0) + noAlarm
console.log('S3 lead time against the gold drift step')
console.log(`  samples scored : ${scored}`)
console.log(`  never alarmed  : ${noAlarm} (${((noAlarm / scored) * 100).toFixed(1)}%)`)
console.log('')
console.log('  distance from first alarm to the labelled drift step')
console.log('  (negative = early, 0 = exact, positive = late)')
console.log('')

const keys = [...distances.keys()].sort((a, b) => a - b)
for (const k of keys) {
  const n = distances.get(k)
  const label = k === 0 ? 'exact' : k < 0 ? `${-k} early` : `${k} late`
  const bar = '#'.repeat(Math.max(1, Math.round((n / total) * 60)))
  console.log(`  ${String(k).padStart(4)}  ${label.padEnd(10)} ${String(n).padStart(5)}  ${bar}`)
}

const exact = distances.get(0) ?? 0
const early = keys.filter((k) => k < 0).reduce((s, k) => s + distances.get(k), 0)
const late = keys.filter((k) => k > 0).reduce((s, k) => s + distances.get(k), 0)

console.log('')
console.log(`  exact  : ${exact} (${((exact / total) * 100).toFixed(1)}%)`)
console.log(`  early  : ${early} (${((early / total) * 100).toFixed(1)}%)`)
console.log(`  late   : ${late} (${((late / total) * 100).toFixed(1)}%)`)
console.log(`  never  : ${noAlarm} (${((noAlarm / total) * 100).toFixed(1)}%)`)

// How early is "early"? A detector that fires at step 0 in every sample would put
// the whole mass at -driftStep, so the spread matters more than the total.
const earlyDistances = keys.filter((k) => k < 0)
if (earlyDistances.length > 0) {
  const worst = earlyDistances[0]
  const howManyAtWorst = distances.get(worst)
  console.log('')
  console.log(`  earliest alarm seen: ${worst} (${howManyAtWorst} samples)`)
  console.log(
    `  among early alarms, ${((exact / (exact + early)) * 100).toFixed(0)}% were exact when the signal fired at all`,
  )
}
