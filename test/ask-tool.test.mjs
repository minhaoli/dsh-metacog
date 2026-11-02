/**
 * `metacog_ask_user`: the plugin's own question card.
 *
 * The point is availability: the host's `ask_user_question` is not registered
 * in every deployment, so the plugin ships its own tool over the
 * `userQuestions.ask` service. The cases cover the happy path, the request the
 * service receives, the explicit refusal when the service is absent, and the
 * protocol's preference for this tool.
 *
 * Run: node test/ask-tool.test.mjs   (after `npm run build`)
 */
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = (path) => pathToFileURL(join(here, '..', 'lib', path)).href

const { metacogAskUserTool } = await import(lib('tools/ask.js'))
const { METACOG_PROTOCOL, METACOG_SESSION_TOOLS } = await import(lib('protocol.js'))
const { parseConfig } = await import(lib('config.js'))

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

function makeEnv(service) {
  return {
    ctx: {
      get: (name) => (name === 'userQuestions' ? service : undefined),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      on: () => () => {},
      effect: () => {},
    },
    config: parseConfig({}),
    resolveProjectRoot: async () => process.cwd(),
    storeFor: () => {
      throw new Error('not used')
    },
  }
}

const exec = {
  callId: 'ask-call-1',
  name: 'metacog_ask_user',
  arguments: {},
  signal: new AbortController().signal,
  agent: { id: 'agent-ask' },
}

// ------------------------------------------------------------------- happy
console.log('\n[ask] a registered service shows the card and returns answers')
{
  const seen = []
  const service = {
    async ask(request) {
      seen.push(request)
      return {
        answers: [
          { id: 'role', selected: ['项目负责人'], custom: '兼统筹' },
          { id: 'deadline', selected: ['2026-11-07'] },
        ],
      }
    },
  }
  const tool = metacogAskUserTool(makeEnv(service))
  const result = await tool.execute(
    {
      questions: [
        {
          id: 'role',
          header: '角色',
          question: '你在项目里是什么角色？',
          options: [{ label: '项目负责人' }, { label: '执行者', description: '按安排做事' }],
          multiSelect: false,
        },
        {
          id: 'deadline',
          question: '这个 L1 的截止时间？',
          detail: '材料里看到换届 11-07',
          options: [{ label: '2026-11-07' }, { label: '没有截止时间' }],
        },
      ],
    },
    exec,
  )
  check('the tool succeeds', result.ok === true, JSON.stringify(result))
  check('both answers are returned', result.data.answers.length === 2, JSON.stringify(result.data))
  check('the selected option is kept', result.data.answers[0].selected[0] === '项目负责人')
  check('the custom answer is kept', result.data.answers[0].custom === '兼统筹')
  check('the service saw two questions', seen.length === 1 && seen[0].questions.length === 2, JSON.stringify(seen))
  check('the option list is passed through', seen[0].questions[0].options.length === 2, JSON.stringify(seen[0].questions[0]))
  check('the call id is passed for correlation', seen[0].wait?.callId === 'ask-call-1', JSON.stringify(seen[0].wait))
  check('the agent is passed', seen[0].agent?.id === 'agent-ask', JSON.stringify(seen[0].agent))
}

// --------------------------------------------------------------- absent
console.log('\n[ask] a missing service is a named refusal, not an exception')
{
  const tool = metacogAskUserTool(makeEnv(undefined))
  const result = await tool.execute(
    { questions: [{ id: 'q', question: '还有问题吗？' }] },
    exec,
  )
  check('the call fails', result.ok === false, JSON.stringify(result))
  check('with a named reason', result.error.code === 'USER_QUESTIONS_UNAVAILABLE', JSON.stringify(result.error))
  check('and tells the model what to do', /numbered list|正文/.test(result.error.message), result.error.message)
}

// --------------------------------------------------------------- protocol
console.log('\n[protocol] the plugin tool is registered and preferred')
{
  check('the whitelist includes the plugin tool', METACOG_SESSION_TOOLS.includes('metacog_ask_user'), METACOG_SESSION_TOOLS.join(','))
  check('the protocol names it first', METACOG_PROTOCOL.indexOf('metacog_ask_user') >= 0 && METACOG_PROTOCOL.indexOf('metacog_ask_user') < METACOG_PROTOCOL.indexOf('ask_user_question'), METACOG_PROTOCOL.slice(0, 300))
  check('the protocol says it is built in', /插件自带/.test(METACOG_PROTOCOL), METACOG_PROTOCOL.slice(0, 400))
}

console.log(`\npassed ${passed}, failed ${failed}`)
process.exit(failed === 0 ? 0 : 1)
