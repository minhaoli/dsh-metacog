/**
 * Plan declaration: cheap to write, hard to lose, never an accusation.
 *
 * Three separate claims, and they fail in different ways if left alone:
 *
 *   A1 — a session that declares only structured steps has already said which
 *        tools it expects to call. Demanding a second copy of that list was the
 *        main reason plans went undeclared, and an undeclared session is
 *        monitored by S5 alone at 0.25 coverage, below the escalation floor.
 *   A2 — the binary S3 verdict stays binary (a gradient would be invented
 *        precision), but its wording reaches the prompt block, so it must read
 *        as a statement plus the action that resolves it, not as a charge.
 *   A3 — a session with no plan is told so once, with the call to make and a
 *        goal it can simply confirm. It disappears once a plan exists and under
 *        quiet mode, so it cannot become a nag.
 *   A4 — `metacog_revise_plan` promises "supply only the fields that change".
 *        The only copy of the plan is the revised one, so a field it silently
 *        dropped is gone for good.
 *
 * Run: node test/plan-declaration.test.mjs   (after `npm run build`)
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (path) => pathToFileURL(join(here, '..', 'lib', path)).href

const { apply } = await import(lib('index.js'))
const { MetacogStore } = await import(lib('data/store.js'))
const { deriveProjectId } = await import(lib('tools/shared.js'))
const { parseConfig } = await import(lib('config.js'))
const { scoreToolNovelty } = await import(lib('analysis/signals/index.js'))
const { planAllowedTools } = await import(lib('data/signals.js'))
const { renderPromptBlock } = await import(lib('report.js'))

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

/** The host shape a tool needs; mirrors the other fixtures so this file drives
 *  the real `execute` path rather than a private helper. */
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

const fixtures = []
const root = await mkdtemp(join(tmpdir(), 'metacog-plan-declaration-'))
fixtures.push(root)
await writeFile(join(root, 'README.md'), '# Plan declaration\n\nA fixture for plan tooling.\n')

const { ctx, tools } = createHost(root)
apply(ctx, parseConfig({}))

const call = async (name, args) => {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`tool "${name}" was not registered`)
  return definition.execute(args, {
    callId: `call-${Math.random().toString(16).slice(2)}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
    agent: { id: 'agent-plan-declaration' },
  })
}

const config = parseConfig({})
const store = new MetacogStore(root, '.metacog')
const projectId = deriveProjectId(root)

// ----------------------------------------------------------------------- A1

console.log('\n[A1] a step list is a tool declaration')

{
  const stepsOnly = {
    id: 'plan_steps',
    goal: '把路径归属接进判定',
    allowedTools: [],
    declaredAt: '2026-10-01T00:00:00.000Z',
    steps: [
      { intent: '读判定链路', expects: { tool: 'read' }, optional: false },
      { intent: '跑测试', expects: { tool: 'pwsh' }, optional: false },
      { intent: '看结果', expects: { assert: 'tests-pass' }, optional: false },
    ],
  }

  check('the tool set is derived from the steps', planAllowedTools(stepsOnly).join(',') === 'read,pwsh')
  check(
    'a step with only an assert contributes no tool',
    !planAllowedTools(stepsOnly).includes('tests-pass'),
  )
  check(
    'an explicit whitelist wins over the steps',
    planAllowedTools({ ...stepsOnly, allowedTools: ['edit'] }).join(',') === 'edit',
  )

  const inside = scoreToolNovelty({ tools: ['read'], results: [] }, stepsOnly)
  check('S3 scores a step tool', inside.status === 'available' && inside.score === 0, JSON.stringify(inside))
  check('S3 scores a derived tool too', scoreToolNovelty({ tools: ['pwsh'], results: [] }, stepsOnly).score === 0)
  check('and still catches one outside it', scoreToolNovelty({ tools: ['web_fetch'], results: [] }, stepsOnly).score === 1)

  const empty = { ...stepsOnly, steps: [] }
  const absent = scoreToolNovelty({ tools: ['read'], results: [] }, empty)
  check(
    'neither source is an absence, not a zero',
    absent.status === 'not_applicable' && absent.reason === 'no_allowed_tools',
    JSON.stringify(absent),
  )
  check('the absence explains both sources', String(absent.detail).includes('expects.tool'), absent.detail)

  const declared = await call('metacog_declare_plan', {
    // A concrete goal: `declare_plan` now refuses one that names nothing
    // checkable, and this test is about the step list rather than the goal.
    goal: '给 src/analysis/alignment.ts 加路径归属判定',
    steps: [
      { intent: '读判定链路', expects: { tool: 'read' } },
      { intent: '改判定', expects: { tool: 'edit' } },
    ],
  })
  check('the tool accepts a declaration without allowedTools', declared.ok === true, JSON.stringify(declared).slice(0, 300))
  check('the plan stores no explicit whitelist', declared.data?.plan?.allowedTools.length === 0)
  const receipt = declared.data?.signals?.find((entry) => entry.signal === 's3_tool_novel')
  check('the receipt says S3 is reading the steps', receipt?.status === 'available', JSON.stringify(receipt))
  check('and names where it read them', String(receipt?.detail).includes('expects.tool'), receipt?.detail)
}

// ----------------------------------------------------------------------- A2

console.log('\n[A2] an undeclared tool is a question, not a charge')

{
  const plan = {
    id: 'plan_words',
    goal: 'g',
    allowedTools: ['read', 'edit'],
    declaredAt: '2026-10-01T00:00:00.000Z',
    steps: [],
  }
  const outside = scoreToolNovelty({ tools: ['web_fetch'], results: [] }, plan)
  const text = String(outside.evidence?.[0] ?? '')

  check('the score is still binary', outside.status === 'available' && outside.score === 1)
  check('the rationale names the tool that was used', text.includes('web_fetch'), text)
  check('and the declared set it left', text.includes('read') && text.includes('edit'), text)
  check('it tells the model which call resolves it', text.includes('metacog_revise_plan'), text)
  check('it says this is not a violation', text.includes('不等于违规'), text)
  check('it no longer reads as a verdict', !text.includes('越界工具'), text)

  const inside = scoreToolNovelty({ tools: ['read'], results: [] }, plan)
  check('a declared tool still scores zero', inside.score === 0)
  check('and is not accused either', !String(inside.evidence?.[0] ?? '').includes('metacog_revise_plan'))
}

// ----------------------------------------------------------------------- A3

console.log('\n[A3] the block invites a declaration while there is none')

{
  const treeState = {
    projectId,
    version: 3,
    confirmed: true,
    updatedAt: '2026-10-20T00:00:00.000Z',
    goals: [
      { id: 'g_root', title: '让监控结论可信', depth: 0, status: 'active', confirmedByUser: true, evidence: ['README.md'] },
      {
        id: 'g_leaf',
        title: '把路径归属接进判定',
        depth: 1,
        status: 'active',
        confirmedByUser: true,
        evidence: ['README.md'],
        parentId: 'g_root',
      },
      {
        id: 'g_done',
        title: '已完成的一支',
        depth: 1,
        status: 'done',
        confirmedByUser: true,
        evidence: ['README.md'],
        parentId: 'g_root',
      },
    ],
    contradictions: [],
  }

  const bare = renderPromptBlock(treeState, [], [], config, undefined)
  check('no plan produces the hint', bare.includes('metacog_declare_plan'), bare)
  check('the hint names the cheap path', bare.includes('expects.tool'), bare)
  check('an unfinished leaf becomes the candidate', bare.includes('g_leaf'), bare)
  check('the candidate carries a goal sentence to confirm', bare.includes('推进 把路径归属接进判定'), bare)
  check('the finished branch is not offered', !bare.includes('g_done'), bare)
  check('the root is not offered as a task', !bare.includes('候选 linkedGoalId "g_root"'), bare)

  const declared = renderPromptBlock(treeState, [], [], config, {
    id: 'plan_live',
    goal: 'g',
    allowedTools: [],
    declaredAt: '2026-10-20T00:00:00.000Z',
    steps: [],
  })
  check('a plan in force silences the hint', !declared.includes('未声明本次计划'), declared)
  check('and offers no candidate either', !declared.includes('候选 linkedGoalId'), declared)

  const quiet = renderPromptBlock(treeState, [], [], parseConfig({ quiet: { enabled: true } }), undefined)
  check('quiet mode hides the hint', !quiet.includes('未声明本次计划'), quiet)
  check('but keeps the standing rules', quiet.includes('core'), quiet)

  const noLeaf = renderPromptBlock(
    { ...treeState, goals: treeState.goals.filter((goal) => goal.id !== 'g_leaf') },
    [],
    [],
    config,
    undefined,
  )
  check('a tree with nothing actionable still asks for a plan', noLeaf.includes('metacog_declare_plan'), noLeaf)
  check('but invents no candidate', !noLeaf.includes('候选 linkedGoalId'), noLeaf)
}

// ----------------------------------------------------------------------- A4

console.log('\n[A4] revising keeps every field it was not given')

{
  const seed = {
    id: 'plan_seed',
    goal: '把路径归属接进判定',
    linkedGoalId: 'g_leaf',
    deadline: '2026-11-30T00:00:00.000Z',
    allowedTools: ['read', 'edit'],
    steps: [{ intent: '读判定链路', expects: { tool: 'read' }, optional: false }],
    declaredAt: '2026-10-01T00:00:00.000Z',
  }
  await store.writeSignalState({
    projectId,
    final: 0.4,
    consecutiveHigh: 1,
    stepsSeen: 9,
    planId: seed.id,
    plan: seed,
    updatedAt: '2026-10-20T00:00:00.000Z',
  })

  const revised = await call('metacog_revise_plan', {
    allowedTools: ['read', 'edit', 'pwsh'],
    reason: '需要跑测试',
  })
  check('revising succeeds', revised.ok === true, JSON.stringify(revised).slice(0, 300))

  const after = (await store.readSignalState(projectId))?.plan
  check('the supplied whitelist replaced the old one', after?.allowedTools.join(',') === 'read,edit,pwsh', String(after?.allowedTools))
  check('the steps it never mentioned survived', after?.steps.length === 1, String(after?.steps.length))
  check('the linked goal survived', after?.linkedGoalId === 'g_leaf', String(after?.linkedGoalId))
  check('the deadline survived', after?.deadline === '2026-11-30T00:00:00.000Z', String(after?.deadline))
  check('the goal survived', after?.goal === '把路径归属接进判定', String(after?.goal))
  check('the declaration time survived', after?.declaredAt === '2026-10-01T00:00:00.000Z', String(after?.declaredAt))
  check('and the revision is stamped', typeof after?.revisedAt === 'string', String(after?.revisedAt))

  const stateAfterRevision = await store.readSignalState(projectId)
  check('the smoothed score was reset', stateAfterRevision?.final === 0, String(stateAfterRevision?.final))
  check('the step count was kept', stateAfterRevision?.stepsSeen === 9, String(stateAfterRevision?.stepsSeen))

  const second = await call('metacog_revise_plan', {
    steps: [
      { intent: '读判定链路', expects: { tool: 'read' } },
      { intent: '跑测试', expects: { tool: 'pwsh' } },
    ],
    reason: '补一步',
  })
  check('adding a step succeeds', second.ok === true, JSON.stringify(second).slice(0, 300))
  const afterSecond = (await store.readSignalState(projectId))?.plan
  check('adding a step keeps the whitelist', afterSecond?.allowedTools.join(',') === 'read,edit,pwsh', String(afterSecond?.allowedTools))
  check('and the new step list is in force', afterSecond?.steps.length === 2, String(afterSecond?.steps.length))
}

for (const fixture of fixtures) await rm(fixture, { recursive: true, force: true })

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
