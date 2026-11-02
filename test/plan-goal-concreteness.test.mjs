/**
 * A session goal has to name something that can be checked.
 *
 * The reason this is a gate rather than a style hint: S4 compares the plan's
 * steps against this sentence, and the periodic model review uses it as the
 * thing the work is measured against. "推进项目" gives both of them nothing, so
 * every step matches equally and nothing can be called off-target. The check is
 * deliberately generous — any one of path, tool, deliverable noun or measurable
 * result is enough — because refusing real work is worse than accepting one
 * vague goal.
 *
 * The escape hatch is tested as carefully as the rule. A vague goal can be
 * accepted, but only with a reason and with the plan marked, so it can never be
 * a silent bypass.
 *
 * Run: node test/plan-goal-concreteness.test.mjs   (after `npm run build`)
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
const { assessGoalConcreteness } = await import(lib('analysis/collapse.js'))

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
const root = await mkdtemp(join(tmpdir(), 'metacog-goal-concreteness-'))
fixtures.push(root)
await writeFile(join(root, 'README.md'), '# Goal concreteness\n\nA fixture for plan goals.\n')

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
    agent: { id: 'agent-goal-concreteness' },
  })
}

const projectId = deriveProjectId(root)

// ------------------------------------------------------------ the judgement

console.log('\n[P1] the reusable verdict')

{
  for (const vague of ['推进项目', '继续优化', '完善一下']) {
    const verdict = assessGoalConcreteness(vague)
    check(`「${vague}」is not concrete`, verdict.concrete === false, JSON.stringify(verdict))
    check(`and says why`, typeof verdict.reason === 'string' && verdict.reason.length > 0, JSON.stringify(verdict))
  }

  for (const concrete of [
    '给 src/api.ts 加 /models 端点的测试',
    '把 F5 的推导改造拆成可执行条目并派发',
    '改 `src/analysis/collapse.ts` 里的词表归一化',
    '写一份迁移报告',
    '把构建时间降到 30 秒以内',
    '用 metacog_declare_plan 补上计划声明',
  ]) {
    const verdict = assessGoalConcreteness(concrete)
    check(`「${concrete}」passes`, verdict.concrete === true, JSON.stringify(verdict))
  }

  // Each concrete signal on its own is enough — these differ only in which one.
  check('a path alone is enough', assessGoalConcreteness('改 src/a.ts').concrete === true)
  check('a deliverable noun alone is enough', assessGoalConcreteness('整理清单').concrete === true)
  check('a measurable result alone is enough', assessGoalConcreteness('把失败用例降到 0').concrete === true)
  check('a tool name alone is enough', assessGoalConcreteness('用 pwsh 跑一遍').concrete === true)

  // Verb + placeholder is exactly the shape being rejected.
  check('a verb plus a placeholder is not enough', assessGoalConcreteness('处理一下项目').concrete === false)

  // An identifier names something a reviewer can point at, even inside a prose
  // sentence. A bare English word does not — otherwise every English sentence
  // would pass, which is the loophole this check exists to close.
  check('an identifier makes a prose goal concrete', assessGoalConcreteness('S4 的窗口切分改成贪心').concrete === true)
  check('a tool name in prose is concrete too', assessGoalConcreteness('declare_plan 的 goal 校验').concrete === true)
  check('a quoted term counts', assessGoalConcreteness('把「窗口切分」改成贪心').concrete === true)
  check('a generic noun does not', assessGoalConcreteness('优化功能').concrete === false)
  check('nor does another one', assessGoalConcreteness('改进逻辑').concrete === false)
  check('a bare English word is not an identifier', assessGoalConcreteness('improve things').concrete === false)
  check('an empty goal is not concrete', assessGoalConcreteness('').concrete === false)
  check('and says it is empty', String(assessGoalConcreteness('').reason).includes('空'))

  // Length threshold: below 8 Han characters the reason is length, at 8 it is
  // the absence of anything checkable. Both are refusals, the fix differs.
  const short = assessGoalConcreteness('把东西弄好一点')
  const long = assessGoalConcreteness('把东西都弄好一点')
  check('seven characters is too short', short.concrete === false && String(short.reason).includes('7 个字'), JSON.stringify(short))
  check(
    'eight characters fails for the other reason',
    long.concrete === false && String(long.reason).includes('没有可验证的对象'),
    JSON.stringify(long),
  )
  check('a short goal with a real object still passes', assessGoalConcreteness('跑测试').concrete === true)
}

// ------------------------------------------------------------- declare_plan

console.log('\n[P2] declare_plan refuses a goal nobody can check')

{
  for (const vague of ['推进项目', '继续优化', '完善一下']) {
    const result = await call('metacog_declare_plan', { goal: vague })
    check(`「${vague}」is refused`, result.ok === false && result.error?.code === 'GOAL_NOT_CONCRETE', JSON.stringify(result).slice(0, 200))
  }

  const refused = await call('metacog_declare_plan', { goal: '推进项目' })
  const message = String(refused.error?.message ?? '')
  check('the message says what is missing', message.includes('泛词'), message)
  check('and gives a rewrite shape', message.includes('src/api.ts'), message)
  check('and points at the goal tree', message.includes('目标树'), message)
  check('and names the escape hatch', message.includes('allowVagueGoal'), message)

  const accepted = await call('metacog_declare_plan', {
    goal: '给 src/api.ts 加 /models 端点的测试',
    steps: [{ intent: '写测试', expects: { tool: 'edit' } }],
  })
  check('a concrete goal is accepted', accepted.ok === true, JSON.stringify(accepted).slice(0, 300))
  check('and the note carries no vagueness warning', !String(accepted.data?.note).includes('allowVagueGoal'), accepted.data?.note)

  // The escape hatch, both halves.
  const noReason = await call('metacog_declare_plan', { goal: '推进项目', allowVagueGoal: true })
  check(
    'the escape hatch without a reason is refused',
    noReason.ok === false && noReason.error?.code === 'REASON_REQUIRED',
    JSON.stringify(noReason).slice(0, 200),
  )

  const escaped = await call('metacog_declare_plan', {
    goal: '推进项目',
    allowVagueGoal: true,
    reason: '探索性会话，先看看项目现状再定目标',
  })
  check('with a reason it is accepted', escaped.ok === true, JSON.stringify(escaped).slice(0, 300))
  check('and the acceptance is announced, not silent', String(escaped.data?.note).includes('模糊'), escaped.data?.note)
  // The mark is persisted, not just announced: a downstream reader (S4, the
  // model review, the "what are you doing today" prompt) must be able to learn
  // that this goal is weak without re-running the judgement.
  check('and the plan carries the mark', escaped.data?.plan?.vagueGoal === true, JSON.stringify(escaped.data?.plan))
  check(
    'with the reason recorded',
    String(escaped.data?.plan?.vagueGoalReason).includes('探索性'),
    escaped.data?.plan?.vagueGoalReason,
  )
  check('a concrete plan is not marked', accepted.data?.plan?.vagueGoal === false, JSON.stringify(accepted.data?.plan))
}

// -------------------------------------------------------- the linked goal

console.log('\n[P2] a linked goal supplies the rewrite suggestion')

{
  const confirmArgs = {
    expectedVersion: 0,
    l0: { title: '让监控结论可信', evidence: ['README.md'], alignment: { relevantActivities: ['root placeholder'] } },
    goals: [
      {
        title: '把路径归属接进判定',
        evidence: ['README.md'],
        relevantActivities: ['path placeholder'],
        successCriteria: ['unbound 不再落入 scope_drift'],
      },
    ],
    contradictions: [],
    reason: 'goal concreteness fixture',
  }
  await call('goal_tree_confirm', { ...confirmArgs, preview: true, noDeadlineGoalRefs: ['*'] })
  const confirmed = await call('goal_tree_confirm', {
    ...confirmArgs,
    userApproved: true,
    approvalNote: 'goal concreteness 确认',
  })
  check('the tree confirms', confirmed.ok === true, JSON.stringify(confirmed).slice(0, 200))
  // Read the id from the store rather than the tool result: the confirm receipt
  // does not carry the whole tree, and guessing at its shape would make this
  // test pass for the wrong reason.
  const store = new MetacogStore(root, '.metacog')
  const leafId = (await store.readState(projectId))?.goals.find((goal) => goal.depth === 1)?.id
  check('the leaf has an id', typeof leafId === 'string', String(leafId))

  const refused = await call('metacog_declare_plan', { goal: '继续优化', linkedGoalId: leafId })
  check('a vague goal with a linked node is refused', refused.ok === false && refused.error?.code === 'GOAL_NOT_CONCRETE')
  check(
    'and the suggestion quotes the node title',
    String(refused.error?.message).includes('把路径归属接进判定'),
    refused.error?.message,
  )
}

// -------------------------------------------------------------- revise_plan

console.log('\n[P3] revise_plan cannot be used to slip past the check')

{
  const declared = await call('metacog_declare_plan', {
    goal: '给 src/api.ts 加 /models 端点的测试',
    allowedTools: ['edit'],
    steps: [{ intent: '写测试', expects: { tool: 'edit' } }],
  })
  check('a concrete plan is in force', declared.ok === true, JSON.stringify(declared).slice(0, 200))

  const vagueRevision = await call('metacog_revise_plan', { goal: '继续优化', reason: '目标调整' })
  check(
    'changing the goal to a vague one is refused',
    vagueRevision.ok === false && vagueRevision.error?.code === 'GOAL_NOT_CONCRETE',
    JSON.stringify(vagueRevision).slice(0, 200),
  )

  const toolOnly = await call('metacog_revise_plan', { allowedTools: ['edit', 'pwsh'], reason: '需要跑测试' })
  check('changing only allowedTools is not re-judged', toolOnly.ok === true, JSON.stringify(toolOnly).slice(0, 300))
  check('and the goal is untouched', toolOnly.data?.plan?.goal === '给 src/api.ts 加 /models 端点的测试', toolOnly.data?.plan?.goal)

  const stepOnly = await call('metacog_revise_plan', {
    steps: [
      { intent: '写测试', expects: { tool: 'edit' } },
      { intent: '跑测试', expects: { tool: 'pwsh' } },
    ],
    reason: '补一步',
  })
  check('changing only steps is not re-judged', stepOnly.ok === true, JSON.stringify(stepOnly).slice(0, 300))

  const vagueWithReason = await call('metacog_revise_plan', {
    goal: '继续优化',
    reason: '需求还没定，先保持模糊',
    allowVagueGoal: true,
  })
  check('a vague revision with the hatch is accepted', vagueWithReason.ok === true, JSON.stringify(vagueWithReason).slice(0, 300))
  check('and announced', String(vagueWithReason.data?.note).includes('模糊'), vagueWithReason.data?.note)
  check('and the revised plan carries the mark', vagueWithReason.data?.plan?.vagueGoal === true, JSON.stringify(vagueWithReason.data?.plan))

  // A later revision that does not touch the goal must keep the mark: dropping
  // it would let a second call quietly turn a known-weak goal into a normal one.
  const afterVague = await call('metacog_revise_plan', { allowedTools: ['edit'], reason: '只调白名单' })
  check(
    'a revision that leaves the goal alone keeps the mark',
    afterVague.data?.plan?.vagueGoal === true,
    JSON.stringify(afterVague.data?.plan),
  )
  check(
    'and keeps the reason with it',
    String(afterVague.data?.plan?.vagueGoalReason).includes('需求还没定'),
    afterVague.data?.plan?.vagueGoalReason,
  )

  const vagueNoReason = await call('metacog_revise_plan', {
    goal: '完善一下',
    reason: '   ',
  })
  check(
    'a revision still needs its own reason',
    vagueNoReason.ok === false && vagueNoReason.error?.code === 'MISSING_REASON',
    JSON.stringify(vagueNoReason).slice(0, 200),
  )
}

for (const fixture of fixtures) await rm(fixture, { recursive: true, force: true })

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
