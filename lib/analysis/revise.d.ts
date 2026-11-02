/**
 * User-stated revision of the tree.
 *
 * The tree is derived once and then held fixed. That leaves exactly one channel
 * through which it may change after confirmation: the user saying so. This
 * module implements that channel and nothing else.
 *
 * The distinction it protects is subtle but load-bearing:
 *
 * - A **file** changing is not a reason. Documents get edited constantly; that
 *   is work progressing, not intent changing. Re-deriving on file changes would
 *   turn the yardstick into a mirror of whatever was edited last.
 * - A **project** changing is a reason. A goal was dropped, a tension resolved,
 *   a new constraint appeared. Those are facts only the user knows, and they are
 *   stated in the user's own words.
 *
 * Every revision is versioned and audited like any other structural change, so
 * the history of "why the yardstick moved" stays answerable.
 *
 * @module dsh-metacog/analysis/revise
 */
import type { ContradictionNode, GoalNode, TreeState } from '../data/types.js';
/** What kind of change the user is reporting. */
export type RevisionKind = 
/** A goal is no longer wanted, or its wording no longer matches intent. */
'goal_changed'
/** A goal was achieved. */
 | 'goal_achieved'
/** A goal should stop counting as active without being deleted. */
 | 'goal_shelved'
/** A tension was resolved and no longer blocks anything. */
 | 'contradiction_resolved'
/** A new structural tension appeared. */
 | 'contradiction_added'
/** A tension got materially worse; its recorded intensity is stale. */
 | 'contradiction_intensified'
/** A root-level change of purpose. */
 | 'root_changed';
/** One revision the user asked for. */
export interface RevisionRequest {
    kind: RevisionKind;
    /** Goal or contradiction the revision applies to, by id or title. */
    target?: string;
    /** New wording, when the revision changes text. */
    newTitle?: string;
    newDescription?: string;
    /**
     * Replacement path claims, when the revision moves ownership.
     *
     * A whole array rather than an add/remove pair: revisions state the intended
     * end state, and an incremental edit would make the committed tree depend on
     * how many revisions happened to run before it.
     */
    paths?: string[];
    /** New intensity, for contradiction revisions. */
    intensity?: number | null;
    /** Everything new, for `contradiction_added`. */
    create?: {
        title: string;
        poleA: string;
        poleB: string;
        type?: 'core' | 'main' | 'secondary' | 'unclassified';
        primaryGoalRef: string;
        relatedGoalRefs?: string[];
        /** What goes wrong if the tension is ignored. */
        consequence?: string;
        /**
         * Why the tension is structural — it does not go away by working harder.
         * Kept separate from `consequence`, which only states the cost.
         */
        rationale?: string;
        evidence?: string[];
    };
}
/** What the revision changed, for the caller and the audit entry. */
export interface RevisionOutcome {
    /** Version after the change (unchanged when nothing applied). */
    version: number;
    /** Goal ids touched. */
    changedGoalIds: string[];
    /** Contradiction ids touched. */
    changedContradictionIds: string[];
    /**
     * Revisions that could not be applied, with the reason. Reported rather than
     * thrown so a batch containing one bad target still applies the rest.
     */
    skipped: {
        kind: RevisionKind;
        target?: string;
        reason: string;
    }[];
}
/**
 * Apply a batch of user-stated revisions to a tree.
 *
 * Pure: returns new arrays and never mutates the input, so the caller decides
 * whether to commit. Nothing here reads the filesystem — a revision is applied
 * because the user said so, not because evidence was found.
 *
 * @param state - current tree.
 * @param requests - the revisions to apply.
 * @param now - ISO timestamp for `updatedAt`.
 * @returns the new nodes plus what was skipped and why.
 */
export declare function applyRevisions(state: TreeState, requests: readonly RevisionRequest[], now: string): {
    goals: GoalNode[];
    contradictions: ContradictionNode[];
    outcome: RevisionOutcome;
};
/** Audit action for a revision, so the log distinguishes it from a tool edit. */
export declare function auditActionFor(kind: RevisionKind): 'update_l0' | 'update_l1' | 'update_core_contradiction' | 'reclassify_contradiction' | 'resolve_intervention';
/** Human-readable summary used in the audit entry and the reply. */
export declare function describeRevision(request: RevisionRequest): string;
