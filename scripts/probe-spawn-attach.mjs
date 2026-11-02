/**
 * Probe: what keeps a launched GUI process alive from inside DSH?
 *
 * Measured facts so far:
 *   - `Code.exe --version` runs and exits 0;
 *   - running `Code.exe <file>` in the foreground leaves a process running;
 *   - spawning it detached with ignored stdio reports `spawn` and leaves nothing.
 *
 * So the difference is not the executable, it is how the child is attached. This
 * probe tries four attachment styles and reports the process count after each,
 * which is the only observable that separates "opened" from "reported success".
 *
 * Usage: node scripts/probe-spawn-attach.mjs <file>
 */
import { spawn, execFileSync } from 'node:child_process'

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node scripts/probe-spawn-attach.mjs <file>')
  process.exit(2)
}

const EXE = 'D:\\APP\\Microsoft VS Code\\Code.exe'

function codeCount() {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-Process Code -ErrorAction SilentlyContinue | Measure-Object).Count',
    ], { encoding: 'utf8', windowsHide: true })
    return Number(out.trim()) || 0
  } catch {
    return 0
  }
}

/** Launch once with the given options, wait, and report the process delta. */
async function attempt(label, options, holdMs = 4000) {
  const before = codeCount()
  let spawned = false
  let errored
  let exited
  let child
  try {
    child = spawn(EXE, [file], options)
    child.on('spawn', () => (spawned = true))
    child.on('error', (error) => (errored = String(error)))
    child.on('exit', (code) => (exited = code))
    if (options.unref) child.unref()
  } catch (error) {
    errored = String(error)
  }
  await new Promise((resolve) => setTimeout(resolve, holdMs))
  const after = codeCount()
  console.log(
    `  ${label}: spawned=${spawned} exited=${exited ?? '-'} err=${errored ?? 'none'} ${before}->${after} ${after > before ? 'ALIVE' : 'gone'}`,
  )
  // Close what this attempt opened so the next one starts from a clean count.
  if (after > before) {
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Process Code -ErrorAction SilentlyContinue | Stop-Process -Force'], { windowsHide: true })
    } catch {
      // Best effort: a leftover editor is not a probe failure.
    }
    await new Promise((resolve) => setTimeout(resolve, 800))
  }
  return after > before
}

console.log(`\n[baseline] Code.exe = ${codeCount()}`)

console.log('\n[attachment styles]')

await attempt('A detached+ignore+unref', { detached: true, stdio: 'ignore', windowsHide: false, unref: true })
await attempt('B attached+ignore', { detached: false, stdio: 'ignore', windowsHide: false })
await attempt('C attached+pipe', { detached: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false })
await attempt('D attached+inherit', { detached: false, stdio: 'inherit', windowsHide: false })
