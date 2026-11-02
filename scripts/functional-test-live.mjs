/**
 * Functional test on the REAL project: settle an intervention card through the
 * live route, then confirm the store agrees.
 *
 * The suite already covers this against a fixture. This runs it against
 * `D:\文档\dsh临时工作区`, where the store has 3 historical cards and a real audit
 * chain — the conditions the fixture cannot reproduce.
 *
 * It creates one card, settles it, and checks the result. It does not touch the
 * historical records.
 *
 * Usage: node scripts/functional-test-live.mjs <project-root> [--keep]
 */
import { EventEmitter } from 'node:events'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (p) => pathToFileURL(join(here, '..', 'lib', p)).href

const { installApi } = await import(lib('api.js'))
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

async function call(handler, method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:3080' }
  req.destroy = () => {}
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

const root = process.argv[2]
if (root === undefined) {
  console.error('usage: node scripts/functional-test-live.mjs <project-root>')
  process.exit(2)
}

const config = parseConfig({})
const projectId = deriveProjectId(root)
const store = new MetacogStore(root, config.storageSubdir)
const state = await store.readState(projectId)

console.log(`\n[project] ${root}`)
console.log(`  id: ${projectId}`)
check('the project has a confirmed tree', state !== undefined && state.confirmed === true, JSON.stringify(state && { v: state.version, c: state.confirmed }))

const before = await store.readInterventions(projectId)
const pendingBefore = before.filter((record) => record.status === 'pending')
console.log(`  interventions: ${before.length} total, ${pendingBefore.length} pending`)

let registered
const ctx = {
  webServer: { register: (route) => ((registered = route), () => {}) },
  get: () => undefined,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  on: () => () => {},
  effect: () => {},
}
installApi(ctx, {
  config,
  profileConfig: {},
  listRoots: async () => [root],
  storeFor: () => store,
  readReports: async () => [],
})
const handler = registered.handler

const cardId = `iv_livetest_${Date.now()}`

try {
  console.log('\n[create] a throwaway card, alongside the real ones')

  await store.appendIntervention(projectId, {
    id: cardId,
    projectId,
    signalId: 'sig_livetest',
    level: 2,
    status: 'pending',
    promptSummary: '功能测试卡：这条应当在测试结束时变成 resolved',
    suggestedActions: ['这是测试数据'],
    createdAt: new Date().toISOString(),
  })

  const listed = await call(handler, 'GET', '/api/metacog/projects')
  const described = listed.json().projects.find((entry) => entry.projectId === projectId)
  const openIds = (described?.interventions?.open ?? []).map((entry) => entry.id)
  check('the card appears in the card payload', openIds.includes(cardId), JSON.stringify(openIds).slice(0, 200))
  check('and the historical resolved cards do not', openIds.length === pendingBefore.length + 1, `${openIds.length} vs ${pendingBefore.length + 1}`)

  console.log('\n[settle] through the live route')

  const settled = await call(handler, 'POST', '/api/metacog/intervention', {
    projectId,
    interventionId: cardId,
    decision: 'dismiss',
    rationale: '功能测试：这条判断不可信',
  })
  check('the route accepts the decision', settled.status === 200, `${settled.status} ${settled.body.slice(0, 200)}`)

  const after = await store.readInterventions(projectId)
  const card = after.find((record) => record.id === cardId)
  check('the card is resolved', card?.status === 'resolved', card?.status)
  check('with the decision recorded', card?.decision === 'dismiss', card?.decision)
  check('and the reason recorded', card?.rationale === '功能测试：这条判断不可信', card?.rationale)

  const audits = await store.readAuditLog(projectId)
  const chain = await store.verifyAuditChain(projectId)
  check('the audit chain still verifies after the write', chain.valid === true, JSON.stringify(chain).slice(0, 200))
  check(
    'the decision is in the audit log',
    audits.some((entry) => entry.action === 'resolve_intervention' && entry.reason.includes('功能测试')),
    JSON.stringify(audits.slice(-3).map((entry) => entry.action)),
  )

  console.log('\n[isolation] the historical cards are untouched')

  for (const record of pendingBefore) {
    const now = after.find((item) => item.id === record.id)
    check(`card ${record.id.slice(0, 12)} keeps its status`, now?.status === record.status, `${record.status} -> ${now?.status}`)
  }

  console.log('\n[reload] the payload reflects the settled state')

  const again = await call(handler, 'GET', '/api/metacog/projects')
  const described2 = again.json().projects.find((entry) => entry.projectId === projectId)
  check('the settled card is no longer listed', (described2?.interventions?.open ?? []).every((entry) => entry.id !== cardId))
} finally {
  if (!process.argv.includes('--keep')) {
    console.log(`\n[cleanup] the test card stays in the store as a resolved record (${cardId.slice(0, 20)}…)`)
    console.log('  it is a real audit entry, so it is not removed')
  }
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
