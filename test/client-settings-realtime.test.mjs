/**
 * Settings card: realtime controls, model picker, criteria staging, verdicts.
 *
 * The card is plain JavaScript with no build step, so this test runs it under
 * the host loader contract (a stub `react`) and then inspects both the rendered
 * tree and the source-level wiring. The pure `__ui` helpers are exercised
 * directly so the neutral wording and the missing-item counts are checked as
 * values, not as strings that happen to appear somewhere.
 *
 * Run: node test/client-settings-realtime.test.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

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

const reactStub = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  },
  useEffect() {},
  useRef(initial) {
    return { current: initial ?? null }
  },
  useCallback(fn) {
    return fn
  },
  useMemo(fn) {
    return fn()
  },
}

const registrations = []
let loaded
const loader = {
  load({ factory }) {
    loaded = factory((name) => {
      if (name === 'react') return reactStub
      throw new Error(`unexpected require: ${name}`)
    })
    loaded.apply({
      slots: {
        inject(_slot, fn) {
          fn()
          return () => {}
        },
        register(definition, component) {
          registrations.push({ definition, component })
          return () => {}
        },
      },
    })
  },
}

globalThis.window = { __ModuleLoader__: loader }
await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`)

const card = registrations.find((entry) => entry.definition.name === 'settings.section')
check('the settings section is registered', card !== undefined)

// --------------------------------------------------------------- pure helpers
console.log('\n[models] provider → model choices keep ids and display names')
{
  const providers = [
    { provider: 'p1', displayName: '提供方一', models: [{ id: 'm1', displayName: '模型一' }, { id: 'm2' }] },
  ]
  const choices = loaded.__ui.modelChoices(providers, 'p1')
  check('the follow-global option is first', choices[0].value === '' && choices[0].label === '跟随全局', JSON.stringify(choices))
  check('the display name and id are both shown', choices.some((item) => item.label === '模型一（m1）'), JSON.stringify(choices))
  check('a model without a display name shows its id', choices.some((item) => item.value === 'm2' && item.label === 'm2'), JSON.stringify(choices))
  check('no provider means only follow-global', loaded.__ui.modelChoices(providers, '').length === 1, JSON.stringify(loaded.__ui.modelChoices(providers, '')))
  const payload = loaded.__ui.realtimeSettingsPayload('p1', 'm1')
  check('the model choice writes provider first', payload[0].path === 'realtime.provider' && payload[0].value === 'p1', JSON.stringify(payload))
  check('and model second', payload[1].path === 'realtime.model' && payload[1].value === 'm1', JSON.stringify(payload))
  const follow = loaded.__ui.realtimeSettingsPayload('', '')
  check('follow-global writes empty values', follow[0].value === '' && follow[1].value === '', JSON.stringify(follow))
}

console.log('\n[verdicts] null match and missed expectation are worded neutrally')
{
  check('null match is not zero', loaded.__ui.verdictMatchLabel(null) === '目标模糊，无法可靠判断', loaded.__ui.verdictMatchLabel(null))
  check('a number becomes a percentage', loaded.__ui.verdictMatchLabel(0.82) === '匹配 82%', loaded.__ui.verdictMatchLabel(0.82))
  check('missed expectation says so plainly', loaded.__ui.verdictFulfilledLabel(false) === '上期预期未兑现', loaded.__ui.verdictFulfilledLabel(false))
  check('met expectation says so plainly', loaded.__ui.verdictFulfilledLabel(true) === '上期预期已兑现', loaded.__ui.verdictFulfilledLabel(true))
  check('no previous expectation is empty', loaded.__ui.verdictFulfilledLabel(null) === '', loaded.__ui.verdictFulfilledLabel(null))
}

console.log('\n[status] missing criteria/paths/deadline are counted')
{
  const summary = loaded.__ui.statusSummary(
    [
      { id: 'a', paths: [], deadline: '' },
      { id: 'b', paths: ['src'], deadline: '2026-11-07T00:00:00.000Z' },
    ],
    { missing: 1 },
    true,
  )
  check('paths missing count', summary.missingPaths === 1, JSON.stringify(summary))
  check('deadline missing count', summary.missingDeadline === 1, JSON.stringify(summary))
  check('criteria gap count', summary.missingCriteria === 1, JSON.stringify(summary))
  check('realtime flag is kept', summary.realtimeEnabled === true, JSON.stringify(summary))
}

// ------------------------------------------------------------------- render
console.log('\n[render] the component renders and the new panels are in it')
{
  let rendered
  let error
  try {
    rendered = card.component({})
  } catch (caught) {
    error = caught
  }
  check('the card renders', error === undefined, error && String(error))
  // The first render has no project yet, so the config/status tabs are not
  // mounted. The panel labels are checked in the source that builds them; the
  // behavioural parts (model choices, verdict wording, counts) are checked
  // through `__ui` above.
  for (const needle of ['实时监控', '启用实时监控', '模型提供方', '模型列表为空', '手填 provider', '实时判定']) {
    check('defines ' + needle, source.includes(needle), needle)
  }
}

// ------------------------------------------------------------------- wiring
console.log('\n[wire] the controls talk to the new endpoints')
{
  for (const [label, needle] of [
    ['models endpoint', '/api/metacog/models'],
    ['verdicts endpoint', '/api/metacog/verdicts'],
    ['criteria endpoint', '/api/metacog/criteria'],
    ['settings write', "path: 'realtime.provider'"],
    ['paths warning', '未绑定目录，活动无法按路径归属'],
    ['criteria red warning', '没有可匹配判据：这个目标永远判不出 aligned'],
    ['criteria confirmation', '确认写入勾选的判据'],
    ['no-auto-write note', '不点确认不会发出写请求'],
  ]) {
    check(label + ' is wired', source.includes(needle), needle)
  }

  const draft = source.slice(source.indexOf('const draftCriteria = useCallback'), source.indexOf('const confirmCriteria = useCallback'))
  check('asking for suggestions does not write the tree', !draft.includes('/api/metacog/tree/edit'), 'draftCriteria contains a tree edit')
  const confirm = source.slice(source.indexOf('const confirmCriteria = useCallback'), source.indexOf('const valueOf = useCallback'))
  check('confirming does write through the governed route', confirm.includes('/api/metacog/tree/edit'), 'confirmCriteria has no tree edit')
  check('confirming uses a reason', confirm.includes('用户确认采纳判据建议'), 'missing reason')
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
