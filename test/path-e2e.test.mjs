/**
 * F1-R2 end-to-end wiring: an activity's file paths must reach the judge.
 *
 * F1 built the path rules and F1-R settled their shape, but both callers of
 * `runActivityCheck` handed the judge only `evidence` — the `paths` array the
 * judge already understood stayed empty, so path ownership never fired outside
 * the unit tests. These cases assert the two doors, not the judge itself:
 *
 *   - `check_drift` derives paths from the evidence a caller reports;
 *   - the live collector derives them from the `<tool>: <value>` evidence its
 *     tool calls produce;
 *   - an activity whose paths no goal claims is `unbound` and produces no
 *     signal at all. The last case is the contrast: the same summary without a
 *     path is still `scope_drift`, which proves the path was load-bearing.
 *
 * Run: node test/path-e2e.test.mjs   (after `npm run build`)
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (path) => pathToFileURL(join(here, '..', 'lib', path)).href

const { apply } = await import(lib('index.js'))
const { MetacogStore } = await import(lib('data/store.js'))
const { deriveProjectId } = await import(lib('tools/shared.js'))
const { parseConfig } = await import(lib('config.js'))
const { runActivityCheck } = await import(lib('analysis/service.js'))
const { pathsFromEvidence } = await import(lib('tools/drift.js'))

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

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * A host whose `on` records listeners, so the collector can be driven with the
 * exact event objects the host would deliver.
 */
function createHost(projectRoot) {
  const tools = new Map()
  const listeners = new Map()
  const logs = []
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return this.workingDirectory
      if (name === 'tools') return this.tools
      return undefined
    },
    logger: {
      debug: () => {},
      info: () => {},
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
    effect: () => {},
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    workingDirectory: { get: () => projectRoot, defaultDirectory: projectRoot },
  }
  apply(ctx, parseConfig({}))
  return { ctx, tools, listeners, logs }
}

/** Call one registered tool through the real `execute` path. */
async function call(tools, name, args) {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`tool "${name}" was never registered`)
  return definition.execute(args, {
    callId: `call-${Math.random().toString(16).slice(2)}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
    agent: { id: 'agent-path-e2e' },
  })
}

function dispatch(listeners, session, event) {
  for (const listener of listeners.get('session/event') ?? []) listener(session, event)
}

/** Deliver one complete turn: tool calls, the closing report, then the boundary. */
function emitTurn(listeners, session, turn, options = {}) {
  let seq = options.seq ?? 1
  for (const tool of options.tools ?? []) {
    dispatch(listeners, session, {
      type: 'tool/call',
      seq,
      data: {
        turn,
        step: 1,
        callId: tool.callId,
        name: tool.name,
        arguments: tool.arguments,
      },
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
    data: { turn, reason: { kind: 'completed' } },
  })
}

/** The collector writes on a serialised chain; poll instead of sleeping a guess. */
async function waitForCount(projectId, reader, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let latest = await reader(projectId)
  while (latest.length < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    latest = await reader(projectId)
  }
  return latest
}

const fixtures = []
const root = await mkdtemp(join(tmpdir(), 'metacog-path-e2e-'))
fixtures.push(root)
await writeFile(join(root, 'README.md'), '# Path e2e\n\nA fixture for path-based alignment wiring.\n')
await mkdir(join(root, 'src', 'api'), { recursive: true })

console.log('\n[evidence] only unambiguous relative paths are promoted')

{
  check(
    'a tool-tagged relative path is kept',
    same(pathsFromEvidence(['edit: src/api/handlers.ts']), ['src/api/handlers.ts']),
    JSON.stringify(pathsFromEvidence(['edit: src/api/handlers.ts'])),
  )
  check(
    'an untagged relative path is kept',
    same(pathsFromEvidence(['src/api/handlers.ts']), ['src/api/handlers.ts']),
  )
  check(
    'a Windows-separator path is kept',
    same(pathsFromEvidence(['write: src\\api\\handlers.ts']), ['src\\api\\handlers.ts']),
  )
  check(
    'duplicates collapse to one candidate',
    pathsFromEvidence(['edit: src/a.ts', 'write: ./src/a.ts']).length === 1,
    JSON.stringify(pathsFromEvidence(['edit: src/a.ts', 'write: ./src/a.ts'])),
  )

  // Each of these is something an evidence line legitimately carries, and none
  // of them may be mistaken for a touched file.
  const rejected = [
    ['a command with arguments', ['pwsh: npm test']],
    ['a glob', ['grep: src/**/*.ts']],
    ['a URL', ['url: https://example.com/a/b']],
    ['a commit id', ['commit: 9f3c1a2']],
    ['a symbol', ['symbol: ConnectionPool.acquire']],
    ['an absolute drive path', ['read: C:\\abs\\x.ts']],
    ['a rooted path', ['read: /abs/x.ts']],
    ['a prose sentence', ['编辑 src/api/handlers.ts 并跑测试']],
    ['a parent-relative path', ['read: ../outside/x.ts']],
    ['no evidence at all', []],
  ]
  for (const [label, evidence] of rejected) {
    check(`not promoted: ${label}`, pathsFromEvidence(evidence).length === 0, JSON.stringify(pathsFromEvidence(evidence)))
  }
}

console.log('\n[fixture] a confirmed tree that declares path ownership')

const host = createHost(root)
const store = new MetacogStore(root, '.metacog')
const projectId = deriveProjectId(root)

const confirmArgs = {
  expectedVersion: 0,
  l0: {
    title: '让监控按路径归属',
    evidence: ['README.md'],
    paths: ['src'],
    alignment: { relevantActivities: ['root placeholder'] },
  },
  goals: [
    {
      title: 'Api',
      evidence: ['README.md'],
      paths: ['src/api'],
      alignment: { relevantActivities: ['api placeholder'] },
      successCriteria: ['each handler module exports exactly one route'],
    },
    {
      title: 'Docs',
      evidence: ['README.md'],
      paths: ['docs'],
      alignment: {
        relevantActivities: ['docs placeholder'],
        excludedActivities: ['marketing landing page rewrite'],
      },
      successCriteria: ['the readme lists every command'],
    },
  ],
  contradictions: [],
  reason: 'path e2e fixture',
}
await call(host.tools, 'goal_tree_confirm', { ...confirmArgs, preview: true, noDeadlineGoalRefs: ['*'] })
const confirmed = await call(host.tools, 'goal_tree_confirm', {
  ...confirmArgs,
  userApproved: true,
  approvalNote: 'path e2e 确认',
})
check('the tree confirms with paths', confirmed.ok === true, JSON.stringify(confirmed).slice(0, 300))

const state = await store.readState(projectId)
const apiGoal = state.goals.find((node) => node.title === 'Api')
check('the Api goal kept its claim', apiGoal?.paths.join() === 'src/api', apiGoal?.paths.join())

const session = { id: 'session-path-e2e', header: { cwd: root } }

console.log('\n[check_drift] evidence paths reach the judge')

{
  const hit = await call(host.tools, 'check_drift', {
    activity: {
      summary: '编辑 API 处理器',
      evidence: ['edit: src/api/handlers.ts', 'edit: a', 'edit: b'],
      grade: 'A',
      source: 'tool_event',
      sessionId: session.id,
      eventFingerprint: 'fp-e2e-tool-bound',
    },
  })
  check('check_drift accepts the activity', hit.ok === true, JSON.stringify(hit).slice(0, 300))
  check('the activity is aligned', hit.data?.activity?.decision === 'aligned', hit.data?.activity?.decision)
  check(
    'the goal that owns the path is the one credited',
    hit.data?.activity?.candidateGoalIds?.includes(apiGoal.id) === true,
    JSON.stringify(hit.data?.activity?.candidateGoalIds),
  )
  check(
    'the rationale cites path ownership',
    String(hit.data?.activity?.rationale).includes('path prefix'),
    hit.data?.activity?.rationale,
  )
  check('a placed activity raises no signal', hit.data?.signals?.length === 0, String(hit.data?.signals?.length))
  check('nothing reaches the signal log', (await store.readSignals(projectId)).length === 0)
}

console.log('\n[check_drift] an unclaimed path is unbound, never drift')

{
  const loose = await call(host.tools, 'check_drift', {
    activity: {
      summary: '整理一个临时脚本',
      evidence: ['edit: scratch/tmp.mjs'],
      grade: 'A',
      source: 'tool_event',
      sessionId: session.id,
      eventFingerprint: 'fp-e2e-tool-unbound',
    },
  })
  check('check_drift accepts the activity', loose.ok === true, JSON.stringify(loose).slice(0, 300))
  check(
    'the record stores the unbound word, not drift',
    loose.data?.activity?.decision === 'unbound',
    loose.data?.activity?.decision,
  )
  check(
    'the unbound rule is the one that fired',
    String(loose.data?.activity?.rationale).includes('not a drift verdict'),
    loose.data?.activity?.rationale,
  )
  check('unbound raises no signal', loose.data?.signals?.length === 0, String(loose.data?.signals?.length))
  check('nothing reaches the signal log', (await store.readSignals(projectId)).length === 0)
}

console.log('\n[collector] the live feed path reaches the judge too')

{
  // The earlier `check_drift` cases wrote records of their own, so the baseline
  // is measured rather than assumed: the turn must add exactly one more, and
  // the one it adds is what gets asserted.
  const before = (await store.readActivities(projectId)).length
  emitTurn(host.listeners, session, 1, {
    seq: 1,
    tools: [
      {
        callId: 'call-e2e-edit',
        name: 'edit',
        arguments: JSON.stringify({ file_path: 'src/api/handlers.ts', old_string: 'a', new_string: 'b' }),
      },
    ],
    report: '把 API 处理器改好，证据是 src/api/handlers.ts。',
  })
  const records = await waitForCount(projectId, (id) => store.readActivities(id), before + 1)
  check(
    'the collector recorded exactly one more activity',
    records.length === before + 1,
    `${String(records.length)} vs ${String(before + 1)} ${JSON.stringify(host.logs.slice(-2))}`,
  )
  const recorded = records[records.length - 1]
  check('the new record came from a completed turn', recorded?.source === 'turn', recorded?.source)
  check(
    'its evidence carries the tool-tagged path',
    recorded?.evidence?.includes('edit: src/api/handlers.ts') === true,
    JSON.stringify(recorded?.evidence),
  )
  check('the collected activity is aligned', recorded?.decision === 'aligned', recorded?.decision)
  check(
    'the collected activity names the claiming goal',
    recorded?.candidateGoalIds?.includes(apiGoal.id) === true,
    JSON.stringify(recorded?.candidateGoalIds),
  )
  check(
    'the collected rationale cites path ownership',
    String(recorded?.rationale).includes('path prefix'),
    recorded?.rationale,
  )
  check('collection raised no signal', (await store.readSignals(projectId)).length === 0)
}

console.log('\n[runActivityCheck] the same contract end to end')

{
  const liveState = await store.readState(projectId)
  const placed = await runActivityCheck(
    store,
    liveState,
    projectId,
    {
      summary: '编辑 API 处理器',
      evidence: ['edit: src/api/handlers.ts'],
      paths: pathsFromEvidence(['edit: src/api/handlers.ts']),
      source: 'tool_event',
      grade: 'A',
      sessionId: session.id,
      eventFingerprint: 'fp-e2e-service-bound',
    },
    parseConfig({}),
  )
  check('a path-carrying activity is aligned', placed.verdict?.decision === 'aligned', placed.verdict?.decision)
  check('and the binding is reported', placed.verdict?.pathBinding?.kind === 'bound')
  check('with the owning goal', placed.verdict?.pathBinding?.goalIds.join() === apiGoal.id)

  const unbound = await runActivityCheck(
    store,
    liveState,
    projectId,
    {
      summary: '整理一个临时脚本',
      evidence: ['edit: scratch/tmp.mjs'],
      paths: pathsFromEvidence(['edit: scratch/tmp.mjs']),
      source: 'tool_event',
      grade: 'A',
      sessionId: session.id,
      eventFingerprint: 'fp-e2e-service-unbound',
    },
    parseConfig({}),
  )
  check('an unclaimed path is unbound', unbound.verdict?.decision === 'unbound', unbound.verdict?.decision)
  check('and produces no signal', unbound.signals.length === 0, String(unbound.signals.length))
  check('and opens no intervention', unbound.interventions.length === 0, String(unbound.interventions.length))
  check('nothing reaches the signal log', (await store.readSignals(projectId)).length === 0)
}

console.log('\n[contrast] without the path the same summary is still drift')

{
  const contrast = await call(host.tools, 'check_drift', {
    activity: {
      summary: 'marketing landing page rewrite',
      evidence: ['临时脚本说明'],
      grade: 'A',
      source: 'tool_event',
      sessionId: session.id,
      eventFingerprint: 'fp-e2e-contrast',
    },
  })
  check(
    'the path-less activity is scope_drift',
    contrast.data?.activity?.decision === 'scope_drift',
    contrast.data?.activity?.decision,
  )
  check(
    'and it does raise a scope_drift signal',
    contrast.data?.signals?.some((entry) => entry.signalType === 'scope_drift') === true,
    JSON.stringify(contrast.data?.signals),
  )
  check('the signal reaches the log', (await store.readSignals(projectId)).length === 1)
}

for (const fixture of fixtures) await rm(fixture, { recursive: true, force: true })

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
