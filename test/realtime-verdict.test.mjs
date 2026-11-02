/**
 * `src/analysis/verdict.ts` + the `/api/metacog/models` route.
 *
 * The verdict channel is a bare LLM call, so most of its risk is in the edges:
 * an over-budget prompt, a model answer that is almost the contract, a timeout
 * that must not become an exception, and a reminder that must fire once per
 * reason rather than once per tick. Each of those has a case below.
 *
 * The route is exercised through the same stub `webServer` the other API tests
 * use: the handler is ordinary code, so no socket is needed.
 *
 * Run: node test/realtime-verdict.test.mjs   (after `npm run build`)
 */
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (path) => pathToFileURL(join(here, '..', 'lib', path)).href

const verdict = await import(lib('analysis/verdict.js'))
const { parseConfig } = await import(lib('config.js'))
const { EDITABLE_PATHS } = await import(lib('settings.js'))
const { installApi } = await import(lib('api.js'))

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

// --------------------------------------------------------------- fixtures
const GOALS = [
  {
    id: 'g1',
    title: '实现实时判定',
    relevantActivities: ['写代码', '跑测试'],
    paths: ['src/analysis'],
    // These three are deliberately present and must never reach the prompt.
    description: 'SECRET_DESCRIPTION',
    successCriteria: ['SECRET_CRITERIA'],
    evidence: ['SECRET_EVIDENCE'],
  },
  {
    id: 'g2',
    title: '整理测试',
    relevantActivities: ['跑测试'],
    paths: ['test'],
  },
  {
    id: 'g3',
    title: '无关目标',
    relevantActivities: ['开会'],
    paths: ['docs'],
  },
]

const ACTIVITIES = [
  { at: '2026-10-31T10:00:00+08:00', action: '编辑 src/analysis/verdict.ts', paths: ['src/analysis/verdict.ts'] },
  { at: '2026-10-31T10:05:00+08:00', action: '运行 npm test', paths: ['test/realtime-verdict.test.mjs'] },
]

const INPUT = { goals: GOALS, activities: ACTIVITIES }

function successLlm(chunks = [
  { type: 'text-delta', text: '{"match":0.82,' },
  { type: 'text-delta', text: '"goalId":"g1","reason":"在推进目标","expectNext":"继续改 verdict.ts","fulfilled":null}' },
  { type: 'usage', usage: { inputTokens: 120, outputTokens: 16, totalTokens: 136 } },
  { type: 'finish', reason: 'stop' },
]) {
  return {
    calls: 0,
    stream() {
      this.calls += 1
      return (async function* () {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

/** One complete verdict answer, so persistence cases can vary expectNext. */
function verdictChunks(expectNext, match = 0.82, goalId = 'g1', reason = '在推进目标', fulfilled = null) {
  return [
    { type: 'text-delta', text: JSON.stringify({ match, goalId, reason, expectNext, fulfilled }) },
    { type: 'usage', usage: { inputTokens: 120, outputTokens: 16, totalTokens: 136 } },
    { type: 'finish', reason: 'stop' },
  ]
}

function failingLlm(message) {
  return {
    calls: 0,
    stream() {
      this.calls += 1
      throw new Error(message)
    },
  }
}

/** A stream that never yields and rejects when its signal aborts. */
function hangingLlm() {
  return {
    calls: 0,
    stream(request) {
      this.calls += 1
      return (async function* () {
        await new Promise((_resolve, reject) => {
          if (request.signal?.aborted === true) {
            reject(new Error('aborted'))
            return
          }
          request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
        yield { type: 'text-delta', text: '{}' }
      })()
    },
  }
}

/** A response that records what the handler wrote. */
function makeRes() {
  return {
    status: 0,
    body: '',
    headers: {},
    writeHead(status, headers) {
      this.status = status
      this.headers = headers || {}
    },
    end(text) {
      this.body = text ?? ''
    },
    json() {
      return JSON.parse(this.body)
    },
  }
}

function makeReq(method, url, body, headers = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:3080', ...headers }
  req.destroy = () => {}
  return req
}

async function call(handler, method, url, body, headers) {
  const req = makeReq(method, url, body, headers)
  const res = makeRes()
  const pending = handler(req, res)
  if (body !== undefined) {
    await new Promise((resolve) => setImmediate(resolve))
    req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    req.emit('end')
  }
  await pending
  return res
}

// ------------------------------------------------------------------ config
console.log('\n[config] realtime section has defaults and is editable from the card')
{
  const config = parseConfig({})
  check('realtime exists', config.realtime !== undefined)
  check('enabled defaults to false', config.realtime.enabled === false, String(config.realtime.enabled))
  check('provider defaults to empty (follow global)', config.realtime.provider === '', JSON.stringify(config.realtime.provider))
  check('model defaults to empty (follow global)', config.realtime.model === '', JSON.stringify(config.realtime.model))
  check('intervalMinutes defaults to 5', config.realtime.intervalMinutes === 5, String(config.realtime.intervalMinutes))
  check('maxInputTokens defaults to 1000', config.realtime.maxInputTokens === 1000, String(config.realtime.maxInputTokens))
  check('timeoutMs defaults to 20000', config.realtime.timeoutMs === 20000, String(config.realtime.timeoutMs))
  check('hintThreshold defaults to 0.5', config.realtime.hintThreshold === 0.5, String(config.realtime.hintThreshold))

  const overridden = parseConfig({ realtime: { enabled: true, intervalMinutes: 7, maxInputTokens: 300 } })
  check('a partial override keeps the other defaults', overridden.realtime.enabled === true && overridden.realtime.timeoutMs === 20000, JSON.stringify(overridden.realtime))
  check('and applies the changed values', overridden.realtime.intervalMinutes === 7 && overridden.realtime.maxInputTokens === 300)

  let rejected = false
  try {
    parseConfig({ realtime: { intervalMinutes: 0 } })
  } catch {
    rejected = true
  }
  check('a zero interval is refused', rejected)

  for (const path of [
    'realtime.enabled',
    'realtime.provider',
    'realtime.model',
    'realtime.intervalMinutes',
    'realtime.maxInputTokens',
    'realtime.timeoutMs',
    'realtime.hintThreshold',
  ]) {
    check(`EDITABLE_PATHS includes ${path}`, EDITABLE_PATHS.includes(path))
  }
}

// ------------------------------------------------------------------- input
console.log('\n[input] only relevant goals, one line per activity, inside the budget')
{
  const selected = verdict.selectRelevantGoals(GOALS, ACTIVITIES)
  check('path ownership picks the goal the work is in', selected[0]?.id === 'g1', JSON.stringify(selected.map((goal) => goal.id)))
  check('at most two goals are sent', selected.length <= 2, String(selected.length))
  check('the unrelated goal is not selected', selected.every((goal) => goal.id !== 'g3'))

  const prompt = verdict.buildVerdictPrompt(INPUT)
  check('the prompt is within the default budget', prompt.estimatedTokens <= 1000, String(prompt.estimatedTokens))
  check('it carries the selected goal id', prompt.text.includes('id: g1'))
  check('it carries the goal title', prompt.text.includes('实现实时判定'))
  check('it carries relevantActivities', prompt.text.includes('写代码'))
  check('it carries paths', prompt.text.includes('src/analysis'))
  check('it asks for the rolling expectation', prompt.text.includes('expectNext'))
  check('a first prompt says there is no previous expectation', prompt.text.includes('首次判定'))
  const withPreviousPrompt = verdict.buildVerdictPrompt(INPUT, { previousExpectNext: '继续改路由' })
  check('a prompt with a previous expectation includes it', withPreviousPrompt.text.includes('上次预期：继续改路由'))
  check('it never carries description', !prompt.text.includes('SECRET_DESCRIPTION'))
  check('it never carries successCriteria', !prompt.text.includes('SECRET_CRITERIA'))
  check('it never carries evidence', !prompt.text.includes('SECRET_EVIDENCE'))
  check('each activity is one line with a clock', prompt.text.includes('- 10:00 编辑 src/analysis/verdict.ts'))
  check('and the second activity is a separate line', prompt.text.includes('- 10:05 运行 npm test'))

  const empty = verdict.buildVerdictPrompt({ goals: GOALS, activities: [] })
  check('an empty window says so instead of rendering nothing', empty.text.includes('（窗口内无活动）'))

  const many = Array.from({ length: 60 }, (_value, index) => ({
    at: `2026-10-31T${String(9 + Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}:00+08:00`,
    action: `第 ${index} 条活动，编辑一个路径很长的文件 src/analysis/very-long-file-name-${index}.ts`,
    paths: [`src/analysis/very-long-file-name-${index}.ts`],
  }))
  const trimmed = verdict.buildVerdictPrompt({ goals: GOALS, activities: many }, { maxInputTokens: 300 })
  check('a long window is trimmed to the budget', trimmed.estimatedTokens <= 300, String(trimmed.estimatedTokens))
  check('and keeps fewer than all activity lines', trimmed.activities < many.length, String(trimmed.activities))
  check('the newest activity survives trimming', trimmed.text.includes('第 59 条活动'))

  check('estimateTokens counts ASCII at four chars per token', verdict.estimateTokens('abcd') === 1, String(verdict.estimateTokens('abcd')))
  check('and CJK at one token per character', verdict.estimateTokens('中文') === 2, String(verdict.estimateTokens('中文')))
}

// ------------------------------------------------------------------ parser
console.log('\n[parse] the strict five-field contract')
{
  const valid = verdict.parseVerdict('{"match":0.7,"goalId":"g1","reason":"在推进目标","expectNext":"继续改路由","fulfilled":null}', ['g1', 'g2'])
  check('a valid answer passes', valid.ok === true && valid.verdict.match === 0.7, JSON.stringify(valid))
  check('and keeps the goal id', valid.ok && valid.verdict.goalId === 'g1')
  check('and the reason', valid.ok && valid.verdict.reason === '在推进目标')
  check('and the rolling expectation', valid.ok && valid.verdict.expectNext === '继续改路由')
  check('and the fulfillment answer', valid.ok && valid.verdict.fulfilled === null)

  const nullGoal = verdict.parseVerdict('{"match":0.2,"goalId":null,"reason":"无法判断","expectNext":"先补数据","fulfilled":null}', ['g1'])
  check('goalId null is accepted', nullGoal.ok === true && nullGoal.verdict.goalId === null)

  const fenced = verdict.parseVerdict('```json\n{"match":0.4,"goalId":"g2","reason":"测试","expectNext":"继续测试","fulfilled":true}\n```', ['g1', 'g2'])
  check('a fenced JSON answer is accepted', fenced.ok === true, JSON.stringify(fenced))
  check('and carries fulfilled true', fenced.ok && fenced.verdict.fulfilled === true)

  const missing = verdict.parseVerdict('{"match":0.5,"goalId":"g1"}', ['g1'])
  check('a missing field is refused', missing.ok === false && /reason/.test(missing.error), JSON.stringify(missing))

  const missingExpectation = verdict.parseVerdict('{"match":0.5,"goalId":"g1","reason":"x","fulfilled":null}', ['g1'])
  check('a missing expectNext is refused', missingExpectation.ok === false && /expectNext/.test(missingExpectation.error), JSON.stringify(missingExpectation))

  const missingFulfilled = verdict.parseVerdict('{"match":0.5,"goalId":"g1","reason":"x","expectNext":"y"}', ['g1'])
  check('a missing fulfilled is refused', missingFulfilled.ok === false && /fulfilled/.test(missingFulfilled.error), JSON.stringify(missingFulfilled))

  const outOfRange = verdict.parseVerdict('{"match":1.2,"goalId":null,"reason":"x","expectNext":"y","fulfilled":null}')
  check('an out-of-range match is refused', outOfRange.ok === false && /match/.test(outOfRange.error), JSON.stringify(outOfRange))

  const negative = verdict.parseVerdict('{"match":-0.1,"goalId":null,"reason":"x","expectNext":"y","fulfilled":null}')
  check('a negative match is refused', negative.ok === false, JSON.stringify(negative))

  const notJson = verdict.parseVerdict('我觉得挺匹配的')
  check('non-JSON is refused', notJson.ok === false && /JSON/.test(notJson.error), JSON.stringify(notJson))

  const extra = verdict.parseVerdict('{"match":0.5,"goalId":"g1","reason":"x","expectNext":"y","fulfilled":null,"confidence":0.9}', ['g1'])
  check('an extra field is refused', extra.ok === false && /unexpected field/.test(extra.error), JSON.stringify(extra))

  const unknownGoal = verdict.parseVerdict('{"match":0.5,"goalId":"g9","reason":"x","expectNext":"y","fulfilled":null}', ['g1'])
  check('a goal id that was not offered is refused', unknownGoal.ok === false && /not one of the provided goals/.test(unknownGoal.error), JSON.stringify(unknownGoal))

  const longReason = verdict.parseVerdict(`{"match":0.5,"goalId":null,"reason":"${'字'.repeat(21)}","expectNext":"y","fulfilled":null}`)
  check('a reason over 20 characters is refused', longReason.ok === false && /20 characters/.test(longReason.error), JSON.stringify(longReason))

  const exactReason = verdict.parseVerdict(`{"match":0.5,"goalId":null,"reason":"${'字'.repeat(20)}","expectNext":"y","fulfilled":null}`)
  check('exactly 20 characters is accepted', exactReason.ok === true, JSON.stringify(exactReason))

  const longExpectation = verdict.parseVerdict(`{"match":0.5,"goalId":null,"reason":"x","expectNext":"${'字'.repeat(21)}","fulfilled":null}`)
  check('an expectNext over 20 characters is refused', longExpectation.ok === false && /expectNext/.test(longExpectation.error), JSON.stringify(longExpectation))

  const emptyReason = verdict.parseVerdict('{"match":0.5,"goalId":null,"reason":"   ","expectNext":"y","fulfilled":null}')
  check('a blank reason is refused', emptyReason.ok === false, JSON.stringify(emptyReason))

  const blankExpectation = verdict.parseVerdict('{"match":0.5,"goalId":null,"reason":"x","expectNext":"   ","fulfilled":null}')
  check('a blank expectNext is refused', blankExpectation.ok === false && /expectNext/.test(blankExpectation.error), JSON.stringify(blankExpectation))

  const invalidFulfilled = verdict.parseVerdict('{"match":0.5,"goalId":null,"reason":"x","expectNext":"y","fulfilled":"yes"}')
  check('a non-boolean fulfilled is refused', invalidFulfilled.ok === false && /fulfilled/.test(invalidFulfilled.error), JSON.stringify(invalidFulfilled))

  const firstCall = verdict.parseVerdict('{"match":0.9,"goalId":"g1","reason":"对齐","expectNext":"继续","fulfilled":false}', ['g1'], { hasPrevious: false })
  check('a first call forces fulfilled to null', firstCall.ok === true && firstCall.verdict.fulfilled === null, JSON.stringify(firstCall))

  const withPrevious = verdict.parseVerdict('{"match":0.9,"goalId":"g1","reason":"对齐","expectNext":"继续","fulfilled":false}', ['g1'], { hasPrevious: true })
  check('with a previous expectation the answer is kept', withPrevious.ok === true && withPrevious.verdict.fulfilled === false, JSON.stringify(withPrevious))
}

// ----------------------------------------------------------------- success
console.log('\n[run] a successful call returns the verdict and its cost facts')
{
  const llm = successLlm()
  const result = await verdict.runRealtimeVerdict(INPUT, { llm, provider: 'p1', model: 'm1', now: () => 1000 })
  check('the call succeeds', result.ok === true && result.status === 'ok', JSON.stringify(result))
  check('the parsed match is kept', result.ok && result.verdict.match === 0.82, JSON.stringify(result))
  check('the parsed goal is kept', result.ok && result.verdict.goalId === 'g1')
  check('the parsed reason is kept', result.ok && result.verdict.reason === '在推进目标')
  check('the parsed expectation is kept', result.ok && result.verdict.expectNext === '继续改 verdict.ts')
  check('the parsed fulfillment is null on a first call', result.ok && result.verdict.fulfilled === null)
  check('the first call has no previous expectation', result.ok && result.expectation.previous === null)
  check('the current expectation is recorded', result.ok && result.expectation.current.expectNext === '继续改 verdict.ts')
  check('the comparison carries the first-call null', result.ok && result.expectation.fulfilled === null)
  check('the provider is recorded', result.meta.provider === 'p1', JSON.stringify(result.meta))
  check('the model is recorded', result.meta.model === 'm1')
  check('inputChars is positive', result.meta.inputChars > 0, String(result.meta.inputChars))
  check('outputChars is positive', result.meta.outputChars > 0, String(result.meta.outputChars))
  check('elapsedMs is not negative', result.meta.elapsedMs >= 0, String(result.meta.elapsedMs))
  check('usage is carried through', result.meta.usage?.inputTokens === 120, JSON.stringify(result.meta.usage))
  check('the stream was called once', llm.calls === 1, String(llm.calls))
}

// -------------------------------------------------------------------- idle
console.log('\n[idle] an empty window makes no call at all')
{
  const llm = successLlm()
  const result = await verdict.runRealtimeVerdict({ goals: GOALS, activities: [] }, { llm, provider: 'p1', model: 'm1' })
  check('an empty window is idle, not a failure', result.ok === true && result.status === 'idle', JSON.stringify(result))
  check('the idle reason says why', /无活动/.test(result.reason), result.reason)
  check('no model call is made', llm.calls === 0, String(llm.calls))

  const idleFirst = await verdict.runRealtimeVerdict({ goals: GOALS, activities: [] }, { llm, provider: '', model: '' })
  check('idle wins over a missing model route', idleFirst.status === 'idle', JSON.stringify(idleFirst))
}

// --------------------------------------------------------------- failures
console.log('\n[run] failures are values, and reminders suppress by reason')
{
  const dir = await mkdtemp(join(tmpdir(), 'metacog-verdict-'))
  const statePath = verdict.failureStatePath(dir, '.metacog')
  const reminders = []
  const reminder = new verdict.RealtimeFailureReminder({
    statePath,
    remind: (message) => reminders.push(message),
    now: () => new Date('2026-10-31T00:00:00.000Z'),
  })

  const modelFailure = failingLlm('model "nope" not found')
  const first = await verdict.runRealtimeVerdict(INPUT, { llm: modelFailure, provider: 'p1', model: 'nope', reminder })
  check('a model failure returns failed, not a throw', first.ok === false && first.status === 'failed', JSON.stringify(first))
  check('and is classified as model_missing', first.reasonKey === 'model_missing', String(first.reasonKey))
  check('the first failure reminds once', reminders.length === 1, String(reminders.length))
  check('the reminder names the reason key', reminders[0].includes('model_missing'), reminders[0])
  check('the suppression is recorded', reminder.suppressedKeys.join(',') === 'model_missing', reminder.suppressedKeys.join(','))

  const second = await verdict.runRealtimeVerdict(INPUT, { llm: modelFailure, provider: 'p1', model: 'nope', reminder })
  check('the same failure still returns failed', second.ok === false && second.reasonKey === 'model_missing')
  check('but does not remind again', reminders.length === 1, String(reminders.length))

  const networkFailure = failingLlm('fetch failed ECONNREFUSED')
  const third = await verdict.runRealtimeVerdict(INPUT, { llm: networkFailure, provider: 'p1', model: 'm1', reminder })
  check('a different reason is classified as network', third.ok === false && third.reasonKey === 'network', String(third.reasonKey))
  check('and is not masked by the earlier suppression', reminders.length === 2, String(reminders.length))
  check('both reasons are suppressed', reminder.suppressedKeys.join(',') === 'model_missing,network', reminder.suppressedKeys.join(','))

  const recovered = await verdict.runRealtimeVerdict(INPUT, { llm: successLlm(), provider: 'p1', model: 'm1', reminder })
  check('a success returns ok', recovered.ok === true)
  check('and clears every suppression', reminder.suppressedKeys.length === 0, reminder.suppressedKeys.join(','))

  const again = await verdict.runRealtimeVerdict(INPUT, { llm: failingLlm('model "nope" not found'), provider: 'p1', model: 'nope', reminder })
  check('a failure after recovery re-arms the reminder', again.ok === false && reminders.length === 3, String(reminders.length))

  const persisted = JSON.parse(await readFile(statePath, 'utf8'))
  check('the state file records the suppressed reason', persisted.suppressed.model_missing !== undefined, JSON.stringify(persisted))

  // A fresh instance is the restart case: the file, not the object, decides.
  const restartReminders = []
  const restarted = new verdict.RealtimeFailureReminder({
    statePath,
    remind: () => restartReminders.push('x'),
    now: () => new Date('2026-10-31T01:00:00.000Z'),
  })
  check('a restarted reminder sees the persisted suppression', restarted.suppressedKeys.join(',') === 'model_missing', restarted.suppressedKeys.join(','))
  check('and stays quiet for the same reason', restarted.recordFailure('model_missing', 'still broken') === false)
  check('while a new reason still reminds', restarted.recordFailure('network', 'offline') === true)
  check('exactly one new reminder was emitted', restartReminders.length === 1, String(restartReminders.length))

  await rm(dir, { recursive: true, force: true })
}

// ----------------------------------------------------------- expectations
console.log('\n[expectation] the rolling expectation is persisted per project')
{
  const dir = await mkdtemp(join(tmpdir(), 'metacog-expectation-'))
  const path = verdict.expectationStatePath(dir, '.metacog')
  try {
    const first = await verdict.runRealtimeVerdict(INPUT, {
      llm: successLlm(verdictChunks('继续改 verdict.ts')),
      provider: 'p1',
      model: 'm1',
      projectId: 'proj1',
      expectationPath: path,
      nowIso: () => '2026-10-31T00:00:00.000Z',
    })
    check('the first call succeeds without a previous expectation', first.ok === true && first.expectation.previous === null, JSON.stringify(first.expectation))
    const state = JSON.parse(await readFile(path, 'utf8'))
    check('the state file stores the project expectation', state.projects.proj1.expectNext === '继续改 verdict.ts', JSON.stringify(state))
    check('with the verdict that produced it', state.projects.proj1.match === 0.82 && state.projects.proj1.goalId === 'g1')

    const second = await verdict.runRealtimeVerdict(INPUT, {
      llm: successLlm(verdictChunks('开始跑测试', 0.82, 'g1', '在推进目标', true)),
      provider: 'p1',
      model: 'm1',
      projectId: 'proj1',
      expectationPath: path,
      nowIso: () => '2026-10-31T00:05:00.000Z',
    })
    check('the next call sees the previous expectation', second.ok === true && second.expectation.previous?.expectNext === '继续改 verdict.ts', JSON.stringify(second.expectation))
    check('and records the new one', second.ok === true && second.expectation.current.expectNext === '开始跑测试')
    check('and carries the model comparison', second.ok === true && second.expectation.fulfilled === true)

    const failing = await verdict.runRealtimeVerdict(INPUT, {
      llm: failingLlm('model "nope" not found'),
      provider: 'p1',
      model: 'nope',
      projectId: 'proj1',
      expectationPath: path,
    })
    check('a failed call does not erase the stored expectation', failing.ok === false)
    const afterFailure = JSON.parse(await readFile(path, 'utf8'))
    check('the stored expectation is still the last successful one', afterFailure.projects.proj1.expectNext === '开始跑测试', JSON.stringify(afterFailure.projects.proj1))

    const noProject = await verdict.runRealtimeVerdict(INPUT, {
      llm: successLlm(verdictChunks('无项目')),
      provider: 'p1',
      model: 'm1',
    })
    check('without a project there is no previous expectation', noProject.ok === true && noProject.expectation.previous === null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------- adversarial
console.log('\n[adversarial] aligned but different from the previous prediction')
{
  const dir = await mkdtemp(join(tmpdir(), 'metacog-adversarial-'))
  const path = verdict.expectationStatePath(dir, '.metacog')
  try {
    // First call: seed a prediction with no baseline of its own.
    const seed = await verdict.runRealtimeVerdict(INPUT, {
      llm: successLlm(verdictChunks('继续改 verdict.ts', 0.9, 'g1', '对齐', null)),
      provider: 'p1',
      model: 'm1',
      projectId: 'proj1',
      expectationPath: path,
      nowIso: () => '2026-10-31T00:00:00.000Z',
    })
    check('the seed call records the first expectation', seed.ok === true && seed.expectation.previous === null)

    // Second call: still fully aligned, but the work moved in a direction the
    // previous prediction did not name. High match, fulfilled false — the two
    // fields must not be collapsed into one judgement.
    const result = await verdict.runRealtimeVerdict(INPUT, {
      llm: successLlm(verdictChunks('改为跑测试', 0.9, 'g1', '仍然对齐', false)),
      provider: 'p1',
      model: 'm1',
      projectId: 'proj1',
      expectationPath: path,
      nowIso: () => '2026-10-31T00:05:00.000Z',
    })
    check('the adversarial call succeeds', result.ok === true, JSON.stringify(result))
    check('match stays high', result.ok === true && result.verdict.match === 0.9, JSON.stringify(result.verdict))
    check('fulfilled is false', result.ok === true && result.verdict.fulfilled === false, JSON.stringify(result.verdict))
    check('the previous expectation is the one compared', result.ok === true && result.expectation.previous?.expectNext === '继续改 verdict.ts')
    check('the two fields remain independent', result.ok === true && result.verdict.match === 0.9 && result.verdict.fulfilled === false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

console.log('\n[run] missing service, missing model, timeout and abort')
{
  const unavailable = await verdict.runRealtimeVerdict(INPUT, { llm: undefined, provider: 'p1', model: 'm1' })
  check('a missing llm service is unavailable, not a throw', unavailable.ok === false && unavailable.status === 'unavailable', JSON.stringify(unavailable))
  check('with a stable reason key', unavailable.reasonKey === 'unavailable', String(unavailable.reasonKey))

  const calls = { value: 0 }
  const unused = {
    stream() {
      calls.value += 1
      return (async function* () {
        yield { type: 'text-delta', text: '{}' }
      })()
    },
  }
  const noModel = await verdict.runRealtimeVerdict(INPUT, { llm: unused, provider: '', model: '' })
  check('an empty provider/model is failed, not guessed', noModel.ok === false && noModel.reasonKey === 'no_model', JSON.stringify(noModel))
  check('and no stream call is attempted', calls.value === 0, String(calls.value))

  const timedOut = await verdict.runRealtimeVerdict(INPUT, {
    llm: hangingLlm(),
    provider: 'p1',
    model: 'm1',
    timeoutMs: 25,
  })
  check('a hanging call times out', timedOut.ok === false && timedOut.reasonKey === 'timeout', JSON.stringify(timedOut))
  check('and the failure carries cost facts', timedOut.meta !== undefined && timedOut.meta.elapsedMs >= 0, JSON.stringify(timedOut.meta))

  const controller = new AbortController()
  const pending = verdict.runRealtimeVerdict(INPUT, {
    llm: hangingLlm(),
    provider: 'p1',
    model: 'm1',
    timeoutMs: 5000,
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 10)
  const aborted = await pending
  check('a caller abort is classified separately', aborted.ok === false && aborted.reasonKey === 'aborted', JSON.stringify(aborted))

  const invalid = await verdict.runRealtimeVerdict(INPUT, {
    llm: successLlm([{ type: 'text-delta', text: '这不太像 JSON' }]),
    provider: 'p1',
    model: 'm1',
  })
  check('unparseable output is failed, not ok', invalid.ok === false && invalid.reasonKey === 'invalid_output', JSON.stringify(invalid))
  check('and the error is readable', /JSON/.test(invalid.reason), invalid.reason)

  const emptyOutput = await verdict.runRealtimeVerdict(INPUT, {
    llm: successLlm([{ type: 'finish', reason: 'stop' }]),
    provider: 'p1',
    model: 'm1',
  })
  check('an empty answer is failed', emptyOutput.ok === false && emptyOutput.reasonKey === 'invalid_output', JSON.stringify(emptyOutput))
}

// -------------------------------------------------------------- models API
console.log('\n[api] GET /api/metacog/models passes the provider catalog through')
{
  const root = await mkdtemp(join(tmpdir(), 'metacog-models-'))
  const config = parseConfig({})
  let registered
  const fakeLlm = {
    listProviders() {
      return [
        { id: 'p1', name: 'Provider One' },
        { id: 'p2', name: 'Provider Two' },
      ]
    },
    async listModels(provider) {
      if (provider === 'p1') return [{ provider: 'p1', id: 'm1', name: 'Model One' }]
      throw new Error('adapter offline')
    },
  }
  const ctx = {
    webServer: {
      register(route) {
        registered = route
        return () => {}
      },
      getOrigin() {
        return 'http://127.0.0.1:3080'
      },
    },
    get(name) {
      return name === 'llm' ? fakeLlm : undefined
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on: () => () => {},
    effect: () => {},
  }
  installApi(ctx, {
    config,
    listRoots: async () => [root],
    storeFor: () => {
      throw new Error('the models route must not read a store')
    },
  })

  try {
    const res = await call(registered.handler, 'GET', '/api/metacog/models')
    check('the route answers 200', res.status === 200, String(res.status))
    check('with ok true', res.json().ok === true, res.body.slice(0, 120))
    check('and two providers', res.json().providers.length === 2, JSON.stringify(res.json()))
    check('the provider id is passed through', res.json().providers[0].provider === 'p1', JSON.stringify(res.json().providers[0]))
    check('the provider display name is passed through', res.json().providers[0].displayName === 'Provider One')
    check('the model id is passed through', res.json().providers[0].models[0].id === 'm1', JSON.stringify(res.json().providers[0].models))
    check('the model display name is passed through', res.json().providers[0].models[0].displayName === 'Model One')
    check('a provider whose adapter throws is kept with no models', res.json().providers[1].provider === 'p2' && res.json().providers[1].models.length === 0, JSON.stringify(res.json().providers[1]))

    const unknown = await call(registered.handler, 'GET', '/api/metacog/not-a-route')
    check('an unknown endpoint is still 404', unknown.status === 404, String(unknown.status))

    // Missing service: the card gets an empty list and a reason, not a 500.
    let missingRegistered
    const missingCtx = {
      webServer: {
        register(route) {
          missingRegistered = route
          return () => {}
        },
        getOrigin() {
          return 'http://127.0.0.1:3080'
        },
      },
      get: () => undefined,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      on: () => () => {},
      effect: () => {},
    }
    installApi(missingCtx, {
      config,
      listRoots: async () => [],
      storeFor: () => {
        throw new Error('not used')
      },
    })
    const missing = await call(missingRegistered.handler, 'GET', '/api/metacog/models')
    check('a host without llm still answers 200', missing.status === 200, String(missing.status))
    check('with an empty provider list', missing.json().providers.length === 0, JSON.stringify(missing.json()))
    check('and a note that names the missing service', /llm/.test(missing.json().note), missing.json().note)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// --------------------------------------------------------------- corrupt
console.log('\n[state] a corrupt state file degrades to empty instead of throwing')
{
  const dir = await mkdtemp(join(tmpdir(), 'metacog-verdict-bad-'))
  const path = verdict.failureStatePath(dir, '.metacog')
  await mkdir(join(dir, '.metacog'), { recursive: true })
  await writeFile(path, '{not json', 'utf8')
  const state = verdict.readFailureState(path)
  check('a corrupt file reads as empty', Object.keys(state.suppressed).length === 0, JSON.stringify(state))
  const reminders = []
  const reminder = new verdict.RealtimeFailureReminder({ statePath: path, remind: (message) => reminders.push(message) })
  check('and a reminder still fires', reminder.recordFailure('model_missing', 'x') === true)
  check('with the state rewritten as valid JSON', JSON.parse(await readFile(path, 'utf8')).suppressed.model_missing !== undefined)
  await rm(dir, { recursive: true, force: true })
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
