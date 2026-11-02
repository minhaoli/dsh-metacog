/**
 * Probe: does the plugin's exact candidate chain open the file?
 *
 * The user reports "shows success, nothing opens" while this machine demonstrably
 * has `2026-10-30.md` open in VSCode. The gap between those two facts is *which*
 * candidate actually ran, and that is invisible from the card.
 *
 * This probe runs the built `openInShell` and then reports the window title, so
 * "opened" is verified by what the OS shows rather than by a promise resolving.
 *
 * Usage: node scripts/probe-open-verify.mjs <file>
 */
import { execFileSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const { openInShell, planFor } = await import(pathToFileURL(join(here, '..', 'lib', 'api.js')).href)

function ps(command) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim()
  } catch {
    return ''
  }
}

/** Window titles of running editors, one per line. */
function titles() {
  return ps("Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object { $_.MainWindowTitle }")
}

const target = process.argv[2]
if (target === undefined) {
  console.error('usage: node scripts/probe-open-verify.mjs <file>')
  process.exit(2)
}

console.log(`\n[plan] candidates for ${target}`)
for (const [index, spec] of planFor(target, 'file').entries()) {
  console.log(`  ${index + 1}. ${spec.run} ${spec.args.map((a) => (a.length > 60 ? `${a.slice(0, 60)}…` : a)).join(' ')}`)
}

const before = titles()
console.log(`\n[before] ${before === '' ? '(no editor windows)' : before.split('\n').join(' | ')}`)

const outcome = await openInShell(target, 'file')
console.log(`\n[result] ${JSON.stringify(outcome)}`)

await new Promise((resolve) => setTimeout(resolve, 4000))
const after = titles()
console.log(`[after]  ${after === '' ? '(no editor windows)' : after.split('\n').join(' | ')}`)

const changed = after !== before
console.log(`\n  VERDICT: ${changed ? 'window list changed' : 'window list unchanged'}`)
if (!outcome.ok) console.log('  (and the call itself reported failure)')
