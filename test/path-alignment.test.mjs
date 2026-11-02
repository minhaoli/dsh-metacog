/**
 * F1-R path judgement: a touched path is positive attribution, and "no goal
 * claims this" is `unbound` rather than drift.
 *
 * Two claims are defended here, and they are deliberately different claims:
 *
 *   1. a declared path prefix places an activity on the goal that declared it —
 *      the longest prefix wins, and every goal sharing that prefix is kept;
 *   2. an activity whose paths no goal claims is `unbound`: not `scope_drift`,
 *      no signal, no escalation. "I cannot place this" is not "this is
 *      off-target", and collapsing the two is the false positive this task
 *      exists to remove.
 *
 * Backward compatibility is part of the contract, not a nicety: a tree that
 * declares no paths must judge exactly as it did before path ownership existed,
 * including the drift verdict a grade-A activity used to receive.
 *
 * Run: node test/path-alignment.test.mjs   (after `npm run build`)
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
const { judgeAlignment } = await import(lib('analysis/alignment.js'))
const { runActivityCheck, countLevels } = await import(lib('analysis/service.js'))
const { detectCoreBypass } = await import(lib('analysis/drift.js'))
const { ActivityRecordSchema, AlignmentDecisionSchema } = await import(lib('data/types.js'))

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
const root = await mkdtemp(join(tmpdir(), 'metacog-path-alignment-'))
fixtures.push(root)
await writeFile(join(root, 'README.md'), '# Path judgement\n\nA fixture for path-based alignment.\n')

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
    agent: { id: 'agent-path-alignment' },
  })
}

console.log('\n[fixture] a confirmed tree that declares path ownership')

const confirmArgs = {
  expectedVersion: 0,
  l0: {
    title: '让监控结论可信',
    evidence: ['README.md'],
    paths: ['src'],
    alignment: { relevantActivities: ['root placeholder'] },
  },
  goals: [
    { title: 'Api', evidence: ['README.md'], paths: ['src/api'], relevantActivities: ['api placeholder'], successCriteria: ['each route handler lives in its own module'] },
    { title: 'Ab', evidence: ['README.md'], paths: ['src/ab'], relevantActivities: ['ab placeholder'], successCriteria: ['the short prefix never owns a longer name'] },
    { title: 'PkgAb', evidence: ['README.md'], paths: ['pkg/ab'], relevantActivities: ['pkg placeholder'], successCriteria: ['package aliases follow the same prefix rule'] },
    {
      title: 'Docs',
      evidence: ['README.md'],
      paths: ['docs'],
      relevantActivities: ['docs placeholder'],
      excludedActivities: ['docs work'],
      successCriteria: ['the documentation tree is written as markdown'],
    },
    { title: 'TwinA', evidence: ['README.md'], paths: ['lib/core'], relevantActivities: ['core placeholder'], successCriteria: ['a tied claim keeps every owner'] },
    { title: 'TwinB', evidence: ['README.md'], paths: ['lib/core'], relevantActivities: ['core placeholder'], successCriteria: ['both tied owners are reported'] },
  ],
  contradictions: [],
  reason: 'path judgement fixture',
}
await call('goal_tree_confirm', { ...confirmArgs, preview: true, noDeadlineGoalRefs: ['*'] })
const confirmed = await call('goal_tree_confirm', {
  ...confirmArgs,
  userApproved: true,
  approvalNote: 'path judgement 确认',
})

check('the tree confirms with paths', confirmed.ok === true, JSON.stringify(confirmed).slice(0, 300))

const store = new MetacogStore(root, '.metacog')
const projectId = deriveProjectId(root)
const config = parseConfig({})
const state = await store.readState(projectId)

const goal = (title) => state.goals.find((node) => node.title === title)
const rootGoal = state.goals.find((node) => node.depth === 0)
const judge = (input) => judgeAlignment({ source: 'tool_event', grade: 'A', ...input }, state.goals, config)

check('every goal kept the claim it was given', goal('Api').paths.join() === 'src/api', goal('Api')?.paths.join())
check('the root kept its broad claim', rootGoal.paths.join() === 'src', rootGoal?.paths.join())

console.log('\n[path hit] a declared prefix is positive attribution')

{
  const hit = judge({ summary: '编辑 API 处理器', evidence: ['src/api/handlers.ts'], paths: ['src/api/handlers.ts'] })
  check('a touched path under a declared prefix is aligned', hit.decision === 'aligned', hit.decision)
  check('the claiming goal is named', hit.matchedGoalId === goal('Api').id, hit.matchedGoalId)
  check('the rationale cites the path basis', hit.rationale.includes('path prefix'), hit.rationale)
  check('the binding is reported to the caller', hit.pathBinding?.kind === 'bound')
  check('the binding names the owner', hit.pathBinding?.goalIds.join() === goal('Api').id, hit.pathBinding?.goalIds.join())
  check('no drift verdict is produced', hit.decision !== 'scope_drift')
}

console.log('\n[longest prefix] the narrower claim wins over the broader one')

{
  const deep = judge({ summary: '编辑 API 处理器', evidence: ['src/api/handlers.ts'], paths: ['src/api/handlers.ts'] })
  const shallow = judge({ summary: '改动入口', evidence: ['src/main.ts'], paths: ['src/main.ts'] })
  check('the deeper claim owns the deep path', deep.matchedGoalId === goal('Api').id, deep.matchedGoalId)
  check('a path outside it falls back to the broad claim', shallow.matchedGoalId === rootGoal.id, shallow.matchedGoalId)
  check('the broad claim is not also named as a winner', !deep.pathBinding?.goalIds.includes(rootGoal.id))
}

console.log('\n[many-to-many] a tied prefix keeps every owner')

{
  const tie = judge({ summary: '重构核心', evidence: ['lib/core/x.ts'], paths: ['lib/core/x.ts'] })
  check('both tied goals are candidates', tie.candidateGoalIds.length === 2, tie.candidateGoalIds.join())
  check('the first tied goal is kept', tie.candidateGoalIds.includes(goal('TwinA').id), tie.candidateGoalIds.join())
  check('and so is the second', tie.candidateGoalIds.includes(goal('TwinB').id), tie.candidateGoalIds.join())
  check('one of them is the representative', tie.matchedGoalId === goal('TwinA').id, tie.matchedGoalId)
  check('the rationale says the claim is shared', tie.rationale.includes('other goal'), tie.rationale)
}

console.log('\n[unbound] no claim is not drift')

{
  const loose = judge({ summary: '整理一个临时脚本', evidence: ['scratch/tmp.mjs'], paths: ['scratch/tmp.mjs'] })
  check('an unclaimed path is unbound', loose.decision === 'unbound', loose.decision)
  check('unbound is explicitly NOT scope_drift', loose.decision !== 'scope_drift')
  check('unbound names no goal', loose.candidateGoalIds.length === 0, loose.candidateGoalIds.join())
  check('unbound makes no confidence claim', loose.confidence === 0, String(loose.confidence))
  check('unbound carries no excluded-goal evidence', loose.excludedByGoalId === undefined)
  check('the report names the unclaimed path', loose.pathBinding?.unboundPaths.join() === 'scratch/tmp.mjs', loose.pathBinding?.unboundPaths.join())
  check('the rationale says it is not a drift verdict', loose.rationale.includes('not a drift verdict'), loose.rationale)
}

console.log('\n[partial] one claimed path places the activity, the stray path is reported')

{
  const partial = judge({
    summary: '改动两处',
    evidence: ['src/api/a.ts'],
    paths: ['src/api/a.ts', 'scratch/b.mjs'],
  })
  check('one claimed path is enough to place the activity', partial.decision === 'aligned', partial.decision)
  check('the stray path is still reported', partial.pathBinding?.unboundPaths.join() === 'scratch/b.mjs', partial.pathBinding?.unboundPaths.join())
  check('and it does not add a false owner', partial.pathBinding?.goalIds.join() === goal('Api').id, partial.pathBinding?.goalIds.join())
}

console.log('\n[segment boundary] a prefix must end on a separator')

{
  check('the exact prefix matches', judge({ summary: '编辑 ab', evidence: ['src/ab/x.ts'], paths: ['src/ab/x.ts'] }).matchedGoalId === goal('Ab').id)
  const abc = judge({ summary: '编辑 abc', evidence: ['src/abc/x.ts'], paths: ['src/abc/x.ts'] })
  check('"src/abc" is not claimed by "src/ab"', abc.matchedGoalId !== goal('Ab').id, abc.matchedGoalId)
  check('it falls to the broad "src" claim instead', abc.matchedGoalId === rootGoal.id, abc.matchedGoalId)

  // Without a broader claim the boundary rule is visible on its own.
  const pkgAb = judge({ summary: '编辑 pkg ab', evidence: ['pkg/ab/x.ts'], paths: ['pkg/ab/x.ts'] })
  const pkgAbc = judge({ summary: '编辑 pkg abc', evidence: ['pkg/abc/x.ts'], paths: ['pkg/abc/x.ts'] })
  check('"pkg/ab" claims its own child', pkgAb.matchedGoalId === goal('PkgAb').id, pkgAb.matchedGoalId)
  check('"pkg/abc" is unbound, not misbound', pkgAbc.decision === 'unbound', pkgAbc.decision)
  check('and it is not drift either', pkgAbc.decision !== 'scope_drift')
}

console.log('\n[order] whitelist first, then path, then exclusion')

{
  const whitelistConfig = parseConfig({
    whitelistedActivities: [{ label: '临时脚本', summaryContains: ['临时脚本'] }],
  })
  const whitelisted = judgeAlignment(
    { summary: '整理一个临时脚本', evidence: ['scratch/tmp.mjs'], paths: ['scratch/tmp.mjs'], source: 'manual', grade: 'A' },
    state.goals,
    whitelistConfig,
  )
  check('the whitelist outranks path ownership', whitelisted.decision === 'aligned', whitelisted.decision)
  check('and unbound never overrides it', whitelisted.decision !== 'unbound')
  check('the whitelist label is echoed', whitelisted.whitelistLabel === '临时脚本', whitelisted.whitelistLabel)

  const claimed = judge({ summary: 'docs work', evidence: ['docs/a.md'], paths: ['docs/a.md'] })
  check('a path claim outranks an exclusion keyword', claimed.decision === 'aligned', claimed.decision)
  check('the docs owner is the one credited', claimed.matchedGoalId === goal('Docs').id, claimed.matchedGoalId)

  const unclaimed = judge({ summary: 'docs work', evidence: ['docs/a.md'] })
  check('without the claim the same activity is drift', unclaimed.decision === 'scope_drift', unclaimed.decision)
  check('and the exclusion is what names it', unclaimed.excludedByGoalId === goal('Docs').id, unclaimed.excludedByGoalId)
}

console.log('\n[backward compatible] a tree that declares no paths judges as before')

{
  const legacyGoals = state.goals.map((node) => ({ ...node, paths: [] }))
  const withPaths = judgeAlignment(
    { summary: '整理一个临时脚本', evidence: ['scratch/tmp.mjs'], paths: ['scratch/tmp.mjs'], source: 'manual', grade: 'A' },
    legacyGoals,
    config,
  )
  const withoutPaths = judgeAlignment(
    { summary: '整理一个临时脚本', evidence: ['scratch/tmp.mjs'], source: 'manual', grade: 'A' },
    legacyGoals,
    config,
  )
  check('a path-less tree ignores the touched paths entirely', withPaths.pathBinding === undefined)
  check('and keeps the verdict it gave before', withPaths.decision === 'scope_drift', withPaths.decision)
  check('which is the same verdict as no paths at all', withPaths.decision === withoutPaths.decision)
  check('the rationale is unchanged too', withPaths.rationale === withoutPaths.rationale)
  check('the confidence is unchanged too', withPaths.confidence === withoutPaths.confidence)

  // An activity with no file of its own is untouched by any of this.
  const noFiles = judgeAlignment(
    { summary: '读了一遍论文', evidence: [], source: 'user_input', grade: 'B' },
    state.goals,
    config,
  )
  check('an activity without paths keeps the old fallback', noFiles.decision === 'uncertain', noFiles.decision)
  check('and reports no binding', noFiles.pathBinding === undefined)
}

console.log('\n[service] unbound is recorded, never escalated')

{
  const outcome = await runActivityCheck(
    store,
    state,
    projectId,
    {
      summary: '整理一个临时脚本',
      evidence: ['scratch/tmp.mjs'],
      paths: ['scratch/tmp.mjs'],
      source: 'tool_event',
      grade: 'A',
      sessionId: 'session-path',
      eventFingerprint: 'fp-unbound-1',
    },
    config,
  )

  check('the verdict reaches the caller', outcome.verdict?.decision === 'unbound', outcome.verdict?.decision)
  check('the record keeps the unbound decision', outcome.activity.decision === 'unbound', outcome.activity.decision)
  check('the record is not scope_drift', outcome.activity.decision !== 'scope_drift')
  check('no signal is produced', outcome.signals.length === 0, String(outcome.signals.length))
  check('no intervention is opened', outcome.interventions.length === 0, String(outcome.interventions.length))
  check('no level-1 hint is injected', outcome.level1Hints.length === 0, String(outcome.level1Hints.length))
  check('every level count stays zero', Object.values(countLevels(outcome.signals)).every((count) => count === 0))
  check('nothing reaches the signal log on disk', (await store.readSignals(projectId)).length === 0)
  check('the candidate goals stay empty', outcome.activity.candidateGoalIds.length === 0)

  // Persistence is the point of the fifth enum value. While `unbound` had to be
  // written as `uncertain`, the record could not answer "how many activities
  // could no goal claim" — the one number that tells a reader whether the tree
  // should register more paths. Reading it back is what proves it now can.
  const reread = (await store.readActivities(projectId)).find((item) => item.id === outcome.activity.id)
  check('unbound survives a round trip through the store', reread?.decision === 'unbound', reread?.decision)
  check(
    'and the persisted record still validates against the schema',
    ActivityRecordSchema.safeParse(reread).success === true,
  )
  check('the verdict and the record agree on the word', reread?.decision === outcome.verdict?.decision)

  // The contrast is what makes the guarantee meaningful: the same activity text,
  // without a path claim to place it, still reaches the drift detector.
  const drifted = await runActivityCheck(
    store,
    state,
    projectId,
    {
      summary: '整理一个临时脚本',
      evidence: ['scratch/tmp.mjs'],
      source: 'tool_event',
      grade: 'A',
      sessionId: 'session-path',
      eventFingerprint: 'fp-unbound-2',
    },
    config,
  )
  check('the same activity without paths is still drift', drifted.verdict?.decision === 'scope_drift', drifted.verdict?.decision)
  check(
    'and does produce a scope_drift signal',
    drifted.signals.some((entry) => entry.signal.signalType === 'scope_drift'),
    String(drifted.signals.length),
  )

  // A placed activity is aligned end to end, and equally silent.
  const placed = await runActivityCheck(
    store,
    state,
    projectId,
    {
      summary: '编辑 API 处理器',
      evidence: ['src/api/handlers.ts'],
      paths: ['src/api/handlers.ts'],
      source: 'tool_event',
      grade: 'A',
      sessionId: 'session-path',
      eventFingerprint: 'fp-bound-1',
    },
    config,
  )
  check('a placed activity is aligned end to end', placed.verdict?.decision === 'aligned', placed.verdict?.decision)
  check('the record keeps the aligned decision', placed.activity.decision === 'aligned', placed.activity.decision)
  check('the claiming goal is on the record', placed.activity.candidateGoalIds.includes(goal('Api').id))
  check('and it escalates nothing either', placed.signals.length === 0, String(placed.signals.length))
}

console.log('\n[compatibility] records written before the fifth value still read')

{
  const stored = (await store.readActivities(projectId)).find((item) => item.decision === 'unbound')
  check('the unbound record reached the disk', stored !== undefined)

  // The migration story is "none": a record written before the enum grew cannot
  // be re-judged, and a historical `uncertain` may or may not have been an
  // unbound activity. Guessing would fabricate data, so the old row is read
  // exactly as it was written.
  const legacy = { ...stored, decision: 'uncertain' }
  check('a legacy four-value record still parses', ActivityRecordSchema.safeParse(legacy).success === true)
  check(
    'and keeps the word it was written with',
    ActivityRecordSchema.safeParse(legacy).data?.decision === 'uncertain',
  )
  for (const value of ['aligned', 'exploratory', 'scope_drift', 'uncertain']) {
    check(`"${value}" is still accepted`, AlignmentDecisionSchema.safeParse(value).success === true)
  }
  check('unbound is accepted too', AlignmentDecisionSchema.safeParse('unbound').success === true)
  check('a word the enum never had is still refused', AlignmentDecisionSchema.safeParse('drift').success === false)
}

/**
 * A confirmed core contradiction at maximum intensity.
 *
 * Built by hand so the bypass detector has every reason to fire and the only
 * variable left is which activities it is shown.
 */
function blockingContradiction(now, primaryGoalId) {
  return {
    id: 'c_known_defect',
    title: '速度与证据严格性',
    type: 'core',
    poleA: '更快落地',
    poleB: '更严证据',
    primaryGoalId,
    relatedGoalIds: [],
    confirmedByUser: true,
    intensity: 5,
    evidence: ['README.md'],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
}

console.log('\n[known defect] `uncertain` with no candidate goals counts as avoidance')

// Pinned, not endorsed. `drift.ts` keeps an avoiding activity with
// `return !candidateGoalIds.some((id) => goalIds.has(id))`, while the comment
// directly above it claims the opposite ("kept unless they positively point at
// a goal the contradiction binds"). An `uncertain` record that names no goal is
// therefore read as evidence that the project avoided the contradiction, and
// repeats of it can reach the Level 2 card.
//
// This predates `unbound` and is deliberately not fixed here: changing the
// predicate changes escalation semantics and needs its own review. `unbound` is
// kept out of that detector at the call site in `service.ts`, so it adds nothing
// to this count. When the predicate is corrected, this assertion is expected to
// flip — it is here so that change is a deliberate act rather than a surprise.
{
  const now = new Date()
  const contradiction = blockingContradiction(now, state.goals[0].id)
  const uncertainRecords = Array.from({ length: config.thresholds.repeatThreshold }, (_, index) => ({
    id: `act_uncertain_${index}`,
    eventFingerprint: `fp-uncertain-${index}`,
    projectId,
    sessionId: 'session-known-defect',
    timestamp: now.toISOString(),
    source: 'tool_event',
    observationGrade: 'C',
    summary: `无法判定的活动 ${index}`,
    evidence: ['notes/unknown.md'],
    candidateGoalIds: [],
    alignmentConfidence: null,
    decision: 'uncertain',
    rationale: 'grade C leaves nothing to judge',
  }))

  const bypass = detectCoreBypass({
    state: { ...state, contradictions: [contradiction] },
    activities: uncertainRecords,
    observations: [],
    signals: [],
    config,
    now,
  })
  check('the predicate counts uncertain-with-no-goals as avoidance', bypass.length === 1, String(bypass.length))
  check(
    'and names every one of them as evidence',
    bypass[0]?.activityIds.length === config.thresholds.repeatThreshold,
    String(bypass[0]?.activityIds.length),
  )
}

console.log('\n[core_bypass] unbound activities are withheld from the avoidance count')

{
  // A separate project so the count is exactly the activities this block writes:
  // the earlier blocks left a scope_drift record behind, which legitimately
  // counts as avoidance and would blur the contrast.
  const bypassRoot = await mkdtemp(join(tmpdir(), 'metacog-unbound-bypass-'))
  fixtures.push(bypassRoot)
  const bypassStore = new MetacogStore(bypassRoot, '.metacog')
  const bypassProjectId = deriveProjectId(bypassRoot)

  const now = new Date()
  const contradiction = blockingContradiction(now, state.goals[0].id)
  const blockingState = { ...state, contradictions: [contradiction] }

  let last
  for (let n = 1; n <= config.thresholds.repeatThreshold; n += 1) {
    last = await runActivityCheck(
      bypassStore,
      blockingState,
      bypassProjectId,
      {
        summary: `整理临时脚本 ${n}`,
        evidence: [`scratch/tmp-${n}.mjs`],
        paths: [`scratch/tmp-${n}.mjs`],
        source: 'tool_event',
        grade: 'A',
        sessionId: 'session-unbound-bypass',
        eventFingerprint: `fp-unbound-bypass-${n}`,
      },
      config,
    )
    check(`run ${n} is unbound`, last.verdict?.decision === 'unbound', last.verdict?.decision)
  }

  // The counterfactual is what makes the guarantee falsifiable: handed these
  // same records directly, the detector does fire. The call site is therefore
  // load-bearing, not decoration.
  const counterfactual = detectCoreBypass({
    state: blockingState,
    activities: await bypassStore.readActivities(bypassProjectId),
    observations: [],
    signals: [],
    config,
    now,
  })
  check('the detector would fire on them if it saw them', counterfactual.length === 1, String(counterfactual.length))
  check(
    'but the service never lets them reach it',
    last.signals.every((entry) => entry.signal.signalType !== 'core_bypass'),
    JSON.stringify(last.signals.map((entry) => entry.signal.signalType)),
  )
  // `contradiction_shift` is expected here and is not the activity's doing: the
  // fixture contradiction sits at intensity 5, which `detectContradictionPressure`
  // reports for any activity at all. (The run's activity id is attached to every
  // draft as context, so "carries the id" is not a discriminator either.) The
  // claim worth asserting is that neither of the two verdicts that would blame
  // the activity is ever raised.
  check(
    'no signal blames the unbound activity',
    last.signals.every(
      (entry) => entry.signal.signalType !== 'core_bypass' && entry.signal.signalType !== 'scope_drift',
    ),
    JSON.stringify(last.signals.map((entry) => entry.signal.signalType)),
  )
  check(
    'and no card is opened against the activity',
    last.interventions.every((entry) => !(entry.activityIds ?? []).includes(last.activity.id)),
    JSON.stringify(last.interventions.map((entry) => entry.id)),
  )
}

for (const fixture of fixtures) await rm(fixture, { recursive: true, force: true })

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
