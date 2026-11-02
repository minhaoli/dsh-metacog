import type { GeneratedReport, InterventionRecord, TreeState } from './data/types.js';
import type { DeclaredPlan } from './data/signals.js';
import type { MetacogStore } from './data/store.js';
import type { MetacogConfig } from './config.js';
/** Report cadence and the period each covers. */
export type ReportType = 'daily' | 'weekly' | 'monthly';
/** Everything a report generation reads. */
export interface ReportInput {
    readonly store: MetacogStore;
    readonly state: TreeState;
    readonly projectId: string;
    readonly config: MetacogConfig;
    readonly type: ReportType;
    /** End of the period; defaults to now. */
    readonly now?: Date;
    /**
     * Fold completed subtrees in the goal section. Defaults to false.
     *
     * A report is a later look rather than the first one, so folding is allowed
     * here — but it is never the default: a section that shows only one line per
     * finished branch hides how much work it stood for, and the user asked to see
     * every goal before any folding happens.
     */
    readonly collapseDone?: boolean;
}
/**
 * Prose budget per cadence, in characters.
 *
 * "Prose" counts every non-whitespace character outside a heading line: the
 * `#` structure and the blank lines between blocks are navigation, not content.
 * Bullets and punctuation do count, which errs on the strict side — the right
 * direction for a cap.
 */
export declare const REPORT_CHAR_LIMITS: Readonly<Record<ReportType, number>>;
/**
 * Count the prose characters in a report.
 *
 * Heading lines are excluded because they are the fixed skeleton, and the
 * marker the truncation path appends does count, so the published number is
 * never larger than the budget.
 *
 * @param markdown - full report body.
 * @returns non-whitespace characters outside heading lines.
 */
export declare function countReportChars(markdown: string): number;
/**
 * Where a report's Markdown copy lives.
 *
 * Layout, one directory per cadence and one file per period inside it:
 *
 * ```
 * reports/markdown/
 *   日报/2026_10/2026-10-30.md
 *   周报/2026_Q4/2026-10-30.md
 *   月报/2026/2026-10.md
 * ```
 *
 * The bucket directories are what make the tree navigable a year in: a flat
 * directory of one file per period becomes unusable long before it becomes
 * interesting, and "which month was that?" is the only question anyone asks of
 * it. Quarters rather than months for the weekly cadence, because a week can
 * straddle a month boundary and a bucket named after neither month is worse than
 * one named after both.
 *
 * @param storageRoot - the project's `.metacog` directory.
 * @param type - report cadence.
 * @param at - the instant the period ends; decides the bucket and the filename.
 */
export declare function reportMarkdownPath(storageRoot: string, type: ReportType, at: Date): string;
/** The directory of one cadence, for the "open folder" action. */
export declare function reportCadenceDir(storageRoot: string, type: ReportType): string;
/**
 * Every workspace that should appear in a cross-workspace report.
 *
 * A monitor that only sees the conversation you happen to have open is blind to
 * the other half of your week. The user asked for one report covering everything
 * that has a tree, so the period's facts are gathered from all of them and merged
 * into a single synthetic view.
 */
export interface WorkspaceSource {
    readonly store: MetacogStore;
    readonly state: TreeState;
    readonly projectId: string;
}
/**
 * Generate one report covering every workspace at once.
 *
 * The merge is deliberately shallow: goals and contradictions are concatenated,
 * and every stream is concatenated before the period filter runs. That is enough
 * because the renderers only ever look up a goal by id, count nodes by status,
 * and iterate activities — none of them assume a single root. Inventing a deeper
 * merge (deduplicating same-titled goals across workspaces, say) would be a
 * judgement call the user never asked for, and would silently drop a goal that
 * legitimately exists twice.
 *
 * Ids are unique per workspace already: a goal id embeds a hash of its project
 * root, so two workspaces cannot collide.
 *
 * @param input - the workspaces to merge, plus cadence and configuration.
 * @returns the stored report, bound to the merged tree version.
 */
export declare function generateWorkspaceReport(input: {
    readonly workspaces: readonly WorkspaceSource[];
    readonly config: MetacogConfig;
    readonly type: ReportType;
    readonly now?: Date;
    /** Where the JSONL record and the Markdown copy are written. */
    readonly targetStore: MetacogStore;
    /** Id the record is filed under; the global sink uses a fixed one. */
    readonly targetProjectId: string;
}): Promise<GeneratedReport>;
/**
 * Generate and persist one report.
 *
 * The stored record is the source of truth; the Markdown copy is a convenience
 * beside it.
 *
 * @param input - store, tree, cadence and configuration.
 * @returns the stored report, bound to the tree version it read.
 */
export declare function generateReport(input: ReportInput): Promise<GeneratedReport>;
/**
 * Render the compact prompt block (spec 6 Stage G item 2).
 *
 * Deliberately small: the decision rule for core-versus-main, the active top
 * level of the tree, and whatever is currently pending. The full tree never
 * appears here — a monitor that costs a thousand tokens per turn is one the
 * user turns off.
 *
 * @param state - current tree, or `undefined` when the project has none.
 * @param pending - pending interventions.
 * @param hints - Level 1 hints from the latest check.
 * @param config - configuration, for the thresholds quoted in the rule line.
 * @param plan - the session's declared plan, when one is in force.
 */
export declare function renderPromptBlock(state: TreeState | undefined, pending: readonly InterventionRecord[], hints: readonly string[], config: MetacogConfig, plan?: DeclaredPlan): string;
