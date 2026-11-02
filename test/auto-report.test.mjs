/**
 * `schedule.autoReport`: the timer writes reports on its own.
 *
 * The whole risk here is duplication, not absence. A missing auto report is a
 * feature that is off; a report written on every tick is a directory filling up
 * with near-identical files that the card then lists as "6 reports" and nobody
 * can tell which one to read.
 *
 * So the tests are mostly about idempotence, and they drive the *real*
 * `generateReport` rather than a stub. That matters: the first version
 * deduplicated on the exact `periodStart`/`periodEnd` pair, and a stubbed report
 * would have agreed with it, because the stub invented the same period the
 * scheduler assumed. The real builder uses a rolling window (`now - 1 day` …
 * `now`), so the endpoints differ on every tick and the pair never matches. Only
 * a test wired to the real builder catches that.
 *
 * Run: node test/auto-report.test.mjs   (after `npm run build`)
 */
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (p) => pathToFileURL(join(here, '..', 'lib', p)).href

const { installScheduler } = await import(lib('schedule.js'))
const { parseConfig } = await import(lib('config.js'))
const { MetacogStore } = await import(lib('data/store.js'))
const { generateReport } = await import(lib('report.js'))
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

const quietCtx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  get: () => undefined,
  on: () => () => {},
}

/** A store with one confirmed (but empty) tree. */
async function fixture(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const config = parseConfig({})
  const projectId = deriveProjectId(root)
  const store = new MetacogStore(root, config.storageSubdir)
  await store.initialize(projectId, [], [])
  // A confirmed tree is the sweep's precondition; an unconfirmed draft is skipped
  // and the test would pass for the wrong reason.
  await store.commit(projectId, {
    expectedVersion: 0,
    goals: [],
    contradictions: [],
    reason: 'fixture',
    action: 'init_trees',
    actor: 'user_confirmed',
    targetIds: [],
    markConfirmed: true,
  })
  return { root, projectId, store }
}

/** A scheduler whose report call is the real builder, over one workspace. */
function scheduler({ config, root, projectId, store, clock }) {
  return installScheduler({
    ctx: quietCtx,
    config,
    projects: async () => [{ projectId, store, projectRoot: root }],
    report: {
      readExisting: () => store.readReports(projectId),
      async generate(type, at) {
        await generateReport({
          store,
          state: await store.readState(projectId),
          projectId,
          config,
          type,
          now: at ?? clock.value,
        })
      },
    },
    now: () => clock.value,
  })
}

console.log('\n[config] the switch is on unless turned off')

{
  const defaults = parseConfig({})
  // On by default: reports are the surface the design exists to fill, and a file
  // that is appended to rather than multiplied cannot flood the directory.
  check('autoReport defaults to true', defaults.schedule.autoReport === true)
  check(
    'the default cadences are daily and weekly',
    JSON.stringify(defaults.schedule.autoReportTypes) === '["daily","weekly"]',
    JSON.stringify(defaults.schedule.autoReportTypes),
  )
  // An unknown cadence is a hard error, not a silently ignored entry: a typo in
  // the config should fail loudly at mount rather than quietly generate nothing.
  let refused = false
  try {
    parseConfig({ schedule: { autoReportTypes: ['hourly'] } })
  } catch {
    refused = true
  }
  check('an unknown cadence is refused at parse time', refused)
}

console.log('\n[idempotence] one report per period, driven by the real builder')

{
  const { root, projectId, store } = await fixture('metacog-auto-')
  try {
    const config = parseConfig({
      schedule: { enabled: true, checkIntervalMinutes: 60, autoReport: true, autoReportTypes: ['daily'] },
    })
    const clock = { value: new Date('2026-10-30T09:00:00+08:00') }
    const sched = scheduler({ config, root, projectId, store, clock })

    await sched.sweep()
    let reports = await store.readReports(projectId)
    check('the first tick writes one report', reports.length === 1, String(reports.length))
    check('and it is the requested cadence', reports[0]?.type === 'daily', reports[0]?.type)
    check('the stat counts it', sched.stats.autoReports === 1, String(sched.stats.autoReports))

    // The regression: a rolling period gives a different `periodEnd` each tick.
    clock.value = new Date('2026-10-30T09:01:00+08:00')
    await sched.sweep()
    reports = await store.readReports(projectId)
    check('one minute later it does not write a second', reports.length === 1, String(reports.length))

    clock.value = new Date('2026-10-30T23:59:00+08:00')
    await sched.sweep()
    reports = await store.readReports(projectId)
    check('still one at the end of that day', reports.length === 1, String(reports.length))
    check('the stat did not move', sched.stats.autoReports === 1, String(sched.stats.autoReports))

    clock.value = new Date('2026-10-31T00:30:00+08:00')
    await sched.sweep()
    reports = await store.readReports(projectId)
    check('the next calendar day writes a second', reports.length === 2, String(reports.length))
    check('the stat counts two', sched.stats.autoReports === 2, String(sched.stats.autoReports))

    clock.value = new Date('2026-10-31T00:31:00+08:00')
    await sched.sweep()
    reports = await store.readReports(projectId)
    check('and that day does not repeat either', reports.length === 2, String(reports.length))

    sched.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log('\n[scope] the switch governs it, an empty list generates nothing')

{
  const { root, projectId, store } = await fixture('metacog-auto-off-')
  try {
    const clock = { value: new Date('2026-10-30T09:00:00+08:00') }

    // Off must be written out explicitly now that the default is on. The intent
    // is unchanged: a switched-off monitor writes nothing.
    const offConfig = parseConfig({ schedule: { enabled: true, checkIntervalMinutes: 60, autoReport: false } })
    const off = scheduler({ config: offConfig, root, projectId, store, clock })
    await off.sweep()
    check('with autoReport off no report appears', (await store.readReports(projectId)).length === 0)
    off.dispose()

    // Switched on but with no cadence: an honest "on, but nothing selected", not
    // a silent fallback to the default list.
    const emptyConfig = parseConfig({ schedule: { autoReport: true, autoReportTypes: [] } })
    const empty = scheduler({ config: emptyConfig, root, projectId, store, clock })
    await empty.sweep()
    check('an empty cadence list generates nothing', (await store.readReports(projectId)).length === 0)
    check('and reports no work', empty.stats.autoReports === 0, String(empty.stats.autoReports))
    empty.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log('\n[isolation] one failing report does not stop the sweep')

{
  const { root, projectId, store } = await fixture('metacog-auto-fail-')
  try {
    const config = parseConfig({
      schedule: { enabled: true, checkIntervalMinutes: 60, autoReport: true, autoReportTypes: ['daily'] },
    })
    const clock = { value: new Date('2026-10-30T09:00:00+08:00') }
    const sched = installScheduler({
      ctx: quietCtx,
      config,
      projects: async () => [{ projectId, store, projectRoot: root }],
      report: {
        async readExisting() {
          return []
        },
        async generate() {
          throw new Error('report builder exploded')
        },
      },
      now: () => clock.value,
    })

    // Must resolve rather than reject: a throwing timer callback is cancelled by
    // the host runtime, which would stop every later tick.
    let threw = false
    try {
      await sched.sweep()
    } catch {
      threw = true
    }
    check('the sweep itself does not throw', threw === false)
    check('the failure is counted', sched.stats.errors >= 1, String(sched.stats.errors))
    check('and no report was stored', (await store.readReports(projectId)).length === 0)
    sched.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log('\n[incremental] each period is appended to one file, not written to a new one')

{
  const { root, projectId, store } = await fixture('metacog-incremental-')
  const config = parseConfig({})
  const markdownDir = join(root, config.storageSubdir, 'reports', 'markdown')
  try {
    // A daily report covers the calendar day it is generated in, not a rolling
    // window: the filename is the date, so a window that slid with `now` would
    // stop matching its own name.
    const first = new Date('2026-10-28T09:00:00+08:00')
    const r1 = await generateReport({ store, state: await store.readState(projectId), projectId, config, type: 'daily', now: first })
    check('a daily period starts at local midnight', new Date(r1.periodStart).getHours() === 0, r1.periodStart)
    // Compared in local time: `periodStart` is stored as UTC, so slicing its
    // string would read the previous day for any timezone east of Greenwich.
    const startLocal = new Date(r1.periodStart)
    check(
      'and covers the day it is generated in',
      startLocal.getFullYear() === 2026 && startLocal.getMonth() === 9 && startLocal.getDate() === 28,
      r1.periodStart,
    )
    check('ending no later than now', Date.parse(r1.periodEnd) <= first.getTime(), r1.periodEnd)

    // The file lands in 日报/年_月/ and is named by the day.
    const monthBucket = join(markdownDir, '日报', '2026_10')
    check('the daily file sits in 日报/年_月', await stat(monthBucket).then(() => true, () => false), monthBucket)
    const dayFile = join(monthBucket, '2026-10-28.md')
    check('and is named by its date', await stat(dayFile).then(() => true, () => false), dayFile)

    // A second run on the SAME day appends to that day's file rather than
    // creating a sibling: "one report per day" is a filename fact.
    const sameDay = new Date('2026-10-28T17:30:00+08:00')
    await generateReport({ store, state: await store.readState(projectId), projectId, config, type: 'daily', now: sameDay })
    const sameDayText = await readFile(dayFile, 'utf8')
    check('a second run the same day appends to the same file', (sameDayText.match(/^## /gm) ?? []).length === 2, sameDayText.slice(0, 300))
    check('separated by a rule', sameDayText.includes('\n---\n'))
    check('with one file-level title', (sameDayText.match(/^# /gm) ?? []).length === 1)
    check('no block heading stays at level two', /^## (?!\d{4}-)/m.test(sameDayText) === false, sameDayText.slice(0, 600))
    check('block headings were demoted to level three', /^### 监控状态/m.test(sameDayText), sameDayText.slice(0, 600))

    // A different day is a different file in the same month bucket.
    const nextDay = new Date('2026-10-29T09:00:00+08:00')
    await generateReport({ store, state: await store.readState(projectId), projectId, config, type: 'daily', now: nextDay })
    const monthFiles = (await readdir(monthBucket)).sort()
    check('the next day is its own file', JSON.stringify(monthFiles) === JSON.stringify(['2026-10-28.md', '2026-10-29.md']), JSON.stringify(monthFiles))

    // A new month is a new bucket.
    const nextMonth = new Date('2026-11-02T09:00:00+08:00')
    await generateReport({ store, state: await store.readState(projectId), projectId, config, type: 'daily', now: nextMonth })
    check('a new month gets its own bucket', await stat(join(markdownDir, '日报', '2026_11')).then(() => true, () => false))

    console.log('\n[weekly/monthly] named by Monday and by the first of the month')

    // Weekly: named after the Monday of the week that contains `now`.
    const wed = new Date('2026-10-28T09:00:00+08:00') // Wednesday
    const w = await generateReport({ store, state: await store.readState(projectId), projectId, config, type: 'weekly', now: wed })
    check('a weekly period starts on a Monday', new Date(w.periodStart).getDay() === 1, w.periodStart)
    check('and that Monday is the filename', new Date(w.periodStart).getDate() === 26, w.periodStart)
    const weekFile = join(markdownDir, '周报', '2026_Q4', '2026-10-26.md')
    check('the weekly file sits in 周报/年_Qn', await stat(weekFile).then(() => true, () => false), weekFile)

    // Monthly: named after the first of the month.
    const m = await generateReport({ store, state: await store.readState(projectId), projectId, config, type: 'monthly', now: wed })
    check('a monthly period starts on the 1st', new Date(m.periodStart).getDate() === 1, m.periodStart)
    const monthFile = join(markdownDir, '月报', '2026', '2026-10-01.md')
    check('the monthly file sits in 月报/年', await stat(monthFile).then(() => true, () => false), monthFile)

    // Run again later in the same week/month: same filename, not a sibling.
    const sun = new Date('2026-11-01T09:00:00+08:00')
    const w2 = await generateReport({ store, state: await store.readState(projectId), projectId, config, type: 'weekly', now: sun })
    check('a report run later in the week keeps the Monday name', w2.periodStart === w.periodStart, `${w2.periodStart} vs ${w.periodStart}`)

    console.log('\n[aggregation] weekly reads days, monthly reads weeks')

    const weeklyText = await readFile(weekFile, 'utf8')
    check('the weekly report names its daily sources', weeklyText.includes('汇总来源'), weeklyText.slice(0, 500))
    check('and counts them', /基于 \d+ 份下级报告/.test(weeklyText), weeklyText.slice(0, 500))

    const monthlyText = await readFile(monthFile, 'utf8')
    check('the monthly report names its weekly sources', monthlyText.includes('汇总来源'), monthlyText.slice(0, 500))

    // A daily report has no lower cadence to summarise.
    const dailyText = await readFile(dayFile, 'utf8')
    check('a daily report has no sources section', dailyText.includes('汇总来源') === false, dailyText.slice(0, 400))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
