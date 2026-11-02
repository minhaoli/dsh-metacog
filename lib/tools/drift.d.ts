/**
 * Analysis-layer tools: `check_drift`, `contradiction_observe` and
 * `resolve_intervention`.
 *
 * These are the only entries into the analysis layer. Each one keeps its own
 * responsibility narrow:
 *
 * - `check_drift` judges one activity (or runs the static checks) and returns
 *   whatever the escalation machine decided;
 * - `contradiction_observe` records one timestamped intensity reading and
 *   returns the trend computed from the stream — it never writes the node's
 *   `trend` field;
 * - `resolve_intervention` records the user's decision and audits it, touching
 *   no tree and no trend.
 *
 * @module dsh-metacog/tools/drift
 */
import { type ToolEnvironment } from './shared.js';
import type { MetacogStore } from '../data/store.js';
import type { ToolDefinition } from '../host.js';
/**
 * File paths an activity's evidence actually names.
 *
 * Evidence is the only place a recorded activity carries files: the collector
 * writes `<tool>: <value>` for every artifact-shaped argument, and a manually
 * reported activity mixes paths with commands, symbols, URLs and prose. Path
 * ownership is positive attribution — a touched path moves work onto the goal
 * that declared the prefix — so guessing is worse than staying silent: this
 * keeps an entry only when, after stripping a leading `<tool>: ` tag, it is an
 * unambiguous project-relative path.
 *
 * Both callers of {@link runActivityCheck} use this function, so the two entry
 * points cannot drift apart on what counts as a touched file. An activity that
 * names no file yields `[]`, which is judged exactly as it was before path
 * ownership existed.
 *
 * @param evidence - evidence lines as the caller or collector recorded them.
 * @returns distinct candidate paths, in first-seen order; `[]` when none.
 */
export declare function pathsFromEvidence(evidence: readonly string[]): string[];
/**
 * Register `check_drift`.
 *
 * @param env - shared tool environment.
 */
export declare function checkDriftTool(env: ToolEnvironment): ToolDefinition;
/**
 * Register `contradiction_observe`.
 *
 * @param env - shared tool environment.
 */
export declare function contradictionObserveTool(env: ToolEnvironment): ToolDefinition;
/**
 * Register `resolve_intervention`.
 *
 * @param env - shared tool environment.
 */
export declare function resolveInterventionTool(env: ToolEnvironment): ToolDefinition;
/**
 * Record the user's decision on one pending intervention.
 *
 * Extracted from the tool so the settings card can settle a card too. Both callers
 * must leave the same audit trail and apply the same supersede rule, and the only
 * way to guarantee that is one implementation: a card that resolved cards its own
 * way would eventually diverge from the tool, and the audit log would then depend
 * on which surface the user happened to click.
 *
 * @param store - the project's store.
 * @param projectId - owning project.
 * @param interventionId - card to decide.
 * @param decision - what the user chose.
 * @param rationale - why; audited, so it is required.
 */
export declare function resolveInterventionDecision(store: MetacogStore, projectId: string, interventionId: string, decision: 'continue' | 'realign' | 'modify_goals' | 'dismiss', rationale: string): Promise<{
    projectId: string;
    interventionId: string;
    level: number;
    status: string;
    decision: string;
    rationale: string;
    decidedAt: string;
    auditEntryId: string;
    supersededIds: string[];
    level3GateActive: boolean;
}>;
