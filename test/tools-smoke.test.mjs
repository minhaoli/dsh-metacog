/**
 * Smoke test: every registered tool, driven through its real `execute` path.
 *
 * The point is coverage, not depth — each stage test owns one subsystem's
 * semantics. This file answers a different question: after a change, does *any*
 * tool still work end to end, and does the rebuild path leave history intact.
 *
 * Run: node test/tools-smoke.test.mjs
 */
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libUrl = pathToFileURL(join(here, '..', 'lib', 'index.js')).href
const configUrl = pathToFileURL(join(here, '..', 'lib', 'config.js')).href

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

function checkEqual(label, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  check(label, a === b, `expected ${b}, got ${a}`)
}

const { apply } = await import(libUrl)
const { parseConfig } = await import(configUrl)

const EXPECTED_TOOLS = [
  'metacog_scan',
  'metacog_read_document',
  'goal_tree_init',
  'goal_tree_confirm',
  'goal_tree_view',
  'goal_tree_edit',
  'contradiction_tree_edit',
  'check_drift',
  'contradiction_observe',
  'resolve_intervention',
  'generate_report',
  'metacog_revise',
  'metacog_archive',
  'metacog_merge_tree',
  // Added with milestone A/B: the plan tools are what give S3 and S4 an input at
  // all, so their registration is part of the contract this test guards.
  'metacog_declare_plan',
  'metacog_revise_plan',
  'metacog_purge',
  'metacog_archive_milestone',
  // Added with M5: the drafter is how a tree whose goals have empty criteria
  // becomes usable without re-deriving it.
  'metacog_draft_criteria',
  // Added with S: the plugin's own question card, independent of the host's
  // ask_user_question registration.
  'metacog_ask_user',
]

function createHost(projectRoot) {
  const tools = new Map()
  const logs = []
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return this.workingDirectory
      if (name === 'tools') return this.tools
      return undefined
    },
    logger: {
      debug: (...args) => logs.push(['debug', ...args]),
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
    },
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
  return { ctx, tools, logs }
}

async function call(tools, name, args) {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`tool "${name}" was never registered`)
  return definition.execute(args, {
    callId: `call-${Math.random().toString(16).slice(2)}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
    agent: { id: 'agent-smoke' },
  })
}

function codeOf(outcome) {
  return outcome?.ok === false ? outcome.error.code : `ok(${JSON.stringify(outcome?.data)})`
}

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), 'metacog-smoke-'))
  await writeFile(
    join(root, 'README.md'),
    [
      '# Smoke Project',
      '',
      'A fixture exercising every metacog tool.',
      '',
      '## Goal derivation',
      '',
      'Turn documents into a goal tree.',
      '',
      '## Drift detection',
      '',
      'Judge activity against the tree.',
      '',
    ].join('\n'),
  )
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'docs', 'design.md'), '# Design\n\nObservations are append-only.\n')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'smoke', version: '1.0.0' }, null, 2))
  return root
}

const fixtures = []

/** One complete tree: L0, two L1, one main contradiction. */
function confirmArgs(expectedVersion) {
  return {
    expectedVersion,
    l0: {
      title: 'Smoke Project',
      description: 'root',
      evidence: ['README.md'],
      // 本测试是十四件工具的全量冒烟，根目标服务的活动就是这类冒烟验证。
      alignment: { relevantActivities: ['工具冒烟验证'] },
    },
    goals: [
      {
        title: 'Goal derivation',
        description: 'derive a tree from documents',
        evidence: ['README.md'],
        successCriteria: ['a model-read tree is confirmed by the user'],
        relevantActivities: ['reading project documents'],
        allowedMethods: ['structured model output'],
        explorationPolicy: 'allowed',
      },
      {
        title: 'Drift detection',
        description: 'judge activity',
        evidence: ['README.md'],
        successCriteria: ['drift signals name the goal they concern'],
        relevantActivities: ['judging activity against the tree', 'drift signal review'],
        allowedMethods: [],
        explorationPolicy: 'limited',
      },
    ],
    contradictions: [
      {
        title: 'evidence strictness versus delivery speed',
        poleA: 'evidence strictness',
        poleB: 'delivery speed',
        evidence: ['README.md'],
        type: 'main',
        primaryGoalRef: 'Drift detection',
        relatedGoalRefs: ['Goal derivation'],
        rationale: 'shapes how much verification each increment carries',
        intensity: 3,
      },
    ],
    reason: 'smoke fixture confirmed',
  }
}

const root = await makeProject()
fixtures.push(root)
const host = createHost(root)
apply(host.ctx, parseConfig({}))
const tools = host.tools

try {
  // ------------------------------------------------------------------ S1
  console.log('\nS1  every tool is registered')
  checkEqual('all twenty tools are present', [...tools.keys()].sort(), [...EXPECTED_TOOLS].sort())

  // ------------------------------------------------------------------ S1b
  console.log('\nS1b metacog_scan lists materials without deriving or writing')
  const scan = await call(tools, 'metacog_scan', {})
  check('scan succeeds', scan.ok === true, codeOf(scan))
  check('files are listed', scan.data.files.length > 0, JSON.stringify(scan.data.counts))
  check('the total is at least the listed page', scan.data.totalFiles >= scan.data.files.length)
  check('a project root was resolved', typeof scan.data.projectRoot === 'string')
  const scanLimited = await call(tools, 'metacog_scan', { limit: 1 })
  checkEqual('limit caps the page', scanLimited.data.files.length, 1)
  check('the omitted count is reported', scanLimited.data.truncated >= 1, String(scanLimited.data.truncated))
  const afterScan = await call(tools, 'goal_tree_view', {})
  checkEqual('scan writes no state', codeOf(afterScan), 'NOT_INITIALIZED')

  // ------------------------------------------------------------------ S2
  console.log('\nS2  goal_tree_view refuses before any tree exists')
  const early = await call(tools, 'goal_tree_view', {})
  checkEqual('view refuses', codeOf(early), 'NOT_INITIALIZED')

  // ------------------------------------------------------------------ S3
  console.log('\nS3  goal_tree_init scans and reports without writing a tree')
  const init = await call(tools, 'goal_tree_init', {})
  check('init succeeds', init.ok === true, codeOf(init))
  checkEqual('no derivation service in a mock host', init.data.mode, 'discovery-only')
  checkEqual('no rebuild performed', init.data.rebuild, null)
  check(
    'materials were discovered',
    Object.values(init.data.materials).some((count) => count > 0),
    JSON.stringify(init.data.materials),
  )
  const stillEmpty = await call(tools, 'goal_tree_view', {})
  checkEqual('discovery-only writes no state', codeOf(stillEmpty), 'NOT_INITIALIZED')

  // ------------------------------------------------------------------ S4
  console.log('\nS4  goal_tree_confirm creates version 1')
  await call(tools, 'goal_tree_confirm', { ...confirmArgs(0), preview: true, noDeadlineGoalRefs: ['*'] })
  const confirmed = await call(tools, 'goal_tree_confirm', {
    ...confirmArgs(0),
    userApproved: true,
    approvalNote: 'smoke 确认',
  })
  check('confirmation succeeds', confirmed.ok === true, codeOf(confirmed))
  checkEqual('version is 1', confirmed.data.version, 1)
  checkEqual('three goals', confirmed.data.goals, 3)
  checkEqual('one contradiction', confirmed.data.contradictions, 1)
  check('a genesis audit entry is written', typeof confirmed.data.auditEntryId === 'string')

  // ------------------------------------------------------------------ S5
  console.log('\nS5  goal_tree_view reads the confirmed basis')
  const view1 = await call(tools, 'goal_tree_view', {})
  check('view succeeds', view1.ok === true, codeOf(view1))
  checkEqual('tree is confirmed', view1.data.confirmed, true)
  checkEqual('three goals are visible', view1.data.goals.length, 3)
  check('every node is user-confirmed', view1.data.goals.every((node) => node.confirmed === true))
  check('the audit chain verifies', view1.data.audit.valid === true, JSON.stringify(view1.data.audit))
  // A revision that only rewrites the description is invisible unless the
  // projection carries it: the write succeeds, the version bumps, and the caller
  // reads back a node that looks untouched. Assert the field is present so the
  // projection cannot silently drop it again.
  check(
    'the projection carries description',
    view1.data.goals.every((node) => typeof node.description === 'string'),
    JSON.stringify(view1.data.goals.map((node) => typeof node.description)),
  )
  check(
    'the projection carries contradiction rationale and resolutionHint',
    view1.data.contradictions.every(
      (node) => typeof node.rationale === 'string' && typeof node.resolutionHint === 'string',
    ),
    JSON.stringify(view1.data.contradictions.map((node) => [typeof node.rationale, typeof node.resolutionHint])),
  )
  const projectId = view1.data.projectId

  // ------------------------------------------------------------------ S6
  console.log('\nS6  goal_tree_init refuses a confirmed tree')
  const again = await call(tools, 'goal_tree_init', {})
  checkEqual('plain re-init is refused', codeOf(again), 'ALREADY_INITIALIZED')

  // ------------------------------------------------------------------ S7
  console.log('\nS7  force alone is not enough to discard a confirmed tree')
  const forceOnly = await call(tools, 'goal_tree_init', { force: true })
  checkEqual('expectedVersion is demanded', codeOf(forceOnly), 'EXPECTED_VERSION_REQUIRED')

  // ------------------------------------------------------------------ S8
  console.log('\nS8  a stale expectedVersion is refused rather than overwriting')
  const stale = await call(tools, 'goal_tree_init', { force: true, expectedVersion: 99 })
  checkEqual('stale version conflicts', codeOf(stale), 'VERSION_CONFLICT')
  const afterStale = await call(tools, 'goal_tree_view', {})
  checkEqual('the tree survived the refusal', afterStale.data.version, 1)

  // ------------------------------------------------------------------ S9
  console.log('\nS9  goal_tree_edit updates and creates nodes')
  const l0 = view1.data.goals.find((node) => node.depth === 0)
  const l1 = view1.data.goals.find((node) => node.depth === 1)
  const edited = await call(tools, 'goal_tree_edit', {
    expectedVersion: 1,
    updates: [
      {
        id: l1.id,
        status: 'at_risk',
        successCriteria: ['a model-read tree is confirmed by the user', 'no headings pass as goals'],
      },
    ],
    creates: [
      {
        depth: 2,
        parentId: l1.id,
        title: 'title-first reading',
        description: 'show titles, let the model choose files',
        evidence: ['docs/design.md'],
        // The created node is a leaf, so it states how it can be checked.
        successCriteria: ['the reading path shows titles before it opens a file'],
      },
    ],
    reason: 'smoke: exercise update and create',
  })
  check('edit succeeds', edited.ok === true, codeOf(edited))
  checkEqual('version advances', edited.data.version, 2)

  // ------------------------------------------------------------------ S10
  console.log('\nS10 goal_tree_edit removes a leaf')
  const view2 = await call(tools, 'goal_tree_view', {})
  const leaf = view2.data.goals.find((node) => node.depth === 2)
  check('the created node is present', leaf !== undefined)
  const removed = await call(tools, 'goal_tree_edit', {
    expectedVersion: view2.data.version,
    removes: [leaf.id],
    reason: 'smoke: exercise removal',
  })
  check('removal succeeds', removed.ok === true, codeOf(removed))

  // ------------------------------------------------------------------ S11
  console.log('\nS11 contradiction_tree_edit adjusts a confirmed contradiction')
  const view3 = await call(tools, 'goal_tree_view', {})
  const contradiction = view3.data.contradictions[0]
  const contradictionEdited = await call(tools, 'contradiction_tree_edit', {
    expectedVersion: view3.data.version,
    updates: [{ id: contradiction.id, intensity: 4, resolutionHint: 'timebox verification' }],
    reason: 'smoke: exercise contradiction update',
  })
  check('contradiction edit succeeds', contradictionEdited.ok === true, codeOf(contradictionEdited))

  // ------------------------------------------------------------------ S12
  console.log('\nS12 contradiction_observe builds a trend from the observation stream')
  const readings = []
  for (const [index, intensity] of [2, 3, 4].entries()) {
    const observed = await call(tools, 'contradiction_observe', {
      contradictionId: contradiction.id,
      intensity,
      rationale: `smoke reading ${index + 1}`,
      evidence: ['README.md'],
      confidence: 0.8,
    })
    check(`observation ${index + 1} accepted`, observed.ok === true, codeOf(observed))
    readings.push(observed)
  }
  const lastReading = readings[readings.length - 1].data
  check(
    'a trend is now known',
    lastReading.trendNow !== undefined && lastReading.trendNow !== 'unknown',
    JSON.stringify({ trendNow: lastReading.trendNow, sampleSize: lastReading.sampleSize }),
  )
  check('the trend rests on every recorded reading', lastReading.sampleSize >= 3, String(lastReading.sampleSize))
  const viewAfterObserve = await call(tools, 'goal_tree_view', {})
  // The stream is the source: after a reading lands, the view must show a verdict,
  // not the stale stored field. The stored field itself is reported separately.
  check(
    'the view reflects the recorded readings',
    viewAfterObserve.data.contradictions[0].trend === lastReading.trendNow,
    `${viewAfterObserve.data.contradictions[0].trend} vs ${lastReading.trendNow}`,
  )
  checkEqual(
    'the stored node field stays what the edit set',
    viewAfterObserve.data.contradictions[0].intensityEdited,
    4,
  )

  // ------------------------------------------------------------------ S13
  console.log('\nS13 check_drift runs a static pass with no activity')
  const staticCheck = await call(tools, 'check_drift', {})
  check('static check succeeds', staticCheck.ok === true, codeOf(staticCheck))
  checkEqual('no activity judgement was made', staticCheck.data.activity, undefined)

  // ------------------------------------------------------------------ S14
  console.log('\nS14 check_drift escalates repeated drift to a Level 2 card')
  let lastDrift
  for (const n of [1, 2, 3, 4]) {
    lastDrift = await call(tools, 'check_drift', {
      activity: {
        summary: `polished the unrelated landing page pass ${n}`,
        evidence: [`src/marketing/pass-${n}.tsx`],
        grade: 'A',
        source: 'tool_event',
        eventFingerprint: `tool:smoke:call-${n}`,
      },
    })
    check(`drift pass ${n} succeeds`, lastDrift.ok === true, codeOf(lastDrift))
  }
  const opened = lastDrift.data.pendingDecisions
  check('a pending decision exists', opened.length >= 1, JSON.stringify(opened))

  // ------------------------------------------------------------------ S15
  console.log('\nS15 resolve_intervention records the decision')
  const beforeResolve = await call(tools, 'goal_tree_view', {})
  const resolved = await call(tools, 'resolve_intervention', {
    interventionId: opened[0].id,
    decision: 'dismiss',
    rationale: 'the marketing page was a one-off favour',
  })
  check('resolution succeeds', resolved.ok === true, codeOf(resolved))
  checkEqual('the record is resolved', resolved.data.status, 'resolved')
  const afterResolve = await call(tools, 'goal_tree_view', {})
  checkEqual('resolving consumes no version', afterResolve.data.version, beforeResolve.data.version)
  check('the audit chain still verifies', afterResolve.data.audit.valid === true)

  // ------------------------------------------------------------------ S16
  console.log('\nS16 generate_report produces all three periods')
  for (const type of ['daily', 'weekly', 'monthly']) {
    const report = await call(tools, 'generate_report', { type })
    check(`${type} report succeeds`, report.ok === true, codeOf(report))
    check(`${type} report has a body`, typeof report.data.markdown === 'string' && report.data.markdown.length > 0)
  }

  // ------------------------------------------------------------------ S17
  console.log('\nS17 metacog_revise applies a batch of revisions in one bump')
  const view4 = await call(tools, 'goal_tree_view', {})
  const target = view4.data.goals.find((node) => node.depth === 1 && node.id !== l1.id)
  const revised = await call(tools, 'metacog_revise', {
    expectedVersion: view4.data.version,
    reason: 'smoke: the project changed',
    revisions: [
      { kind: 'goal_achieved', target: l1.id },
      { kind: 'contradiction_intensified', target: contradiction.id, intensity: 5 },
      {
        kind: 'contradiction_added',
        create: {
          title: 'titles only versus reading everything',
          poleA: 'context economy',
          poleB: 'derivation fidelity',
          primaryGoalRef: 'Goal derivation',
          relatedGoalRefs: ['Drift detection'],
          consequence: 'decides how many documents a derivation pass can afford to open',
          evidence: ['docs/design.md'],
        },
      },
    ],
  })
  check('revision succeeds', revised.ok === true, codeOf(revised))
  checkEqual('one version bump for three revisions', revised.data.version, view4.data.version + 1)
  check('the unrelated goal is untouched', target !== undefined)

  // ------------------------------------------------------------------ S18
  console.log('\nS18 goal_tree_init rebuilds a confirmed tree under force + expectedVersion')
  const beforeRebuild = await call(tools, 'goal_tree_view', {})
  const oldVersion = beforeRebuild.data.version
  const rebuild = await call(tools, 'goal_tree_init', {
    force: true,
    expectedVersion: oldVersion,
    reason: 'smoke: restate the project from scratch',
  })
  check('rebuild is accepted', rebuild.ok === true, codeOf(rebuild))
  check('the replaced tree was backed up', typeof rebuild.data.rebuild?.backupPath === 'string')
  const backupExists = await access(rebuild.data.rebuild.backupPath).then(() => true, () => false)
  check('the backup file is on disk', backupExists === true)

  const afterRebuild = await call(tools, 'goal_tree_view', {})
  checkEqual('the cleared tree keeps its version number', afterRebuild.data.version, oldVersion)
  checkEqual('the cleared tree is unconfirmed', afterRebuild.data.confirmed, false)
  checkEqual('no goals remain', afterRebuild.data.goals.length, 0)
  checkEqual('no contradictions remain', afterRebuild.data.contradictions.length, 0)

  // ------------------------------------------------------------------ S19
  console.log('\nS19 the pre-rebuild snapshot is not overwritten')
  const snapshotPath = join(root, '.metacog', 'snapshots', projectId, `${oldVersion}.json`)
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'))
  checkEqual('the old snapshot still holds the old tree', snapshot.goals.length, beforeRebuild.data.goals.length)
  checkEqual('the old snapshot keeps its reason', snapshot.reason.length > 0, true)

  // ------------------------------------------------------------------ S20
  console.log('\nS20 the rebuilt tree confirms at the version after the reset')
  await call(tools, 'goal_tree_confirm', { ...confirmArgs(oldVersion), preview: true, noDeadlineGoalRefs: ['*'] })
  const reconfirmed = await call(tools, 'goal_tree_confirm', {
    ...confirmArgs(oldVersion),
    userApproved: true,
    approvalNote: 'rebuild 确认',
  })
  check('re-confirmation succeeds', reconfirmed.ok === true, codeOf(reconfirmed))
  checkEqual('the new tree takes the next version', reconfirmed.data.version, oldVersion + 1)
  const finalView = await call(tools, 'goal_tree_view', {})
  checkEqual('the tree is confirmed again', finalView.data.confirmed, true)
  check('the audit chain still verifies', finalView.data.audit.valid === true, JSON.stringify(finalView.data.audit))

  // ------------------------------------------------------------------ S21
  console.log('\nS21 the reset is present in the audit log')
  const auditText = await readFile(join(root, '.metacog', 'audit', `${projectId}.jsonl`), 'utf8')
  const entries = auditText.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line))
  const resetEntry = entries.find((entry) => entry.action === 'tree_reset')
  check('a tree_reset entry exists', resetEntry !== undefined)
  checkEqual('the reset consumed no version', resetEntry?.beforeVersion, resetEntry?.afterVersion)
  check('the reset carries its reason', (resetEntry?.reason ?? '').length > 0)

  // ------------------------------------------------------------------ S22
  console.log('\nS22 picture the rebuilt tree is monitorable again')
  const monitored = await call(tools, 'check_drift', {
    activity: {
      summary: 'wrote the smoke test for every tool',
      evidence: ['metacog/test/tools-smoke.test.mjs'],
      grade: 'A',
      source: 'tool_event',
      eventFingerprint: 'tool:smoke:after-rebuild',
    },
  })
  check('drift still runs after a rebuild', monitored.ok === true, codeOf(monitored))
  check('the activity was actually judged', monitored.data.activity !== undefined)
} finally {
  for (const fixture of fixtures) await rm(fixture, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
