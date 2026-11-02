/**
 * Stage F: the periodic drift sweep.
 *
 * Verified host contract (2026-10-27, `cordis_inspect_query` host `Service`
 * provider): the recurring primitive is `ctx.timer.interval(callback, delay)`,
 * which returns a disposer and is bound to the plugin's fiber. `ctx.jobs` is
 * *not* a general scheduler — its `JobKindMap` holds only `'bash'` and each job
 * needs an owner plus an attached controller, so it models a one-shot background
 * command's output ring, not a periodic pulse. `ctx.schedule` does fire on a
 * schedule but its semantics are "deliver a prompt into a Session", which wakes
 * the user; that is opt-in and off by default.
 *
 * Because the sweep runs on a timer with no conversation attached, everything
 * it produces is Grade C by construction: it may run the static
 * checks and it may *hint*, but it may never invent an activity or open a card.
 * `runStaticCheck` already enforces that with `mayEscalate: false`.
 *
 * **The sweep never touches the goal tree.** Initialisation and monitoring are
 * separate phases: the tree is derived once, confirmed by the user, and then
 * held fixed as the yardstick for judging alignment. A timer that re-derived it
 * whenever documents changed would invalidate every past judgement, because an
 * activity recorded as advancing goal T3 would refer to a goal that no longer
 * exists. Changes come only from the user, through `metacog_revise`.
 *
 * @module dsh-metacog/schedule
 */
import type { Disposer, HostContext } from './host.js';
import type { MetacogConfig } from './config.js';
import type { MetacogStore } from './data/store.js';
import type { TreeState } from './data/types.js';
import { RealtimeFailureReminder, type LlmServiceLike, type RunVerdictOptions, type VerdictInput, type VerdictResult } from './analysis/verdict.js';
/** One project the sweep knows how to check. */ export interface MonitoredProject {
    readonly projectId: string;
    readonly store: MetacogStore;
    readonly projectRoot: string;
}
/** How a single sweep went, for the mount's diagnostics. */
export interface SweepResult {
    readonly projectId: string;
    readonly signals: number;
    readonly hints: string[];
}
/** Aggregate stats the mount can log and tests can assert on. */
export interface SchedulerStats {
    /** Number of ticks that actually ran a sweep. */
    ticks: number;
    /** Projects checked across all ticks. */
    checks: number;
    /** Signals appended across all ticks. */
    signals: number;
    /** Ticks skipped because no project was registered yet. */
    idle: number;
    /** Errors contained during a sweep. */
    errors: number;
    /** Reports generated automatically across all ticks. */
    autoReports: number;
    /** Whether the timer is currently installed. */
    running: boolean;
}
/** A cadence the scheduler may generate on its own. */
export type AutoReportType = 'daily' | 'weekly' | 'monthly';
/** Everything the scheduler needs from the mount. */
export interface SchedulerOptions {
    readonly ctx: HostContext;
    readonly config: MetacogConfig;
    /** Enumerate the projects worth checking on each tick. */
    readonly projects: () => Promise<readonly MonitoredProject[]>;
    /** Collect hints for the prompt layer (called with this tick's output). */
    readonly onHints?: (hints: readonly string[], result: readonly SweepResult[]) => void;
    /**
     * Second-opinion pass over queued drift candidates.
     *
     * Runs on the same tick as the static check: the queue only grows between ticks,
     * so this is its natural cadence. Returning hints is how a judgement log that has
     * grown worth reading reaches the user.
     */
    readonly review?: (project: MonitoredProject, state: TreeState) => Promise<readonly string[]>;
    /**
     * Generate one report covering every monitored workspace.
     *
     * Injected rather than imported so the scheduler keeps no dependency on the
     * report builder: `report.ts` is a large module and the scheduler's job is
     * timing, not prose. It also keeps this file testable without a tree.
     *
     * `readExisting` is what the scheduler deduplicates against. It lives on the
     * same object because the records are written by the same sink: asking any
     * single project's store would miss reports written for the whole set.
     */
    readonly report?: {
        readonly readExisting: () => Promise<readonly {
            type: string;
            periodEnd: string;
        }[]>;
        /**
         * @param type - cadence to generate.
         * @param at - the instant the report should treat as "now", i.e. the end of
         *   the period being written. Defaults to the wall clock for a manual run.
         */
        readonly generate: (type: AutoReportType, at?: Date) => Promise<void>;
    };
    /** Clock injection for tests. */
    readonly now?: () => Date;
}
/**
 * Install the periodic sweep.
 *
 * The timer is created lazily on install and disposed through the returned
 * disposer, which `mount.claim` owns. A configuration with `schedule.enabled`
 * false installs nothing at all — not an inert timer — so the honest report is
 * "no timer was created" rather than "a timer exists and does nothing".
 *
 * @param options - mount context, policy and project source.
 * @returns stats plus the disposer (a no-op when disabled).
 */
export declare function installScheduler(options: SchedulerOptions): {
    stats: SchedulerStats;
    dispose: Disposer;
    /** Run one sweep immediately, as `schedule`-less tests and tools do. */
    sweep: () => Promise<SweepResult[]>;
};
/**
 * Describe the scheduling capability boundary for the API table and logs.
 *
 * @param available - whether the host exposed `ctx.timer.interval`.
 * @param enabled - whether the configuration asked for periodic checks.
 */
export declare function schedulerBoundary(available: boolean, enabled: boolean): string;
/** One project's outcome in one realtime tick. */
export interface RealtimeTickResult {
    readonly projectId: string;
    readonly status: 'verdict' | 'idle' | 'failed' | 'skipped';
    readonly match?: number;
    readonly hints: readonly string[];
}
/** Aggregate stats the realtime mount can log and tests can assert on. */
export interface RealtimeSchedulerStats {
    /** Timer callbacks that fired. */
    ticks: number;
    /** Projects that had a non-empty window and reached the verdict call. */
    checks: number;
    /** Verdict records written. */
    verdicts: number;
    /** Empty windows (or a verdict `idle`) that made no model call. */
    idle: number;
    /** Hints emitted (low match or failure reminders). */
    hints: number;
    /** Contained errors across ticks. */
    errors: number;
    /** Whether the timer is currently installed. */
    running: boolean;
}
/** Everything the realtime scheduler needs from the mount. */
export interface RealtimeSchedulerOptions {
    readonly ctx: HostContext;
    readonly config: MetacogConfig;
    readonly projects: () => Promise<readonly MonitoredProject[]>;
    /** Host `llm` service; `ctx.get('llm')` is used when omitted. */
    readonly llm?: LlmServiceLike;
    /** Resolve the global model when `realtime.provider/model` are empty. */
    readonly defaultModel?: () => {
        provider?: string;
        model?: string;
    } | undefined;
    /** Where hints reach the prompt cache. Quiet mode filters before this call. */
    readonly onHints?: (hints: readonly string[]) => void;
    /** Per-project reminder state; the default persists under the project's storage. */
    readonly reminderFor?: (project: MonitoredProject) => RealtimeFailureReminder;
    /** Verdict runner, injectable so tests do not need a live model. */
    readonly runVerdict?: (input: VerdictInput, options: RunVerdictOptions) => Promise<VerdictResult>;
    /** Clock injection for tests. */
    readonly now?: () => Date;
    /** Timer injection for tests; defaults to `ctx.get('timer')`. */
    readonly timer?: {
        interval(callback: () => void, delayMs: number): Disposer;
    };
}
/**
 * One Chinese hint for a low realtime match.
 *
 * The action is written before the model's reason on purpose: `clampHint` cuts
 * the tail, and a hint whose action was cut is no longer actionable. `match`
 * is only passed here when it is a real number; a vague goal reports `null` and
 * is explained by the verdict layer's own hint instead of a fabricated score.
 *
 * @param match - realtime match score, 0–1.
 * @param goalLabel - goal title or id the verdict named, when known.
 * @param reason - the model's short reason for the low match.
 * @returns a clamped, actionable Chinese line.
 */
export declare function realtimeHint(match: number, goalLabel: string | undefined, reason: string): string;
/**
 * Install the independent 5-minute realtime verdict timer.
 *
 * Runs beside the 25-minute sweep, not inside it: the two have different
 * cadences, different windows and different failure semantics, and sharing a
 * tick would make the slower one either miss windows or repeat them. They
 * share only the project set and the prompt-cache hint channel.
 *
 * The window is "since the last realtime checkpoint", stored separately from
 * the report checkpoint. On an empty window the checkpoint still advances (so
 * the next tick starts from here) but no model is called and no verdict is
 * recorded. On failure the checkpoint deliberately does not advance: the same
 * activities are retried next tick.
 *
 * @param options - mount context, project source, model route and sinks.
 * @returns stats, the disposer, and a `tick` a test can drive directly.
 */
export declare function installRealtimeScheduler(options: RealtimeSchedulerOptions): {
    stats: RealtimeSchedulerStats;
    dispose: Disposer;
    tick: () => Promise<RealtimeTickResult[]>;
};
