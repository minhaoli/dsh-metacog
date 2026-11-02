/**
 * Structural change governance: the rules that decide whether a proposed tree
 * edit may reach the store at all.
 *
 * The spec's gate requirements live here rather than inside the tool
 * definitions, so every path that mutates structure — a tool call, a
 * confirmation, a future automated reclassification — passes the same checks.
 *
 * Three rules, each with a distinct failure mode:
 *
 * 1. L0 and confirmed `core` contradiction changes require an explicit
 *    `userConfirmed: true` plus a non-empty `reason`.
 * 2. L1 changes always require a reason and mark dependent contradictions for
 *    re-evaluation, because a strategy shift invalidates tensions derived from
 *    the old strategy.
 * 3. Tree shape invariants (exactly one L0, valid parents, no goal cycles) are
 *    validated regardless of who is acting.
 *
 * @module dsh-metacog/governance
 */
import { type ContradictionNode, type GoalNode } from './data/types.js';
/** A rejection with a stable code, rendered to the model as a refusal. */
export declare class GateError extends Error {
    readonly details: Record<string, unknown>;
    readonly code: string;
    constructor(code: string, message: string, details?: Record<string, unknown>);
}
/** Evidence that one node changed, keyed by kind. */
export interface ChangeSet {
    /** Goal ids whose content changed. */
    changedGoalIds: string[];
    /** Contradiction ids whose content changed. */
    changedContradictionIds: string[];
    /** Contradiction ids whose `type` changed. */
    reclassifiedContradictionIds: string[];
    /** Contradiction ids added. */
    addedContradictionIds: string[];
    /** Goal ids added. */
    addedGoalIds: string[];
    /**
     * Goal ids that existed before and are gone now.
     *
     * Removals leave no trace in the surviving arrays, so a caller comparing
     * before and after sees nothing at all unless the difference is stated here.
     */
    removedGoalIds: string[];
    /** Contradiction ids that existed before and are gone now. */
    removedContradictionIds: string[];
}
/**
 * Compute which nodes a proposed tree actually changes.
 *
 * `confirmedByUser` and timestamps are excluded: flipping the confirmation bit
 * is what `goal_tree_confirm` does, and it must not count as an L0 content edit
 * requiring a second confirmation.
 *
 * @param beforeGoals - current goals.
 * @param afterGoals - proposed goals.
 * @param beforeContradictions - current contradictions.
 * @param afterContradictions - proposed contradictions.
 */
export declare function computeChanges(beforeGoals: GoalNode[], afterGoals: GoalNode[], beforeContradictions: ContradictionNode[], afterContradictions: ContradictionNode[]): ChangeSet;
/** Caller-supplied authorization context for a structural write. */
export interface AuthorizationContext {
    /** Whether the user explicitly confirmed this exact change. */
    userConfirmed?: boolean;
    /** Why the change is happening. */
    reason?: string;
}
/**
 * Enforce the L0 / core-contradiction second-confirmation gate.
 *
 * @param changes - what the proposal would alter.
 * @param beforeGoals - current goals, for level lookup.
 * @param beforeContradictions - current contradictions, for type lookup.
 * @param authorization - the caller's confirmation claims.
 * @throws {GateError} `L0_CONFIRMATION_REQUIRED`, `CORE_CONFIRMATION_REQUIRED`,
 *   `REASON_REQUIRED`, or `L1_REASON_REQUIRED`.
 */
export declare function assertStructuralGate(changes: ChangeSet, beforeGoals: GoalNode[], beforeContradictions: ContradictionNode[], authorization: AuthorizationContext): void;
/**
 * Validate the shape of a goal tree.
 *
 * @param goals - proposed goal nodes.
 * @throws {GateError} with code `TREE_SHAPE` describing the first violation.
 */
export declare function assertGoalTreeShape(goals: GoalNode[]): void;
/**
 * Validate the shape of a contradiction tree.
 *
 * Goal links are validated separately because they may reference goals that a
 * concurrent edit is adding; only existence against the *proposed* set counts.
 *
 * @param contradictions - proposed contradiction nodes.
 * @param goals - the proposed goal set those links must resolve against.
 * @throws {GateError} with code `TREE_SHAPE`.
 */
export declare function assertContradictionTreeShape(contradictions: ContradictionNode[], goals: GoalNode[]): void;
/**
 * Contradictions that must be re-evaluated after a goal change.
 *
 * A tension is derived from a goal arrangement; when a goal it references moves
 * or changes, the tension's classification may no longer hold.
 *
 * @param contradictions - current contradictions.
 * @param changedGoalIds - goals whose content changed.
 * @returns ids needing a `contradiction_tree_edit` review.
 */
export declare function contradictionsNeedingReview(contradictions: ContradictionNode[], changedGoalIds: string[]): string[];
/**
 * Verify that an evidence list contains at least one traceable entry.
 *
 * @param evidence - candidate evidence refs.
 * @throws {GateError} with code `EVIDENCE_REQUIRED`.
 */
export declare function assertEvidence(evidence: string[], what: string): void;
