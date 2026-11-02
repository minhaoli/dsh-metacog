/**
 * D-stage behaviour: achievements, detail traps, and report structure.
 *
 * The trap detector is the riskiest thing added in this stage: it tells a person
 * where they are wasting effort, and a false positive there is worse than silence.
 * So its tests are mostly negative — asserting that ordinary focused work is NOT
 * reported as a trap.
 *
 * Run: node test/achievements.test.mjs   (after `npm run build`)
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'analysis', 'achievements.js')).href)
const { collectAchievements, detectDetailTraps, summarizeAchievements, urgencyOf, easingContradictions } = mod

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

const NOW = new Date('2026-10-29T12:00:00Z')
// Two helpers with unmistakable names: mixing up 'two days ago' and 'in two
// days' silently inverts every urgency assertion in this file, which is exactly
// what happened on the first run.
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString()
const inDays = (n) => new Date(NOW.getTime() + n * 86_400_000).toISOString()

const goal = (id, over = {}) => ({
  id,
  projectId: 'p',
  parentId: null,
  depth: 1,
  title: id,
  description: '',
  status: 'active',
  priority: 0,
  confirmedByUser: true,
  successCriteria: [],
  alignment: {},
  evidence: ['x'],
  createdAt: daysAgo(30),
  updatedAt: daysAgo(1),
  ...over,
})

const activity = (ids, at = daysAgo(0)) => ({
  id: `a${Math.random()}`,
  eventFingerprint: `f${Math.random()}`,
  projectId: 'p',
  sessionId: 's',
  timestamp: at,
  source: 'turn',
  observationGrade: 'A',
  summary: 'x',
  evidence: [],
  candidateGoalIds: ids,
  alignmentConfidence: 1,
  decision: 'aligned',
  rationale: '',
})

const state = (goals, contradictions = []) => ({
  projectId: 'p',
  version: 1,
  confirmed: true,
  goals,
  contradictions,
  createdAt: daysAgo(30),
  updatedAt: daysAgo(0),
})

console.log('\n[achievements] read from the tree timestamps')

{
  const s = state([
    goal('done-now', { status: 'done', doneAt: daysAgo(1) }),
    goal('done-old', { status: 'done', doneAt: daysAgo(40) }),
    goal('open'),
  ])
  const list = collectAchievements(s, new Date(daysAgo(7)), NOW)
  check('only the in-period completion is returned', list.length === 1, String(list.length))
  check('and it is the right one', list[0].id === 'done-now')
}

{
  const s = state([goal('a')], [
    { id: 'c1', projectId: 'p', parentId: null, primaryGoalId: 'a', relatedGoalIds: [], type: 'main', confirmedByUser: true, title: 'c1', description: '', poleA: '', poleB: '', intensity: 4, trend: 'stable', rationale: '', resolutionHint: '', evidence: [], resolvedAt: daysAgo(2), createdAt: daysAgo(20), updatedAt: daysAgo(2) },
  ])
  const list = collectAchievements(s, new Date(daysAgo(7)), NOW)
  check('a resolved contradiction is an achievement', list.length === 1 && list[0].kind === 'contradiction')
  check('it carries the intensity it was resolved from', list[0].intensityBefore === 4)
}

console.log('\n[progress] completion ratio over confirmed goals')

{
  const s = state([goal('a', { status: 'done' }), goal('b'), goal('c'), goal('draft', { confirmedByUser: false })])
  const p = summarizeAchievements(s)
  check('unconfirmed goals are excluded from the denominator', p.totalGoals === 3, String(p.totalGoals))
  check('completion is 1/3', Math.abs(p.completion - 1 / 3) < 1e-9, String(p.completion))
  check('the line mentions both numbers', p.line.includes('1/3'))
}

console.log('\n[urgency] closer deadlines are more pressing')

{
  // Same creation time (30 days ago), deadlines 2 days out versus 30 days out.
  const soon = goal('soon', { deadline: inDays(2) })
  const far = goal('far', { deadline: inDays(30) })
  check('a nearer deadline scores higher', urgencyOf(soon, NOW) > urgencyOf(far, NOW))
  check('a goal with no deadline is low but not zero', urgencyOf(goal('x'), NOW) >= 0)
  const overdue = goal('late', { deadline: new Date(NOW.getTime() - 86400000).toISOString() })
  check('an overdue goal outranks a future one', urgencyOf(overdue, NOW) > urgencyOf(soon, NOW))
}

console.log('\n[traps] ordinary focused work is NOT a trap')

{
  // One goal at depth 1, getting all the attention. No trap: it is the shallowest
  // goal in the tree, so "deep in the tree" does not hold.
  const s = state([goal('top', { depth: 1 })])
  const acts = [activity(['top']), activity(['top']), activity(['top'])]
  check('a single shallow goal absorbing everything is not a trap', detectDetailTraps(s, acts, NOW).length === 0)
}

{
  // A deep goal absorbing everything, but it has the highest urgency: that is
  // correct prioritisation, not a trap.
  const s = state([
    goal('deep', { depth: 3, deadline: inDays(1) }),
    goal('shallow', { depth: 1, deadline: inDays(60) }),
  ])
  const acts = [activity(['deep']), activity(['deep']), activity(['deep'])]
  check('a deep goal that is also the most urgent is not a trap', detectDetailTraps(s, acts, NOW).length === 0)
}

console.log('\n[traps] the real case IS reported')

{
  // Deep, low-urgency goal soaking up the work while a shallow, urgent one is
  // untouched. This is exactly what the detector exists for.
  const s = state([
    goal('detail', { depth: 3, deadline: inDays(90) }),
    goal('critical', { depth: 1, deadline: inDays(1) }),
  ])
  const acts = [activity(['detail']), activity(['detail']), activity(['detail']), activity(['detail'])]
  const traps = detectDetailTraps(s, acts, NOW)
  check('a deep low-urgency goal crowding out an urgent one is reported', traps.length === 1, String(traps.length))
  if (traps.length === 1) {
    check('it names the crowded-out goal', traps[0].crowdedOut.goalId === 'critical')
    check('share is 100% here', Math.abs(traps[0].share - 1) < 1e-9)
    check('the summary is a sentence a person can read', traps[0].summary.includes('detail') && traps[0].summary.includes('critical'))
  }
}

{
  // Mixed attention: below the 30% floor, so not a trap.
  const s = state([goal('detail', { depth: 3, deadline: inDays(90) }), goal('critical', { depth: 1, deadline: inDays(1) })])
  const acts = [
    activity(['detail']),
    activity(['critical']),
    activity(['critical']),
    activity(['critical']),
    activity(['critical']),
  ]
  check('spending 20% on the detail goal is not a trap', detectDetailTraps(s, acts, NOW).length === 0)
}

{
  const s = state([goal('a', { depth: 2 })])
  check('no activities means no traps', detectDetailTraps(s, [], NOW).length === 0)
  check('activities with no goal attribution means no traps', detectDetailTraps(s, [activity([])], NOW).length === 0)
}

console.log('\n[easing] a falling contradiction intensity is progress')

{
  const before = [{ id: 'c1', intensity: 5, title: 'c1' }]
  const after = [
    { id: 'c1', projectId: 'p', parentId: null, primaryGoalId: 'g', relatedGoalIds: [], type: 'main', confirmedByUser: true, title: 'c1', description: '', poleA: '', poleB: '', intensity: 3, trend: 'falling', rationale: '', resolutionHint: '', evidence: [], createdAt: daysAgo(20), updatedAt: daysAgo(1) },
  ]
  const easing = easingContradictions(before, after)
  check('5 → 3 is reported', easing.length === 1 && easing[0].from === 5 && easing[0].to === 3)
}

{
  const after = [
    { id: 'c1', projectId: 'p', parentId: null, primaryGoalId: 'g', relatedGoalIds: [], type: 'main', confirmedByUser: true, title: 'c1', description: '', poleA: '', poleB: '', intensity: null, trend: 'unknown', rationale: '', resolutionHint: '', evidence: [], createdAt: daysAgo(20), updatedAt: daysAgo(1) },
  ]
  check('an unknown intensity is not reported as a change', easingContradictions([{ id: 'c1', intensity: 4, title: 'c1' }], after).length === 0)
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
