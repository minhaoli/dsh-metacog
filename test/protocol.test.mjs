/**
 * Protocol tests: the metacog session's standing instructions and toolset.
 *
 * These verify the second-generation entry path — guidance carried by a scoped
 * system-prompt section, tools narrowed to a whitelist, and a one-line kickoff
 * instead of a long opening message — including the failure modes that must not
 * take a session down (a host without `systemPrompt`, a whitelisted tool this
 * build never registered).
 *
 * Run: node test/protocol.test.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libUrl = pathToFileURL(join(here, '..', 'lib', 'index.js')).href
const protocolUrl = pathToFileURL(join(here, '..', 'lib', 'protocol.js')).href
const sessionUrl = pathToFileURL(join(here, '..', 'lib', 'session.js')).href
const storeUrl = pathToFileURL(join(here, '..', 'lib', 'data', 'store.js')).href

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

// `apply` must load, otherwise the plugin would not mount at all.
await import(libUrl)

const {
  METACOG_PROTOCOL,
  METACOG_PROTOCOL_SECTION,
  METACOG_PROTOCOL_ORDER,
  METACOG_SESSION_TOOLS,
  applyMetacogScope,
} = await import(protocolUrl)
const { buildInitKickoff, ensureMetacogSession } = await import(sessionUrl)
const { MetacogStore } = await import(storeUrl)

/** A scope that records what the plugin registers into it. */
function recordingScope(captured, options = {}) {
  return {
    get(name) {
      if (name === 'systemPrompt' && options.withPrompt !== false) {
        return {
          section(section) {
            captured.sections.push(section)
            return () => {}
          },
        }
      }
      if (name === 'tools' && options.withTools !== false) {
        return {
          restrict(filter) {
            captured.restrictions.push(filter)
            return () => {}
          },
        }
      }
      return undefined
    },
  }
}

console.log('\n=== P1: applyMetacogScope 正常路径 ===')
{
  const captured = { sections: [], restrictions: [] }
  const known = new Set(METACOG_SESSION_TOOLS)
  const applied = applyMetacogScope(recordingScope(captured), known)

  check('section 已注册', captured.sections.length === 1, `got ${captured.sections.length}`)
  check(
    'section 名字稳定',
    captured.sections[0]?.name === METACOG_PROTOCOL_SECTION,
    String(captured.sections[0]?.name),
  )
  check(
    'section 排序号稳定',
    captured.sections[0]?.order === METACOG_PROTOCOL_ORDER,
    String(captured.sections[0]?.order),
  )
  check(
    'section 正文与常量一致（单一事实来源）',
    captured.sections[0]?.text === METACOG_PROTOCOL,
  )
  check('工具白名单已下发', captured.restrictions.length === 1)
  check(
    '白名单内容等于常量',
    JSON.stringify(captured.restrictions[0]?.allow) === JSON.stringify(METACOG_SESSION_TOOLS),
    JSON.stringify(captured.restrictions[0]?.allow),
  )
  check('结果自述 section=true', applied.section === true)
  check('结果自述 restricted=true', applied.restricted === true)
  check('结果无告警', applied.problems.length === 0, applied.problems.join('; '))
  check('结果无跳过项', applied.skipped.length === 0, applied.skipped.join(','))

  // The whole point of the move: the protocol must actually carry the procedure.
  check('协议含四步推导流程', METACOG_PROTOCOL.includes('goal_tree_init'))
  check('协议含落库工具', METACOG_PROTOCOL.includes('goal_tree_confirm'))
  check('协议含弹窗提问工具', METACOG_PROTOCOL.includes('ask_user_question'))
  check('协议要求先对齐再推导', METACOG_PROTOCOL.includes('先对齐，再推导') && METACOG_PROTOCOL.indexOf('先问用户') < METACOG_PROTOCOL.indexOf('按回答推导'))
  check('协议写明树冻结规则', METACOG_PROTOCOL.includes('推导一次、经用户确认后固定'))
  check('协议写明重建双参数', METACOG_PROTOCOL.includes('expectedVersion'))
  check('协议禁止用 read 探目录', METACOG_PROTOCOL.includes('不要用 read 去探目录'))
}

console.log('\n=== P2: 未注册的工具降级为跳过，而不是炸掉会话 ===')
{
  const captured = { sections: [], restrictions: [] }
  // A build that only ships the core tools: no read, no glob, no grep.
  const known = new Set([
    'metacog_scan',
    'goal_tree_init',
    'goal_tree_confirm',
    'goal_tree_view',
    'goal_tree_edit',
    'contradiction_tree_edit',
    'metacog_revise',
    'ask_user_question',
  ])
  const applied = applyMetacogScope(recordingScope(captured), known)

  check('仍然下发白名单', captured.restrictions.length === 1)
  check(
    '白名单只含已知工具',
    captured.restrictions[0]?.allow.every((name) => known.has(name)),
    JSON.stringify(captured.restrictions[0]?.allow),
  )
  check(
    'host 工具、shell 与文档读取器被跳过（本用例的 known 集合里没有）',
    JSON.stringify(applied.skipped) ===
      JSON.stringify([
        'metacog_read_document',
        'metacog_ask_user',
        'read',
        'glob',
        'grep',
        'pwsh',
        'load_workspace_dependencies',
        'skill',
      ]),
    JSON.stringify(applied.skipped),
  )
  check('跳过不产生告警', applied.problems.length === 0, applied.problems.join('; '))
  check('restricted 仍为 true', applied.restricted === true)
}

console.log('\n=== P3: 宿主缺能力时只告警，不抛异常 ===')
{
  const captured = { sections: [], restrictions: [] }
  const applied = applyMetacogScope(
    recordingScope(captured, { withPrompt: false }),
    new Set(METACOG_SESSION_TOOLS),
  )
  check('缺 systemPrompt 时 section=false', applied.section === false)
  check('缺 systemPrompt 时给出原因', applied.problems.length === 1, applied.problems.join('; '))
  check('缺 systemPrompt 不影响工具限制', applied.restricted === true)
}
{
  const captured = { sections: [], restrictions: [] }
  const applied = applyMetacogScope(recordingScope(captured, { withTools: false }), new Set())
  check('缺 tools 时 restricted=false', applied.restricted === false)
  check('缺 tools 时仍挂上 section', applied.section === true)
  check('空 known 集合会跳过全部白名单', applied.allowed.length === 0)
}
{
  // A registry that rejects the filter must not escape as a throw.
  const scope = {
    get(name) {
      if (name === 'systemPrompt') return { section: () => () => {} }
      if (name === 'tools') {
        return {
          restrict() {
            throw new Error('restriction refused')
          },
        }
      }
      return undefined
    },
  }
  const applied = applyMetacogScope(scope, new Set(['metacog_scan']))
  check('restrict 抛错被收敛', applied.restricted === false)
  check('restrict 抛错进入 problems', applied.problems.some((p) => p.includes('restriction refused')))
}

console.log('\n=== P4: 唤醒消息必须短，且只带 section 拿不到的事实 ===')
{
  const first = buildInitKickoff('朋友系统设计', false)
  check('首建消息含工作区名', first.includes('朋友系统设计'), first)
  check('首建消息声明无树', first.includes('还没有目标树'), first)
  check('消息足够短（<120 字）', first.length < 120, `${first.length} 字`)
  check('不再内联步骤清单', !first.includes('1. 先调用'))
  check('不再内联提问清单', !first.includes('你是什么角色') && !first.includes('你在项目里是什么角色'))

  const rebuild = buildInitKickoff('朋友系统设计', true, 3)
  check('重建消息点明是重建', rebuild.includes('重建'), rebuild)
  check('重建消息带版本号', rebuild.includes('version 3'), rebuild)
  check('重建消息仍然很短', rebuild.length < 120, `${rebuild.length} 字`)

  const unknownVersion = buildInitKickoff('朋友系统设计', true)
  check(
    '重建但版本未知时要求先读树',
    unknownVersion.includes('goal_tree_view'),
    unknownVersion,
  )
}

console.log('\n=== P5: 会话创建时把作用域装进 setup ===')
{
  const root = await mkdtemp(join(tmpdir(), 'metacog-protocol-'))
  try {
    const captured = { sections: [], restrictions: [], options: undefined, warns: [] }
    const ctx = {
      get(name) {
        if (name === 'agents') {
          return {
            async create(options) {
              captured.options = options
              if (typeof options.setup === 'function') {
                options.setup(recordingScope(captured), { id: options.sessionId })
              }
              return { agent: { id: options.sessionId }, dispose: async () => {} }
            },
            get: () => undefined,
          }
        }
        if (name === 'sessions') return { get: () => undefined }
        if (name === 'workingDirectory') return { get: () => root, defaultDirectory: root }
        return undefined
      },
      logger: {
        debug() {},
        info() {},
        warn: (...args) => captured.warns.push(args.join(' ')),
      },
      on: () => () => {},
      effect: () => {},
      tools: { register: () => () => {} },
    }

    const store = new MetacogStore(root, '.metacog')
    const resolution = await ensureMetacogSession(
      {
        ctx,
        config: { storageSubdir: '.metacog' },
        store,
        projectId: 'proj-test',
        projectRoot: root,
        knownTools: new Set(METACOG_SESSION_TOOLS),
      },
      false,
      { provider: 'test-provider', model: 'test-model' },
    )

    check('会话创建成功', resolution.status === 'created', JSON.stringify(resolution))
    check('setup 被传入', typeof captured.options?.setup === 'function')
    check('cwd 指向项目根', captured.options?.meta?.cwd === root, String(captured.options?.meta?.cwd))
    check(
      '模型被传给新 agent',
      captured.options?.agentOptions?.model === 'test-model',
      JSON.stringify(captured.options?.agentOptions),
    )
    check('setup 执行后挂上 section', captured.sections.length === 1)
    check('setup 执行后下发白名单', captured.restrictions.length === 1)
    check('无作用域告警', captured.warns.length === 0, captured.warns.join('; '))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log(`\n=== Protocol 结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
