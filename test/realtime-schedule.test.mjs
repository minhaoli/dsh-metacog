/**
 * `src/schedule.ts` realtime scheduler + the five-field verdict contract.
 *
 * The scheduler is exercised with an injected clock, timer and verdict runner:
 * no live model and no real 5-minute wait. The store is real, because the
 * point of the integration is that the window boundary, the verdict record and
 * the checkpoint actually agree on disk.
 *
 * Run: node test/realtime-schedule.test.mjs   (after `npm run build`)
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (path) => pathToFileURL(join(here, '..', 'lib', path)).href

const schedule = await import(lib('schedule.js'))
const verdict = await import(lib('analysis/verdict.js'))
const { parseConfig } = await import(lib('config.js'))
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

const FIXED_NOW = '2026-10-31T00:10:00.000Z'

/** One confirmed project with one goal. */
async function fixture({ configRaw = {}, withGoal = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'metacog-realtime-'))
  const config = parseConfig({
    realtime: { enabled: true, intervalMinutes: 5, hintThreshold: 0.5, timeoutMs: 2000 },
    ...configRaw,
  })
  const projectId = deriveProjectId(root)
  const store = new MetacogStore(root, config.storageSubdir)
  const goal = {
    id: 'g1',
    projectId,
    parentId: null,
    depth: 0,
    title: '实现实时判定',
    description: '',
    status: 'active',
    priority: 0,
    confirmedByUser: true,
    successCriteria: [],
    alignment: { relevantActivities: ['写代码', '跑测试'] },
    paths: ['src/analysis'],
    evidence: [],
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  }
  await store.initialize(projectId, withGoal ? [goal] : [], [])
  await store.commit(projectId, {
    expectedVersion: 0,
    goals: withGoal ? [goal] : [],
    contradictions: [],
    reason: 'fixture',
    action: 'init_trees',
    actor: 'user_confirmed',
    targetIds: [],
    markConfirmed: true,
  })
  return { root, config, projectId, store, goal }
}

/** One valid activity record. */
function activity(projectId, index, timestamp, summary, paths = ['src/analysis/verdict.ts']) {
  return {
    id: `act_${index}`,
    eventFingerprint: `fp_${index}`,
    projectId,
    sessionId: 'session-fixture',
    timestamp,
    source: 'tool_event',
    observationGrade: 'A',
    summary,
    evidence: paths,
    candidateGoalIds: ['g1'],
    alignmentConfidence: 0.9,
    decision: 'aligned',
    rationale: '',
  }
}

function successResult(overrides = {}) {
  return {
    ok: true,
    status: 'ok',
    verdict: {
      match: 0.3,
      goalId: 'g1',
      reason: '在推进',
      expectNext: '继续改 verdict.ts',
      fulfilled: null,
    },
    meta: { provider: 'p1', model: 'm1', elapsedMs: 7, inputChars: 120, outputChars: 60 },
    expectation: {
      previous: null,
      current: { expectNext: '继续改 verdict.ts', at: FIXED_NOW, match: 0.3, goalId: 'g1' },
      fulfilled: null,
    },
    hints: [],
    ...overrides,
  }
}

function failureResult(reasonKey = 'network', reason = 'offline') {
  return { ok: false, status: 'failed', reasonKey, reason }
}

/** A scheduler wired to a controllable clock, timer and verdict runner. */
async function harness({ configRaw = {}, nextResult = successResult() } = {}) {
  const { root, config, projectId, store } = await fixture({ configRaw })
  let current = new Date(FIXED_NOW)
  let intervalCalls = 0
  let intervalDelay
  let tickCallback
  const timer = {
    interval(callback, delayMs) {
      intervalCalls += 1
      intervalDelay = delayMs
      tickCallback = callback
      return () => {}
    },
  }
  const hints = []
  const reminderMessages = []
  const calls = []
  let result = nextResult
  const reminderPath = join(root, config.storageSubdir, 'realtime-verdict-failures.json')
  const reminder = new verdict.RealtimeFailureReminder({
    statePath: reminderPath,
    remind: (message) => reminderMessages.push(message),
    now: () => current,
  })
  const scheduler = schedule.installRealtimeScheduler({
    ctx: {
      get: (name) => (name === 'timer' ? timer : undefined),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      on: () => () => {},
      effect: () => {},
    },
    config,
    projects: async () => [{ projectId, store, projectRoot: root }],
    llm: {},
    defaultModel: () => ({ provider: 'p1', model: 'm1' }),
    onHints: (items) => hints.push(...items),
    reminderFor: () => reminder,
    runVerdict: async (input, options) => {
      calls.push({ input, options })
      return result
    },
    now: () => current,
    timer,
  })
  return {
    root,
    config,
    projectId,
    store,
    scheduler,
    hints,
    reminderMessages,
    calls,
    reminder,
    timer,
    setNow: (iso) => {
      current = new Date(iso)
    },
    setResult: (next) => {
      result = next
    },
    fireTimer: () => tickCallback?.(),
    intervalCalls: () => intervalCalls,
    intervalDelay: () => intervalDelay,
    tickCallback: () => tickCallback,
  }
}

// ---------------------------------------------------------------- disabled
console.log('\n[disabled] realtime.enabled = false installs no timer')
{
  const h = await harness({ configRaw: { realtime: { enabled: false } } })
  try {
    check('no timer is created', h.intervalCalls() === 0, String(h.intervalCalls()))
    check('the scheduler reports not running', h.scheduler.stats.running === false)
    check('tick is still callable for a manual run', typeof h.scheduler.tick === 'function')
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
}

// ------------------------------------------------------- window + idle
console.log('\n[window] the window starts at the realtime checkpoint')
{
  const h = await harness()
  try {
    // First tick: no checkpoint, no activities in the initial 5-minute window.
    h.setNow('2026-10-31T00:10:00.000Z')
    let results = await h.scheduler.tick()
    check('an empty window is idle', results[0]?.status === 'idle', JSON.stringify(results))
    check('no model call is made', h.calls.length === 0, String(h.calls.length))
    check('no verdict is recorded', (await h.store.readVerdicts(h.projectId)).length === 0)
    check('the checkpoint advances on idle', (await h.store.readRealtimeCheckpoint(h.projectId)) === '2026-10-31T00:10:00.000Z')

    // An activity before the checkpoint is outside the next window.
    await h.store.appendActivity(h.projectId, activity(h.projectId, 1, '2026-10-31T00:03:00.000Z', '旧活动'))
    h.setNow('2026-10-31T00:15:00.000Z')
    results = await h.scheduler.tick()
    check('an activity before the checkpoint is not re-judged', h.calls.length === 0, String(h.calls.length))
    check('and the tick is idle', results[0]?.status === 'idle')

    // An activity after the checkpoint is the next window.
    await h.store.appendActivity(h.projectId, activity(h.projectId, 2, '2026-10-31T00:16:00.000Z', '编辑 verdict.ts'))
    h.setNow('2026-10-31T00:20:00.000Z')
    results = await h.scheduler.tick()
    check('an activity after the checkpoint reaches the model', h.calls.length === 1, String(h.calls.length))
    check('the verdict is written', (await h.store.readVerdicts(h.projectId)).length === 1)
    check('the tick reports a verdict', results[0]?.status === 'verdict', JSON.stringify(results))
    const record = (await h.store.readVerdicts(h.projectId))[0]
    check('the record window starts at the previous checkpoint', record.windowStart === '2026-10-31T00:15:00.000Z', record.windowStart)
    check('and ends at this tick', record.windowEnd === '2026-10-31T00:20:00.000Z', record.windowEnd)

    // The same activity must not be judged twice.
    h.setNow('2026-10-31T00:25:00.000Z')
    results = await h.scheduler.tick()
    check('the next tick does not repeat the same window', h.calls.length === 1, String(h.calls.length))
    check('and is idle', results[0]?.status === 'idle')
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------ record shape
console.log('\n[record] a successful verdict is stored with every cost field')
{
  const h = await harness()
  try {
    await h.store.appendActivity(h.projectId, activity(h.projectId, 1, '2026-10-31T00:16:00.000Z', '编辑 verdict.ts'))
    h.setNow('2026-10-31T00:20:00.000Z')
    await h.scheduler.tick()
    const record = (await h.store.readVerdicts(h.projectId))[0]
    check('match is stored', record.match === 0.3, JSON.stringify(record))
    check('goalId is stored', record.goalId === 'g1')
    check('reason is stored', record.reason === '在推进')
    check('expectNext is stored', record.expectNext === '继续改 verdict.ts')
    check('fulfilled is stored', record.fulfilled === null)
    check('provider is stored', record.provider === 'p1')
    check('model is stored', record.model === 'm1')
    check('elapsedMs is stored', record.elapsedMs === 7)
    check('inputChars is stored', record.inputChars === 120)
    check('outputChars is stored', record.outputChars === 60)
    check('the record id is minted', typeof record.id === 'string' && record.id.startsWith('verdict_'), record.id)
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
}

// --------------------------------------------------------------- low score
console.log('\n[hint] a low match reaches the prompt hint channel')
{
  const h = await harness()
  try {
    await h.store.appendActivity(h.projectId, activity(h.projectId, 1, '2026-10-31T00:16:00.000Z', '改无关文件', ['docs/readme.md']))
    h.setNow('2026-10-31T00:20:00.000Z')
    await h.scheduler.tick()
    check('a low match emits one hint', h.hints.length === 1, JSON.stringify(h.hints))
    check('the hint names the score', /匹配度 0\.30/.test(h.hints[0]), h.hints[0])
    check('the hint names the goal', /实现实时判定/.test(h.hints[0]), h.hints[0])
    check('the verdict is still recorded', (await h.store.readVerdicts(h.projectId)).length === 1)
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
}

console.log('\n[hint] quiet mode suppresses the hint but keeps the record')
{
  const h = await harness({ configRaw: { quiet: { enabled: true } } })
  try {
    await h.store.appendActivity(h.projectId, activity(h.projectId, 1, '2026-10-31T00:16:00.000Z', '改无关文件', ['docs/readme.md']))
    h.setNow('2026-10-31T00:20:00.000Z')
    await h.scheduler.tick()
    check('no hint is emitted while quiet', h.hints.length === 0, JSON.stringify(h.hints))
    check('the verdict is still recorded', (await h.store.readVerdicts(h.projectId)).length === 1)
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
}

// -------------------------------------------------------------- failures
console.log('\n[failure] a failed call does not stop the timer or advance the window')
{
  const h = await harness()
  try {
    await h.store.appendActivity(h.projectId, activity(h.projectId, 1, '2026-10-31T00:16:00.000Z', '编辑 verdict.ts'))
    h.setNow('2026-10-31T00:20:00.000Z')
    h.setResult(failureResult('network', 'offline'))
    let results = await h.scheduler.tick()
    check('the tick reports failed', results[0]?.status === 'failed', JSON.stringify(results))
    check('the first failure reminds once', h.reminderMessages.length === 1, String(h.reminderMessages.length))
    check('the reminder names the reason', /network/.test(h.reminderMessages[0]), h.reminderMessages[0])
    check('no verdict is recorded', (await h.store.readVerdicts(h.projectId)).length === 0)
    check('the checkpoint holds the failed window start', (await h.store.readRealtimeCheckpoint(h.projectId)) === '2026-10-31T00:15:00.000Z')
    check('the scheduler still runs', h.scheduler.stats.running === true)

    // Same reason again: the same window is retried, but no second reminder.
    h.setNow('2026-10-31T00:25:00.000Z')
    results = await h.scheduler.tick()
    check('the failed window is retried', h.calls.length === 2, String(h.calls.length))
    check('the same reason stays quiet', h.reminderMessages.length === 1, String(h.reminderMessages.length))

    // Recovery re-arms; a later failure reminds again.
    h.setNow('2026-10-31T00:30:00.000Z')
    h.setResult(successResult())
    results = await h.scheduler.tick()
    check('a success records the verdict', (await h.store.readVerdicts(h.projectId)).length === 1)
    check('and advances the checkpoint', (await h.store.readRealtimeCheckpoint(h.projectId)) === '2026-10-31T00:30:00.000Z')
    check('recovery clears the suppression', h.reminder.suppressedKeys.length === 0, h.reminder.suppressedKeys.join(','))

    await h.store.appendActivity(h.projectId, activity(h.projectId, 2, '2026-10-31T00:32:00.000Z', '继续改 verdict.ts'))
    h.setNow('2026-10-31T00:35:00.000Z')
    h.setResult(failureResult('model_missing', 'model "nope" not found'))
    await h.scheduler.tick()
    check('a failure after recovery reminds again', h.reminderMessages.length === 2, String(h.reminderMessages.length))
    check('the new reason is suppressed separately', h.reminder.suppressedKeys.join(',') === 'model_missing', h.reminder.suppressedKeys.join(','))
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------------ idle
console.log('\n[idle] a verdict idle result is not a failure and writes nothing')
{
  const h = await harness({ nextResult: { ok: true, status: 'idle', reason: '窗口内无活动，未调用模型' } })
  try {
    await h.store.appendActivity(h.projectId, activity(h.projectId, 1, '2026-10-31T00:16:00.000Z', '编辑 verdict.ts'))
    h.setNow('2026-10-31T00:20:00.000Z')
    const results = await h.scheduler.tick()
    check('the scheduler treats idle as idle', results[0]?.status === 'idle', JSON.stringify(results))
    check('no verdict is written', (await h.store.readVerdicts(h.projectId)).length === 0)
    check('the checkpoint still advances', (await h.store.readRealtimeCheckpoint(h.projectId)) === '2026-10-31T00:20:00.000Z')
    check('no failure reminder fires', h.reminderMessages.length === 0)
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
}

// ----------------------------------------------------------- five fields
console.log('\n[parse] five fields and the first-call null')
{
  const missing = verdict.parseVerdict('{"match":0.5,"goalId":"g1","reason":"x","expectNext":"y"}')
  check('a missing fulfilled is refused', missing.ok === false && /fulfilled/.test(missing.error), JSON.stringify(missing))

  const first = verdict.parseVerdict('{"match":0.9,"goalId":"g1","reason":"对齐","expectNext":"继续","fulfilled":false}', ['g1'], { hasPrevious: false })
  check('a first call forces fulfilled to null', first.ok === true && first.verdict.fulfilled === null, JSON.stringify(first))

  const invalid = verdict.parseVerdict('{"match":0.5,"goalId":"g1","reason":"x","expectNext":"y","fulfilled":"maybe"}')
  check('a non-boolean fulfilled is refused', invalid.ok === false && /fulfilled/.test(invalid.error), JSON.stringify(invalid))
}

// ------------------------------------------------------------ adversarial
console.log('\n[adversarial] aligned but different from the previous prediction')
{
  const root = await mkdtemp(join(tmpdir(), 'metacog-realtime-adv-'))
  const path = verdict.expectationStatePath(root, '.metacog')
  try {
    verdict.writeExpectationState(path, {
      version: 1,
      projects: {
        proj1: { expectNext: '继续改 verdict.ts', at: '2026-10-31T00:00:00.000Z', match: 0.9, goalId: 'g1' },
      },
      updatedAt: '2026-10-31T00:00:00.000Z',
    })
    const llm = {
      stream() {
        return (async function* () {
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              match: 0.9,
              goalId: 'g1',
              reason: '仍然对齐',
              expectNext: '改为跑测试',
              fulfilled: false,
            }),
          }
          yield { type: 'finish', reason: 'stop' }
        })()
      },
    }
    const result = await verdict.runRealtimeVerdict(
      {
        goals: [{ id: 'g1', title: '实现实时判定', relevantActivities: ['写代码'], paths: ['src/analysis'] }],
        activities: [{ at: '2026-10-31T00:05:00.000Z', action: '运行 npm test', paths: ['test/'] }],
      },
      { llm, provider: 'p1', model: 'm1', projectId: 'proj1', expectationPath: path },
    )
    check('the adversarial call succeeds', result.ok === true, JSON.stringify(result))
    check('match stays high', result.ok === true && result.verdict.match === 0.9, JSON.stringify(result.verdict))
    check('fulfilled is false', result.ok === true && result.verdict.fulfilled === false, JSON.stringify(result.verdict))
    check('the previous expectation is compared', result.ok === true && result.expectation.previous?.expectNext === '继续改 verdict.ts')
    check('the two fields remain independent', result.ok === true && result.verdict.match === 0.9 && result.verdict.fulfilled === false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
