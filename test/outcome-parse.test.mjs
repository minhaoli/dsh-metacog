/**
 * Reading a tool result: what the output says about a checkable outcome.
 *
 * This is what S5 rests on, and it is entirely a text-parsing problem against
 * output formats that were never designed to be parsed. So the cases here are
 * real strings that real toolchains print, not invented ones — `pytest`'s counts
 * line, `tsc`'s error code, npm's exit banner.
 *
 * Run: node test/outcome-parse.test.mjs   (after `npm run build`)
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { describeToolResult } = await import(pathToFileURL(join(here, '..', 'lib', 'collect.js')).href)

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

const outcome = (text) => describeToolResult('pwsh', { name: 'pwsh', content: [{ type: 'text', text }] })?.outcome ?? null
const is = (text, expected) => check(`${JSON.stringify(text)} -> ${expected}`, outcome(text) === expected, `got ${outcome(text)}`)

console.log('\n[tests] pytest counts lines')

is('8 passed in 1.2s', 'tests-pass')
is('3 passed', 'tests-pass')
is('2 failed', 'tests-fail')
is('37 failed', 'tests-fail')
is('1 failed, 7 passed in 2.3s', 'tests-fail')
is('0 failed, 12 passed', 'tests-fail')

console.log('\n[tests] a failure anywhere wins over passes')

is('FAILED tests/test_x.py::test_a - assert 1 == 2', 'tests-fail')
is('AssertionError: expected 1 got 2', 'tests-fail')
is('测试失败', 'tests-fail')
is('全部通过', 'tests-pass')

console.log('\n[build] build failures are not reported as test failures')

// "compilation failed" contains "failed", and an earlier version classified it as
// a test failure because the test markers were checked first. The build is the
// outer operation: when it fails, no test ran.
is('compilation failed', 'build-fail')
is('error TS2304: Cannot find name', 'build-fail')
is('error ts','build-fail')
is('0 errors, build succeeded', 'build-pass')
is('compiled successfully', 'build-pass')

console.log('\n[unknown] silence is not a pass')

is('File edited', null)
is('npm ERR! code ELIFECYCLE', null)
is('', null)

console.log('\n[shape] nothing to read means no record')

{
  const nothing = describeToolResult('pwsh', { name: 'pwsh' })
  check('an empty payload with no flag yields undefined, not a zero score', nothing === undefined)
  const flagOnly = describeToolResult('pwsh', { name: 'pwsh', ok: false })
  check('a bare flag yields a record with a null outcome', flagOnly !== undefined && flagOnly.outcome === null)
  check('and the flag itself is kept', flagOnly.ok === false)
}

console.log('\n[nested] content blocks and plain strings both read')

{
  const blocks = describeToolResult('pwsh', { content: [{ type: 'text', text: '5 passed' }] })
  check('a content block array is read', blocks?.outcome === 'tests-pass')
  const plain = describeToolResult('pwsh', { content: '5 passed' })
  check('a plain string is read', plain?.outcome === 'tests-pass')
  const output = describeToolResult('pwsh', { output: '5 passed' })
  check('an output field is read', output?.outcome === 'tests-pass')
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
