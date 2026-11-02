/**
 * Move the old flat markdown reports into the new per-cadence, per-period tree.
 *
 * Three generations of files exist on disk and all three have to end up in the
 * same layout:
 *
 * - `01-daily-2026-10-27-v1.md` — the earliest naming, one file per run;
 * - `daily-2026-10-28.md` — one file per period, flat directory;
 * - `daily.md` — the briefly-lived accumulator holding several `## <range>`
 *   sections in one file.
 *
 * The target is `日报/<年_月>/<日期>.md`, `周报/<年_Qn>/<周一>.md`,
 * `月报/<年>/<月一号>.md`, with one file per period.
 *
 * Superseded files are removed through the Recycle Bin, not unlinked: the user's
 * history is not scrap for a refactor to destroy, and a mis-parse here would
 * otherwise be unrecoverable.
 *
 * Idempotent: an existing target file is left alone, so a second run is a no-op.
 *
 * Usage:
 *   node scripts/reorganize-reports.mjs <project-root> --dry-run
 *   node scripts/reorganize-reports.mjs <project-root> --apply
 */
import { readFile, readdir, mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { parseConfig } from '../lib/config.js'

const [root, flag] = process.argv.slice(2)
if (root === undefined || (flag !== '--dry-run' && flag !== '--apply')) {
  console.error('usage: node scripts/reorganize-reports.mjs <project-root> --dry-run|--apply')
  process.exit(2)
}
const apply = flag === '--apply'

const config = parseConfig({})
const dir = join(root, config.storageSubdir, 'reports', 'markdown')

const CADENCE = { daily: '日报', weekly: '周报', monthly: '月报' }

const pad = (value) => String(value).padStart(2, '0')
const ymd = (at) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`

/** Monday of the week containing `at`. */
function mondayOf(at) {
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate())
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7))
  return day
}

/** First of the month containing `at`. */
function firstOfMonth(at) {
  return new Date(at.getFullYear(), at.getMonth(), 1)
}

/** Where a period's file belongs, per cadence. */
function targetFor(cadence, at) {
  if (cadence === 'monthly') {
    const first = firstOfMonth(at)
    return join(CADENCE.monthly, String(first.getFullYear()), `${ymd(first)}.md`)
  }
  if (cadence === 'weekly') {
    const monday = mondayOf(at)
    const quarter = Math.floor(monday.getMonth() / 3) + 1
    return join(CADENCE.weekly, `${monday.getFullYear()}_Q${quarter}`, `${ymd(monday)}.md`)
  }
  return join(CADENCE.daily, `${at.getFullYear()}_${pad(at.getMonth() + 1)}`, `${ymd(at)}.md`)
}

/** `2026-10-30` → Date at local midnight; `undefined` when unparseable. */
function parseDay(text) {
  const match = text.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (match === null) return undefined
  const at = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(at.getTime()) ? undefined : at
}

/**
 * Split an accumulated file into one body per `## <range>` section.
 *
 * A file with no such section is treated as a single period whose date comes
 * from its own title line.
 */
function splitSections(text) {
  const lines = text.split('\n')
  const title = lines[0]?.startsWith('# ') ? lines[0] : ''
  const sections = []
  let current = null
  for (const raw of lines.slice(title === '' ? 0 : 1)) {
    const heading = raw.match(/^## (.+)$/)
    if (heading !== null) {
      if (current !== null) sections.push(current)
      current = { label: heading[1], lines: [] }
      continue
    }
    if (current !== null) current.lines.push(raw)
  }
  if (current !== null) sections.push(current)
  return sections.map((section) => ({
    label: section.label,
    // The demotion applied on write pushed every block heading down one level.
    // Restoring is the inverse: a level-two heading inside a section goes back
    // to being a `#`-relative block under the period title.
    body: section.lines.join('\n').trim(),
  }))
}

/** Put a heading back one level, so a re-rendered file nests the same way. */
function promoteHeadings(body) {
  return body
    .split('\n')
    .map((line) => (line.startsWith('##') ? line.slice(1) : line))
    .join('\n')
}

/** Drop the `# 日报 2026-10-30` line a single-period file opens with. */
function stripDocumentTitle(markdown) {
  const lines = markdown.split('\n')
  if (lines.length > 0 && lines[0]?.startsWith('# ')) return lines.slice(1).join('\n').trimStart()
  return markdown
}

/** Push every heading down one level, matching what the writer emits. */
function demoteHeadings(markdown) {
  return markdown
    .split('\n')
    .map((line) => (line.startsWith('#') ? `#${line}` : line))
    .join('\n')
}

/** Document title per cadence, matching what the writer emits. */
const CADENCE_TITLES = { daily: '日报记录', weekly: '周报记录', monthly: '月报记录' }

let entries
try {
  entries = await readdir(dir, { withFileTypes: true })
} catch {
  console.log(`no report directory at ${dir}`)
  process.exit(0)
}

/** Relative path → full text to write there. */
const planned = new Map()
/** Old files to remove once the new ones are written. */
const stale = []

for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith('.md')) continue
  const full = join(dir, entry.name)
  const text = await readFile(full, 'utf8')

  // `daily.md` / `weekly.md` / `monthly.md`: the accumulator.
  const accumulated = entry.name.match(/^(daily|weekly|monthly)\.md$/)
  if (accumulated !== null) {
    const cadence = accumulated[1]
    for (const section of splitSections(text)) {
      const at = parseDay(section.label)
      if (at === undefined) {
        console.log(`  skip section "${section.label}" in ${entry.name}: no date`)
        continue
      }
      const relative = targetFor(cadence, at)
      const body = promoteHeadings(section.body)
      planned.set(relative, `# ${CADENCE_TITLES[cadence]}\n\n## ${section.label}\n\n${body}\n`)
    }
    stale.push(entry.name)
    continue
  }

  // `daily-2026-10-30.md` and `01-daily-2026-10-27-v1.md`.
  const dated = entry.name.match(/(daily|weekly|monthly)-(\d{4}-\d{2}-\d{2})/)
  if (dated !== null) {
    const cadence = dated[1]
    const at = parseDay(dated[2])
    if (at === undefined) continue
    // Re-wrap: these files carry a single `# <类型> <日期>` title and blocks at
    // `##`. The new layout wants a file title, one period heading, and the
    // blocks one level deeper — otherwise a block's `##` sits at the same level
    // as the period heading and the outline flattens.
    const body = demoteHeadings(stripDocumentTitle(text)).trimEnd()
    const label = cadence === 'monthly' ? ymd(firstOfMonth(at)) : cadence === 'weekly' ? ymd(mondayOf(at)) : ymd(at)
    planned.set(targetFor(cadence, at), `# ${CADENCE_TITLES[cadence]}\n\n## ${label}\n\n${body}\n`)
    stale.push(entry.name)
    continue
  }

  console.log(`  unrecognised file left alone: ${entry.name}`)
}

if (planned.size === 0) {
  console.log('nothing to reorganise')
  process.exit(0)
}

let written = 0
let kept = 0
for (const [relative, body] of planned) {
  const target = join(dir, relative)
  const exists = await stat(target).then(
    () => true,
    () => false,
  )
  if (exists) {
    // Never overwrite: a file already in the new layout is newer than the flat
    // one it would be replaced with.
    kept += 1
    console.log(`  keep existing ${relative}`)
    continue
  }
  console.log(`  ${apply ? 'write' : 'would write'} ${relative}`)
  if (apply) {
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, body, 'utf8')
  }
  written += 1
}

console.log(`\n${apply ? 'wrote' : 'would write'} ${written}, kept ${kept} existing, ${stale.length} superseded`)
for (const name of stale) console.log(`  ${apply ? 'recycle' : 'would recycle'} ${name}`)

if (!apply) {
  console.log('\n(dry run — nothing was changed; re-run with --apply)')
  process.exit(0)
}

// Recycle rather than unlink: this is the user's history and a bad parse here
// would otherwise be unrecoverable. The API path is the only portable way.
const { execFileSync } = await import('node:child_process')
let recycled = 0
for (const name of stale) {
  const full = join(dir, name)
  try {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${full.replace(/'/g, "''")}','OnlyErrorDialogs','SendToRecycleBin')`,
    ])
    recycled += 1
  } catch (error) {
    console.log(`  could not recycle ${name}: ${String(error)}`)
  }
}
console.log(`recycled ${recycled} of ${stale.length} superseded files`)
