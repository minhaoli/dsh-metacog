/**
 * F1 path binding: longest prefix, many-to-many, segment boundaries, unbound.
 *
 * The rules tested here are the ones that silently bind work to the wrong goal
 * when they are wrong, and a wrong binding is worse than no binding: it moves
 * an activity onto a goal that never claimed it. So each rule is checked
 * against the near-miss case, not only the happy path.
 *
 * Backward compatibility is part of the contract, not a nicety: state files
 * written before this field existed have no `paths` key at all, and reading
 * them must not throw.
 *
 * Run: node test/path-binding.test.mjs   (after `npm run build`)
 */
import { pathToFileURL } from 'node:url'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (name) => import(pathToFileURL(join(here, '..', 'lib', name)).href)

const { normalizePath, bindPath, bindPaths } = await lib(join('analysis', 'paths.js'))
const { GoalNodeSchema, TreeStateSchema } = await lib(join('data', 'types.js'))
const { apply } = await lib('index.js')
const { parseConfig } = await lib('config.js')

const fixtures = []

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

const goal = (id, paths) => ({ id, paths })

/** The host shape a tool needs; mirrors the smoke test's fixture so this file
 *  drives the real `execute` path rather than a private helper. */
function createHost(projectRoot) {
  const tools = new Map()
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return this.workingDirectory
      if (name === 'tools') return this.tools
      return undefined
    },
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
    on: () => () => {},
    effect: () => {},
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    workingDirectory: { get: () => projectRoot, defaultDirectory: projectRoot },
  }
  return { ctx, tools }
}

console.log('\n[normalize] separators and stray segments')

{
  check('Windows separators become forward slashes', normalizePath('src\\api\\handlers.ts') === 'src/api/handlers.ts')
  check('duplicate separators collapse', normalizePath('src//api') === 'src/api')
  check('a trailing separator is dropped', normalizePath('src/api/') === 'src/api')
  check('a `.` segment is dropped', normalizePath('./src/api') === 'src/api')
  check('an empty string stays empty', normalizePath('') === '')
  check('a rooted path keeps its leading slash', normalizePath('/src/api') === '/src/api')
}

console.log('\n[longest prefix] the narrower owner wins, not the first in the list')

{
  const goals = [goal('broad', ['src']), goal('narrow', ['src/api'])]
  const hit = bindPath('src/api/handlers.ts', goals)
  check('a path under both prefixes binds to the narrow one', hit.goalIds.join() === 'narrow', hit.goalIds.join())
  check('and the winning depth is the narrow prefix', hit.depth === 2, String(hit.depth))

  // Array order must not decide the answer: reversing the input changes nothing.
  const reversed = bindPath('src/api/handlers.ts', [goal('narrow', ['src/api']), goal('broad', ['src'])])
  check('goal order does not change the winner', reversed.goalIds.join() === 'narrow', reversed.goalIds.join())

  const loose = bindPath('src/other/x.ts', goals)
  check('a path outside the narrow prefix falls back to the broad one', loose.goalIds.join() === 'broad', loose.goalIds.join())
  check('and its depth is the broad prefix', loose.depth === 1, String(loose.depth))
}

console.log('\n[longest prefix] deeper wins across three levels')

{
  const goals = [goal('a', ['src']), goal('b', ['src/x']), goal('c', ['src/x/y'])]
  check('three nested prefixes pick the deepest', bindPath('src/x/y/z.ts', goals).goalIds.join() === 'c')
  check('one level up picks the middle', bindPath('src/x/z.ts', goals).goalIds.join() === 'b')
  check('an unrelated child picks the outermost', bindPath('src/z.ts', goals).goalIds.join() === 'a')
}

console.log('\n[many-to-many] several goals may own the same deepest prefix')

{
  const goals = [goal('g1', ['src/shared']), goal('g2', ['src/shared'])]
  const hit = bindPath('src/shared/util.ts', goals)
  check('a tie yields every goal, not a winner', hit.goalIds.length === 2, String(hit.goalIds.length))
  check('both tied ids are reported', hit.goalIds.join() === 'g1,g2', hit.goalIds.join())

  // One goal owning several prefixes, and one activity touching several paths.
  const owners = [goal('api', ['src/api', 'docs/api']), goal('docs', ['docs'])]
  const report = bindPaths(['src/api/a.ts', 'docs/api/b.md', 'docs/guide/c.md'], owners)
  check('one goal can claim several of its own prefixes', report.goalIds.includes('api'))
  check('the report unions every bound goal', report.goalIds.join() === 'api,docs', report.goalIds.join())
  check('the activity counts as bound', report.kind === 'bound')
  check('one path may be claimed by the deeper owner only', report.bindings[1].goalIds.join() === 'api', report.bindings[1].goalIds.join())
  check('a duplicate goal id is not repeated in the union', report.goalIds.filter((id) => id === 'api').length === 1)
}

console.log('\n[segment boundary] a prefix must end on a separator')

{
  const goals = [goal('ab', ['src/ab'])]
  check('the exact prefix matches', bindPath('src/ab/x.ts', goals).goalIds.join() === 'ab')
  check('the bare directory matches', bindPath('src/ab', goals).goalIds.join() === 'ab')
  check('"src/abc" does NOT match "src/ab"', bindPath('src/abc/x.ts', goals).kind === 'unbound')
  check('"src/abc" is reported with no owners', bindPath('src/abc/x.ts', goals).goalIds.length === 0)
  check('"src/abx" does NOT match "src/ab"', bindPath('src/abx', goals).kind === 'unbound')

  // The same trap one level up: a goal owning a file name prefix.
  const file = [goal('f', ['src/index.ts'])]
  check('a file path prefix matches itself', bindPath('src/index.ts', file).goalIds.join() === 'f')
  check('"src/index.tsx" does NOT match "src/index.ts"', bindPath('src/index.tsx', file).kind === 'unbound')
}

console.log('\n[crossing separators] a prefix never matches across a directory')

{
  const goals = [goal('g', ['api'])]
  check('a nested "api" segment does not match a root "api" prefix', bindPath('src/api/x.ts', goals).kind === 'unbound')
  check('a sibling with the same tail does not match', bindPath('api2/x.ts', goals).kind === 'unbound')
  const rooted = [goal('abs', ['/api'])]
  check('an absolute prefix does not match a relative path', bindPath('api/x.ts', rooted).kind === 'unbound')
}

console.log('\n[unbound] no claim is not drift')

{
  const goals = [goal('g', ['src/api'])]
  const hit = bindPath('test/other.test.mjs', goals)
  check('an unclaimed path is unbound', hit.kind === 'unbound')
  check('an unbound path names no goal', hit.goalIds.length === 0)
  check('an unbound path has depth zero', hit.depth === 0)
  check('an unbound path still reports the path it was asked about', hit.path === 'test/other.test.mjs', hit.path)

  check('a goal with no paths claims nothing', bindPath('src/a.ts', [goal('empty', [])]).kind === 'unbound')
  check('an empty goal list claims nothing', bindPath('src/a.ts', []).kind === 'unbound')
  check('an empty path is unbound', bindPath('', goals).kind === 'unbound')

  const report = bindPaths(['test/a.mjs', 'test/b.mjs'], goals)
  check('an activity with only unclaimed paths is unbound', report.kind === 'unbound')
  check('and every path is listed as unbound', report.unboundPaths.length === 2)
  check('the union stays empty', report.goalIds.length === 0)
  check('an activity touching nothing is unbound', bindPaths([], goals).kind === 'unbound')
}

console.log('\n[partial] bound and unbound paths in one activity')

{
  const goals = [goal('g', ['src/api'])]
  const report = bindPaths(['src/api/a.ts', 'node_modules/x/y.js'], goals)
  check('one bound path makes the activity bound', report.kind === 'bound')
  check('the stray path is still reported', report.unboundPaths.join() === 'node_modules/x/y.js', report.unboundPaths.join())
  check('but it does not add a false owner', report.goalIds.join() === 'g', report.goalIds.join())
}

console.log('\n[case] Windows paths are case-insensitive')

{
  const goals = [goal('g', ['src/API'])]
  check('a different case still matches', bindPath('src/api/handlers.ts', goals).goalIds.join() === 'g')
  check('the reported path keeps its original case', bindPath('src/api/handlers.ts', goals).path === 'src/api/handlers.ts')
}

console.log('\n[backward compatible] a goal written before `paths` existed')

{
  // Shape of a real node from .metacog/state/*.json, which has no `paths` key.
  const legacyGoal = {
    id: 'L0_legacy',
    projectId: 'p1',
    parentId: null,
    depth: 0,
    title: 'old goal',
    description: '',
    status: 'active',
    priority: 0,
    confirmedByUser: true,
    successCriteria: [],
    alignment: { relevantActivities: [], allowedMethods: [], excludedActivities: [], explorationPolicy: 'limited' },
    evidence: ['package.json'],
    createdAt: '2026-10-27T11:14:14.986Z',
    updatedAt: '2026-10-27T11:14:14.986Z',
  }

  check('the legacy node really has no paths key', !('paths' in legacyGoal))

  const parsed = GoalNodeSchema.parse(legacyGoal)
  check('parsing it does not throw', parsed !== undefined)
  check('paths defaults to an empty array', Array.isArray(parsed.paths) && parsed.paths.length === 0)
  check('no other field is disturbed', parsed.title === 'old goal' && parsed.status === 'active')

  const legacyState = {
    projectId: 'p1',
    version: 1,
    confirmed: true,
    goals: [legacyGoal],
    contradictions: [],
    createdAt: '2026-10-27T11:14:10.218Z',
    updatedAt: '2026-10-27T11:14:14.987Z',
  }

  let state
  let threw = undefined
  try {
    state = TreeStateSchema.parse(legacyState)
  } catch (error) {
    threw = error
  }
  check('a whole legacy state file parses', threw === undefined, threw === undefined ? '' : String(threw))
  check('its goal gets an empty paths list', state !== undefined && state.goals[0].paths.length === 0)
  check('its version survives', state !== undefined && state.version === 1)

  // And an old goal is simply unbound rather than wrongly claimed.
  check('an old goal owns nothing, so a path is unbound', bindPath('src/a.ts', state.goals).kind === 'unbound')

  // New data round-trips: paths survive a parse.
  const withPaths = GoalNodeSchema.parse({ ...legacyGoal, paths: ['src/api'] })
  check('paths survive a parse', withPaths.paths.join() === 'src/api', withPaths.paths.join())
  check('and then bind', bindPath('src/api/x.ts', [withPaths]).goalIds.join() === 'L0_legacy')
}

console.log('\n[write paths] goal_tree_confirm records the claims it was given')

{
  const root = await mkdtemp(join(tmpdir(), 'metacog-paths-'))
  fixtures.push(root)
  await writeFile(join(root, 'README.md'), '# Paths\n\nA fixture for path binding.\n')
  const { ctx, tools } = createHost(root)
  apply(ctx, parseConfig({}))
  const call = async (name, args) => {
    const definition = tools.get(name)
    if (definition === undefined) throw new Error(`tool "${name}" was never registered`)
    return definition.execute(args, {
      callId: `call-${Math.random().toString(16).slice(2)}`,
      name,
      arguments: args,
      signal: new AbortController().signal,
      agent: { id: 'agent-paths' },
    })
  }

  const confirmArgs = {
    expectedVersion: 0,
    l0: { title: 'Root', evidence: ['README.md'], paths: ['src'], alignment: { relevantActivities: ['x'] } },
    goals: [
      { title: 'Api', evidence: ['README.md'], paths: ['src/api'], relevantActivities: ['api work'], successCriteria: ['each handler module exports exactly one route'] },
      { title: 'Docs', evidence: ['README.md'], paths: ['docs'], relevantActivities: ['writing docs'], successCriteria: ['the readme lists every command'] },
    ],
    reason: 'paths fixture',
  }
  await call('goal_tree_confirm', { ...confirmArgs, preview: true, noDeadlineGoalRefs: ['*'] })
  const confirmed = await call('goal_tree_confirm', {
    ...confirmArgs,
    userApproved: true,
    approvalNote: 'paths 测试确认',
  })
  check('confirm succeeds with paths', confirmed.ok === true, JSON.stringify(confirmed))
  const view = await call('goal_tree_view', {})
  const apiNode = view.data.goals.find((node) => node.title === 'Api')
  const rootNode = view.data.goals.find((node) => node.title === 'Root')
  check('the root keeps its claim', JSON.stringify(rootNode.paths) === '["src"]', JSON.stringify(rootNode?.paths))
  check('a child keeps its claim', JSON.stringify(apiNode.paths) === '["src/api"]', JSON.stringify(apiNode?.paths))
  check('view echoes paths so a caller can see them', Array.isArray(apiNode.paths))

  // The tree the confirm wrote binds the way the rules say it should.
  const goals = view.data.goals.map((node) => ({ id: node.title, paths: node.paths }))
  check('the confirmed tree binds a deep path to the narrow goal', bindPath('src/api/x.ts', goals).goalIds.join() === 'Api')
  check('and a shallow path to the broad one', bindPath('src/main.ts', goals).goalIds.join() === 'Root')

  console.log('\n[write paths] goal_tree_edit replaces claims and creates with them')

  const edited = await call('goal_tree_edit', {
    expectedVersion: view.data.version,
    updates: [{ id: apiNode.id, paths: ['src/api', 'src/server'] }],
    creates: [{ depth: 1, parentId: rootNode.id, title: 'Tests', paths: ['test'], successCriteria: ['every claim is exercised by a test case'] }],
    reason: 'move ownership',
  })
  check('edit succeeds with paths', edited.ok === true, JSON.stringify(edited))
  const afterEdit = await call('goal_tree_view', {})
  const editedApi = afterEdit.data.goals.find((node) => node.title === 'Api')
  check('an update replaces the whole claim list', JSON.stringify(editedApi.paths) === '["src/api","src/server"]', JSON.stringify(editedApi?.paths))
  const createdTests = afterEdit.data.goals.find((node) => node.title === 'Tests')
  check('a create records its claim', JSON.stringify(createdTests.paths) === '["test"]', JSON.stringify(createdTests?.paths))

  console.log('\n[write paths] metacog_revise moves claims, and an empty array withdraws them')

  const revised = await call('metacog_revise', {
    expectedVersion: afterEdit.data.version,
    reason: 'docs owns the whole docs tree now',
    revisions: [{ kind: 'goal_changed', target: 'Docs', paths: ['docs', 'README.md'] }],
  })
  check('revise succeeds with paths', revised.ok === true, JSON.stringify(revised))
  const afterRevise = await call('goal_tree_view', {})
  const revisedDocs = afterRevise.data.goals.find((node) => node.title === 'Docs')
  check('revise writes the new claims', JSON.stringify(revisedDocs.paths) === '["docs","README.md"]', JSON.stringify(revisedDocs?.paths))

  const withdrawn = await call('metacog_revise', {
    expectedVersion: afterRevise.data.version,
    reason: 'tests no longer own anything',
    revisions: [{ kind: 'goal_changed', target: 'Tests', paths: [] }],
  })
  check('withdrawing succeeds', withdrawn.ok === true, JSON.stringify(withdrawn))
  const afterWithdraw = await call('goal_tree_view', {})
  const withdrawnTests = afterWithdraw.data.goals.find((node) => node.title === 'Tests')
  check('an empty array withdraws the claim', JSON.stringify(withdrawnTests.paths) === '[]', JSON.stringify(withdrawnTests?.paths))
}

for (const fixture of fixtures) await rm(fixture, { recursive: true, force: true })

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
