/**
 * Mutation test: break the implementation on purpose, see whether the suite notices.
 *
 * A test suite that stays green while the code is wrong is worse than no suite,
 * because it manufactures confidence. Reading test files cannot tell you whether
 * they would catch anything — the only way to know is to break the code and look.
 *
 * Every mutant below is a single, plausible mistake: the kind that gets made when
 * editing quickly, not a random character swap. Each one is applied to the
 * COMPILED output, the full suite runs, and the file is restored.
 *
 * A mutant that survives (suite still green) is a real gap and is reported.
 *
 * Run: node scripts/mutation-check.mjs
 */
import { readFileSync, writeFileSync, cpSync, rmSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = process.cwd()
/** Where mutants are compiled. Never lib/, which a concurrent reader may be using. */
const WORK = join(ROOT, '.mutation-work')

/** One deliberate defect in the compiled code. */
const MUTANTS = [
  {
    file: 'lib/data/signals.js',
    name: 'EMA decays to zero on a step with no signal',
    // The invariant the design leans on: a step where nothing could be measured
    // must carry `final` forward. Decaying would let a signal outage erase a
    // drift that is still happening.
    find: `    if (aggregate.riskScore === null)
        return previous;`,
    replace: `    if (aggregate.riskScore === null)
        return beta * previous;`,
  },
  {
    file: 'lib/data/signals.js',
    name: 'dimension score becomes the mean instead of the max',
    find: 'best = best === null ? entry.score : Math.max(best, entry.score);',
    replace: 'best = best === null ? entry.score : (best + entry.score) / 2;',
  },
  {
    file: 'lib/data/signals.js',
    name: 'riskScore normalises by total weight instead of available weight',
    find: 'riskScore = dimensions.reduce((sum, d) => sum + d.weight * d.score, 0) / availableWeight;',
    replace: 'riskScore = dimensions.reduce((sum, d) => sum + d.weight * d.score, 0) / totalWeight;',
  },
  {
    file: 'lib/data/signals.js',
    name: 'the coverage floor check is dropped',
    find: 'if (aggregate.coverage < thresholds.coverageFloor)\n        return 0;',
    replace: 'if (false)\n        return 0;',
  },
  {
    file: 'lib/data/signals.js',
    name: 'an absent signal still contributes its weight to coverage',
    // Reachable, unlike the earlier version of this mutant: every absent signal
    // adds its dimension's weight without a score, so coverage rises while the
    // evidence behind it does not exist.
    find: 'absent.push({ signal: entry.signal, status: entry.reason });',
    replace: 'absent.push({ signal: entry.signal, status: entry.reason }); best = best ?? 0;',
  },
  {
    file: 'lib/analysis/signals/index.js',
    name: 'S3 treats a tool outside the whitelist as fine',
    // The binary decision at the heart of the scope dimension.
    find: "return available('s3_tool_novel', 1,",
    replace: "return available('s3_tool_novel', 0,",
  },
  {
    file: 'lib/analysis/signals/plan.js',
    name: 'an empty expects object counts as satisfied',
    // The rule that stops a plan line with no constraint from clearing the score.
    find: 'if (checks.length === 0) {',
    replace: 'if (false) {',
  },
  {
    file: 'lib/collect.js',
    name: 'the host isError flag is ignored again',
    // Reverting to reading only ok/success, which the host never sends. This is
    // the exact defect that made a failed write satisfy the file-changed check.
    find: "else if (typeof payload.isError === 'boolean')\n        ok = !payload.isError;",
    replace: 'else if (false)\n        ok = null;',
  },
  {
    file: 'lib/analysis/signals/plan.js',
    name: 'S4 loses the original step position',
    // Reintroduces the defect as a one-liner: the map that carries the plan
    // position is replaced by a plain filter, so the following line indexes
    // `windows` by `.indexOf` semantics that no longer exist.
    find: 'const verdicts = required.map(({ step, index }) =>',
    replace: 'const verdicts = required.map(({ step, index }) => evaluateStep(step, windows[required.filter((e) => !e.step.optional).indexOf({ step, index })] ?? { tools: [], paths: [], results: [] }, index)); const __skip = ((step, index) =>',
  },
  {
    file: 'lib/analysis/signals/index.js',
    name: 'a refused write counts as progress again',
    find: "if (trace.results.some((result) => result.ok === false))",
    replace: 'if (false)',
  },
  {
    file: 'lib/data/signals.js',
    name: 'silent steps earn L2 credit again',
    find: "const measurable = aggregate.riskScore !== null && aggregate.coverage >= thresholds.coverageFloor;",
    replace: 'const measurable = true;',
  },
  {
    file: 'lib/gate.js',
    name: 'quiet mode silently drops the hard block',
    find: 'if (quiet.enabled && !quiet.keepHardBlock)',
    replace: 'if (quiet.enabled)',
  },
  {
    file: 'lib/config.js',
    name: 'quiet mode defaults to on',
    find: 'enabled: z.boolean().default(false),\n    /**\n     * Whether Level 3 still blocks',
    replace: 'enabled: z.boolean().default(true),\n    /**\n     * Whether Level 3 still blocks',
  },
  {
    file: 'lib/api.js',
    name: 'the usage route answers with invented token counts',
    find: "tokenUsage: null,",
    replace: "tokenUsage: 12345,",
  },
  {
    file: 'lib/api.js',
    name: 'the purge route accepts any confirmation id',
    find: "if (confirm !== project.projectId) {",
    replace: "if (false) {",
  },
  {
    file: 'lib/analysis/achievements.js',
    name: 'urgency inverts: a distant deadline outranks a near one',
    find: 'return 1 / (1 + daysLeft / 7) + priorityBoost;',
    replace: 'return 1 / (1 + 1 / (daysLeft + 1)) + priorityBoost;',
  },
]

/** Run the full suite; true means it stayed green. */
function suitePasses() {
  // Only the fast suite: enough to catch a behavioural change, and short enough
  // that a dozen mutants finish in one sitting. `--test` targets exactly the files
  // that assert behaviour, not the stage-* integration runs.
  const files = readFileSync(join(ROOT, 'package.json'), 'utf8')
  const script = JSON.parse(files).scripts.test
  const targets = script
    .split('&&')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('node test/'))
    .map((part) => part.replace(/^node /, ''))
  for (const target of targets) {
    try {
      execFileSync(process.execPath, [target], { cwd: ROOT, stdio: 'pipe', timeout: 300_000 })
    } catch {
      return false
    }
  }
  return true
}

console.log('mutation check: break one thing, see whether the suite notices\n')

// Baseline first: a suite that is already red tells us nothing about mutants.
if (!suitePasses()) {
  console.log('BASELINE FAILS — fix the suite before trusting any mutation result')
  process.exit(1)
}
console.log('baseline: green\n')

const survivors = []
for (const mutant of MUTANTS) {
  const path = join(ROOT, mutant.file)
  let original
  try {
    original = readFileSync(path, 'utf8')
  } catch {
    console.log(`SKIP    ${mutant.name}`)
    console.log(`        ${mutant.file} does not exist — the mutant is stale\n`)
    survivors.push({ ...mutant, stale: true })
    continue
  }

  if (!original.includes(mutant.find)) {
    console.log(`SKIP    ${mutant.name}`)
    console.log(`        pattern not found in ${mutant.file} — the mutant is stale, not the code\n`)
    survivors.push({ ...mutant, stale: true })
    continue
  }

  writeFileSync(path, original.replace(mutant.find, mutant.replace), 'utf8')
  let caught
  try {
    caught = !suitePasses()
  } finally {
    writeFileSync(path, original, 'utf8')
  }

  if (caught) {
    console.log(`caught  ${mutant.name}`)
  } else {
    console.log(`SURVIVED  ${mutant.name}  <- no test covers this`)
    survivors.push(mutant)
  }
  console.log('')
}

const real = survivors.filter((s) => !s.stale)
console.log(`mutants: ${MUTANTS.length}, killed: ${MUTANTS.length - survivors.length}, survived: ${real.length}`)
if (real.length > 0) {
  console.log('\ntest gaps, in the order they matter:')
  for (const s of real) console.log(`  - ${s.name}  (${s.file})`)
}
process.exit(real.length === 0 ? 0 : 1)
