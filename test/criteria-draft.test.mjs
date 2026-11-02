/**
 * `metacog_draft_criteria`: suggestions only, one small call per goal.
 *
 * The tool is exercised with a real store and a fake llm service: the store
 * proves nothing is written, and the fake lets each case control the model
 * answer without spending a call. The important failure modes are all here —
 * a sentence instead of a phrase, overlapping criteria, an empty answer, an
 * unavailable channel, and one goal failing while the rest still succeed.
 *
 * Run: node test/criteria-draft.test.mjs   (after `npm run build`)
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (path) => pathToFileURL(join(here, '..', 'lib', path)).href

const { metacogDraftCriteriaTool } = await import(lib('tools/criteria.js'))
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

const NOW = '2026-10-31T00:00:00.000Z'

function goal(id, overrides = {}) {
  return {
    id,
    projectId: 'fixture',
    parentId: null,
    depth: 0,
    title: `目标 ${id}`,
    description: '',
    status: 'active',
    priority: 0,
    confirmedByUser: true,
    successCriteria: [],
    alignment: { relevantActivities: [] },
    paths: [],
    evidence: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

/** A confirmed tree with missing, existing, non-leaf and done goals. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'metacog-criteria-'))
  await mkdir(join(root, 'src', 'analysis'), { recursive: true })
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'src', 'analysis', 'verdict.ts'), 'export {}\n', 'utf8')
  await writeFile(join(root, 'src', 'analysis', 'criteria.ts'), 'export {}\n', 'utf8')
  await writeFile(join(root, 'docs', 'readme.md'), '# docs\n', 'utf8')

  const config = parseConfig({ realtime: { enabled: true, timeoutMs: 2000 } })
  const projectId = deriveProjectId(root)
  const store = new MetacogStore(root, config.storageSubdir)
  const goals = [
    goal('g1', {
      title: '生成判据',
      description: '为缺判据的目标生成短词判据',
      paths: ['src'],
      alignment: { relevantActivities: [] },
    }),
    goal('g2', {
      title: '已有判据',
      paths: ['docs'],
      alignment: { relevantActivities: ['写文档'] },
    }),
    goal('g3', { title: '父目标', alignment: { relevantActivities: [] } }),
    goal('g4', {
      title: '子目标',
      parentId: 'g3',
      depth: 1,
      paths: ['src/analysis'],
      alignment: { relevantActivities: [] },
    }),
    goal('g5', { title: '完成目标', status: 'done', alignment: { relevantActivities: [] } }),
  ].map((item) => ({ ...item, projectId }))
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
  return { root, config, projectId, store, goals }
}

/** A fake llm that returns one answer per call, and records the prompts. */
function fakeLlm(responses) {
  let index = 0
  const prompts = []
  return {
    prompts,
    stream(options) {
      const answer = responses[Math.min(index, responses.length - 1)]
      index += 1
      prompts.push(options.messages[0].content[0].text)
      if (answer instanceof Error) throw answer
      return (async function* () {
        yield { type: 'text-delta', text: typeof answer === 'string' ? answer : JSON.stringify(answer) }
        yield { type: 'finish', reason: 'stop' }
      })()
    },
  }
}

const VALID = {
  relevantActivities: ['写判据', '跑测试'],
  excludedActivities: ['写文档'],
  unable: false,
  reason: '',
}

function makeEnv(root, store, config, llm, defaultModel = { provider: 'p1', model: 'm1' }) {
  return {
    ctx: {
      get(name) {
        if (name === 'llm') return llm
        if (name === 'agents') return { defaultModel: () => defaultModel }
        return undefined
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      on: () => () => {},
      effect: () => {},
    },
    config,
    resolveProjectRoot: async () => root,
    storeFor: () => store,
  }
}

function execFor(root, args) {
  return {
    callId: 'criteria-test',
    name: 'metacog_draft_criteria',
    arguments: args,
    signal: new AbortController().signal,
    projectRoot: root,
  }
}

// ----------------------------------------------------------------- targets
console.log('\n[targets] only live leaves missing criteria, unless overwrite')
{
  const { root, config, projectId, store } = await fixture()
  const llm = fakeLlm([VALID])
  try {
    const tool = metacogDraftCriteriaTool(makeEnv(root, store, config, llm))
    const result = await tool.execute({}, execFor(root, {}))
    check('the tool succeeds', result.ok === true, JSON.stringify(result))
    const ids = result.data.suggestions.map((item) => item.goalId)
    check('both missing leaves are drafted', ids.length === 2 && ids.includes('g1') && ids.includes('g4'), JSON.stringify(ids))
    check('the goal with criteria is skipped', result.data.skipped.some((item) => item.goalId === 'g2' && item.reason === 'has_criteria'), JSON.stringify(result.data.skipped))
    check('the non-leaf parent is not drafted', !ids.includes('g3'), JSON.stringify(ids))
    check('the done goal is not drafted', !ids.includes('g5'), JSON.stringify(ids))
    check('two model calls were made', llm.prompts.length === 2, String(llm.prompts.length))
    check('the suggestion has relevant criteria', result.data.suggestions[0].relevantActivities.includes('写判据'), JSON.stringify(result.data.suggestions[0]))
    check('the suggestion has excluded criteria', result.data.suggestions[0].excludedActivities.includes('写文档'))
    check('nothing was written', result.data.wrote === false)
    check('dryRun defaults to true', result.data.dryRun === true)

    const stateAfter = await store.readState(projectId)
    check('the stored tree is untouched', stateAfter.goals.every((item) => item.alignment.relevantActivities.length === 0 || item.id === 'g2'), JSON.stringify(stateAfter.goals.map((item) => item.alignment.relevantActivities)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log('\n[targets] overwrite and explicit ids')
{
  const { root, config, store } = await fixture()
  const llm = fakeLlm([VALID])
  try {
    const tool = metacogDraftCriteriaTool(makeEnv(root, store, config, llm))
    const overwrite = await tool.execute({ overwrite: true }, execFor(root, { overwrite: true }))
    const ids = overwrite.data.suggestions.map((item) => item.goalId)
    check('overwrite includes the goal that already has criteria', ids.includes('g2'), JSON.stringify(ids))

    const explicitLlm = fakeLlm([VALID])
    const explicitTool = metacogDraftCriteriaTool(makeEnv(root, store, config, explicitLlm))
    const explicit = await explicitTool.execute({ goalIds: ['g2'] }, execFor(root, { goalIds: ['g2'] }))
    check('an explicit goal with criteria is skipped by default', explicit.data.suggestions.length === 0 && explicit.data.skipped.some((item) => item.goalId === 'g2'), JSON.stringify(explicit.data))

    const unknown = await explicitTool.execute({ goalIds: ['nope'] }, execFor(root, { goalIds: ['nope'] }))
    check('an unknown id is reported, not silently ignored', unknown.data.skipped.some((item) => item.goalId === 'nope' && item.reason === 'unknown_goal'), JSON.stringify(unknown.data.skipped))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log('\n[targets] the batch limit caps model calls')
{
  const { root, config, store } = await fixture()
  const llm = fakeLlm([VALID])
  try {
    const tool = metacogDraftCriteriaTool(makeEnv(root, store, config, llm))
    const result = await tool.execute({ limit: 1 }, execFor(root, { limit: 1 }))
    check('only one goal is processed', result.data.processed === 1, String(result.data.processed))
    check('the rest is reported as truncated', result.data.truncated === 1, String(result.data.truncated))
    check('only one model call was made', llm.prompts.length === 1, String(llm.prompts.length))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------------- input
console.log('\n[input] only this goal plus directory/file clues')
{
  const { root, config, store } = await fixture()
  const llm = fakeLlm([VALID])
  try {
    const tool = metacogDraftCriteriaTool(makeEnv(root, store, config, llm))
    await tool.execute({ goalIds: ['g1'] }, execFor(root, { goalIds: ['g1'] }))
    const prompt = llm.prompts[0]
    check('the prompt carries the title', prompt.includes('生成判据'), prompt)
    check('the prompt carries the description', prompt.includes('为缺判据的目标生成短词判据'), prompt)
    check('the prompt carries the bound path', prompt.includes('src'), prompt)
    check('the prompt carries a directory clue', prompt.includes('analysis'), prompt)
    check('the prompt carries a file clue', prompt.includes('verdict.ts'), prompt)
    check('the prompt does not carry another goal', !prompt.includes('已有判据') && !prompt.includes('父目标'), prompt)
    check('the prompt does not carry the whole tree', !prompt.includes('完成目标'), prompt)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// ----------------------------------------------------------------- quality
console.log('\n[quality] sentences, empty answers and overlaps are refused')
{
  const cases = [
    {
      name: 'a sentence is not a criterion',
      answer: { relevantActivities: ['这个目标需要持续写代码。'], excludedActivities: [], unable: false, reason: '' },
      expect: (entry) => entry.status === 'unable' && /没有给出可用/.test(entry.reason),
    },
    {
      name: 'an empty relevant list becomes unable',
      answer: { relevantActivities: [], excludedActivities: ['写文档'], unable: false, reason: '' },
      expect: (entry) => entry.status === 'unable' && /没有给出可用/.test(entry.reason),
    },
    {
      name: 'overlapping relevant/excluded is refused',
      answer: { relevantActivities: ['写测试'], excludedActivities: ['测试'], unable: false, reason: '' },
      expect: (entry) => entry.status === 'unable' && /重叠/.test(entry.reason),
    },
    {
      name: 'the model may say it cannot judge',
      answer: { relevantActivities: [], excludedActivities: [], unable: true, reason: '目标太笼统' },
      expect: (entry) => entry.status === 'unable' && /目标太笼统/.test(entry.reason),
    },
  ]
  for (const testCase of cases) {
    const { root, config, store } = await fixture()
    const llm = fakeLlm([testCase.answer])
    try {
      const tool = metacogDraftCriteriaTool(makeEnv(root, store, config, llm))
      const result = await tool.execute({ goalIds: ['g1'] }, execFor(root, { goalIds: ['g1'] }))
      const entry = result.data.suggestions[0]
      check(testCase.name, testCase.expect(entry), JSON.stringify(entry))
      check(`${testCase.name}: no empty suggestion is presented as done`, entry.status !== 'suggested' || entry.relevantActivities.length > 0, JSON.stringify(entry))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}

// ------------------------------------------------------------- unavailable
console.log('\n[channel] unavailable or unconfigured is an explicit refusal')
{
  const { root, config, store } = await fixture()
  try {
    const noLlm = metacogDraftCriteriaTool(makeEnv(root, store, config, undefined))
    const result = await noLlm.execute({}, execFor(root, {}))
    check('a missing llm service fails the call', result.ok === false && result.error.code === 'LLM_UNAVAILABLE', JSON.stringify(result))
    check('and returns no suggestion array', !('suggestions' in (result.data ?? {})), JSON.stringify(result.data))

    const unconfigured = metacogDraftCriteriaTool(makeEnv(root, store, config, fakeLlm([VALID]), null))
    const result2 = await unconfigured.execute({}, execFor(root, {}))
    check('an empty model route fails the call', result2.ok === false && result2.error.code === 'LLM_NOT_CONFIGURED', JSON.stringify(result2))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------- isolation
console.log('\n[isolation] one goal failing does not lose the others')
{
  const { root, config, store } = await fixture()
  const llm = fakeLlm([new Error('boom'), VALID])
  try {
    const tool = metacogDraftCriteriaTool(makeEnv(root, store, config, llm))
    const result = await tool.execute({}, execFor(root, {}))
    check('the batch itself succeeds', result.ok === true, JSON.stringify(result))
    check('one goal is failed', result.data.counts.failed === 1, JSON.stringify(result.data.counts))
    check('the other goal is suggested', result.data.counts.suggested === 1, JSON.stringify(result.data.counts))
    check('the failure carries its reason', result.data.suggestions.some((item) => item.status === 'failed' && /boom/.test(item.reason)), JSON.stringify(result.data.suggestions))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------------ dryRun
console.log('\n[dryRun] false still writes nothing')
{
  const { root, config, projectId, store } = await fixture()
  const llm = fakeLlm([VALID])
  try {
    const before = await store.readState(projectId)
    const tool = metacogDraftCriteriaTool(makeEnv(root, store, config, llm))
    const result = await tool.execute({ dryRun: false }, execFor(root, { dryRun: false }))
    check('the result records the intent', result.data.dryRun === false)
    check('but reports wrote false', result.data.wrote === false)
    check('and suggests a write path', /goal_tree_edit/.test(result.data.note), result.data.note)
    const after = await store.readState(projectId)
    check('the stored criteria are unchanged', JSON.stringify(before.goals.map((item) => item.alignment.relevantActivities)) === JSON.stringify(after.goals.map((item) => item.alignment.relevantActivities)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------- nothing to do
console.log('\n[empty] a tree with complete criteria makes no call')
{
  const { root, config, store, projectId } = await fixture()
  const llm = fakeLlm([VALID])
  try {
    // Give every live leaf criteria.
    const state = await store.readState(projectId)
    const goals = state.goals.map((item) => ({
      ...item,
      alignment: { ...item.alignment, relevantActivities: ['已有'] },
    }))
    await store.commit(projectId, {
      expectedVersion: state.version,
      goals,
      contradictions: [],
      reason: 'fixture complete',
      action: 'update_l1',
      actor: 'user_confirmed',
      targetIds: [],
    })
    const tool = metacogDraftCriteriaTool(makeEnv(root, store, config, llm))
    const result = await tool.execute({}, execFor(root, {}))
    check('no goal is eligible', result.data.eligible === 0, String(result.data.eligible))
    check('no suggestion is fabricated', result.data.suggestions.length === 0)
    check('no model call is made', llm.prompts.length === 0, String(llm.prompts.length))
    check('the note explains why', /没有|不需要|已有/.test(result.data.note), result.data.note)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
