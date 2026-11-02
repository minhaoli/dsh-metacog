/**
 * Report generation tools.
 *
 * @module dsh-metacog/tools/report
 */
import type { ToolDefinition } from '../host.js';
import { type ToolEnvironment } from './shared.js';
/**
 * `generate_report`: build one daily/weekly/monthly report over the recorded
 * stream, bound to the tree version it read.
 *
 * @param env - tool environment.
 */
export declare function generateReportTool(env: ToolEnvironment): ToolDefinition;
