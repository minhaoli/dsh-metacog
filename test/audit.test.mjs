/**
 * Stratified audit sampling and inverse-probability weighting.
 *
 * The failure this guards against is arithmetic that looks reasonable and is
 * wrong: high-risk records sampled at 100% and low-risk at 2% means the raw sample
 * is almost all high-risk, so any unweighted rate is inflated by construction. The
 * weights are what turn a sample back into an estimate of the population.
 *
 * Run: node test/audit.test.mjs   (after `npm run build`)
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (p) => pathToFileURL(join(here, '..', 'lib', p)).href

const {
  AUDIT_STRATA,
  stratumFor,
  selectAuditSample,
  describeAudit,
} = await import(lib('analysis/audit.js'))

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

/** A judgement carrying a drafted score. */
function judgement(id, score) {
  return {
    id,
    projectId: 'p',
    createdAt: new Date().toISOString(),
    activityIds: [],
    signalType: 'scope_drift',
    summary: '',
    programReason: '',
    draft: score === undefined ? undefined : { score },
    status: 'pending',
  }
}

console.log('\n[strata] the bands partition the score range')

{
  check('there are three strata', AUDIT_STRATA.length === 3, String(AUDIT_STRATA.length))
  check('a low score is in low', stratumFor(0.1)?.name === 'low', stratumFor(0.1)?.name)
  check('exactly 0.5 belongs to medium, not low', stratumFor(0.5)?.name === 'medium', stratumFor(0.5)?.name)
  check('0.9 is high', stratumFor(0.9)?.name === 'high', stratumFor(0.9)?.name)
  check('exactly 1 is high', stratumFor(1)?.name === 'high', stratumFor(1)?.name)
  check('a score above 1 is in no stratum', stratumFor(1.5) === undefined)
  check('a negative score is in no stratum', stratumFor(-0.1) === undefined)
  // The rates are the design's, and lowering them would quietly stop calibration
  // from ever having enough positive samples.
  check('low is sampled at 2%', AUDIT_STRATA[0].rate === 0.02, String(AUDIT_STRATA[0].rate))
  check('medium at 15%', AUDIT_STRATA[1].rate === 0.15, String(AUDIT_STRATA[1].rate))
  check('high at 100%', AUDIT_STRATA[2].rate === 1, String(AUDIT_STRATA[2].rate))
}

console.log('\n[select] the sample is deterministic and weighted')

{
  const records = [
    judgement('j-low-1', 0.2),
    judgement('j-low-2', 0.3),
    judgement('j-med-1', 0.6),
    judgement('j-high-1', 0.9),
    judgement('j-high-2', 0.95),
  ]
  const sample = selectAuditSample(records)
  const ids = sample.map((row) => row.judgmentId)

  // High-risk is sampled at 100%, so both must appear.
  check('every high-risk record is sampled', ids.includes('j-high-1') && ids.includes('j-high-2'), JSON.stringify(ids))
  // The weights follow the design: 1/1 for high, 1/0.02 = 50 for low.
  const high = sample.find((row) => row.judgmentId === 'j-high-1')
  check('a high-risk record has weight 1', high?.weight === 1, String(high?.weight))
  check('and an inclusion probability of 1', high?.inclusionProbability === 1, String(high?.inclusionProbability))

  // Determinism: the same input twice gives the same selection.
  const again = selectAuditSample(records)
  check('the selection is deterministic', JSON.stringify(again) === JSON.stringify(sample))

  // A record already audited is not sampled again.
  const once = selectAuditSample(records, new Set(['j-high-1']))
  check('an audited record is skipped', once.every((row) => row.judgmentId !== 'j-high-1'), JSON.stringify(once.map((r) => r.judgmentId)))

  // A record with no readable score is skipped, not guessed at.
  const noScore = selectAuditSample([judgement('j-noscore', undefined)])
  check('a record with no score is skipped', noScore.length === 0, JSON.stringify(noScore))
}

console.log('\n[describe] the report says what the sample can support')

{
  check('no sample says so', describeAudit([], 0).includes('没有抽到'), describeAudit([], 0))
  const sample = [
    { judgmentId: 'h1', stratum: 'high', score: 0.9, inclusionProbability: 1, weight: 1 },
  ]
  check('an unlabelled sample says so', describeAudit(sample, 0).includes('还没有标注'), describeAudit(sample, 0))
  check('a labelled sample reports the count', describeAudit(sample, 1).includes('已标注 1 条'), describeAudit(sample, 1))
  check('and names the strata', describeAudit(sample, 1).includes('high'), describeAudit(sample, 1))
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
