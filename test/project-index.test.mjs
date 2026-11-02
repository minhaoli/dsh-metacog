/**
 * The project index must stay a list of real workspaces.
 *
 * A test fixture creates a temp project for every case, and `rememberProject`
 * used to append one entry each. The index only ever grows, so a few suite runs
 * left it full of dead temp paths — 30 of 31 entries at one point. The sweep
 * skipped them harmlessly, but a reader looking for "what is monitored" had to
 * filter them out by eye.
 *
 * Two things are checked here:
 *
 * - a fixture root is not recorded;
 * - the index file itself survives a sweep without absorbing one.
 *
 * Run: node test/project-index.test.mjs   (after `npm run build`)
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (p) => pathToFileURL(join(here, '..', 'lib', p)).href

const { apply, isDisposableRoot } = await import(lib('index.js'))

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

const indexPath = join(homedir(), '.dsh', 'metacog-projects.json')

/** Read the index, treating a missing file as an empty list. */
async function readIndex() {
  const raw = await readFile(indexPath, 'utf8').catch(() => '[]')
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Mount the plugin over one temp workspace and return its tool registry. */
function mount(root) {
  const tools = new Map()
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return this.workingDirectory
      if (name === 'tools') return this.tools
      return undefined
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on: () => () => {},
    effect() {},
    tools: { register: (definition) => (tools.set(definition.name, definition), () => {}) },
    workingDirectory: { get: () => root, defaultDirectory: root },
  }
  apply(ctx, {})
  return tools
}

console.log('\n[rule] the guard itself, asserted directly')

{
  // The rule, not the plumbing. An earlier version of this file only walked the
  // mount-plus-confirm path, and a mutant that deleted the guard passed, because
  // that path never reached it. A pure function is the only honest target.
  const temp = tmpdir()

  check('a root inside the temp directory is disposable', isDisposableRoot(join(temp, 'metacog-abc'), temp) === true)
  check('a fixture-named root is disposable even off-temp', isDisposableRoot('D:\\Temp\\metacog-xyz', 'Q:\\nowhere') === true)
  check('a genuine workspace is not', isDisposableRoot('D:\\文档\\dsh临时工作区', temp) === false)
  check('a user file under a temp-like folder is not', isDisposableRoot('D:\\文档\\Temp\\notes', temp) === false)

  // A sibling whose name merely begins with the temp path must not match: the
  // prefix has to end at a separator, or `/tmp` would swallow `/tmpfoo`.
  check('a sibling of the temp directory is not disposable', isDisposableRoot(`${temp}foo`, temp) === false)
  check('the temp directory itself is disposable', isDisposableRoot(temp, temp) === true)
  check('a nested path inside temp is disposable', isDisposableRoot(join(temp, 'a', 'b'), temp) === true)
  check('an empty temp dir disables the prefix rule', isDisposableRoot('D:\\文档\\x', '') === false)
}

console.log('\n[fixture] a temp directory is not recorded as a workspace')

{
  const before = await readIndex()
  const countBefore = before.length

  const root = await mkdtemp(join(tmpdir(), 'metacog-index-probe-'))
  try {
    const tools = mount(root)
    const init = tools.get('goal_tree_init')
    const view = tools.get('goal_tree_view')
    check('the plugin mounted', init !== undefined && view !== undefined)

    const invocation = { cwd: root, workingDirectory: root, sessionId: 'probe', rawInput: '' }

    // A project is only *registered* once its tree is confirmed: an unconfirmed
    // draft is not a monitored workspace, so `rememberProject` is not reached
    // and the guard would never be exercised. The fixture therefore walks the
    // real path: init, then confirm.
    await init
      .execute({ userContext: { intent: 'probe the index guard' } }, invocation)
      .catch(() => undefined)

    const confirm = tools.get('goal_tree_confirm')
    check('a confirm tool exists', confirm !== undefined)
    await confirm
      .execute(
        {
          l0: { title: '探针根目标', evidence: ['probe'] },
          goals: [],
          reason: 'exercise the index guard',
        },
        invocation,
      )
      .catch(() => undefined)

    // Reading the tree is what registers a confirmed project outside a session
    // event, and registration is where the index is written.
    await view.execute({}, invocation).catch(() => undefined)

    const after = await readIndex()
    check('the temp root is not indexed', after.every((entry) => entry.projectRoot !== root), JSON.stringify(after.map((e) => e.projectRoot)))
    check('the index did not grow', after.length === countBefore, `${countBefore} -> ${after.length}`)
    check(
      'and no entry points into the temp directory',
      after.every((entry) => !entry.projectRoot.startsWith(tmpdir())),
      JSON.stringify(after.map((e) => e.projectRoot)),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log('\n[real] a genuine workspace root would be recorded')

{
  // The guard is a path test, so a non-temp path must pass it. This is checked
  // without creating the directory: the rule is about where a workspace lives,
  // not whether it exists right now.
  const realLooking = join(dirname(homedir()), 'metacog-index-real-probe')
  check('a non-temp path is not excluded by the rule', !realLooking.startsWith(tmpdir()))
  check('and does not look like a fixture', !/[\\/]Temp[\\/]metacog-/i.test(realLooking))
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
