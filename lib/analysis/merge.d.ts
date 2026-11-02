/**
 * Merging a candidate tree into the main tree.
 *
 * The constraint this exists to respect: **one workspace holds one tree**. A
 * goal tree is the yardstick every alignment judgement is measured against, so
 * two of them would mean two incompatible yardsticks and every past judgement
 * would be answering a different question.
 *
 * But projects grow. A scan can surface a whole sub-project — new deliverables,
 * new literature, a new line of work — that belongs to no existing L1. Deleting
 * the main tree and re-deriving loses the history of why the old nodes existed;
 * refusing to grow leaves the new work unmonitored. Merging is the third option:
 * keep both, reconcile them once, record the reconciliation.
 *
 * This module is pure. It takes two trees and returns one plus a report of what
 * it decided, so the caller can preview a merge, audit it, or throw it away.
 *
 * @module dsh-metacog/analysis/merge
 */
import type { ContradictionNode, GoalNode, TreeState } from '../data/types.js';
/** How to resolve a node that exists on both sides with different content. */
export type MergeStrategy = 
/** Keep the main tree's node; the candidate's version is dropped. */
'keep-main'
/** Take the candidate's node, keeping the main tree's id. */
 | 'take-candidate';
/** What one merge decided, node by node. */
export interface MergeReport {
    /** Goal ids that came from the candidate and now live in the merged tree. */
    readonly addedGoalIds: string[];
    /** Goal ids that existed on both sides; the main version was kept. */
    readonly keptGoalIds: string[];
    /** Goal ids whose content was replaced by the candidate's version. */
    readonly replacedGoalIds: string[];
    /** Contradiction ids added from the candidate. */
    readonly addedContradictionIds: string[];
    /** Contradiction ids that existed on both sides. */
    readonly keptContradictionIds: string[];
    /**
     * References rewritten because a candidate node was mapped onto a main node
     * with a different id. Each entry is `from -> to`.
     */
    readonly remappedReferences: {
        from: string;
        to: string;
    }[];
    /** Candidate nodes skipped, with the reason. */
    readonly skipped: {
        title: string;
        reason: string;
    }[];
}
/** The merged tree plus what happened. */
export interface MergeOutcome {
    readonly goals: GoalNode[];
    readonly contradictions: ContradictionNode[];
    readonly report: MergeReport;
}
/**
 * Pick which root survives when the two trees state different purposes.
 *
 * The main tree's root wins unless the caller explicitly says otherwise: the
 * main tree is what every past judgement was measured against, so replacing its
 * root silently would reinterpret history.
 *
 * @param strategy - the caller's choice.
 * @returns which side's root survives.
 */
export declare function resolveRoot(strategy: MergeStrategy): 'main' | 'candidate';
/**
 * Merge a candidate tree into the main tree.
 *
 * The rules, in order:
 *
 * 1. The root: one L0 survives, chosen by {@link resolveRoot}. The other root
 *    becomes an L1 under it (so its content is not lost) unless its title
 *    duplicates an existing node, in which case it is dropped and reported.
 * 2. Same id: the main node wins unless the strategy says otherwise.
 * 3. Same normalized title: treated as the same goal. The main node keeps its
 *    id and the candidate's references are remapped onto it, so no link dangles.
 * 4. Otherwise the candidate node is added, keeping its id when free.
 * 5. Contradictions follow their goals through the same remapping; a
 *    contradiction whose primary goal was dropped is reported, not silently
 *    kept pointing at nothing.
 *
 * @param main - the tree that stays.
 * @param candidate - the tree being folded in.
 * @param options - root strategy and timestamp for `updatedAt`.
 * @returns the merged arrays plus a report.
 */
export declare function mergeTrees(main: TreeState, candidate: TreeState, options: {
    strategy?: MergeStrategy;
    now: string;
}): MergeOutcome;
/**
 * Check the merged result is structurally sound before anyone commits it.
 *
 * The merge itself cannot guarantee this: a candidate tree can be internally
 * valid yet produce a cycle once its root is demoted under the main root.
 *
 * @param goals - the merged goal list.
 * @returns problems found, empty when the shape is sound.
 */
export declare function checkMergedShape(goals: readonly GoalNode[]): string[];
