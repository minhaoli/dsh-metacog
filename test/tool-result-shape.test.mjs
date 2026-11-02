/**
 * The collector must read the host's real event shapes.
 *
 * This is written against the shapes the harness actually appends, read out of
 * the bundled `dsh-agent-loop`:
 *
 *   tool/call   → { turn, step, callId, name, arguments }
 *   tool/result → { turn, step, message: { role, source: { callId }, toolCallId,
 *                   content, isError } }
 *
 * The earlier version assumed `tool/result` carried `name` at the top level, the
 * way `tool/call` does. It does not. Every result was discarded on a
 * `name.length === 0` check, so `toolResults` stayed empty on every real turn
 * while the parsing code behind it looked perfectly correct.
 *
 * So these cases reproduce the host payload exactly. A test written against a
 * guessed shape would have passed against the broken code too.
 *
 * Run: node test/tool-result-shape.test.mjs   (after `npm run build`)
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (p) => pathToFileURL(join(here, '..', 'lib', p)).href

const { installCollector } = await import(lib('collect.js'))
const { parseConfig } = await import(lib('config.js'))

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

/**
 * Drive the collector's listener with a hand-built event sequence.
 *
 * @param events - `{ type, data }` pairs, in order.
 * @returns the activities the collector delivered.
 */
async function drive(events) {
  const delivered = []
  let listener
  const ctx = {
    on(name, handler) {
      if (name === 'session/event') listener = handler
      return () => {}
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }
  const store = { readonly: true }
  installCollector({
    ctx,
    config: parseConfig({}),
    async storeForSession() {
      return { store, projectId: 'p' }
    },
    async onActivity(activity) {
      delivered.push(activity)
    },
  })

  const session = { id: 's1', header: { cwd: '/tmp/p' } }
  for (const event of events) listener(session, { type: event.type, data: event.data })
  // Let the internal queue drain.
  await new Promise((resolve) => setTimeout(resolve, 30))
  return delivered
}

const call = (turn, callId, name, args = {}) => ({
  type: 'tool/call',
  data: { turn, step: 1, callId, name, arguments: args },
})

/** The host's real result payload: everything inside `message`. */
const result = (turn, callId, text, isError = false) => ({
  type: 'tool/result',
  data: {
    turn,
    step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId },
      toolCallId: callId,
      content: [{ type: 'text', text }],
      isError,
    },
  },
})

const assistantSays = (turn, text) => ({
  type: 'assistant/message',
  data: { turn, message: { content: [{ type: 'text', text }] } },
})
const turnEnd = (turn) => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })

console.log('\n[wiring] a real turn produces one activity with a trace')

{
  const delivered = await drive([
    call(1, 'c1', 'pwsh'),
    result(1, 'c1', '8 passed in 1.2s'),
    call(1, 'c2', 'edit'),
    result(1, 'c2', 'File edited'),
    assistantSays(1, '跑完测试并改了文件'),
    turnEnd(1),
  ])

  const turn = delivered.find((a) => a.source === 'turn')
  check('the turn was delivered', turn !== undefined, `delivered ${delivered.length}`)
  check('it carries both tool names in order', JSON.stringify(turn?.toolNames) === JSON.stringify(['pwsh', 'edit']), JSON.stringify(turn?.toolNames))
  check('it carries both results', turn?.toolResults?.length === 2, JSON.stringify(turn?.toolResults?.length))
}

console.log('\n[the bug] a result is matched to its call by callId, not by name')

{
  const delivered = await drive([
    call(1, 'abc-123', 'pwsh'),
    result(1, 'abc-123', '3 failed'),
    assistantSays(1, '测试有三处失败'),
    turnEnd(1),
  ])
  const turn = delivered.find((a) => a.source === 'turn')
  const r = turn?.toolResults?.[0]
  check('the result survived at all', r !== undefined, 'toolResults empty — the name lookup failed')
  check('it is attributed to the right tool', r?.tool === 'pwsh', r?.tool)
  check('and its outcome was parsed', r?.outcome === 'tests-fail', r?.outcome)
}

console.log('\n[outcome] the parsed outcome rides along')

{
  const delivered = await drive([
    call(1, 'k1', 'pwsh'),
    result(1, 'k1', 'error TS2304: Cannot find name'),
    assistantSays(1, '构建失败'),
    turnEnd(1),
  ])
  const turn = delivered.find((a) => a.source === 'turn')
  check('a build error is classified as a build failure', turn?.toolResults?.[0]?.outcome === 'build-fail')
}

console.log('\n[cross-turn] a result for another turn is not mixed in')

{
  const delivered = await drive([
    call(7, 'x1', 'pwsh'),
    // A result tagged with a different turn must not land in turn 7's bucket.
    result(8, 'x1', '5 passed'),
    assistantSays(7, '这一轮只调了一次工具'),
    turnEnd(7),
  ])
  const turn = delivered.find((a) => a.source === 'turn')
  check('the tool name is still recorded', turn?.toolNames?.length === 1)
  check('the mismatched result is dropped', (turn?.toolResults?.length ?? 0) === 0, JSON.stringify(turn?.toolResults))
}

console.log('\n[unknown call] a result with no matching call is ignored, not guessed')

{
  const delivered = await drive([
    call(1, 'known', 'pwsh'),
    result(1, 'never-seen', '5 passed'),
    assistantSays(1, '继续'),
    turnEnd(1),
  ])
  const turn = delivered.find((a) => a.source === 'turn')
  check('the orphan result produces no entry', (turn?.toolResults?.length ?? 0) === 0, JSON.stringify(turn?.toolResults))
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
