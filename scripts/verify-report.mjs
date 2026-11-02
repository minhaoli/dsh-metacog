/**
 * Run the three report cadences against a real project's store.
 *
 * Verifies, on real data rather than a fixture: the prose stays inside its
 * budget, the four v3 placeholders are present, the Markdown copy is written at
 * `reports/markdown/<type>-<YYYY-MM-DD>.md` with exactly the stored body, and
 * the body truncates out loud when the period is too large to fit.
 *
 * Usage: node scripts/verify-report.mjs [projectRoot]
 *        (defaults to the workspace that owns this checkout)
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (name) => pathToFileURL(join(here, '..', 'lib', name)).href

const { generateReport, countReportChars, REPORT_CHAR_LIMITS, reportMarkdownPath } = await import(
  lib('report.js')
)
const { MetacogStore } = await import(lib('data/store.js'))
const { parseConfig } = await import(lib('config.js'))

const projectRoot = process.argv[2] ?? join(here, '..', '..')
const storage = '.metacog'
const store = new MetacogStore(projectRoot, storage)

const entries = await readdir(join(store.root, 'state')).catch(() => [])
const projectId = entries.find((name) => name.endsWith('.json'))?.replace(/\.json$/, '')
if (projectId === undefined) {
  console.error(`no metacognitive state under ${store.root}`)
  process.exitCode = 1
  throw new Error('nothing to report on')
}

const state = await store.readState(projectId)
if (state === undefined) {
  console.error(`state file for ${projectId} did not parse`)
  process.exitCode = 1
  throw new Error('nothing to report on')
}

const config = parseConfig({})
const PLACEHOLDERS = ['### 校准状态', '### 审计覆盖率', '### undecidable 四因占比', '### 阈值验证方式']

console.log(`project   ${projectId}`)
console.log(`root      ${projectRoot}`)
console.log(`store     ${relative(process.cwd(), store.root)}`)
console.log(`tree      version ${state.version}, ${state.goals.length} goals, ${state.contradictions.length} contradictions`)

let failures = 0
const summary = []

for (const type of ['daily', 'weekly', 'monthly']) {
  const report = await generateReport({ store, state, projectId, config, type })
  const chars = countReportChars(report.markdown)
  const limit = REPORT_CHAR_LIMITS[type]
  const path = reportMarkdownPath(store.root, type, report.periodEnd)
  const onDisk = await readFile(path, 'utf8').catch(() => undefined)
  const missing = PLACEHOLDERS.filter((heading) => !report.markdown.includes(heading))
  const problems = []
  if (chars > limit) problems.push(`over budget: ${chars} > ${limit}`)
  if (onDisk === undefined) problems.push(`markdown copy missing at ${path}`)
  else if (onDisk !== `${report.markdown}\n`) problems.push('markdown copy differs from the stored body')
  if (missing.length > 0) problems.push(`missing placeholders: ${missing.join(', ')}`)
  if (problems.length > 0) failures += problems.length

  console.log(`\n================ ${type} · ${type}-${report.periodEnd.slice(0, 10)} ================`)
  console.log(report.markdown)
  console.log(`---- 字数 ${chars} / ${limit}｜${chars > limit ? '超限' : '未超限'}｜` +
    `${report.markdown.includes('已截断') ? '已截断' : '未截断'}｜${path}`)
  if (problems.length > 0) console.log(`!! ${problems.join('; ')}`)

  summary.push({ type, chars, limit, truncated: report.markdown.includes('已截断'), path })
}

console.log('\n================ 汇总 ================')
for (const row of summary) {
  console.log(
    `  ${row.type.padEnd(8)} ${String(row.chars).padStart(4)} / ${row.limit}` +
      `  ${row.truncated ? '已截断' : '未截断'}  ${row.path}`,
  )
}
console.log(failures === 0 ? '\n全部通过：三份报告均落盘且未超限。' : `\n${failures} 项失败。`)
if (failures > 0) process.exitCode = 1
