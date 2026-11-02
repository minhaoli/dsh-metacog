/**
 * `metacog_ask_user`: the plugin's own question tool.
 *
 * The host's `ask_user_question` is not registered in every deployment (a
 * known workspace-level gap), which left the metacog session writing questions
 * into prose the user had to read and answer by hand. The plugin can do better:
 * `ctx.get('userQuestions').ask()` is the same card service `/metacog-init`
 * already uses, so this tool exposes it to the model and does not depend on
 * whether the host registered its own question tool.
 *
 * The service is optional. When it is missing the tool refuses with a named
 * reason; the protocol then falls back to numbered prose, but "no tool" is
 * never a reason to skip asking.
 *
 * @module dsh-metacog/tools/ask
 */
import type { AskUserQuestionItem, AskUserQuestionRequest, ToolDefinition } from '../host.js'
import { GateError } from '../governance.js'
import { defineMetacogTool, type ToolEnvironment } from './shared.js'

/** One answer as the model sees it. */
export interface AskAnswer {
  readonly id: string
  readonly selected: string[]
  readonly custom: string
}

/** What `metacog_ask_user` returns. */
export interface AskResult {
  readonly answers: AskAnswer[]
}

/** One question the model may send. */
interface AskQuestionInput {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  readonly multiSelect?: boolean
}

/** Validate the raw arguments into the host's question shape. */
function normalizeQuestions(raw: unknown): AskUserQuestionItem[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new GateError('INVALID_ARGS', 'questions must be a non-empty array')
  }
  return raw.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new GateError('INVALID_ARGS', `questions[${index}] must be an object`)
    }
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const question = typeof record.question === 'string' ? record.question.trim() : ''
    if (id.length === 0) throw new GateError('INVALID_ARGS', `questions[${index}].id is required`)
    if (question.length === 0) throw new GateError('INVALID_ARGS', `questions[${index}].question is required`)
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
          if (option === null || typeof option !== 'object') return []
          const entry = option as Record<string, unknown>
          if (typeof entry.label !== 'string' || entry.label.trim().length === 0) return []
          return [
            {
              label: entry.label.trim(),
              ...(typeof entry.description === 'string' && entry.description.length > 0
                ? { description: entry.description }
                : {}),
            },
          ]
        })
      : undefined
    return {
      id,
      question,
      ...(typeof record.detail === 'string' && record.detail.length > 0 ? { detail: record.detail } : {}),
      ...(typeof record.header === 'string' && record.header.length > 0 ? { header: record.header } : {}),
      ...(options === undefined || options.length === 0 ? {} : { options }),
      ...(record.multiSelect === true ? { multiSelect: true } : {}),
    }
  })
}

/**
 * Register `metacog_ask_user`.
 *
 * @param env - shared tool environment.
 */
export function metacogAskUserTool(env: ToolEnvironment): ToolDefinition {
  return defineMetacogTool<AskResult>({
    name: 'metacog_ask_user',
    description:
      'Ask the user a question through the host card UI and wait for the answer. Use this instead ' +
      'of writing questions into prose: the card gives the user clickable options. This tool ships ' +
      'with the metacog plugin, so it is available even when the deployment did not register ' +
      'ask_user_question. If the host exposes no question service it refuses with a named reason; ' +
      'then fall back to a numbered list in prose — never skip asking.',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'One or more questions; ask them together rather than in several rounds.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable id echoed back in the answer.' },
              question: { type: 'string', description: 'The question itself.' },
              detail: { type: 'string', description: 'Optional supporting detail.' },
              header: { type: 'string', description: 'Optional short heading.' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['label'],
                  additionalProperties: false,
                },
              },
              multiSelect: { type: 'boolean' },
            },
            required: ['id', 'question'],
            additionalProperties: false,
          },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    async run(args, exec) {
      const input = (args ?? {}) as { questions?: unknown }
      const questions = normalizeQuestions(input.questions)
      const service = env.ctx.get('userQuestions') as
        | { ask(request: AskUserQuestionRequest): Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }> }
        | undefined
      if (service === undefined || typeof service.ask !== 'function') {
        throw new GateError(
          'USER_QUESTIONS_UNAVAILABLE',
          'the host exposes no userQuestions service, so the card cannot be shown; fall back to a ' +
            'numbered list in prose and keep the question — do not confirm without an answer.',
        )
      }
      const answer = await service.ask({
        questions,
        ...(exec.agent === undefined ? {} : { agent: exec.agent }),
        signal: exec.signal,
        wait: { callId: exec.callId },
      })
      return {
        answers: (answer.answers ?? []).map((item) => ({
          id: item.id,
          selected: [...item.selected],
          custom: item.custom ?? '',
        })),
      }
    },
  })
}
