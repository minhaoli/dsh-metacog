/**
 * Probe: which of the three Windows candidates actually opens a file?
 *
 * Measured: the built chain reports `ok` for a file that was never open, and no
 * editor window changes. So the chain is reporting success without opening — the
 * exact failure `dsh-better-sidebar` documents as #412.
 *
 * This probe runs each candidate by hand, one at a time, and reads the window
 * title after each. The title is the only honest observable: a process that
 * starts and exits proves nothing.
 *
 * Usage: node scripts/probe-open-each.mjs <file>
 */
import { spawn, execFileSync } from 'node:child_process'

const target = process.argv[2]
if (target === undefined) {
  console.error('usage: node scripts/probe-open-each.mjs <file>')
  process.exit(2)
}

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

function titles() {
  return ps("Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object { $_.MainWindowTitle }")
}

/** Run one command and report whether the editor window list changed. */
async function attempt(label, run, args) {
  const before = titles()
  let code = 'n/a'
  let err = ''
  try {
    const child = spawn(run, args, { detached: false, stdio: 'ignore', windowsHide: false })
    await new Promise((resolve) => {
      child.on('exit', (value) => {
        code = value
        resolve()
      })
      child.on('error', (error) => {
        err = String(error)
        resolve()
      })
      setTimeout(resolve, 6000)
    })
  } catch (error) {
    err = String(error)
  }
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const after = titles()
  const opened = after !== before
  console.log(`  ${label}: exit=${code}${err === '' ? '' : ` err=${err.slice(0, 80)}`} -> ${opened ? 'OPENED' : 'no change'}`)
  if (opened) console.log(`      titles now: ${after.split('\n').join(' | ')}`)
  return opened
}

const url = `vscode://file/${target.replace(/\\/g, '/').replace(/\/{2,}/g, '/')}`

console.log(`\n[target] ${target}`)
console.log(`[url]    ${url}`)
console.log(`[before] ${titles().split('\n').join(' | ') || '(none)'}`)

console.log('\n[candidates]')

await attempt('1 cmd /d /c start "" <url>', 'cmd.exe', ['/d', '/c', 'start', '', url])
await attempt('2 rundll32 FileProtocolHandler <path>', 'rundll32.exe', ['url.dll,FileProtocolHandler', target])
await attempt('3 notepad <path>', 'notepad.exe', [target])

console.log('\n[direct] the editor executable with the file argument')
const exe = 'D:\\APP\\Microsoft VS Code\\Code.exe'
await attempt('4 Code.exe <path>', exe, [target])
await attempt('5 Code.exe --reuse-window <path>', exe, ['--reuse-window', target])
