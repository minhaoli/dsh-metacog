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
import type { ToolDefinition } from '../host.js';
import { type ToolEnvironment } from './shared.js';
/** One answer as the model sees it. */
export interface AskAnswer {
    readonly id: string;
    readonly selected: string[];
    readonly custom: string;
}
/** What `metacog_ask_user` returns. */
export interface AskResult {
    readonly answers: AskAnswer[];
}
/**
 * Register `metacog_ask_user`.
 *
 * @param env - shared tool environment.
 */
export declare function metacogAskUserTool(env: ToolEnvironment): ToolDefinition;
