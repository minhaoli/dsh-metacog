/**
 * S4 judges a plan step against a slice of the turn, in plan order.
 *
 * The defect this file pins is not "the matcher is too lenient" — it is that
 * every step used to be handed the *whole* turn. When step 3's call also
 * satisfied step 2's expectation, step 2 was marked done, so "the middle step
 * was quietly dropped" could never be detected. The greedy segmentation makes
 * each step claim the shortest run of calls that satisfies it and advance the
 * cursor, which is the finest attribution the collector can honestly support: it
 * records a flat sequence and does not tag calls with the step they belong to.
 *
 * The path half of this file is the other side of the same coin. `pathGlob` used
 * to fail always because `PlanWindow.paths` was hard-wired empty; the collector
 * now captures each call's file-path arguments, so a step can be judged on the
 * call that actually named the file.
 *
 * Run: node test/plan-window-order.test.mjs   (after `npm run build`)
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (path) => pathToFileURL(join(here, '..', 'lib', path)).href

const { segmentPlanWindows, scorePlanMatch } = await import(lib('analysis/signals/plan.js'))
const { tracesFromActivity } = await import(lib('analysis/signals/index.js'))
const { installCollector } = await import(lib('collect.js'))
const { parseConfig } = await import(lib('config.js'))

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

/** One declared step. */
const step = (expects, intent = 'step', optional = false) => ({ intent, expects, optional })
/** One call in the turn. */
const call = (tool, paths = []) => ({ tools: [tool], paths, results: [] })
/** A plan around the given steps. */
const plan = (steps) => ({ id: 'plan_order', goal: 'g', allowedTools: [], steps, declaredAt: '2026-10-01T00:00:00.000Z' })

// ------------------------------------------------------------ in-order turns

console.log('\n[R2] a turn that does everything satisfies every step')

{
  const steps = [step({ tool: 'read' }, '读第一个文件'), step({ tool: 'read' }, '读第二个文件'), step({ tool: 'edit' }, '改代码')]
  const windows = segmentPlanWindows(steps, [call('read'), call('read'), call('edit')])
  const result = scorePlanMatch(plan(steps), windows)

  check('three windows were produced', windows.length === 3, String(windows.length))
  check('every step is complete', result.verdicts.every((verdict) => verdict.complete), JSON.stringify(result.verdicts))
  check('so the plan scores zero drift', result.score.score === 0, String(result.score.score))
}

// -------------------------------------------------------- the skipped middle

console.log('\n[R2] a skipped middle step stays skipped')

{
  // The turn did steps 1 and 3. Step 2 expects `read`, and the turn *does*
  // contain a read — that is exactly why the old whole-turn window marked it
  // complete. The calls are simply already spent by the time step 2 is judged.
  const steps = [step({ tool: 'read' }, '读'), step({ tool: 'read' }, '再读一遍'), step({ tool: 'edit' }, '改')]
  const windows = segmentPlanWindows(steps, [call('read'), call('edit')])
  const result = scorePlanMatch(plan(steps), windows)

  check('step 1 is complete', result.verdicts[0]?.complete === true, JSON.stringify(result.verdicts[0]))
  check(
    'step 2 is NOT complete — the whole point of the change',
    result.verdicts[1]?.complete === false,
    JSON.stringify(result.verdicts[1]),
  )
  check('step 3 is complete', result.verdicts[2]?.complete === true, JSON.stringify(result.verdicts[2]))
  check('one of three is missing', Math.abs(result.score.score - 1 / 3) < 1e-9, String(result.score.score))
  check('and the evidence names the unfinished step', result.score.evidence?.[1]?.startsWith('✗'), String(result.score.evidence?.[1]))
}

// ------------------------------------------------------------- optional steps

console.log('\n[R2] an optional step neither counts nor shifts the indices')

{
  const steps = [
    step({ tool: 'read' }, '读'),
    step({ tool: 'read' }, '可选的再读', true),
    step({ tool: 'edit' }, '改'),
  ]
  const result = scorePlanMatch(plan(steps), segmentPlanWindows(steps, [call('read'), call('edit')]))

  check('the optional step is out of the denominator', result.verdicts.length === 2, String(result.verdicts.length))
  check(
    'the surviving verdicts keep their original indices',
    result.verdicts.map((verdict) => verdict.index).join(',') === '0,2',
    JSON.stringify(result.verdicts.map((verdict) => verdict.index)),
  )
  check('both required steps are complete', result.verdicts.every((verdict) => verdict.complete))
  check('so the plan scores zero', result.score.score === 0, String(result.score.score))
}

// -------------------------------------------------------------------- paths

console.log('\n[R3] pathGlob is judged on the call that named the file')

{
  const steps = [step({ pathGlob: 'src/*.ts' }, '改源码')]

  const hit = scorePlanMatch(plan(steps), segmentPlanWindows(steps, [call('edit', ['src/handlers.ts'])]))
  check('a file in the directory satisfies the step', hit.verdicts[0]?.complete === true, JSON.stringify(hit.verdicts[0]))

  const deep = scorePlanMatch(plan(steps), segmentPlanWindows(steps, [call('edit', ['src/deep/a.ts'])]))
  check('a subdirectory does not — `*` does not cross a separator', deep.verdicts[0]?.complete === false)

  const miss = scorePlanMatch(plan(steps), segmentPlanWindows(steps, [call('edit', ['docs/a.md'])]))
  check('an unrelated path does not', miss.verdicts[0]?.complete === false)

  // A call that named no file must not be read as having touched one.
  const silent = scorePlanMatch(plan(steps), segmentPlanWindows(steps, [call('edit')]))
  check('a call with no path does not satisfy a path step', silent.verdicts[0]?.complete === false)
}

console.log('\n[R3] paths survive the hop from the collector')

{
  const activity = {
    summary: '改了两个文件',
    evidence: ['src/a.ts'],
    grade: 'A',
    sessionId: 'session-plan-order',
    fingerprint: 'turn:session-plan-order:9',
    source: 'turn',
    toolNames: ['edit', 'edit'],
    toolResults: [],
    toolPaths: [['src/a.ts'], ['src/b.ts']],
  }
  const traces = tracesFromActivity(activity)
  check('the first call carries its own path', traces[0]?.paths[0] === 'src/a.ts', JSON.stringify(traces[0]?.paths))
  check('and the second carries a different one', traces[1]?.paths[0] === 'src/b.ts', JSON.stringify(traces[1]?.paths))

  const steps = [step({ pathGlob: 'src/b.ts' }, '改 b')]
  const result = scorePlanMatch(plan(steps), segmentPlanWindows(steps, traces))
  check('a step finds the call that touched its file', result.verdicts[0]?.complete === true, JSON.stringify(result.verdicts[0]))
}

// ------------------------------------------------------- the collector itself

console.log('\n[R3] the collector captures file-path arguments from tool/call')

{
  const listeners = new Map()
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on(name, listener) {
      const bucket = listeners.get(name) ?? []
      bucket.push(listener)
      listeners.set(name, bucket)
      return () => listeners.set(name, (listeners.get(name) ?? []).filter((item) => item !== listener))
    },
  }
  const config = parseConfig({})
  const collected = []
  const { dispose } = installCollector({
    ctx,
    config,
    storeForSession: async () => ({ store: {}, projectId: 'proj-plan-order' }),
    onActivity: async (activity) => {
      collected.push(activity)
    },
  })

  const session = { id: 'session-collector', header: { cwd: '/tmp/plan-order' } }
  const dispatch = (event) => {
    for (const listener of listeners.get('session/event') ?? []) listener(session, event)
  }
  dispatch({
    type: 'tool/call',
    seq: 1,
    data: { turn: 1, step: 1, callId: 'call-1', name: 'edit', arguments: { file_path: 'src/api/handlers.ts' } },
  })
  dispatch({
    type: 'tool/call',
    seq: 2,
    data: { turn: 1, step: 1, callId: 'call-2', name: 'read', arguments: { path: 'docs/readme.md' } },
  })
  dispatch({
    type: 'tool/call',
    seq: 3,
    data: { turn: 1, step: 1, callId: 'call-3', name: 'pwsh', arguments: { command: 'npm test' } },
  })
  dispatch({
    type: 'assistant/message',
    seq: 4,
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '改完了' }] } },
  })
  dispatch({ type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } })

  const deadline = Date.now() + 5000
  while (collected.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  dispose()

  const activity = collected[0]
  check('the turn was collected', activity !== undefined, String(collected.length))
  check('with all three calls', activity?.toolNames?.length === 3, JSON.stringify(activity?.toolNames))
  check(
    'paths are index-aligned with the tool names',
    activity?.toolPaths?.length === activity?.toolNames?.length,
    `${activity?.toolPaths?.length} vs ${activity?.toolNames?.length}`,
  )
  check('the edit call kept its file_path', activity?.toolPaths?.[0]?.includes('src/api/handlers.ts'), JSON.stringify(activity?.toolPaths?.[0]))
  check('the read call kept its path', activity?.toolPaths?.[1]?.includes('docs/readme.md'), JSON.stringify(activity?.toolPaths?.[1]))
  check(
    'a shell call contributes no path rather than a fabricated one',
    Array.isArray(activity?.toolPaths?.[2]) && activity.toolPaths[2].length === 0,
    JSON.stringify(activity?.toolPaths?.[2]),
  )
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
