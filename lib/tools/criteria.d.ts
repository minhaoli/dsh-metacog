import type { ToolDefinition } from '../host.js';
import { type ToolEnvironment } from './shared.js';
/** One goal's suggestion, or why it could not be produced. */
export interface CriteriaSuggestion {
    readonly goalId: string;
    readonly title: string;
    readonly status: 'suggested' | 'unable' | 'failed';
    readonly relevantActivities: string[];
    readonly excludedActivities: string[];
    /** Human-readable reason; empty for a suggestion. */
    readonly reason: string;
    /** Items dropped by the quality gate, with the gate that dropped them. */
    readonly rejected: string[];
}
/** What `metacog_draft_criteria` returns. */
export interface DraftCriteriaResult {
    readonly projectId: string;
    readonly projectRoot: string;
    /** Whether the caller asked for a dry run (always true in effect). */
    readonly dryRun: boolean;
    /** Always false: this tool never writes the tree. */
    readonly wrote: false;
    readonly totalGoals: number;
    /** Goals that needed criteria (or all selected goals with `overwrite`). */
    readonly eligible: number;
    readonly processed: number;
    /** Eligible goals beyond `limit`, not processed this call. */
    readonly truncated: number;
    readonly suggestions: CriteriaSuggestion[];
    /** Goals deliberately skipped, with the reason. */
    readonly skipped: {
        goalId: string;
        reason: string;
    }[];
    readonly counts: {
        suggested: number;
        unable: number;
        failed: number;
    };
    readonly note: string;
}
/**
 * Register `metacog_draft_criteria`.
 *
 * @param env - shared tool environment.
 */
export declare function metacogDraftCriteriaTool(env: ToolEnvironment): ToolDefinition;
