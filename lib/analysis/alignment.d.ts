/**
 * Activity-to-goal alignment judgement.
 *
 * The judgement is deliberately deterministic and conservative. The model may
 * describe an activity in words, but this module decides what it means, and it
 * refuses to conclude `scope_drift` from anything short of Grade A evidence
 * that fails every registered rule.
 *
 * The rule order matters and follows the spec exactly:
 *
 * 1. grade gate — Grade C has no activity signal at all, Grade B is capped;
 * 2. global whitelist — a registered activity is never drift;
 * 3. path ownership — a touched path that a goal declared as its own is
 *    positive attribution: the user has already decided that work under that
 *    prefix serves the goal;
 * 4. explicit exclusion — a goal's `excludedActivities` is positive evidence of
 *    over-engineering, but still only Grade A may act on it;
 * 5. registered exploration — a goal's `alignment.relevantActivities` /
 *    `allowedMethods` covers planned reading, dependency work and experiments;
 * 6. fallback — no match with enough confidence is `uncertain`, never drift;
 *    an activity whose touched paths no goal claims is `unbound`, which is a
 *    verdict of its own rather than a weaker form of drift.
 *
 * Path ownership outranks exclusion because the two rest on different evidence.
 * A path claim is a declaration about the tree — "this directory is this goal's"
 * — matched against a file the activity demonstrably touched; an exclusion is a
 * keyword matched against prose. When the user's own declaration and a keyword
 * disagree, the declaration is the more specific statement, and demoting it
 * would let a substring veto work the user explicitly placed.
 *
 * `successCriteria` is consulted only as corroboration for a matched goal. It
 * is deliberately NOT the drift yardstick: daily dependency work rarely reads
 * like a completion criterion, and treating it as the yardstick is exactly how
 * a monitor cries wolf.
 *
 * @module dsh-metacog/analysis/alignment
 */
import type { ActivitySource, AlignmentDecision, GoalNode, ObservationGrade } from '../data/types.js';
import type { MetacogConfig, WhitelistEntry } from '../config.js';
import { type PathBindingReport } from './paths.js';
/** Everything the judge needs to know about one activity. */
export interface ActivityInput {
    /** Free-text description of what happened. */
    summary: string;
    /** Verifiable support: paths, symbols, test results, commits. */
    evidence: string[];
    /** How the activity reached the plugin. */
    source: ActivitySource;
    /** Tool name, when the activity came from a tool call. */
    toolName?: string;
    /** Evidence grade established by the caller from real context. */
    grade: ObservationGrade;
    /**
     * File paths the activity touched, as recorded by the tool that touched them.
     *
     * Optional because most activities have none: a conversation turn, a
     * contradiction observation or a manual report carries no file of its own, and
     * an activity without paths must be judged exactly as it was before path
     * ownership existed. Entries that normalize to nothing are ignored rather than
     * counted as an unclaimed path.
     */
    paths?: string[];
}
/** The verdict for one activity. */
export interface AlignmentVerdict {
    /**
     * `aligned` | `exploratory` | `scope_drift` | `uncertain` | `unbound`.
     *
     * This used to be a separate `JudgementDecision` union, because the record's
     * enum had only four members and an unbound outcome had to be stored under
     * `uncertain`. The record carries the fifth value now, so the judge and the
     * store speak one vocabulary and the alias is gone: a reader of the persisted
     * data can tell "I could not place this" from "I could not decide".
     */
    decision: AlignmentDecision;
    /** Goals this activity plausibly serves (may be empty for drift). */
    candidateGoalIds: string[];
    /** 0–1 confidence in the decision, after grade capping. */
    confidence: number;
    /**
     * One or two Chinese lines for the person reading this verdict.
     *
     * Says what happened, why it matters and what can be done next — the three
     * things `rationale` deliberately does not: that one names the rule and the
     * threshold for the audit trail, and is not shown to the user as a hint.
     */
    hint: string;
    /** One-paragraph justification naming the rule that fired. */
    rationale: string;
    /** Goal whose `excludedActivities` matched, when that rule fired. */
    excludedByGoalId?: string;
    /** Whitelist entry that matched, when that rule fired. */
    whitelistLabel?: string;
    /** Goal that claimed the activity, by path ownership or by a registered rule. */
    matchedGoalId?: string;
    /**
     * How the touched paths were placed on the tree.
     *
     * Present exactly when the activity carried file paths. `kind: 'unbound'` is
     * the positive statement "no goal claims any of these", which is what makes the
     * verdict `unbound` instead of drift; `unboundPaths` reports the remainder of a
     * partially claimed activity without that remainder ever being called drift.
     */
    pathBinding?: PathBindingReport;
}
/**
 * Find the whitelist entry covering an activity.
 *
 * @param input - the activity.
 * @param entries - configured whitelist.
 * @returns the matching entry, if any.
 */
export declare function matchWhitelist(input: ActivityInput, entries: readonly WhitelistEntry[]): WhitelistEntry | undefined;
/**
 * Judge one activity against the confirmed goal tree.
 *
 * @param input - the activity.
 * @param goals - full goal list; unconfirmed and terminal goals are ignored.
 * @param config - resolved plugin configuration.
 * @returns the verdict, with confidence already capped by grade.
 */
export declare function judgeAlignment(input: ActivityInput, goals: readonly GoalNode[], config: MetacogConfig): AlignmentVerdict;
/**
 * Confidence ceiling implied by an observation grade.
 *
 * @param grade - A, B or C.
 * @param config - configuration carrying the Grade B cap.
 * @returns the ceiling in 0–1.
 */
export declare function gradeConfidenceCap(grade: ObservationGrade, config: MetacogConfig): number;
/**
 * Whether a verdict may feed the escalation counters.
 *
 * Grade B findings are advisory: they may be recorded and shown, but they must
 * never open a Level 2 or Level 3 intervention.
 *
 * @param grade - the grade the activity was observed at.
 * @param config - configuration carrying the observation policy.
 */
export declare function mayEscalate(grade: ObservationGrade, _config: MetacogConfig): boolean;
