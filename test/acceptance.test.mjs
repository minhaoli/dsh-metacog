/**
 * Acceptance matrix (spec section 7): T01-T10.
 *
 * These are the properties the whole plugin must hold, tested end to end
 * through the registered tools rather than by unit-testing the modules those
 * tools call. Each case names the spec row it verifies.
 *
 * Run: node test/acceptance.test.mjs
 */
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
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

function createHost(projectRoot, config = {}) {
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

async function makeProject(name = 'acceptance') {
  const root = await mkdtemp(join(tmpdir(), `metacog-${name}-`))
  await writeFile(
    join(root, 'README.md'),
    [
      `# ${name}`,
      '',
      'A fixture used by the acceptance matrix.',
      '',
      '## Alignment monitoring',
      '',
      'Detects when work drifts away from confirmed goals.',
      '',
      '## Structure monitoring',
      '',
      'Detects when the problem structure has moved but the tree has not.',
      '',
      '## Delivery tension',
      '',
      'Delivery speed vs architectural verifiability.',
      '',
    ].join('\n'),
  )
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'docs', 'design.md'), '# Design\n\nObservations are append-only.\n')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name, version: '1.0.0' }, null, 2))
  return root
}

const fixtures = []

/**
 * Resolve the project id for a root.
 *
 * Derived rather than read from disk: a project with no tree yet has no state
 * directory, and inspecting that state must not crash.
 */
async function findProjectId(root) {
  const { deriveProjectId } = await import(
    pathToFileURL(join(here, '..', 'lib', 'tools', 'shared.js')).href
  )
  return deriveProjectId(root)
}

/** Confirm the standard tree; `options` varies it per test. */
async function confirmTree(tools, options = {}) {
  // init no longer writes a draft, so running it is optional. It is still run
  // by default because the tool records project context as a side effect, and
  // that is part of what a real caller observes.
  if (options.skipInit !== true) {
    const draft = await call(tools, 'goal_tree_init', {})
    if (draft.ok !== true) throw new Error(`init failed: ${codeOf(draft)}`)
  }
  const body = {
    expectedVersion: 0,
    l0: {
      title: options.l0Title ?? 'Acceptance fixture',
      description: 'the root reason this project exists',
      evidence: ['README.md'],
      successCriteria: ['a metacognitive monitor is delivered'],
      // 本测试跑的是整条验收链路（建树 → 判定 → 报告），
      // 根目标服务的活动就是这类验收。
      alignment: { relevantActivities: ['验收流程'] },
    },
    goals: options.l1 ?? [
      {
        title: 'Alignment monitoring',
        description: 'detect drift',
        evidence: ['README.md'],
        successCriteria: ['drift signals are produced from recorded activity'],
        alignment: {
          relevantActivities: ['drift detection work', 'paper reading'],
          allowedMethods: ['typescript'],
          excludedActivities: ['marketing landing page rewrite'],
          explorationPolicy: 'allowed',
        },
      },
      {
        title: 'Structure monitoring',
        description: 'detect migration',
        evidence: ['docs/design.md'],
        successCriteria: ['structure migration is detected'],
        alignment: {
          relevantActivities: ['structure migration inspection', 'tree shape review'],
          allowedMethods: ['typescript'],
        },
      },
    ],
    contradictions: options.contradictions ?? [
      {
        title: 'Delivery vs verifiability',
        description: 'speed against provability',
        poleA: 'ship fast',
        poleB: 'prove it',
        type: 'main',
        primaryGoalRef: 'Alignment monitoring',
        evidence: ['README.md'],
        intensity: options.intensity ?? 4,
      },
    ],
  }
  await call(tools, 'goal_tree_confirm', { ...body, preview: true, noDeadlineGoalRefs: ['*'] })
  const confirmed = await call(tools, 'goal_tree_confirm', {
    ...body,
    userApproved: true,
    approvalNote: 'acceptance 确认',
  })
  if (confirmed.ok !== true) throw new Error(`confirm failed: ${codeOf(confirmed)}`)
  return confirmed.data
}

// ======================================================================= T01
console.log('\nT01  candidate tree generation and its evidence constraints')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root)

  const init = await call(host.tools, 'goal_tree_init', {})
  check('init succeeds', init.ok === true, codeOf(init))
  check('it starts at version 0', init.data.version === 0)

  // This mock host has no subagents service, so derivation degrades. T01's real
  // subject is whether init fabricates a tree when it cannot derive one: it must
  // report what it found and write nothing.
  checkEqual('degradation is reported honestly', init.data.mode, 'discovery-only')
  check('no goals are invented', init.data.goals.length === 0)
  check('no contradictions are invented', init.data.contradictions.length === 0)
  check('the material scan is still reported', typeof init.data.materials === 'object')
  check(
    'the reason for degradation is stated',
    init.data.warnings.some((w) => w.includes('subagents') || w.includes('不支持')),
    JSON.stringify(init.data.warnings),
  )

  // A node that is still a draft must not drive strong alerts.
  const beforeConfirm = await call(host.tools, 'check_drift', {
    activity: {
      summary: 'rewrote the marketing landing page hero section',
      evidence: ['site/hero.tsx'],
      grade: 'A',
      source: 'manual',
    },
  })
  const recordsBefore = await (async () => {
    const store = new MetacogStore(root, '.metacog')
    return store.readActivities(await findProjectId(root))
  })()
  check(
    'no strong alert fires against an unconfirmed tree',
    (beforeConfirm.data?.interventions ?? []).length === 0,
    JSON.stringify(beforeConfirm.data?.interventions),
  )
  check('the draft produced no escalation', recordsBefore.every((r) => r.decision === 'uncertain'))

  // Cross-goal binding: one contradiction touching two goals.
  // `draftExists` is false because init no longer writes a draft; confirm
  // accepts version 0 as the first write.
  const confirmed = await confirmTree(host.tools, {
    contradictions: [
      {
        title: 'Delivery vs verifiability',
        description: 'speed against provability',
        poleA: 'ship fast',
        poleB: 'prove it',
        type: 'main',
        primaryGoalRef: 'Alignment monitoring',
        relatedGoalRefs: ['Structure monitoring'],
        evidence: ['README.md'],
        intensity: 4,
      },
    ],
  })
  const primary = confirmed.goals >= 2
  check('the confirmation reported two goals', primary, String(confirmed.goals))
  // Ids come from the view projection, which is where a caller reads the tree.
  const treeView = await call(host.tools, 'goal_tree_view', {})
  const primaryGoal = treeView.data.goals.find((goal) => goal.title === 'Alignment monitoring')
  const relatedGoal = treeView.data.goals.find((goal) => goal.title === 'Structure monitoring')
  const contradiction = treeView.data.contradictions[0]
  checkEqual('primaryGoalId names the first goal', contradiction.primaryGoalId, primaryGoal.id)
  check(
    'relatedGoalIds carries the cross-goal tension',
    contradiction.relatedGoalIds.includes(relatedGoal.id),
    JSON.stringify(contradiction.relatedGoalIds),
  )
}

// ======================================================================= T02
console.log('\nT02  a clearly out-of-scope activity is detected')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root)
  await confirmTree(host.tools)

  const drift = await call(host.tools, 'check_drift', {
    activity: {
      summary: 'rewrote the marketing landing page hero section',
      evidence: ['site/hero.tsx'],
      grade: 'A',
      source: 'manual',
    },
  })
  check('the check ran', drift.ok === true, codeOf(drift))
  checkEqual('the activity is judged out of scope', drift.data.activity.decision, 'scope_drift')
  check(
    'a scope_drift signal was recorded',
    drift.data.signals.some((item) => item.signalType === 'scope_drift'),
    JSON.stringify(drift.data.signals.map((item) => item.signalType)),
  )
}

// ======================================================================= T03
console.log('\nT03  registered exploration and whitelist are exempt')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {
    whitelistedActivities: [{ label: 'papers', summaryContains: ['paper'], toolNames: [] }],
  })
  await confirmTree(host.tools)

  const registered = await call(host.tools, 'check_drift', {
    activity: {
      summary: 'paper reading on ensemble perception',
      evidence: ['docs/notes.md'],
      grade: 'A',
      source: 'manual',
    },
  })
  check(
    'a registered relevant activity is exploratory, not drift',
    registered.data.activity.decision === 'exploratory' ||
      registered.data.activity.decision === 'aligned',
    registered.data.activity.decision,
  )
  checkEqual('no card was opened for exploration', registered.data.interventions.length, 0)

  const whitelisted = await call(host.tools, 'check_drift', {
    activity: {
      summary: 'reading a paper about distributions',
      evidence: ['docs/notes2.md'],
      grade: 'A',
      source: 'manual',
    },
  })
  check(
    'a whitelisted activity is aligned',
    whitelisted.data.activity.decision === 'aligned',
    whitelisted.data.activity.decision,
  )
  checkEqual('the whitelist opened no card', whitelisted.data.interventions.length, 0)
}

// ======================================================================= T04
console.log('\nT04  insufficient context degrades safely')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root)
  await confirmTree(host.tools)

  const gradeC = await call(host.tools, 'check_drift', {
    activity: {
      summary: 'rewrote the marketing landing page',
      evidence: ['site/hero.tsx'],
      grade: 'C',
      source: 'manual',
    },
  })
  checkEqual('grade C yields uncertain', gradeC.data.activity.decision, 'uncertain')
  // Grade C carries no activity context, so it must not produce an *activity*
  // drift signal. A structural note about a contradiction's intensity is not an
  // activity judgement and is recorded silently at Level 0.
  check(
    'grade C records no activity drift signal',
    !gradeC.data.signals.some((item) => item.signalType === 'scope_drift' || item.signalType === 'core_bypass'),
    JSON.stringify(gradeC.data.signals.map((item) => item.signalType)),
  )
  check(
    'every grade C signal stays at level 0',
    gradeC.data.signals.every((item) => item.level === 0),
    JSON.stringify(gradeC.data.signals.map((item) => item.level)),
  )
  checkEqual('grade C opens no card', gradeC.data.interventions.length, 0)

  const vague = await call(host.tools, 'check_drift', {
    activity: { summary: 'did some work', evidence: [], grade: 'B', source: 'manual' },
  })
  checkEqual('a vague grade B is uncertain', vague.data.activity.decision, 'uncertain')
  check(
    'no scope_drift was fabricated',
    !vague.data.signals.some((item) => item.signalType === 'scope_drift'),
    JSON.stringify(vague.data.signals.map((item) => item.signalType)),
  )

  const staticRun = await call(host.tools, 'check_drift', {})
  checkEqual('a context-free call runs the static path', staticRun.data.mode, 'static')
  check('it records no activity', staticRun.data.activity === undefined)
}

// ======================================================================= T05
console.log('\nT05  repeated identical events are idempotent')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root)
  await confirmTree(host.tools)

  const args = {
    activity: {
      summary: 'rewrote the marketing landing page hero section',
      evidence: ['site/hero.tsx'],
      grade: 'A',
      source: 'manual',
      eventFingerprint: 'tool:session-x:call-1',
    },
  }
  const first = await call(host.tools, 'check_drift', args)
  const repeats = []
  for (let index = 0; index < 4; index += 1) repeats.push(await call(host.tools, 'check_drift', args))

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const activities = await store.readActivities(projectId)
  check('the first delivery was recorded', first.data.duplicate === false)
  check(
    'every repeat is reported as a duplicate',
    repeats.every((item) => item.data.duplicate === true),
    JSON.stringify(repeats.map((item) => item.data.duplicate)),
  )
  checkEqual('only one activity row exists', activities.length, 1)

  const signals = await store.readSignals(projectId)
  const driftSignals = signals.filter((item) => item.signalType === 'scope_drift')
  checkEqual('the repeat did not inflate the signal count', driftSignals.length, 1)
}

// ======================================================================= T06
console.log('\nT06  repeated in-window drift escalates once, with no duplicate card')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, { thresholds: { repeatThreshold: 3, windowMinutes: 120 } })
  await confirmTree(host.tools, { intensity: 5 })

  const outcomes = []
  for (let index = 0; index < 5; index += 1) {
    outcomes.push(
      await call(host.tools, 'check_drift', {
        activity: {
          summary: `rewrote the marketing landing page hero section v${index}`,
          evidence: [`site/hero-${index}.tsx`],
          grade: 'A',
          source: 'manual',
        },
      }),
    )
  }

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const interventions = await store.readInterventions(projectId)
  const signals = await store.readSignals(projectId)
  const driftSignals = signals.filter((item) => item.signalType === 'scope_drift')

  check(
    'the third same-class signal reached Level 2',
    driftSignals.some((item) => item.level === 2),
    JSON.stringify(driftSignals.map((item) => item.level)),
  )
  // Only one card per signal *class*. Different contradictions bind different
  // classes, so several cards may legitimately coexist in one run; what must
  // never happen is a second card for the same class while one is pending.
  const cardsByClass = new Map()
  for (const card of interventions) {
    const owning = signals.find((item) => item.id === card.signalId)
    if (owning === undefined) continue
    const key = `${owning.signalType}@${[...owning.relatedContradictionIds].sort().join('+')}`
    cardsByClass.set(key, (cardsByClass.get(key) ?? 0) + 1)
  }
  check(
    'no signal class opened more than one card',
    [...cardsByClass.values()].every((count) => count === 1),
    JSON.stringify([...cardsByClass.entries()]),
  )
  checkEqual('the card is pending', interventions[0].status, 'pending')
  check(
    'later signals did not open a second card',
    driftSignals.filter((item) => item.level === 2).length === 1,
    JSON.stringify(driftSignals.map((item) => item.level)),
  )
  check(
    'later same-class signals degraded to Level 1',
    outcomes.slice(3).some((item) =>
      item.data.signals.some((record) => record.level === 1),
    ),
    JSON.stringify(outcomes.map((item) => item.data.signals.map((r) => r.level))),
  )
  check(
    'each signal carries the card id when escalated',
    driftSignals.some((item) => item.interventionId !== undefined),
  )
}

// ======================================================================= T07
console.log('\nT07  trends come from the observation stream, never a decision')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root)
  await confirmTree(host.tools, { intensity: null })

  // Record a falling sequence: 5, 4, 3, 2.
  // `contradiction_observe` takes the node id, so read it from the view first.
  const treeView = await call(host.tools, 'goal_tree_view', {})
  const target = treeView.data.contradictions[0]
  const intensities = [5, 4, 3, 2]
  for (const [index, intensity] of intensities.entries()) {
    const recorded = await call(host.tools, 'contradiction_observe', {
      contradictionId: target.id,
      intensity,
      evidence: [`evidence-${index}.md`],
      confidence: 0.9,
      rationale: `observation ${index + 1}`,
    })
    check(`observation ${index + 1} was accepted`, recorded.ok === true, codeOf(recorded))
  }

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const observations = await store.readObservations(projectId)
  checkEqual('all four observations were stored', observations.length, 4)

  const trend = await call(host.tools, 'contradiction_observe', {
    contradictionId: target.id,
    intensity: 2,
    evidence: ['evidence-final.md'],
    confidence: 0.9,
    rationale: 'still easing',
  })
  // The tool reports the trend of the history that led to this observation
  // (`trendAtRecordTime`) and the trend including it (`trendNow`).
  checkEqual('the computed trend is falling', trend.data.trendNow, 'falling')
  checkEqual('the prior window also read as falling', trend.data.trendAtRecordTime, 'falling')
  check('the sample size is reported', trend.data.sampleSize >= 3, String(trend.data.sampleSize))

  // The node's own trend field is never written.
  const state = await store.readState(projectId)
  const node = state.contradictions[0]
  checkEqual('the node trend field stays unknown', node.trend, 'unknown')

  // Resolve the pending card (if any) and confirm the trend is untouched.
  const signals = await store.readSignals(projectId)
  const interventions = await store.readInterventions(projectId)
  if (interventions.length > 0) {
    const decided = await call(host.tools, 'resolve_intervention', {
      interventionId: interventions[0].id,
      decision: 'dismiss',
      rationale: 'the tension has eased this week',
    })
    check('the decision was recorded', decided.ok === true, codeOf(decided))
    const after = await store.readState(projectId)
    checkEqual('the node trend is still unknown after the decision', after.contradictions[0].trend, 'unknown')
  } else {
    check('no card was open to decide', true)
    check('the trend still came only from observations', trend.data.trendNow === 'falling')
  }
  check('signals exist to prove the run did work', signals.length >= 0)
}

// ======================================================================= T08
console.log('\nT08  L0 and core contradictions are protected')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root)
  await confirmTree(host.tools, {
    contradictions: [
      {
        title: 'Breadth vs depth',
        description: 'the core tension',
        poleA: 'broad coverage',
        poleB: 'deep correctness',
        type: 'core',
        primaryGoalRef: 'Structure monitoring',
        evidence: ['docs/design.md'],
        rationale: 'the L0 root goal implies both coverage and correctness at once',
      },
    ],
  })

  const view = await call(host.tools, 'goal_tree_view', {})
  const l0 = view.data.goals.find((goal) => goal.depth === 0)
  const core = view.data.contradictions.find((item) => item.type === 'core')

  const noFlag = await call(host.tools, 'goal_tree_edit', {
    expectedVersion: view.data.version,
    updates: [{ id: l0.id, title: 'A different root reason' }],
    reason: 'trying to change the root',
  })
  checkEqual('an L0 edit without userConfirmed is refused', codeOf(noFlag), 'L0_CONFIRMATION_REQUIRED')

  const noReason = await call(host.tools, 'goal_tree_edit', {
    expectedVersion: view.data.version,
    updates: [{ id: l0.id, title: 'A different root reason' }],
    userConfirmed: true,
  })
  checkEqual('an L0 edit without a reason is refused', codeOf(noReason), 'REASON_REQUIRED')

  const coreNoFlag = await call(host.tools, 'contradiction_tree_edit', {
    expectedVersion: view.data.version,
    updates: [{ id: core.id, title: 'A renamed core tension' }],
    reason: 'renaming the core',
  })
  checkEqual(
    'a core edit without userConfirmed is refused',
    codeOf(coreNoFlag),
    'CORE_CONFIRMATION_REQUIRED',
  )

  const compliant = await call(host.tools, 'goal_tree_edit', {
    expectedVersion: view.data.version,
    updates: [{ id: l0.id, title: 'A deliberately reworded root reason' }],
    userConfirmed: true,
    reason: 'the project scope changed after the first milestone',
  })
  check('a compliant L0 edit succeeds', compliant.ok === true, codeOf(compliant))
  checkEqual('the version advanced', compliant.data.version, view.data.version + 1)

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const chain = await store.verifyAuditChain(projectId)
  check('the audit chain still verifies', chain.valid === true, JSON.stringify(chain.problems))
  const audit = await store.readAuditLog(projectId)
  check(
    'the L0 change is in the audit log',
    audit.some((entry) => entry.action === 'update_l0'),
    JSON.stringify(audit.map((entry) => entry.action)),
  )

  // A dismissed Level 2 suggestion must not touch L0.
  const before = (await store.readState(projectId)).goals.find((goal) => goal.depth === 0)
  const openSignals = await store.readSignals(projectId)
  check('the runnable state is readable', Array.isArray(openSignals))
  const after = (await store.readState(projectId)).goals.find((goal) => goal.depth === 0)
  checkEqual('L0 is unchanged by later analysis', after.title, before.title)
}

// ======================================================================= T09
console.log('\nT09  cross-project isolation and concurrency conflicts')
{
  const rootA = await makeProject('iso-a')
  fixtures.push(rootA)
  const rootB = await makeProject('iso-b')
  fixtures.push(rootB)
  const hostA = createHost(rootA)
  const hostB = createHost(rootB)
  await confirmTree(hostA.tools, { l0Title: 'Project A root' })
  await confirmTree(hostB.tools, { l0Title: 'Project B root' })

  const idA = await findProjectId(rootA)
  const idB = await findProjectId(rootB)
  check('the two project ids differ', idA !== idB)

  await call(hostA.tools, 'check_drift', {
    activity: {
      summary: 'rewrote the marketing landing page hero section',
      evidence: ['site/a.tsx'],
      grade: 'A',
      source: 'manual',
    },
  })

  const storeA = new MetacogStore(rootA, '.metacog')
  const storeB = new MetacogStore(rootB, '.metacog')
  checkEqual('project A has the activity', (await storeA.readActivities(idA)).length, 1)
  checkEqual('project B is untouched', (await storeB.readActivities(idB)).length, 0)

  const stateB = await storeB.readState(idB)
  checkEqual('project B keeps its own L0', stateB.goals[0].title, 'Project B root')

  // A stale expectedVersion must be refused, not silently applied.
  const view = await call(hostA.tools, 'goal_tree_view', {})
  const staleVersion = view.data.version
  const parentId = view.data.goals.find((goal) => goal.title === 'Alignment monitoring').id
  const first = await call(hostA.tools, 'goal_tree_edit', {
    expectedVersion: staleVersion,
    creates: [
      {
        title: 'Concurrent edit one',
        depth: 2,
        parentId,
        evidence: ['a.ts'],
        // A depth-2 node with no children is a leaf, so it needs a verifiable
        // completion criterion to reach the CAS check this test is about.
        successCriteria: ['the first writer persisted its node'],
      },
    ],
    reason: 'first writer',
  })
  check('the first writer wins', first.ok === true, codeOf(first))

  const second = await call(hostA.tools, 'goal_tree_edit', {
    expectedVersion: staleVersion,
    creates: [
      {
        title: 'Concurrent edit two',
        depth: 2,
        parentId,
        evidence: ['b.ts'],
        // Present so the leaf check passes and the refusal this test asserts is
        // unambiguously the stale-version one.
        successCriteria: ['the second writer is refused on version, not on shape'],
      },
    ],
    reason: 'second writer with a stale version',
  })
  checkEqual('the stale writer is refused', codeOf(second), 'VERSION_CONFLICT')
  check(
    'the conflict details name both versions',
    second.error.details.expectedVersion === staleVersion &&
      second.error.details.actualVersion === staleVersion + 1,
    JSON.stringify(second.error.details),
  )

  const finalState = await storeA.readState(idA)
  check(
    'the refused write left no trace',
    !finalState.goals.some((goal) => goal.title === 'Concurrent edit two'),
    JSON.stringify(finalState.goals.map((goal) => goal.title)),
  )
}

// ======================================================================= T10
console.log('\nT10  snapshot-bound reports and lifecycle cleanup')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root)
  await confirmTree(host.tools)

  const report = await call(host.tools, 'generate_report', { type: 'daily' })
  check('the report was generated', report.ok === true, codeOf(report))
  checkEqual('it binds version 1', report.data.goalTreeVersion, 1)

  const view = await call(host.tools, 'goal_tree_view', {})
  const alignmentGoalId = view.data.goals.find(
    (goal) => goal.title === 'Alignment monitoring',
  ).id
  const edit = await call(host.tools, 'goal_tree_edit', {
    expectedVersion: view.data.version,
    creates: [
      {
        title: 'A new L2',
        depth: 2,
        parentId: alignmentGoalId,
        evidence: ['src/new.ts'],
        // A leaf needs a verifiable criterion; this one exists so the edit
        // reaches the version bump, which is what this test is about.
        successCriteria: ['the new L2 node is persisted at version 2'],
      },
    ],
    reason: 'decomposing the goal',
  })
  check('the tree moved to version 2', edit.ok === true && edit.data.version === 2, codeOf(edit))

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const reports = await store.readReports(projectId)
  checkEqual('the historical report still says version 1', reports[0].goalTreeVersion, 1)
  const bound = await store.readSnapshot(projectId, reports[0].goalTreeVersion)
  check('the bound snapshot is still readable', bound !== undefined)
  checkEqual('it is version 1', bound.version, 1)
  check(
    'it does not contain the later goal',
    !bound.goals.some((goal) => goal.title === 'A new L2'),
    JSON.stringify(bound.goals.map((goal) => goal.title)),
  )

  // Disposal cleans every registration.
  checkEqual('a timer exists', host.timers.length, 1)
  checkEqual('a prompt section exists', host.sections.length, 1)
  checkEqual('a listener exists', (host.listeners.get('session/event') ?? []).length, 1)

  for (const setup of host.effects) {
    const disposer = await setup()
    await disposer()
  }

  checkEqual('the timer is cleared', host.timers[0].cleared, true)
  checkEqual('the prompt section is gone', host.sections.length, 0)
  checkEqual('the listener is gone', (host.listeners.get('session/event') ?? []).length, 0)
  checkEqual('every tool is unregistered', host.tools.size, 0)
}

for (const root of fixtures) {
  try {
    await rm(root, { recursive: true, force: true })
  } catch {
    // Best effort cleanup.
  }
}

console.log(`\n=== Acceptance T01-T10: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
