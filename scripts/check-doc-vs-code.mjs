/**
 * Cross-check the design doc against the compiled contract.
 *
 * The doc and `src/data/signals.ts` state the same numbers twice — once in prose
 * for a reader, once in code for the analyser. Twice-stated numbers drift apart,
 * and the failure mode is quiet: the doc keeps promising 0.50 while the code
 * computes 0.35, and nobody notices until a report disagrees with a card.
 *
 * So this asserts the numbers in the doc are the ones the code actually holds.
 * It checks the *values*, not the wording, which is what makes it different from
 * `check-design.mjs`.
 *
 * Run: node scripts/check-doc-vs-code.mjs   (after `npm run build`)
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const docText = readFileSync(join(here, '..', 'docs', 'architecture.md'), 'utf8')
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'data', 'signals.js')).href)
const { DIMENSION_WEIGHTS, DIMENSION_SIGNALS, SignalIdSchema } = mod
/** Every signal id the code defines, in declaration order. */
const SIGNAL_IDS = SignalIdSchema.options

let problems = 0
function must(label, condition, detail) {
  if (condition) {
    console.log(`ok    ${label}`)
    return
  }
  problems += 1
  console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

// --- dimension weights -------------------------------------------------------
must('doc promises 范围越界 0.50', docText.includes('| 范围越界 | S3 工具惊讶 + S2 动作类别 | 0.50'))
must('code says scope = 0.50', DIMENSION_WEIGHTS.scope === 0.5, String(DIMENSION_WEIGHTS.scope))
must('doc promises 计划符合 0.25', docText.includes('| 计划符合 | S4 计划匹配 | 0.25'))
must('code says plan = 0.25', DIMENSION_WEIGHTS.plan === 0.25, String(DIMENSION_WEIGHTS.plan))
must('doc promises 实际推进 0.25', docText.includes('| 实际推进 | S5 推进真实性 | 0.25'))
must('code says progress = 0.25', DIMENSION_WEIGHTS.progress === 0.25, String(DIMENSION_WEIGHTS.progress))
must('weights sum to 1', Object.values(DIMENSION_WEIGHTS).reduce((a, b) => a + b, 0) === 1)

// --- dimension membership ----------------------------------------------------
must(
  'scope dimension holds exactly S3 + S2',
  JSON.stringify(DIMENSION_SIGNALS.scope) === JSON.stringify(['s3_tool_novel', 's2_class']),
  JSON.stringify(DIMENSION_SIGNALS.scope),
)
must(
  'plan dimension holds exactly S4',
  JSON.stringify(DIMENSION_SIGNALS.plan) === JSON.stringify(['s4_plan_match']),
  JSON.stringify(DIMENSION_SIGNALS.plan),
)
must(
  'progress dimension holds exactly S5',
  JSON.stringify(DIMENSION_SIGNALS.progress) === JSON.stringify(['s5_progress']),
  JSON.stringify(DIMENSION_SIGNALS.progress),
)
// S1 was reserved for a semantic-drift channel that never got a producer, and has
// now been removed outright: a signal id nothing emits reads as broken rather than
// as unplanned.
must('s1_semantic is gone from the signal enum', !JSON.stringify(SIGNAL_IDS).includes('s1_semantic'), JSON.stringify(SIGNAL_IDS))
must('and from every weighted dimension', !JSON.stringify(DIMENSION_SIGNALS).includes('s1_semantic'))

// --- thresholds --------------------------------------------------------------
must('doc states beta = 0.4', docText.includes('β = 0.4'))
must('doc states the hint threshold 0.500', docText.includes('`final < 0.500`'), 'band table missing')
must('doc states the card threshold 0.875', docText.includes('0.875'))
must('doc states 连续 3 步 for Level 2', docText.includes('连续 3 步'))
must('doc states coverageFloor 0.4', docText.includes('coverage ≥ 0.4'))

// --- coverage discreteness ---------------------------------------------------
// The doc's table must list the same five values the weights can produce.
const docStatesFive = docText.includes('{0, 0.25, 0.5, 0.75, 1}') || docText.includes('覆盖度的取值与其真实含义')
must('doc explains the coverage value set', docStatesFive)

const reachable = new Set()
const dims = Object.keys(DIMENSION_WEIGHTS)
for (let mask = 0; mask < 1 << dims.length; mask += 1) {
  let sum = 0
  for (let i = 0; i < dims.length; i += 1) if ((mask >> i) & 1) sum += DIMENSION_WEIGHTS[dims[i]]
  reachable.add(Number(sum.toFixed(10)))
}
const expected = [0, 0.25, 0.5, 0.75, 1]
must(
  'weights yield exactly {0, 0.25, 0.5, 0.75, 1}',
  JSON.stringify([...reachable].sort((a, b) => a - b)) === JSON.stringify(expected),
  JSON.stringify([...reachable].sort((a, b) => a - b)),
)
must('0.4 floor admits 0.50 and rejects 0.25', 0.5 >= 0.4 && 0.25 < 0.4)

// --- the S5 naming correction must survive --------------------------------
must('doc records that s5_paraphrase is a different signal', docText.includes('s5_paraphrase'))
must('doc no longer claims S5 has benchmark coverage', !docText.includes('2 (0.1%)'))

console.log(`\nproblems: ${problems}`)
process.exit(problems === 0 ? 0 : 1)
