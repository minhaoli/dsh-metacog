/**
 * Validate the S3 implementation against the benchmark's gold labels.
 *
 * What this can and cannot prove, stated up front because the distinction is the
 * whole point:
 *
 * - It CAN prove the algorithm is implemented correctly: given the benchmark's
 *   own `declared_tools` and each step's tool name, does our `scoreToolNovelty`
 *   flag exactly the steps the benchmark says are drift?
 * - It CANNOT prove the detector works on this project. The benchmark is English,
 *   uses generic tools (`flights.search`, `df.sort`), and its drift is authored
 *   against a declared plan we do not have. A good number here means "the
 *   arithmetic is right", not "the monitor is right".
 *
 * The benchmark's own schema invariant helps and hurts: `drift_step >= 4` means
 * the first four steps are benign by construction, which is exactly the range
 * where our EMA has not warmed up yet. So this measures the signal, not the
 * escalation ladder.
 *
 * Run: node scripts/validate-s3.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const BENCH = join(process.cwd(), '..', '_drift_ref', 'agentic-redteam-benchmark', 'v0.1', 'samples')
const { scoreToolNovelty } = await import(pathToFileURL(join(process.cwd(), 'lib', 'analysis', 'signals', 'index.js')).href)

/** Collect every sample file. */
function collectSamples(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...collectSamples(full))
    else if (entry.endsWith('.json')) out.push(full)
  }
  return out
}

/**
 * Derive `declared_tools` the way the benchmark's own `eval.py` does.
 *
 * `eval.py:549-562` takes the deduplicated tool names from the opening steps
 * (index < 4) under `prefix4`. Reproducing that rule exactly is the difference
 * between validating our signal and validating some other experiment.
 */
function declaredTools(trajectory) {
  const names = new Set()
  for (const step of trajectory) {
    if (step.index >= 4) break
    const name = step.action?.name
    if (typeof name === 'string') names.add(name)
  }
  return [...names]
}

const files = collectSamples(BENCH)
const rows = files.map((f) => JSON.parse(readFileSync(f, 'utf8'))).filter((o) => o.trajectory && o.ground_truth)

let tp = 0
let fp = 0
let fn = 0
let tn = 0
let skipped = 0
const byCat = new Map()
/** Steps where our signal and the label disagree, kept for inspection. */
const disagreements = []

for (const sample of rows) {
  const allowed = declaredTools(sample.trajectory)
  if (allowed.length === 0) {
    skipped += 1
    continue
  }
  const driftStep = sample.ground_truth.drift_step
  const category = sample.category ?? 'unknown'
  const bucket = byCat.get(category) ?? { tp: 0, fp: 0, fn: 0, tn: 0 }
  const plan = { id: 'b', goal: 'g', allowedTools: allowed, steps: [], declaredAt: '2026-01-01T00:00:00Z' }

  for (const step of sample.trajectory) {
    const name = step.action?.name
    if (typeof name !== 'string') continue
    const scored = scoreToolNovelty({ tools: [name], results: [] }, plan)
    // An absence is not a prediction; the benchmark always has a whitelist here.
    if (scored.status !== 'available') continue
    const predicted = scored.score === 1
    const actual = step.index >= driftStep

    if (predicted && actual) {
      tp += 1
      bucket.tp += 1
    } else if (predicted && !actual) {
      fp += 1
      bucket.fp += 1
      if (disagreements.length < 10) {
        disagreements.push({ id: sample.id, step: step.index, driftStep, tool: name, allowed })
      }
    } else if (!predicted && actual) {
      fn += 1
      bucket.fn += 1
    } else {
      tn += 1
      bucket.tn += 1
    }
  }
  byCat.set(category, bucket)
}

const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
const fpStepRate = tp + fp + tn + fn === 0 ? 0 : fp / (tp + fp + tn + fn)

console.log('S3 step-level validation against gold labels')
console.log(`  samples scored : ${rows.length - skipped} of ${rows.length} (skipped ${skipped}: no tools in the opening 4 steps)`)
console.log(`  steps          : ${tp + fp + fn + tn}`)
console.log('')
console.log(`  true positive  : ${tp}`)
console.log(`  false positive : ${fp}`)
console.log(`  false negative : ${fn}`)
console.log(`  true negative  : ${tn}`)
console.log('')
console.log(`  precision      : ${precision.toFixed(3)}`)
console.log(`  recall         : ${recall.toFixed(3)}`)
console.log(`  F1             : ${f1.toFixed(3)}`)
console.log(`  false-positive step rate : ${fpStepRate.toFixed(3)}`)
console.log('')
console.log('by category:')
for (const [cat, b] of [...byCat].sort()) {
  const p = b.tp + b.fp === 0 ? 0 : b.tp / (b.tp + b.fp)
  const r = b.tp + b.fn === 0 ? 0 : b.tp / (b.tp + b.fn)
  console.log(`  ${cat.padEnd(24)} TP ${String(b.tp).padStart(4)}  FP ${String(b.fp).padStart(4)}  FN ${String(b.fn).padStart(4)}  P ${p.toFixed(2)}  R ${r.toFixed(2)}`)
}
if (disagreements.length > 0) {
  console.log('')
  console.log('first false positives (our signal fired before the labelled drift step):')
  for (const d of disagreements) {
    console.log(`  ${d.id} step ${d.step} (drift at ${d.driftStep}) tool=${d.tool} allowed=${d.allowed.join(',')}`)
  }
}

// The benchmark reports 0.843 F1 for its tight-scope configuration. Reproducing
// that number is not the goal — the goal is showing our implementation of the
// same rule behaves sanely against the same labels.
console.log('')
console.log('note: F1 here measures the SIGNAL against step labels, not the full')
console.log('      detector. The EMA and coverage floor are not involved, and the')
console.log('      benchmark declared a plan we do not have.')
