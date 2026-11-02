/**
 * Deadlines and staged progress reminders.
 *
 * A monitor that only asks "did this activity serve a goal" is blind to *when*
 * the goal is due. Two projects can both look aligned while one is three days
 * from a deadline and the other has no date at all.
 *
 * The staging rule this module implements: reminders fire at fractions of the
 * goal's own span (1/4, 1/2, 3/4, and the final stretch), not at fixed calendar
 * dates. A two-week goal and a two-year goal both get four checkpoints; what
 * differs is when. Fixed dates would either nag long goals constantly or never
 * mention short ones.
 *
 * The other half is the level rule: a long-horizon goal must not be judged by
 * daily activity. A root goal with a two-year deadline showing no movement this
 * afternoon is not stalled — it is a root goal. So the check is scoped: short
 * spans look at leaf goals, long spans at strategic ones.
 *
 * @module dsh-metacog/analysis/progress
 */
import type { GoalNode } from '../data/types.js';
/** Where a goal sits relative to its deadline. */
export type ProgressStage = 'not-started' | 'early' | 'quarter' | 'half' | 'three-quarter' | 'overdue';
/** What the check concluded about one goal. */
export interface ProgressFinding {
    readonly goalId: string;
    readonly title: string;
    readonly depth: number;
    readonly stage: ProgressStage;
    /** Fraction of the span elapsed, 0–1; `null` when the goal has no deadline. */
    readonly elapsed: number | null;
    /** Days left; negative when overdue. `null` without a deadline. */
    readonly daysLeft: number | null;
    /** Whether the goal has evidence of movement since it started. */
    readonly hasProgress: boolean;
    /**
     * Whether this finding should reach the user.
     *
     * A goal at its quarter mark with visible progress is not news. A goal past
     * its three-quarter mark with none is.
     */
    readonly shouldRemind: boolean;
    /** One sentence stating the situation, in the user's terms. */
    readonly message: string;
}
/**
 * Pick the progress band for an elapsed fraction.
 *
 * The boundaries are inclusive at the lower end: exactly a quarter elapsed is
 * the quarter checkpoint, not still "early". A reminder that fires one tick
 * after the mark would be a reminder about a moment that already passed.
 *
 * @param elapsed - fraction of the span consumed, 0–1.
 * @returns the stage name.
 */
export declare function stageFor(elapsed: number): ProgressStage;
/**
 * Which goal depths a span of this length should be checked at.
 *
 * The rule exists to stop the monitor from nagging: a two-year root goal with no
 * activity today is not stalled, and a three-day leaf goal with no activity
 * today probably is.
 *
 * @param spanDays - the goal's total span in days.
 * @returns the depths worth checking.
 */
export declare function depthsForSpan(spanDays: number): readonly number[];
/**
 * Evaluate every dated goal against the current time.
 *
 * @param goals - the confirmed tree.
 * @param options - current time and the last recorded movement per goal.
 * @param options.lastTouched - for each goal id, the timestamp of its most
 *   recent *aligned or exploratory activity*. Node edits are deliberately not
 *   included: setting a deadline is an edit, and treating it as progress would
 *   let a user silence a reminder by touching the goal.
 * @returns one finding per dated goal, plus the undated count for reporting.
 */
export declare function evaluateProgress(goals: readonly GoalNode[], options: {
    now: Date;
    lastTouched: ReadonlyMap<string, string>;
}): {
    findings: ProgressFinding[];
    undated: number;
};
/** A compact summary for reports. */
export interface ProgressSummary {
    /** Goals past due, worst first. */
    readonly overdue: ProgressFinding[];
    /** Goals whose reminder condition fired. */
    readonly remind: ProgressFinding[];
    /** How many active goals carry no deadline at all. */
    readonly undated: number;
}
