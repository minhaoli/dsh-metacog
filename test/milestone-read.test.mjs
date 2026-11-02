/**
 * Functional test: archive a milestone, then read it back through the route.
 *
 * Archive was write-only — a milestone could be recorded but never listed or read,
 * so "did judgement improve after the tree changed" had both halves on disk with
 * no way to line them up. This drives the real route against a real store.
 *
 * Run: node test/milestone-read.test.mjs   (after `npm run build`)
 */
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
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

const root = await mkdtemp(join(tmpdir(), 'metacog-milestone-'))
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

try {
  console.log('\n[empty] a project with no archive lists nothing')

  const empty = await call(handler, 'GET', `/api/metacog/milestone?projectId=${projectId}`)
  check('the list route answers 200', empty.status === 200, String(empty.status))
  check('with an empty list, not an error', Array.isArray(empty.json().milestones) && empty.json().milestones.length === 0, JSON.stringify(empty.json()))

  console.log('\n[archive] recording a milestone makes it readable')

  const archived = await call(handler, 'POST', '/api/metacog/milestone', {
    projectId,
    label: 'v4-confirmed',
    note: '树结构定稿，之后只改细节',
  })
  check('the archive succeeds', archived.status === 200, `${archived.status} ${archived.body.slice(0, 160)}`)
  const archivedPath = archived.json().path

  const listed = await call(handler, 'GET', `/api/metacog/milestone?projectId=${projectId}`)
  const rows = listed.json().milestones
  check('the milestone appears in the list', rows.length === 1, JSON.stringify(rows))
  check('with its label', rows[0].label === 'v4-confirmed', rows[0].label)
  check('its note', rows[0].note === '树结构定稿，之后只改细节', rows[0].note)
  check('its version', typeof rows[0].version === 'number', String(rows[0].version))
  check('and its path', rows[0].path === archivedPath, `${rows[0].path} vs ${archivedPath}`)

  console.log('\n[optional] the note may be omitted')

  // Requiring a note produced one-word answers, and the label plus the captured
  // snapshot already say what was archived. The reason is a nicety, not the record.
  const bare = await call(handler, 'POST', '/api/metacog/milestone', {
    projectId,
    label: 'no-note-milestone',
  })
  check('archiving without a note succeeds', bare.status === 200, `${bare.status} ${bare.body.slice(0, 160)}`)

  const afterBare = await call(handler, 'GET', `/api/metacog/milestone?projectId=${projectId}`)
  const bareRow = afterBare.json().milestones.find((row) => row.label === 'no-note-milestone')
  check('it appears in the list', bareRow !== undefined, JSON.stringify(afterBare.json().milestones.map((r) => r.label)))
  check('with an empty note, not a missing field', bareRow?.note === '', JSON.stringify(bareRow?.note))

  // The label is still required: an unnamed milestone cannot be found later.
  const noLabel = await call(handler, 'POST', '/api/metacog/milestone', { projectId })
  check('a missing label is still refused', noLabel.status === 400, String(noLabel.status))

  console.log('\n[read] one milestone can be opened in full')

  const one = await call(
    handler,
    'GET',
    `/api/metacog/milestone?projectId=${projectId}&milestonePath=${encodeURIComponent(archivedPath)}`,
  )
  check('the detail route answers 200', one.status === 200, String(one.status))
  const detail = one.json().milestone
  check('it carries the tree it captured', detail.tree !== undefined, JSON.stringify(Object.keys(detail ?? {})))
  check('and the judgement counts beside it', detail.counts !== undefined, JSON.stringify(detail?.counts))

  console.log('\n[fence] a path outside the archive is refused')

  // The path arrives from a client, so a route that reads whatever it is handed is
  // a file-read primitive.
  const outside = await call(
    handler,
    'GET',
    `/api/metacog/milestone?projectId=${projectId}&milestonePath=${encodeURIComponent(join(root, 'state', `${projectId}.json`))}`,
  )
  check('a path outside the archive is 404', outside.status === 404, String(outside.status))

  const traversal = await call(
    handler,
    'GET',
    `/api/metacog/milestone?projectId=${projectId}&milestonePath=${encodeURIComponent(join(root, '..', 'anything.json'))}`,
  )
  check('a traversal attempt is 404', traversal.status === 404, String(traversal.status))

  console.log('\n[resilience] one corrupt entry does not hide the rest')

  const archiveDir = join(root, config.storageSubdir, 'archive', projectId)
  await mkdir(archiveDir, { recursive: true })
  await writeFile(join(archiveDir, '9999-broken.json'), '{ not json', 'utf8')

  const stillListed = await call(handler, 'GET', `/api/metacog/milestone?projectId=${projectId}`)
  // Compared against what was there before the corrupt file appeared: the count
  // itself is not fixed, because earlier cases archived more than one milestone.
  const beforeCorrupt = afterBare.json().milestones.length
  check('the good entries are still listed', stillListed.json().milestones.length === beforeCorrupt, `${beforeCorrupt} -> ${stillListed.json().milestones.length}`)
  check('and the corrupt one is skipped, not thrown', stillListed.status === 200, String(stillListed.status))
  check(
    'none of the listed rows is the corrupt file',
    stillListed.json().milestones.every((row) => !row.path.includes('9999-broken')),
    JSON.stringify(stillListed.json().milestones.map((row) => row.path)),
  )
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
