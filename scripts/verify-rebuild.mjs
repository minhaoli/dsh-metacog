/**
 * 功能验证：重建（force + expectedVersion）
 *
 * 用临时项目 + 桩子代理，走真实的 goal_tree_init → resetForRebuild → 备份 → 审计 路径。
 * 不触碰任何真实工作区。
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChecker, libUrl, mountHost } from './_harness.mjs'

/** A path inside `lib/`, resolved relative to this checkout. */
const lib = (p) => libUrl('lib', p)
const { check, counts, exit } = createChecker()
const { apply } = await import(lib('index.js'))

const STRUCTURED = {
  evidenceManifest: [{ path: 'README.md', why: '项目意图', useful: true }],
  goals: [
    {
      tempId: 'g0',
      parentTempId: '',
      depth: 0,
      title: '重建后的新根目标',
      derivation: 'README 说明这次重建是为了验证覆盖路径，原文见第一段。',
      evidence: ['README.md'],
      successCriteria: [],
      confidence: 0.8,
    },
    {
      tempId: 'g1',
      parentTempId: 'g0',
      depth: 1,
      title: '重建后的第二层',
      derivation: 'README 第二段要求保留版本连续性，因此新树仍需可确认。',
      evidence: ['README.md'],
      successCriteria: [],
      confidence: 0.7,
    },
  ],
  contradictions: [],
  projectProfile: { summary: '重建验证项目', stage: '验证中', deliverables: [] },
  noContradictionFound: true,
  openQuestions: [],
}

/** Mount against a host whose subagent returns the fixed derivation above. */
function createHost(root) {
  return mountHost(apply, root, {
    agents: { currentInitiator: () => ({ id: 'agent-verify' }) },
    subagents: {
      list: () => ['stub'],
      resolveMaxDepth: () => 3,
      async startActivation() {
        return {
          childId: 'child-stub',
          result: Promise.resolve({
            output: [{ type: 'text', text: '{}' }],
            stopReason: 'completed',
            structured: STRUCTURED,
          }),
          dispose: async () => {},
        }
      },
    },
  })
}

const root = await mkdtemp(join(tmpdir(), 'metacog-rebuild-'))


try {
  await writeFile(join(root, 'README.md'), '# 重建验证\n\n第一段说明意图。\n\n第二段要求保留版本连续性。\n')
  const { tools } = createHost(root)
  const call = (name, args) =>
    tools.get(name).execute(args, {
      callId: `c-${Math.random().toString(16).slice(2)}`,
      name,
      arguments: args,
      signal: new AbortController().signal,
      agent: { id: 'agent-verify' },
    })

  console.log('\n=== 准备：建一棵确认树 ===')
  const confirmed = await call('goal_tree_confirm', {
    expectedVersion: 0,
    l0: { title: '原始根目标', evidence: ['README.md'] },
    goals: [{ depth: 1, title: '原始第二层', evidence: ['README.md'] }],
    contradictions: [],
    reason: '重建验证的基线',
  })
  check('确认成功', confirmed.ok === true, JSON.stringify(confirmed).slice(0, 200))
  check('版本为 1', confirmed.data?.version === 1, String(confirmed.data?.version))

  const edited = await call('goal_tree_edit', {
    expectedVersion: 1,
    creates: [{ depth: 2, parentId: (await call('goal_tree_view', {})).data.goals.find((g) => g.depth === 1).id, title: '原始第三层', evidence: ['README.md'] }],
    reason: '加一层，制造版本 2',
  })
  check('编辑成功到 v2', edited.ok === true && edited.data?.version === 2, JSON.stringify(edited).slice(0, 200))

  console.log('\n=== 1. 已确认树上不带 force 的重建必须被拒 ===')
  const refused = await call('goal_tree_init', {})
  check('返回 ALREADY_INITIALIZED', refused.ok === false && refused.error.code === 'ALREADY_INITIALIZED', JSON.stringify(refused).slice(0, 200))

  console.log('\n=== 2. 只给 force 不够，必须给 expectedVersion ===')
  const noVersion = await call('goal_tree_init', { force: true })
  check('返回 EXPECTED_VERSION_REQUIRED', noVersion.ok === false && noVersion.error.code === 'EXPECTED_VERSION_REQUIRED', JSON.stringify(noVersion).slice(0, 200))

  console.log('\n=== 3. 版本号不对必须冲突，且树无损 ===')
  const wrong = await call('goal_tree_init', { force: true, expectedVersion: 99 })
  check('返回 VERSION_CONFLICT', wrong.ok === false && wrong.error.code === 'VERSION_CONFLICT', JSON.stringify(wrong).slice(0, 200))
  const intact = await call('goal_tree_view', {})
  check('树仍然完整', intact.data?.goals.length === 3 && intact.data?.confirmed === true, `${intact.data?.goals.length} 节点`)

  console.log('\n=== 4. force + 正确版本号 → 重建 ===')
  const rebuilt = await call('goal_tree_init', { force: true, expectedVersion: 2 })
  check('重建成功', rebuilt.ok === true, JSON.stringify(rebuilt).slice(0, 300))
  check('模式是 derived', rebuilt.data?.mode === 'derived', String(rebuilt.data?.mode))
  check('带回 rebuild 信息', rebuilt.data?.rebuild !== null && rebuilt.data?.rebuild !== undefined, JSON.stringify(rebuilt.data?.rebuild))
  check('记录了被替换的版本', rebuilt.data?.rebuild?.previousVersion === 2, String(rebuilt.data?.rebuild?.previousVersion))

  console.log('\n=== 5. 备份文件真的落盘 ===')
  const backupPath = rebuilt.data?.rebuild?.backupPath
  check('备份路径存在', typeof backupPath === 'string', String(backupPath))
  if (typeof backupPath === 'string') {
    const backup = JSON.parse(await readFile(backupPath, 'utf8'))
    check('备份里是旧树', backup.goals.length === 3, `${backup.goals.length} 节点`)
    check('备份保留旧根目标标题', backup.goals.some((g) => g.title === '原始根目标'))
  }

  console.log('\n=== 6. 重建后树回到未确认草稿 ===')
  const afterRebuild = await call('goal_tree_view', {})
  check('未确认', afterRebuild.data?.confirmed === false)
  check('版本没有回退（仍是 2）', afterRebuild.data?.version === 2, String(afterRebuild.data?.version))
  check('草稿里是新推导的两个节点', afterRebuild.data?.goals.length === 2, String(afterRebuild.data?.goals.length))
  check('节点全部是 draft', afterRebuild.data?.goals.every((g) => g.status === 'draft') === true)

  console.log('\n=== 7. 审计链记录了 tree_reset 且仍然有效 ===')
  const auditPath = join(root, '.metacog', 'audit')
  const auditFiles = await readdir(auditPath)
  const entries = (await readFile(join(auditPath, auditFiles[0]), 'utf8'))
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))
  check('存在 tree_reset 记录', entries.some((e) => e.action === 'tree_reset'), entries.map((e) => e.action).join(','))
  check('审计链校验通过', afterRebuild.data?.audit.valid === true)
  check('版本连续，没有回退到 1', afterRebuild.data?.audit.entries >= 3, String(afterRebuild.data?.audit.entries))

  console.log('\n=== 8. 旧快照没有被覆盖 ===')
  const snapshots = await readdir(join(root, '.metacog', 'snapshots', auditFiles[0].replace('.jsonl', '')))
  check('v1 与 v2 快照都在', snapshots.includes('1.json') && snapshots.includes('2.json'), snapshots.join(','))
  const snap2 = JSON.parse(
    await readFile(join(root, '.metacog', 'snapshots', auditFiles[0].replace('.jsonl', ''), '2.json'), 'utf8'),
  )
  check('v2 快照仍是旧树', snap2.goals.length === 3, `${snap2.goals.length} 节点`)

  console.log('\n=== 9. 重建后的草稿可以再次确认 ===')
  const reconfirm = await call('goal_tree_confirm', {
    expectedVersion: 2,
    l0: { title: '重建后的新根目标', evidence: ['README.md'] },
    goals: [{ depth: 1, title: '重建后的第二层', evidence: ['README.md'] }],
    contradictions: [],
    reason: '重建后确认新树',
  })
  check('再次确认成功', reconfirm.ok === true, JSON.stringify(reconfirm).slice(0, 200))
  check('版本推进到 3', reconfirm.data?.version === 3, String(reconfirm.data?.version))
} finally {
  await rm(root, { recursive: true, force: true })
}

exit(`\n=== 重建验证：${counts.passed} 通过，${counts.failed} 失败 ===`)
