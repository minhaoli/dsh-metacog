/**
 * F2: the deepest level of the tree must be executable.
 *
 * A leaf has no children, so `successCriteria` is the only place "how is this
 * done?" can be answered. Three failures look different to a person and have
 * different fixes — no criteria at all, only whitespace, only platitudes — so
 * the gate reports them separately rather than folding them into one code.
 *
 * Two more claims are defended here:
 *
 *   1. the rule is about leaves only. A parent that decomposes into concrete
 *      work is doing its job by having children, not by restating them;
 *   2. it is a separate invariant from CRITERIA_REQUIRED. That gate asks whether
 *      an activity can be *matched* to a goal (relevantActivities /
 *      allowedMethods); this one asks whether a leaf states a *checkable
 *      completion*. A tree can fail either without failing the other, and the
 *      fixes are different fields.
 *
 * Run: node test/leaf-actionable.test.mjs   (after `npm run build`)
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (path) => pathToFileURL(join(here, '..', 'lib', path)).href

const { apply } = await import(lib('index.js'))
const { parseConfig } = await import(lib('config.js'))
const {
  GENERIC_CRITERIA,
  inspectLeafActionability,
  isGenericCriterion,
} = await import(lib('analysis/collapse.js'))

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

/** A fresh confirmed-project fixture; confirm is one-shot, so each case gets one. */
async function freshProject() {
  const root = await mkdtemp(join(tmpdir(), 'metacog-leaf-'))
  fixtures.push(root)
  await writeFile(join(root, 'README.md'), '# Leaf actionability\n\nA fixture for the leaf contract.\n')
  const { ctx, tools } = createHost(root)
  apply(ctx, parseConfig({}))
  const rawCall = async (name, args) => {
    const definition = tools.get(name)
    if (definition === undefined) throw new Error(`tool "${name}" was never registered`)
    return definition.execute(args, {
      callId: `call-${Math.random().toString(16).slice(2)}`,
      name,
      arguments: args,
      signal: new AbortController().signal,
      agent: { id: 'agent-leaf-actionable' },
    })
  }
  // Confirmation is two-stage now; wrap it so each case still expresses only
  // the tree it is testing.
  const call = async (name, args) => {
    if (name !== 'goal_tree_confirm') return rawCall(name, args)
    await rawCall('goal_tree_confirm', { ...args, preview: true, noDeadlineGoalRefs: ['*'] })
    return rawCall('goal_tree_confirm', { ...args, userApproved: true, approvalNote: 'leaf 测试确认' })
  }
  return { root, call, tools }
}

const ROOT = {
  title: 'Root',
  evidence: ['README.md'],
  successCriteria: ['the root outcome is observable from outside'],
  alignment: { relevantActivities: ['root work'] },
}

const codeOf = (outcome) => (outcome?.ok === false ? outcome.error.code : `ok(${JSON.stringify(outcome?.data)})`)

try {
  console.log('\n[missing] a leaf with no successCriteria is refused')

  {
    const { call } = await freshProject()
    const refused = await call('goal_tree_confirm', {
      expectedVersion: 0,
      l0: ROOT,
      goals: [{ title: 'Leaf', evidence: ['README.md'], relevantActivities: ['leaf work'] }],
      contradictions: [],
      reason: 'missing criteria fixture',
    })
    check('the confirm is refused', refused.ok === false, codeOf(refused))
    check('with the leaf code, not the criteria code', refused.error.code === 'LEAF_NOT_ACTIONABLE', codeOf(refused))
    check('the message names the goal', refused.error.message.includes('"Leaf"'), refused.error.message)
    check('and says what is missing', refused.error.message.includes('no successCriteria at all'), refused.error.message)
    check(
      'the payload classifies it as missing',
      JSON.stringify(refused.error.details?.reasons?.missing) === '["Leaf"]',
      JSON.stringify(refused.error.details),
    )
  }

  console.log('\n[criteria] a leaf that states one passes')

  {
    const { call } = await freshProject()
    const accepted = await call('goal_tree_confirm', {
      expectedVersion: 0,
      l0: ROOT,
      goals: [
        {
          title: 'Leaf',
          evidence: ['README.md'],
          relevantActivities: ['leaf work'],
          successCriteria: ['the leaf writes one file per run'],
        },
      ],
      contradictions: [],
      reason: 'criteria fixture',
    })
    check('the confirm passes', accepted.ok === true, codeOf(accepted))
    check('both goals are stored', accepted.data?.goals === 2, JSON.stringify(accepted.data))
  }

  console.log('\n[parents] a non-leaf is exempt: children are its concreteness')

  {
    const { call } = await freshProject()
    const accepted = await call('goal_tree_confirm', {
      expectedVersion: 0,
      l0: ROOT,
      goals: [
        // No successCriteria on purpose: the parent is decomposed, and the
        // leaf contract is about the deepest level, not every level.
        { title: 'Parent', depth: 1, evidence: ['README.md'], relevantActivities: ['parent work'] },
        {
          title: 'Child',
          depth: 2,
          parentRef: 'Parent',
          evidence: ['README.md'],
          relevantActivities: ['child work'],
          successCriteria: ['the child produces a checked artifact'],
        },
      ],
      contradictions: [],
      reason: 'parent fixture',
    })
    check('a parent without criteria is accepted', accepted.ok === true, codeOf(accepted))
    check('the whole tree is stored', accepted.data?.goals === 3, JSON.stringify(accepted.data))
  }

  console.log('\n[generic] platitudes are not acceptance criteria')

  {
    const { call } = await freshProject()
    const refused = await call('goal_tree_confirm', {
      expectedVersion: 0,
      l0: ROOT,
      goals: [
        {
          title: 'Vague leaf',
          evidence: ['README.md'],
          relevantActivities: ['vague work'],
          successCriteria: ['完成', '做好', '推进'],
        },
      ],
      contradictions: [],
      reason: 'generic fixture',
    })
    check('the confirm is refused', refused.ok === false, codeOf(refused))
    check('the code is the leaf code', refused.error.code === 'LEAF_NOT_ACTIONABLE', codeOf(refused))
    check('the message says they are generic', refused.error.message.includes('only generic phrases'), refused.error.message)
    check('the message quotes the platitudes', refused.error.message.includes('完成'), refused.error.message)
    check(
      'the payload classifies it as generic',
      JSON.stringify(refused.error.details?.reasons?.generic) === '["Vague leaf"]',
      JSON.stringify(refused.error.details),
    )
  }

  console.log('\n[blank] whitespace is the same as nothing')

  {
    const { call } = await freshProject()
    const refused = await call('goal_tree_confirm', {
      expectedVersion: 0,
      l0: ROOT,
      goals: [
        {
          title: 'Blank leaf',
          evidence: ['README.md'],
          relevantActivities: ['blank work'],
          successCriteria: ['   ', '\t'],
        },
      ],
      contradictions: [],
      reason: 'blank fixture',
    })
    check('the confirm is refused', refused.ok === false, codeOf(refused))
    check('the message says the entries are blank', refused.error.message.includes('only blank entries'), refused.error.message)
    check(
      'blank is reported separately from missing',
      refused.error.details?.reasons?.blank?.length === 1 && refused.error.details?.reasons?.missing?.length === 0,
      JSON.stringify(refused.error.details),
    )
  }

  console.log('\n[mixed] one concrete criterion is enough')

  {
    const { call } = await freshProject()
    const accepted = await call('goal_tree_confirm', {
      expectedVersion: 0,
      l0: ROOT,
      goals: [
        {
          title: 'Mixed leaf',
          evidence: ['README.md'],
          relevantActivities: ['mixed work'],
          successCriteria: ['完成', 'README 记录安装与卸载步骤'],
        },
      ],
      contradictions: [],
      reason: 'mixed fixture',
    })
    check('a concrete entry alongside a platitude passes', accepted.ok === true, codeOf(accepted))
  }

  console.log('\n[escape hatch] the placeholder must be deliberate')

  {
    const { call } = await freshProject()
    const goals = [{ title: 'Placeholder', evidence: ['README.md'], relevantActivities: ['later work'] }]
    const noReason = await call('goal_tree_confirm', {
      expectedVersion: 0,
      l0: ROOT,
      goals,
      contradictions: [],
      allowNonActionableLeaves: true,
      reason: '   ',
    })
    check('without a reason the bypass is refused', noReason.ok === false, codeOf(noReason))
    check('with REASON_REQUIRED', noReason.error.code === 'REASON_REQUIRED', codeOf(noReason))

    const withReason = await call('goal_tree_confirm', {
      expectedVersion: 0,
      l0: ROOT,
      goals,
      contradictions: [],
      allowNonActionableLeaves: true,
      reason: 'placeholder accepted while the decomposition is still being decided',
    })
    check('with a reason it is accepted', withReason.ok === true, codeOf(withReason))
  }

  console.log('\n[edit path] the same rule guards structural edits')

  {
    const { call } = await freshProject()
    const confirmed = await call('goal_tree_confirm', {
      expectedVersion: 0,
      l0: ROOT,
      goals: [
        { title: 'Parent', depth: 1, evidence: ['README.md'], relevantActivities: ['parent work'] },
        {
          title: 'Leaf',
          depth: 2,
          parentRef: 'Parent',
          evidence: ['README.md'],
          relevantActivities: ['leaf work'],
          successCriteria: ['the leaf writes one file per run'],
        },
      ],
      contradictions: [],
      reason: 'edit fixture',
    })
    check('the base tree confirms', confirmed.ok === true, codeOf(confirmed))

    const view = await call('goal_tree_view', {})
    const parentId = view.data.goals.find((goal) => goal.title === 'Parent').id
    const version = view.data.version

    const created = await call('goal_tree_edit', {
      expectedVersion: version,
      creates: [{ depth: 2, parentId, title: 'New leaf', evidence: ['README.md'] }],
      reason: 'add a concrete step',
    })
    check('creating a leaf without criteria is refused', created.ok === false, codeOf(created))
    check('with the leaf code', created.error.code === 'LEAF_NOT_ACTIONABLE', codeOf(created))
    check('the message names the new goal', created.error.message.includes('"New leaf"'), created.error.message)

    const createdOk = await call('goal_tree_edit', {
      expectedVersion: version,
      creates: [
        {
          depth: 2,
          parentId,
          title: 'New leaf',
          evidence: ['README.md'],
          successCriteria: ['the new step publishes one checkpoint file'],
        },
      ],
      reason: 'add a concrete step',
    })
    check('the same create with criteria passes', createdOk.ok === true, codeOf(createdOk))

    const bypassNoReason = await call('goal_tree_edit', {
      expectedVersion: view.data.version,
      creates: [{ depth: 2, parentId, title: 'Parked leaf', evidence: ['README.md'] }],
      allowNonActionableLeaves: true,
      reason: '',
    })
    check('the edit bypass also requires a reason', bypassNoReason.ok === false, codeOf(bypassNoReason))
    check('with REASON_REQUIRED', bypassNoReason.error.code === 'REASON_REQUIRED', codeOf(bypassNoReason))
  }

  console.log('\n[pure] the predicate and the vocabulary are testable on their own')

  {
    check('a bare platitude is generic', isGenericCriterion('完成') === true)
    check('a conjugated platitude is too', isGenericCriterion('做完了') === true)
    check('punctuation does not launder it', isGenericCriterion('推进。') === true)
    check('a concrete criterion is not generic', isGenericCriterion('完成登录页并跑通 e2e') === false)
    check('an empty string is blank, not generic', isGenericCriterion('') === false)
    check('the exported vocabulary is non-empty', GENERIC_CRITERIA.length > 0)
    check('and contains the documented examples', GENERIC_CRITERIA.includes('完成') && GENERIC_CRITERIA.includes('推进'))

    const report = inspectLeafActionability([
      { id: 'p', parentId: null, title: 'P' },
      { id: 'a', parentId: 'p', title: 'A', successCriteria: [] },
      { id: 'b', parentId: 'p', title: 'B', successCriteria: ['  '] },
      { id: 'c', parentId: 'p', title: 'C', successCriteria: ['推进'] },
      { id: 'd', parentId: 'p', title: 'D', successCriteria: ['npm test exits 0'] },
    ])
    check('three of four leaves are refused', report.leaves === 4 && report.issues.length === 3, JSON.stringify(report))
    check(
      'each gets its own reason',
      report.issues.map((issue) => issue.reason).join(',') === 'missing,blank,generic',
      report.issues.map((issue) => issue.reason).join(','),
    )
  }

  console.log('\n[separation] the two gates do not share a code')

  {
    const { call } = await freshProject()
    const refused = await call('goal_tree_confirm', {
      expectedVersion: 0,
      l0: {
        title: 'Root',
        evidence: ['README.md'],
        successCriteria: ['the root outcome is observable from outside'],
        // No relevantActivities and no allowedMethods: this tree fails the
        // matching gate first, and must still report that gate's code.
        alignment: { relevantActivities: [] },
      },
      goals: [],
      contradictions: [],
      reason: 'criteria gate fixture',
    })
    check('the matching gate still speaks first', refused.ok === false, codeOf(refused))
    check('with its own code', refused.error.code === 'CRITERIA_REQUIRED', codeOf(refused))
    check('not the leaf code', refused.error.code !== 'LEAF_NOT_ACTIONABLE')
  }

  console.log('\n[revise] metacog_revise has no channel that can create or empty a leaf')

  {
    const { call, tools } = await freshProject()
    const confirmed = await call('goal_tree_confirm', {
      expectedVersion: 0,
      l0: ROOT,
      goals: [
        { title: 'Parent', depth: 1, evidence: ['README.md'], relevantActivities: ['parent work'] },
        {
          title: 'Leaf',
          depth: 2,
          parentRef: 'Parent',
          evidence: ['README.md'],
          relevantActivities: ['leaf work'],
          successCriteria: ['the leaf writes one file per run'],
        },
      ],
      contradictions: [],
      reason: 'revise fixture',
    })
    check('the revise fixture confirms', confirmed.ok === true, codeOf(confirmed))

    // The contract can only be bypassed if the payload offers a way to add a
    // goal, delete one (turning a parent into a leaf), or write criteria. It
    // offers none: no structural kind, and no field that reaches successCriteria.
    const reviseSchema = tools.get('metacog_revise').parameters
    const revisionProperties = reviseSchema.properties.revisions.items.properties
    const kinds = revisionProperties.kind.enum
    check(
      'no goal_added / goal_removed kind exists',
      !kinds.some((kind) => kind === 'goal_added' || kind === 'goal_removed'),
      JSON.stringify(kinds),
    )
    check(
      'a revision item has no successCriteria field',
      !Object.prototype.hasOwnProperty.call(revisionProperties, 'successCriteria'),
      JSON.stringify(Object.keys(revisionProperties)),
    )
    check(
      'the kind list is exactly the seven documented revisions',
      JSON.stringify(kinds) ===
        JSON.stringify([
          'goal_changed',
          'goal_achieved',
          'goal_shelved',
          'contradiction_resolved',
          'contradiction_added',
          'contradiction_intensified',
          'root_changed',
        ]),
      JSON.stringify(kinds),
    )

    const before = await call('goal_tree_view', {})
    const leafBefore = before.data.goals.find((goal) => goal.title === 'Leaf')
    const countBefore = before.data.goals.length

    const renamed = await call('metacog_revise', {
      expectedVersion: before.data.version,
      reason: 'the wording no longer matches intent',
      revisions: [
        { kind: 'goal_changed', target: leafBefore.id, newTitle: 'Leaf renamed', newDescription: 'reworded' },
      ],
    })
    check('a goal_changed revision applies', renamed.ok === true, codeOf(renamed))
    const afterRename = await call('goal_tree_view', {})
    const leafAfterRename = afterRename.data.goals.find((goal) => goal.id === leafBefore.id)
    check(
      'the renamed goal keeps its criteria',
      JSON.stringify(leafAfterRename.successCriteria) === '["the leaf writes one file per run"]',
      JSON.stringify(leafAfterRename.successCriteria),
    )
    check('and no goal was added or removed', afterRename.data.goals.length === countBefore, afterRename.data.goals.length)

    // Even with the host's schema validation bypassed (calling execute
    // directly), applyRevisions has no branch that creates a goal.
    const added = await call('metacog_revise', {
      expectedVersion: afterRename.data.version,
      reason: 'try to create a goal through the revision channel',
      revisions: [{ kind: 'goal_added', target: 'Parent', newTitle: 'Sneaky leaf' }],
    })
    check(
      'an undeclared goal_added kind applies nothing',
      added.ok === true && added.data.applied.length === 0,
      codeOf(added),
    )
    check(
      'and is reported as an unknown kind',
      added.data.skipped?.[0]?.reason === 'unknown revision kind',
      JSON.stringify(added.data.skipped),
    )
    const afterAdd = await call('goal_tree_view', {})
    check('the goal count is unchanged', afterAdd.data.goals.length === countBefore, afterAdd.data.goals.length)
    check('no Sneaky leaf exists', !afterAdd.data.goals.some((goal) => goal.title === 'Sneaky leaf'))

    // An extra field is ignored by applyRevisions rather than copied onto the
    // node: there is no assignment to goal.successCriteria anywhere in the path.
    const withCriteria = await call('metacog_revise', {
      expectedVersion: afterAdd.data.version,
      reason: 'try to write criteria through the revision channel',
      revisions: [{ kind: 'goal_changed', target: leafBefore.id, successCriteria: [] }],
    })
    check('the payload with an undeclared criteria field is accepted as a text no-op', withCriteria.ok === true, codeOf(withCriteria))
    const afterCriteria = await call('goal_tree_view', {})
    const leafStill = afterCriteria.data.goals.find((goal) => goal.id === leafBefore.id)
    check(
      'and the criteria were not emptied',
      JSON.stringify(leafStill.successCriteria) === '["the leaf writes one file per run"]',
      JSON.stringify(leafStill.successCriteria),
    )

    // Scope statement: revise neither creates debt nor repairs it. A leaf parked
    // through the documented escape hatch stays parked, because reporting on a
    // tree is not the same act as changing its structure.
    const parentNode = afterCriteria.data.goals.find((goal) => goal.title === 'Parent')
    const parked = await call('goal_tree_edit', {
      expectedVersion: afterCriteria.data.version,
      creates: [{ depth: 2, parentId: parentNode.id, title: 'Parked', evidence: ['README.md'] }],
      allowNonActionableLeaves: true,
      reason: 'park a placeholder on purpose',
    })
    check('the escape hatch can park a leaf without criteria', parked.ok === true, codeOf(parked))
    const parkedView = await call('goal_tree_view', {})
    const parkedLeaf = parkedView.data.goals.find((goal) => goal.title === 'Parked')
    check('the parked leaf has no criteria', parkedLeaf.successCriteria.length === 0, JSON.stringify(parkedLeaf.successCriteria))

    const achieved = await call('metacog_revise', {
      expectedVersion: parkedView.data.version,
      reason: 'the strategy is finished',
      revisions: [{ kind: 'goal_achieved', target: parentNode.id }],
    })
    check('revise still records a status change on that tree', achieved.ok === true, codeOf(achieved))
    const finalView = await call('goal_tree_view', {})
    check(
      'the parked leaf is still parked (revise does not repair debt)',
      finalView.data.goals.find((goal) => goal.id === parkedLeaf.id)?.successCriteria.length === 0,
    )
    check(
      'and the revision created no goal (revise does not add debt)',
      finalView.data.goals.length === parkedView.data.goals.length,
      finalView.data.goals.length,
    )
  }
} finally {
  for (const root of fixtures) await rm(root, { recursive: true, force: true })
}

console.log(`\nLeaf actionability: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
