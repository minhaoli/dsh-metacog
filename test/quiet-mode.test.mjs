/**
 * Silent mode: record everything, interrupt about nothing.
 *
 * The properties worth pinning are about what quiet mode must *not* change. It is
 * tempting to implement "silent" as "turn the monitor down", and that version is
 * wrong in a way that only shows up months later: the history stops accumulating,
 * and with it the only evidence that could ever validate the thresholds.
 *
 * So the assertions here are mostly negative — collection still runs, scores are
 * still written, the tree is still read — and only the user-facing surfaces go
 * quiet.
 *
 * Run: node test/quiet-mode.test.mjs   (after `npm run build`)
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (p) => pathToFileURL(join(here, '..', 'lib', p)).href

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

console.log('\n[defaults] quiet mode is off, and protection stays on when it is enabled')

{
  const base = parseConfig({})
  check('quiet mode is off by default', base.quiet.enabled === false)
  check('the hard block survives quiet mode by default', base.quiet.keepHardBlock === true)
  check('the prompt block is kept by default', base.quiet.suppressPromptBlock === false)
}

{
  // Enabling quiet must not require opting into the other two: the safe combination
  // has to be reachable with one flag.
  const enabled = parseConfig({ quiet: { enabled: true } })
  check('enabling quiet alone keeps the hard block', enabled.quiet.keepHardBlock === true)
  check('and keeps the prompt block', enabled.quiet.suppressPromptBlock === false)
  check('collection stays on regardless', enabled.collection.enabled === true)
}

console.log('\n[collection] quiet mode does not touch the collector')

{
  const quiet = parseConfig({ quiet: { enabled: true } })
  const loud = parseConfig({})
  check('collection config is identical', JSON.stringify(quiet.collection) === JSON.stringify(loud.collection))
  check('signal thresholds are identical', JSON.stringify(quiet.signals) === JSON.stringify(loud.signals))
  check('schedule config is identical', JSON.stringify(quiet.schedule) === JSON.stringify(loud.schedule))
  check('drift thresholds are identical', JSON.stringify(quiet.thresholds) === JSON.stringify(loud.thresholds))
}

console.log('\n[gate] the hard block is the one thing quiet leaves alone by default')

{
  const { evaluateCall } = await import(lib('gate.js'))

  // A store with a pending Level 3 card.
  const store = {
    async readInterventions() {
      return [{ id: 'iv_1', level: 3, status: 'pending' }]
    },
  }
  const ctx = { logger: { info() {}, warn() {}, error() {}, debug() {} } }
  const host = { ctx, storeForSession: async () => ({ store, projectId: 'p' }) }
  const call = { name: 'pwsh', agent: { id: 'a', session: { id: 's' } } }

  const quietDefault = parseConfig({ quiet: { enabled: true }, gate: { level3HardBlock: true } })
  const withDefault = await evaluateCall(call, { ...host, config: quietDefault })
  check(
    'quiet mode still blocks when keepHardBlock is left on',
    withDefault.decision.kind === 'deny',
    JSON.stringify(withDefault.decision),
  )

  const quietNoBlock = parseConfig({
    quiet: { enabled: true, keepHardBlock: false },
    gate: { level3HardBlock: true },
  })
  const withoutBlock = await evaluateCall(call, { ...host, config: quietNoBlock })
  check(
    'turning it off explicitly does allow the call',
    withoutBlock.decision.kind === 'allow',
    JSON.stringify(withoutBlock.decision),
  )

  const loud = parseConfig({ gate: { level3HardBlock: true } })
  const loudResult = await evaluateCall(call, { ...host, config: loud })
  check('and ordinary mode blocks as it always did', loudResult.decision.kind === 'deny')
}

console.log('\n[tolerance] a config without the quiet section still works')

{
  // A profile written before this section existed, or a test that builds a minimal
  // config, must not crash the one path that stops an irreversible action.
  const { evaluateCall } = await import(lib('gate.js'))
  const store = {
    async readInterventions() {
      return [{ id: 'iv_1', level: 3, status: 'pending' }]
    },
  }
  const minimal = { gate: { level3HardBlock: true, neverBlocked: [] } }
  const result = await evaluateCall(
    { name: 'pwsh', agent: { id: 'a', session: { id: 's' } } },
    {
      ctx: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
      config: minimal,
      storeForSession: async () => ({ store, projectId: 'p' }),
    },
  )
  check('a missing quiet section defaults to blocking', result.decision.kind === 'deny', JSON.stringify(result.decision))
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
