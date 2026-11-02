/**
 * `src/api.ts`: every HTTP route the settings card talks to.
 *
 * The route handler is ordinary code, so no web server is started: a stub
 * `webServer` captures the registration and hand-built `req`/`res` objects stand
 * in for the socket. That is the same seam `scripts/verify-card-api.mjs` uses,
 * but this file runs in the suite and asserts on the failure paths as well as
 * the happy ones.
 *
 * Two mutants survived here before this file existed, so two rules get
 * dedicated coverage rather than a passing mention:
 *
 * - The purge route must refuse a confirmation id that does not match the
 *   project it actually resolved. A route that trusts the caller turns a
 *   destructive action into a one-click delete of the wrong project.
 * - The usage route must report `tokenUsage: null`. The activity stream carries
 *   no token counts, so any number there is invented, and an invented number is
 *   worse than an admitted gap.
 *
 * Run: node test/api-routes.test.mjs   (after `npm run build`)
 */
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, mkdir, stat, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (p) => pathToFileURL(join(here, '..', 'lib', p)).href

const { installApi } = await import(lib('api.js'))
const { parseConfig } = await import(lib('config.js'))
const { MetacogStore } = await import(lib('data/store.js'))
const { deriveProjectId } = await import(lib('tools/shared.js'))
const { reportMarkdownPath } = await import(lib('report.js'))

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

/** A request whose body is emitted on the next tick, once `readJson` listens. */
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

/** One temp project with a confirmed tree, plus a mounted route. */
async function fixture(prefix = 'metacog-api-') {
  const root = await mkdtemp(join(tmpdir(), prefix))
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

  const purged = []
  const opened = []
  // The report sink, faked: a real store would need a tree, and these routes only
  // care that reads and writes go to the *same* place — which is the whole
  // cross-workspace change. A map makes a divergence obvious.
  const reportSink = []
  const dispose = installApi(ctx, {
    config,
    profileConfig: {},
    listRoots: async () => [root],
    storeFor: () => store,
    runSweep: async () => ({ ran: true, signals: 0, hints: [] }),
    readReports: async () => reportSink,
    reportRoot: () => join(root, config.storageSubdir),
    async generateReport(type) {
      const now = new Date()
      const record = {
        id: `rep_${reportSink.length + 1}`,
        projectId: 'global-all-workspaces',
        type,
        generatedAt: now.toISOString(),
        periodStart: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
        periodEnd: now.toISOString(),
        goalTreeVersion: 1,
        observationIds: [],
        signalIds: [],
        interventionIds: [],
        markdown: `# ${type}\n\n## 监控状态\n- 测试\n`,
      }
      reportSink.push(record)
      // Written where the route's "open" action will look for it, so a test can
      // prove the two agree about the path.
      const path = reportMarkdownPath(join(root, config.storageSubdir), type, now)
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, record.markdown, 'utf8')
      return record
    },
    // Injected: a test must never launch the real shell. Doing so once popped a
    // "Windows cannot find the file" dialog onto the user's screen, which is both
    // a false alarm and a personal interruption.
    async opener(target, what) {
      opened.push({ target, what })
      return { ok: true }
    },
    async purgeProject(projectRoot, id, reason, scope) {
      purged.push({ root: projectRoot, projectId: id, reason, scope })
      return { deleted: ['activities'], files: 3, bytes: 100 }
    },
  })
  if (registered === undefined) throw new Error('installApi registered no route')
  return { root, config, projectId, store, handler: registered.handler, route: registered, purged, opened, reportSink, dispose }
}

// ---------------------------------------------------------------- origin guard
console.log('\n[origin] a cross-site write is refused; an opaque local one is not')

{
  const { handler, dispose } = await fixture()
  try {
    const evil = await call(handler, 'POST', '/api/metacog/purge', { projectId: 'x' }, {
      origin: 'https://evil.example',
    })
    check('a foreign origin is refused', evil.status === 403, String(evil.status))
    check('and says why', /cross-origin/.test(evil.json().error), evil.body.slice(0, 120))

    // The Electron renderer sends `null` or a `file://` origin, and an earlier
    // guard rejected both — which made every button in the card do nothing.
    const opaque = await call(handler, 'GET', '/api/metacog/projects', undefined, { origin: 'null' })
    check('an opaque origin may read', opaque.status === 200, String(opaque.status))

    const fileOrigin = await call(handler, 'POST', '/api/metacog/sweep', { projectId: null }, {
      origin: 'file://',
      'content-type': 'application/json',
    })
    check('a file:// origin may write when it sends JSON', fileOrigin.status !== 403, String(fileOrigin.status))

    const formPost = await call(handler, 'POST', '/api/metacog/sweep', { projectId: null }, {
      origin: 'null',
      'content-type': 'application/x-www-form-urlencoded',
    })
    check('but a form-encoded write is refused', formPost.status === 403, String(formPost.status))
  } finally {
    dispose()
  }
}

// ------------------------------------------------------------------- reads
console.log('\n[read] the card can list projects and one project')
{
  const { handler, projectId, dispose } = await fixture()
  try {
    const projects = await call(handler, 'GET', '/api/metacog/projects')
    check('projects answers 200', projects.status === 200, String(projects.status))
    const list = projects.json().projects
    check('and lists the confirmed project', list.length === 1 && list[0].projectId === projectId, JSON.stringify(list).slice(0, 160))
    check('with goal counts', typeof list[0].goals.total === 'number', JSON.stringify(list[0].goals))
    // Completion was computed for the report but never sent to the card, so the one
    // number that answers "how far along" was only visible in a generated report.
    check('with an overall progress summary', typeof list[0].progress?.completion === 'number', JSON.stringify(list[0].progress))
    check('including per-depth completion', Array.isArray(list[0].progress?.byDepth), JSON.stringify(list[0].progress?.byDepth))
    check('and a criteria gap count', typeof list[0].criteriaGap.missing === 'number')
    check('and the tree nodes', Array.isArray(list[0].nodes))

    const missing = await call(handler, 'GET', '/api/metacog/reports')
    check('a request naming no project resolves to one', missing.status === 200, String(missing.status))

    const unknown = await call(handler, 'GET', '/api/metacog/reports?projectId=nope')
    check('an unknown project id is 404', unknown.status === 404, String(unknown.status))
  } finally {
    dispose()
  }
}

// ------------------------------------------------------------------- usage
console.log('\n[usage] counts are real and token usage is admitted, not invented')
{
  const { handler, projectId, store, dispose } = await fixture()
  try {
    await store.appendActivity(projectId, {
      id: 'act_1',
      eventFingerprint: 'f1',
      projectId,
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      source: 'turn',
      observationGrade: 'A',
      summary: 'did something',
      evidence: [],
      candidateGoalIds: [],
      alignmentConfidence: null,
      decision: 'aligned',
      rationale: '',
    })

    const res = await call(handler, 'GET', `/api/metacog/usage?projectId=${projectId}`)
    check('usage answers 200', res.status === 200, String(res.status))
    const usage = res.json().usage
    check('it counts the recorded activity', usage.activities === 1, String(usage.activities))
    // The mutant invented a number here. There is no token data in the stream,
    // so null is the only honest value and a number is a fabrication.
    check('token usage is null, never a number', usage.tokenUsage === null, JSON.stringify(usage.tokenUsage))
    check('and the note says why', /不编造|没有 token/.test(usage.tokenUsageNote), usage.tokenUsageNote)
  } finally {
    dispose()
  }
}

// ----------------------------------------------------------------- reports
console.log('\n[report] generating validates the cadence and returns a summary')
{
  const { handler, projectId, dispose } = await fixture()
  try {
    const bad = await call(handler, 'POST', '/api/metacog/report', { projectId, type: 'hourly' })
    check('an unknown cadence is 400', bad.status === 400, String(bad.status))
    check('and the message names the allowed set', /daily/.test(bad.json().error), bad.json().error)

    const ok = await call(handler, 'POST', '/api/metacog/report', { projectId, type: 'daily' })
    check('a daily report generates', ok.status === 200, String(ok.status))
    check('and comes back as a summary', typeof ok.json().report.chars === 'number', JSON.stringify(ok.json()).slice(0, 160))

    const listed = await call(handler, 'GET', `/api/metacog/reports?projectId=${projectId}`)
    check('it now appears in the list', listed.json().reports.length === 1, JSON.stringify(listed.json().reports).slice(0, 160))

    const id = listed.json().reports[0].id
    const one = await call(handler, 'GET', `/api/metacog/report?projectId=${projectId}&reportId=${id}`)
    check('and can be fetched with its body', typeof one.json().report.markdown === 'string')

    const notFound = await call(handler, 'GET', `/api/metacog/report?projectId=${projectId}&reportId=nope`)
    check('an unknown report id is 404', notFound.status === 404, String(notFound.status))
  } finally {
    dispose()
  }
}

// -------------------------------------------------------------- open routes
console.log('\n[open] the file and folder buttons target paths this plugin wrote')
{
  const { handler, projectId, root, config, opened, dispose } = await fixture()
  try {
    const badType = await call(handler, 'POST', '/api/metacog/report/open', { projectId, type: 'yearly', what: 'file' })
    check('an unknown cadence is refused', badType.status === 400, String(badType.status))

    const unknown = await call(handler, 'POST', '/api/metacog/report/open', { projectId: 'nope', type: 'daily' })
    check('an unknown project is 404', unknown.status === 404, String(unknown.status))

    // Opening a file that does not exist is not a shell error to show the user:
    // it means no report of that cadence has been generated yet.
    const missing = await call(handler, 'POST', '/api/metacog/report/open', { projectId, type: 'daily', what: 'file' })
    check('a missing report file is refused before the shell runs', missing.status === 404, String(missing.status))
    check('and says nothing was generated yet', /还没生成过/.test(missing.json().error), missing.json().error)
    check('and the shell was never asked to open it', opened.length === 0, JSON.stringify(opened))

    // Generating one first is what makes the file button meaningful. With no
    // `at` in the request the route falls back to now, which is the bucket the
    // freshly generated report landed in.
    await call(handler, 'POST', '/api/metacog/report', { projectId, type: 'daily' })
    const file = await call(handler, 'POST', '/api/metacog/report/open', { projectId, type: 'daily', what: 'file' })
    check('an existing report file opens', file.status === 200, String(file.status))
    // The seam that broke twice: the generator decides where a file goes, the
    // open action decides where to look. If the two ever disagree the button
    // reports "not generated yet" for a report that was just created.
    const written = opened[opened.length - 1].target
    check(
      'the opened path is the path the generator wrote',
      await stat(written).then(() => true, () => false),
      `${written} does not exist`,
    )
    check('and it lives under the report root', written.startsWith(join(root, config.storageSubdir)), written)
    check(
      'at the path the builder writes',
      file.json().path === reportMarkdownPath(join(root, config.storageSubdir), 'daily', new Date()),
      file.json().path,
    )
    check('and the shell was asked, once', opened.length === 1 && opened[0].what === 'file', JSON.stringify(opened))

    // A folder request lands on the cadence's own directory, not the shared root.
    const folder = await call(handler, 'POST', '/api/metacog/report/open', { projectId, type: 'monthly', what: 'folder' })
    check(
      'the folder target is the cadence directory',
      folder.json().path === join(root, config.storageSubdir, 'reports', 'markdown', '月报'),
      folder.json().path,
    )
    check('the folder opens even with no reports yet', folder.status === 200, String(folder.status))
    check('and it was created on demand', await stat(folder.json().path).then(() => true, () => false))
  } finally {
    dispose()
  }
}

// ------------------------------------------------------------------- purge
console.log('\n[purge] the confirmation must match the project that was resolved')
{
  const { handler, projectId, purged, dispose } = await fixture()
  try {
    // The mutant accepted any id. Typing out an id is the only guard a
    // destructive action has, so a route that ignores it is a one-click delete.
    const wrong = await call(handler, 'POST', '/api/metacog/purge', {
      projectId,
      confirmProjectId: 'some-other-project',
      reason: 'test',
    })
    check('a mismatched confirmation is refused', wrong.status === 400, String(wrong.status))
    check('and the message names the resolved project', /does not match/.test(wrong.json().error), wrong.json().error)
    check('nothing was deleted', purged.length === 0, JSON.stringify(purged))

    const blank = await call(handler, 'POST', '/api/metacog/purge', { projectId, confirmProjectId: '' })
    check('an empty confirmation is refused too', blank.status === 400, String(blank.status))

    // The reason is optional; what must survive is the record of what went.
    const ok = await call(handler, 'POST', '/api/metacog/purge', { projectId, confirmProjectId: projectId })
    check('a matching confirmation with no reason is accepted', ok.status === 200, String(ok.status))
    check('and the purge ran once', purged.length === 1, JSON.stringify(purged))
    check('with the records scope by default', purged[0].scope === 'records', JSON.stringify(purged[0]))

    const everything = await call(handler, 'POST', '/api/metacog/purge', {
      projectId,
      confirmProjectId: projectId,
      scope: 'everything',
    })
    check('the everything scope is passed through', everything.status === 200 && purged[1].scope === 'everything', JSON.stringify(purged))
  } finally {
    dispose()
  }
}

// ----------------------------------------------------------------- settings
console.log('\n[settings] only editable paths are listed and only those can be written')
{
  const { handler, dispose } = await fixture()
  try {
    const read = await call(handler, 'GET', '/api/metacog/settings')
    check('settings answers 200', read.status === 200, String(read.status))
    const editable = read.json().editable
    check('every entry names its dotted path', editable.every((row) => typeof row.path === 'string'))
    check('and says a restart is needed', editable.every((row) => row.requiresRestart === true))
    check('storageSubdir is not editable', editable.every((row) => row.path !== 'storageSubdir'))
    check('autoReport is editable', editable.some((row) => row.path === 'schedule.autoReport'), JSON.stringify(editable.map((r) => r.path)))

    const noPath = await call(handler, 'POST', '/api/metacog/settings', { value: 1 })
    check('a write with no path is 400', noPath.status === 400, String(noPath.status))

    const notEditable = await call(handler, 'POST', '/api/metacog/settings', {
      path: 'storageSubdir',
      value: 'elsewhere',
    })
    check('a non-editable path is refused', notEditable.status === 400, String(notEditable.status))
  } finally {
    dispose()
  }
}

// -------------------------------------------------------------- misc routes
console.log('\n[misc] the remaining routes answer or report a real failure')
{
  const { handler, projectId, dispose } = await fixture()
  try {
    const llm = await call(handler, 'GET', '/api/metacog/llm')
    check('llm answers 200 without a model', llm.status === 200, String(llm.status))
    check('and reports the provider as null rather than guessing', llm.json().llm.provider === null, JSON.stringify(llm.json().llm))

    const sweep = await call(handler, 'POST', '/api/metacog/sweep', { projectId })
    check('sweep answers 200', sweep.status === 200, String(sweep.status))
    check('and says the model half was skipped', /模型复核/.test(sweep.json().sweep.note), sweep.json().sweep.note)

    const archive = await call(handler, 'POST', '/api/metacog/signals/archive', { projectId })
    check('archiving an empty stream is not an error', archive.status === 200 && archive.json().archived === 0, JSON.stringify(archive.json()))

    const noLabel = await call(handler, 'POST', '/api/metacog/milestone', { projectId, note: 'x' })
    check('a milestone without a label is 400', noLabel.status === 400, String(noLabel.status))
    // The note is optional: requiring it produced one-word answers, and the label
    // plus the captured snapshot already identify what was archived.
    const noNote = await call(handler, 'POST', '/api/metacog/milestone', { projectId, label: 'note-optional' })
    check('a milestone without a note is accepted', noNote.status === 200, `${noNote.status} ${noNote.body.slice(0, 120)}`)
    const milestone = await call(handler, 'POST', '/api/metacog/milestone', { projectId, label: 'v1', note: 'why' })
    check('a complete milestone is archived', milestone.status === 200 && typeof milestone.json().version === 'number', JSON.stringify(milestone.json()))

    const unknown = await call(handler, 'GET', '/api/metacog/not-a-route')
    check('an unknown endpoint is 404', unknown.status === 404, String(unknown.status))
    check('and the message names it', /unknown endpoint/.test(unknown.json().error), unknown.json().error)
  } finally {
    dispose()
  }
}

// ------------------------------------------------------------ error handling
console.log('\n[errors] a throwing store becomes a 500, not a dead server')
{
  const root = await mkdtemp(join(tmpdir(), 'metacog-api-boom-'))
  const config = parseConfig({})
  const projectId = deriveProjectId(root)
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
    listRoots: async () => [root],
    storeFor: () => ({
      async readState() {
        throw new Error('disk on fire')
      },
    }),
  })
  try {
    const res = await call(registered.handler, 'GET', '/api/metacog/projects')
    check('the request answers 500', res.status === 500, String(res.status))
    check('with the error text', /disk on fire/.test(res.json().error), res.body.slice(0, 120))
    check('as JSON, not a crash', /application\/json/.test(res.headers['content-type'] ?? ''), JSON.stringify(res.headers))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// --------------------------------------------------------- no web server
console.log('\n[absent] a host with no web server degrades instead of throwing')
{
  const ctx = {
    webServer: undefined,
    get: () => undefined,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on: () => () => {},
    effect: () => {},
  }
  const result = installApi(ctx, {
    config: parseConfig({}),
    listRoots: async () => [],
    storeFor: () => {
      throw new Error('should not be called')
    },
  })
  check('installApi returns undefined', result === undefined, String(result))
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
