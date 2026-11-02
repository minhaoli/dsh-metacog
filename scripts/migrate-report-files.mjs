/**
 * Fold the pre-incremental markdown reports into the new per-cadence files.
 *
 * Before this change each run wrote `daily-2026-10-30.md` and a new period got a
 * new file. Now one `daily.md` accumulates every period, so the newest of each
 * old file is folded in as the first section and the rest stay on disk untouched
 * — nothing is deleted, because the older files are the only copy of those
 * periods and a migration that loses history is worse than a stale filename.
 *
 * Idempotent: a cadence whose accumulated file already exists is left alone.
 *
 * Usage: node scripts/migrate-report-files.mjs <project-root>
 */
import { readFile, readdir, stat, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

import { parseConfig } from '../lib/config.js'

const root = process.argv[2]
if (root === undefined) {
  console.error('usage: node scripts/migrate-report-files.mjs <project-root>')
  process.exit(2)
}

const config = parseConfig({})
const dir = join(root, config.storageSubdir, 'reports', 'markdown')
const TITLES = { daily: '日报记录', weekly: '周报记录', monthly: '月报记录' }

/** `daily-2026-10-30.md` → `2026-10-30`; anything unexpected → undefined. */
function stampOf(name, cadence) {
  const match = name.match(new RegExp(`^${cadence}-(\\d{4}-\\d{2}-\\d{2})\\.md$`))
  return match === null ? undefined : match[1]
}

let entries
try {
  entries = await readdir(dir)
} catch {
  console.log(`no report directory at ${dir}; nothing to migrate`)
  process.exit(0)
}

let migrated = 0
for (const cadence of ['daily', 'weekly', 'monthly']) {
  const target = join(dir, `${cadence}.md`)
  const exists = await stat(target).then(
    () => true,
    () => false,
  )
  if (exists) {
    console.log(`${cadence}: ${cadence}.md already exists, left alone`)
    continue
  }

  // Newest period wins: the older dated files are superseded snapshots of the
  // same cadence, and folding all of them in would duplicate overlapping windows.
  const candidates = entries
    .map((name) => ({ name, stamp: stampOf(name, cadence) }))
    .filter((entry) => entry.stamp !== undefined)
    .sort((left, right) => right.stamp.localeCompare(left.stamp))
  if (candidates.length === 0) {
    console.log(`${cadence}: no dated file to fold in`)
    continue
  }

  const newest = candidates[0]
  const body = await readFile(join(dir, newest.name), 'utf8')
  const lines = body.split('\n')
  const titleLine = lines[0]?.startsWith('# ') ? lines[0] : `# ${TITLES[cadence]}`
  const rest = lines.slice(titleLine === lines[0] ? 1 : 0).join('\n').trim()
  // Demote the period's own headings so they nest under their section heading,
  // which is the layout `appendMarkdownCopy` produces for every later period.
  const demoted = rest
    .split('\n')
    .map((line) => (line.startsWith('#') ? `#${line}` : line))
    .join('\n')

  const section = `## ${newest.stamp}（迁移自 ${newest.name}）\n\n${demoted}\n`
  const content = `# ${TITLES[cadence]}\n\n${section}`
  const temporary = `${target}.tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, target)
  migrated += 1
  console.log(`${cadence}: folded ${newest.name} into ${cadence}.md (${content.length} chars)`)
}

console.log(`\nmigrated ${migrated} cadence(s); superseded files left in place`)
