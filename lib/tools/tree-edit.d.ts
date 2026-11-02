import { VersionConflictError } from '../data/store.js';
import { type ToolEnvironment } from './shared.js';
import type { ToolDefinition } from '../host.js';
/** Result of either edit tool. */
export interface EditResult {
    projectId: string;
    version: number;
    auditEntryId: string;
    auditAction: string;
    changedGoalIds: string[];
    changedContradictionIds: string[];
    reclassifiedContradictionIds: string[];
    addedGoalIds: string[];
    addedContradictionIds: string[];
    /**
     * Nodes that were deleted. Reported separately because a removal leaves no
     * trace in the surviving arrays: without this the reply and the audit entry
     * look identical to an edit that changed nothing.
     */
    removedGoalIds: string[];
    removedContradictionIds: string[];
    contradictionsNeedingReview: string[];
}
/**
 * Register `goal_tree_edit`.
 *
 * @param env - shared tool environment.
 */
export declare function goalTreeEditTool(env: ToolEnvironment): ToolDefinition;
/**
 * Register `contradiction_tree_edit`.
 *
 * @param env - shared tool environment.
 */
export declare function contradictionTreeEditTool(env: ToolEnvironment): ToolDefinition;
export { VersionConflictError };
