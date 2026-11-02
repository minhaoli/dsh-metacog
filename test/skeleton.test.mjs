/**
 * Skeleton verification: the skeleton must load, validate its configuration,
 * expose every documented tunable, and release everything it owns on teardown.
 *
 * Drive the compiled `lib/` through a mock host context that records every
 * registration, mirroring the event payload shapes shipped plugins receive.
 * No dsh process and no restart are needed.
 *
 * Run: node test/skeleton.test.mjs
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libUrl = pathToFileURL(join(here, '..', 'lib', 'index.js')).href

let passed = 0
let failed = 0

/** Assert a condition, recording the outcome instead of throwing. */
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
    return
  }
  failed += 1
  console.log(`  FAIL  ${label}${detail === undefined ? '' : ` -- ${detail}`}`)
}

/** Assert deep equality on JSON-serializable values. */
function checkEqual(label, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  check(label, a === b, `expected ${b}, got ${a}`)
}

/**
 * Build a mock host context that records registrations and honours teardown.
 *
 * @param options.capabilities - which optional services to include.
 * @param options.config - the loader `config` value to hand to `apply`.
 */
function createMockHost(options = {}) {
  // `tools` and `webServer` are hard inject dependencies, so a loadable host
  // always has both; the optional capabilities below are the ones a host may
  // legitimately lack.
  const { capabilities = ['tools', 'webServer', 'systemPrompt', 'timer', 'fs', 'workingDirectory'], config } = options

  const effects = []
  const logs = []
  let timerDisposers = 0
  let timerStarted = 0

  const ctx = {
  get(name) {
    if (name === 'workingDirectory') return this.workingDirectory
    if (name === 'timer') return this.timer
    if (name === 'systemPrompt') return this.systemPrompt
    if (name === 'tools') return this.tools
    if (name === 'fs') return this.fs
    if (name === 'webServer') return this.webServer
    return undefined
  },
    logger: {
      debug: (...args) => logs.push(['debug', ...args]),
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
    },
    on(name, listener) {
      return () => {}
    },
    effect(setup) {
      effects.push(setup)
    },
  }

  if (capabilities.includes('tools')) {
    ctx.tools = {
      register() {
        return () => {}
      },
    }
  }
  if (capabilities.includes('webServer')) {
    // The settings card's route registry; the plugin registers one prefix route
    // at mount, so the stub has to accept a route and hand back a disposer.
    ctx.webServer = {
      register() {
        return () => {}
      },
      getOrigin() {
        return 'http://127.0.0.1:3080'
      },
    }
  }
  if (capabilities.includes('systemPrompt')) {
    ctx.systemPrompt = {
      section: () => () => {},
      context: () => () => {},
    }
  }
  if (capabilities.includes('timer')) {
    ctx.timer = {
      interval(callback, delay) {
        timerStarted += 1
        return () => {
          timerDisposers += 1
        }
      },
    }
  }
  if (capabilities.includes('fs')) ctx.fs = {}
  if (capabilities.includes('workingDirectory')) {
    ctx.workingDirectory = { get: () => undefined, defaultDirectory: '/x' }
  }

  return {
    ctx,
    config,
    logs,
    effects,
    get timerStarted() {
      return timerStarted
    },
    get timerDisposers() {
      return timerDisposers
    },
    /** Run every registered effect setup, collecting the disposers. */
    async runEffects() {
      const disposers = []
      for (const setup of effects) disposers.push(await setup())
      return disposers
    },
  }
}

console.log('=== Skeleton: 环境核验与最小可加载插件骨架 ===')

const mod = await import(libUrl)
const { apply, name, inject } = mod

console.log('\n-- A1: 模块形态与宿主契约一致 --')
check('导出 name', typeof name === 'string' && name.length > 0, String(name))
check('name 与 package.json 一致', name === 'dsh-metacog', name)
check(
  '导出 inject 数组且包含硬依赖 tools',
  Array.isArray(inject) && inject.includes('tools'),
  JSON.stringify(inject),
)
check('导出 apply 函数', typeof apply === 'function')

console.log('\n-- A2: 配置 Schema 暴露全部规格参数 --')
{
  const host = createMockHost()
  apply(host.ctx, {})
  const { getMount } = await import(libUrl)
  const mount = getMount(host.ctx)
  check('mount 已发布', mount !== undefined)
  const t = mount?.config?.thresholds
  check('windowMinutes 有默认值', t?.windowMinutes === 120, String(t?.windowMinutes))
  check('repeatThreshold 有默认值', t?.repeatThreshold === 3, String(t?.repeatThreshold))
  check('minConfidence 有默认值', t?.minConfidence === 0.6, String(t?.minConfidence))
  check(
    'highIntensityThreshold 有默认值',
    t?.highIntensityThreshold === 4,
    String(t?.highIntensityThreshold),
  )
  check('staleDaysThreshold 有默认值', t?.staleDaysThreshold === 7, String(t?.staleDaysThreshold))
  check(
    'whitelistedActivities 默认为空数组',
    Array.isArray(mount?.config?.whitelistedActivities) &&
      mount.config.whitelistedActivities.length === 0,
  )
  check('schedule.checkIntervalMinutes 默认 25', mount?.config?.schedule?.checkIntervalMinutes === 25)
  check('schedule.enabled 默认 true', mount?.config?.schedule?.enabled === true)
  check(
    'observationPolicy.gradeBMaxConfidence 有默认值',
    mount?.config?.observationPolicy?.gradeBMaxConfidence === 0.5,
  )
  check('storageSubdir 默认 .metacog', mount?.config?.storageSubdir === '.metacog')
  await host.runEffects()
}

console.log('\n-- A3: 配置覆盖与非法值拒绝 --')
{
  const host = createMockHost()
  apply(host.ctx, {
    thresholds: { windowMinutes: 30, repeatThreshold: 5, minConfidence: 0.8 },
    whitelistedActivities: [{ label: '文献阅读', summaryContains: ['读论文'], toolNames: ['web_search'] }],
    schedule: { enabled: false, checkIntervalMinutes: 10 },
  })
  const { getMount } = await import(libUrl)
  const cfg = getMount(host.ctx)?.config
  check('windowMinutes 覆盖生效', cfg?.thresholds?.windowMinutes === 30)
  check('repeatThreshold 覆盖生效', cfg?.thresholds?.repeatThreshold === 5)
  check('minConfidence 覆盖生效', cfg?.thresholds?.minConfidence === 0.8)
  check('未覆盖项保留默认', cfg?.thresholds?.highIntensityThreshold === 4)
  check('白名单条目已登记', cfg?.whitelistedActivities?.length === 1)
  check('白名单 label 正确', cfg?.whitelistedActivities?.[0]?.label === '文献阅读')
  check('schedule.enabled 覆盖生效', cfg?.schedule?.enabled === false)
  await host.runEffects()
}
{
  const host = createMockHost()
  let threw = false
  let message = ''
  try {
    apply(host.ctx, { thresholds: { minConfidence: 1.5 } })
  } catch (error) {
    threw = true
    message = String(error?.message ?? error)
  }
  check('minConfidence 越界被拒绝', threw, message)
}
{
  const host = createMockHost()
  let threw = false
  try {
    apply(host.ctx, { thresholds: { repeatThreshold: 0 } })
  } catch {
    threw = true
  }
  check('repeatThreshold=0 被拒绝', threw)
}

console.log('\n-- A4: enabled=false 时不注册任何东西 --')
{
  const host = createMockHost()
  apply(host.ctx, { enabled: false })
  const { getMount } = await import(libUrl)
  check('未发布 mount', getMount(host.ctx) === undefined)
  check('未注册 effect', host.effects.length === 0, String(host.effects.length))
}

console.log('\n-- A5: 缺失可选能力时如实记录边界 --')
{
  const host = createMockHost({ capabilities: ['tools'] })
  apply(host.ctx, {})
  const { getMount } = await import(libUrl)
  const caps = getMount(host.ctx)?.capabilities
  check('timer 报告为不可用', caps?.timer === false)
  check('systemPrompt 报告为不可用', caps?.systemPrompt === false)
  check('fs 报告为不可用', caps?.fs === false)
  const gaps = host.logs.filter(
    (entry) => entry[0] === 'info' && String(entry[1]).includes('does not expose'),
  )
  // One line per optional capability the host declined. The count follows the
  // probe list, so assert coverage of that list instead of a fixed number.
  const expected = ['systemPrompt', 'timer', 'fs', 'workingDirectory', 'subagents', 'agents']
  const missing = expected.filter(
    (name) => !gaps.some((entry) => String(entry[1]).includes(`"${name}"`)),
  )
  check(
    '为每个缺口记录一条日志',
    missing.length === 0,
    `unreported: ${missing.join(', ') || '(none)'} (got ${gaps.length} lines)`,
  )
  await host.runEffects()
}

console.log('\n-- A6: 卸载清理全部资源且幂等 --')
{
  const host = createMockHost()
  apply(host.ctx, {})
  const { getMount } = await import(libUrl)
  const mount = getMount(host.ctx)
  check('mount 存在', mount !== undefined)

  let released = 0
  mount.claim(() => released++)
  mount.claim(() => released++)
  check('claim 后未立即释放', released === 0)

  const disposers = await host.runEffects()
  check('注册了一个 effect', disposers.length === 1)
  await disposers[0]()
  check('卸载时释放全部 claim 的 disposer', released === 2, String(released))
  check('卸载后 mount 被移除', getMount(host.ctx) === undefined)

  let late = 0
  mount.claim(() => late++)
  check('卸载后 claim 立即执行', late === 1, String(late))

  await disposers[0]()
  check('重复卸载不重复释放', released === 2, String(released))
}

console.log('\n-- A7: 单个 disposer 抛错不影响其余释放 --')
{
  const host = createMockHost()
  apply(host.ctx, {})
  const { getMount } = await import(libUrl)
  const mount = getMount(host.ctx)
  let reached = 0
  mount.claim(() => {
    throw new Error('boom')
  })
  mount.claim(() => reached++)
  const disposers = await host.runEffects()
  await disposers[0]()
  check('后续 disposer 仍被调用', reached === 1, String(reached))
  const warned = host.logs.filter((entry) => entry[0] === 'warn')
  check('抛错被记录为警告', warned.length === 1, String(warned.length))
}

console.log(`\n=== Skeleton 结果: ${passed} passed, ${failed} failed ===`)
process.exitCode = failed === 0 ? 0 : 1
