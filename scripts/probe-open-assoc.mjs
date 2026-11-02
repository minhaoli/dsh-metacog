/**
 * Probe: can the registered handler be launched directly, bypassing Invoke-Item?
 *
 * `Invoke-Item` returns OK on this machine while no handler process appears, so it
 * cannot be trusted as the way to open a file. The alternative is to read the
 * association ourselves and spawn the command it names.
 *
 * This probe performs that lookup and launches nothing; it only proves the lookup
 * is reliable enough to build a launcher on.
 *
 * Usage: node scripts/probe-open-assoc.mjs
 */
import { spawnSync } from 'node:child_process'

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
  return (result.stdout ?? '').trim()
}

/**
 * Resolve the executable and argument template for one extension.
 *
 * Two levels have to be walked: the per-user `UserChoice` ProgID, then that
 * ProgID's `shell\open\command`. HKCR alone is not enough — a per-user choice
 * does not appear there, which is why an earlier probe wrongly concluded that
 * `.md` had no handler at all.
 */
function resolveHandler(extension) {
  const progId = ps(
    `(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${extension}\\UserChoice' -ErrorAction SilentlyContinue).ProgId`,
  )
  if (progId === '') return undefined
  const command = ps(
    `(Get-ItemProperty 'Registry::HKEY_CLASSES_ROOT\\${progId}\\shell\\open\\command' -ErrorAction SilentlyContinue).'(default)'`,
  )
  if (command === '') return undefined
  const match = command.match(/^"([^"]+)"\s*(.*)$/)
  if (match === null) return undefined
  return { progId, exe: match[1], args: match[2] }
}

console.log('\n[resolve] read the association the way Explorer does')

{
  const md = resolveHandler('.md')
  check('a handler is resolved for .md', md !== undefined, JSON.stringify(md))
  if (md !== undefined) {
    console.log(`  progId = ${md.progId}`)
    console.log(`  exe    = ${md.exe}`)
    console.log(`  args   = ${JSON.stringify(md.args)}`)
    check('the exe exists', ps(`Test-Path -LiteralPath '${md.exe.replace(/'/g, "''")}'`) === 'True', md.exe)
    // `%1` is the placeholder Explorer replaces with the file path.
    check('the argument template carries a %1 placeholder', md.args.includes('%1'), md.args)
  }

  const txt = resolveHandler('.txt')
  check('the same lookup works for another extension', txt !== undefined, JSON.stringify(txt))
  if (txt !== undefined) console.log(`  .txt -> ${txt.progId}`)
}

console.log('\n[fallback] what to do when no handler resolves')

{
  // Notepad takes the path as a plain argv entry, so it needs no template
  // substitution and no shell. It is the last resort, not the first choice.
  const notepad = ps('(Get-Command notepad.exe -ErrorAction SilentlyContinue).Source')
  check('notepad is available as a last resort', notepad !== '', notepad)
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
