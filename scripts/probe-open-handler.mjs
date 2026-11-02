/**
 * Probe: what happens when the target file has no default handler?
 *
 * The user reported that "open folder" works and "open file" does not, while both
 * report success. The file path is correct and the process spawns, so the failure
 * has to be inside the shell association. On this machine `.md` has no registered
 * handler at all — `Invoke-Item` then fails without opening anything.
 *
 * This probe answers three questions:
 *   1. does `.md` have a handler here?
 *   2. does `Invoke-Item` throw, or fail silently?
 *   3. is there a fallback that always works (Notepad)?
 *
 * Usage: node scripts/probe-open-handler.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

/** Run a PowerShell snippet, returning stdout/stderr/exit code. */
function ps(command) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8' },
  )
  return { code: result.status, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() }
}

const dir = await mkdtemp(join(tmpdir(), 'probe-handler-'))
const file = join(dir, 'sample.md')
await writeFile(file, '# hello\n', 'utf8')

try {
  console.log('\n[association] is there a handler for .md?')

  const assoc = ps("(Get-ItemProperty 'Registry::HKEY_CLASSES_ROOT\\.md' -ErrorAction SilentlyContinue).'(default)'")
  const progId = assoc.out
  console.log(`  .md ProgID = ${JSON.stringify(progId)}`)

  if (progId === '') {
    check('no ProgID is registered for .md on this machine', true)
  } else {
    const cmd = ps(`(Get-ItemProperty 'Registry::HKEY_CLASSES_ROOT\\${progId}\\shell\\open\\command' -ErrorAction SilentlyContinue).'(default)'`)
    console.log(`  open command = ${JSON.stringify(cmd.out)}`)
    check('a ProgID exists and names a command', cmd.out !== '')
  }

  console.log('\n[behaviour] does Invoke-Item report the failure?')

  // `-ErrorAction Stop` turns a non-terminating error into a catchable one. If the
  // association is missing, this is where it surfaces.
  const invoke = ps(
    `try { Invoke-Item -LiteralPath '${file.replace(/'/g, "''")}' -ErrorAction Stop; 'OK' } catch { 'ERR:' + $_.Exception.Message }`,
  )
  console.log(`  Invoke-Item -> ${JSON.stringify(invoke.out.slice(0, 160))}`)
  console.log(`  stderr      -> ${JSON.stringify(invoke.err.slice(0, 160))}`)

  if (progId === '') {
    check(
      'with no handler, Invoke-Item either errors or silently does nothing',
      invoke.out.startsWith('ERR:') || invoke.out === 'OK',
      invoke.out.slice(0, 120),
    )
  }

  console.log('\n[fallback] a guaranteed way to open a text file')

  // Notepad is present on every Windows install and takes the path as one argv
  // entry, so it cannot be defeated by quoting.
  const notepad = spawnSync('where.exe', ['notepad.exe'], { encoding: 'utf8' })
  check('notepad.exe is on PATH', notepad.status === 0, (notepad.stdout ?? '').trim())

  // Not launched: only its existence and resolvability are asserted, so the probe
  // does not open a window on the user's screen.
  const resolved = (notepad.stdout ?? '').trim().split(/\r?\n/)[0]
  check('and resolves to an absolute path', resolved !== undefined && resolved.endsWith('notepad.exe'), resolved)
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
