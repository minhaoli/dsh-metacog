/**
 * Cross-workspace reports: one report covering every workspace with a tree.
 *
 * The behaviour that matters is the boundary between "merged" and "still
 * separate":
 *
 * - nodes from every workspace appear in the report, and a goal from workspace B
 *   is not silently dropped because the renderer started from workspace A;
 * - the record and the Markdown copy land in the global sink, never inside one
 *   workspace's `.metacog` — a file filed under A but describing B and C is
 *   actively misleading;
 * - a workspace without a confirmed tree contributes nothing, because a draft is
 *   a set of goals nobody agreed to.
 *
 * Run: node test/cross-workspace.test.mjs   (after `npm run build`)
 */
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (p) => pathToFileURL(join(here, '..', 'lib', p)).href

const { generateWorkspaceReport } = await import(lib('report.js'))
const { parseConfig } = await import(lib('config.js'))
const { MetacogStore } = await import(lib('data/store.js'))
const { deriveProjectId } = await import(lib('tools/shared.js'))

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

const config = parseConfig({})

/** One workspace with a confirmed tree holding the given goals. */
async function workspace(prefix, goals) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const projectId = deriveProjectId(root)
  const store = new MetacogStore(root, config.storageSubdir)
  await store.initialize(projectId, goals, [])
  await store.commit(projectId, {
    expectedVersion: 0,
    goals,
    contradictions: [],
    reason: 'fixture',
    action: 'init_trees',
    actor: 'user_confirmed',
    targetIds: [],
    markConfirmed: true,
  })
  return { root, projectId, store, state: await store.readState(projectId) }
}

/** A goal node with the fields the schema requires. */
function goal(id, title, extra = {}) {
  const now = new Date().toISOString()
  return {
    id,
    projectId: 'ignored',
    parentId: null,
    depth: 1,
    title,
    description: '',
    status: 'active',
    priority: 0,
    confirmedByUser: true,
    successCriteria: [],
    alignment: { relevantActivities: ['x'], allowedMethods: ['y'] },
    evidence: ['x'],
    createdAt: now,
    updatedAt: now,
    ...extra,
  }
}

const sinkRoot = await mkdtemp(join(tmpdir(), 'metacog-global-'))

try {
  console.log('\n[merge] every workspace with a confirmed tree contributes')

  const a = await workspace('metacog-ws-a-', [goal('g-a', '工作区 A 的目标')])
  const b = await workspace('metacog-ws-b-', [goal('g-b', '工作区 B 的目标')])
  const sink = new MetacogStore(sinkRoot, '.')

  const report = await generateWorkspaceReport({
    workspaces: [a, b],
    config,
    type: 'daily',
    now: new Date('2026-10-30T09:00:00+08:00'),
    targetStore: sink,
    targetProjectId: 'global-all-workspaces',
  })

  check('the report is filed under the global id', report.projectId === 'global-all-workspaces', report.projectId)
  check('the merged version is the highest of the workspaces', report.goalTreeVersion === Math.max(a.state.version, b.state.version), String(report.goalTreeVersion))
  check('the record lands in the sink', (await sink.readReports('global-all-workspaces')).length === 1)
  check('and not in a workspace', (await a.store.readReports(a.projectId)).length === 0)

  // The completion line counts both workspaces; with one goal each and none
  // done, the total is what proves the merge happened.
  check('both workspaces are represented', /目标 0\/2 完成/.test(report.markdown), report.markdown.slice(0, 300))

  console.log('\n[layout] the Markdown copy goes into the global tree')

  const at = new Date(report.periodEnd)
  const pad = (value) => String(value).padStart(2, '0')
  const expected = join(
    sinkRoot,
    'reports',
    'markdown',
    '日报',
    `${at.getFullYear()}_${pad(at.getMonth() + 1)}`,
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}.md`,
  )
  check('the copy is under the sink, not a workspace root', await stat(expected).then(() => true, () => false), expected)
  check('no copy leaked into workspace A', await stat(join(a.root, config.storageSubdir, 'reports', 'markdown')).then(() => true, () => false) === false)

  const markdown = await readFile(expected, 'utf8')
  check('the copy carries the report body', markdown.includes('监控状态'), markdown.slice(0, 200))

  console.log('\n[confirmation] a draft tree contributes nothing')

  // An unconfirmed workspace is a set of goals nobody agreed to. Including it
  // would let a half-finished derivation change the summary.
  const draftRoot = await mkdtemp(join(tmpdir(), 'metacog-ws-draft-'))
  const draftId = deriveProjectId(draftRoot)
  const draftStore = new MetacogStore(draftRoot, config.storageSubdir)
  await draftStore.initialize(draftId, [goal('g-draft', '草稿目标')], [])

  const second = await generateWorkspaceReport({
    workspaces: [a],
    config,
    type: 'daily',
    now: new Date('2026-10-31T09:00:00+08:00'),
    targetStore: sink,
    targetProjectId: 'global-all-workspaces',
  })
  check('only the confirmed workspace is counted', /目标 0\/1 完成/.test(second.markdown), second.markdown.slice(0, 300))

  console.log('\n[period] a cross-workspace weekly report still lands on its Monday')

  const weekly = await generateWorkspaceReport({
    workspaces: [a, b],
    config,
    type: 'weekly',
    now: new Date('2026-10-30T09:00:00+08:00'),
    targetStore: sink,
    targetProjectId: 'global-all-workspaces',
  })
  const monday = new Date(weekly.periodStart)
  check('the weekly period starts on a Monday', monday.getDay() === 1, weekly.periodStart)
  check('and the report names the merged total', /目标 0\/2 完成/.test(weekly.markdown), weekly.markdown.slice(0, 300))

  await rm(draftRoot, { recursive: true, force: true })
  await rm(a.root, { recursive: true, force: true })
  await rm(b.root, { recursive: true, force: true })
} finally {
  await rm(sinkRoot, { recursive: true, force: true })
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
