/**
 * Level 3 hard-gate verification (spec 4.4 item 4).
 *
 * Drives the real `tools/pre-execute` waterfall listener through a fake host,
 * asserting both the shadow mode (off) and the enforcing mode (on). The
 * waterfall contract is `(exec, next) => Promise<PreToolDecision>`, verified
 * against the live host, so what is tested here is what the registry will call.
 *
 * Run: node test/gate.test.mjs
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

function createHost(projectRoot, config) {
  const tools = new Map()
  const logs = []
  const listeners = new Map()
  const effects = []
  const ctx = {
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
    get(name) {
      if (name === 'workingDirectory') {
        return { get: () => projectRoot, defaultDirectory: projectRoot }
      }
      if (name === 'timer') return { interval: () => () => {} }
      if (name === 'systemPrompt') return { section: () => () => {} }
      return undefined
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
  }
  apply(ctx, config)
  return { ctx, tools, logs, listeners, effects }
}

async function call(tools, name, args) {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`tool "${name}" was never registered`)
  return definition.execute(args, {
    callId: `call-${Math.random().toString(16).slice(2)}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
    agent: { id: 'agent-g', session: { id: 'session-g' } },
  })
}

function codeOf(outcome) {
  return outcome?.ok === false ? outcome.error.code : `ok(${JSON.stringify(outcome?.data)})`
}

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), 'metacog-gate-'))
  await writeFile(
    join(root, 'README.md'),
    '# Gate Project\n\n## Alignment monitoring\n\nDetects drift.\n\n## Design tension\n\nSpeed vs proof.\n',
  )
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'docs', 'design.md'), '# Design\n\nAppend-only.\n')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'gate', version: '1.0.0' }, null, 2))
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
      title: 'Gate Project',
      description: 'root',
      evidence: ['README.md'],
      // 本测试驱动的是门控/瀑布判定链路本身，根目标服务的活动就是这类验证。
      alignment: { relevantActivities: ['drift 判定与门控验证'] },
    },
    goals: [
      {
        title: 'Alignment monitoring',
        description: 'detect drift',
        evidence: ['README.md'],
        alignment: {
          relevantActivities: ['drift work'],
          allowedMethods: ['typescript'],
          excludedActivities: ['marketing rewrite'],
          explorationPolicy: 'allowed',
        },
        // 这是 depth-1 叶子，叶子必须可验收；本测试驱动的是门控链路本身。
        successCriteria: ['a drift signal reaches the configured escalation level'],
      },
    ],
    contradictions: [
      {
        title: 'Coverage vs depth',
        description: 'core tension',
        poleA: 'broad',
        poleB: 'deep',
        type: 'core',
        primaryGoalRef: 'Alignment monitoring',
        rationale: 'the L0 goal implies both',
        evidence: ['docs/design.md'],
        // A core bypass needs a high current intensity; supplying it at
        // confirmation is how a user records a reading they already hold.
        intensity: 5,
      },
    ],
  }
  await call(tools, 'goal_tree_confirm', { ...confirmArgs, preview: true, noDeadlineGoalRefs: ['*'] })
  const confirmed = await call(tools, 'goal_tree_confirm', {
    ...confirmArgs,
    userApproved: true,
    approvalNote: 'gate 测试确认',
  })
  if (confirmed.ok !== true) throw new Error(`confirm failed: ${codeOf(confirmed)}`)
  return confirmed.data
}

/**
 * Drive the waterfall: every registered pre-execute listener in order, with
 * `next` delegating to the following one, exactly as the registry composes them.
 */
async function driveGate(host, call_) {
  const chain = [...(host.listeners.get('tools/pre-execute') ?? [])]
  const runAt = async (index) => {
    if (index >= chain.length) return { kind: 'allow' }
    return chain[index](call_, () => runAt(index + 1))
  }
  return runAt(0)
}

/** Open a real Level 3 card through the escalation machine. */
async function openLevel3(tools) {
  // A core_bypass needs both halves: a core contradiction at high intensity
  // (supplied at confirmation) and a run of recorded activity that avoids its
  // goals. Repeat the avoiding activity until the detector fires.
  for (let index = 0; index < 4; index += 1) {
    await call(tools, 'check_drift', {
      activity: {
        summary: `marketing rewrite iteration ${index}`,
        evidence: [`site/m-${index}.tsx`],
        grade: 'A',
        source: 'manual',
      },
    })
  }
}

// ---------------------------------------------------------------------- G1
console.log('\nG1  the gate is installed and reports shadow mode by default')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {})
  checkEqual('one pre-execute listener is registered', (host.listeners.get('tools/pre-execute') ?? []).length, 1)
  const log = host.logs.map(([, message]) => String(message)).join(' ')
  check('the mount log says shadow', log.includes('level3Gate=shadow'), log)
}

// ---------------------------------------------------------------------- G2
console.log('\nG2  with no pending Level 3 card, a mutation is allowed')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {})
  await confirmTree(host.tools)
  // Let the collector enrol the project for the gate's store lookup.
  await call(host.tools, 'goal_tree_view', {})

  const decision = await driveGate(host, {
    name: 'pwsh',
    arguments: { command: 'echo hi' },
    agent: { id: 'agent-g', session: { id: 'session-g' } },
    signal: new AbortController().signal,
  })
  checkEqual('the call is allowed', decision.kind, 'allow')
}

// ---------------------------------------------------------------------- G3
console.log('\nG3  read-only and decision tools are never blocked')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, { gate: { level3HardBlock: true } })
  await confirmTree(host.tools)
  await call(host.tools, 'goal_tree_view', {})

  for (const name of ['read', 'grep', 'goal_tree_view', 'check_drift', 'resolve_intervention']) {
    const decision = await driveGate(host, {
      name,
      arguments: {},
      agent: { id: 'agent-g', session: { id: 'session-g' } },
      signal: new AbortController().signal,
    })
    checkEqual(`${name} is allowed`, decision.kind, 'allow')
  }
}

// ---------------------------------------------------------------------- G4
console.log('\nG4  a pending Level 3 card denies a mutation in enforce mode')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {
    gate: { level3HardBlock: true },
    thresholds: { repeatThreshold: 1, highIntensityThreshold: 4 },
  })
  await confirmTree(host.tools)
  await call(host.tools, 'goal_tree_view', {})
  await openLevel3(host.tools)

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const pending3 = (await store.readInterventions(projectId)).filter(
    (record) => record.status === 'pending' && record.level === 3,
  )
  check('a level 3 card is pending', pending3.length > 0, JSON.stringify(
    (await store.readInterventions(projectId)).map((r) => `L${r.level}/${r.status}`),
  ))

  if (pending3.length > 0) {
    const decision = await driveGate(host, {
      name: 'pwsh',
      arguments: { command: 'rm -rf build' },
      agent: { id: 'agent-g', session: { id: 'session-g' } },
      signal: new AbortController().signal,
    })
    checkEqual('the mutation is denied', decision.kind, 'deny')
    check(
      'the reason names the card',
      String(decision.reason).includes(pending3[0].id),
      String(decision.reason),
    )
    check(
      'the reason says how to unblock',
      String(decision.reason).includes('resolve_intervention'),
      String(decision.reason),
    )
  }
}

// ---------------------------------------------------------------------- G5
console.log('\nG5  in shadow mode the same call is allowed and counted')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {
    gate: { level3HardBlock: false },
    thresholds: { repeatThreshold: 1, highIntensityThreshold: 4 },
  })
  await confirmTree(host.tools)
  await call(host.tools, 'goal_tree_view', {})
  await openLevel3(host.tools)

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const pending3 = (await store.readInterventions(projectId)).filter(
    (record) => record.status === 'pending' && record.level === 3,
  )

  if (pending3.length > 0) {
    const decision = await driveGate(host, {
      name: 'pwsh',
      arguments: { command: 'echo hi' },
      agent: { id: 'agent-g', session: { id: 'session-g' } },
      signal: new AbortController().signal,
    })
    checkEqual('shadow mode allows the call', decision.kind, 'allow')
  } else {
    check('no level 3 card was opened to shadow', true)
  }
}

// ---------------------------------------------------------------------- G6
console.log('\nG6  a level 2 card never blocks anything')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, { gate: { level3HardBlock: true } })
  await confirmTree(host.tools)
  await call(host.tools, 'goal_tree_view', {})

  for (let index = 0; index < 4; index += 1) {
    await call(host.tools, 'check_drift', {
      activity: {
        summary: `marketing rewrite ${index}`,
        evidence: [`site/m-${index}.tsx`],
        grade: 'A',
        source: 'manual',
      },
    })
  }

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const cards = await store.readInterventions(projectId)
  const level2 = cards.filter((record) => record.status === 'pending' && record.level === 2)
  check('a level 2 card is pending', level2.length > 0, JSON.stringify(cards.map((r) => `L${r.level}`)))

  const decision = await driveGate(host, {
    name: 'pwsh',
    arguments: { command: 'echo hi' },
    agent: { id: 'agent-g', session: { id: 'session-g' } },
    signal: new AbortController().signal,
  })
  checkEqual('level 2 does not deny the call', decision.kind, 'allow')
}

// ---------------------------------------------------------------------- G7
console.log('\nG7  an aborted call is passed through untouched')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, { gate: { level3HardBlock: true } })
  await confirmTree(host.tools)
  await call(host.tools, 'goal_tree_view', {})

  const controller = new AbortController()
  controller.abort()
  const decision = await driveGate(host, {
    name: 'pwsh',
    arguments: {},
    agent: { id: 'agent-g', session: { id: 'session-g' } },
    signal: controller.signal,
  })
  checkEqual('an aborted call is allowed through', decision.kind, 'allow')
}

// ---------------------------------------------------------------------- G8
console.log('\nG8  a call with no session is allowed (fail open)')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, { gate: { level3HardBlock: true } })
  await confirmTree(host.tools)

  const decision = await driveGate(host, {
    name: 'pwsh',
    arguments: {},
    signal: new AbortController().signal,
  })
  checkEqual('a sessionless call is not judged', decision.kind, 'allow')
}

// ---------------------------------------------------------------------- G9
console.log('\nG9  disposal removes the gate')
{
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, { gate: { level3HardBlock: true } })
  checkEqual('listener present', (host.listeners.get('tools/pre-execute') ?? []).length, 1)
  for (const setup of host.effects) {
    const disposer = await setup()
    await disposer()
  }
  checkEqual('listener gone', (host.listeners.get('tools/pre-execute') ?? []).length, 0)
}

// --------------------------------------------------------------------- G10
console.log('\nG10  the gate evaluates the real card state')
{
  const gateModule = await import(pathToFileURL(join(here, '..', 'lib', 'gate.js')).href)
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root, {
    gate: { level3HardBlock: true },
    thresholds: { repeatThreshold: 1, highIntensityThreshold: 4 },
  })
  await confirmTree(host.tools)
  await call(host.tools, 'goal_tree_view', {})
  await openLevel3(host.tools)

  const store = new MetacogStore(root, '.metacog')
  const projectId = await findProjectId(root)
  const config = {
    gate: { level3HardBlock: true, neverBlocked: ['goal_tree_view'] },
    quiet: { enabled: false, keepHardBlock: true, suppressPromptBlock: false },
    quiet: { enabled: false, keepHardBlock: true, suppressPromptBlock: false },
    // evaluateCall reads `gate` and, since silent mode landed, `quiet`. It tolerates
    // a missing `quiet`, but spelling it out keeps this a test of the gate rather
    // than of the fallback.
  }
  const decision = await gateModule.evaluateCall(
    { name: 'pwsh', agent: { id: 'agent-g', session: { id: 'session-g' } } },
    { ctx: host.ctx, config, storeForSession: async () => ({ store, projectId }) },
  )
  const cards = await store.readInterventions(projectId)
  const hasLevel3 = cards.some((record) => record.status === 'pending' && record.level === 3)
  checkEqual('evaluateCall agrees with the stored state', decision.decision.kind, hasLevel3 ? 'deny' : 'allow')
}

for (const root of fixtures) {
  try {
    await rm(root, { recursive: true, force: true })
  } catch {
    // Best effort cleanup.
  }
}

console.log(`\n=== Gate 结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1

