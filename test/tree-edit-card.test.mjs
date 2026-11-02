/**
 * Functional test: edit the goal tree from the card.
 *
 * The card was read-only because there was no write route. The route now forwards
 * to the registered `goal_tree_edit` tool, so every gate the model-facing surface
 * has applies here too.
 *
 * The risk this test exists for: `resolveProjectRoot` is session-scoped, so a card
 * action could edit whichever workspace the conversation is in instead of the one
 * the card was showing. Two workspaces are built to prove the pin works.
 *
 * Run: node test/tree-edit-card.test.mjs   (after `npm run build`)
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
const { goalTreeEditTool } = await import(lib('tools/tree-edit.js'))

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

const config = parseConfig({})
const quietCtx = { logger: { debug() {}, info() {}, warn() {}, error() {} } }

/** One confirmed workspace holding an L0 root and one L1 goal under it. */
async function workspace(prefix, title) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const projectId = deriveProjectId(root)
  const store = new MetacogStore(root, config.subdir ?? config.storageSubdir)
  const now = new Date().toISOString()
  const base = {
    projectId,
    description: '',
    status: 'active',
    priority: 0,
    confirmedByUser: true,
    // The depth-1 child below is a leaf, and a leaf must be verifiable to pass
    // `LEAF_NOT_ACTIONABLE`. The root inherits this too, which costs nothing:
    // it has a child, so it is not a leaf and the check never looks at it.
    successCriteria: ['改名后只影响卡片指定的那个工作区'],
    alignment: { relevantActivities: ['x'], allowedMethods: ['y'] },
    evidence: ['x'],
    createdAt: now,
    updatedAt: now,
  }
  // A depth-1 node without a parent is not a legal tree: `TREE_SHAPE` refuses it,
  // which is correct — the fixture has to look like a real tree or it tests the
  // gate instead of the feature.
  const rootGoal = { ...base, id: 'g0', parentId: null, depth: 0, title: `根：${title}` }
  const child = { ...base, id: 'g1', parentId: 'g0', depth: 1, title }
  await store.initialize(projectId, [rootGoal, child], [])
  await store.commit(projectId, {
    expectedVersion: 0,
    goals: [rootGoal, child],
    contradictions: [],
    reason: 'fixture',
    action: 'init_trees',
    actor: 'user_confirmed',
    targetIds: [],
    markConfirmed: true,
  })
  return { root, projectId, store, state: await store.readState(projectId) }
}

/** The L1 goal of a state, which is the node these tests edit. */
function childOf(state) {
  return state.goals.find((goal) => goal.depth === 1)
}

/** The tool reports refusals as an object; flatten it for message assertions. */
function errorText(payload) {
  const error = payload.error
  if (typeof error === 'string') return error
  if (error === null || error === undefined) return ''
  return JSON.stringify(error)
}

const a = await workspace('metacog-tree-a-', '工作区 A 的目标')
const b = await workspace('metacog-tree-b-', '工作区 B 的目标')

// The tool instance, wired the way `index.ts` wires it.
const toolEnv = {
  ctx: quietCtx,
  config,
  async resolveProjectRoot(exec, explicit) {
    if (typeof explicit === 'string' && explicit.length > 0) return explicit
    // Deliberately returns workspace A for every session-scoped call: without the
    // pin, a card action aimed at B would land here.
    return a.root
  },
  storeFor(root) {
    return root === b.root ? b.store : a.store
  },
}
const editTool = goalTreeEditTool(toolEnv)

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
  listRoots: async () => [a.root, b.root],
  storeFor: (root) => (root === b.root ? b.store : a.store),
  readReports: async () => [],
  async editTree(args) {
    const { projectRoot, ...toolArgs } = args
    return await editTool.execute(toolArgs, {
      callId: 'card-test',
      name: 'goal_tree_edit',
      arguments: toolArgs,
      signal: new AbortController().signal,
      projectRoot,
      rawInput: '',
    })
  },
})
const handler = registered.handler

try {
  console.log('\n[guard] the route refuses requests it cannot apply safely')

  const noArgs = await call(handler, 'POST', '/api/metacog/tree/edit', { projectId: b.projectId })
  check('a missing args object is 400', noArgs.status === 400, String(noArgs.status))

  const noVersion = await call(handler, 'POST', '/api/metacog/tree/edit', {
    projectId: b.projectId,
    args: { updates: [{ id: 'g1', title: 'x' }] },
  })
  check('a missing expectedVersion is 400', noVersion.status === 400, String(noVersion.status))
  check('and the message names it', /expectedVersion/.test(noVersion.json().error), noVersion.json().error)

  console.log('\n[pin] the edit lands on the project the card named, not the session one')

  const edited = await call(handler, 'POST', '/api/metacog/tree/edit', {
    projectId: b.projectId,
    args: {
      expectedVersion: b.state.version,
      updates: [{ id: 'g1', title: 'B 的目标已改名' }],
      reason: '卡片改名测试',
    },
  })
  check('the edit is accepted', edited.status === 200 && edited.json().ok === true, `${edited.status} ${edited.body.slice(0, 200)}`)

  const bAfter = await b.store.readState(b.projectId)
  const aAfter = await a.store.readState(a.projectId)
  check('workspace B changed', childOf(bAfter).title === 'B 的目标已改名', childOf(bAfter).title)
  check('workspace A did not', childOf(aAfter).title === '工作区 A 的目标', childOf(aAfter).title)
  check('B advanced a version', bAfter.version === b.state.version + 1, `${b.state.version} -> ${bAfter.version}`)
  check('A stayed at its version', aAfter.version === a.state.version, `${a.state.version} -> ${aAfter.version}`)

  console.log('\n[gates] the tool\'s own refusals reach the card unchanged')

  const stale = await call(handler, 'POST', '/api/metacog/tree/edit', {
    projectId: b.projectId,
    args: { expectedVersion: b.state.version, updates: [{ id: 'g1', title: '过期的版本' }], reason: 'x' },
  })
  check('a stale version is refused', stale.status === 400, String(stale.status))
  check('and the tree is unchanged', childOf(await b.store.readState(b.projectId)).title === 'B 的目标已改名')

  const noReason = await call(handler, 'POST', '/api/metacog/tree/edit', {
    projectId: b.projectId,
    args: { expectedVersion: bAfter.version, updates: [{ id: 'g1', title: '无理由改名' }] },
  })
  check('an edit without a reason is refused', noReason.status === 400, String(noReason.status))
  check('and the message asks for one', /reason/i.test(errorText(noReason.json())), errorText(noReason.json()))

  const unknownId = await call(handler, 'POST', '/api/metacog/tree/edit', {
    projectId: b.projectId,
    args: { expectedVersion: bAfter.version, updates: [{ id: 'nope', title: 'x' }], reason: 'x' },
  })
  check('an unknown goal id is refused', unknownId.status === 400, String(unknownId.status))

  console.log('\n[audit] the card write leaves the same trail as a tool call')

  const audits = await b.store.readAuditLog(b.projectId)
  check(
    'the edit is in the audit log',
    audits.some((entry) => entry.action === 'update_lower_goal' || entry.action === 'update_l1'),
    JSON.stringify(audits.map((entry) => entry.action)),
  )
  const chain = await b.store.verifyAuditChain(b.projectId)
  check('and the audit chain verifies', chain.valid === true, JSON.stringify(chain).slice(0, 160))
} finally {
  await rm(a.root, { recursive: true, force: true })
  await rm(b.root, { recursive: true, force: true })
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
