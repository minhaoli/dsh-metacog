/**
 * Probe: does the Windows "open file" invocation actually resolve the path?
 *
 * `openInShell` builds a `powershell.exe -Command "Invoke-Item -LiteralPath '…'"`
 * call. Getting the quoting wrong is invisible until a user clicks the button and
 * Windows says "cannot find the file", which is exactly what happened once.
 *
 * This probe runs the same command with `Test-Path` in place of `Invoke-Item`: it
 * proves the path survives the quoting without opening an editor on the user's
 * screen. A path with CJK characters and spaces is the case that broke.
 *
 * Usage: node scripts/probe-open-path.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The exact command text `openInShell` builds. */
function commandFor(target) {
  return `Invoke-Item -LiteralPath '${target.replace(/'/g, "''")}'`
}

/** Run the same quoting, but ask whether the path exists instead of opening it. */
function resolves(target) {
  const command = commandFor(target).replace('Invoke-Item', 'Test-Path')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
  })
  return { status: result.status, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() }
}

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

const base = await mkdtemp(join(tmpdir(), 'probe open 中文 '))
try {
  const dir = join(base, '日报', '2026_10')
  await mkdir(dir, { recursive: true })
  const file = join(dir, '2026-10-30.md')
  await writeFile(file, '# x\n', 'utf8')

  console.log('\n[quoting] the path survives the PowerShell command text')

  const plain = resolves(base)
  check('a plain path resolves', plain.out === 'True', `${plain.out} ${plain.err.slice(0, 120)}`)

  const spaced = resolves(dir)
  check('a path with spaces resolves', spaced.out === 'True', `${spaced.out} ${spaced.err.slice(0, 120)}`)

  const cjk = resolves(file)
  check('a CJK path resolves', cjk.out === 'True', `${cjk.out} ${cjk.err.slice(0, 120)}`)

  // A quote in a filename is legal on Windows-adjacent filesystems and would end
  // the string literal early if it were not doubled.
  const quoted = join(base, "it's here.md")
  await writeFile(quoted, '# y\n', 'utf8')
  const tricky = resolves(quoted)
  check('a path containing a single quote resolves', tricky.out === 'True', `${tricky.out} ${tricky.err.slice(0, 120)}`)

  console.log('\n[regression] the broken form must not come back')

  // The first implementation passed the path as a separate argv entry after
  // `-Command`; PowerShell treated it as source and the path never arrived.
  const broken = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output $args[0]', file],
    { encoding: 'utf8' },
  )
  check(
    'the old separate-argument form does not deliver the path',
    (broken.stdout ?? '').trim() !== file,
    (broken.stdout ?? '').trim().slice(0, 80),
  )
} finally {
  await rm(base, { recursive: true, force: true })
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
