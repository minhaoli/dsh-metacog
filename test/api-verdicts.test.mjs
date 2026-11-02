/**
 * `GET /api/metacog/verdicts`: the card's recent-verdict feed.
 *
 * It reads `store.readVerdicts`, returns newest first, honours `limit`, and
 * resolves the goal title so the card does not have to hold the whole tree.
 * A null `match` and a null `fulfilled` must survive the route unchanged: the
 * card renders them as "cannot judge" and "no previous expectation", and
 * collapsing either into 0/false would invent a verdict.
 *
 * Run: node test/api-verdicts.test.mjs   (after `npm run build`)
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

async function get(handler, url) {
  const res = makeRes()
  await handler(makeReq('GET', url), res)
  return res
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'metacog-api-verdicts-'))
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
        alignment: { relevantActivities: ['筹备'], allowedMethods: [], excludedActivities: [], explorationPolicy: 'allowed' },
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
        alignment: { relevantActivities: ['写判据'], allowedMethods: [], excludedActivities: [], explorationPolicy: 'allowed' },
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

  const base = {
    projectId,
    windowStart: now,
    windowEnd: now,
    provider: 'p1',
    model: 'm1',
    elapsedMs: 10,
    inputChars: 100,
    outputChars: 20,
  }
  await store.appendVerdict({ ...base, at: '2026-10-01T00:00:00.000Z', match: 0.2, goalId: 'G2_leaf', reason: '第一条', expectNext: '继续', fulfilled: null })
  await store.appendVerdict({ ...base, at: '2026-10-02T00:00:00.000Z', match: null, goalId: null, reason: '目标模糊', expectNext: '', fulfilled: false })
  await store.appendVerdict({ ...base, at: '2026-10-03T00:00:00.000Z', match: 0.8, goalId: 'G2_leaf', reason: '第三条', expectNext: '交付', fulfilled: true })

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
  })
  return { root, projectId, handler: registered.handler }
}

console.log('\n[verdicts] newest first, titles resolved, nulls preserved')
{
  const { root, projectId, handler } = await fixture()
  try {
    const res = await get(handler, `/api/metacog/verdicts?projectId=${encodeURIComponent(projectId)}`)
    const body = res.json()
    check('the route answers 200', res.status === 200, String(res.status))
    check('three records come back', body.verdicts.length === 3, JSON.stringify(body.verdicts))
    check('newest first', body.verdicts[0].reason === '第三条', JSON.stringify(body.verdicts.map((item) => item.reason)))
    check('the goal title is resolved', body.verdicts[0].goalTitle === '写判据', JSON.stringify(body.verdicts[0]))
    const vague = body.verdicts.find((item) => item.reason === '目标模糊')
    check('match null survives', vague.match === null, JSON.stringify(vague))
    check('fulfilled false survives', vague.fulfilled === false, JSON.stringify(vague))
    check('a null goal stays null', vague.goalId === null && vague.goalTitle === null, JSON.stringify(vague))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log('\n[verdicts] limit keeps the newest N')
{
  const { root, projectId, handler } = await fixture()
  try {
    const res = await get(handler, `/api/metacog/verdicts?projectId=${encodeURIComponent(projectId)}&limit=2`)
    const body = res.json()
    check('two records come back', body.verdicts.length === 2, JSON.stringify(body.verdicts))
    check('the newest two are kept', body.verdicts[0].reason === '第三条' && body.verdicts[1].reason === '目标模糊', JSON.stringify(body.verdicts.map((item) => item.reason)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log('\n[verdicts] unknown project is 404')
{
  const { root, handler } = await fixture()
  try {
    const res = await get(handler, '/api/metacog/verdicts?projectId=nope')
    check('the route answers 404', res.status === 404, String(res.status))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
