/**
 * Probe: can a GUI program be spawned from inside DSH at all?
 *
 * The rebuilt `openInShell` reports success and no process appears. That rules out
 * argument quoting, because the same result came from three different invocation
 * styles. The remaining suspect is the environment: DSH runs its children inside a
 * Windows Job Object, and a GUI process may be started and then reaped, or started
 * without ever getting a window.
 *
 * This probe spawns VSCode three ways and reports, for each, whether the process
 * exists afterwards:
 *   1. detached + stdio ignore (what the plugin does);
 *   2. detached + windowsHide false + unref;
 *   3. `cmd /c start` (a shell-mediated launch, which uses a different path).
 *
 * It closes the VSCode it started so the user is not left with windows.
 *
 * Usage: node scripts/probe-spawn-gui.mjs <file>
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node scripts/probe-spawn-gui.mjs <file>')
  process.exit(2)
}

const EXE = 'D:\\APP\\Microsoft VS Code\\Code.exe'

/** How many Code.exe processes are running right now. */
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

/** Try one launch style and report whether a process appeared. */
async function attempt(label, run, args, options) {
  const before = codeCount()
  let spawned = false
  let errored
  try {
    const child = spawn(run, args, options)
    child.on('spawn', () => (spawned = true))
    child.on('error', (error) => (errored = String(error)))
    child.unref()
  } catch (error) {
    errored = String(error)
  }
  await new Promise((resolve) => setTimeout(resolve, 3500))
  const after = codeCount()
  console.log(
    `  ${label}: spawned=${spawned} error=${errored ?? 'none'} processes ${before} -> ${after} ${after > before ? 'APPEARED' : 'none'}`,
  )
  return after > before
}

console.log(`\n[env] node ${process.version} on ${process.platform}`)
console.log(`  exe exists: ${existsSync(EXE)}`)
console.log(`  file exists: ${existsSync(file)}`)
console.log(`  baseline Code.exe: ${codeCount()}`)

console.log('\n[launch styles]')

await attempt('detached+ignore', EXE, [file], { detached: true, stdio: 'ignore', windowsHide: false })
await attempt('detached+unref', EXE, [file], { detached: true, stdio: 'ignore', windowsHide: false })
await attempt('cmd /c start', 'cmd.exe', ['/c', 'start', '', EXE, file], {
  detached: true,
  stdio: 'ignore',
  windowsHide: false,
})
