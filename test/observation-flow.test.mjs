/**
 * Observation flow verification: observation stream, dedupe, alignment judgement, drift
 * detectors and the Level 0-3 escalation state machine.
 *
 * The cases drive the registered tools through their real `execute` path against
 * a real temporary project, so what is verified is the behaviour a model would
 * observe 鈥?including refusals and the exact level a signal receives.
 *
 * Run: node test/observation-flow.test.mjs
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libUrl = pathToFileURL(join(here, '..', 'lib', 'index.js')).href

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

const { apply, getMount } = await import(libUrl)

function createHost(projectRoot) {
  const tools = new Map()
  const logs = []
  const ctx = {
  get(name) {
    if (name === 'workingDirectory') return this.workingDirectory
    if (name === 'timer') return this.timer
    if (name === 'systemPrompt') return this.systemPrompt
    if (name === 'tools') return this.tools
    if (name === 'fs') return this.fs
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
    agent: { id: 'agent-test' },
  })
}

function codeOf(outcome) {
  return outcome?.ok === false ? outcome.error.code : `ok(${JSON.stringify(outcome?.data)})`
}

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), 'metacog-staged-'))
  await writeFile(
    join(root, 'README.md'),
    [
      '# Stage D Project',
      '',
      'A fixture for drift detection.',
      '',
      '## Alignment monitoring',
      '',
      'Detects scope drift.',
      '',
      '## Structure monitoring',
      '',
      'Detects contradiction migration.',
      '',
      '## Design tension',
      '',
      'Delivery speed vs architectural verifiability.',
      '',
    ].join('\n'),
  )
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'docs', 'design.md'), '# Design\n\nObservations are append-only.\n')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'stage-d', version: '1.0.0' }, null, 2))
  return root
}

const fixtures = []

/** Confirm a standard tree: one L0, two L1, one main contradiction. */
async function confirmTree(tools, options = {}) {
  const alignmentPolicy = options.explorationPolicy ?? 'allowed'
  const confirmArgs = {
    expectedVersion: 0,
    l0: {
      title: 'Stage D Project',
      description: 'root',
      evidence: ['README.md'],
      // 本阶段测的是收集器 + 对齐判定（趋势、窗口、升级），
      // 根目标服务的活动就是这类监控判定。
      alignment: { relevantActivities: ['监控判定'] },
    },
    goals: [
      {
        title: 'Alignment monitoring',
        description: 'detect drift',
        evidence: ['README.md'],
        successCriteria: ['drift signals are produced from recorded activity'],
        relevantActivities: ['reading papers about drift detection'],
        allowedMethods: ['static analysis', 'dependency audit'],
        explorationPolicy: alignmentPolicy,
      },
      {
        title: 'Structure monitoring',
        description: 'detect migration',
        evidence: ['README.md'],
        successCriteria: ['contradiction shift is reported'],
        relevantActivities: ['contradiction migration inspection'],
        allowedMethods: [],
        explorationPolicy: 'limited',
      },
    ],
    contradictions: [
      {
        title: 'delivery speed versus architectural verifiability',
        poleA: 'delivery speed',
        poleB: 'architectural verifiability',
        evidence: ['README.md'],
        type: 'main',
        primaryGoalRef: 'Alignment monitoring',
        relatedGoalRefs: ['Structure monitoring'],
        rationale: 'shapes how much verification each increment can carry',
      },
    ],
    reason: 'user reviewed scanned candidates',
  }
  await call(tools, 'goal_tree_confirm', { ...confirmArgs, preview: true, noDeadlineGoalRefs: ['*'] })
  return call(tools, 'goal_tree_confirm', {
    ...confirmArgs,
    userApproved: true,
    approvalNote: 'stage-d 确认',
  })
}

/** Start from a confirmed tree and return the live tool handles plus facts. */
async function withProject(config, fn) {
  const root = await makeProject()
  fixtures.push(root)
  const host = createHost(root)
  apply(host.ctx, config)
  const mount = getMount(host.ctx)
  // `goal_tree_confirm` completes an *existing* draft, so the draft must exist
  // first; this mirrors the real workflow rather than skipping a step.
  const init = await call(host.tools, 'goal_tree_init', {})
  if (init?.ok !== true) throw new Error(`fixture init failed: ${codeOf(init)}`)
  const confirmed = await confirmTree(host.tools, config?.treeOptions ?? {})
  if (confirmed?.ok !== true) throw new Error(`fixture confirmation failed: ${codeOf(confirmed)}`)
  const view = await call(host.tools, 'goal_tree_view', {})
  return fn({
    root,
    tools: host.tools,
    logs: host.logs,
    mount,
    state: view.data,
    contradictionId: view.data.contradictions[0].id,
    alignmentGoalId: view.data.goals.find((g) => g.depth === 1).id,
  })
}

try {
  // ------------------------------------------------------------------- D1
  console.log('\nD1  contradictions start with an underivable trend')
  await withProject({}, async ({ state, contradictionId }) => {
    checkEqual('new contradiction trend is unknown', state.contradictions[0].trend, 'unknown')
    checkEqual('new contradiction intensity is null', state.contradictions[0].intensity, null)
    check('contradiction has an id', typeof state.contradictions[0].id === 'string')
    check(
      'contradiction links to a primary goal',
      typeof state.contradictions[0].primaryGoalId === 'string',
    )
    check('contradiction is confirmed', state.contradictions[0].confirmed === true)
  })

  // ------------------------------------------------------------------- D1b
  console.log('\nD1b  the full node carries the spec fields (checked through the store)')
  await withProject({}, async ({ root }) => {
    const { MetacogStore } = await import(
      pathToFileURL(join(here, '..', 'lib', 'data', 'store.js')).href
    )
    const { deriveProjectId } = await import(
      pathToFileURL(join(here, '..', 'lib', 'tools', 'shared.js')).href
    )
    const store = new MetacogStore(root, '.metacog')
    const stored = await store.readState(deriveProjectId(root))
    const node = stored.contradictions[0]
    checkEqual('the stored node carries projectId', node.projectId, deriveProjectId(root))
    check('the stored node has a parentId field', 'parentId' in node)
    checkEqual('the stored node is user-confirmed', node.confirmedByUser, true)
    checkEqual('the stored node keeps its rationale', typeof node.rationale, 'string')
    check('the stored node has relatedGoalIds', Array.isArray(node.relatedGoalIds))
    check('related ids do not repeat the primary id', !node.relatedGoalIds.includes(node.primaryGoalId))
  })

  // ------------------------------------------------------------------- D2
  console.log('\nD2  a single observation cannot claim a direction')
  await withProject({}, async ({ tools, contradictionId }) => {
    const first = await call(tools, 'contradiction_observe', {
      contradictionId,
      intensity: 4,
      rationale: 'deadline pressure is visible in the commit log',
      confidence: 0.8,
      evidence: ['git log'],
    })
    check('observation is accepted', first.ok === true, codeOf(first))
    checkEqual('one point yields unknown', first.data.trendNow, 'unknown')
    checkEqual('the recorded trend is unknown too', first.data.trendAtRecordTime, 'unknown')
    check('sample size is reported', first.data.sampleSize === 1, String(first.data.sampleSize))
    check(
      'the return states the node field was not touched',
      typeof first.data.nodeTrendUnchanged === 'string',
    )

    const view = await call(tools, 'goal_tree_view', {})
    checkEqual(
      'the contradiction node trend remains unknown after one observation',
      view.data.contradictions[0].trend,
      'unknown',
    )

    // (A null-intensity check lives in its own project at the end of this block;
    // here the observation stream legitimately supports a level.)
  })

  // ------------------------------------------------------------------ D2b
  console.log('\nD2b  an unobserved contradiction reports an unknown intensity, not 0')
  await withProject({}, async ({ tools }) => {
    await confirmTree(tools)
    const view = await call(tools, 'goal_tree_view', {})
    for (const node of view.data.contradictions) {
      checkEqual(`node "${node.title}" starts with no reading`, node.intensity ?? null, null)
    }

    const run = await call(tools, 'check_drift', {})
    const dominant = run.data.dominantContradiction
    check('a dominant contradiction is still reported', dominant !== undefined)
    checkEqual(
      'its intensity is null, not a fabricated 0',
      dominant?.intensity ?? null,
      null,
    )
    const trends = run.data.trends
    check(
      'every trend row also carries null rather than 0',
      trends.every((row) => row.intensity === null),
      JSON.stringify(trends.map((row) => row.intensity)),
    )
  })

  // ------------------------------------------------------------------- D3
  console.log('\nD3  history drives the trend (T07)')
  await withProject({}, async ({ tools, contradictionId }) => {
    const now = Date.now()
    const stamp = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString()
    const readings = [
      [50, 5],
      [40, 5],
      [30, 4],
      [20, 3],
      [10, 2],
    ]
    let last
    for (const [minutesAgo, intensity] of readings) {
      last = await call(tools, 'contradiction_observe', {
        contradictionId,
        intensity,
        observedAt: stamp(minutesAgo),
        rationale: `intensity sample at T-${minutesAgo}m`,
        confidence: 0.9,
        evidence: ['observation log'],
      })
      check(`observation T-${minutesAgo}m accepted`, last.ok === true, codeOf(last))
    }
    checkEqual('falling series computes falling', last.data.trendNow, 'falling')
    checkEqual('falling series has 5 usable points', last.data.sampleSize, 5)
    check('rationale quotes the endpoints', /5.*2|5 to 2/.test(last.data.rationale), last.data.rationale)

    const view = await call(tools, 'goal_tree_view', {})
    // The stored node field stays untouched — observations never write it — but the
    // view projects the stream, so what a caller sees is the live verdict.
    checkEqual(
      'the view projects the observed trend',
      view.data.contradictions[0].trend,
      'falling',
    )
    checkEqual(
      'the view exposes the stored field separately',
      view.data.contradictions[0].intensityEdited,
      null,
    )
  })

  // ------------------------------------------------------------------- D4
  console.log('\nD4  rising history computes rising; noise computes stable')
  await withProject({}, async ({ tools, contradictionId }) => {
    const now = Date.now()
    const stamp = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString()
    for (const [minutesAgo, intensity] of [
      [30, 2],
      [20, 3],
      [10, 5],
    ]) {
      await call(tools, 'contradiction_observe', {
        contradictionId,
        intensity,
        observedAt: stamp(minutesAgo),
        rationale: 'rising sample',
        confidence: 0.9,
        evidence: [],
      })
    }
    const rising = await call(tools, 'contradiction_observe', {
      contradictionId,
      intensity: 5,
      observedAt: stamp(1),
      rationale: 'latest sample',
      confidence: 0.9,
      evidence: [],
    })
    check('rising series is rising', rising.data.trendNow === 'rising', rising.data.trendNow)
  })

  await withProject({}, async ({ tools, contradictionId }) => {
    const now = Date.now()
    const stamp = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString()
    let last
    for (const [minutesAgo, intensity] of [
      [30, 3],
      [20, 3],
      [10, 3],
      [1, 3],
    ]) {
      last = await call(tools, 'contradiction_observe', {
        contradictionId,
        intensity,
        observedAt: stamp(minutesAgo),
        rationale: 'flat sample',
        confidence: 0.9,
        evidence: [],
      })
    }
    checkEqual('flat series is stable', last.data.trendNow, 'stable')
  })

  // ------------------------------------------------------------------- D5
  console.log('\nD5  observation input is validated')
  await withProject({}, async ({ tools, contradictionId }) => {
    const unknown = await call(tools, 'contradiction_observe', {
      contradictionId: 'C_missing',
      intensity: 3,
      rationale: 'x',
    })
    checkEqual('unknown contradiction is refused', codeOf(unknown), 'UNKNOWN_CONTRADICTION')

    const badIntensity = await call(tools, 'contradiction_observe', {
      contradictionId,
      intensity: 9,
      rationale: 'x',
    })
    checkEqual('out-of-range intensity is refused', codeOf(badIntensity), 'INVALID_ARGS')

    const noRationale = await call(tools, 'contradiction_observe', {
      contradictionId,
      intensity: 3,
    })
    checkEqual('missing rationale is refused', codeOf(noRationale), 'INVALID_ARGS')

    const nullIntensity = await call(tools, 'contradiction_observe', {
      contradictionId,
      intensity: null,
      rationale: 'evidence is insufficient to place this on the scale',
    })
    check('null intensity is allowed', nullIntensity.ok === true, codeOf(nullIntensity))
    checkEqual('null intensity does not count as a usable point', nullIntensity.data.trendNow, 'unknown')
  })

  // ------------------------------------------------------------------- D6
  console.log('\nD6  Grade A out-of-scope activity is drift (T02)')
  await withProject({}, async ({ tools }) => {
    const outcome = await call(tools, 'check_drift', {
      activity: {
        summary: 'rewrote the marketing landing page hero section',
        evidence: ['src/marketing/hero.tsx'],
        grade: 'A',
        source: 'tool_event',
        toolName: 'edit',
      },
    })
    check('check_drift accepted the activity', outcome.ok === true, codeOf(outcome))
    checkEqual('the activity is judged scope_drift', outcome.data.activity.decision, 'scope_drift')
    const drift = outcome.data.signals.find((s) => s.signalType === 'scope_drift')
    check('a scope_drift signal exists', drift !== undefined)
    check('the signal is at least Level 1', drift !== undefined && drift.level >= 1)
    check(
      'the recorded activity carries a confidence',
      typeof outcome.data.activity.alignmentConfidence === 'number',
    )
  })

  // ------------------------------------------------------------------- D7
  console.log('\nD7  registered exploration is exempt (T03)')
  await withProject({ explorationPolicy: 'allowed' }, async ({ tools }) => {
    const papers = await call(tools, 'check_drift', {
      activity: {
        summary: 'reading papers about drift detection for the alignment monitor',
        evidence: ['notes/drift-papers.md'],
        grade: 'A',
        source: 'tool_event',
        toolName: 'web_search',
      },
    })
    check('reading is accepted', papers.ok === true, codeOf(papers))
    checkEqual('registered reading is exploratory', papers.data.activity.decision, 'exploratory')
    check(
      'no Level 2/3 intervention is opened for registered exploration',
      papers.data.interventions.length === 0,
      JSON.stringify(papers.data.interventions),
    )

    const method = await call(tools, 'check_drift', {
      activity: {
        summary: 'dependency audit of the transitive tree',
        evidence: ['package-lock.json'],
        grade: 'A',
        source: 'tool_event',
        toolName: 'bash',
      },
    })
    checkEqual('an allowed method is exploratory', method.data.activity.decision, 'exploratory')
  })

  console.log('\nD8  the global whitelist exempts by tool name and by phrase')
  await withProject(
    {
      whitelistedActivities: [
        { label: 'build hygiene', summaryContains: ['formatting pass'], toolNames: ['prettier'] },
      ],
    },
    async ({ tools }) => {
      const byTool = await call(tools, 'check_drift', {
        activity: {
          summary: 'ran the formatter over the whole tree',
          evidence: ['src/index.ts'],
          grade: 'A',
          source: 'tool_event',
          toolName: 'prettier',
        },
      })
      checkEqual('by tool name is aligned', byTool.data.activity.decision, 'aligned')

      const byPhrase = await call(tools, 'check_drift', {
        activity: {
          summary: 'a formatting pass across generated files',
          evidence: ['dist/*'],
          grade: 'A',
          source: 'manual',
        },
      })
      checkEqual('by phrase is aligned', byPhrase.data.activity.decision, 'aligned')
    },
  )

  // ------------------------------------------------------------------- D9
  console.log('\nD9  weak context degrades to uncertain (T04)')
  await withProject({}, async ({ tools }) => {
    const gradeC = await call(tools, 'check_drift', {
      activity: {
        summary: 'spent a while on something unrelated to the goal',
        evidence: [],
        grade: 'C',
        source: 'manual',
      },
    })
    check('grade C is accepted', gradeC.ok === true, codeOf(gradeC))
    checkEqual('grade C yields uncertain', gradeC.data.activity.decision, 'uncertain')
    checkEqual('grade C confidence is zero', gradeC.data.activity.alignmentConfidence, 0)
    check(
      'grade C opens no intervention',
      gradeC.data.interventions.length === 0,
      JSON.stringify(gradeC.data.interventions),
    )

    const gradeB = await call(tools, 'check_drift', {
      activity: {
        summary: 'rewrote the marketing landing page hero section',
        evidence: [],
        grade: 'B',
        source: 'manual',
      },
    })
    checkEqual('grade B without a rule match is uncertain', gradeB.data.activity.decision, 'uncertain')
    check(
      'grade B confidence is capped below the floor',
      gradeB.data.activity.alignmentConfidence < 0.6,
      String(gradeB.data.activity.alignmentConfidence),
    )

    const gradeAWithoutEvidence = await call(tools, 'check_drift', {
      activity: { summary: 'something', grade: 'A', evidence: [] },
    })
    checkEqual(
      'grade A without evidence is refused',
      codeOf(gradeAWithoutEvidence),
      'GRADE_EVIDENCE_REQUIRED',
    )
  })

  // ------------------------------------------------------------------ D10
  console.log('\nD10  the static check invents no activity')
  await withProject({}, async ({ tools }) => {
    const staticRun = await call(tools, 'check_drift', {})
    check('static check is accepted', staticRun.ok === true, codeOf(staticRun))
    checkEqual('static mode is reported', staticRun.data.mode, 'static')
    check('static mode records no activity', staticRun.data.activity === undefined)

    const view = await call(tools, 'goal_tree_view', {})
    check('the tree is untouched by a static check', view.data.version === 1, String(view.data.version))
  })

  // ------------------------------------------------------------------ D11
  console.log('\nD11  replayed events are idempotent (T05)')
  await withProject({}, async ({ tools }) => {
    const args = {
      activity: {
        summary: 'rewrote the marketing landing page hero section',
        evidence: ['src/marketing/hero.tsx'],
        grade: 'A',
        source: 'tool_event',
        eventFingerprint: 'tool:sess-1:call-42',
      },
    }
    const first = await call(tools, 'check_drift', args)
    check('first delivery records', first.ok === true && first.data.duplicate === false, codeOf(first))
    const firstSignalCount = first.data.signals.length

    const second = await call(tools, 'check_drift', args)
    checkEqual('second delivery reports duplicate', second.data.duplicate, true)
    checkEqual('second delivery appends no signal', second.data.signals.length, 0)
    check(
      'second delivery returns the original activity',
      second.data.activity.eventFingerprint === 'tool:sess-1:call-42',
    )

    const third = await call(tools, 'check_drift', args)
    checkEqual('third delivery still appends no signal', third.data.signals.length, 0)
    check('the first delivery did produce a signal', firstSignalCount >= 1, String(firstSignalCount))

    // A different fingerprint for the same text is a genuinely new event, since
    // the host assigned a different call id.
    const other = await call(tools, 'check_drift', {
      activity: { ...args.activity, eventFingerprint: 'tool:sess-1:call-43' },
    })
    checkEqual('a different fingerprint records again', other.data.duplicate, false)
  })

  // ------------------------------------------------------------------ D12
  console.log('\nD12  manual reports dedupe on content')
  await withProject({}, async ({ tools }) => {
    const args = {
      activity: { summary: 'read a blog post about   typography', evidence: ['b/typography'], grade: 'A' },
    }
    const first = await call(tools, 'check_drift', args)
    const second = await call(tools, 'check_drift', {
      activity: { summary: 'read a blog post about typography', evidence: ['b/typography'], grade: 'A' },
    })
    check('first manual report records', first.data.duplicate === false)
    checkEqual('whitespace-only variant dedupes to one record', second.data.duplicate, true)
  })

  // ------------------------------------------------------------------ D13
  console.log('\nD13  repeats inside the window escalate to Level 2 (T06)')
  await withProject({ thresholdReached: true }, async ({ tools }) => {
    const drift = (n) =>
      call(tools, 'check_drift', {
        activity: {
          summary: `polished the unrelated landing page pass ${n}`,
          evidence: [`src/marketing/pass-${n}.tsx`],
          grade: 'A',
          source: 'tool_event',
          eventFingerprint: `tool:sess-2:call-${n}`,
        },
      })
    const one = await drift(1)
    const two = await drift(2)
    const three = await drift(3)
    check('first drift is recorded', one.ok === true, codeOf(one))
    const levels = [one, two, three].map((outcome) =>
      Math.max(0, ...outcome.data.signals.map((s) => s.level)),
    )
    check('a signal was raised on the third repeat', levels[2] >= 2, JSON.stringify(levels))
    const opened = [one, two, three].reduce((sum, outcome) => sum + outcome.data.interventions.length, 0)
    checkEqual('exactly one intervention is opened', opened, 1)
    const level2 = [one, two, three]
      .flatMap((outcome) => outcome.data.interventions)
      .find((record) => record.level === 2)
    check('the intervention is Level 2', level2 !== undefined)

    const four = await drift(4)
    checkEqual('a further same-class signal opens no second card', four.data.interventions.length, 0)
    check(
      'the further signal is held at Level 1',
      Math.max(0, ...four.data.signals.map((s) => s.level)) <= 1,
      JSON.stringify(four.data.signals.map((s) => s.level)),
    )
    check(
      'the pending decision is surfaced',
      four.data.pendingDecisions.length === 1,
      JSON.stringify(four.data.pendingDecisions),
    )
  })

  // ------------------------------------------------------------------ D14
  console.log('\nD14  resolving an intervention records the decision (T07, T08)')
  await withProject({}, async ({ tools, state }) => {
    for (const n of [1, 2, 3]) {
      await call(tools, 'check_drift', {
        activity: {
          summary: `unrelated landing page pass ${n}`,
          evidence: [`src/marketing/pass-${n}.tsx`],
          grade: 'A',
          source: 'tool_event',
          eventFingerprint: `tool:sess-3:call-${n}`,
        },
      })
    }
    const check3 = await call(tools, 'check_drift', {
      activity: {
        summary: 'unrelated landing page pass 4',
        evidence: ['src/marketing/pass-4.tsx'],
        grade: 'A',
        source: 'tool_event',
        eventFingerprint: 'tool:sess-3:call-4',
      },
    })
    const pending = check3.data.pendingDecisions[0]
    check('a pending intervention exists', pending !== undefined, JSON.stringify(check3.data))

    const before = await call(tools, 'goal_tree_view', {})
    const resolved = await call(tools, 'resolve_intervention', {
      interventionId: pending === undefined ? 'iv_missing' : pending.id,
      decision: 'dismiss',
      rationale: 'the marketing page was a one-off favour for a colleague',
    })
    check('resolution is accepted', resolved.ok === true, codeOf(resolved))
    checkEqual('the decision is recorded', resolved.data.decision, 'dismiss')
    checkEqual('the record is resolved', resolved.data.status, 'resolved')
    check('an audit entry is written', typeof resolved.data.auditEntryId === 'string')

    const after = await call(tools, 'goal_tree_view', {})
    checkEqual('the tree version is unchanged by a dismissal', after.data.version, before.data.version)
    checkEqual(
      'the L0 is unchanged by a dismissal',
      after.data.goals.find((g) => g.depth === 0).title,
      state.goals.find((g) => g.depth === 0).title,
    )
    checkEqual(
      'the contradiction trend is untouched by the decision',
      after.data.contradictions[0].trend,
      before.data.contradictions[0].trend,
    )
    check('the audit chain still verifies', after.data.audit.valid === true, JSON.stringify(after.data.audit))

    const again = await call(tools, 'resolve_intervention', {
      interventionId: resolved.data.interventionId,
      decision: 'continue',
      rationale: 'changed my mind',
    })
    checkEqual('resolving twice is refused', codeOf(again), 'NOT_PENDING')

    const noRationale = await call(tools, 'resolve_intervention', {
      interventionId: resolved.data.interventionId,
      decision: 'continue',
    })
    checkEqual('a decision without a reason is refused', codeOf(noRationale), 'REASON_REQUIRED')

    const noRationalePending = await call(tools, 'resolve_intervention', {
      interventionId: 'iv_does_not_exist',
      decision: 'continue',
    })
    checkEqual(
      'a reason is demanded before existence is even checked',
      codeOf(noRationalePending),
      'REASON_REQUIRED',
    )

    const unknownWithReason = await call(tools, 'resolve_intervention', {
      interventionId: 'iv_does_not_exist',
      decision: 'continue',
      rationale: 'testing the unknown-id path',
    })
    checkEqual(
      'an unknown intervention is refused once the reason is present',
      codeOf(unknownWithReason),
      'UNKNOWN_INTERVENTION',
    )
  })

  // ------------------------------------------------------------------ D15
  console.log('\nD15  goal staleness is decided by the clock, at detector level')
  await withProject({}, async ({ root, tools }) => {
    const driftUrl = pathToFileURL(join(here, '..', 'lib', 'analysis', 'drift.js')).href
    const configUrl = pathToFileURL(join(here, '..', 'lib', 'config.js')).href
    const storeUrl = pathToFileURL(join(here, '..', 'lib', 'data', 'store.js')).href
    const sharedUrl = pathToFileURL(join(here, '..', 'lib', 'tools', 'shared.js')).href
    const { detectGoalStaleness } = await import(driftUrl)
    const { parseConfig } = await import(configUrl)
    const { MetacogStore } = await import(storeUrl)
    const { deriveProjectId } = await import(sharedUrl)

    const config = parseConfig({})
    const store = new MetacogStore(root, '.metacog')
    const projectId = deriveProjectId(root)
    const state = await store.readState(projectId)

    const base = {
      state,
      activities: [],
      observations: [],
      signals: [],
      config,
    }
    const fresh = detectGoalStaleness({ ...base, now: new Date() })
    check('a freshly confirmed goal is not stale', fresh.length === 0, JSON.stringify(fresh))

    // Eight days later, with no activity recorded, both L1 goals are stale.
    const later = new Date(Date.now() + 8 * 86_400_000)
    const stale = detectGoalStaleness({ ...base, now: later })
    checkEqual('both stale L1 goals are reported', stale.length, 2)
    check(
      'each stale signal names exactly one goal',
      stale.every((signal) => signal.relatedGoalIds.length === 1),
      JSON.stringify(stale.map((signal) => signal.relatedGoalIds)),
    )
    check(
      'the rationale quotes the threshold and the idle days',
      stale.every((signal) => /7-day threshold/.test(signal.rationale)),
      stale[0]?.rationale,
    )
    check(
      'staleness is attributed to goal_alignment',
      stale.every((signal) => signal.monitorCategory === 'goal_alignment'),
    )

    // A goal that received aligned activity recently is not stale.
    const withActivity = detectGoalStaleness({
      ...base,
      now: later,
      activities: state.goals.map((goal, index) => ({
        id: `act_synthetic_${index}`,
        eventFingerprint: `fp-${index}`,
        projectId,
        sessionId: 'sess',
        timestamp: new Date(later.getTime() - 60_000).toISOString(),
        source: 'manual',
        observationGrade: 'A',
        summary: 'aligned work',
        evidence: [],
        candidateGoalIds: [goal.id],
        alignmentConfidence: 1,
        decision: 'aligned',
        rationale: 'synthetic',
      })),
    })
    check(
      'recent aligned activity suppresses staleness',
      withActivity.length === 0,
      JSON.stringify(withActivity.map((signal) => signal.relatedGoalIds)),
    )

    // Static check still runs safely through the tool and opens no card.
    const outcome = await call(tools, 'check_drift', {})
    check('static check runs', outcome.ok === true, codeOf(outcome))
    check(
      'a static check cannot open a Level 2 card',
      outcome.data.interventions.length === 0,
      JSON.stringify(outcome.data.interventions),
    )
    checkEqual('static mode is reported by the tool', outcome.data.mode, 'static')
  })

  // ------------------------------------------------------------------ D16
  console.log('\nD16  contradiction_shift fires only when the structure lags')
  await withProject({}, async ({ tools }) => {
    const known = await call(tools, 'check_drift', {
      blockerHint: 'architectural verifiability',
    })
    const shiftKnown = known.data.signals.filter((s) => s.signalType === 'contradiction_shift')
    check(
      'a covered bottleneck raises no shift signal',
      shiftKnown.length === 0,
      JSON.stringify(shiftKnown.map((s) => s.rationale)),
    )

    const novel = await call(tools, 'check_drift', {
      blockerHint: 'GPU memory ceiling on the training box',
    })
    const shift = novel.data.signals.find((s) => s.signalType === 'contradiction_shift')
    check('an uncovered bottleneck raises a shift signal', shift !== undefined, codeOf(novel))
    check(
      'the shift signal names structure_validity',
      shift !== undefined && shift.monitorCategory === 'structure_validity',
      shift?.monitorCategory,
    )
  })

  // ------------------------------------------------------------------ D17
  console.log('\nD17  core_bypass requires both halves')
  await withProject({}, async ({ tools, contradictionId }) => {
    // Intensity is high, but every activity serves the contradiction's goals:
    // that is a hard problem being worked on, not a bypass.
    const now = Date.now()
    for (const [minutesAgo, intensity] of [
      [30, 5],
      [20, 5],
      [5, 5],
    ]) {
      await call(tools, 'contradiction_observe', {
        contradictionId,
        intensity,
        observedAt: new Date(now - minutesAgo * 60_000).toISOString(),
        rationale: 'sustained high tension',
        confidence: 0.9,
        evidence: ['README.md'],
      })
    }
    const engaged = await call(tools, 'check_drift', {
      activity: {
        summary: 'reading papers about drift detection',
        evidence: ['notes/papers.md'],
        grade: 'A',
        source: 'tool_event',
        eventFingerprint: 'tool:sess-5:call-1',
      },
    })
    const bypassEngaged = engaged.data.signals.filter((s) => s.signalType === 'core_bypass')
    check(
      'working on the tension itself is not a bypass',
      bypassEngaged.length === 0,
      JSON.stringify(bypassEngaged.map((s) => s.rationale)),
    )

    // Now the same high intensity with activity that serves neither pole. Each
    // further avoiding activity re-runs the bypass detector, so the signal
    // accumulates the repeats the Level 3 rule requires.
    let lastBypass
    for (let n = 1; n <= 6; n += 1) {
      lastBypass = await call(tools, 'check_drift', {
        activity: {
          summary: `unrelated marketing pass ${n}`,
          evidence: [`marketing/pass-${n}.tsx`],
          grade: 'A',
          source: 'tool_event',
          eventFingerprint: `tool:sess-5:call-${n + 10}`,
        },
      })
      check(`avoiding activity ${n} is accepted`, lastBypass.ok === true, codeOf(lastBypass))
    }
    const bypassSignals = lastBypass.data.signals.filter((s) => s.signalType === 'core_bypass')
    check(
      'sustained avoidance raises core_bypass',
      bypassSignals.length >= 1 || lastBypass.data.pendingDecisions.length > 0,
      JSON.stringify(lastBypass.data.signals.map((s) => s.signalType)),
    )
    const gatePending = lastBypass.data.pendingDecisions.find((d) => d.level === 3)
    check(
      'a repeated high-intensity bypass reaches Level 3',
      gatePending !== undefined,
      JSON.stringify(lastBypass.data.pendingDecisions.map((d) => d.level)),
    )
  })

  // ------------------------------------------------------------------ D18
  console.log('\nD18  significance of the returned status block')
  await withProject({}, async ({ tools }) => {
    const outcome = await call(tools, 'check_drift', {})
    check('level counts are reported', typeof outcome.data.levelCounts === 'object')
    check(
      'capability notes state the Level 3 gate exists',
      outcome.data.capabilityNotes.some((note) => note.includes('Level 3 is a real gate')),
      JSON.stringify(outcome.data.capabilityNotes),
    )
    check(
      'trends are reported per contradiction',
      Array.isArray(outcome.data.trends) && outcome.data.trends.length === 1,
      JSON.stringify(outcome.data.trends),
    )
  })
} finally {
  for (const root of fixtures) {
    await rm(root, { recursive: true, force: true })
  }
}

console.log(`\n=== Observation flow 结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1

