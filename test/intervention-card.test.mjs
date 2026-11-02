/**
 * Functional test: settle an intervention card through the HTTP route.
 *
 * The card could always *list* a pending decision but never take one, so every
 * feedback channel stayed empty. This drives the real route against a real store:
 *
 *   append a pending intervention -> POST /api/metacog/intervention -> read back
 *
 * It asserts the parts that make the feature trustworthy rather than merely
 * present: the decision is persisted, an audit entry records it, the sibling card
 * of the same signal is superseded, and a second attempt on the settled card is
 * refused instead of silently accepted.
 *
 * Run: node test/intervention-card.test.mjs   (after `npm run build`)
 */
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

const root = await mkdtemp(join(tmpdir(), 'metacog-verify-intervention-'))
const config = parseConfig({})
const projectId = deriveProjectId(root)
const store = new MetacogStore(root, config.storageSubdir)
await store.initialize(projectId, [], [])
await store.commit(projectId, {
  expectedVersion: 0,
  goals: [],
  contradictions: [],
  reason: 'fixture',
  action: 'init_trees',
  actor: 'user_confirmed',
  targetIds: [],
  markConfirmed: true,
})

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

/** Append one pending intervention at the given level. */
async function addCard(id, level, signalId) {
  await store.appendIntervention(projectId, {
    id,
    projectId,
    signalId,
    level,
    status: 'pending',
    promptSummary: `L${level} 需要你决定：${id}`,
    suggestedActions: ['把工作拉回目标', '或者承认目标要改'],
    createdAt: new Date().toISOString(),
  })
}

/**
 * Append the drift signal a card points at.
 *
 * Superseding matches cards by *signal class* — `signalType` plus the contradiction
 * set — which is read from the signal, not from the card. Without the signal record
 * there is nothing to compare and no sibling is ever superseded, so a fixture that
 * only writes cards cannot exercise that rule.
 */
async function addSignal(id, signalType, contradictionIds = []) {
  await store.appendSignal(projectId, {
    id,
    projectId,
    monitorCategory: 'goal_alignment',
    signalType,
    observedAt: new Date().toISOString(),
    relatedGoalIds: [],
    relatedContradictionIds: contradictionIds,
    level: 2,
    evidence: [],
    rationale: 'fixture',
    confidence: 0.7,
  })
}

try {
  console.log('\n[guard] the route refuses incomplete requests')

  await addCard('iv_1', 2, 'sig_a')

  const noId = await call(handler, 'POST', '/api/metacog/intervention', {
    projectId,
    decision: 'continue',
    rationale: 'x',
  })
  check('a missing interventionId is 400', noId.status === 400, String(noId.status))

  const badDecision = await call(handler, 'POST', '/api/metacog/intervention', {
    projectId,
    interventionId: 'iv_1',
    decision: 'whatever',
    rationale: 'x',
  })
  check('an unknown decision is 400', badDecision.status === 400, String(badDecision.status))
  check('and the message names the allowed set', /continue/.test(badDecision.json().error), badDecision.json().error)

  const noReason = await call(handler, 'POST', '/api/metacog/intervention', {
    projectId,
    interventionId: 'iv_1',
    decision: 'continue',
  })
  check('a missing rationale is 400', noReason.status === 400, String(noReason.status))
  check('and says the reason is required', /rationale/.test(noReason.json().error), noReason.json().error)

  console.log('\n[settle] a valid request closes the card and records it')

  const ok = await call(handler, 'POST', '/api/metacog/intervention', {
    projectId,
    interventionId: 'iv_1',
    decision: 'realign',
    rationale: '确实偏了，拉回原目标',
  })
  check('the decision is accepted', ok.status === 200, `${ok.status} ${ok.body.slice(0, 160)}`)
  check('and the response names the decision', ok.json().decided?.decision === 'realign', JSON.stringify(ok.json()).slice(0, 200))

  const after = await store.readInterventions(projectId)
  const card = after.find((record) => record.id === 'iv_1')
  check('the card is no longer pending', card?.status === 'resolved', card?.status)
  check('the decision is persisted', card?.decision === 'realign', card?.decision)
  check('the reason is persisted', card?.rationale === '确实偏了，拉回原目标', card?.rationale)

  const audits = await store.readAuditLog(projectId)
  check(
    'an audit entry records the decision',
    audits.some((entry) => entry.action === 'resolve_intervention'),
    JSON.stringify(audits.map((entry) => entry.action)),
  )

  console.log('\n[race] settling the same card twice is refused, not silently accepted')

  const twice = await call(handler, 'POST', '/api/metacog/intervention', {
    projectId,
    interventionId: 'iv_1',
    decision: 'dismiss',
    rationale: 'again',
  })
  check('a settled card cannot be settled again', twice.status === 400, String(twice.status))
  check('and the store still holds the first decision', (await store.readInterventions(projectId)).find((r) => r.id === 'iv_1')?.decision === 'realign')

  console.log('\n[sibling] the same signal\'s sibling card is superseded')

  // Both cards point at signals of the same class, which is what the supersede
  // rule compares. The signal records are required for that comparison.
  await addSignal('sig_b1', 'scope_drift', ['c1'])
  await addSignal('sig_b2', 'scope_drift', ['c1'])
  await addCard('iv_2', 2, 'sig_b1')
  await addCard('iv_3', 2, 'sig_b2')
  const settleTwo = await call(handler, 'POST', '/api/metacog/intervention', {
    projectId,
    interventionId: 'iv_2',
    decision: 'continue',
    rationale: '不是偏离',
  })
  check('the sibling settle succeeds', settleTwo.status === 200, String(settleTwo.status))
  const siblings = await store.readInterventions(projectId)
  check(
    'the sibling card is superseded, not left pending',
    siblings.find((record) => record.id === 'iv_3')?.status === 'superseded',
    siblings.find((record) => record.id === 'iv_3')?.status,
  )

  console.log('\n[listing] the card payload exposes what the panel renders')

  await addCard('iv_4', 3, 'sig_c')
  const projects = await call(handler, 'GET', '/api/metacog/projects')
  const described = projects.json().projects.find((entry) => entry.projectId === projectId)
  check('the project is described', described !== undefined)
  check('it lists the pending cards', Array.isArray(described?.interventions?.open), JSON.stringify(described?.interventions).slice(0, 160))
  const open = described.interventions.open.find((entry) => entry.id === 'iv_4')
  check('with the summary the panel shows', typeof open?.promptSummary === 'string' && open.promptSummary.length > 0, JSON.stringify(open).slice(0, 160))
  check('and the proposed actions', Array.isArray(open?.suggestedActions), JSON.stringify(open?.suggestedActions))
  check('settled cards are not listed', described.interventions.open.every((entry) => entry.id !== 'iv_1'))
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
