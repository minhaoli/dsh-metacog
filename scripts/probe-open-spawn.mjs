/**
 * Probe: does `openInShell`'s spawn actually start a process?
 *
 * Two distinct failures have been reported for the same code path:
 *
 * - the file button does nothing;
 * - the folder button, which used to work, stopped working.
 *
 * Both displayed "opened successfully", because the old implementation resolved
 * `{ok: true}` synchronously right after `spawn()` — the `error` event could never
 * fire in time. So the first question is not "did it open" but "did the process
 * start at all, and with which flags".
 *
 * This probe spawns the exact commands the implementation builds, with the same
 * options, and reports the spawn/error outcome. It uses `-WhatIf`-style
 * substitutions where possible so nothing is opened on screen.
 *
 * Usage: node scripts/probe-open-spawn.mjs
 */
import { spawn } from 'node:child_process'

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

/** Run one spawn and report how it settled. */
function probe(label, command, args, options) {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    const finish = (outcome) => {
      if (settled) return
      settled = true
      console.log(
        `  ${label}: ${outcome.kind}${outcome.detail === undefined ? '' : ` (${outcome.detail})`} in ${Date.now() - started}ms`,
      )
      resolve(outcome)
    }
    try {
      const child = spawn(command, args, options)
      child.on('spawn', () => finish({ kind: 'spawned' }))
      child.on('error', (error) => finish({ kind: 'error', detail: String(error) }))
      // A process that exits quickly still counts as spawned; wait a moment so a
      // fast failure is distinguishable from a hang.
      setTimeout(() => finish({ kind: 'still-running' }), 1500)
    } catch (error) {
      finish({ kind: 'threw', detail: String(error) })
    }
  })
}

const target = process.argv[2] ?? process.cwd()
console.log(`\n[probe] target = ${target}\n`)

console.log('[folder] explorer.exe')

{
  // `explorer.exe /select,<path>` opens the parent and highlights the entry, and
  // exits immediately; plain `explorer.exe <path>` opens the folder. Both are GUI.
  const hidden = await probe('explorer, windowsHide=true', 'explorer.exe', ['/select,', target], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  check('explorer starts even with windowsHide', hidden.kind !== 'error' && hidden.kind !== 'threw', JSON.stringify(hidden))

  const shown = await probe('explorer, windowsHide=false', 'explorer.exe', ['/select,', target], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  check('explorer starts with windowsHide=false', shown.kind !== 'error' && shown.kind !== 'threw', JSON.stringify(shown))
}

console.log('\n[file] powershell Invoke-Item')

{
  // `Test-Path` stands in for `Invoke-Item`: it proves the command text and the
  // path quoting survive, without launching an editor.
  const command = `Test-Path -LiteralPath '${target.replace(/'/g, "''")}'`
  const result = await new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    })
    let out = ''
    let err = ''
    child.stdout?.on('data', (chunk) => (out += chunk.toString('utf8')))
    child.stderr?.on('data', (chunk) => (err += chunk.toString('utf8')))
    child.on('error', (error) => resolve({ error: String(error) }))
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }))
  })
  check('powershell runs', result.error === undefined, result.error)
  check('and resolves the path', result.out === 'True', `out=${result.out} err=${result.err.slice(0, 120)}`)
}

console.log('\n[diagnosis] what the old code could not see')

{
  // A spawn of a command that does not exist: the error event fires on the next
  // tick, so a synchronous `resolve({ok:true})` would have reported success.
  const missing = await probe('nonexistent.exe', 'definitely-not-a-real-command-xyz.exe', [], {
    detached: true,
    stdio: 'ignore',
  })
  check('a missing command reports an error, not success', missing.kind === 'error', JSON.stringify(missing))
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
