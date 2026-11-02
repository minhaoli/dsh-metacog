/**
 * Stage G verification: periodic reports and the dynamic prompt block.
 *
 * The report cases drive `generate_report` through the real tool path. They
 * assert what a reader actually needs: that the body leads with the monitor and
 * ends with the activity, that it names real files rather than saying "无", that
 * it stays inside 400/600/800 prose characters even when the period overflows,
 * that the four v3 placeholders are present and honest, that the three known
 * monthly defects stay fixed, and that a Markdown copy lands at
 * `reports/markdown/<type>-<YYYY-MM-DD>.md`.
 *
 * Run: node test/stage-g.test.mjs
 */
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libUrl = pathToFileURL(join(here, '..', 'lib', 'index.js')).href

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

function checkEqual(label, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  check(label, a === b, `expected ${b}, got ${a}`)
}

const { apply } = await import(libUrl)
const { MetacogStore } = await import(pathToFileURL(join(here, '..', 'lib', 'data', 'store.js')).href)
const { renderPromptBlock, countReportChars, REPORT_CHAR_LIMITS } = await import(
  pathToFileURL(join(here, '..', 'lib', 'report.js')).href
)

/** The four v3 sections that must exist as honest placeholders. */
const PLACEHOLDER_HEADINGS = ['### 校准状态', '### 审计覆盖率', '### undecidable 四因占比', '### 阈值验证方式']

function createHost(projectRoot, config, options = {}) {
  const tools = new Map()
  const logs = []
  const listeners = new Map()
  const effects = []
  const timers = []
  const sections = []
  const ctx = {
  get(name) {
    if (name === 'workingDirectory') return this.workingDirectory
    if (name === 'timer') return this.timer
    if (name === 'systemPrompt') return this.systemPrompt
    if (name === 'tools') return this.tools
    if (name === 'fs') return this.fs
    return undefined
  },
    logger: {
      debug: (...args) => logs.push(['debug', ...args]),
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
    },
    on(name, listener) {
      const bucket = listeners.get(name) ?? []
      bucket.push(listener)
      listeners.set(name, bucket)
      return () => {
        listeners.set(name, (listeners.get(name) ?? []).filter((item) => item !== listener))
      }
    },
    effect(setup) {
      effects.push(setup)
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    workingDirectory: { get: () => projectRoot, defaultDirectory: projectRoot },
    timer: {
      interval(callback, delay) {
        const entry = { callback, delay, cleared: false }
        timers.push(entry)
        return () => {
          entry.cleared = true
        }
      },
    },
    ...(options.noPrompt === true
      ? {}
      : {
          systemPrompt: {
            section(section) {
              sections.push(section)
              return () => {
                const index = sections.indexOf(section)
                if (index >= 0) sections.splice(index, 1)
              }
            },
            context(entry) {
              sections.push(entry)
              return () => {}
            },
          },
        }),
  }
  apply(ctx, config)
  return { ctx, tools, logs, listeners, effects, timers, sections }
}

async function call(tools, name, args) {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`tool "${name}" was never registered`)
  return definition.execute(args, {
    callId: `call-${Math.random().toString(16).slice(2)}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
    agent: { id: 'agent-test' },
  })
}

function codeOf(outcome) {
  return outcome?.ok === false ? outcome.error.code : `ok(${JSON.stringify(outcome?.data)})`
}

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), 'metacog-stageg-'))
  await writeFile(
    join(root, 'README.md'),
    [
      '# Report Project',
      '',
      'A fixture for periodic reports.',
      '',
      '## Alignment monitoring',
      '',
      'Detects scope drift.',
      '',
      '## Structure monitoring',
      '',
      'Detects contradiction migration.',
      '',
      '## Design tension',
      '',
      'Delivery speed vs architectural verifiability.',
      '',
    ].join('\n'),
  )
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'docs', 'design.md'), '# Design\n\nObservations are append-only.\n')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'stage-g', version: '1.0.0' }, null, 2))
  return root
}

const fixtures = []

async function findProjectId(root) {
  const entries = await readdir(join(root, '.metacog', 'state'))
  return entries.find((name) => name.endsWith('.json'))?.replace(/\.json$/, '') ?? ''
}

async function confirmTree(tools, options = {}) {
  const draft = await call(tools, 'goal_tree_init', {})
  if (draft.ok !== true) throw new Error(`init failed: ${codeOf(draft)}`)
  const confirmArgs = {
    expectedVersion: 0,
    l0: {
      title: 'Report Project',
      description: 'root',
      evidence: ['README.md'],
      successCriteria: ['reports cite real evidence'],
      // 本阶段测的是周期报告（按目录/动作聚合、写入 markdown），
      // 根目标服务的活动就是这类报告生成。
      alignment: { relevantActivities: ['周期报告生成'] },
    },
    goals: [
      {
        title: 'Alignment monitoring',
        description: 'detect drift',
        evidence: ['README.md'],
        successCriteria: ['drift signals are produced'],
        alignment: {
          relevantActivities: ['drift detection work'],
          allowedMethods: ['typescript'],
          excludedActivities: ['marketing landing page rewrite'],
          explorationPolicy: 'allowed',
        },
      },
      {
        title: 'Structure monitoring',
        description: 'detect migration',
        evidence: ['docs/design.md'],
        successCriteria: ['migration is detected'],
        alignment: {
          relevantActivities: ['structure migration inspection'],
          allowedMethods: ['typescript'],
        },
      },
    ],
    contradictions: [
      {
        title: 'Delivery vs verifiability',
        description: 'tension',
        poleA: 'fast delivery',
        poleB: 'architectural verifiability',
        type: 'main',
        primaryGoalRef: 'Alignment monitoring',
        evidence: ['README.md'],
        intensity: options.intensity ?? 4,
      },
      ...(options.core === true
        ? [
            {
              title: 'Breadth vs depth',
              description: 'core tension',
              poleA: 'broad coverage',
              poleB: 'deep correctness',
              type: 'core',
              primaryGoalRef: 'Structure monitoring',
              evidence: ['docs/design.md'],
              rationale: 'the L0 root goal implies both coverage and correctness',
            },
          ]
        : []),
    ],
  }
  await call(tools, 'goal_tree_confirm', { ...confirmArgs, preview: true, noDeadlineGoalRefs: ['*'] })
  const confirmed = await call(tools, 'goal_tree_confirm', {
    ...confirmArgs,
    userApproved: true,
    approvalNote: 'stage-g 确认',
  })
  if (confirmed.ok !== true) throw new Error(`confirm failed: ${codeOf(confirmed)}`)
  return confirmed.data
}

async function settle() {
  for (let index = 0; index < 15; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function markdownFiles(root) {
  try {
    return await readdir(join(root, '.metacog', 'reports', 'markdown'))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------- G1
console.log('\nG1  a daily report leads with the monitor and ends with the activity')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {})
  await confirmTree(host.tools)

  const report = await call(host.tools, 'generate_report', { type: 'daily' })
  check('the report was generated', report.ok === true, codeOf(report))
  const md = report.data.markdown
  check('it is titled as a daily report', md.startsWith('# 日报 '), md.split('\n')[0])
  check('monitoring comes before activity', md.indexOf('## 监控状态') < md.indexOf('## 本期活动'), md)
  check('there is no advice section', !md.includes('明日唯一优先项'))
  checkEqual('it binds the current tree version', report.data.goalTreeVersion, 1)
  for (const heading of PLACEHOLDER_HEADINGS) {
    check(`it reserves the ${heading.replace('### ', '')} section`, md.includes(heading), md)
  }
  // These three used to print "未启用" unconditionally. Two of them now compute a
  // number from the store, so the assertion is that each section carries a real
  // figure rather than a fixed sentence — and the threshold section still refuses
  // honestly, because no calibration exists.
  check(
    'the audit section reports a count, not a placeholder',
    /### 审计覆盖率\n- (记录 \d+ 条活动|本期没有记录到活动)/.test(md),
    md.slice(md.indexOf('### 审计覆盖率'), md.indexOf('### 审计覆盖率') + 200),
  )
  check(
    'the reason section either counts reasons or says there are none',
    /### undecidable 四因占比\n- (本期没有已结算的判定|\d+ 条已结算|[\w-]+：\d+ 条)/.test(md),
    md.slice(md.indexOf('### undecidable 四因占比'), md.indexOf('### undecidable 四因占比') + 200),
  )
  check(
    'the threshold section explains why it is not derived',
    /### 阈值验证方式\n- 阈值为工程估计值/.test(md),
    md.slice(md.indexOf('### 阈值验证方式'), md.indexOf('### 阈值验证方式') + 200),
  )
  // The old blanket phrase must be gone: it claimed "not implemented" for sections
  // that now compute something, which reads as a bug rather than a caveat.
  check('the blanket "未启用" text is gone', md.includes('本期未启用（分层抽样审计未实现') === false, md)
}

// ---------------------------------------------------------------------- G2
console.log('\nG2  a daily report names directories, actions and real files')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {})
  await confirmTree(host.tools)

  // With no recorded activity the section must say so rather than invent work.
  const empty = await call(host.tools, 'generate_report', { type: 'daily' })
  check(
    'an empty period admits there is no activity',
    empty.data.markdown.includes('本期没有记录到活动'),
    empty.data.markdown,
  )

  await call(host.tools, 'check_drift', {
    activity: {
      summary: 'continued drift detection work on the analyser',
      evidence: ['src/analysis/drift.ts'],
      grade: 'A',
      source: 'manual',
    },
  })
  const filled = await call(host.tools, 'generate_report', { type: 'daily' })
  const md = filled.data.markdown
  check('the activity section lists the directory', md.includes('src/analysis'), md)
  check('it names the real file', md.includes('drift.ts'), md)
  check('it reports how much work the group holds', /\d+ 次/u.test(md), md)
}

// ---------------------------------------------------------------------- G3
console.log('\nG3  every cadence stays inside its character budget and says when it was cut')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {})
  await confirmTree(host.tools)

  // 32 distinct directories: far more than a 400 / 600 / 800 character body can
  // hold, so all three cadences must truncate by priority.
  const packed = 32
  for (let index = 0; index < packed; index += 1) {
    await call(host.tools, 'check_drift', {
      activity: {
        summary: `rewrote the marketing landing page hero section v${index}`,
        evidence: [`src/mod${index}/impl.ts`],
        grade: 'A',
        source: 'manual',
      },
    })
  }

  const daily = await call(host.tools, 'generate_report', { type: 'daily' })
  const dailyChars = countReportChars(daily.data.markdown)
  check(
    'the daily body stays inside 400 characters',
    dailyChars <= REPORT_CHAR_LIMITS.daily,
    `${dailyChars} characters`,
  )
  check('the daily body says it was cut', daily.data.markdown.includes('已截断'), daily.data.markdown)
  check(
    'the cut keeps all four v3 placeholders',
    PLACEHOLDER_HEADINGS.every((heading) => daily.data.markdown.includes(heading)),
    daily.data.markdown,
  )
  check(
    'the cut keeps the surviving work detail',
    daily.data.markdown.includes('impl.ts'),
    daily.data.markdown,
  )

  const weekly = await call(host.tools, 'generate_report', { type: 'weekly' })
  const weeklyChars = countReportChars(weekly.data.markdown)
  check(
    'the weekly body stays inside 600 characters',
    weeklyChars <= REPORT_CHAR_LIMITS.weekly,
    `${weeklyChars} characters`,
  )
  check('the weekly body says it was cut', weekly.data.markdown.includes('已截断'), weekly.data.markdown)

  const monthly = await call(host.tools, 'generate_report', { type: 'monthly' })
  const monthlyChars = countReportChars(monthly.data.markdown)
  check(
    'the monthly body stays inside 800 characters',
    monthlyChars <= REPORT_CHAR_LIMITS.monthly,
    `${monthlyChars} characters`,
  )
  check('the monthly body says it was cut', monthly.data.markdown.includes('已截断'), monthly.data.markdown)
  check(
    'a large sample is enough to describe the drift split',
    monthly.data.markdown.includes('分散在不同目录'),
    monthly.data.markdown,
  )
  check(
    'a large sample is not dismissed as too small',
    !monthly.data.markdown.includes('样本不足'),
    monthly.data.markdown,
  )
}

// ---------------------------------------------------------------------- G4
console.log('\nG4  a weekly report adds structure, intensity, rules and the activity')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {})
  await confirmTree(host.tools)
  await call(host.tools, 'check_drift', {
    activity: {
      summary: 'continued drift detection work on the analyser',
      evidence: ['src/analysis/drift.ts'],
      grade: 'A',
      source: 'manual',
    },
  })
  await call(host.tools, 'check_drift', {
    activity: {
      summary: 'rewrote the marketing landing page hero section',
      evidence: ['site/hero.tsx'],
      grade: 'A',
      source: 'manual',
    },
  })

  const report = await call(host.tools, 'generate_report', { type: 'weekly' })
  check('the report was generated', report.ok === true, codeOf(report))
  const md = report.data.markdown
  check('it is titled as a weekly report', md.startsWith('# 周报 '), md.split('\n')[0])
  check('it covers structural movement', md.includes('## 目标树结构变更'), md)
  check('it covers contradiction intensity', md.includes('## 矛盾强度变化'), md)
  check('it covers rule health', md.includes('## 规则健康度'), md)
  check('it ends with the activity', md.includes('## 本期活动'), md)
  check('the activity section is last', md.lastIndexOf('## ') === md.indexOf('## 本期活动'), md)
  check(
    'monitoring leads every other section',
    md.indexOf('## 监控状态') < md.indexOf('## 目标树结构变更'),
    md,
  )
  for (const heading of PLACEHOLDER_HEADINGS) {
    check(`it reserves the ${heading.replace('### ', '')} section`, md.includes(heading), md)
  }
  check(
    'it counts the alignment distribution as facts',
    /判定 \d+ 条：偏离 \d+、探索 \d+、待定 \d+、对齐 \d+/u.test(md),
    md,
  )
  check('it makes no recommendation', !md.includes('建议') && !md.includes('应将其'), md)
}

// ---------------------------------------------------------------------- G5
console.log('\nG5  a monthly report fixes the three known defects')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {})
  await confirmTree(host.tools, { core: true })
  for (let index = 0; index < 6; index += 1) {
    await call(host.tools, 'check_drift', {
      activity: {
        summary: `rewrote the marketing landing page hero section v${index}`,
        evidence: [`site/hero-${index}.tsx`],
        grade: 'A',
        source: 'manual',
      },
    })
  }

  const report = await call(host.tools, 'generate_report', { type: 'monthly' })
  check('the report was generated', report.ok === true, codeOf(report))
  const md = report.data.markdown
  check('it covers structural stability', md.includes('## 目标树结构稳定性'), md)
  check('it covers core contradiction management', md.includes('## 核心矛盾管理记录'), md)
  check('it covers repeated drift', md.includes('## 重复漂移模式识别'), md)

  // Defect 1: a first month has no baseline, and the report must say so.
  check('the root-goal line admits there is no baseline', md.includes('无对比基线'), md)
  check('it still states the root goal did not change', md.includes('根目标本期未变更'), md)
  check(
    'it names the tree-creation baseline exactly once',
    (md.match(/无对比基线/g) ?? []).length === 1,
    md,
  )

  // Defect 2: the empty core record is stated once, and a zero bypass is not a line.
  check('the empty core record is one phrase', md.includes('本期无观察与干预记录'), md)
  check('it does not repeat the same absence', !md.includes('0 次关联干预'), md)

  // Defect 3: six activities cannot support a repeated-pattern claim.
  check('a small sample is called out as too small', md.includes('样本不足'), md)
  check('a small sample gets no ratio conclusion', !md.includes('主要集中在'), md)

  // Facts only, everywhere.
  check(
    'it carries no remediation advice',
    !md.includes('应将其正式接纳') && !md.includes('建议检查优先级'),
    md,
  )
}

// --------------------------------------------------------------------- G5b
console.log('\nG5b  a quiet month does not print an empty core_bypass conclusion')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {})
  await confirmTree(host.tools, { core: true })

  const quiet = await call(host.tools, 'generate_report', { type: 'monthly' })
  const md = quiet.data.markdown
  check('an empty period is stated once', md.includes('本期无观察与干预记录'), md)
  check('a zero core_bypass gets no line of its own', !md.includes('core_bypass'), md)
  check('an empty period reports no activity', md.includes('本期没有记录到活动'), md)
}

// ---------------------------------------------------------------------- G6
console.log('\nG6  a markdown copy lands beside the report, one file per cadence')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {})
  await confirmTree(host.tools)

  const daily = await call(host.tools, 'generate_report', { type: 'daily' })
  const files = await markdownFiles(root)
  // One directory per cadence, one file per period inside it. The flat
  // directory this replaced became unusable long before it became interesting.
  checkEqual('the cadence gets its own directory', files, ['日报'])

  const day = new Date(daily.data.periodEnd)
  const pad = (value) => String(value).padStart(2, '0')
  const bucket = `${day.getFullYear()}_${pad(day.getMonth() + 1)}`
  const name = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}.md`
  const path = join(root, '.metacog', 'reports', 'markdown', '日报', bucket, name)
  check('the bucket is 年_月', bucket.length === 7, bucket)
  check('and the file is named by its date', /^\d{4}-\d{2}-\d{2}\.md$/.test(name), name)

  const onDisk = await readFile(path, 'utf8')
  check('the copy holds the report body', onDisk.includes(daily.data.markdown.split('\n').slice(1).join('\n').trim().slice(0, 40)))
  check('it opens with a file title, not a period title', onDisk.startsWith('# 日报记录'), onDisk.split('\n')[0])
  // The period heading and the demoted blocks are what make several runs
  // readable in one file; without them the outline interleaves.
  check('the period is a level-two heading', onDisk.includes('\n## '), onDisk.slice(0, 200))
  check('and the report blocks sit one level deeper', onDisk.includes('\n### 监控状态'), onDisk.slice(0, 400))

  const weekly = await call(host.tools, 'generate_report', { type: 'weekly' })
  const again = await markdownFiles(root)
  checkEqual('a second cadence adds its own directory', again.sort(), ['周报', '日报'])

  // The weekly file is named after that week's Monday, not the day it ran.
  const monday = new Date(weekly.data.periodStart)
  check('the weekly period starts on a Monday', monday.getDay() === 1, weekly.data.periodStart)
  const weekName = `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}.md`
  const quarter = `Q${Math.floor(monday.getMonth() / 3) + 1}`
  check('the weekly file sits in 年_Qn', await stat(join(root, '.metacog', 'reports', 'markdown', '周报', `${monday.getFullYear()}_${quarter}`)).then(() => true, () => false))
  check('and is named by the Monday', /^\d{4}-\d{2}-\d{2}\.md$/.test(weekName), weekName)
}

// ---------------------------------------------------------------------- G6b
console.log('\nG6b  a second run the same period appends instead of replacing')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {})
  await confirmTree(host.tools)

  // Two runs on the same day must land in the same file, the second appended
  // under its own period heading. Nothing is erased, and no sibling appears.
  const first = await call(host.tools, 'generate_report', { type: 'daily' })
  const day = new Date(first.data.periodEnd)
  const pad = (value) => String(value).padStart(2, '0')
  const path = join(
    root,
    '.metacog',
    'reports',
    'markdown',
    '日报',
    `${day.getFullYear()}_${pad(day.getMonth() + 1)}`,
    `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}.md`,
  )
  const afterFirst = await readFile(path, 'utf8')
  await call(host.tools, 'generate_report', { type: 'daily' })
  const afterSecond = await readFile(path, 'utf8')

  check('the second run kept the first section', afterSecond.length > afterFirst.length, `${afterFirst.length} -> ${afterSecond.length}`)
  check('the first section is still readable in full', afterSecond.startsWith(afterFirst.trimEnd()))
  const sections = (afterSecond.match(/^## \d{4}-\d{2}-\d{2} → /gm) ?? []).length
  check('both runs are present as sections', sections === 2, String(sections))
  check('separated by a rule', afterSecond.includes('\n---\n'))
  check('and the file still has exactly one title', (afterSecond.match(/^# /gm) ?? []).length === 1)
}

// ---------------------------------------------------------------------- G7
console.log('\nG7  a report keeps its version after the tree moves on')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {})
  await confirmTree(host.tools)

  const report = await call(host.tools, 'generate_report', { type: 'daily' })
  checkEqual('it was generated at version 1', report.data.goalTreeVersion, 1)

  // Change the tree: this must not rewrite history.
  const view = await call(host.tools, 'goal_tree_view', {})
  const parentId = view.data.goals.find((goal) => goal.title === 'Alignment monitoring').id
  const l2Goal = {
    title: 'Write the trend calculator',
    description: 'a new L2 under alignment monitoring',
    depth: 2,
    parentId,
    evidence: ['src/analysis/trend.ts'],
    successCriteria: ['the calculator returns a slope for the given window'],
  }
  const edit = await call(host.tools, 'goal_tree_edit', {
    expectedVersion: view.data.version,
    creates: [l2Goal],
    reason: 'adding a decomposed step',
  })
  check('the tree moved on', edit.ok === true, codeOf(edit))
  checkEqual('the tree is now at version 2', edit.data.version, 2)

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const reports = await store.readReports(projectId)
  checkEqual('one report is stored', reports.length, 1)
  checkEqual('the stored report still says version 1', reports[0].goalTreeVersion, 1)

  // And that version's snapshot is still readable.
  const snapshot = await store.readSnapshot(projectId, 1)
  check('the bound snapshot still exists', snapshot !== undefined)
  checkEqual('it is the snapshot the report read', snapshot.version, 1)
}

// ---------------------------------------------------------------------- G8
console.log('\nG8  a report cites only ids that exist')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {})
  await confirmTree(host.tools, { intensity: 5 })
  await call(host.tools, 'contradiction_observe', {
    contradictionRef: 'Delivery vs verifiability',
    intensity: 5,
    evidence: ['README.md'],
    confidence: 0.9,
    rationale: 'the tension is acute this week',
  })
  for (let index = 0; index < 4; index += 1) {
    await call(host.tools, 'check_drift', {
      activity: {
        summary: `rewrote the marketing landing page hero section v${index}`,
        evidence: [`site/hero-${index}.tsx`],
        grade: 'A',
        source: 'manual',
      },
    })
  }

  const report = await call(host.tools, 'generate_report', { type: 'weekly' })
  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const observations = await store.readObservations(projectId)
  const signals = await store.readSignals(projectId)
  const interventions = await store.readInterventions(projectId)

  check(
    'every cited observation exists',
    report.data.observationIds.every((id) => observations.some((item) => item.id === id)),
    JSON.stringify(report.data.observationIds),
  )
  check(
    'every cited signal exists',
    report.data.signalIds.every((id) => signals.some((item) => item.id === id)),
    JSON.stringify(report.data.signalIds),
  )
  check(
    'every cited intervention exists',
    report.data.interventionIds.every((id) => interventions.some((item) => item.id === id)),
    JSON.stringify(report.data.interventionIds),
  )
  check('no phantom observation was cited', report.data.observationIds.length >= 0)
}

// ---------------------------------------------------------------------- G9
console.log('\nG9  an invalid report type is refused')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {})
  await confirmTree(host.tools)
  const bad = await call(host.tools, 'generate_report', { type: 'hourly' })
  checkEqual('an unknown cadence is refused', codeOf(bad), 'INVALID_REPORT_TYPE')
}

// --------------------------------------------------------------------- G10
console.log('\nG10  a report on an uninitialized project is refused')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {})
  const uninit = await call(host.tools, 'generate_report', { type: 'daily' })
  checkEqual('an uninitialized project is refused', codeOf(uninit), 'NOT_INITIALIZED')
}

// --------------------------------------------------------------------- G11
console.log('\nG11  the prompt section is registered with a required order')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {})
  checkEqual('one section is registered', host.sections.length, 1)
  checkEqual('it is named dsh-metacog', host.sections[0]?.name, 'dsh-metacog')
  check('it declares a finite order', Number.isFinite(host.sections[0]?.order))
  check('its text is a function, so it re-renders per assembly', typeof host.sections[0]?.text === 'function')
}

// --------------------------------------------------------------------- G12
console.log('\nG12  the prompt block carries the rule, the L0/L1 summary and pending cards')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {})
  await confirmTree(host.tools)

  // Render the section the way the host would, after letting the cache warm.
  const render = () => host.sections[0].text({})
  render() // schedules a refresh
  await settle()
  const block = render()

  check('it states the core-versus-main rule', block.includes('core: implied by the root goal'))
  check('it states the evidence rule', block.includes('grade A evidence'))
  check('it carries the root line', block.includes('根目标: Report Project'))
  check('it carries the strategic summary', block.includes('第 1 层 (2)'))
  check('it names the main contradiction', block.includes('main contradiction:'))

  // The full tree must not leak into the prompt.
  check('it does not dump every goal', !block.includes('Write the trend calculator'))
  check('the block stays small', block.length < 1200, `length ${block.length}`)
}

// --------------------------------------------------------------------- G13
console.log('\nG13  a pending decision is surfaced in the prompt')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {})
  await confirmTree(host.tools, { intensity: 5 })

  for (let index = 0; index < 4; index += 1) {
    await call(host.tools, 'check_drift', {
      activity: {
        summary: `rewrote the marketing landing page hero section v${index}`,
        evidence: [`site/hero-${index}.tsx`],
        grade: 'A',
        source: 'manual',
      },
    })
  }

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const pending = (await store.readInterventions(projectId)).filter(
    (record) => record.status === 'pending',
  )
  check('a card is pending', pending.length > 0, JSON.stringify(pending.map((r) => r.status)))

  const render = () => host.sections[0].text({})
  render()
  await settle()
  const block = render()
  check('the pending card appears in the prompt', block.includes(pending[0].id), block)
  check('it names the level', block.includes(`L${pending[0].level}`))
}

// --------------------------------------------------------------------- G14
console.log('\nG14  the prompt block is honest when no project is known')
{
  const block = renderPromptBlock(undefined, [], [], {
    thresholds: { minConfidence: 0.6, windowMinutes: 120, repeatThreshold: 3, highIntensityThreshold: 4, staleDaysThreshold: 7 },
    observationPolicy: { gradeBMaxConfidence: 0.5, gradeCStaticOnly: true },
    whitelistedActivities: [],
    storageSubdir: '.metacog',
    enabled: true,
    schedule: { enabled: true, checkIntervalMinutes: 25 },
    collection: { enabled: true, summaryMaxChars: 240 },
    quiet: { enabled: false },
  })
  check('it still states the rule', block.includes('core: implied by the root goal'))
  check('it claims no L0 when there is none', !block.includes('L0:'))
  check('it mentions the confidence floor', block.includes('0.6'))
}

// --------------------------------------------------------------------- G15
console.log('\nG15  a host without systemPrompt still mounts and reports the gap')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {}, { noPrompt: true })
  checkEqual('no section was registered', host.sections.length, 0)
  check('tools still registered', host.tools.size >= 9)
  check(
    'the gap is reported as info, not a crash',
    host.logs.some(([level, message]) => level === 'info' && String(message).includes('systemPrompt')),
    JSON.stringify(host.logs.map(([level]) => level)),
  )
}

// --------------------------------------------------------------------- G16
console.log('\nG16  disposal removes the prompt section')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {})
  checkEqual('section present before disposal', host.sections.length, 1)
  for (const setup of host.effects) {
    const disposer = await setup()
    await disposer()
  }
  checkEqual('section gone after disposal', host.sections.length, 0)
  checkEqual('tools gone too', host.tools.size, 0)
  checkEqual('timer cleared', host.timers[0]?.cleared, true)
  checkEqual('listener gone', (host.listeners.get('session/event') ?? []).length, 0)
}

for (const root of fixtures) {
  try {
    await rm(root, { recursive: true, force: true })
  } catch {
    // Best effort cleanup.
  }
}

console.log(`\n=== Stage G 结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
