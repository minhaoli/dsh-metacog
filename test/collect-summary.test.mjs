/**
 * Collector acceptance: what counts as activity, and what the summary says.
 *
 * The first live run judged every `read (tool call)` as drift, because a summary
 * naming no object can match no goal. These cases lock the two fixes: read-only
 * tools are not activity at all, and a write names the file it changed.
 *
 * Run: node test/collect-summary.test.mjs
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const url = pathToFileURL(join(here, '..', 'lib', 'collect.js')).href

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

const { collectToolCall, describeToolCall, collectTurnReport, collectUserMessage, isInjectedBlock } =
  await import(url)

const call = (name, args) =>
  collectToolCall('session-test', {
    callId: `c-${name}-${Math.random().toString(16).slice(2)}`,
    name,
    arguments: JSON.stringify(args),
  })

console.log('\n=== C1: 只读工具不再产生活动 ===')
for (const name of ['read', 'glob', 'grep', 'list_dir', 'metacog_read_document', 'todo_write']) {
  check(`${name} 被忽略`, call(name, { file_path: 'a.ts' }) === undefined)
}

console.log('\n=== C2: 写文件的操作给出文件级摘要 ===')
{
  const edit = call('edit', { file_path: 'src/index.ts', old_string: 'a', new_string: 'b' })
  check('edit 产生活动', edit !== undefined)
  check('摘要点名文件', edit?.summary === '修改 src/index.ts', edit?.summary)
  check('仍然算 A 级证据', edit?.grade === 'A', edit?.grade)

  const write = call('write', { file_path: 'docs/新文档.md', content: '...' })
  check('write 同样点名文件', write?.summary === '修改 docs/新文档.md', write?.summary)

  const many = describeToolCall('edit', {
    files: ['a.ts', 'b.ts', 'c.ts'],
  })
  check('多文件给出数量与前几个', many === '修改 3 个文件：a.ts、b.ts、c.ts', many)
}

console.log('\n=== C3: 命令摘要取首行 ===')
{
  const shell = call('pwsh', { command: 'node build.mjs\nnpm test' })
  check('只取第一行', shell?.summary === '执行命令：node build.mjs', shell?.summary)

  const long = describeToolCall('pwsh', { command: 'x'.repeat(400) })
  check('过长命令被截断', typeof long === 'string' && long.length <= 130, String(long?.length))
}

console.log('\n=== C4: 无参数时不留空摘要 ===')
{
  const bare = describeToolCall('pwsh', {})
  check('没有命令时仍给出说明', bare === '执行命令', String(bare))
  check('未知工具返回 undefined', describeToolCall('some_unknown_tool', { a: 1 }) === undefined)
  const fallback = call('some_unknown_tool', { a: 1 })
  check('未知工具回落为旧格式', fallback?.summary === 'some_unknown_tool (tool call)', fallback?.summary)
}

console.log('\n=== C5: 自身工具与管理工具不记录 ===')
for (const name of ['goal_tree_edit', 'check_drift', 'ask_user_question', 'session_list']) {
  check(`${name} 被忽略`, call(name, {}) === undefined)
}

console.log('\n=== C6: 用户消息仍然是活动 ===')
{
  const { collectUserMessage } = await import(url)
  const message = collectUserMessage('s', 12, {
    content: [{ type: 'text', text: '把判定的证据链补上，先做日志再做统计。' }],
  })
  check('长消息被记录', message !== undefined)
  check('摘要就是消息文本', String(message?.summary).includes('证据链'), String(message?.summary))
  const short = collectUserMessage('s', 13, { content: [{ type: 'text', text: '继续' }] })
  check('短消息照样记录', short !== undefined)
  check('短消息保留原文', short?.summary === '继续', String(short?.summary))
}

console.log('\n=== C7: 回合级活动 ===')
{
  const turn = collectTurnReport('s', 3, '把判定改成回合级，证据是 src/collect.ts 与测试文件。', [
    'edit: src/collect.ts',
  ])
  check('回合产生活动', turn !== undefined)
  check('摘要就是该回合的汇报', String(turn?.summary).includes('回合级'), turn?.summary)
  check('工具调用成为证据', turn?.evidence.length === 1, JSON.stringify(turn?.evidence))
  check('有证据时是 A 级', turn?.grade === 'A', turn?.grade)
  check('指纹带回合号', turn?.fingerprint === 'turn:s:3', turn?.fingerprint)

  const noEvidence = collectTurnReport('s', 4, '读了一堆文件，但没改任何东西，只是调研了一下现有实现。')
  check('没有产物时降为 B 级', noEvidence?.grade === 'B', noEvidence?.grade)

  const shortTurn = collectTurnReport('s', 5, '好的')
  check('短汇报也记录', shortTurn !== undefined)
  check('短汇报保留原文', shortTurn?.summary === '好的', String(shortTurn?.summary))
  check('完全空的回合才跳过', collectTurnReport('s', 6, '   ') === undefined)
}

console.log('\n=== C8: 宿主注入的块不算用户消息 ===')
{
  const injected = [
    'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
    'Time sampled while preparing turn 75, step 1: 2026-10-28T14:19:02+08:00',
    'MNEMON RUNTIME MEMORY SNAPSHOT\nRevision: abc123',
    '<system-reminder> The following workspace instructions are relevant',
    '（过程纪律提醒）上一步只执行了工具、没有输出正文。',
    '`context_compact` done: checkpoint above; freed ~53000 tokens.',
    'This is an automatically generated checkpoint condensing an earlier span',
    'The working directory changed from "D:\\a" to "D:\\b"',
    '[MNEMON] Use mnemon_view_route only when relevant evidence is missing.',
  ]
  for (const text of injected) {
    const activity = collectUserMessage('s', 1, { content: [{ type: 'text', text }] })
    check(`注入块被忽略：${text.slice(0, 24)}…`, activity === undefined, JSON.stringify(activity?.summary))
  }

  // 真正说的话仍然记录，包括短句与包含关键词但不在开头的情况
  const real = [
    '先修复采集口径，版本归档先不管',
    '继续',
    '我刚才看到一段 Current runtime context. 这样的注入，这算活动吗',
  ]
  for (const text of real) {
    const activity = collectUserMessage('s', 1, { content: [{ type: 'text', text }] })
    check(`用户消息被记录：${text.slice(0, 20)}…`, activity !== undefined)
  }
}

console.log(`\n=== Collector 结果: ${passed} passed, ${failed} failed ===`)
