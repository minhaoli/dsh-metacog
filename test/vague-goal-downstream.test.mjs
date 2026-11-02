/**
 * `vagueGoal` downstream: the realtime verdict and S4.
 *
 * A vague goal is not a low-quality goal; it is a goal whose text names no
 * checkable target. The verdict must say "cannot judge" instead of inventing a
 * score, and S4 must keep judging the steps, which do not depend on the goal
 * sentence at all.
 *
 * Run: node test/vague-goal-downstream.test.mjs   (after `npm run build`)
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (path) => pathToFileURL(join(here, '..', 'lib', path)).href

const verdict = await import(lib('analysis/verdict.js'))
const { scorePlanMatch } = await import(lib('analysis/signals/plan.js'))
const { MetacogStore } = await import(lib('data/store.js'))

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

const INPUT = {
  goals: [
    {
      id: 'g1',
      title: '说不清的目标',
      relevantActivities: ['写代码'],
      paths: ['src'],
    },
  ],
  activities: [
    { at: '2026-10-31T10:00:00+08:00', action: '编辑 src/verdict.ts', paths: ['src/verdict.ts'] },
  ],
}

const VAGUE_INPUT = {
  ...INPUT,
  vagueGoal: true,
  vagueGoalReason: '还没想清楚这个项目到底要什么',
}

/** A fake stream that returns one complete verdict answer. */
function answerLlm(answer) {
  return {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', text: JSON.stringify(answer) }
        yield { type: 'finish', reason: 'stop' }
      })()
    },
  }
}

const MODEL_ANSWER = {
  match: 0.9,
  goalId: 'g1',
  reason: '工作看起来对齐',
  expectNext: '继续写',
  fulfilled: null,
}

// ------------------------------------------------------------------ input
console.log('\n[input] the vague fact and its reason reach the prompt')
{
  const prompt = verdict.buildVerdictPrompt(VAGUE_INPUT)
  check('the prompt states the goal is vague', prompt.text.includes('目标被标记为模糊'), prompt.text.slice(0, 200))
  check('the prompt carries the reason', prompt.text.includes('还没想清楚这个项目到底要什么'), prompt.text)
  check('the prompt requires match null', prompt.text.includes('match 必须为 null'), prompt.text)
  check('the vague prompt is still inside the budget', prompt.estimatedTokens <= 1000, String(prompt.estimatedTokens))

  const concrete = verdict.buildVerdictPrompt(INPUT)
  check('a concrete prompt carries no vague marker', !concrete.text.includes('目标被标记为模糊'), concrete.text.slice(0, 200))
  check('a concrete prompt still asks for a numeric match', concrete.text.includes('0到1的小数'), concrete.text.slice(0, 200))
}

// ----------------------------------------------------------------- output
console.log('\n[output] a vague goal never yields a score')
{
  const result = await verdict.runRealtimeVerdict(VAGUE_INPUT, {
    llm: answerLlm(MODEL_ANSWER),
    provider: 'p1',
    model: 'm1',
  })
  check('the call succeeds', result.ok === true, JSON.stringify(result))
  check('match is null even though the model returned 0.9', result.ok === true && result.verdict.match === null, JSON.stringify(result.verdict))
  check('the reason names the vague goal', result.ok === true && /模糊|无法可靠/.test(result.verdict.reason), result.verdict.reason)
  check('the vague hint is produced', result.ok === true && result.hints.length === 1, JSON.stringify(result.hints))
  check('the hint suggests revising the plan', result.ok === true && /metacog_revise_plan/.test(result.hints[0]), result.hints[0])
  check('no low-score hint is produced', result.ok === true && !/匹配度/.test(result.hints.join('')), result.hints.join(''))

  const concrete = await verdict.runRealtimeVerdict(INPUT, {
    llm: answerLlm({ ...MODEL_ANSWER, match: 0.4 }),
    provider: 'p1',
    model: 'm1',
  })
  check('a concrete goal keeps its numeric match', concrete.ok === true && concrete.verdict.match === 0.4, JSON.stringify(concrete))
  check('and produces no vague hint', concrete.ok === true && concrete.hints.length === 0, JSON.stringify(concrete.hints))

  const parserNull = verdict.parseVerdict(
    '{"match":null,"goalId":"g1","reason":"目标模糊，无法可靠判断","expectNext":"继续","fulfilled":null}',
    ['g1'],
    { allowNullMatch: true },
  )
  check('the parser accepts null when allowed', parserNull.ok === true && parserNull.verdict.match === null, JSON.stringify(parserNull))

  const parserReject = verdict.parseVerdict(
    '{"match":null,"goalId":"g1","reason":"x","expectNext":"y","fulfilled":null}',
    ['g1'],
  )
  check('the parser rejects null when not allowed', parserReject.ok === false && /match/.test(parserReject.error), JSON.stringify(parserReject))
}

// ------------------------------------------------------------------- hint
console.log('\n[hint] the vague explanation is clamped and actionable')
{
  const hint = verdict.vagueGoalHint(VAGUE_INPUT)
  check('a vague goal produces a hint', typeof hint === 'string' && hint.length > 0, String(hint))
  check('the hint is clamped to 60 characters', hint.length <= 60, String(hint.length))
  check('the hint names the consequence', /模糊/.test(hint), hint)
  check('the hint names the action', /metacog_revise_plan/.test(hint), hint)
  check('a concrete goal produces no hint', verdict.vagueGoalHint(INPUT) === undefined)
}

// -------------------------------------------------------------------- S4
console.log('\n[S4] a vague goal does not make the plan signal absent')
{
  const steps = [
    { intent: '编辑代码', expects: { tool: 'edit' }, optional: false },
    { intent: '跑测试', expects: { assert: 'tests-pass' }, optional: false },
  ]
  const plan = {
    id: 'plan-vague',
    goal: '说不清的目标',
    allowedTools: [],
    steps,
    declaredAt: '2026-10-31T00:00:00.000Z',
    vagueGoal: true,
    vagueGoalReason: '还没想清楚',
  }
  const windows = [
    { tools: ['edit'], paths: [], results: [] },
    { tools: ['pwsh'], paths: [], results: [{ tool: 'pwsh', ok: true, excerpt: '', outcome: 'tests-pass' }] },
  ]
  const out = scorePlanMatch(plan, windows)
  check('S4 is available for a vague plan', out.score.status === 'available', JSON.stringify(out.score))
  check('S4 scores the steps, not the goal', out.score.status === 'available' && out.score.score === 0, JSON.stringify(out.score))
  check('S4 evidence names both steps', out.score.status === 'available' && out.score.evidence.length === 2, JSON.stringify(out.score))
  check('S4 evidence does not quote the vague goal', out.score.status === 'available' && out.score.evidence.every((line) => !line.includes('说不清的目标')), JSON.stringify(out.score))

  const partial = scorePlanMatch(plan, [{ tools: ['edit'], paths: [], results: [] }, { tools: [], paths: [], results: [] }])
  check('an incomplete vague plan still gets a numeric score', partial.score.status === 'available' && partial.score.score === 0.5, JSON.stringify(partial.score))

  const concretePlan = { ...plan, vagueGoal: false, vagueGoalReason: '' }
  const concreteOut = scorePlanMatch(concretePlan, windows)
  check('a concrete plan scores the same way', concreteOut.score.status === 'available' && concreteOut.score.score === 0, JSON.stringify(concreteOut.score))
}

// ------------------------------------------------------------------ store
console.log('\n[store] a vague verdict is a real record with a null score')
{
  const root = await mkdtemp(join(tmpdir(), 'metacog-vague-store-'))
  try {
    const store = new MetacogStore(root, '.metacog')
    const record = await store.appendVerdict({
      projectId: 'proj-vague',
      at: '2026-10-31T00:05:00.000Z',
      windowStart: '2026-10-31T00:00:00.000Z',
      windowEnd: '2026-10-31T00:05:00.000Z',
      match: null,
      goalId: 'g1',
      reason: '目标模糊，无法可靠判断',
      expectNext: '继续',
      fulfilled: null,
      provider: 'p1',
      model: 'm1',
      elapsedMs: 5,
      inputChars: 100,
      outputChars: 40,
    })
    check('the record accepts a null match', record.match === null, JSON.stringify(record))
    const read = await store.readVerdicts('proj-vague')
    check('the null match survives the round trip', read.length === 1 && read[0].match === null, JSON.stringify(read))
    check('the record keeps the vague reason', read[0].reason === '目标模糊，无法可靠判断')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
