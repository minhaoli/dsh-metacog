/**
 * The second opinion on drift.
 *
 * A rule that fires on the string `pwsh (tool call)` is guessing. Rather than
 * teaching every rule to understand prose, the program keeps doing what it is
 * good at — cheap, deterministic, exhaustive screening — and a model looks only at
 * the candidates it produces, in one batch per review interval.
 *
 * Two consequences are deliberate:
 *
 * 1. **Nothing is published on a single rule hit.** A candidate becomes a signal
 *    only when the model agrees, which is what makes an hourly cadence honest
 *    instead of a delay before the same noise.
 * 2. **The model is told to prefer "not drift".** A missed drift costs one quiet
 *    hour; a false alarm costs the user's trust in the whole monitor.
 *
 * @module dsh-metacog/analysis/judgment
 */
import type { DriftSignalType, JudgmentRecord, TreeState } from '../data/types.js';
import type { MetacogConfig } from '../config.js';
import type { MetacogStore } from '../data/store.js';
import type { HostAgent, HostContext } from '../host.js';
import type { SignalDraft } from './drift.js';
/** Schema the model must satisfy. Single types only: the host rejects type arrays. */
export declare const JUDGMENT_JSON_SCHEMA: {
    readonly type: "object";
    readonly properties: {
        readonly verdicts: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                    };
                    readonly isDrift: {
                        readonly type: "boolean";
                    };
                    /**
                     * Which named rule the activity failed to satisfy.
                     *
                     * `reason` stays free-form for the human reading it; this field is the
                     * machine-readable half, so rejections can be counted by cause. A
                     * monitor that cannot say *why* it rejected something cannot learn
                     * from its own rejections.
                     */
                    readonly why: {
                        readonly type: "string";
                        readonly enum: readonly ["no-matching-goal", "missed-success-criteria", "outside-allowed-methods", "hit-excluded-activity", "contradicts-goal", "unclear"];
                    };
                    /** Concrete next step: what would make this activity serve a goal. */
                    readonly howToAdjust: {
                        readonly type: "string";
                    };
                    /** 0-1; below the configured floor the verdict is not acted on. */
                    readonly confidence: {
                        readonly type: "number";
                    };
                    readonly reason: {
                        readonly type: "string";
                    };
                };
                readonly required: readonly ["id", "isDrift", "why", "howToAdjust", "confidence", "reason"];
                readonly additionalProperties: false;
            };
        };
    };
    readonly required: readonly ["verdicts"];
    readonly additionalProperties: false;
};
/** Why a reviewer called an activity drift. Machine-readable so it can be counted. */
export type DriftWhy = 'no-matching-goal' | 'missed-success-criteria' | 'outside-allowed-methods' | 'hit-excluded-activity' | 'contradicts-goal' | 'unclear';
/** One candidate, reduced to what the reviewer needs. */
export interface JudgmentCandidate {
    readonly id: string;
    readonly signalType: string;
    readonly summary: string;
    readonly programReason: string;
}
/**
 * Build the review prompt.
 *
 * The goal tree is compressed to depth, title and success criteria: the reviewer
 * needs to know what the project is *for*, and the rest of the node (evidence,
 * timestamps) would only dilute that.
 *
 * @param state - the confirmed tree.
 * @param candidates - queued candidates, already capped by the caller.
 */
export declare function buildJudgmentPrompt(state: TreeState, candidates: readonly JudgmentCandidate[]): string;
/** What one review pass did. */
export interface ReviewOutcome {
    /** Candidates examined. */
    readonly reviewed: number;
    /** Candidates the model also called drift, now published as signals. */
    readonly confirmed: number;
    /** Candidates the model rejected. */
    readonly dismissed: number;
    /** Hints worth showing the user, including the log reminder. */
    readonly hints: string[];
    /** Present when the pass could not run. */
    readonly problem?: string;
}
/** Whether a draft may escalate without a model review. */
export type SignalPrecision = 'direct' | 'review';
/** Facts outside the draft that decide its precision (from the alignment verdict). */
export interface PrecisionContext {
    /** Set when the activity matched a goal's explicit `excludedActivities`. */
    readonly excludedByGoalId?: string;
}
/** One row of the precision table. First matching row wins. */
export interface SignalPrecisionRule {
    readonly id: string;
    readonly signalTypes: readonly DriftSignalType[];
    /** Why this rule does not need a second opinion. */
    readonly reason: string;
    /** Extra fact the draft must carry, when the signal type alone is not enough. */
    readonly requires?: (draft: SignalDraft, context: PrecisionContext) => boolean;
}
/**
 * Ordered precision table: the first row whose signal type matches decides.
 *
 * The bar for `direct` is "the fact is already in the record, so a model can
 * only add latency". Keyword guesses, single-tool-name mismatches and
 * contradiction-shift hints stay in `review` by falling through to the default.
 * A new rule belongs here, not in an `if` at a call site, so the answer to
 * "why does this rule not need review" is readable in one place.
 */
export declare const SIGNAL_PRECISION_RULES: readonly SignalPrecisionRule[];
/**
 * Decide one draft's precision.
 *
 * @param draft - rule draft from the detector sweep.
 * @param context - facts from the alignment verdict, when the draft came from one.
 * @param allowUnreviewed - explicit degradation: treat every draft as direct.
 * @returns `direct` only when a table row applies (or degradation is on).
 */
export declare function precisionOf(draft: SignalDraft, context?: PrecisionContext, allowUnreviewed?: boolean): SignalPrecision;
/**
 * Split a sweep's drafts into immediate signals and review candidates.
 *
 * @param drafts - detector output for one activity.
 * @param context - alignment facts that refine a rule's precision.
 * @param allowUnreviewed - explicit degradation switch.
 */
export declare function splitDraftsByPrecision(drafts: readonly SignalDraft[], context?: PrecisionContext, allowUnreviewed?: boolean): {
    direct: SignalDraft[];
    review: SignalDraft[];
};
/** Reason recorded on candidates dropped because the queue hit its cap. */
export declare const JUDGMENT_BACKLOG_DROP_REASON = "\u56E0\u590D\u6838\u4E0D\u53EF\u7528\u4E22\u5F03\u79EF\u538B\uFF08\u8D85\u8FC7\u4E0A\u9650\uFF09";
/**
 * Cap the pending queue, settling the oldest records as dropped.
 *
 * The queue is read on every review attempt, so trimming here covers both
 * "review is unavailable" and "review is slow": either way the cap holds and
 * the drop is recorded on the judgment record itself, which is the audit trail
 * this module already writes.
 *
 * @param store - project store.
 * @param projectId - owning project.
 * @param limit - maximum pending records; must be positive.
 * @param now - clock injection for the settled timestamp.
 * @returns how many were dropped and their ids.
 */
export declare function trimJudgmentBacklog(store: MetacogStore, projectId: string, limit: number, now?: Date): Promise<{
    dropped: number;
    ids: string[];
}>;
/** Options for {@link ReviewFailureNotifier}. */
export interface ReviewFailureNotifierOptions {
    readonly statePath: string;
    readonly remind: (message: string) => void;
    readonly now?: () => Date;
}
/**
 * Make a review outage visible once per reason, re-arming on recovery.
 *
 * Reuses M1's `RealtimeFailureReminder` (persisted suppression, clear-on-success)
 * instead of adding a second state machine. Only the wording is ours: the
 * reminder's own message names an internal reason key, which is not what a user
 * should see.
 */
export declare class ReviewFailureNotifier {
    #private;
    constructor(options: ReviewFailureNotifierOptions);
    /**
     * Record one failure.
     *
     * @param problem - the reason `reviewPendingJudgments` reported.
     * @returns a Chinese hint only when this reason has not been shown yet.
     */
    noteFailure(problem: string): string | undefined;
    /** Record one success so a later failure of any kind re-arms. */
    noteSuccess(): boolean;
    /** Reasons currently suppressed, for status output and tests. */
    get suppressedKeys(): readonly string[];
}
/**
 * Review queued candidates and publish the ones both sides call drift.
 *
 * @param options - host context, store, tree and configuration.
 */
export declare function reviewPendingJudgments(options: {
    readonly ctx: HostContext;
    readonly store: MetacogStore;
    readonly projectId: string;
    readonly state: TreeState;
    readonly config: MetacogConfig;
    readonly cwd?: string;
    readonly now?: Date;
    /** Agent to attribute the review child to; required outside a tool call. */
    readonly parent?: HostAgent;
}): Promise<ReviewOutcome>;
/**
 * Ask the user to read the judgement log once it is worth reading.
 *
 * The log is the only evidence of whether the rules are improving, so it is
 * surfaced periodically rather than kept for a programmer to find.
 *
 * The unit is *newly settled since the last reminder*, not *unread entries*. The
 * first version counted unread records, which meant every review batch pushed the
 * total back over the threshold and the same reminder repeated four times in one
 * command — the reminder was reporting its own backlog rather than new evidence.
 *
 * @param store - project store.
 * @param projectId - owning project.
 * @param config - thresholds.
 */
export declare function remindIfLogIsLong(store: MetacogStore, projectId: string, config: MetacogConfig): Promise<string[]>;
/** Build a queued candidate from one signal draft. */
export declare function judgmentFromDraft(projectId: string, draft: SignalDraft, summary: string, options?: {
    sampled?: boolean;
}): JudgmentRecord;
/** Stable fingerprint of a draft, used for deterministic bypass sampling. */
export declare function bypassSampleKey(draft: SignalDraft): string;
/**
 * Decide whether a bypassed draft also becomes a review sample.
 *
 * Deterministic on purpose: the same draft always samples the same way, so a
 * project's audit coverage is reproducible and a test cannot flake. `0` never
 * samples and `1` always does, without going through the hash.
 *
 * @param draft - the bypassed draft.
 * @param rate - configured sample rate, 0–1.
 */
export declare function isBypassSampled(draft: SignalDraft, rate: number): boolean;
/** Schema for the holistic look at a period of work. */
export declare const WINDOW_JSON_SCHEMA: {
    readonly type: "object";
    readonly properties: {
        readonly drifted: {
            readonly type: "boolean";
        };
        readonly reason: {
            readonly type: "string";
        };
        readonly suggestions: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
        };
    };
    readonly required: readonly ["drifted", "reason"];
    readonly additionalProperties: false;
};
/** What a window assessment concluded. */
export interface WindowAssessment {
    /** Whether the period as a whole looks off-target. */
    readonly drifted: boolean;
    /** Why, citing concrete activities. */
    readonly reason: string;
    /** Optional advice. Empty is a legitimate answer. */
    readonly suggestions: string[];
}
/** One activity as the reviewer sees it. */
export interface WindowActivity {
    readonly summary: string;
    readonly decision: string;
    readonly timestamp: string;
}
/**
 * Build the prompt for a holistic assessment of a period.
 *
 * Distinct from the per-candidate prompt: this one asks whether the *shape* of the
 * period is right, which no single rule can answer. Per-activity verdicts are
 * handed over as context, not as the question.
 *
 * @param state - confirmed tree.
 * @param activities - period activities, oldest first.
 */
export declare function buildWindowPrompt(state: TreeState, activities: readonly WindowActivity[]): string;
/**
 * Ask a model whether a period of work is on target.
 *
 * Used by the manual check command and by the periodic sweep when the rule queue
 * is quiet: rules only see single activities, and a period can go off-target
 * without any one activity looking wrong.
 *
 * @param options - host context, tree and the activities to judge.
 */
export declare function assessWindow(options: {
    readonly ctx: HostContext;
    readonly state: TreeState;
    readonly activities: readonly WindowActivity[];
    readonly cwd?: string;
    readonly label?: string;
    /** Agent to attribute the review child to; required outside a tool call. */
    readonly parent?: HostAgent;
}): Promise<{
    readonly status: 'ok';
    readonly assessment: WindowAssessment;
} | {
    readonly status: 'empty';
} | {
    readonly status: 'unavailable';
    readonly reason: string;
} | {
    readonly status: 'failed';
    readonly reason: string;
}>;
