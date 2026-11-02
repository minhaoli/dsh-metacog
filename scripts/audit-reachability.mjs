/**
 * Accurate reachability: does anything in src/ reference this name at all?
 *
 * The earlier pass excluded `index.ts` and reported eighteen false positives —
 * that file is the plugin entry point and calls most of them. This version counts
 * every src file except the one that defines the export.
 *
 * Usage: node scripts/audit-reachability.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

const files = walk('src')
const texts = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]))

/** Names the user asked about, plus everything the audit flagged as suspicious. */
const CANDIDATES = [
  'evaluateCall',
  'scanProject',
  'detectFileChanges',
  'matchWhitelist',
  'gradeConfidenceCap',
  'currentIntensity',
  'buildIntervention',
  'remindIfLogIsLong',
  'stageFor',
  'summarizeProgress',
  'renderRuleHealth',
  'overallFalsePositiveRate',
  'readContradictionTrend',
  'buildJudgmentPrompt',
  'buildWindowPrompt',
  'reviewDerivation',
  'contradictionRejection',
  'calibrateScore',
  'reliabilityTable',
  'MIN_CALIBRATION_SAMPLES',
  'MIN_PER_CLASS',
]

console.log('name                       referenced by (src, excluding its own file)')
for (const name of CANDIDATES) {
  const users = []
  for (const [file, text] of texts) {
    if (!new RegExp(`\\b${name}\\b`).test(text)) continue
    // Skip the file that defines it: an export always mentions its own name.
    const definesIt = new RegExp(`export (?:async )?function ${name}\\b|export const ${name}\\b`).test(text)
    if (definesIt) continue
    users.push(file.replace(/\\/g, '/').replace('src/', ''))
  }
  console.log(`${name.padEnd(26)} ${users.length === 0 ? '!! NONE' : users.join(', ')}`)
}
