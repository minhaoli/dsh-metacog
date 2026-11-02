/**
 * Re-judge the recorded activities against the current tree, and report what changed.
 *
 * Filling in alignment criteria only matters if it moves the verdicts. This
 * script replays the stored activity stream through `judgeAlignment` with the
 * live tree, so the before/after split is measured rather than assumed.
 *
 * Usage: node scripts/verify-criteria-effect.mjs [projectRoot]
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.argv[2] ?? process.cwd()
const projectId = process.argv[3] ?? 'dsh_____-7856756f'

const lib = (name) => pathToFileURL(join(process.cwd(), 'lib', name)).href
const { judgeAlignment } = await import(lib('analysis/alignment.js'))
const { parseConfig } = await import(lib('config.js'))

const config = parseConfig({})
const state = JSON.parse(await readFile(join(root, '.metacog', 'state', `${projectId}.json`), 'utf8'))
const raw = await readFile(join(root, '.metacog', 'activities', `${projectId}.jsonl`), 'utf8')
const activities = raw
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))

console.log(`activities: ${activities.length}`)
console.log(`goals with criteria: ${state.goals.filter((g) => g.alignment.relevantActivities.length > 0 || g.alignment.allowedMethods.length > 0).length}/${state.goals.length}\n`)

const before = {}
const after = {}
/** Which goal each newly aligned activity was attributed to. */
const byGoal = new Map()
/** Activities that still fall through, with the reason. */
const stillDrift = []

for (const activity of activities) {
  before[activity.decision] = (before[activity.decision] ?? 0) + 1

  const verdict = judgeAlignment(
    {
      summary: activity.summary,
      evidence: activity.evidence ?? [],
      grade: activity.observationGrade ?? 'B',
      source: activity.source,
      timestamp: activity.timestamp,
    },
    state.goals,
    config,
  )
  after[verdict.decision] = (after[verdict.decision] ?? 0) + 1

  if (verdict.decision === 'aligned' || verdict.decision === 'exploratory') {
    for (const id of verdict.candidateGoalIds ?? []) {
      byGoal.set(id, (byGoal.get(id) ?? 0) + 1)
    }
  } else if (verdict.decision === 'scope_drift' && stillDrift.length < 5) {
    stillDrift.push(activity.summary?.slice(0, 60) ?? '')
  }
}

const order = ['aligned', 'exploratory', 'scope_drift', 'uncertain']
console.log('判定      改动前   改动后')
for (const key of order) {
  console.log(`  ${key.padEnd(12)} ${String(before[key] ?? 0).padStart(5)} ${String(after[key] ?? 0).padStart(8)}`)
}

console.log('\n新判定里各目标命中数：')
const titles = new Map(state.goals.map((g) => [g.id, g.title]))
for (const [id, count] of [...byGoal.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${titles.get(id) ?? id}`)
}
if (byGoal.size === 0) console.log('  （无）')

console.log('\n仍判 scope_drift 的样例：')
for (const summary of stillDrift) console.log(`  - ${summary}`)
