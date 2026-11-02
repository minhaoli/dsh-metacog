/**
 * Verify the settings card's Host channel without a running web server.
 *
 * The route handler is ordinary code: it takes a request, reads the store and
 * writes JSON. So it can be driven directly — a stub `webServer` captures the
 * registration, and hand-built `req`/`res` objects stand in for the socket.
 *
 * The point is to prove the wiring against real `.metacog/` data, including the
 * two writes, before the card is ever rendered in a browser.
 *
 * Usage: node scripts/verify-card-api.mjs <project-root>
 */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

import { createChecker } from './_harness.mjs'
import { installApi } from '../lib/api.js'
import { parseConfig } from '../lib/config.js'
import { MetacogStore } from '../lib/data/store.js'
import { deriveProjectId } from '../lib/tools/shared.js'

const { check, exit } = createChecker('ok', { predicate: true })

/** A response object that records what the handler wrote. */
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

/** A request object; `body` is optional because GET never reads it. */
function makeReq(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:3080' }
  if (body !== undefined) {
    req.bodyText = JSON.stringify(body)
  }
  return req
}

/** Drive one request through the handler. */
async function call(handler, method, url, body) {
  const req = makeReq(method, url, body)
  const res = makeRes()
  const pending = handler(req, res)
  if (body !== undefined) {
    // The handler subscribes to `data`/`end` while `readJson` awaits them; emit
    // on the next tick so the listeners are attached first.
    await new Promise((resolve) => setImmediate(resolve))
    req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    req.emit('end')
  }
  await pending
  return res
}

/** Mount the route against one root and return the captured handler. */
function mount(root) {
  const config = parseConfig({
    schedule: { checkIntervalMinutes: 60 },
    thresholds: {
      windowMinutes: 120,
      repeatThreshold: 3,
      minConfidence: 0.6,
      highIntensityThreshold: 4,
      staleDaysThreshold: 7,
    },
  })
  const stores = new Map()
  let registered
  const ctx = {
    // `installApi` reads the property, not `ctx.get`: the service is declared in
    // `inject`, so the stub has to look the same way the host does.
    webServer: {
      register(route) {
        registered = route
        return () => {}
      },
      getOrigin() {
        return 'http://127.0.0.1:3080'
      },
    },
    get() {
      return undefined
    },
    logger: { debug() {}, info() {}, warn() {} },
    on() {
      return () => {}
    },
    effect() {},
  }
  const dispose = installApi(ctx, {
    config,
    listRoots: async () => [root],
    storeFor(projectRoot) {
      const key = join(projectRoot, config.storageSubdir)
      let store = stores.get(key)
      if (store === undefined) {
        store = new MetacogStore(projectRoot, config.storageSubdir)
        stores.set(key, store)
      }
      return store
    },
  })
  if (registered === undefined) throw new Error('installApi registered no route')
  return { handler: registered.handler, route: registered, dispose, config }
}

const root = process.argv[2]
if (root === undefined) {
  console.error('usage: node scripts/verify-card-api.mjs <project-root>')
  process.exit(2)
}

const projectId = deriveProjectId(root)
console.log(`project root: ${root}`)
console.log(`project id:   ${projectId}`)

// ---------------------------------------------------------------- read paths
{
  const { handler, route } = mount(root)
  check('route kind is prefix', route.kind === 'prefix', route.kind)
  check('route path is /api/metacog', route.path === '/api/metacog', route.path)

  const projects = await call(handler, 'GET', '/api/metacog/projects')
  check('projects returns 200', projects.status === 200, String(projects.status))
  const list = projects.json()
  check('projects payload ok', list.ok === true, JSON.stringify(list).slice(0, 120))
  check('exactly one project found', Array.isArray(list.projects) && list.projects.length === 1, String(list.projects?.length))
  const project = list.projects[0]
  check('project id matches the derived id', project.projectId === projectId, project.projectId)
  check('goal count is reported', typeof project.goals.total === 'number' && project.goals.total > 0, String(project.goals.total))
  check('max depth is reported', typeof project.goals.maxDepth === 'number', String(project.goals.maxDepth))
  check('activity total is reported', typeof project.activities.total === 'number', String(project.activities.total))
  check(
    'decision buckets sum to the total',
    project.activities.aligned +
      project.activities.exploratory +
      project.activities.scopeDrift +
      project.activities.uncertain ===
      project.activities.total,
    JSON.stringify(project.activities),
  )
  check('judgment buckets sum to the total', project.judgments.pending + project.judgments.confirmed + project.judgments.dismissed === project.judgments.total, JSON.stringify(project.judgments))
  check('data volume lists directories', Object.keys(project.data).length > 0, JSON.stringify(project.data))
  check('thresholds are exposed', typeof project.config.thresholds.windowMinutes === 'number')
  check('level 3 flag is exposed', typeof project.config.gate.level3HardBlock === 'boolean')

  const reports = await call(handler, 'GET', `/api/metacog/reports?projectId=${encodeURIComponent(projectId)}`)
  check('reports returns 200', reports.status === 200, String(reports.status))
  const reportList = reports.json()
  check('report list is an array', Array.isArray(reportList.reports), typeof reportList.reports)
  check('report entries carry a char count', reportList.reports.every((item) => typeof item.chars === 'number'))

  if (reportList.reports.length > 0) {
    const first = reportList.reports[0]
    const one = await call(
      handler,
      'GET',
      `/api/metacog/report?projectId=${encodeURIComponent(projectId)}&reportId=${encodeURIComponent(first.id)}`,
    )
    check('single report returns 200', one.status === 200, String(one.status))
    const payload = one.json()
    check('report body is non-empty', typeof payload.report?.markdown === 'string' && payload.report.markdown.length > 0)
  }

  const missing = await call(handler, 'GET', '/api/metacog/reports?projectId=nope-00000000')
  check('unknown project is 404', missing.status === 404, String(missing.status))

  const unknownEndpoint = await call(handler, 'GET', '/api/metacog/whatever')
  check('unknown endpoint is 404', unknownEndpoint.status === 404, String(unknownEndpoint.status))
}

// ---------------------------------------------------------------- write paths
// Writes run against a throwaway copy so the real project is never touched.
const scratch = await mkdtemp(join(tmpdir(), 'metacog-card-'))
const copyRoot = join(scratch, 'project')
try {
  await copyProject(root, copyRoot)
  const { handler } = mount(copyRoot)
  const copyId = deriveProjectId(copyRoot)

  const badType = await call(handler, 'POST', '/api/metacog/report', { projectId: copyId, type: 'yearly' })
  check('invalid report type is 400', badType.status === 400, String(badType.status))

  const before = (await call(handler, 'GET', `/api/metacog/reports?projectId=${encodeURIComponent(copyId)}`)).json()
  const generated = await call(handler, 'POST', '/api/metacog/report', { projectId: copyId, type: 'daily' })
  check('generate returns 200', generated.status === 200, generated.body.slice(0, 160))
  const gen = generated.json()
  check('generate reports a body size', typeof gen.report?.chars === 'number' && gen.report.chars > 0, String(gen.report?.chars))
  const after = (await call(handler, 'GET', `/api/metacog/reports?projectId=${encodeURIComponent(copyId)}`)).json()
  check('report count grew by one', after.reports?.length === (before.reports?.length ?? -9) + 1, `${before.reports?.length} → ${after.reports?.length}`)

  const archived = await call(handler, 'POST', '/api/metacog/signals/archive', { projectId: copyId })
  check('archive returns 200', archived.status === 200, archived.body.slice(0, 160))
  const arch = archived.json()
  check('archive reports a count and a path', typeof arch.archived === 'number', JSON.stringify(arch))
  const again = await call(handler, 'POST', '/api/metacog/signals/archive', { projectId: copyId })
  check('re-archiving an empty stream is a no-op', again.json().archived === 0, again.body.slice(0, 120))
} finally {
  await rm(scratch, { recursive: true, force: true })
}

/**
 * Copy the state and stream files a card read needs, re-keying them to the copy.
 *
 * A project id is derived from its root path, so a copy at another path has a
 * different id: every `<oldId>` file name (and the snapshot directory) has to be
 * renamed or the store sees an empty project.
 */
async function copyProject(from, to) {
  const { cp, readdir, rename } = await import('node:fs/promises')
  await rm(to, { recursive: true, force: true })
  const oldId = deriveProjectId(from)
  const newId = deriveProjectId(to)
  for (const name of ['state', 'reports', 'signals', 'interventions', 'judgments', 'snapshots']) {
    const source = join(from, '.metacog', name)
    try {
      await stat(source)
    } catch {
      continue
    }
    const target = join(to, '.metacog', name)
    await cp(source, target, { recursive: true })
    for (const entry of await readdir(target)) {
      if (!entry.includes(oldId)) continue
      await rename(join(target, entry), join(target, entry.replaceAll(oldId, newId)))
    }
  }
}

exit()
