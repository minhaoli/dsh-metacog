/**
 * The report as the user sees it: is the achievement section actually there, and
 * does it come first?
 *
 * The block builders are unit-tested elsewhere. What this checks is the assembled
 * document, because the failure mode that matters is structural: a block that is
 * built correctly and then dropped by the character budget, or ordered after the
 * drift section so the reader meets the accusation first.
 *
 * Run: node test/report-achievements.test.mjs   (after `npm run build`)
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (p) => pathToFileURL(join(here, '..', 'lib', p)).href

const { parseConfig } = await import(lib('config.js'))
const { generateReport } = await import(lib('report.js'))
const { MetacogStore } = await import(lib('data/store.js'))
const { deriveProjectId } = await import(lib('tools/shared.js'))

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

const NOW = new Date('2026-10-29T03:00:00.000Z')
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString()
const hoursAgo = (n) => new Date(NOW.getTime() - n * 3_600_000).toISOString()
const inDays = (n) => new Date(NOW.getTime() + n * 86_400_000).toISOString()

const root = await mkdtemp(join(tmpdir(), 'metacog-report-'))
const config = parseConfig({})

try {
  const store = new MetacogStore(root, '.metacog')
  const projectId = deriveProjectId(root)

  const base = {
    projectId,
    parentId: null,
    description: '',
    priority: 0,
    confirmedByUser: true,
    successCriteria: [],
    alignment: { relevantActivities: ['x'], allowedMethods: ['y'] },
    evidence: ['x'],
    createdAt: daysAgo(30),
    updatedAt: daysAgo(1),
  }

  const state = {
    projectId,
    version: 1,
    confirmed: true,
    goals: [
      // Inside today's calendar day. The report's period is now the day
      // containing `now`, not a rolling 24 hours, so an event one day back is
      // yesterday's achievement and correctly excluded.
      { ...base, id: 'g1', depth: 1, title: '宿主接入', status: 'done', doneAt: hoursAgo(2) },
      { ...base, id: 'g2', depth: 1, title: '验证层', status: 'active', deadline: inDays(3) },
    ],
    contradictions: [
      {
        id: 'c1',
        projectId,
        parentId: null,
        primaryGoalId: 'g1',
        relatedGoalIds: [],
        type: 'main',
        confirmedByUser: true,
        title: '证据严格性 vs 落地速度',
        description: '',
        poleA: 'a',
        poleB: 'b',
        intensity: 3,
        trend: 'falling',
        rationale: '',
        resolutionHint: '',
        evidence: [],
        createdAt: daysAgo(20),
        updatedAt: daysAgo(1),
        // Same reasoning as `doneAt`: the contradiction was resolved today, so a
        // daily report covering today must name it.
        resolvedAt: hoursAgo(2),
      },
    ],
    createdAt: daysAgo(30),
    updatedAt: daysAgo(0),
  }

  // `initialize` builds and validates the state itself, and refuses a second call
  // on a confirmed tree. So it runs once and the validated result is what the
  // report reads; hand-writing the state file would bypass the schema.
  const stored = await store.initialize(projectId, state.goals, state.contradictions)
  const resolved = await store.readState(projectId)

  console.log('\n[daily] the achievement section is present and first')

  const daily = await generateReport({ store, state: resolved, projectId, config, type: 'daily', now: NOW })
  const md = daily.markdown

  check('the achievement heading is present', md.includes('## 本期完成'), md.slice(0, 300))
  check('it names the completed goal', md.includes('宿主接入'))
  check('it names the resolved contradiction', md.includes('证据严格性 vs 落地速度'))
  check('it reports the completion ratio', /目标 \d+\/\d+ 完成/.test(md))

  // Ordering is the whole point: the reader must meet progress before drift.
  // Asserted as "first level-2 heading", not as "earlier than 监控状态" — the
  // weaker form passed while the block was still after the monitor section,
  // because both headings happened to exist in the wrong order.
  const headings = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1])
  check(
    '本期完成 is the first section of the report',
    headings[0] === '本期完成',
    `headings: ${headings.join(' | ')}`,
  )

  console.log('\n[weekly] suggestions are present when a goal is pressing')

  const weekly = await generateReport({ store, state: resolved, projectId, config, type: 'weekly', now: NOW })
  const weeklyHeadings = [...weekly.markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1])
  check('本期完成 is the first section of the weekly report', weeklyHeadings[0] === '本期完成', `headings: ${weeklyHeadings.join(' | ')}`)
  check('it suggests the pressing goal', weekly.markdown.includes('## 下期建议'))
  check('and quotes its remaining days', /还剩 \d+ 天/.test(weekly.markdown), weekly.markdown.slice(0, 500))

  console.log('\n[monthly] the report still assembles')

  const monthly = await generateReport({ store, state: resolved, projectId, config, type: 'monthly', now: NOW })
  const monthlyHeadings = [...monthly.markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1])
  check('本期完成 is the first section of the monthly report', monthlyHeadings[0] === '本期完成', `headings: ${monthlyHeadings.join(' | ')}`)
  check('and is non-trivially long', monthly.markdown.length > 200, String(monthly.markdown.length))

  console.log('\n[empty] a period with nothing finished says so plainly')

  const quiet = {
    ...state,
    goals: [{ ...base, id: 'g9', depth: 1, title: '未完成的目标', status: 'active' }],
    contradictions: [],
  }
  const quietState = { ...resolved, goals: quiet.goals, contradictions: [] }
  const quietReport = await generateReport({ store, state: quietState, projectId, config, type: 'daily', now: NOW })
  const quietHeadings = [...quietReport.markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1])
  check('the achievement section still leads when nothing finished', quietHeadings[0] === '本期完成', quietHeadings.join(' | '))
  check(
    'an empty period states it in words rather than omitting the section',
    quietReport.markdown.includes('本期没有目标完成或矛盾解除'),
    quietReport.markdown.slice(0, 400),
  )
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
