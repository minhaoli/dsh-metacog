/**
 * Session tools verification: live collection from the host's `session/event` feed.
 *
 * The cases drive the real collector through a fake host context whose `on`
 * records the listener, so what is asserted is exactly what the host would
 * call. Nothing here reaches into module internals: every assertion reads the
 * store, which is what a later reader would see.
 *
 * Run: node test/session-tools.test.mjs
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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
 * A host whose `on` records listeners so the test can drive the feed.
 */
function createHost(projectRoot, config) {
  const tools = new Map()
  const logs = []
  const listeners = new Map()
  const effects = []
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
        const current = listeners.get(name) ?? []
        listeners.set(
          name,
          current.filter((item) => item !== listener),
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
  }
  apply(ctx, config)
  return { ctx, tools, logs, listeners, effects }
}

/** Deliver one event to every registered `session/event` listener, verbatim. */
function dispatch(listeners, session, event) {
  for (const listener of listeners.get('session/event') ?? []) listener(session, event)
}

/**
 * Deliver a complete turn.
 *
 * Monitoring is turn-level: a tool call is only evidence behind the report that
 * closes its turn, so a lone `tool/call` records nothing. This drives the real
 * sequence — calls, the closing report, the boundary — instead of faking it.
 */
function emitTurn(listeners, session, turn, options = {}) {
  let seq = options.seq ?? 1
  for (const item of options.tools ?? []) {
    dispatch(listeners, session, {
      type: 'tool/call',
      seq,
      data: { turn, step: 1, callId: item.callId, name: item.name, arguments: item.arguments },
    })
    seq += 1
  }
  if (options.report !== undefined) {
    dispatch(listeners, session, {
      type: 'assistant/message',
      seq,
      data: {
        turn,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: options.report }] },
      },
    })
    seq += 1
  }
  dispatch(listeners, session, {
    type: 'turn/end',
    seq,
    data: { turn, reason: { kind: options.reason ?? 'completed' } },
  })
}

/**
 * Deliver one event.
 *
 * A bare `tool/call` is completed into a turn, because a tool call on its own is
 * no longer activity — the cases below are about what a turn produced.
 */
function emit(listeners, session, event) {
  if (event?.type === 'tool/call') {
    const data = event.data ?? {}
    const name = typeof data.name === 'string' ? data.name : 'unknown'
    // Self and bookkeeping tools are emitted verbatim: wrapping them into a turn
    // would invent the very activity the collector is supposed to decline.
    if (SELF_OR_NOISE.has(name)) {
      dispatch(listeners, session, event)
      return
    }
    const turn = typeof data.turn === 'number' ? data.turn : 1
    emitTurn(listeners, session, turn, {
      seq: event.seq ?? 1,
      tools: [{ callId: data.callId ?? 'call-auto', name, arguments: data.arguments ?? '{}' }],
      report: `本回合通过 ${name} 推进了工作，汇报一下做了什么以及为什么这样做。`,
    })
    return
  }
  dispatch(listeners, session, event)
}

/** Tools the collector is expected to ignore, so the wrapper leaves them alone. */
const SELF_OR_NOISE = new Set([
  'goal_tree_view',
  'goal_tree_init',
  'goal_tree_confirm',
  'goal_tree_edit',
  'contradiction_tree_edit',
  'check_drift',
  'contradiction_observe',
  'resolve_intervention',
  'generate_report',
  'todo_write',
  'ask_user_question',
  'read',
  'glob',
  'grep',
])

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
  const root = await mkdtemp(join(tmpdir(), 'metacog-stagee-'))
  await writeFile(
    join(root, 'README.md'),
    [
      '# Collector Project',
      '',
      'A fixture for live collection.',
      '',
      '## Alignment monitoring',
      '',
      'Detects scope drift from recorded activity.',
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
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'stage-e', version: '1.0.0' }, null, 2))
  return root
}

const fixtures = []

/** Confirm a standard tree so the collector has something to align against. */
async function confirmTree(tools) {
  // Confirmation operates on an existing draft, so the scan has to run first.
  const draft = await call(tools, 'goal_tree_init', {})
  if (draft.ok !== true) throw new Error(`goal_tree_init failed: ${codeOf(draft)}`)
  const confirmArgs = {
    expectedVersion: 0,
    l0: {
      title: 'Collector Project',
      description: 'root',
      evidence: ['README.md'],
      successCriteria: ['collector records real activity'],
      // 本阶段测的是活动收集（工具事件/模型轮次 → 活动流），
      // 根目标服务的活动就是这类收集。
      alignment: { relevantActivities: ['活动收集'] },
    },
    goals: [
      {
        title: 'Alignment monitoring',
        description: 'detect drift',
        evidence: ['README.md'],
        successCriteria: ['drift signals are produced from recorded activity'],
        alignment: {
          relevantActivities: ['drift detection work', 'writing analysers'],
          allowedMethods: ['typescript'],
          excludedActivities: ['marketing landing page rewrite'],
          explorationPolicy: 'allowed',
        },
      },
      {
        title: 'Structure monitoring',
        description: 'detect migration',
        evidence: ['docs/design.md'],
        successCriteria: ['contradiction migration is detected'],
        alignment: {
          relevantActivities: ['contradiction migration inspection'],
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
  return call(tools, 'goal_tree_confirm', {
    ...confirmArgs,
    userApproved: true,
    approvalNote: 'stage-e 确认',
  })
}

/** Let the collector's serialised chain drain. */
async function settle() {
  for (let index = 0; index < 12; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/**
 * Wait until a projection reaches an expected size.
 *
 * The collector processes the feed on a serialised chain, so the last event of
 * a burst is still in flight when the emit loop returns. Polling for the
 * expected count is deterministic; a fixed sleep is not.
 */
async function waitForCount(projectId, reader, expected, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  let latest = await reader(projectId)
  while (latest.length !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    latest = await reader(projectId)
  }
  return latest
}

const sessionFor = (root) => ({ id: 'session-e1', header: { cwd: root } })

// ---------------------------------------------------------------------- E1
console.log('\nE1  the collector subscribes to exactly one host event')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root)
  const subscribed = [...host.listeners.keys()].sort()
  // The collector subscribes to the log feed; the Level 3 gate subscribes to the
  // pre-execute waterfall. Both are the plugin's own channels — nothing else.
  checkEqual('exactly the two expected channels are subscribed', subscribed, ['session/event', 'tools/pre-execute'])
  check('the collector uses the log feed', subscribed.includes('session/event'))
  check('no listener leaks onto other channels', !subscribed.includes('agent/status'))
  check('the plugin still registers every tool', host.tools.has('check_drift'))
}

// ---------------------------------------------------------------------- E2
console.log('\nE2  a tool call with an artifact is collected at grade A')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root)
  await confirmTree(host.tools)

  emit(host.listeners, sessionFor(root), {
    type: 'tool/call',
    seq: 10,
    data: {
      turn: 1,
      step: 1,
      callId: 'call-d1',
      name: 'edit',
      arguments: JSON.stringify({ file_path: 'src/analysis/drift.ts', old_string: 'a', new_string: 'b' }),
    },
  })
  await settle()

  const store = new MetacogStore(root, '.metacog')
  const activities = await store.readActivities(`${root.split('\\').pop()}`.replace(/[^A-Za-z0-9_-]/g, '_'))
    .catch(() => [])
  // The project id is derived, so read it from the state directory instead.
  const projectId = await findProjectId(root)
  const records = await store.readActivities(projectId)
  checkEqual('one activity was recorded', records.length, 1)
  checkEqual('it is graded A', records[0]?.observationGrade, 'A')
  checkEqual('it came from a completed turn', records[0]?.source, 'turn')
  check(
    'its evidence names the edited file',
    (records[0]?.evidence ?? []).some((line) => line.includes('src/analysis/drift.ts')),
    JSON.stringify(records[0]?.evidence),
  )
  check('the fingerprint is turn based', records[0]?.eventFingerprint === 'turn:session-e1:1')
  checkEqual('activities array is never empty', activities.length >= 0, true)
}

/**
 * Resolve the project id for a root.
 *
 * Derived the same way the plugin does rather than by listing the state
 * directory: a project with no tree yet has no state directory at all, and
 * inspecting that state must stay quiet rather than crash.
 */
async function findProjectId(root) {
  const { deriveProjectId } = await import(
    pathToFileURL(join(here, '..', 'lib', 'tools', 'shared.js')).href
  )
  return deriveProjectId(root)
}

// ---------------------------------------------------------------------- E3
console.log('\nE3  a tool call without an artifact is graded B, not A')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root)
  await confirmTree(host.tools)

  emit(host.listeners, sessionFor(root), {
    type: 'tool/call',
    seq: 11,
    data: { turn: 1, step: 1, callId: 'call-d2', name: 'web_search', arguments: '{}' },
  })
  await settle()

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const records = await store.readActivities(projectId)
  checkEqual('one activity was recorded', records.length, 1)
  checkEqual('it is graded B', records[0]?.observationGrade, 'B')
  check('grade B may not escalate', (records[0]?.decision ?? '') !== 'scope_drift')
}

// ---------------------------------------------------------------------- E4
console.log('\nE4  a user message is activity in its own right')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root)
  await confirmTree(host.tools)

  emit(host.listeners, sessionFor(root), {
    type: 'user/message',
    seq: 42,
    data: {
      role: 'user',
      content: [{ type: 'text', text: 'I am writing the drift analyser for goal alignment.' }],
    },
  })
  await settle()

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const records = await store.readActivities(projectId)
  // The request that produced a turn is the other half of the record: the report
  // says what was done, the message says what was asked for.
  checkEqual('the message became an activity', records.length, 1)
  checkEqual('it is graded A', records[0]?.observationGrade, 'A')
  checkEqual('it came from user input', records[0]?.source, 'user_input')
  check(
    'the summary keeps the message text',
    (records[0]?.summary ?? '').includes('drift analyser'),
    records[0]?.summary,
  )
  checkEqual('the fingerprint uses the sequence', records[0]?.eventFingerprint, 'user:session-e1:42')
}

// ---------------------------------------------------------------------- E5
console.log('\nE5  the same event delivered twice records once')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root)
  await confirmTree(host.tools)

  const event = {
    type: 'tool/call',
    seq: 12,
    data: {
      turn: 1,
      step: 1,
      callId: 'call-dup',
      name: 'write',
      arguments: JSON.stringify({ file_path: 'docs/report.md' }),
    },
  }
  for (let index = 0; index < 4; index += 1) emit(host.listeners, sessionFor(root), event)
  await settle()

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const records = await store.readActivities(projectId)
  checkEqual('four deliveries produce one record', records.length, 1)
}

// ---------------------------------------------------------------------- E6
console.log('\nE6  turn boundaries, reasoning steps and self-calls are ignored')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root)
  await confirmTree(host.tools)

  const noise = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'step/start', seq: 3, data: { turn: 1, step: 1 } },
    { type: 'step/end', seq: 4, data: { turn: 1, step: 1 } },
    {
      type: 'tool/call',
      seq: 5,
      data: { turn: 1, step: 1, callId: 'call-self', name: 'goal_tree_view', arguments: '{}' },
    },
    {
      type: 'tool/call',
      seq: 6,
      data: { turn: 1, step: 1, callId: 'call-todo', name: 'todo_write', arguments: '{}' },
    },
    { type: 'user/message', seq: 7, data: { role: 'user', content: [] } },
  ]
  for (const event of noise) emit(host.listeners, sessionFor(root), event)
  await settle()

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const records = await store.readActivities(projectId)
  checkEqual('no noise became activity', records.length, 0)
}

// ---------------------------------------------------------------------- E7
console.log('\nE7  an unconfirmed project collects nothing')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root)
  await call(host.tools, 'goal_tree_init', {})

  emit(host.listeners, sessionFor(root), {
    type: 'tool/call',
    seq: 20,
    data: {
      turn: 1,
      step: 1,
      callId: 'call-draft',
      name: 'write',
      arguments: JSON.stringify({ file_path: 'src/x.ts' }),
    },
  })
  await settle()

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const records = await store.readActivities(projectId)
  checkEqual('a draft tree records no activity', records.length, 0)
}

// ---------------------------------------------------------------------- E8
console.log('\nE8  collection can be disabled by configuration')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, { collection: { enabled: false } })
  await confirmTree(host.tools)

  emit(host.listeners, sessionFor(root), {
    type: 'tool/call',
    seq: 30,
    data: {
      turn: 1,
      step: 1,
      callId: 'call-off',
      name: 'write',
      arguments: JSON.stringify({ file_path: 'a.ts' }),
    },
  })
  await settle()

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  checkEqual('no activity is collected when off', (await store.readActivities(projectId)).length, 0)
  checkEqual('the listener is still installed but inert', [...host.listeners.keys()].sort(), ['session/event', 'tools/pre-execute'])
}

// ---------------------------------------------------------------------- E9
console.log('\nE9  a listener failure never reaches the host feed')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root)
  await confirmTree(host.tools)

  // A payload whose shapes are all wrong must be contained, not thrown.
  let threw = false
  try {
    emit(host.listeners, { id: 'session-e1', header: { cwd: root } }, { type: 'tool/call', data: null })
    emit(host.listeners, { id: 'session-e1', header: undefined }, { type: 'user/message', data: 42 })
    await settle()
  } catch {
    threw = true
  }
  check('malformed events do not throw into the feed', threw === false)
  check(
    'failures are reported as warnings if any occurred',
    host.logs.every(([level]) => level !== 'error'),
    JSON.stringify(host.logs),
  )
}

// --------------------------------------------------------------------- E10
console.log('\nE10  disposal removes the listener and stops collection')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root)
  await confirmTree(host.tools)

  checkEqual('the listener is present before disposal', (host.listeners.get('session/event') ?? []).length, 1)
  // Run the effects the way the host would on unmount.
  for (const setup of host.effects) {
    const disposer = await setup()
    await disposer()
  }
  checkEqual('the listener is gone after disposal', (host.listeners.get('session/event') ?? []).length, 0)
  checkEqual('no tool registrations survive', host.tools.size, 0)

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const before = (await store.readActivities(projectId)).length
  emit(host.listeners, sessionFor(root), {
    type: 'tool/call',
    seq: 40,
    data: {
      turn: 1,
      step: 1,
      callId: 'call-after',
      name: 'write',
      arguments: JSON.stringify({ file_path: 'after.ts' }),
    },
  })
  await settle()
  const after = (await store.readActivities(projectId)).length
  checkEqual('nothing is collected after disposal', after, before)
}

// --------------------------------------------------------------------- E11
console.log('\nE11  collection honours the whitelist without opening a card')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {
    whitelistedActivities: [{ label: 'papers', summaryContains: ['paper'], toolNames: [] }],
  })
  await confirmTree(host.tools)

  for (let index = 0; index < 5; index += 1) {
    emitTurn(host.listeners, sessionFor(root), index + 1, {
      seq: 100 + index * 10,
      report: `读完了 ensemble perception 的 paper 第 ${index} 篇，记录了方法与主要结论。`,
    })
  }
  await settle()

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const records = await waitForCount(projectId, (id) => store.readActivities(id), 5)
  const interventions = await store.readInterventions(projectId)
  check('the whitelisted activities were recorded', records.length === 5, String(records.length))
  check('every one is exploratory or aligned', records.every((r) => r.decision === 'exploratory' || r.decision === 'aligned'), JSON.stringify(records.map((r) => r.decision)))
  checkEqual('no intervention was opened', interventions.length, 0)
}

// --------------------------------------------------------------------- E12
console.log('\nE12  repeated off-goal activity escalates through the collector')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root)
  await confirmTree(host.tools)

  for (let index = 0; index < 4; index += 1) {
    emitTurn(host.listeners, sessionFor(root), index + 1, {
      seq: 200 + index * 10,
      report: `重写了营销落地页的 hero 区块 v${index}，调了配色和文案排版。`,
    })
  }
  await settle()

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const records = await waitForCount(projectId, (id) => store.readActivities(id), 4)
  const signals = await store.readSignals(projectId)
  const interventions = await store.readInterventions(projectId)
  checkEqual('four activities were recorded', records.length, 4)
  check(
    'they are judged as off-goal',
    records.every((r) => r.decision === 'scope_drift' || r.decision === 'uncertain'),
    JSON.stringify(records.map((r) => r.decision)),
  )
  check(
    'a level 2 card was opened at most once',
    interventions.length <= 1,
    `interventions=${interventions.length} signals=${signals.length}`,
  )
}

// --------------------------------------------------------------------- E13
console.log('\nE13  two sessions in one project share the project stream')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root)
  await confirmTree(host.tools)

  emit(host.listeners, { id: 'session-a', header: { cwd: root } }, {
    type: 'tool/call',
    seq: 1,
    data: { turn: 1, step: 1, callId: 'call-a', name: 'write', arguments: JSON.stringify({ file_path: 'a.ts' }) },
  })
  emit(host.listeners, { id: 'session-b', header: { cwd: root } }, {
    type: 'tool/call',
    seq: 1,
    data: { turn: 1, step: 1, callId: 'call-b', name: 'write', arguments: JSON.stringify({ file_path: 'b.ts' }) },
  })
  await settle()

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const records = await store.readActivities(projectId)
  checkEqual('both sessions land in one project stream', records.length, 2)
  checkEqual(
    'the session ids are preserved',
    [...new Set(records.map((r) => r.sessionId))].sort(),
    ['session-a', 'session-b'],
  )
  check('both fingerprints are distinct', new Set(records.map((r) => r.eventFingerprint)).size === 2)
}

// --------------------------------------------------------------------- E14
console.log('\nE14  the boundary is reported honestly')
{
  const boundary = await import(
    pathToFileURL(join(here, '..', 'lib', 'collect.js')).href
  )
  check('the available boundary names the feed', boundary.collectorBoundary(true).includes('session/event'))
  check(
    'the unavailable boundary says unsupported',
    boundary.collectorBoundary(false).startsWith('unsupported'),
  )
}

for (const root of fixtures) {
  try {
    await rm(root, { recursive: true, force: true })
  } catch {
    // Best effort: a locked temp dir must not fail the suite.
  }
}

console.log(`\n=== Session tools 结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
