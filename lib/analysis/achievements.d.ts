/**
 * What got done, and what it cost.
 *
 * The monitor's other modules answer "is this drifting". This one answers the
 * question that keeps a person working: "did any of this land". It reads the
 * achievement timestamps (`goal.doneAt`, `contradiction.resolvedAt`), works out
 * which goals are absorbing effort without moving, and reports both — because a
 * report that only says "偏离" is a report people stop reading.
 *
 * Two measurements are deliberately crude and labelled as such:
 *
 * - `share` is a count of activities, not time. The collector records one
 *   timestamp per activity and no durations, so any "hours spent" figure would be
 *   invented. A count is honest; hours are not.
 * - `depthRatio` uses the tree's own depth, which the user defines. It says
 *   "deep in the tree", not "unimportant".
 *
 * @module dsh-metacog/analysis/achievements
 */
import type { ActivityRecord, ContradictionNode, GoalNode, TreeState } from '../data/types.js';
/** One thing that finished, in the period being reported. */
export interface Achievement {
    kind: 'goal' | 'contradiction';
    id: string;
    title: string;
    /** ISO timestamp it finished at. */
    at: string;
    /** Tree depth, for goals. */
    depth?: number;
    /** Intensity before resolution, for contradictions. */
    intensityBefore?: number | null;
}
/** A goal absorbing effort without moving. */
export interface DetailTrap {
    goalId: string;
    title: string;
    depth: number;
    /** Fraction of the period's activities attributed to this goal, 0–1. */
    share: number;
    /** `depth / maxDepth`, 0–1. */
    depthRatio: number;
    /** Days since the last activity attributed to it. */
    staleDays: number;
    /** The higher-urgency goal that this one is crowding out, when there is one. */
    crowdedOut?: {
        goalId: string;
        title: string;
        urgency: number;
    };
    /** One sentence for the report. */
    summary: string;
}
/**
 * Collect what finished inside a period.
 *
 * @param state - current tree state.
 * @param start - period start.
 * @param end - period end.
 * @returns achievements, newest first.
 */
export declare function collectAchievements(state: TreeState, start: Date, end: Date): Achievement[];
/**
 * Compute `U(g,t)`: how pressing a goal is.
 *
 * Higher means more pressing, and the measure is the time actually left, not the
 * fraction of the original span. An earlier version used the fraction and it was
 * wrong in a way that inverted the ordering: with both goals created 30 days ago,
 * one due in 2 days scored 0.063 and one due in 30 days scored 0.500 — because
 * the 2-day goal's remaining slice of a 62-day span is tiny. A 2-day deadline is
 * more pressing than a 30-day one; anything that says otherwise is a bug, no
 * matter how defensible the formula looks.
 *
 * So: remaining days, mapped through a hyperbola so it stays in a bounded range
 * while preserving order. `1/(1 + days/7)` gives 1.0 today, 0.5 in a week, 0.19
 * in a month, and never reaches zero.
 *
 * An overdue goal is pinned above every future one at 2.0 — an overdue goal is the
 * most urgent thing on the tree, not the least.
 *
 * A goal with no deadline gets a small constant above zero. It is not zero: an
 * undated goal still matters, and returning 0 would sort it below every dated
 * goal regardless of what the user said.
 *
 * @param goal - the goal.
 * @param now - reference time.
 * @returns a comparable number; larger is more pressing.
 */
export declare function urgencyOf(goal: GoalNode, now: Date): number;
/**
 * Find goals that are absorbing effort while a more pressing one waits.
 *
 * The definition is deliberately conjunctive. High share alone is not a trap —
 * focused work on the most important goal looks exactly like that. It becomes a
 * trap when the effort goes to something deep, unimportant by urgency, and a
 * more urgent sibling is stalled.
 *
 * @param state - current tree state.
 * @param activities - activities in the period.
 * @param now - reference time.
 * @returns traps, worst first.
 */
export declare function detectDetailTraps(state: TreeState, activities: readonly ActivityRecord[], now: Date): DetailTrap[];
/** How much of the goal tree is done, weighted by depth. */
export interface ProgressSummary {
    /** Confirmed goals in total. */
    totalGoals: number;
    /** Confirmed goals whose status is `done`. */
    doneGoals: number;
    /** `doneGoals / totalGoals`. */
    completion: number;
    /** Contradictions recorded. */
    totalContradictions: number;
    /** Contradictions with a `resolvedAt`. */
    resolvedContradictions: number;
    /** Per-depth completion, deepest last. */
    byDepth: {
        depth: number;
        total: number;
        done: number;
    }[];
    /** The single line a report can print. */
    line: string;
}
/**
 * Summarise how far along the tree is.
 *
 * Completion is a plain ratio of goals, not a weighted score. A weighted version
 * would need to know how much each goal matters, and that is exactly the thing
 * the tree does not record — inventing weights would make the progress bar move
 * in ways the user cannot predict from their own tree.
 *
 * @param state - current tree state.
 * @returns the summary.
 */
export declare function summarizeAchievements(state: TreeState): ProgressSummary;
/**
 * The contradictions whose intensity fell over a period.
 *
 * Reported because a falling tension is progress even when no goal finished, and
 * the goal tree alone cannot show it.
 *
 * @param before - observations or nodes at the start of the period.
 * @param nodes - current nodes.
 * @returns the improvements.
 */
export declare function easingContradictions(before: readonly ContradictionNode[], nodes: readonly ContradictionNode[]): {
    id: string;
    title: string;
    from: number;
    to: number;
}[];
