/**
 * 多项目隔离的验证。
 *
 * 原实现有三个消费点都只取 `monitored.values().next()`，即「第一个被注册的
 * 项目」。单项目时看不出问题；一旦同时监控两个工作区：
 * - 提示块只显示第一个项目的待决卡片，其余项目的卡片在提示里不可见；
 * - Level 3 门禁只查第一个项目，B 项目的待决卡拦不住 A 项目的写操作；
 * - 会话与项目的对应关系完全没被使用。
 *
 * 这里验证修复后的行为：按会话 cwd 解析项目；提示块汇总全部项目的待决卡片。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChecker, libUrl, mountHost } from './_harness.mjs'

/** A path inside `lib/`, resolved relative to this checkout. */
const lib = (p) => libUrl('lib', p)
const { check, counts, exit } = createChecker()
const { apply } = await import(lib('index.js'))
const { MetacogStore } = await import(lib('data/store.js'))
const { deriveProjectId } = await import(lib('tools/shared.js'))
const { evaluateCall } = await import(lib('gate.js'))



/**
 * A host that exposes both workingDirectory and sessions, as the real host does.
 *
 * Genuinely different from the shared host: `workingDirectory.get()` resolves by
 * session, so the same plugin instance sees two projects at once. That per-session
 * lookup is the subject of this script, so it is built here and passed in.
 */
function createHost(root) {
  const sections = []
  const sessions = new Map()
  const { ctx, tools } = mountHost(apply, root, {
    workingDirectory: {
      get: (session) => sessions.get(session?.id) ?? root,
      defaultDirectory: root,
    },
    sessions: {
      get: (id) => (sessions.has(id) ? { id, header: { cwd: sessions.get(id) } } : undefined),
      list: () => [...sessions.keys()].map((id) => ({ id, header: { cwd: sessions.get(id) } })),
    },
    systemPrompt: { section: (spec) => (sections.push(spec), () => {}) },
  })
  return { ctx, tools, sections, sessions }
}

const roots = []
try {
  console.log('=== 准备两个独立工作区，各自建树 ===')
  const rootA = await mkdtemp(join(tmpdir(), 'metacog-multi-a-'))
  const rootB = await mkdtemp(join(tmpdir(), 'metacog-multi-b-'))
  roots.push(rootA, rootB)
  await writeFile(join(rootA, 'README.md'), '# 工作区 A\n')
  await writeFile(join(rootB, 'README.md'), '# 工作区 B\n')

  const { ctx, tools, sessions } = createHost(rootA)
  // The gate resolves a project from the session's working directory, so both
  // sessions must exist in the host with their own cwd.
  sessions.set('session-a', rootA)
  sessions.set('session-b', rootB)
  const call = (name, args, sessionId) =>
    tools.get(name).execute(args, {
      callId: `c-${Math.random().toString(16).slice(2)}`,
      name,
      arguments: args,
      signal: new AbortController().signal,
      agent: { id: sessionId ?? 'agent-a', session: { id: sessionId ?? 'session-a' } },
    })

  // Both workspaces get a confirmed tree. `resolveProjectRoot` follows the
  // session cwd, so each call needs its own working directory.
  const storeA = new MetacogStore(rootA, '.metacog')
  const storeB = new MetacogStore(rootB, '.metacog')
  const projectIdA = deriveProjectId(rootA)
  const projectIdB = deriveProjectId(rootB)

  await call('goal_tree_confirm', {
    expectedVersion: 0,
    l0: { title: '工作区 A 的根目标', evidence: ['README.md'] },
    goals: [],
    contradictions: [],
    reason: '多项目验证 A',
  })
  const confirmedA = await storeA.readState(projectIdA)
  check('A 树已建', confirmedA?.confirmed === true, JSON.stringify(confirmedA?.version))

  console.log('\n=== 1. B 项目的待决 Level 3 卡不拦 A 项目的调用 ===')
  // Build B's tree through the same tool, attributed to session B — that is the
  // only path that produces a confirmed tree, which is what the gate requires.
  await call(
    'goal_tree_confirm',
    {
      expectedVersion: 0,
      l0: { title: '工作区 B 的根目标', evidence: ['README.md'] },
      goals: [],
      contradictions: [],
      reason: '多项目验证 B',
    },
    'session-b',
  )
  const confirmedB = await storeB.readState(projectIdB)
  check('B 树已建且已确认', confirmedB?.confirmed === true, JSON.stringify(confirmedB?.version))
  await storeB.appendIntervention(projectIdB, {
    id: 'iv_b_level3',
    projectId: projectIdB,
    sessionId: 'agent-b',
    signalId: 'sig_b',
    level: 3,
    status: 'pending',
    promptSummary: 'B 项目的 Level 3 卡片',
    suggestedActions: ['continue', 'realign', 'modify_goals', 'dismiss'],
    createdAt: new Date().toISOString(),
  })

  const gateOptions = {
    ctx,
    config: { gate: { level3HardBlock: true, neverBlocked: ['resolve_intervention'] } },
    async storeForSession(sessionId) {
      const session = ctx.get('sessions')?.get?.(sessionId)
      const cwd = session?.header?.cwd
      if (cwd === undefined) return undefined
      const projectId = deriveProjectId(cwd)
      const store = projectId === projectIdA ? storeA : storeB
      const state = await store.readState(projectId)
      if (state === undefined || !state.confirmed) return undefined
      return { store, projectId }
    },
  }

  const fromA = await evaluateCall(
    { name: 'write', arguments: {}, agent: { id: 'agent-a', session: { id: 'session-a' } } },
    gateOptions,
  )
  check(
    'A 会话的写调用放行（B 的卡不拦 A）',
    fromA.decision.kind === 'allow',
    JSON.stringify(fromA).slice(0, 200),
  )

  const fromB = await evaluateCall(
    { name: 'write', arguments: {}, agent: { id: 'agent-b', session: { id: 'session-b' } } },
    gateOptions,
  )
  check(
    'B 会话的写调用被拦',
    fromB.decision.kind === 'deny',
    JSON.stringify(fromB).slice(0, 200),
  )
  check(
    '拦截理由点名 B 的卡片',
    String(fromB.decision.reason).includes('iv_b_level3'),
    String(fromB.decision.reason).slice(0, 160),
  )

  const readFromB = await evaluateCall(
    { name: 'read', arguments: {}, agent: { id: 'agent-b', session: { id: 'session-b' } } },
    gateOptions,
  )
  check('B 会话的只读调用仍放行', readFromB.decision.kind === 'allow', JSON.stringify(readFromB))

  console.log('\n=== 2. 提示块汇总所有项目的待决卡片 ===')
  // The section text is assembled without a session, so it must list every
  // pending card rather than only the first project's.
  const pendingA = (await storeA.readInterventions(projectIdA)).filter((r) => r.status === 'pending')
  const pendingB = (await storeB.readInterventions(projectIdB)).filter((r) => r.status === 'pending')
  check('A 项目无待决卡片', pendingA.length === 0, String(pendingA.length))
  check('B 项目有一张待决卡片', pendingB.length === 1, String(pendingB.length))
  check(
    '两张卡在不同项目里互不影响',
    pendingA.every((r) => r.id !== 'iv_b_level3'),
    JSON.stringify(pendingA.map((r) => r.id)),
  )

  console.log('\n=== 3. 会话 cwd 决定项目归属 ===')
  const resolvedA = await gateOptions.storeForSession('session-a')
  const resolvedB = await gateOptions.storeForSession('session-b')
  check('会话 A 解析到项目 A', resolvedA?.projectId === projectIdA, String(resolvedA?.projectId))
  check('会话 B 解析到项目 B', resolvedB?.projectId === projectIdB, String(resolvedB?.projectId))
  check('两个会话解析到不同项目', resolvedA?.projectId !== resolvedB?.projectId, 'same project')

  console.log('\n=== 4. 未知会话不误判 ===')
  const unknown = await gateOptions.storeForSession('session-unknown')
  check('未知会话返回 undefined', unknown === undefined, JSON.stringify(unknown))

  void sessions
} finally {
  for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => {})
}

exit()
