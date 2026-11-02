/**
 * S4 matching semantics: globs, expectations, and what "complete" means.
 *
 * The glob rules are the part most likely to be wrong in a way that only shows up
 * in production, so they are tested against the cases the design doc actually
 * specifies: `*` not crossing a directory, `**` crossing, and Windows being
 * case-insensitive.
 *
 * Run: node test/plan-match.test.mjs   (after `npm run build`)
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'lib', 'analysis', 'signals', 'plan.js')).href)
const { globToRegExp, evaluateStep, scorePlanMatch } = mod

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

const win = (tools, paths = [], results = []) => ({ tools, paths, results })
const step = (expects, intent = 'x', optional = false) => ({ intent, expects, optional })

console.log('\n[glob] `*` does not cross a directory')

{
  const re = globToRegExp('src/*.ts')
  check('matches a file directly inside src', re.test('src/main.ts'))
  check('does not match a nested file', !re.test('src/deep/main.ts'))
  check('does not match a sibling directory', !re.test('other/src/main.ts'))
}

console.log('\n[glob] `**` crosses directories')

{
  const re = globToRegExp('src/**/*.ts')
  check('matches one level deep', re.test('src/a/b.ts'))
  check('matches two levels deep', re.test('src/a/b/c.ts'))
  check('still rejects an unrelated root', !re.test('lib/a/b.ts'))
}

console.log('\n[glob] Windows separators and case')

{
  const re = globToRegExp('src/*.ts')
  const backslash = 'src\\main.ts'.replace(/\\/g, '/')
  check('a backslash path is normalised before matching', re.test(backslash))
  if (process.platform === 'win32') {
    check('matching is case-insensitive on Windows', re.test('SRC/Main.TS'))
  } else {
    check('matching is case-sensitive elsewhere', !re.test('SRC/Main.TS'))
  }
}

console.log('\n[glob] special characters are escaped')

{
  const re = globToRegExp('a.b/c+d.ts')
  check('a dot is literal, not "any character"', re.test('a.b/c+d.ts') && !re.test('axb/c+d.ts'))
}

console.log('\n[step] every supplied expectation must hold')

{
  const toolsAndPath = step({ tool: 'edit', pathGlob: 'src/*.ts' })
  check(
    'complete when both hold',
    evaluateStep(toolsAndPath, win(['edit'], ['src/x.ts']), 0).complete,
  )
  check(
    'not complete when the tool ran but the path did not match',
    !evaluateStep(toolsAndPath, win(['edit'], ['docs/x.md']), 0).complete,
  )
  check(
    'not complete when the path matched but the tool did not run',
    !evaluateStep(toolsAndPath, win(['read'], ['src/x.ts']), 0).complete,
  )
}

console.log('\n[step] an empty expects object is never complete')

{
  const empty = step({})
  check('empty expects does not count as done', !evaluateStep(empty, win(['edit'], ['src/x.ts']), 0).complete)
  check('and the reason says so', evaluateStep(empty, win([], []), 0).because.includes('expects 为空'))
}

console.log('\n[step] assert needs a result that says so')

{
  const asserts = step({ assert: 'tests-pass' })
  check('complete when a passing test result is present', evaluateStep(asserts, win(['pwsh'], [], [{ tool: 'pwsh', ok: true, excerpt: 'ok', outcome: 'tests-pass' }]), 0).complete)
  check('not complete when the test failed', !evaluateStep(asserts, win(['pwsh'], [], [{ tool: 'pwsh', ok: false, excerpt: 'x', outcome: 'tests-fail' }]), 0).complete)
  check('not complete when no result was recorded', !evaluateStep(asserts, win(['pwsh'], [], []), 0).complete)
}

console.log('\n[step] file-changed needs a write, and a failed write does not count')

{
  const changed = step({ assert: 'file-changed' })
  check('complete when a write tool ran', evaluateStep(changed, win(['edit'], [], []), 0).complete)
  check('not complete when only reads ran', !evaluateStep(changed, win(['read'], [], []), 0).complete)
  check(
    'not complete when the write reported an error',
    !evaluateStep(changed, win(['edit'], [], [{ tool: 'edit', ok: false, excerpt: 'denied', outcome: null }]), 0).complete,
  )
}

console.log('\n[score] 1 - completed / required')

{
  const plan = {
    id: 'p',
    goal: 'g',
    allowedTools: [],
    declaredAt: '2026-01-01T00:00:00Z',
    steps: [step({ tool: 'edit' }, 'first'), step({ tool: 'pwsh' }, 'second')],
  }
  const windows = [win(['edit']), win(['pwsh'])]
  const r = scorePlanMatch(plan, windows)
  check('both done scores 0', r.score.status === 'available' && r.score.score === 0, JSON.stringify(r.score))

  const half = scorePlanMatch(plan, [win(['edit']), win(['read'])])
  check('half done scores 0.5', Math.abs(half.score.score - 0.5) < 1e-9, String(half.score.score))

  const none = scorePlanMatch(plan, [win([]), win([])])
  check('nothing done scores 1', none.score.score === 1)
}

console.log('\n[score] optional steps are excluded from the denominator')

{
  const plan = {
    id: 'p',
    goal: 'g',
    allowedTools: [],
    declaredAt: '2026-01-01T00:00:00Z',
    steps: [step({ tool: 'edit' }, 'required'), step({ tool: 'pwsh' }, 'nice to have', true)],
  }
  const r = scorePlanMatch(plan, [win(['edit']), win([])])
  check('skipping an optional step does not raise the score', r.score.score === 0, String(r.score.score))
  check('and only the required step appears in the verdicts', r.verdicts.length === 1)
}

console.log('\n[score] absences')

check('no plan is an absence', scorePlanMatch(undefined, []).score.status === 'not_applicable')
check('a plan with no required steps is an absence', scorePlanMatch({ id: 'p', goal: 'g', allowedTools: [], declaredAt: '2026-01-01T00:00:00Z', steps: [step({ tool: 'edit' }, 'x', true)] }, []).score.status === 'not_applicable')

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
