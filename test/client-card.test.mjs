/**
 * The client half: does it load, and does it register the surfaces it claims?
 *
 * This card is plain JavaScript with no build step, so a syntax error reaches the
 * user as a blank panel with one console line. The check below runs it through the
 * same `__ModuleLoader__` contract the host uses, with a stub `react`, and asserts
 * the registrations — which is what catches a typo in the slot name or a component
 * that throws on first render.
 *
 * Run: node test/client-card.test.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

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
 * A minimal `react` stand-in.
 *
 * `createElement` returns a plain descriptor so the tree can be inspected without a
 * renderer. Hooks are stubbed to the values a first render would see: this is a
 * structural check, not a behavioural one, and pretending to run effects would make
 * it look like something it is not.
 */
const reactStub = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  },
  useEffect() {},
  // A stable box, like the real hook: the auto-dismiss timer stores its handle here
  // and the cleanup effect reads it back.
  useRef(initial) {
    return { current: initial ?? null }
  },
  useCallback(fn) {
    return fn
  },
  useMemo(fn) {
    return fn()
  },
}

/** Collect what the module registers. */
const registrations = []
const injections = []
const loader = {
  load({ id, factory }) {
    const module = factory((name) => {
      if (name === 'react') return reactStub
      throw new Error(`unexpected require: ${name}`)
    })
    module.apply({
      slots: {
        inject(slot, fn) {
          injections.push(slot)
          fn()
          return () => {}
        },
        register(definition, component) {
          registrations.push({ definition, component })
          return () => {}
        },
      },
    })
    check('the module declares an id', typeof id === 'string' && id.length > 0, String(id))
  },
}

console.log('\n[load] the module runs under the host loader contract')

let thrown
try {
  // `window` is what the module attaches itself to.
  globalThis.window = { __ModuleLoader__: loader }
  await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`)
} catch (error) {
  thrown = error
}
check('it loads without throwing', thrown === undefined, thrown && String(thrown))

console.log('\n[slots] both surfaces are registered')

const names = registrations.map((entry) => entry.definition.name)
check('the bundle page is registered', names.includes('plugins.bundle.config'), names.join(','))
check('the settings section is registered', names.includes('settings.section'), names.join(','))
check('both injections were attempted', injections.length === 2, String(injections.length))

const settings = registrations.find((entry) => entry.definition.name === 'settings.section')
check('the settings row has a stable id', settings?.definition.id === 'metacog', String(settings?.definition.id))
check('it declares an order', typeof settings?.definition.order === 'number', String(settings?.definition.order))
check(
  'and a label function rather than a string',
  typeof settings?.definition.label === 'function',
  typeof settings?.definition.label,
)

console.log('\n[render] the component produces a tree instead of throwing')

{
  const card = registrations.find((entry) => entry.definition.name === 'settings.section')
  check('a component was registered', typeof card?.component === 'function')

  let rendered
  let renderError
  try {
    // First render: no project loaded yet, which is the state every user meets.
    rendered = card.component({})
  } catch (error) {
    renderError = error
  }
  check('it renders without a project', renderError === undefined, renderError && String(renderError))
  check('and returns an element', rendered !== undefined && rendered !== null)
  check('the empty state explains what to do', JSON.stringify(rendered ?? {}).includes('goal_tree_init'))
}

{
  // The summary view is a different projection of the same component and takes an
  // early return, so it is worth exercising separately.
  const card = registrations.find((entry) => entry.definition.name === 'plugins.bundle.config')
  let rendered
  let renderError
  try {
    rendered = card.component({ view: 'summary' })
  } catch (error) {
    renderError = error
  }
  check('the summary view renders', renderError === undefined, renderError && String(renderError))
}

console.log('\n[structure] the three tabs and the honesty blocks are present')

{
  // The mockup's value is not decoration: each tab answers a different question, and
  // the numbers that mislead carry the sentence that says why. Both are easy to drop
  // while editing JSX, so both are asserted here.
  const must = [
    ['状态 tab', "'状态'"],
    ['tree tab', "'目标树与矛盾树'"],
    ['config tab', "'设置'"],
    ['当前状态 card', "'当前状态'"],
    ['needs-you card', "'需要你处理'"],
    ['criteria-gap sentence', '判据缺口'],
    ['trust card', "'判断可信度'"],
    ['glossary', '术语表'],
    ['quiet-mode explanation', '只记录、不打扰'],
    ['delete warning', '不能撤销'],
  ]
  for (const [label, needle] of must) {
    check(label + ' is present', source.includes(needle), needle)
  }

  // Style keys are referenced as S.xxx. A typo yields undefined styling, which
  // renders as unstyled text rather than an error, so it is checked mechanically.
  const sStart = source.indexOf('const S = {')
  const sEnd = source.indexOf('\n    }', sStart)
  const block = source.slice(sStart, sEnd)
  const defined = new Set([...block.matchAll(/^      (\w+):/gm)].map((m) => m[1]))
  // The `\b` matters: without it `parts.map(...)` matches as `S.map`, because the
  // regex only sees the last letter of `parts`. That produced a false failure
  // naming a style key nobody wrote.
  const missing = [...new Set([...source.matchAll(/\bS\.(\w+)/g)].map((m) => m[1]))].filter(
    (key) => !defined.has(key),
  )
  check('every S.xxx reference is defined', missing.length === 0, missing.join(','))
}

console.log('\n[guards] a button may only look ready if the handler will accept it')

{
  // The defect this pins: the delete button enabled on the id alone, while the handler
  // also required a reason and returned early — silently, because the reload that
  // followed cleared the error before it reached the screen. The button looked ready,
  // did nothing, and said nothing.
  const handler = source.slice(source.indexOf('const purge = useCallback'), source.indexOf('const saveSetting'))
  const button = source.slice(source.indexOf('永久删除全部'), source.indexOf('id 已匹配', source.indexOf('永久删除全部')))

  const handlerGuards = (handler.match(/return { ok: false, error:/g) || []).length
  check('the purge handler has guards', handlerGuards >= 2, String(handlerGuards))

  // Scope the search to the danger card: `disabled:` appears on other controls first,
  // and the expression spans three lines.
  const dangerAt = source.indexOf("key: 'danger'")
  const dangerBlock = source.slice(dangerAt, source.indexOf("key: 'glossary'"))
  // Reason is optional by design: requiring prose discouraged the operation more than
  // it improved the audit, and the entry records what was destroyed either way. The
  // assertion is now the opposite — the reason must NOT be part of the guard.
  check(
    'the button does not require a reason',
    !dangerBlock.includes('purgeReason.trim().length === 0'),
    'the reason must not gate the button',
  )

  // The three hint strings must be mutually exclusive and cover every state.
  check('the label marks the reason as optional', source.includes('为什么清空（可选）'))
  check('the hint confirms readiness', source.includes('条件齐了'))
}

console.log('\n[errors] a failure must survive the reload that follows it')

{
  // load() used to call setError(null) unconditionally, so act()'s message was erased in
  // the same render. Every failed action looked like a dead button.
  check(
    'load accepts a clearError option',
    source.includes('const load = useCallback(async (options) =>') && source.includes('clearError'),
  )
  check(
    'act passes clearError:false when the action failed',
    source.includes('clearError: outcome !== undefined && outcome.ok === true'),
    'act() must not clear the error of a failed action',
  )
  check(
    'the empty state renders the error too',
    source.includes('projects.length === 0') && source.includes("error ? h('div', { style: S.dangerLine }, error) : null"),
  )
}

console.log('\n[source] the endpoints the card calls all exist on the host')

{
  const { readdirSync } = await import('node:fs')
  const apiSource = readFileSync(join(here, '..', 'src', 'api.ts'), 'utf8')
  const called = new Set()
  for (const match of source.matchAll(/api\('([^']+)'/g)) {
    const path = match[1].split('?')[0]
    if (path.startsWith('/api/')) called.add(path)
  }
  for (const match of source.matchAll(/api\('([^']+)' \+/g)) {
    const path = match[1].split('?')[0]
    if (path.startsWith('/api/')) called.add(path)
  }
  check('the card calls at least one endpoint', called.size > 0, String(called.size))
  for (const path of [...called].sort()) {
    check(`${path} is handled by the host route`, apiSource.includes(`path === '${path}'`), path)
  }
}

console.log('\n[reports] the cadence buttons switch the view; generating is a separate button')

{
  // A structural check on the source, because the panel only renders once a
  // project is loaded and this stub runs no effects.
  //
  // The behaviour being locked: clicking a cadence used to *generate* a report as
  // a side effect, so merely looking at the weekly list wrote a file. Switching a
  // view and performing an action now have to be different controls.
  const at = source.indexOf("key: 'reports'")
  const reportPanel = at === -1 ? '' : source.slice(at, at + 3000)

  check('the panel exists', reportPanel.length > 0)
  check(
    'a cadence button only changes the selected type',
    /onClick: \(\) => \{\s*setReportType\(cadence\)/.test(reportPanel),
    reportPanel.slice(0, 400),
  )
  // Extract the cadence button's own onClick body and insist it performs no
  // generation. Matching a single literal call missed a block body that had one
  // added to it, which is exactly how the side effect would come back.
  const cadenceHandler = reportPanel.match(/onClick: \(\) => \{[\s\S]*?setOpen\(null\)\s*\}/)
  check('the cadence handler was found', cadenceHandler !== null, reportPanel.slice(0, 400))
  check(
    'and it never generates on click',
    cadenceHandler !== null && !/\bgenerate\s*\(/.test(cadenceHandler[0]),
    cadenceHandler === null ? 'no handler' : cadenceHandler[0],
  )
  check('generation has its own button', /onClick: \(\) => generate\(reportType\)/.test(reportPanel), reportPanel.slice(0, 800))
  check('its label names the cadence', /'生成' \+ REPORT_LABELS\[reportType\]/.test(reportPanel))

  // Each cadence is its own file now, so the list must not mix them.
  check('the list is filtered to the selected cadence', /reports\.filter\(\(report\) => report\.type === reportType\)/.test(source))

  // Opening the file and the folder are two distinct host actions.
  check('a button opens the report file', /openReport\('file'\)/.test(reportPanel))
  check('another opens its folder', /openReport\('folder'\)/.test(reportPanel))
  check('both go through the open route', source.includes('/api/metacog/report/open'))
  check('and the route is asked with the selected cadence', /type: reportType/.test(source), 'the open call must name the cadence')

  // The panel explains the nesting, because it is the part a reader cannot
  // guess: a weekly report summarises that week's dailies, not the raw activity.
  check('the panel renders a per-cadence hint', /REPORT_HINTS\[reportType\]/.test(reportPanel), reportPanel.slice(-600))
  check(
    'the hints name the bucket layout',
    /日报\/年份_月份/.test(source) && /周报\/年份_季度/.test(source) && /月报\/年份\//.test(source),
    'each cadence must say where its files live',
  )
  check(
    'and the aggregation direction',
    /汇总这一周的日报/.test(source) && /汇总这一月的周报/.test(source),
    'weekly reads dailies, monthly reads weeklies',
  )
}

console.log('\n[settings] the auto-report switch is on the card and defaults to on')

{
  check('the card renders the switch', /schedule\.autoReport/.test(source))
  check(
    'it falls back to true when the host sends nothing',
    /valueOf\('schedule\.autoReport', true\)/.test(source),
    'the fallback must match the schema default',
  )
}

console.log('\n[feedback] the result of an action is visible from where the button was')

{
  // Feedback belongs to the panel that produced it. A single bar at the top of the
  // card was reported as easy to miss twice — the click happened far below and the
  // message appeared elsewhere. So every action names a scope and each panel
  // renders only its own.
  check('a feedback renderer exists', /const feedbackFor = \(scope\) =>/.test(source))
  check('it keys on the scope', /feedback\[scope\]/.test(source))

  // Every action passes a scope. A bare `act(async` would land in the wrong place
  // or nowhere at all.
  const scoped = (source.match(/act\('[a-z]+',/g) ?? []).length
  const bare = (source.match(/act\(async/g) ?? []).length
  check('every action names a scope', bare === 0, `${bare} unscoped act call(s)`)
  check('and there is more than one', scoped >= 8, String(scoped))

  // The panels that own buttons each render their own slot.
  for (const scope of ['reports', 'todo', 'tree', 'settings', 'data', 'milestone', 'danger']) {
    check(`the ${scope} panel renders its feedback`, source.includes(`feedbackFor('${scope}')`))
  }

  // No global bar: one would duplicate every message at the top of the page.
  check('no top-of-card notice remains', source.includes("notice ? h('div'") === false)
  check('no global error bar remains', source.includes("error ? h('div', { style: S.dangerBar }") === false)
}

console.log('\n[milestones] the archive can be read back, not only written')

{
  check('the card loads the archive list', source.includes("'/api/metacog/milestone?projectId='"))
  check('it renders one row per milestone', source.includes('milestones.map((entry)'))
  check('a row can be opened in full', source.includes('showMilestone(entry.path)'))
  check('the detail request passes the path', source.includes('&milestonePath='))
  // Archiving refreshes the list, so the new entry appears without a reload.
  check('archiving refreshes the list', /await loadMilestones\(activeId\)/.test(source))
  check('an empty archive says so', source.includes('还没有归档过里程碑'))

  // The note is optional. Requiring it produced one-word answers, and the label
  // plus the snapshot already identify what was archived.
  check('the note field is marked optional', source.includes('为什么记这一笔（可选）'))
  check('and blocks nothing', /milestoneNote\.trim\(\)\.length === 0\) return/.test(source) === false, 'the note must not gate the archive button')
}

console.log('\n[tree] the goal tree is editable from the card, through the governed path')

{
  const apiSource = readFileSync(join(here, '..', 'src', 'api.ts'), 'utf8')

  check('the tree panel offers an edit button', source.includes('编辑这个目标'))
  check('the form collects a reason', source.includes("label: '为什么改'"))
  check('and will not save without one', /disabled: busy \|\| goalDraft\.reason\.trim\(\)\.length === 0/.test(source))
  check('the version travels with the draft', source.includes('version: active.version'))
  check('the save posts to the edit route', source.includes("'/api/metacog/tree/edit'"))
  check('the status options are declared', /const GOAL_STATUSES = \[/.test(source))

  // The route must forward to the tool rather than re-implement the write: the
  // tool carries CAS, the L0/L1 gates and the audit entry, and a second copy of
  // those rules would drift.
  check('the route forwards to the tool', /editTree\?:/.test(apiSource), 'ApiOptions has no editTree seam')
  check('and requires a version', /args\.expectedVersion is required/.test(apiSource))
  check('and refuses a non-object args', /args must be an object/.test(apiSource))
  // `resolveProjectRoot` is session-scoped, so the card's own root has to travel
  // with the call or the edit lands on the wrong workspace.
  check('the project root is pinned on the context', /projectRoot: root/.test(readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')))
}

console.log('\n[open] the launch chain, and why it is a chain')

{
  const apiSource = readFileSync(join(here, '..', 'src', 'api.ts'), 'utf8')

  // `windowsHide: true` suppresses the window of the program being spawned. For
  // `explorer.exe` and an editor — both GUI programs — that makes a working
  // action look like it did nothing, which is the regression the folder button
  // hit. Only the GUI spawn site may set it, and it must be false.
  check('the spawn does not hide the window', /windowsHide: false/.test(apiSource), 'windowsHide must stay false for GUI programs')
  // `windowsHide: true` is correct for the console helpers (`reg.exe`,
  // `powershell.exe`) that only print a value. What must never happen is a *GUI*
  // spawn setting it, so the assertion is scoped to that function.
  const spawnCall = apiSource.slice(apiSource.indexOf('function launchViaSpawn'), apiSource.indexOf('export function planFor'))
  check('the GUI spawn exists', spawnCall !== '', 'launchViaSpawn is gone')
  check('and never hides its window', /windowsHide: true/.test(spawnCall) === false, 'a GUI launch must not hide its window')

  // Windows goes through WMI, not spawn: DSH puts children in a Windows Job
  // Object, so a spawned editor is reaped as soon as the launcher exits. Measured
  // on this machine: every spawn variant left zero processes, WMI left eleven.
  check('Windows launches through WMI', /Win32_Process -MethodName Create/.test(apiSource), 'the WMI launcher is gone')
  check('and checks the WMI return code', /ReturnValue/.test(apiSource))
  check('spawn is kept for other platforms', /function launchViaSpawn/.test(apiSource))

  // A single command is not enough: `dsh-better-sidebar` documents (#412) that one
  // Windows route reported `{ started: true }` while nothing opened. The chain is
  // what makes a lying candidate survivable.
  check('a candidate chain exists', /function launchChain/.test(apiSource), 'launchChain is gone')
  check('it tries candidates in order', /for \(const \[index, spec\] of chain\.entries\(\)\)/.test(apiSource))
  check('and reports the aggregate failure', /failures\.join\(' \| '\)/.test(apiSource))

  // Success must not be "spawn fired": a detached child can start and die at once.
  // The rule is "still alive after a grace period, or exited cleanly".
  check('an early non-zero exit counts as failure', /exited with code/.test(apiSource))
  check('a clean exit counts as success', /code === 0 \? \{ ok: true \}/.test(apiSource))
  check('and a surviving process counts as success', /setTimeout\(\(\) => \{/.test(apiSource))
  check('a launch error is still reported', /child\.on\('error'/.test(apiSource))

  // The Windows file chain: editor URL, then the generic handler, then a reader
  // that needs no association at all.
  check('the Windows file chain has a URL route', /vscode:\/\/file\//.test(apiSource), 'the editor URL builder is gone')
  check('a generic handler route', /url\.dll,FileProtocolHandler/.test(apiSource))
  check('and a no-association fallback', /notepad\.exe/.test(apiSource))
  check('the folder action still reveals', /explorer\.exe/.test(apiSource))
}

console.log('\n[feedback] success clears itself, failure does not')

{
  // A success message is transient news; an error has to be read and acted on, so
  // only the success path arms a timer.
  check('a dismissal timer is armed', /setTimeout\(\(\) => \{/.test(source))
  check('it fires after 3 seconds', /3000/.test(source), 'the delay must be 3000ms')
  check(
    'and it removes only the notice entry',
    /entry\.kind !== 'notice'\) return current/.test(source),
    'the timer must not clear an error',
  )
  check('a pending timer is cancelled on unmount', /clearTimeout\(noticeTimer\.current\)/.test(source))
  check(
    'errors go through a separate path with no timer',
    /const showError = useCallback/.test(source) && !/showError = useCallback[^]*?setTimeout/.test(source),
    'an error must not disappear on its own',
  )
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
