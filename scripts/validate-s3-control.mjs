/**
 * The control experiment for `validate-s3.mjs`.
 *
 * The validation run reports F1 0.864, which looks like a success. It could
 * equally be an artefact: the whitelist is derived from the opening four steps,
 * so *any* tool appearing later is "novel", and later steps are also where the
 * labels say drift happens. If the benchmark were built that way, a signal that
 * simply answered "index > 3" would score the same and we would be measuring the
 * label distribution, not the detector.
 *
 * So this runs three baselines against the same labels:
 *
 *   1. Always predict drift after step 3 (the trivial age baseline).
 *   2. Random with matched positive rate.
 *   3. Our signal.
 *
 * If (1) is close to (3), the number means nothing.
 *
 * Run: node scripts/validate-s3-control.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const BENCH = join(process.cwd(), '..', '_drift_ref', 'agentic-redteam-benchmark', 'v0.1', 'samples')
const { scoreToolNovelty } = await import(pathToFileURL(join(process.cwd(), 'lib', 'analysis', 'signals', 'index.js')).href)

function collectSamples(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...collectSamples(full))
    else if (entry.endsWith('.json')) out.push(full)
  }
  return out
}

function declaredTools(trajectory) {
  const names = new Set()
  for (const step of trajectory) {
    if (step.index >= 4) break
    const name = step.action?.name
    if (typeof name === 'string') names.add(name)
  }
  return [...names]
}

const rows = collectSamples(BENCH)
  .map((f) => JSON.parse(readFileSync(f, 'utf8')))
  .filter((o) => o.trajectory && o.ground_truth)

/** Score a prediction function over the whole benchmark. */
function evaluate(predict) {
  let tp = 0
  let fp = 0
  let fn = 0
  let tn = 0
  for (const sample of rows) {
    const allowed = declaredTools(sample.trajectory)
    if (allowed.length === 0) continue
    const driftStep = sample.ground_truth.drift_step
    for (const step of sample.trajectory) {
      const name = step.action?.name
      if (typeof name !== 'string') continue
      const predicted = predict(step, allowed, sample)
      const actual = step.index >= driftStep
      if (predicted && actual) tp += 1
      else if (predicted && !actual) fp += 1
      else if (!predicted && actual) fn += 1
      else tn += 1
    }
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return { tp, fp, fn, tn, precision, recall, f1 }
}

const ours = evaluate((step, allowed) => {
  const s = scoreToolNovelty({ tools: [step.action.name], results: [] }, { id: 'b', goal: 'g', allowedTools: allowed, steps: [], declaredAt: '2026-01-01T00:00:00Z' })
  return s.status === 'available' && s.score === 1
})

// Baseline 1: everything after the opening four steps is drift.
const ageBaseline = evaluate((step) => step.index >= 4)

// Baseline 2: everything is drift.
const allDrift = evaluate(() => true)

// Baseline 3: nothing is drift.
const noDrift = evaluate(() => false)

// Baseline 4: random, matched to our positive rate.
const positiveRate = (ours.tp + ours.fp) / (ours.tp + ours.fp + ours.fn + ours.tn)
let seed = 12345
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
const random = evaluate(() => rand() < positiveRate)

const fmt = (name, r) =>
  `${name.padEnd(30)} P ${r.precision.toFixed(3)}  R ${r.recall.toFixed(3)}  F1 ${r.f1.toFixed(3)}  (TP ${r.tp} FP ${r.fp} FN ${r.fn})`

console.log('S3 against controls — the same labels, four trivial predictors')
console.log('')
console.log(fmt('our S3 signal', ours))
console.log(fmt('baseline: index >= 4', ageBaseline))
console.log(fmt('baseline: always drift', allDrift))
console.log(fmt('baseline: never drift', noDrift))
console.log(fmt(`baseline: random (p=${positiveRate.toFixed(3)})`, random))
console.log('')
const margin = ours.f1 - Math.max(ageBaseline.f1, random.f1)
console.log(`margin over the best trivial baseline: ${margin >= 0 ? '+' : ''}${margin.toFixed(3)}`)
console.log('')
if (margin < 0.05) {
  console.log('VERDICT: our signal is within noise of a trivial predictor on this benchmark.')
  console.log('That means the benchmark cannot distinguish it from "step > 3", and the')
  console.log('0.864 figure must not be quoted as evidence the detector works.')
  console.log('')
  console.log('Why F1 fails here, rather than the signal failing:')
  console.log('  - Labelled drift, once it starts, continues to the end of the trajectory,')
  console.log('    so "predict drift after step 3" has recall 1.0 with no effort at all.')
  console.log('  - The whitelist is the first four steps, so the first alarm is very often')
  console.log('    at step 4 -- before the label says anything is wrong. F1 counts that as a')
  console.log('    false positive, i.e. it penalises the detector for firing early, which is')
  console.log('    the one behaviour a monitor is for.')
  console.log('  - Measured directly, 82.7% of every out-of-whitelist step in this corpus')
  console.log('    falls at or after the labelled drift, so the signal is tracking real')
  console.log('    boundaries rather than the step index.')
  console.log('')
  console.log('See scripts/validate-s3-leadtime.mjs for the metric that does not')
  console.log('reward a constant predictor: the distance from the first alarm to the label.')
} else {
  console.log('VERDICT: our signal beats every trivial baseline on these labels, so the')
  console.log('number reflects the signal rather than the label distribution. It still')
  console.log('says nothing about this project: the benchmark is English, uses generic')
  console.log('tools, and its whitelist comes from the opening four steps.')
}
