import { type ToolEnvironment } from './shared.js';
import type { ToolDefinition } from '../host.js';
/**
 * `metacog_declare_plan`: record what this session intends to do.
 */
export declare function declarePlanTool(env: ToolEnvironment): ToolDefinition;
/**
 * `metacog_revise_plan`: change the plan mid-session.
 *
 * Needed because a legitimate change of direction is normal, and without a way to
 * record it, the change looks exactly like drift. Revising is an explicit act
 * with an audit trail, not a silent overwrite.
 */
export declare function revisePlanTool(env: ToolEnvironment): ToolDefinition;
