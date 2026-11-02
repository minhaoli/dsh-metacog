/**
 * Probe: does the rebuilt `openInShell` really launch the handler?
 *
 * The previous version called `Invoke-Item`, which returned success while nothing
 * started. The replacement resolves the association itself and spawns the named
 * executable. This probe calls the built module and then looks for the process, so
 * "reported success" and "actually opened" are separated.
 *
 * Usage: node scripts/probe-open-real.mjs <file-or-folder>
 */
import { spawnSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const { openInShell: openPath } = await import(pathToFileURL(join(here, '..', 'lib', 'api.js')).href)

function ps(command) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
  })
  return (result.stdout ?? '').trim()
}

const target = process.argv[2]
if (target === undefined) {
  console.error('usage: node scripts/probe-open-real.mjs <file-or-folder>')
  process.exit(2)
}

console.log(`\n[target] ${target}`)
console.log(`  exists: ${ps(`Test-Path -LiteralPath '${target.replace(/'/g, "''")}'`)}`)

const before = Number(ps('(Get-Process Code -ErrorAction SilentlyContinue | Measure-Object).Count')) || 0
console.log(`  Code.exe before: ${before}`)

const outcome = await openPath(target, 'file')
console.log(`\n[result] ${JSON.stringify(outcome)}`)

await new Promise((resolve) => setTimeout(resolve, 3000))
const after = Number(ps('(Get-Process Code -ErrorAction SilentlyContinue | Measure-Object).Count')) || 0
console.log(`  Code.exe after: ${after}`)

if (outcome.ok && after > before) {
  console.log('\n  VERDICT: opened (a handler process appeared)')
  process.exit(0)
}
if (outcome.ok && after === before) {
  console.log('\n  VERDICT: reported success but no process appeared — still broken')
  process.exit(1)
}
console.log('\n  VERDICT: reported failure')
process.exit(1)
