/**
 * The `metacog_revise` tool: the only way the tree changes after confirmation.
 *
 * Wraps {@link applyRevisions} with the persistence and audit obligations any
 * structural change carries. The tool exists as a separate entry point rather
 * than an option on `goal_tree_init` because the two acts are conceptually
 * different: init derives from evidence once, revise records what the user says
 * changed. Merging them would make it easy to re-derive by accident.
 *
 * @module dsh-metacog/tools/revise
 */
import type { ToolDefinition } from '../host.js';
import { type ToolEnvironment } from './shared.js';
/**
 * Register `metacog_revise`.
 *
 * @param env - shared tool environment.
 */
export declare function metacogReviseTool(env: ToolEnvironment): ToolDefinition;
