/**
 * 用户直接编辑命令的验证：`/metacog-goal` 与 `/metacog-contradiction`。
 *
 * 命令的价值不在"能改"，而在"改得一样"：它是同一套受治理写入的第二个入口，
 * 不是特权通道。所以这里重点验证三件事：
 * - 解析层：字段校验、缺参数报错、引号与逗号切分；
 * - 写入层：CAS、L0/core 二次确认、审计条目与工具路径完全一致；
 * - 回显：版本、动作、改了什么、审计 id 都要给出来。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createChecker, libUrl } from './_harness.mjs'

/** A path inside `lib/`, resolved relative to this checkout. */
const lib = (p) => libUrl('lib', p)
const { apply } = await import(lib('index.js'))
const { MetacogStore } = await import(lib('data/store.js'))
const { deriveProjectId } = await import(lib('tools/shared.js'))
const {
  tokenize,
  parseGoalCommand,
  parseContradictionCommand,
  describeOutcome,
  GOAL_USAGE,
  CONTRADICTION_USAGE,
} = await import(lib('commands/edit.js'))

const { check, exit } = createChecker()
const codeOf = (error) => (error && typeof error === 'object' && 'code' in error ? error.code : String(error))
const throwsWith = (fn, code) => {
  try {
    fn()
    return false
  } catch (error) {
    return codeOf(error) === code
  }
}

console.log('=== 1. 分词 ===')
check('普通分词', JSON.stringify(tokenize('a b c')) === '["a","b","c"]', JSON.stringify(tokenize('a b c')))
check(
  '引号内保留空格',
  JSON.stringify(tokenize('"两个 词" next')) === '["两个 词","next"]',
  JSON.stringify(tokenize('"两个 词" next')),
)
check(
  '等号形式整体保留',
  JSON.stringify(tokenize('--title="新 标题"')) === '["--title=新 标题"]',
  JSON.stringify(tokenize('--title="新 标题"')),
)
check('空串给空数组', tokenize('   ').length === 0, JSON.stringify(tokenize('   ')))

console.log('\n=== 2. /metacog-goal 解析 ===')
const basic = parseGoalCommand('甲目标 --status=done --reason="做完了"')
check('解析出 target', basic.target === '甲目标', String(basic.target))
check('解析出 status', basic.fields.status === 'done', String(basic.fields.status))
check('解析出 reason', basic.reason === '做完了', basic.reason)
check('默认未确认', basic.confirmed === false, String(basic.confirmed))
check('默认是 set', basic.action === 'set', basic.action)

const forced = parseGoalCommand('甲目标 --title=乙 --force --reason="用户本人确认"')
check('--force 标记为已确认', forced.confirmed === true, String(forced.confirmed))
check('--force 不进入字段', forced.fields.force === undefined, JSON.stringify(forced.fields))

const listParsed = parseGoalCommand(
  '甲目标 --successCriteria="走 CAS, 有审计" --relevantActivities="建模,设计" --reason="补判据"',
)
check(
  '成功标准按逗号切成两条',
  JSON.stringify(listParsed.fields.successCriteria) === '["走 CAS","有审计"]',
  JSON.stringify(listParsed.fields.successCriteria),
)
check(
  '相关活动按逗号切成两条',
  JSON.stringify(listParsed.fields.relevantActivities) === '["建模","设计"]',
  JSON.stringify(listParsed.fields.relevantActivities),
)

const addParsed = parseGoalCommand('add --parent=甲目标 --depth=2 --title=新子目标 --reason="拆细"')
check('add 动作被识别', addParsed.action === 'add', addParsed.action)
check('add 无 target', addParsed.target === undefined, String(addParsed.target))
check('add 带 depth', addParsed.fields.depth === 2, String(addParsed.fields.depth))
check('add 带 parent', addParsed.fields.parent === '甲目标', String(addParsed.fields.parent))

console.log('\n=== 3. /metacog-goal 拒绝非法输入 ===')
check('缺 reason 被拒', throwsWith(() => parseGoalCommand('甲目标 --status=done'), 'REASON_REQUIRED'), 'not refused')
check('空 reason 被拒', throwsWith(() => parseGoalCommand('甲目标 --reason="  "'), 'REASON_REQUIRED'), 'not refused')
check('缺 target 被拒', throwsWith(() => parseGoalCommand('--status=done --reason="x"'), 'INVALID_ARGS'), 'not refused')
check(
  '非法 status 被拒',
  throwsWith(() => parseGoalCommand('甲 --status=finished --reason="x"'), 'INVALID_ARGS'),
  'not refused',
)
check(
  '非整数 priority 被拒',
  throwsWith(() => parseGoalCommand('甲 --priority=高 --reason="x"'), 'INVALID_ARGS'),
  'not refused',
)
check(
  '非法 explorationPolicy 被拒',
  throwsWith(() => parseGoalCommand('甲 --explorationPolicy=free --reason="x"'), 'INVALID_ARGS'),
  'not refused',
)
check(
  '只给 reason 不给字段被拒',
  throwsWith(() => parseGoalCommand('甲 --reason="x"'), 'INVALID_ARGS'),
  'not refused',
)
check(
  'add 缺 title 被拒',
  throwsWith(() => parseGoalCommand('add --parent=甲 --depth=2 --reason="x"'), 'INVALID_ARGS'),
  'not refused',
)
check(
  'add 缺 depth 被拒',
  throwsWith(() => parseGoalCommand('add --parent=甲 --title=乙 --reason="x"'), 'INVALID_ARGS'),
  'not refused',
)
check(
  'add 缺 parent 被拒',
  throwsWith(() => parseGoalCommand('add --depth=2 --title=乙 --reason="x"'), 'INVALID_ARGS'),
  'not refused',
)
check('用法文本非空', GOAL_USAGE.includes('--reason'), GOAL_USAGE.slice(0, 40))

console.log('\n=== 4. /metacog-contradiction 解析 ===')
const tension = parseContradictionCommand('"严格 vs 快" --intensity=4 --reason="更严重了"')
check('解析出 target', tension.target === '严格 vs 快', String(tension.target))
check('解析出 intensity', tension.fields.intensity === 4, String(tension.fields.intensity))
check('intensity 是数字', typeof tension.fields.intensity === 'number', typeof tension.fields.intensity)
// A title containing spaces must be quoted; unquoted it splits into words.
check(
  '未加引号的空格标题会被切碎',
  parseContradictionCommand('严格 vs 快 --intensity=4 --reason="x"').target === '严格',
  parseContradictionCommand('严格 vs 快 --intensity=4 --reason="x"').target,
)

const typed = parseContradictionCommand('某张力 --type=main --force --reason="改分类"')
check('解析出 type', typed.fields.type === 'main', String(typed.fields.type))
check('core 改动可带 --force', typed.confirmed === true, String(typed.confirmed))

check(
  'intensity 越界被拒',
  throwsWith(() => parseContradictionCommand('某张力 --intensity=9 --reason="x"'), 'INVALID_ARGS'),
  'not refused',
)
check(
  'intensity 非整数被拒',
  throwsWith(() => parseContradictionCommand('某张力 --intensity=3.5 --reason="x"'), 'INVALID_ARGS'),
  'not refused',
)
check(
  '非法 type 被拒',
  throwsWith(() => parseContradictionCommand('某张力 --type=primary --reason="x"'), 'INVALID_ARGS'),
  'not refused',
)
check(
  '缺 reason 被拒',
  throwsWith(() => parseContradictionCommand('某张力 --intensity=3'), 'REASON_REQUIRED'),
  'not refused',
)
check(
  '缺 target 被拒',
  throwsWith(() => parseContradictionCommand('--intensity=3 --reason="x"'), 'INVALID_ARGS'),
  'not refused',
)
check('矛盾用法文本非空', CONTRADICTION_USAGE.includes('--intensity'), CONTRADICTION_USAGE.slice(0, 40))

console.log('\n=== 5. 回显格式 ===')
const shown = describeOutcome({
  version: 7,
  auditEntryId: 'audit_x',
  auditAction: 'update_l1',
  changed: ['G1'],
  added: ['G2'],
  removed: ['G3'],
})
check('回显带版本', shown.includes('版本 → 7'), shown)
check('回显带动作', shown.includes('update_l1'), shown)
check('回显带改动', shown.includes('改动: G1'), shown)
check('回显带新增', shown.includes('新增: G2'), shown)
check('回显带删除', shown.includes('删除: G3'), shown)
check('回显带审计 id', shown.includes('audit_x'), shown)

console.log('\n=== 6. 命令走的是同一套受治理写入 ===')
const root = await mkdtemp(join(tmpdir(), 'metacog-cmd-'))
try {
  await writeFile(join(root, 'README.md'), '# 命令验证\n')
  const tools = new Map()
  const commands = new Map()
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') return { get: () => root, defaultDirectory: root }
      if (name === 'tools') return this.tools
      if (name === 'commands') {
        return { register: (def) => (commands.set(def.name, def), () => commands.delete(def.name)) }
      }
      if (name === 'sessions') return { get: () => undefined, list: () => [] }
      return undefined
    },
    logger: { debug() {}, info() {}, warn() {} },
    on: () => () => {},
    effect: () => {},
    tools: { register: (d) => (tools.set(d.name, d), () => tools.delete(d.name)) },
    workingDirectory: { get: () => root, defaultDirectory: root },
  }
  apply(ctx, {})

  check('两条命令都注册了', commands.has('metacog-goal') && commands.has('metacog-contradiction'), JSON.stringify([...commands.keys()]))

  const call = (name, args) =>
    tools.get(name).execute(args, {
      callId: `c-${Math.random().toString(16).slice(2)}`,
      name,
      arguments: args,
      signal: new AbortController().signal,
      agent: { id: 'cmd-test', session: { id: 'session-cmd', header: { cwd: root } } },
    })

  const store = new MetacogStore(root, '.metacog')
  const projectId = deriveProjectId(root)
  await call('goal_tree_confirm', {
    expectedVersion: 0,
    l0: { title: '命令验证的根目标', evidence: ['README.md'] },
    goals: [{ title: '甲目标', evidence: ['README.md'], depth: 1 }],
    contradictions: [
      {
        title: '某张力',
        poleA: 'A',
        poleB: 'B',
        evidence: ['README.md'],
        primaryGoalRef: '甲目标',
        type: 'main',
      },
    ],
    reason: '命令验证基线',
  })

  const agent = { id: 'cmd-test', session: { id: 'session-cmd', header: { cwd: root } } }
  const invoke = async (commandName, rawInput) => {
    const def = commands.get(commandName)
    return def.handler({ agent, rawInput, signal: new AbortController().signal })
  }

  console.log('\n--- 正常改字段 ---')
  const okEdit = await invoke('metacog-goal', '甲目标 --status=at_risk --priority=2 --reason="命令改状态"')
  check('命令执行成功', okEdit.kind === 'success', JSON.stringify(okEdit).slice(0, 200))
  check('回显带版本', String(okEdit.text).includes('版本 →'), String(okEdit.text))
  check('回显带审计 id', String(okEdit.text).includes('审计: audit_'), String(okEdit.text))

  const stateAfter = await store.readState(projectId)
  const goalAfter = stateAfter.goals.find((g) => g.title === '甲目标')
  check('status 已落盘', goalAfter?.status === 'at_risk', String(goalAfter?.status))
  check('priority 已落盘', goalAfter?.priority === 2, String(goalAfter?.priority))

  const auditAfter = await store.readAuditLog(projectId)
  const lastAudit = auditAfter[auditAfter.length - 1]
  check('审计 action 为 update_l1', lastAudit?.action === 'update_l1', String(lastAudit?.action))
  check('审计 reason 记录命令给的理由', String(lastAudit?.reason).includes('命令改状态'), String(lastAudit?.reason))
  check('审计 actor 为 user_confirmed', lastAudit?.actor === 'user_confirmed', String(lastAudit?.actor))

  console.log('\n--- L0 需要 --force ---')
  const rootTitle = stateAfter.goals.find((g) => g.depth === 0)?.title
  const noForce = await invoke('metacog-goal', `"${rootTitle}" --title=新根目标 --reason="改根"`)
  check('改 L0 未加 --force 被拒', noForce.kind === 'error', JSON.stringify(noForce).slice(0, 200))
  check('提示需要 --force', String(noForce.text).includes('--force'), String(noForce.text).slice(0, 160))

  const withForce = await invoke('metacog-goal', `"${rootTitle}" --title=新根目标 --force --reason="改根"`)
  check('加 --force 后成功', withForce.kind === 'success', JSON.stringify(withForce).slice(0, 200))
  const afterRename = await store.readState(projectId)
  check('根目标已改名', afterRename.goals.find((g) => g.depth === 0)?.title === '新根目标', String(afterRename.goals.find((g) => g.depth === 0)?.title))

  console.log('\n--- 找不到目标时给出可操作提示 ---')
  const missing = await invoke('metacog-goal', '不存在的目标 --status=done --reason="x"')
  check('未知目标被拒', missing.kind === 'error', JSON.stringify(missing).slice(0, 160))
  check('提示可用 id 或标题', String(missing.text).includes('id') || String(missing.text).includes('标题'), String(missing.text).slice(0, 120))

  console.log('\n--- 解析失败时给出用法 ---')
  const badParse = await invoke('metacog-goal', '甲目标 --status=finished --reason="x"')
  check('非法字段被拒', badParse.kind === 'error', JSON.stringify(badParse).slice(0, 160))
  check('附带用法文本', String(badParse.text).includes('用法'), String(badParse.text).slice(0, 120))

  console.log('\n--- 改矛盾 ---')
  const tensionEdit = await invoke('metacog-contradiction', '"某张力" --intensity=4 --reason="更严重"')
  check('改矛盾成功', tensionEdit.kind === 'success', JSON.stringify(tensionEdit).slice(0, 200))
  const afterTension = await store.readState(projectId)
  const tensionAfter = afterTension.contradictions.find((c) => c.title === '某张力')
  check('强度已落盘', tensionAfter?.intensity === 4, String(tensionAfter?.intensity))
  const tensionAudit = (await store.readAuditLog(projectId)).pop()
  check('矛盾改动记 reclassify_contradiction', tensionAudit?.action === 'reclassify_contradiction', String(tensionAudit?.action))

  console.log('\n--- 新增子目标 ---')
  const addResult = await invoke('metacog-goal', 'add --parent=甲目标 --depth=2 --title=新子目标 --reason="拆细"')
  check('新增成功', addResult.kind === 'success', JSON.stringify(addResult).slice(0, 200))
  const afterAdd = await store.readState(projectId)
  const added = afterAdd.goals.find((g) => g.title === '新子目标')
  check('新节点已落盘', added !== undefined, JSON.stringify(afterAdd.goals.map((g) => g.title)))
  check('新节点深度为 2', added?.depth === 2, String(added?.depth))

  console.log('\n--- 审计链完整 ---')
  const finalAudit = await store.readAuditLog(projectId)
  let chainOk = finalAudit[0]?.prevHash === 'GENESIS'
  for (let i = 1; i < finalAudit.length; i += 1) {
    if (finalAudit[i].prevHash !== finalAudit[i - 1].entryHash) chainOk = false
  }
  check('命令写入的审计也串进同一条链', chainOk, JSON.stringify(finalAudit.map((e) => e.action)))

  const raw = await readFile(join(root, '.metacog', 'state', `${projectId}.json`), 'utf8')
  check('状态文件可解析', JSON.parse(raw).version > 0, raw.slice(0, 60))
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
