/**
 * `metacog_archive_milestone`: stamp the current tree and its judgement statistics.
 *
 * The tree snapshots itself on every commit, so the tree alone is not worth
 * archiving twice. What is missing is the pairing: these statistics were measured
 * against that tree. Half a year from now the useful question is not "what did the
 * tree say" but "when we changed it, did the judgements get better", and neither
 * half answers that alone.
 *
 * Deliberately manual. A milestone is a decision — structure was confirmed, a phase
 * ended, thresholds moved. Stamping one on every commit would fill a directory
 * nobody opens, and a directory nobody opens is indistinguishable from no archive.
 *
 * @module dsh-metacog/tools/milestone
 */
import { type ToolEnvironment } from './shared.js';
import type { ToolDefinition } from '../host.js';
/** What the tool returns. */
export interface MilestoneResult {
    projectId: string;
    version: number;
    path: string;
    next: string;
}
/** Register `metacog_archive_milestone`. */
export declare function metacogArchiveMilestoneTool(env: ToolEnvironment): ToolDefinition;
