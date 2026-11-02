/**
 * `metacog_merge_tree`: fold a candidate tree into the main tree.
 *
 * The constraint that shapes this tool: **one workspace holds one tree**, and
 * `goal_tree_confirm` refuses to replace a confirmed one for good reason — a
 * yardstick that gets re-derived whenever documents change invalidates every
 * past judgement.
 *
 * But a project can grow a whole new line of work that belongs under no
 * existing node. This tool is the sanctioned way to grow the yardstick without
 * discarding it: the main tree stays, the candidate's new nodes are added, the
 * duplicates are reconciled, and the whole act lands as one audit entry.
 *
 * Two phases, because a merge is not reversible by inspection:
 *
 * - `preview: true` returns the report without writing anything. This is the
 *   default when `confirm` is absent, so a caller cannot merge by accident.
 * - `confirm: true` commits, taking a snapshot first so the pre-merge state is
 *   recoverable.
 *
 * @module dsh-metacog/tools/merge
 */
import type { ToolDefinition } from '../host.js';
import { type ToolEnvironment } from './shared.js';
/**
 * Register `metacog_merge_tree`.
 *
 * @param env - shared tool environment.
 */
export declare function metacogMergeTreeTool(env: ToolEnvironment): ToolDefinition;
