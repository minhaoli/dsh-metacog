/**
 * The success flag: reading the host's real field, and keeping its three states.
 *
 * The host reports a tool result as `{ content, isError }` — there is no `ok` and
 * no `success`. `describeToolResult` read only the latter two, so `ok` stayed null
 * on every real result and a failed `edit` was indistinguishable from a successful
 * one. The visible consequence was that S4's `file-changed` assertion was
 * satisfied by a write that never happened: the plan looked complete while the
 * file was untouched.
 *
 * The fix is not `ok = !isError`, and the cases below are what pins that down:
 * `isError: false` means the call ran, not that it achieved anything. A test suite
 * that reports failures has still run.
 *
 * Run: node test/result-flag.test.mjs   (after `npm run build`)
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (p) => pathToFileURL(join(here, '..', 'lib', p)).href

const { describeToolResult } = await import(lib('collect.js'))
const { evaluateStep } = await import(lib('analysis/signals/plan.js'))

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

const text = (s) => [{ type: 'text', text: s }]

console.log('\n[host shape] isError is what the host actually sends')

// The real payload has no ok/success: only this field distinguishes a broken call.
{
  const broken = describeToolResult('edit', { content: text('Error: old_string not found'), isError: true })
  check('a failed call reports ok:false', broken?.ok === false, String(broken?.ok))

  const worked = describeToolResult('edit', { content: text('File edited'), isError: false })
  check('a completed call reports ok:true', worked?.ok === true, String(worked?.ok))
}

console.log('\n[not the inverse] a completed call that reports failure is still ok:true')

// This is the case that rules out `ok = !isError`: pytest exits non-zero, the host
// records isError:false because the tool itself did not break, and the outcome word
// list is what says the tests failed.
{
  const testRun = describeToolResult('pwsh', { content: text('3 failed, 7 passed in 2.1s'), isError: false })
  check('ok stays true because the command ran', testRun?.ok === true, String(testRun?.ok))
  check('and the outcome records the failure', testRun?.outcome === 'tests-fail', String(testRun?.outcome))
}

console.log('\n[tri-state] silence is not success')

{
  const silent = describeToolResult('edit', { content: text('something happened') })
  check('with no flag at all, ok is null', silent?.ok === null, String(silent?.ok))
}

console.log('\n[error field] an error entry means the call failed')

{
  const withError = describeToolResult('pwsh', { content: text('boom'), error: { message: 'boom' } })
  check('ok is false', withError?.ok === false, String(withError?.ok))
}

console.log('\n[plan] file-changed is not satisfied by a failed write')

{
  const step = { intent: '改文件', expects: { assert: 'file-changed' } }
  const window = (results) => ({ tools: ['edit'], paths: [], results })

  const broke = evaluateStep(
    step,
    window([{ tool: 'edit', ok: false, excerpt: 'Error: old_string not found', outcome: null }]),
    0,
  )
  check('a failed write does not complete the step', broke.complete === false, JSON.stringify(broke))

  const wrote = evaluateStep(step, window([{ tool: 'edit', ok: true, excerpt: 'File edited', outcome: null }]), 0)
  check('a successful write completes it', wrote.complete === true, JSON.stringify(wrote))

  // Deliberate: records written before this fix carry ok:null, and treating those
  // as failures would retroactively fail every historical plan step. Keeping them
  // as "not disproven" is the conservative reading.
  const historical = evaluateStep(step, window([{ tool: 'edit', ok: null, excerpt: 'Edited', outcome: null }]), 0)
  check('a record with no flag is not retroactively failed', historical.complete === true, JSON.stringify(historical))
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
