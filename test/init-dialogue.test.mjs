/**
 * R: initialisation as a dialogue, not a race.
 *
 * The cases follow the complaint that produced this task: the model derived,
 * confirmed and froze a tree without asking anything or showing the user what
 * it was about to freeze. So the assertions are about the *order* (ask before
 * derive), the *gate* (a placeholder role cannot pass), the *content*
 * (`paths`/`deadline` are derived and checked), and the *two-stage confirm*
 * (a version must have been previewed, and approval must be explicit).
 *
 * Run: node test/init-dialogue.test.mjs   (after `npm run build`)
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (path) => pathToFileURL(join(here, '..', 'lib', path)).href

const { METACOG_PROTOCOL } = await import(lib('protocol.js'))
const { reviewDerivation, DERIVATION_JSON_SCHEMA } = await import(lib('analysis/derive.js'))
const { goalTreeConfirmTool } = await import(lib('tools/tree-lifecycle.js'))
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

// ----------------------------------------------------------------- protocol
console.log('\n[protocol] ask first, derive second, preview third')
{
  check('the old "do not stop to ask" line is gone', !METACOG_PROTOCOL.includes('不要因为缺上下文就停下来先问'), 'still present')
  const askAt = METACOG_PROTOCOL.indexOf('先问用户')
  const deriveAt = METACOG_PROTOCOL.indexOf('按回答推导')
  check('the ask step exists', askAt >= 0)
  check('the ask step comes before derivation', askAt >= 0 && deriveAt > askAt, `${askAt} / ${deriveAt}`)
  check('the first round names role, intent and constraints', /角色/.test(METACOG_PROTOCOL) && /意图/.test(METACOG_PROTOCOL) && /约束/.test(METACOG_PROTOCOL))
  check('the second round asks each L1 deadline with date clues', /第二轮提问/.test(METACOG_PROTOCOL) && /逐个 L1 问预期截止时间/.test(METACOG_PROTOCOL) && /11-07/.test(METACOG_PROTOCOL))
  check('the preview step comes before confirmation', METACOG_PROTOCOL.indexOf('preview: true') < METACOG_PROTOCOL.indexOf('userApproved: true'), METACOG_PROTOCOL.slice(0, 200))
  check('the fallback forbids skipping questions', /不允许因为工具不可用就跳过提问直接确认/.test(METACOG_PROTOCOL), METACOG_PROTOCOL.slice(-500))
}

// -------------------------------------------------------------- derive schema
console.log('\n[derive] paths and deadline are part of the contract')
{
  const props = DERIVATION_JSON_SCHEMA.properties.goals.items.properties
  check('the output schema has paths', props.paths !== undefined, JSON.stringify(Object.keys(props)))
  check('the output schema has deadline', props.deadline !== undefined, JSON.stringify(Object.keys(props)))
  check('paths is an array of strings', props.paths.type === 'array' && props.paths.items.type === 'string')
  check('deadline is a string', props.deadline.type === 'string')
}

function derivedGoal(overrides = {}) {
  return {
    tempId: 'g1',
    parentTempId: '',
    depth: 1,
    title: '任务一',
    description: '',
    derivation: '目录 src 下有 3 个文件，说明这是实现任务。',
    evidence: ['src'],
    successCriteria: ['src/index.ts 存在且 npm test 通过'],
    relevantActivities: ['写代码'],
    allowedMethods: [],
    paths: [],
    deadline: '',
    confidence: 0.8,
    alternative: '',
    status: 'active',
    statusBasis: 'deliverable',
    statusEvidence: 'src/index.ts',
    ...overrides,
  }
}

function derivation(goals) {
  return {
    evidenceManifest: [],
    goals,
    contradictions: [],
    projectProfile: { summary: '', stage: '', deliverables: [] },
    noContradictionFound: true,
    openQuestions: [],
  }
}

console.log('\n[derive] placeholder role becomes an open question')
{
  const review = reviewDerivation(
    derivation([derivedGoal()]),
    {
      role: '未确认：从文件看是各项事务的执行与统稿者',
      intent: '',
      constraints: [],
      stakeholders: [],
      projectSummary: '',
      stage: '',
      deliverables: [],
    },
    undefined,
  )
  check('the placeholder role is called out', review.questions.some((line) => /尚未确认|未确认/.test(line) && /角色|role/.test(line)), JSON.stringify(review.questions))
}

console.log('\n[derive] path and deadline gates')
{
  const root = await mkdtemp(join(tmpdir(), 'metacog-init-'))
  await mkdir(join(root, 'src'), { recursive: true })
  try {
    const review = reviewDerivation(
      derivation([
        derivedGoal({ tempId: 'g1', paths: ['src'], deadline: '2999-01-01T00:00:00.000Z' }),
        derivedGoal({ tempId: 'g2', title: '坏路径', paths: ['missing-dir', 'C:\\absolute'] }),
        derivedGoal({ tempId: 'g3', title: '过期', deadline: '2000-01-01T00:00:00.000Z' }),
        derivedGoal({ tempId: 'g4', title: '无绑定', paths: [], deadline: '' }),
      ]),
      { role: '项目负责人', intent: '完成项目', constraints: [], stakeholders: [], projectSummary: '', stage: '', deliverables: [] },
      root,
    )
    const byId = new Map(review.output.goals.map((goal) => [goal.tempId, goal]))
    check('a real relative path is kept', byId.get('g1').paths.includes('src'), JSON.stringify(byId.get('g1').paths))
    check('a future deadline is kept as ISO', byId.get('g1').deadline === '2999-01-01T00:00:00.000Z', byId.get('g1').deadline)
    check('a missing path is rejected', review.rejections.some((item) => item.tempId === 'g2' && item.code === 'PATH_INVALID'), JSON.stringify(review.rejections))
    check('an absolute path is rejected', review.rejections.some((item) => item.tempId === 'g2' && item.code === 'PATH_INVALID'))
    check('the bad paths are dropped, not stored', byId.get('g2').paths.length === 0, JSON.stringify(byId.get('g2').paths))
    check('a past deadline is rejected', review.rejections.some((item) => item.tempId === 'g3' && item.code === 'DEADLINE_INVALID'), JSON.stringify(review.rejections))
    check('the past deadline is cleared', byId.get('g3').deadline === '', byId.get('g3').deadline)
    check('an L1 without paths is asked about', review.questions.some((line) => /没有绑定任务目录/.test(line) && /无绑定/.test(line)), JSON.stringify(review.questions))
    check('an L1 without a deadline is asked about', review.questions.some((line) => /没有预期截止时间/.test(line) && /无绑定/.test(line)), JSON.stringify(review.questions))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// -------------------------------------------------------------- confirm flow
console.log('\n[confirm] preview first, approve explicitly, then commit')
{
  const root = await mkdtemp(join(tmpdir(), 'metacog-confirm-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'README.md'), '# 项目\n', 'utf8')
  const config = parseConfig({})
  const projectId = deriveProjectId(root)
  const store = new MetacogStore(root, config.storageSubdir)
  const context = {
    role: '项目负责人',
    intent: '完成换届',
    constraints: ['2026-11-07 换届会议'],
    stakeholders: [],
    projectSummary: '',
    stage: '',
    deliverables: [],
  }
  await store.initialize(projectId, [], [], { projectContext: context })

  const env = {
    ctx: {
      get: () => undefined,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      on: () => () => {},
      effect: () => {},
    },
    config,
    resolveProjectRoot: async () => root,
    storeFor: () => store,
  }
  const exec = {
    callId: 'confirm-test',
    name: 'goal_tree_confirm',
    arguments: {},
    signal: new AbortController().signal,
    projectRoot: root,
  }
  const tool = goalTreeConfirmTool(env)
  const args = {
    expectedVersion: 0,
    l0: {
      title: '项目根目标',
      evidence: ['README.md'],
      successCriteria: ['换届完成'],
      alignment: { relevantActivities: ['筹备'] },
    },
    goals: [
      {
        title: 'L1 任务',
        depth: 1,
        evidence: ['README.md'],
        successCriteria: ['L1 交付物存在'],
        paths: ['src'],
        deadline: '2999-01-01T00:00:00.000Z',
        alignment: { relevantActivities: ['写代码'] },
      },
      {
        title: 'L2 子任务',
        depth: 2,
        parentRef: 'L1 任务',
        evidence: ['README.md'],
        successCriteria: ['L2 交付物存在'],
        paths: ['src'],
        deadline: '2999-01-01T00:00:00.000Z',
        alignment: { relevantActivities: ['写代码'] },
      },
    ],
    contradictions: [],
    reason: '用户确认的树',
  }

  try {
    const early = await tool.execute(args, exec)
    check('confirm without preview is refused', early.ok === false && early.error.code === 'PREVIEW_REQUIRED', JSON.stringify(early))

    const preview = await tool.execute({ ...args, preview: true }, exec)
    check('preview succeeds', preview.ok === true && preview.data.preview === true, JSON.stringify(preview))
    check('preview returns goal tree text', /L1 任务/.test(preview.data.goalsText) && /L2 子任务/.test(preview.data.goalsText), preview.data.goalsText)
    check('the L2 is indented under its L1, not another root', /\n\s+└─ L2 子任务/.test(preview.data.goalsText), preview.data.goalsText)
    check('an empty contradiction tree is stated explicitly', preview.data.contradictionTreeEmpty === true && /未发现结构性矛盾/.test(preview.data.contradictionsText), preview.data.contradictionsText)
    const afterPreview = await store.readState(projectId)
    check('preview writes no tree', afterPreview.confirmed === false && afterPreview.version === 0, JSON.stringify({ confirmed: afterPreview.confirmed, version: afterPreview.version }))

    const noApproval = await tool.execute(args, exec)
    check('approval is required after preview', noApproval.ok === false && noApproval.error.code === 'APPROVAL_REQUIRED', JSON.stringify(noApproval))

    const noNote = await tool.execute({ ...args, userApproved: true }, exec)
    check('an approval note is required', noNote.ok === false && noNote.error.code === 'APPROVAL_NOTE_REQUIRED', JSON.stringify(noNote))

    const confirmed = await tool.execute({ ...args, userApproved: true, approvalNote: '用户看过预览，同意这棵树' }, exec)
    check('the same version confirms after preview and approval', confirmed.ok === true && confirmed.data.version === 1, JSON.stringify(confirmed))
    check('the approval note is echoed', confirmed.data.approvalNote === '用户看过预览，同意这棵树')
    const state = await store.readState(projectId)
    check('the tree is confirmed', state.confirmed === true && state.version === 1)
    const audit = await store.readAuditLog(projectId)
    const entry = audit.find((item) => item.action === 'init_trees')
    check('the audit entry records the approval note', entry !== undefined && entry.reason.includes('用户看过预览，同意这棵树'), JSON.stringify(entry?.reason))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log('\n[confirm] an L1 deadline must be answered or explicitly waived')
{
  const root = await mkdtemp(join(tmpdir(), 'metacog-confirm-deadline-'))
  await writeFile(join(root, 'README.md'), '# 项目\n', 'utf8')
  const config = parseConfig({})
  const projectId = deriveProjectId(root)
  const store = new MetacogStore(root, config.storageSubdir)
  await store.initialize(projectId, [], [], {
    projectContext: { role: '负责人', intent: '完成', constraints: [], stakeholders: [], projectSummary: '', stage: '', deliverables: [] },
  })
  const env = {
    ctx: { get: () => undefined, logger: { debug() {}, info() {}, warn() {}, error() {} }, on: () => () => {}, effect: () => {} },
    config,
    resolveProjectRoot: async () => root,
    storeFor: () => store,
  }
  const exec = {
    callId: 'confirm-deadline',
    name: 'goal_tree_confirm',
    arguments: {},
    signal: new AbortController().signal,
    projectRoot: root,
  }
  const tool = goalTreeConfirmTool(env)
  const args = {
    expectedVersion: 0,
    l0: { title: '根', evidence: ['README.md'], successCriteria: ['完成'], alignment: { relevantActivities: ['筹备'] } },
    goals: [
      { title: 'L1 任务', depth: 1, evidence: ['README.md'], successCriteria: ['src/index.ts 存在且 npm test 通过'], alignment: { relevantActivities: ['写代码'] } },
    ],
    contradictions: [],
    reason: 'deadline 测试',
  }
  try {
    await tool.execute({ ...args, preview: true }, exec)
    const blocked = await tool.execute({ ...args, userApproved: true, approvalNote: '同意' }, exec)
    check('a missing L1 deadline blocks confirmation', blocked.ok === false && blocked.error.code === 'DEADLINE_REQUIRED', JSON.stringify(blocked))
    check('the refusal names the goal', blocked.ok === false && /L1 任务/.test(blocked.error.message), blocked.error?.message)

    await tool.execute({ ...args, preview: true, noDeadlineGoalRefs: ['L1 任务'] }, exec)
    const waived = await tool.execute({ ...args, userApproved: true, approvalNote: '用户说这个目标没有截止时间' }, exec)
    check('an explicit no-deadline record lets it confirm', waived.ok === true, JSON.stringify(waived))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log('\n[confirm] a changed version requires a fresh preview')
{
  const root = await mkdtemp(join(tmpdir(), 'metacog-confirm-version-'))
  await writeFile(join(root, 'README.md'), '# 项目\n', 'utf8')
  const config = parseConfig({})
  const projectId = deriveProjectId(root)
  const store = new MetacogStore(root, config.storageSubdir)
  await store.initialize(projectId, [], [], {
    projectContext: { role: '负责人', intent: '完成', constraints: [], stakeholders: [], projectSummary: '', stage: '', deliverables: [] },
  })
  const env = {
    ctx: { get: () => undefined, logger: { debug() {}, info() {}, warn() {}, error() {} }, on: () => () => {}, effect: () => {} },
    config,
    resolveProjectRoot: async () => root,
    storeFor: () => store,
  }
  const exec = {
    callId: 'confirm-version',
    name: 'goal_tree_confirm',
    arguments: {},
    signal: new AbortController().signal,
    projectRoot: root,
  }
  const tool = goalTreeConfirmTool(env)
  const args = {
    expectedVersion: 0,
    l0: { title: '根', evidence: ['README.md'], successCriteria: ['完成'], alignment: { relevantActivities: ['筹备'] } },
    goals: [
      { title: 'L1', depth: 1, evidence: ['README.md'], successCriteria: ['src/index.ts 存在且 npm test 通过'], deadline: '2999-01-01T00:00:00.000Z', alignment: { relevantActivities: ['写代码'] } },
    ],
    contradictions: [],
    reason: '确认',
  }
  try {
    await tool.execute({ ...args, preview: true }, exec)
    // A revision after the preview bumps the version; the old preview is stale.
    const state = await store.readState(projectId)
    await store.commit(projectId, {
      expectedVersion: state.version,
      goals: state.goals,
      contradictions: state.contradictions,
      reason: 'post-preview revision',
      action: 'update_l1',
      actor: 'user_confirmed',
      targetIds: [],
    })
    const stale = await tool.execute({ ...args, expectedVersion: 1, userApproved: true, approvalNote: '同意' }, exec)
    check('a preview of an older version does not authorize the new one', stale.ok === false && stale.error.code === 'PREVIEW_REQUIRED', JSON.stringify(stale))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log('\n[confirm] a placeholder role is blocked unless explicitly waived')
{
  const root = await mkdtemp(join(tmpdir(), 'metacog-confirm-context-'))
  await writeFile(join(root, 'README.md'), '# 项目\n', 'utf8')
  const config = parseConfig({})
  const projectId = deriveProjectId(root)
  const store = new MetacogStore(root, config.storageSubdir)
  await store.initialize(projectId, [], [], {
    projectContext: {
      role: '未确认：从文件看是执行者',
      intent: '',
      constraints: [],
      stakeholders: [],
      projectSummary: '',
      stage: '',
      deliverables: [],
    },
  })
  const env = {
    ctx: { get: () => undefined, logger: { debug() {}, info() {}, warn() {}, error() {} }, on: () => () => {}, effect: () => {} },
    config,
    resolveProjectRoot: async () => root,
    storeFor: () => store,
  }
  const exec = {
    callId: 'confirm-context',
    name: 'goal_tree_confirm',
    arguments: {},
    signal: new AbortController().signal,
    projectRoot: root,
  }
  const tool = goalTreeConfirmTool(env)
  const args = {
    expectedVersion: 0,
    l0: { title: '根', evidence: ['README.md'], successCriteria: ['完成'], alignment: { relevantActivities: ['筹备'] } },
    goals: [
      { title: 'L1', depth: 1, evidence: ['README.md'], successCriteria: ['src/index.ts 存在且 npm test 通过'], deadline: '2999-01-01T00:00:00.000Z', alignment: { relevantActivities: ['写代码'] } },
    ],
    contradictions: [],
    reason: '确认',
  }
  try {
    await tool.execute({ ...args, preview: true }, exec)
    const blocked = await tool.execute({ ...args, userApproved: true, approvalNote: '同意' }, exec)
    check('a placeholder role blocks confirmation', blocked.ok === false && blocked.error.code === 'CONTEXT_UNCONFIRMED', JSON.stringify(blocked))

    const waived = await tool.execute(
      { ...args, userApproved: true, approvalNote: '同意', allowUnconfirmedContext: true, reason: '用户暂时无法确认角色' },
      exec,
    )
    check('an explicit waiver with a reason passes', waived.ok === true, JSON.stringify(waived))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
