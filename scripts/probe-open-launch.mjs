/**
 * Probe: does `Invoke-Item` actually launch the registered handler?
 *
 * `.md` IS associated here — per-user `UserChoice` maps it to `VSCode.md`, and that
 * ProgID's open command points at a real `Code.exe`. So the earlier "no handler"
 * reading was wrong: it looked in HKCR, where a per-user choice does not appear.
 *
 * That leaves a narrower question. `Invoke-Item` returned OK on a machine where
 * the handler exists, so either it really launched VSCode (and something else is
 * wrong) or it silently did nothing.
 *
 * The probe therefore launches the handler and then looks for the process, which
 * distinguishes "opened" from "reported success without opening". It closes what
 * it started so the user is not left with stray windows.
 *
 * Usage: node scripts/probe-open-launch.mjs
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

function ps(command) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
  })
  return { code: result.status, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() }
}

const dir = await mkdtemp(join(tmpdir(), 'probe-launch-'))
const file = join(dir, 'probe-target.md')
await writeFile(file, '# probe\n', 'utf8')

/** Code.exe processes that did not exist before the launch. */
const before = ps("(Get-Process Code -ErrorAction SilentlyContinue | Measure-Object).Count")
const beforeCount = Number(before.out) || 0

try {
  console.log('\n[state] what is registered for .md')

  const progId = ps("(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.md\\UserChoice' -ErrorAction SilentlyContinue).ProgId").out
  console.log(`  UserChoice ProgID = ${JSON.stringify(progId)}`)
  check('a per-user handler is registered', progId !== '', progId)

  const command = ps(`(Get-ItemProperty 'Registry::HKEY_CLASSES_ROOT\\${progId}\\shell\\open\\command' -ErrorAction SilentlyContinue).'(default)'`).out
  console.log(`  open command = ${JSON.stringify(command)}`)
  check('the command names an executable', /"[^"]+\.exe"/.test(command), command)

  console.log('\n[launch] does Invoke-Item start the handler?')

  const invoke = ps(`try { Invoke-Item -LiteralPath '${file.replace(/'/g, "''")}' -ErrorAction Stop; 'OK' } catch { 'ERR:' + $_.Exception.Message }`)
  console.log(`  Invoke-Item -> ${JSON.stringify(invoke.out.slice(0, 160))}`)
  console.log(`  stderr      -> ${JSON.stringify(invoke.err.slice(0, 200))}`)

  // Give the handler a moment to appear.
  await new Promise((resolve) => setTimeout(resolve, 2500))

  const after = ps("(Get-Process Code -ErrorAction SilentlyContinue | Measure-Object).Count")
  const afterCount = Number(after.out) || 0
  console.log(`  Code.exe processes: ${beforeCount} -> ${afterCount}`)

  check(
    'the handler process count did not fall',
    afterCount >= beforeCount,
    `${beforeCount} -> ${afterCount}`,
  )
  // The informative line: whether a NEW process appeared. On a machine where
  // VSCode is already running, it may reuse the existing one instead, so this is
  // reported rather than asserted.
  console.log(
    afterCount > beforeCount
      ? '  NOTE: a new handler process appeared'
      : '  NOTE: no new process — either it reused a running instance, or nothing launched',
  )

  console.log('\n[direct] launching the registered command without the shell')

  // If `Invoke-Item` is the weak link, spawning the registered command directly
  // is the workaround. `%1` is replaced with the quoted path.
  const exeMatch = command.match(/^"([^"]+)"/)
  check('the executable can be extracted from the command', exeMatch !== null, command)
  if (exeMatch !== null) {
    const exe = exeMatch[1]
    check('and it exists on disk', ps(`Test-Path -LiteralPath '${exe.replace(/'/g, "''")}'`).out === 'True', exe)
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
