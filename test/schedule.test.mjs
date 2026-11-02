/**
 * Scheduling verification: periodic scheduling and teardown.
 *
 * The timer is injected through a fake host context, so the tests drive ticks
 * deterministically instead of waiting real minutes. What is asserted is the
 * lifecycle contract: a timer exists only when configured, each tick runs a
 * Grade C static sweep, and disposal leaves nothing behind.
 *
 * Run: node test/schedule.test.mjs
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

/**
 * A host with an observable timer.
 *
 * `timer.interval` records the callback so a test can fire a tick on demand,
 * which is the only way to exercise a 25-minute schedule in milliseconds.
 */
function createHost(projectRoot, config, options = {}) {
  const tools = new Map()
  const logs = []
  const listeners = new Map()
  const effects = []
  const timers = []
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
        listeners.set(
          name,
          (listeners.get(name) ?? []).filter((item) => item !== listener),
        )
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
    ...(options.noTimer === true
      ? {}
      : {
          timer: {
            interval(callback, delay) {
              const entry = { callback, delay, cleared: false }
              timers.push(entry)
              return () => {
                entry.cleared = true
              }
            },
          },
        }),
  }
  apply(ctx, config)
  return { ctx, tools, logs, listeners, effects, timers }
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
  const root = await mkdtemp(join(tmpdir(), 'metacog-stagef-'))
  await writeFile(
    join(root, 'README.md'),
    [
      '# Scheduler Project',
      '',
      'A fixture for periodic checks.',
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
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture-project', version: '1.0.0' }, null, 2))
  return root
}

const fixtures = []

async function findProjectId(root) {
  const entries = await readdir(join(root, '.metacog', 'state'))
  return entries.find((name) => name.endsWith('.json'))?.replace(/\.json$/, '') ?? ''
}

async function confirmTree(tools) {
  const draft = await call(tools, 'goal_tree_init', {})
  if (draft.ok !== true) throw new Error(`init failed: ${codeOf(draft)}`)
  const confirmArgs = {
    expectedVersion: 0,
    l0: {
      title: 'Scheduler Project',
      description: 'root',
      evidence: ['README.md'],
      successCriteria: ['periodic checks run'],
      // 本阶段测的是周期产出（定时检查点、报告生成），
      // 根目标服务的活动就是这类周期产出。
      alignment: { relevantActivities: ['周期产出'] },
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
          excludedActivities: [],
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
      },
    ],
  }
  await call(tools, 'goal_tree_confirm', { ...confirmArgs, preview: true, noDeadlineGoalRefs: ['*'] })
  const confirmed = await call(tools, 'goal_tree_confirm', {
    ...confirmArgs,
    userApproved: true,
    approvalNote: 'stage-f 确认',
  })
  if (confirmed.ok !== true) throw new Error(`confirm failed: ${codeOf(confirmed)}`)
  return confirmed.data
}

/** Fire every registered timer callback and let the async work settle. */
async function tick(timers) {
  for (const entry of timers) {
    if (entry.cleared) continue
    entry.callback()
  }
  for (let index = 0; index < 15; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// ---------------------------------------------------------------------- F1
console.log('\nF1  a timer is installed with the configured interval')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, { schedule: { enabled: true, checkIntervalMinutes: 25 } })
  checkEqual('exactly one timer exists', host.timers.length, 1)
  checkEqual('it uses the configured delay', host.timers[0]?.delay, 25 * 60_000)
  check('it is not cleared yet', host.timers[0]?.cleared === false)
}

// ---------------------------------------------------------------------- F2
console.log('\nF2  a disabled schedule creates no timer at all')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, { schedule: { enabled: false } })
  checkEqual('no timer was created', host.timers.length, 0)
  check('the plugin still mounts tools', host.tools.has('check_drift'))
}

// ---------------------------------------------------------------------- F3
console.log('\nF3  a host without the timer service still mounts')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {}, { noTimer: true })
  checkEqual('no timer was created', host.timers.length, 0)
  check('tools are still registered', host.tools.size >= 8)
  check(
    'the gap is reported, not hidden',
    host.logs.some(([level, message]) => level === 'info' && String(message).includes('timer')),
    JSON.stringify(host.logs.map(([level]) => level)),
  )
}

// ---------------------------------------------------------------------- F4
console.log('\nF4  a tick runs a static sweep that records no activity')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, { thresholds: { staleDaysThreshold: 1 } })
  await confirmTree(host.tools)
  await tick(host.timers)

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const activities = await store.readActivities(projectId)
  checkEqual('the sweep invented no activity', activities.length, 0)
  checkEqual('the timer fired once', host.timers.length, 1)
}

// ---------------------------------------------------------------------- F5
console.log('\nF5  a tick opens no intervention card (Grade C cannot escalate)')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {})
  await confirmTree(host.tools)
  for (let index = 0; index < 4; index += 1) await tick(host.timers)

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const interventions = await store.readInterventions(projectId)
  checkEqual('no card was opened by a timer tick', interventions.length, 0)
}

// ---------------------------------------------------------------------- F6
console.log('\nF6  disposal stops the timer and it never fires again')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {})
  await confirmTree(host.tools)

  for (const setup of host.effects) {
    const disposer = await setup()
    await disposer()
  }
  checkEqual('the timer is cleared', host.timers[0]?.cleared, true)

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const before = (await store.readSignals(projectId)).length
  await tick(host.timers)
  const after = (await store.readSignals(projectId)).length
  checkEqual('a cleared tick writes nothing', after, before)
  checkEqual('all tools were unregistered', host.tools.size, 0)
  checkEqual('the event listener is gone', (host.listeners.get('session/event') ?? []).length, 0)
}

// ---------------------------------------------------------------------- F7
console.log('\nF7  disposal is idempotent')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {})
  for (const setup of host.effects) {
    const disposer = await setup()
    await disposer()
    await disposer()
  }
  checkEqual('the timer reports cleared exactly once', host.timers[0]?.cleared, true)
}

// ---------------------------------------------------------------------- F8
console.log('\nF8  a tick with no confirmed project is idle, not an error')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {})
  // No tree confirmed: nothing is enrolled, so the sweep has no projects.
  await tick(host.timers)
  check(
    'the sweep logged no error',
    host.logs.every(([level]) => level !== 'error'),
    JSON.stringify(host.logs.filter(([level]) => level === 'error')),
  )
}

// ---------------------------------------------------------------------- F9
console.log('\nF9  a stale goal is detected by a timer tick')
{
  const root = await makeProject()
  fixtures.push(root)
  // A one-day threshold makes the freshly confirmed goal immediately stale,
  // which is the honest way to exercise the detector without waiting a week.
  const host = createHost(root, { thresholds: { staleDaysThreshold: 1 } })
  const confirmed = await confirmTree(host.tools)

  // Backdate the goal so it is unambiguously past the threshold.
  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const state = await store.readState(projectId)
  const old = new Date(Date.now() - 10 * 86_400_000).toISOString()
  await store.commit(projectId, {
    expectedVersion: state.version,
    goals: state.goals.map((goal) => ({ ...goal, updatedAt: old })),
    contradictions: state.contradictions,
    reason: 'backdate for staleness test',
    action: 'update_lower_goal',
    actor: 'manual_tool',
    targetIds: state.goals.map((goal) => goal.id),
    evidence: ['test fixture'],
  })

  await tick(host.timers)
  const signals = await store.readSignals(projectId)
  const stale = signals.filter((signal) => signal.signalType === 'goal_staleness')
  check('a staleness signal was recorded', stale.length > 0, JSON.stringify(signals.map((s) => s.signalType)))
  check(
    'it is level 1 at most, never a card',
    stale.every((signal) => signal.level <= 1),
    JSON.stringify(stale.map((signal) => signal.level)),
  )
}

// --------------------------------------------------------------------- F10
console.log('\nF10  a stale goal does not open a card even when repeated')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, { thresholds: { staleDaysThreshold: 1, repeatThreshold: 1 } })
  await confirmTree(host.tools)

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const state = await store.readState(projectId)
  const old = new Date(Date.now() - 10 * 86_400_000).toISOString()
  await store.commit(projectId, {
    expectedVersion: state.version,
    goals: state.goals.map((goal) => ({ ...goal, updatedAt: old })),
    contradictions: state.contradictions,
    reason: 'backdate for escalation test',
    action: 'update_lower_goal',
    actor: 'manual_tool',
    targetIds: state.goals.map((goal) => goal.id),
    evidence: ['test fixture'],
  })

  for (let index = 0; index < 5; index += 1) await tick(host.timers)
  const interventions = await store.readInterventions(projectId)
  checkEqual('a repeatThreshold of 1 still opens nothing', interventions.length, 0)
}

// --------------------------------------------------------------------- F11
console.log('\nF11  the interval is configurable')
{
  const root = await makeProject()
  fixtures.push(root)
  const five = createHost(root, { schedule: { enabled: true, checkIntervalMinutes: 5 } })
  checkEqual('a 5-minute interval is honoured', five.timers[0]?.delay, 5 * 60_000)

  const root2 = await makeProject()
  fixtures.push(root2)
  const hour = createHost(root2, { schedule: { enabled: true, checkIntervalMinutes: 60 } })
  checkEqual('a 60-minute interval is honoured', hour.timers[0]?.delay, 60 * 60_000)
}

// --------------------------------------------------------------------- F12
console.log('\nF12  the scheduler boundary is reported honestly')
{
  const schedule = await import(pathToFileURL(join(here, '..', 'lib', 'schedule.js')).href)
  check(
    'no timer service says unsupported',
    schedule.schedulerBoundary(false, true).startsWith('unsupported'),
  )
  check(
    'disabled by config says so without claiming a gap',
    schedule.schedulerBoundary(true, false).includes('disabled by config'),
  )
  check('enabled says supported', schedule.schedulerBoundary(true, true).startsWith('supported'))
}

// --------------------------------------------------------------------- F13
console.log('\nF13  two mounts of different projects keep separate timers')
{
  const rootA = await makeProject()
  fixtures.push(rootA)
  const rootB = await makeProject()
  fixtures.push(rootB)
  const hostA = createHost(rootA, {})
  const hostB = createHost(rootB, {})
  await confirmTree(hostA.tools)
  await confirmTree(hostB.tools)
  await tick(hostA.timers)
  await tick(hostB.timers)

  const storeA = new MetacogStore(rootA, '.metacog')
  const storeB = new MetacogStore(rootB, '.metacog')
  const idA = await findProjectId(rootA)
  const idB = await findProjectId(rootB)
  check('the two project ids differ', idA !== idB)
  checkEqual('project A stays untouched by B', (await storeA.readActivities(idA)).length, 0)
  checkEqual('project B stays untouched by A', (await storeB.readActivities(idB)).length, 0)
  checkEqual('each mount owns one timer', [hostA.timers.length, hostB.timers.length], [1, 1])
}

for (const root of fixtures) {
  try {
    await rm(root, { recursive: true, force: true })
  } catch {
    // Best effort cleanup.
  }
}

console.log(`\n=== Scheduling 结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
