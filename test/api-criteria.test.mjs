/**
 * `POST /api/metacog/criteria`: the settings card's suggestion endpoint.
 *
 * The route must reuse `metacog_draft_criteria` (so the quality gates and the
 * "no empty array on failure" contract stay in one place), must never write the
 * tree, and must report a missing llm as an error rather than an empty list.
 *
 * Run: node test/api-criteria.test.mjs   (after `npm run build`)
 */
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (path) => pathToFileURL(join(here, '..', 'lib', path)).href

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
    writeHead(status) {
      this.status = status
    },
    end(text) {
      this.body = text ?? ''
    },
    json() {
      return JSON.parse(this.body)
    },
  }
}

function makeReq(method, url) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:3080' }
  req.destroy = () => {}
  return req
}

async function call(handler, method, url, body) {
  const req = makeReq(method, url)
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

const VALID = {
  relevantActivities: ['写判据', '跑测试'],
  excludedActivities: ['写文档'],
  unable: false,
  reason: '',
}

function fakeLlm() {
  return {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', text: JSON.stringify(VALID) }
        yield { type: 'finish', reason: 'stop' }
      })()
    },
  }
}

async function fixture(llm) {
  const root = await mkdtemp(join(tmpdir(), 'metacog-api-criteria-'))
  await writeFile(join(root, 'README.md'), '# fixture\n', 'utf8')
  const config = parseConfig({})
  const projectId = deriveProjectId(root)
  const store = new MetacogStore(root, config.storageSubdir)
  const now = new Date().toISOString()
  await store.initialize(projectId, [], [])
  await store.commit(projectId, {
    expectedVersion: 0,
    goals: [
      {
        id: 'G1_root',
        projectId,
        parentId: null,
        depth: 0,
        title: '根目标',
        description: '',
        status: 'active',
        priority: 0,
        confirmedByUser: true,
        successCriteria: ['完成'],
        alignment: {
          relevantActivities: ['筹备'],
          allowedMethods: [],
          excludedActivities: [],
          explorationPolicy: 'allowed',
        },
        paths: [],
        evidence: ['README.md'],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'G2_leaf',
        projectId,
        parentId: 'G1_root',
        depth: 1,
        title: '写判据',
        description: '',
        status: 'active',
        priority: 0,
        confirmedByUser: true,
        successCriteria: ['判据可匹配'],
        alignment: {
          relevantActivities: [],
          allowedMethods: [],
          excludedActivities: [],
          explorationPolicy: 'allowed',
        },
        paths: [],
        evidence: ['README.md'],
        createdAt: now,
        updatedAt: now,
      },
    ],
    contradictions: [],
    reason: 'fixture',
    action: 'init_trees',
    actor: 'user_confirmed',
    targetIds: [],
    markConfirmed: true,
  })

  let registered
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
      if (name === 'llm') return llm
      if (name === 'agents') return { defaultModel: () => ({ provider: 'p1', model: 'm1' }) }
      return undefined
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on: () => () => {},
    effect: () => {},
  }
  installApi(ctx, {
    config,
    profileConfig: {},
    listRoots: async () => [root],
    storeFor: () => store,
  })
  return { root, projectId, store, handler: registered.handler }
}

console.log('\n[criteria] suggestions are returned and nothing is written')
{
  const { root, projectId, store, handler } = await fixture(fakeLlm())
  try {
    const before = await store.readState(projectId)
    const res = await call(handler, 'POST', '/api/metacog/criteria', {
      projectId,
      goalIds: ['G2_leaf'],
    })
    const body = res.json()
    check('the route answers 200', res.status === 200, String(res.status))
    check('it reports ok', body.ok === true, JSON.stringify(body))
    check('a suggestion comes back', Array.isArray(body.suggestions) && body.suggestions.length === 1, JSON.stringify(body))
    check('the suggestion is for the asked goal', body.suggestions[0].goalId === 'G2_leaf', JSON.stringify(body.suggestions[0]))
    check('it carries criteria', body.suggestions[0].relevantActivities.length > 0, JSON.stringify(body.suggestions[0]))
    check('the tool says it did not write', body.wrote === false, JSON.stringify(body.wrote))
    const after = await store.readState(projectId)
    check('the tree is unchanged', JSON.stringify(after.goals) === JSON.stringify(before.goals))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log('\n[criteria] a missing llm is a named error, not an empty list')
{
  const { root, handler } = await fixture(undefined)
  try {
    const res = await call(handler, 'POST', '/api/metacog/criteria', { goalIds: [] })
    const body = res.json()
    check('the route refuses with 503', res.status === 503, String(res.status))
    check('the error code is explicit', body.error?.code === 'LLM_UNAVAILABLE', JSON.stringify(body))
    check('no empty suggestions are returned', body.suggestions === undefined, JSON.stringify(body))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log('\n[criteria] an unknown project is 404')
{
  const { root, handler } = await fixture(fakeLlm())
  try {
    const res = await call(handler, 'POST', '/api/metacog/criteria', { projectId: 'nope' })
    check('the route answers 404', res.status === 404, String(res.status))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
