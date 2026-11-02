/**
 * F2: completed subtrees fold for display, and only when asked.
 *
 * The fold is a presentation choice with one hard rule: it never changes what is
 * stored, and it is never the default. The first look at a tree must list every
 * goal — a branch that has already vanished is indistinguishable from one that
 * never existed, and the user can no longer check the tree against their memory
 * of it. So the default is "show everything", and only a caller that explicitly
 * opts in gets one summary line per finished branch.
 *
 * The fold condition is the whole subtree, not just direct children: a done
 * child with an active grandchild means the tree disagrees with itself, and
 * hiding the active node would be the one outcome worse than a long list.
 *
 * Run: node test/done-collapse.test.mjs   (after `npm run build`)
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (path) => pathToFileURL(join(here, '..', 'lib', path)).href

const { apply } = await import(lib('index.js'))
const { parseConfig } = await import(lib('config.js'))
const { generateReport } = await import(lib('report.js'))
const { MetacogStore } = await import(lib('data/store.js'))
const { deriveProjectId } = await import(lib('tools/shared.js'))
const { collapseCompleted } = await import(lib('analysis/collapse.js'))

let passed = 0
let failed = 0
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
    return
  }
  failed += 1
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` -- ${String(detail).slice(0, 700)}`}`)
}

const ids = (goals) => goals.map((goal) => goal.id).join(',')

function createHost(projectRoot) {
  const tools = new Map()
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return this.workingDirectory
      if (name === 'tools') return this.tools
      return undefined
    },
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
    on: () => () => {},
    effect: () => {},
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    workingDirectory: { get: () => projectRoot, defaultDirectory: projectRoot },
  }
  return { ctx, tools }
}

const fixtures = []

async function freshProject() {
  const root = await mkdtemp(join(tmpdir(), 'metacog-collapse-'))
  fixtures.push(root)
  await writeFile(join(root, 'README.md'), '# Collapse\n\nA fixture for completed-subtree folding.\n')
  const { ctx, tools } = createHost(root)
  apply(ctx, parseConfig({}))
  const call = async (name, args) => {
    const definition = tools.get(name)
    if (definition === undefined) throw new Error(`tool "${name}" was never registered`)
    return definition.execute(args, {
      callId: `call-${Math.random().toString(16).slice(2)}`,
      name,
      arguments: args,
      signal: new AbortController().signal,
      agent: { id: 'agent-collapse' },
    })
  }
  return { root, call }
}

const codeOf = (outcome) => (outcome?.ok === false ? outcome.error.code : `ok(${JSON.stringify(outcome?.data)})`)

try {
  console.log('\n[pure] folding is off unless asked, and then it is one summary line')

  {
    const tree = [
      { id: 'p', parentId: null, title: 'Parent', status: 'active' },
      { id: 'c1', parentId: 'p', title: 'C1', status: 'done' },
      { id: 'c2', parentId: 'p', title: 'C2', status: 'done' },
    ]

    const byDefault = collapseCompleted(tree)
    check('default options fold nothing', byDefault.anyCollapsed === false)
    check('every goal stays visible', ids(byDefault.visible) === 'p,c1,c2', ids(byDefault.visible))
    check('nothing is hidden', byDefault.folded.length === 0)
    check(
      'the group reports that it could fold',
      byDefault.groups[0]?.allDone === true && byDefault.groups[0]?.collapsed === false,
    )

    const explicitExpand = collapseCompleted(tree, { collapseDone: false })
    check('expand mode returns the full detail', ids(explicitExpand.visible) === 'p,c1,c2', ids(explicitExpand.visible))

    const folded = collapseCompleted(tree, { collapseDone: true })
    check('a fully done subtree folds', folded.anyCollapsed === true)
    check('the parent is the visible row', ids(folded.visible) === 'p', ids(folded.visible))
    check('the children are the folded rows', ids(folded.folded) === 'c1,c2', ids(folded.folded))
    check('the group says it is collapsed', folded.groups[0]?.collapsed === true)
    check(
      'the summary is a completion line with the count',
      folded.groups[0]?.summary.includes('已完成') && folded.groups[0]?.summary.includes('2'),
      folded.groups[0]?.summary,
    )
  }

  {
    const partial = [
      { id: 'p', parentId: null, title: 'Parent', status: 'active' },
      { id: 'c1', parentId: 'p', title: 'C1', status: 'done' },
      { id: 'c2', parentId: 'p', title: 'C2', status: 'active' },
    ]
    const view = collapseCompleted(partial, { collapseDone: true })
    check('a partially done subtree never folds', view.anyCollapsed === false)
    check('both children stay visible', ids(view.visible) === 'p,c1,c2', ids(view.visible))
    check('and nothing is hidden', view.folded.length === 0)
  }

  {
    const nested = [
      { id: 'p', parentId: null, title: 'Parent', status: 'active' },
      { id: 'c1', parentId: 'p', title: 'C1', status: 'done' },
      { id: 'g1', parentId: 'c1', title: 'G1', status: 'active' },
    ]
    const view = collapseCompleted(nested, { collapseDone: true })
    check('a done parent with an active grandchild does not fold', view.anyCollapsed === false, JSON.stringify(view.groups))
    check('the active node stays visible', view.visible.some((goal) => goal.id === 'g1'))
  }

  console.log('\n[view] goal_tree_view folds only when the caller asks')

  const { root, call } = await freshProject()
  const confirmArgs = {
    expectedVersion: 0,
    l0: {
      title: 'Root',
      evidence: ['README.md'],
      successCriteria: ['the root outcome is observable from outside'],
      alignment: { relevantActivities: ['root work'] },
    },
    goals: [
      { title: 'Parent', depth: 1, evidence: ['README.md'], relevantActivities: ['parent work'] },
      {
        title: 'Done one',
        depth: 2,
        parentRef: 'Parent',
        evidence: ['README.md'],
        relevantActivities: ['one work'],
        successCriteria: ['the first step publishes one artifact'],
      },
      {
        title: 'Done two',
        depth: 2,
        parentRef: 'Parent',
        evidence: ['README.md'],
        relevantActivities: ['two work'],
        successCriteria: ['the second step publishes one artifact'],
      },
    ],
    contradictions: [],
    reason: 'collapse fixture',
  }
  await call('goal_tree_confirm', { ...confirmArgs, preview: true, noDeadlineGoalRefs: ['*'] })
  const confirmed = await call('goal_tree_confirm', {
    ...confirmArgs,
    userApproved: true,
    approvalNote: 'collapse 测试确认',
  })
  check('the fixture tree confirms', confirmed.ok === true, codeOf(confirmed))

  const store = new MetacogStore(root, '.metacog')
  const projectId = deriveProjectId(root)
  const config = parseConfig({})

  const firstView = await call('goal_tree_view', {})
  check('the first view lists every goal', firstView.data.goals.length === 4, firstView.data.goals.length)
  check(
    'and marks nothing collapsed',
    firstView.data.goals.every((goal) => goal.collapsed === undefined),
    JSON.stringify(firstView.data.goals.map((goal) => goal.collapsed)),
  )

  const parentId = firstView.data.goals.find((goal) => goal.title === 'Parent').id
  const doneIds = firstView.data.goals
    .filter((goal) => goal.title.startsWith('Done '))
    .map((goal) => goal.id)

  const marked = await call('goal_tree_edit', {
    expectedVersion: firstView.data.version,
    updates: doneIds.map((id) => ({ id, status: 'done' })),
    reason: 'both steps finished',
  })
  check('both children can be marked done', marked.ok === true, codeOf(marked))

  const afterDone = await call('goal_tree_view', {})
  check('the default view still lists every goal', afterDone.data.goals.length === 4, afterDone.data.goals.length)
  check(
    'the done children are present and marked done',
    afterDone.data.goals.filter((goal) => goal.status === 'done').length === 2,
    JSON.stringify(afterDone.data.goals.map((goal) => `${goal.title}:${goal.status}`)),
  )
  check(
    'the parent is not folded by default',
    afterDone.data.goals.find((goal) => goal.id === parentId).collapsed === undefined,
  )

  const foldedView = await call('goal_tree_view', { collapseDoneGoals: true })
  check('the folded view omits the done children', foldedView.data.goals.length === 2, foldedView.data.goals.length)
  const foldedParent = foldedView.data.goals.find((goal) => goal.id === parentId)
  check('the parent carries the fold', foldedParent.collapsed?.folded === 2, JSON.stringify(foldedParent?.collapsed))
  check(
    'with a readable completion summary',
    typeof foldedParent.collapsed?.summary === 'string' && foldedParent.collapsed.summary.includes('已完成'),
    foldedParent?.collapsed?.summary,
  )
  check(
    'and the children are genuinely absent',
    !foldedView.data.goals.some((goal) => doneIds.includes(goal.id)),
  )

  const persistedAfterFold = await store.readState(projectId)
  check('the fold changed no stored goal', persistedAfterFold.goals.length === 4, persistedAfterFold.goals.length)
  check(
    'the stored statuses are untouched',
    persistedAfterFold.goals.filter((goal) => goal.status === 'done').length === 2,
    JSON.stringify(persistedAfterFold.goals.map((goal) => `${goal.title}:${goal.status}`)),
  )

  const backToList = await call('goal_tree_view', {})
  check('a plain view after the folded one is full again', backToList.data.goals.length === 4, backToList.data.goals.length)

  console.log('\n[report] the goal section folds only when the report is asked to')

  const state = await store.readState(projectId)
  const rootGoal = state.goals.find((goal) => goal.depth === 0)
  const childOne = state.goals.find((goal) => goal.title === 'Done one')
  const childTwo = state.goals.find((goal) => goal.title === 'Done two')
  const activity = (index, goalId) => ({
    id: `act_${index}`,
    eventFingerprint: `fp_${index}`,
    projectId,
    sessionId: 'session-collapse',
    timestamp: new Date().toISOString(),
    source: 'tool_event',
    observationGrade: 'A',
    summary: `work attributed to ${goalId}`,
    evidence: ['src/example.ts'],
    candidateGoalIds: [goalId],
    alignmentConfidence: 0.9,
    decision: 'aligned',
    rationale: '',
  })
  await store.appendActivity(projectId, activity(1, childOne.id))
  await store.appendActivity(projectId, activity(2, childTwo.id))
  check('the report fixture has a root to anchor the tree', rootGoal !== undefined)

  const expandedReport = await generateReport({
    store,
    state,
    projectId,
    config,
    type: 'monthly',
    now: new Date(),
  })
  const expandedMd = expandedReport.markdown
  check('the expanded report has the goal section', expandedMd.includes('## 按目标看活动'), expandedMd)
  check(
    'it names both done children',
    expandedMd.includes('Done one') && expandedMd.includes('Done two'),
    expandedMd,
  )

  const foldedReport = await generateReport({
    store,
    state,
    projectId,
    config,
    type: 'monthly',
    now: new Date(),
    collapseDone: true,
  })
  const foldedMd = foldedReport.markdown
  const sectionStart = foldedMd.indexOf('## 按目标看活动')
  check('the folded report still has the goal section', sectionStart >= 0, foldedMd)
  const section = onlySection(foldedMd, '## 按目标看活动')
  check(
    'the section folds the finished branch into one line',
    section.includes('Parent') && /已完成 \d+ 个子目标/.test(section),
    section,
  )
  check('and no longer lists the children there', !section.includes('Done one') && !section.includes('Done two'), section)

  function onlySection(markdown, heading) {
    const start = markdown.indexOf(heading)
    if (start < 0) return ''
    const rest = markdown.slice(start + heading.length)
    const next = rest.search(/^## /m)
    return next < 0 ? rest : rest.slice(0, next)
  }
} finally {
  for (const fixture of fixtures) await rm(fixture, { recursive: true, force: true })
}

console.log(`\nDone collapse: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
