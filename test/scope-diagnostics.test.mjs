/**
 * Scope diagnostics tests: the tool whitelist must never disappear silently.
 *
 * Three regressions are pinned here, all found by `docs/diagnose-tool-whitelist.md`:
 *
 * 1. The rebuild branch of `/metacog-init` called `runInitialisation` without
 *    `knownTools`, so the whitelist was intersected with an empty set and every
 *    tool — including `ask_user_question` — was dropped. The two branches must
 *    stay identical.
 * 2. An empty allow set skipped `tools.restrict` and reported a single vague
 *    problem, with the dropped names nowhere. It must name them.
 * 3. `ScopeApplication.skipped` had no consumer. The session setup callback now
 *    logs it, so "this deployment never registered that tool" is visible.
 *
 * The protocol's own fallback is pinned too: when `ask_user_question` is not in
 * the toolset, the model must ask in prose and keep working instead of stopping.
 *
 * Run: node test/scope-diagnostics.test.mjs
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const protocolUrl = pathToFileURL(join(here, '..', 'lib', 'protocol.js')).href
const sessionUrl = pathToFileURL(join(here, '..', 'lib', 'session.js')).href
const storeUrl = pathToFileURL(join(here, '..', 'lib', 'data', 'store.js')).href
const indexSourcePath = join(here, '..', 'src', 'index.ts')

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

const {
  METACOG_PROTOCOL,
  METACOG_SESSION_TOOLS,
  applyMetacogScope,
} = await import(protocolUrl)
const { ensureMetacogSession } = await import(sessionUrl)
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

/**
 * Extract every `runInitialisation({...})` call site from a source text.
 *
 * Brace matching is enough for this file: the call bodies contain no braces
 * inside string literals, and `...{ model }` is balanced.
 */
function initialisationCallSites(source) {
  const needle = 'runInitialisation({'
  const sites = []
  let from = 0
  for (;;) {
    const start = source.indexOf(needle, from)
    if (start === -1) break
    let depth = 0
    let end = -1
    for (let i = start + needle.length - 1; i < source.length; i += 1) {
      const char = source[i]
      if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) {
      sites.push(source.slice(start))
      break
    }
    sites.push(source.slice(start, end + 1))
    from = end + 1
  }
  return sites
}

console.log('\n=== D1: 两个 runInitialisation 分支都传 knownTools ===')
{
  const source = await readFile(indexSourcePath, 'utf8')
  const sites = initialisationCallSites(source)
  check('恰好两个 runInitialisation 调用点', sites.length === 2, `got ${sites.length}`)
  for (const [index, site] of sites.entries()) {
    check(
      `调用点 #${index + 1} 传了 knownTools: knownToolNames`,
      site.includes('knownTools: knownToolNames'),
      site.replace(/\s+/g, ' ').slice(0, 160),
    )
  }
  check(
    'knownToolNames 在调用点之前已定义（同一闭包内可用）',
    source.indexOf('const knownToolNames = new Set<string>(registeredTools)') !== -1 &&
      source.indexOf('const knownToolNames = new Set<string>(registeredTools)') <
        source.indexOf('runInitialisation({'),
  )
}

console.log('\n=== D2: 空 allow 集合必须显式告警，并给出完整 skipped 名单 ===')
{
  const captured = { sections: [], restrictions: [] }
  // The deployment registers tools, but none of the metacog whitelist: this is
  // the shape of the bug — `restrict` silently skipped, session left unusable.
  const known = new Set(['some_other_tool'])
  const applied = applyMetacogScope(recordingScope(captured), known)

  check('allowed 为空', applied.allowed.length === 0, JSON.stringify(applied.allowed))
  check('problems 非空', applied.problems.length > 0, applied.problems.join('; '))
  check('restricted 为 false', applied.restricted === false)
  check('没有偷偷下发空 restrict', captured.restrictions.length === 0)
  check(
    'skipped 是全量白名单（15 个）',
    JSON.stringify(applied.skipped) === JSON.stringify([...METACOG_SESSION_TOOLS]),
    JSON.stringify(applied.skipped),
  )
  const problem = applied.problems.join('; ')
  check('problem 里写明 allowed: none', problem.includes('allowed: none'), problem)
  check('problem 里列出 skipped 全量名单', problem.includes('skipped: '), problem)
  for (const name of METACOG_SESSION_TOOLS) {
    check(`problem 含被丢弃的工具 ${name}`, problem.includes(name), problem)
  }
  check('problem 明确说白名单未应用', problem.includes('whitelist was not applied'), problem)
}

console.log('\n=== D3: 非空集合按白名单正确过滤 ===')
{
  const captured = { sections: [], restrictions: [] }
  const known = new Set(['metacog_scan', 'goal_tree_init', 'ask_user_question', 'read', 'pwsh'])
  const applied = applyMetacogScope(recordingScope(captured), known)

  const expectedAllowed = METACOG_SESSION_TOOLS.filter((name) => known.has(name))
  const expectedSkipped = METACOG_SESSION_TOOLS.filter((name) => !known.has(name))
  check(
    'allowed 只含已知工具，且保持协议顺序',
    JSON.stringify(applied.allowed) === JSON.stringify(expectedAllowed),
    JSON.stringify(applied.allowed),
  )
  check(
    'skipped 是白名单的补集',
    JSON.stringify(applied.skipped) === JSON.stringify(expectedSkipped),
    JSON.stringify(applied.skipped),
  )
  check('restricted 为 true', applied.restricted === true)
  check('restrict 被调用一次', captured.restrictions.length === 1)
  check(
    '下发的 allow 等于 applied.allowed',
    JSON.stringify(captured.restrictions[0]?.allow) === JSON.stringify(expectedAllowed),
    JSON.stringify(captured.restrictions[0]?.allow),
  )
  check('正常路径无告警', applied.problems.length === 0, applied.problems.join('; '))
  check('ask_user_question 被保留', applied.allowed.includes('ask_user_question'))
}

console.log('\n=== D4: 协议兜底——工具不可用时不把模型逼进死角 ===')
{
  check('协议仍提到 ask_user_question', METACOG_PROTOCOL.includes('ask_user_question'))
  check('协议仍要求优先用工具', METACOG_PROTOCOL.includes('优先用工具'))
  check(
    '不再有「必须调用 ask_user_question」的绝对规则',
    !METACOG_PROTOCOL.includes('必须调用 ask_user_question'),
  )
  check(
    '给出正文编号列表的兜底',
    METACOG_PROTOCOL.includes('编号列表'),
    METACOG_PROTOCOL.slice(METACOG_PROTOCOL.indexOf('若 ask_user_question'), 200),
  )
  check('要求明确说「请直接回复编号+答案」', METACOG_PROTOCOL.includes('请直接回复编号+答案'))
  check(
    '要求工具不可用时也不能跳过提问直接确认',
    METACOG_PROTOCOL.includes('可以继续扫描材料，但在用户回答之前不要推导、不要确认、不要落库') &&
      METACOG_PROTOCOL.includes('不允许因为工具不可用就跳过提问直接确认'),
  )
}

console.log('\n=== D5: 会话创建时 setup 把 applied.skipped 打进日志 ===')
{
  const root = await mkdtemp(join(tmpdir(), 'metacog-scope-diag-'))
  try {
    const captured = { infos: [], warns: [], sections: [], restrictions: [], setup: undefined }
    const ctx = {
      get(name) {
        if (name === 'agents') {
          return {
            async create(options) {
              captured.setup = options.setup
              if (typeof options.setup === 'function') {
                options.setup(recordingScope(captured), { id: options.sessionId })
              }
              return { agent: { id: options.sessionId }, dispose: async () => {} }
            },
            get: () => undefined,
          }
        }
        if (name === 'sessions') return { get: () => undefined }
        return undefined
      },
      logger: {
        debug() {},
        info: (...args) => captured.infos.push(args.join(' ')),
        warn: (...args) => captured.warns.push(args.join(' ')),
      },
      on: () => () => {},
      effect: () => {},
      tools: { register: () => () => {} },
    }

    const store = new MetacogStore(root, '.metacog')
    // This deployment lacks ask_user_question: exactly the situation the
    // fallback protocol and the diagnostic line exist for.
    const knownTools = new Set(
      METACOG_SESSION_TOOLS.filter((name) => name !== 'ask_user_question'),
    )
    const resolution = await ensureMetacogSession(
      {
        ctx,
        config: { storageSubdir: '.metacog' },
        store,
        projectId: 'proj-scope-diag',
        projectRoot: root,
        knownTools,
      },
      false,
      { provider: 'test-provider', model: 'test-model' },
    )

    check('会话创建成功', resolution.status === 'created', JSON.stringify(resolution))
    check('setup 被传入', typeof captured.setup === 'function')
    check('白名单已下发', captured.restrictions.length === 1)
    check('ask_user_question 未下发', !captured.restrictions[0]?.allow.includes('ask_user_question'))

    check('setup 打了一条 info 诊断日志', captured.infos.length === 1, captured.infos.join(' | '))
    const info = captured.infos[0] ?? ''
    check('日志含 section 状态', info.includes('section=true'), info)
    check('日志含 restricted 状态', info.includes('restricted=true'), info)
    check('日志含 allowed 名单', info.includes('allowed=['), info)
    check('日志含 skipped 名单', info.includes('skipped=['), info)
    check('日志里能看到 ask_user_question 被跳过', info.includes('ask_user_question'), info)
    check('正常路径没有 scope 告警', captured.warns.length === 0, captured.warns.join('; '))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log(`\n=== Scope diagnostics 结果: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exitCode = 1
