/**
 * Check that the compiled output actually matches the source.
 *
 * `npm run build` has repeatedly reported success while not emitting — sometimes one
 * file, sometimes several. The failure is silent: tsc exits 0, the file keeps its old
 * mtime, and every test then runs against stale code. That produced at least five
 * false conclusions during this project, including one where a fix looked like it had
 * no effect for the same reason.
 *
 * This compares each `lib/**.js` against its `src/**.ts` by mtime and reports any
 * source newer than its output. It is a cheap guard, not a compiler.
 *
 * Run: node scripts/check-build-freshness.mjs   (after `npm run build`)
 */
import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

const ROOT = process.cwd()

/** Every `.ts` under src, as a path relative to the project root. */
async function listSources(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listSources(full)))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/** mtime in ms, or `undefined` when the path does not exist. */
async function mtime(path) {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return undefined
  }
}

const sources = await listSources(join(ROOT, 'src'))
const stale = []
const missing = []

for (const source of sources) {
  const rel = relative(join(ROOT, 'src'), source)
  const output = join(ROOT, 'lib', rel.replace(/\.ts$/, '.js'))
  const [srcTime, outTime] = await Promise.all([mtime(source), mtime(output)])

  if (outTime === undefined) {
    missing.push(relative(ROOT, output))
    continue
  }
  if (srcTime !== undefined && srcTime > outTime + 1) {
    stale.push({ source: relative(ROOT, source), output: relative(ROOT, output) })
  }
}

console.log('build freshness')
console.log(`  sources : ${sources.length}`)

if (missing.length === 0 && stale.length === 0) {
  console.log('  outputs : all present and newer than their sources')
  process.exit(0)
}

if (missing.length > 0) {
  console.log(`\n  ${missing.length} source file(s) produced no output:`)
  for (const path of missing) console.log(`    ${path}`)
}

if (stale.length > 0) {
  console.log(`\n  ${stale.length} output(s) older than their source:`)
  for (const entry of stale) console.log(`    ${entry.output}  <-  ${entry.source}`)
}

console.log('\nRun `npm run build` again. If these persist, tsc is skipping them:')
console.log('delete the specific lib file and rebuild, which is what has fixed it before.')
process.exit(1)
