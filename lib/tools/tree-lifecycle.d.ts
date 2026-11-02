import { type ContradictionGoalLink } from '../data/types.js';
import { describeScan } from '../evidence/scanner.js';
import type { TaskDirectoryView } from '../evidence/discover.js';
import { type SessionMaterial } from '../analysis/derive.js';
import { type ToolEnvironment } from './shared.js';
import type { ToolDefinition } from '../host.js';
/**
 * What `goal_tree_init` returns.
 *
 * Two shapes share this type because the tool has two honest outcomes:
 * `derived` when a model produced a candidate structure, and `discovery-only`
 * when it could not (no subagent service, no initiator, provider failure). The
 * latter still reports what was found on disk so the caller can act on it,
 * rather than pretending nothing happened.
 */
export interface InitResult {
    projectId: string;
    projectRoot: string;
    version: number;
    mode: 'derived' | 'discovery-only';
    /** Files found per category, always present. */
    materials: Record<string, number>;
    inspectedPaths: string[];
    warnings: string[];
    contextStored: boolean;
    /** Project background read from the documents; `derived` runs only. */
    projectProfile?: {
        summary: string;
        stage: string;
        deliverables: string[];
    };
    /**
     * Present only when a previously confirmed tree was cleared to make room for
     * this derivation. Names where the replaced tree was backed up, so the discard
     * is recoverable rather than merely recorded.
     */
    rebuild: {
        previousVersion: number;
        backupPath: string;
        auditEntryId: string;
    } | null;
    /** `derived` only: candidate goals with their derivation. */
    goals: {
        tempId: string;
        title: string;
        description: string;
        depth: number;
        parentTempId: string | null;
        derivation: string;
        evidence: string[];
        successCriteria: string[];
        /** Alignment criteria: the only fields the activity matcher reads. */
        relevantActivities: string[];
        allowedMethods: string[];
        confidence: number;
        alternative: string;
    }[];
    /** `derived` only: accepted contradictions. */
    contradictions: unknown[];
    noContradictionFound?: boolean;
    openQuestions: string[];
    rejections?: unknown[];
    capped?: unknown[];
    /** Token/时间成本，供调用方评估。 */
    usage: unknown;
    /** `discovery-only` only. */
    skippedDirs?: {
        path: string;
        reason: string;
    }[];
}
/**
 * Collect the session history that may explain which tasks are finished.
 *
 * Derivation runs as a subagent and cannot reach host services, so this runs in
 * the plugin process and hands over plain data. Three sources are combined:
 * live sessions (`sessions.list`), archived ones (workspace registry), and —
 * when the semantic engine is available — content hits attached by cwd.
 *
 * Every source is optional. A missing engine, a cold index or an embedding
 * backend that is down all end in `contentSearchUsed: false` with a reason, and
 * the prompt says in words that conversation content did not participate. It
 * never fabricates a snippet to fill the gap.
 *
 * @param ctx - host context.
 * @param projectRoot - absolute workspace root.
 * @param directories - the task directories, used for title matching.
 * @param exec - tool run context, forwarded to the query engine.
 */
export declare function collectSessionMaterial(ctx: ToolEnvironment['ctx'], projectRoot: string, directories: TaskDirectoryView, exec: unknown): Promise<SessionMaterial>;
/**
 * Register `goal_tree_init`.
 *
 * Scans the project and writes an unconfirmed candidate tree at version 0.
 *
 * @param env - shared tool environment.
 */
export declare function goalTreeInitTool(env: ToolEnvironment): ToolDefinition;
/**
 * Register `goal_tree_confirm`.
 *
 * Converts chosen candidates (or user-supplied replacements) into confirmed,
 * active nodes, sets version 1 and writes the genesis audit entry.
 *
 * @param env - shared tool environment.
 */
export declare function goalTreeConfirmTool(env: ToolEnvironment): ToolDefinition;
/** Compact projection of a goal for `goal_tree_view`. */
export interface GoalView {
    id: string;
    depth: number;
    title: string;
    /**
     * The node's own wording, as written at confirm or revision time.
     *
     * Projected because a revision that changes only the description is otherwise
     * invisible: the write succeeds, the version bumps, and the caller reads back a
     * node that looks untouched — which invites the same edit again.
     */
    description: string;
    status: string;
    confirmed: boolean;
    parentId: string | null;
    priority: number;
    successCriteria: string[];
    evidence: string[];
    relevantActivities: string[];
    explorationPolicy: string;
    /**
     * Aggregated contradiction pressure on this goal.
     *
     * `Σ intensity × weight` over the unresolved tensions that touch it. Exposed
     * here because goal recommendation needs exactly this number, and computing it
     * in the projection keeps that definition from drifting away from the one the
     * pure function implements.
     */
    contradictionBurden: {
        total: number;
        count: number;
        peak: number;
        unmeasured: number;
    };
    /**
     * The tensions behind those numbers, named.
     *
     * A count alone cannot be acted on: "3" does not say whether the goal is
     * blocked by the core tension or by three minor ones. Same set the burden
     * sums over — unresolved, primary or weighted related link — strongest first.
     */
    relatedContradictions: {
        id: string;
        title: string;
        intensity: number | null;
        weight: number;
    }[];
    /**
     * Fold state, present only when the caller asked for the collapsed view and
     * this node's whole subtree is done.
     *
     * Its descendants are then absent from `goals`, and this object is the one
     * line that stands in for them. Without the flag the field is absent and every
     * goal is listed: the first look at a tree must never silently hide branches.
     */
    collapsed?: {
        /** Direct children folded away. */
        folded: number;
        /** The stand-in line, e.g. `已完成（3 个子目标）`. */
        summary: string;
    };
}
/** Compact projection of a contradiction for `goal_tree_view`. */
export interface ContradictionView {
    id: string;
    type: string;
    title: string;
    /** The stated consequence of the tension; `''` when none was given. */
    description: string;
    confirmed: boolean;
    primaryGoalId: string;
    relatedGoalIds: string[];
    /** The contradiction tree's own links, so the hierarchy is readable, not flat. */
    parentId: string | null;
    /** Parent ids from the immediate parent up to the root. Empty at top level. */
    parentChain: string[];
    /** Ids of the contradictions that hang directly under this one. */
    childIds: string[];
    /**
     * Every goal this tension presses on, with its effective weight.
     *
     * Resolved through `contradictionGoalLinks`, so the primary goal appears at
     * 1.0 and a legacy id appears at the configured default: this is the list the
     * burden calculation actually reads, not merely what was stored.
     */
    goalLinks: ContradictionGoalLink[];
    /**
     * Root → primary goal, inclusive: the branch this tension sits under.
     *
     * The id alone forces a second call to know what it means; the chain makes the
     * tension readable in the goal tree's own terms, which is the whole point of
     * linking the two trees.
     */
    primaryGoalChain: {
        id: string;
        title: string;
        depth: number;
    }[];
    /**
     * Other goals it presses on, with effective weights.
     *
     * The primary goal is excluded because it already has `primaryGoalChain`;
     * weights here are the resolved ones, so a legacy id appears at the configured
     * default rather than at an invented 1.0.
     */
    relatedGoals: {
        id: string;
        title: string;
        weight: number;
    }[];
    poleA: string;
    poleB: string;
    /** Why the tension is structural, as recorded at creation or revision. */
    rationale: string;
    /** What would relieve it; rewritten by `contradiction_resolved`. */
    resolutionHint: string;
    intensity: number | null;
    trend: string;
    evidence: string[];
}
/**
 * Register `goal_tree_view`.
 *
 * @param env - shared tool environment.
 */
export declare function goalTreeViewTool(env: ToolEnvironment): ToolDefinition;
export { describeScan };
