/**
 * Storage-free views over a goal array: which leaves are executable, and how a
 * completed subtree folds for display.
 *
 * The two questions share a home because both are pure projections of the same
 * array — neither reads the store, neither writes one, and both are needed by
 * more than one caller. Keeping them here rather than inside a tool means the
 * report and both write paths compute the same answer from the same code.
 *
 * The fold defaults to **off**. Initialisation and the first look at a tree must
 * show every goal: a monitor whose completed branches have already vanished is
 * one whose state the user cannot check, and "already folded" is indistinguishable
 * from "never existed". Only a caller that explicitly asks for a fold gets one.
 *
 * @module dsh-metacog/analysis/collapse
 */
/**
 * The part of a goal these views read.
 *
 * Structural rather than `GoalNode` so a candidate, a snapshot and a plain test
 * fixture can all be folded without being parsed into the full schema first.
 */
export interface GoalLike {
    readonly id: string;
    readonly parentId: string | null;
    readonly title: string;
    readonly status?: string | undefined;
    readonly successCriteria?: readonly string[] | undefined;
}
/** Options shared by the fold. */
export interface CollapseOptions {
    /**
     * Fold a parent whose whole subtree is done into one summary line.
     *
     * Defaults to false — see the module comment. This is a presentation choice,
     * never a storage one: nothing here changes a `status`.
     */
    readonly collapseDone?: boolean | undefined;
}
/** One parent and the direct children under it. */
export interface GoalGroup<G extends GoalLike> {
    /** Id of the parent, so a caller can key the group without walking `parent`. */
    readonly id: string;
    readonly parent: G;
    readonly children: readonly G[];
    /**
     * Every node below the parent is done (the parent itself may still be active:
     * a strategy is not finished merely because its parts are).
     */
    readonly allDone: boolean;
    /** `allDone` and the caller asked for a fold. */
    readonly collapsed: boolean;
    /** All descendants, deepest last; empty for a leaf group. */
    readonly descendants: readonly G[];
    /**
     * The single line that stands in for the subtree when collapsed, counting the
     * descendants it replaces; `''` when the group stays expanded.
     */
    readonly summary: string;
}
/** What {@link collapseCompleted} returns. */
export interface CollapsedGoals<G extends GoalLike> {
    /** One group per node that has at least one direct child, in input order. */
    readonly groups: readonly GoalGroup<G>[];
    /** The nodes a caller should print, in input order. */
    readonly visible: readonly G[];
    /** The nodes a folded group replaced, in input order. */
    readonly folded: readonly G[];
    /** True when at least one group was folded. */
    readonly anyCollapsed: boolean;
}
/**
 * Group a goal array for display, optionally folding completed subtrees.
 *
 * A group folds when every node **below** its parent is done. The stricter
 * "whole subtree" reading is deliberate: folding on direct children alone would
 * hide an active grandchild under a parent that happens to have only finished
 * children, and a hidden active goal is worse than a long list.
 *
 * @param goals - the tree, as any order; a node whose parent is absent is
 *   treated as a root rather than dropped.
 * @param options - see {@link CollapseOptions}.
 */
export declare function collapseCompleted<G extends GoalLike>(goals: readonly G[], options?: CollapseOptions): CollapsedGoals<G>;
/**
 * Completion phrases that assert no checkable outcome.
 *
 * A leaf is the most concrete level of the tree, so its `successCriteria` is the
 * only place "how is this done?" can be answered. "完成" answers it with the
 * question itself. The list is exact-match after normalisation, never a
 * substring test — "完成登录页并跑通 e2e" must pass, only the bare "完成" fails.
 *
 * Chinese and English entries sit together because a tree may mix them; adding
 * a phrase here is the whole mechanism, so a later reader can tune the rule
 * without touching the gate.
 */
export declare const GENERIC_CRITERIA: readonly string[];
/**
 * Whether a criterion is a bare platitude.
 *
 * An entry that is empty after normalisation is **not** generic — it is blank,
 * and `inspectLeafActionability` reports the two separately because "you wrote
 * nothing" and "you wrote '完成'" need different fixes.
 */
export declare function isGenericCriterion(criterion: string): boolean;
/** What {@link assessGoalConcreteness} concluded. */
export interface GoalConcreteness {
    /** True when the goal names something that can be checked afterwards. */
    readonly concrete: boolean;
    /** Why it is not concrete, phrased for the caller to act on. */
    readonly reason?: string;
    /** A rewrite direction, when one can be inferred from the goal alone. */
    readonly suggestion?: string;
}
/**
 * Whether a stated session goal names something that can be checked.
 *
 * The contract, because more than one caller needs it — `declare_plan` and
 * `revise_plan` gate on it today, and "what are you doing today?" will ask the
 * same question of a human answer:
 *
 * - **Input**: one sentence, already trimmed by the caller. No context is
 *   assumed; this is a pure function of the string.
 * - **Output**: `concrete: true` when the goal names a path or file, a tool, a
 *   deliverable noun, a measurable result, an identifier (`S4`, `api.ts`,
 *   `coverageFloor`) or a quoted term. Otherwise `concrete: false` with a
 *   `reason` saying which test failed and a `suggestion` giving a rewrite shape.
 * - **Not concrete** means "this sentence cannot be compared with what the
 *   session actually did", never "this goal is unimportant". A vague goal makes
 *   S4 and the model review compare against nothing.
 *
 * Deliberately conservative: any one concrete signal is enough. A goal that
 * passes may still be a poor goal — judging quality needs context this function
 * does not have — but a goal that fails cannot be judged at all.
 *
 * @param goal - the sentence to assess.
 * @returns the verdict, with a reason and suggestion when it is not concrete.
 */
export declare function assessGoalConcreteness(goal: string): GoalConcreteness;
/** Why one leaf failed the executable check. */
export type LeafIssueReason = 'missing' | 'blank' | 'generic';
/** One leaf that cannot be executed, with the reason in the caller's terms. */
export interface LeafActionabilityIssue {
    readonly goalId: string;
    readonly title: string;
    readonly reason: LeafIssueReason;
    /** For `generic`: the non-blank criteria that were judged platitudes. */
    readonly dismissed: readonly string[];
}
/** The whole-tree answer to "is every leaf executable?". */
export interface LeafActionabilityReport {
    /** Leaves inspected: nodes with no children in this array. */
    readonly leaves: number;
    readonly issues: readonly LeafActionabilityIssue[];
}
/**
 * Check that every leaf states at least one checkable completion condition.
 *
 * A leaf with no `successCriteria`, only whitespace entries, or nothing but
 * platitudes can never be judged done from the outside — so it is either a goal
 * that should have children, or an unfinished one. Both are worth refusing at
 * the write path, where the user can still fix it.
 *
 * @param goals - the whole tree, in any order.
 */
export declare function inspectLeafActionability(goals: readonly GoalLike[]): LeafActionabilityReport;
/**
 * One refusal message naming every offending leaf and why.
 *
 * All of them, not the first: a caller repairing a tree should need one pass,
 * not one call per node.
 */
export declare function describeLeafActionability(report: LeafActionabilityReport): string;
/** Stable payload for the gate error, so both callers report the same shape. */
export declare function leafActionabilityDetails(report: LeafActionabilityReport): {
    goals: {
        id: string;
        title: string;
        reason: LeafIssueReason;
    }[];
    reasons: Record<LeafIssueReason, string[]>;
};
