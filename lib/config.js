/**
 * Plugin configuration: every tunable the drift analyser, the escalation state
 * machine and the schedulers read, with defaults that satisfy the spec.
 *
 * The config arrives as the `config` field of this plugin's row in the profile
 * `cordis.patch.yml`, deep-merged by the loader. Unknown keys are stripped
 * rather than rejected (a stale profile patch must not brick startup), but a
 * *known* key with an invalid value is a hard error: silently running with a
 * nonsense threshold would corrupt escalation decisions.
 *
 * @module dsh-metacog/config
 */
import { z } from 'zod';
/**
 * Confidence floor for an activity to count toward drift at all. Below it the
 * analyser must answer `uncertain` instead of guessing (spec 4.2 step 4).
 */
const DEFAULT_MIN_CONFIDENCE = 0.6;
/** Intensity at or above this counts as "high" for `core_bypass`. */
const DEFAULT_HIGH_INTENSITY = 4;
/** Days without new evidence before an active L1/L2 goal is stale. */
const DEFAULT_STALE_DAYS = 7;
/** How often queued drift candidates are sent to a model for a second opinion. */
const DEFAULT_REVIEW_INTERVAL_MINUTES = 60;
/** Candidates that trigger a review even before the interval elapses. */
const DEFAULT_REVIEW_BATCH_SIZE = 12;
/** Judgement-log entries before the user is asked to read the log. */
const DEFAULT_JUDGMENT_LOG_THRESHOLD = 30;
/** Sliding window for repeat counting and observation trends, in minutes. */
const DEFAULT_WINDOW_MINUTES = 120;
/** Same-class high-confidence misaligned activities needed for Level 2. */
const DEFAULT_REPEAT_THRESHOLD = 3;
/** Pending candidates allowed before the oldest are dropped as a backlog. */
const DEFAULT_JUDGMENT_BACKLOG_LIMIT = 200;
/**
 * Target latency for a high-confidence drift, in minutes.
 *
 * This is a scheduling promise, not a sensitivity knob: high-precision rules
 * bypass the review queue entirely (see `analysis/judgment.ts`), so the target
 * is met by the direct path rather than by loosening a threshold. A
 * low-precision candidate is not covered by this number; it waits for review,
 * whose worst case is `thresholds.reviewIntervalMinutes`.
 */
const DEFAULT_MAX_LATENCY_MINUTES = 10;
/**
 * Default strength of a cross-goal link that carries no explicit weight.
 *
 * Half rather than 1: a goal the tension merely constrains should not be
 * burdened as if the tension were its own. It is a config value, not a
 * constant, because the same stored tree must be re-readable under a different
 * weighting policy without rewriting every node.
 */
const DEFAULT_RELATED_WEIGHT = 0.5;
/** Periodic in-process drift check interval, in minutes (spec Stage F). */
const DEFAULT_CHECK_INTERVAL_MINUTES = 25;
/** Realtime bare-LLM verdict cadence, in minutes (stage M1). */
const DEFAULT_REALTIME_INTERVAL_MINUTES = 5;
/** Default ceiling for the realtime verdict prompt, in estimated tokens. */
const DEFAULT_REALTIME_MAX_INPUT_TOKENS = 1000;
/** Default wall-clock ceiling for one realtime verdict call. */
const DEFAULT_REALTIME_TIMEOUT_MS = 20_000;
const positiveInt = (fallback) => z.number().int().positive().default(fallback);
const unitInterval = (fallback) => z.number().min(0).max(1).default(fallback);
/**
 * One entry of the global activity whitelist. Entries match either by
 * substring against the activity summary (case-insensitive) or by exact tool
 * name, so a user can register both "读论文" and `web_search`.
 */
export const WhitelistEntrySchema = z.object({
    /** Human-readable label, echoed back in rationales and reports. */
    label: z.string().min(1),
    /** Case-insensitive substrings matched against the activity summary. */
    summaryContains: z.array(z.string().min(1)).default([]),
    /** Exact tool names always treated as aligned/exploratory. */
    toolNames: z.array(z.string().min(1)).default([]),
});
/** Escalation and drift-detection tunables. */
export const ThresholdsSchema = z.object({
    /** Sliding window for repeat counting and trend computation. */
    windowMinutes: positiveInt(DEFAULT_WINDOW_MINUTES),
    /** Same-class high-confidence misaligned activities needed for Level 2. */
    repeatThreshold: positiveInt(DEFAULT_REPEAT_THRESHOLD),
    /** Confidence floor; below it the verdict degrades to `uncertain`. */
    minConfidence: unitInterval(DEFAULT_MIN_CONFIDENCE),
    /** Contradiction intensity counted as "high" for `core_bypass`. */
    highIntensityThreshold: z.number().int().min(1).max(5).default(DEFAULT_HIGH_INTENSITY),
    /** Days without new evidence before an active L1/L2 goal is stale. */
    staleDaysThreshold: positiveInt(DEFAULT_STALE_DAYS),
    /**
     * Minimum gap between model reviews of queued drift candidates.
     *
     * The model is not consulted once per activity: judging a single tool call is
     * both expensive and blind to what the surrounding hour was about.
     */
    reviewIntervalMinutes: positiveInt(DEFAULT_REVIEW_INTERVAL_MINUTES),
    /** Pending candidates that force a review before the interval elapses. */
    reviewBatchSize: positiveInt(DEFAULT_REVIEW_BATCH_SIZE),
    /** Judgement-log entries before the user is asked to read it. */
    judgmentLogThreshold: positiveInt(DEFAULT_JUDGMENT_LOG_THRESHOLD),
});
/** Periodic scheduling tunables (spec Stage F). */
export const ScheduleSchema = z.object({
    /** Master switch for the in-process periodic drift check. */
    enabled: z.boolean().default(true),
    /** Interval between in-process checks, in minutes. */
    checkIntervalMinutes: positiveInt(DEFAULT_CHECK_INTERVAL_MINUTES),
    /**
     * Generate a report automatically when a cadence has elapsed.
     *
     * On by default. Reports are the surface this whole design exists to fill: a
     * monitor whose only output appears when you remember to press a button is one
     * you stop reading. The cost of being wrong is one write per period, and since
     * a report is appended to its own file rather than multiplied into a new one,
     * leaving it on cannot flood the directory.
     *
     * It stays a separate switch from `enabled` because the two answer different
     * questions: `enabled` is "is this plugin running", this is "does it write a
     * summary on its own".
     */
    autoReport: z.boolean().default(true),
    /**
     * Which cadences to generate automatically.
     *
     * A list rather than one flag per cadence: a user who wants a weekly summary
     * does not want three switches, and the set is closed (`daily` / `weekly` /
     * `monthly`). An empty list with `autoReport: true` generates nothing, which is
     * an honest "switched on but disabled" rather than a silent default.
     */
    autoReportTypes: z.array(z.enum(['daily', 'weekly', 'monthly'])).default(['daily', 'weekly']),
});
/** Live collection tunables (spec Stage E). */
export const CollectionSchema = z.object({
    /** Whether `session/event` is turned into activity records at all. */
    enabled: z.boolean().default(true),
    /**
     * Maximum characters kept from a user message. Long prompts are truncated
     * rather than stored whole: the record is an activity summary, and the full
     * transcript already lives in the session log.
     */
    summaryMaxChars: z.number().int().positive().default(240),
});
/**
 * Realtime bare-LLM verdict channel.
 *
 * Off by default: this is a second, independent judgement that costs a model
 * call every few minutes, so it is a choice the user makes rather than a
 * default the monitor imposes. `provider` / `model` empty means "follow the
 * harness's global selection"; resolving that belongs to the caller, because
 * the verdict module deliberately does not read global model state.
 */
export const RealtimeSchema = z.object({
    /** Master switch for the periodic bare-LLM verdict. */
    enabled: z.boolean().default(false),
    /** Provider route; empty follows the global model selection. */
    provider: z.string().default(''),
    /** Model id; empty follows the global model selection. */
    model: z.string().default(''),
    /** How often the verdict runs, in minutes. */
    intervalMinutes: positiveInt(DEFAULT_REALTIME_INTERVAL_MINUTES),
    /** Hard ceiling for the rendered prompt, in estimated tokens. */
    maxInputTokens: positiveInt(DEFAULT_REALTIME_MAX_INPUT_TOKENS),
    /** Wall-clock ceiling for one call, in milliseconds. */
    timeoutMs: positiveInt(DEFAULT_REALTIME_TIMEOUT_MS),
    /**
     * `match` below this earns one immediate low-score hint.
     *
     * Deliberately its own knob rather than `thresholds.thetaHintScore`: the two
     * score different things (a model's holistic match vs. the rule layer's
     * aggregate), and sharing a number would silently couple the two chains.
     */
    hintThreshold: unitInterval(0.5),
});
/**
 * v4 signal tunables.
 *
 * Weights live in `data/signals.ts` as constants rather than here: they are part
 * of the aggregation contract, and a weight that can be edited in a profile file
 * is a contract that can silently change between two runs of the same test.
 * What is configurable is the tuning that legitimately differs per deployment.
 */
export const SignalsSchema = z.object({
    /** EMA weight of the newest step. 0.4 keeps a single-step burst below the hint threshold. */
    emaBeta: z.number().min(0).max(1).default(0.4),
    /** `final` at or above which a hint is shown. Not a probability. */
    thetaHintScore: z.number().min(0).max(1).default(0.5),
    /** `final` at or above which an intervention card opens. Not a probability. */
    thetaCardScore: z.number().min(0).max(1).default(0.875),
    /** Consecutive steps at or above `thetaCardScore` before the card opens. */
    consecutiveStepsForCard: z.number().int().min(1).default(3),
    /** Minimum coverage for any escalation; admits 0.50, rejects 0.25. */
    coverageFloor: z.number().min(0).max(1).default(0.4),
});
/**
 * Automatic-review degradation policy.
 *
 * The review queue exists because a rule hit is not a finding: a keyword guess
 * or a single tool-name mismatch is worth a second opinion. Two things must not
 * follow from that: a high-confidence structural rule waiting an hour for a
 * model, and a review outage becoming invisible. The first is solved by the
 * precision table in `analysis/judgment.ts` (high-precision rules bypass this
 * queue); the fields here bound the second.
 */
export const JudgmentSchema = z.object({
    /**
     * Allow low-precision candidates to bypass review and escalate directly.
     *
     * Off by default: "unreviewed work never opens a card" is the conservative
     * position, and turning it on is an explicit choice to trade false positives
     * for immediacy. The mode is shown in the prompt block either way.
     */
    allowUnreviewedEscalation: z.boolean().default(false),
    /**
     * Pending candidates allowed to accumulate while review is unavailable.
     *
     * Beyond this the oldest are settled as dropped, with the reason recorded on
     * the judgment record, so an outage cannot grow an unbounded queue that floods
     * the user when review comes back.
     */
    backlogLimit: positiveInt(DEFAULT_JUDGMENT_BACKLOG_LIMIT),
    /**
     * Target for "a high-confidence drift is visible within this many minutes".
     *
     * Kept as configuration so the promise is inspectable and testable; the
     * direct path is what makes it true. `thresholds.reviewIntervalMinutes` and
     * the sweep interval are deliberately not lowered to meet it: changing cadence
     * changes cost and report windows, while bypassing the queue for facts does not.
     */
    maxLatencyMinutes: positiveInt(DEFAULT_MAX_LATENCY_MINUTES),
    /**
     * Fraction of bypassed drafts that also get a review candidate.
     *
     * Zero by default: sampling adds model calls, and turning it on silently
     * would spend the user's budget without asking. It is the only way a bypassed
     * rule ever produces a labelled sample, so an operator who wants the audit to
     * cover high-precision rules turns it up deliberately. Selection is
     * deterministic (hash of the draft fingerprint), never random.
     */
    bypassSampleRate: z.number().min(0).max(1).default(0),
});
/** Level 3 enforcement tunables (spec 4.4 item 4). */ export const GateSchema = z.object({
    /**
     * Whether a pending Level 3 card actually denies non-read-only tool calls.
     *
     * Off by default, and deliberately so: the gate blocks the very edits a user
     * needs in order to *act* on the decision it is asking for. Turning this on
     * is a choice to be interrupted, not a default a monitor should impose.
     */
    level3HardBlock: z.boolean().default(false),
    /**
     * Tools the gate never blocks, regardless of level.
     *
     * Read-only inspection plus the monitor's own decision tools: a user must
     * always be able to look around and to resolve the card that is blocking them.
     */
    neverBlocked: z
        .array(z.string().min(1))
        .default([
        'goal_tree_view',
        'check_drift',
        'resolve_intervention',
        'contradiction_observe',
        'generate_report',
        'ask_user_question',
        'read',
        'glob',
        'grep',
        'session_list',
        'job_list',
        'job_output',
        'schedule_list',
        'list_agents',
        'todo_write',
    ]),
});
/**
 * Silent mode.
 *
 * The monitor's most likely failure is not being wrong — it is being ignored. A
 * card that interrupts work to report a suspicion nobody has validated gets the
 * whole plugin switched off, and then it watches nothing at all. So "keep
 * recording, stop interrupting" has to be a supported mode rather than a set of
 * thresholds turned up until the noise happens to stop.
 *
 * What it does *not* do is stop judging. Collection, scoring and persistence all
 * run unchanged; only the surfaces that reach the user go quiet. That distinction
 * is the point: the data has to keep accumulating, because the only way this ever
 * gets validated is against a history of real judgements.
 */
export const QuietSchema = z.object({
    /** Suppress in-conversation hints and intervention cards. */
    enabled: z.boolean().default(false),
    /**
     * Whether Level 3 still blocks tool calls while quiet.
     *
     * Defaults to true: what goes quiet is the *asking*, not the protection. A hard
     * gate exists to stop something irreversible, and staying silent about it while
     * letting it through would be the worst of both.
     */
    keepHardBlock: z.boolean().default(true),
    /**
     * Whether the per-turn prompt block is suppressed too.
     *
     * Off by default, so that "quiet" means no interruptions rather than no
     * information: the block is passive context the model reads, not a card the user
     * has to dismiss.
     */
    suppressPromptBlock: z.boolean().default(false),
});
/**
 * Contradiction-tree weighting.
 *
 * A tension has one primary goal, which always weighs 1 by definition, and any
 * number of related goals, each pressing with its own strength. What is
 * configurable here is the *fallback*: the weight a related link gets when the
 * node carries no explicit one. That is what makes an old node — one that only
 * records `relatedGoalIds` — re-readable under a new weighting policy without
 * rewriting every node, and it is why the default lives in config rather than
 * in the calculation.
 */
export const ContradictionsSchema = z.object({
    /** Weight a related goal gets when the node carries no explicit weight. */
    defaultRelatedWeight: unitInterval(DEFAULT_RELATED_WEIGHT),
    /**
     * Whether a node may carry its own per-link weights.
     *
     * On by default. Turning it off makes the project-wide default authoritative,
     * so every goal is burdened by the same policy rather than by how each node
     * happened to be written.
     */
    allowNodeOverride: z.boolean().default(true),
});
export const ConfigSchema = z.object({
    /** Master switch; when false `apply` returns after registering nothing. */
    enabled: z.boolean().default(true),
    /** Sampling grade ceiling this deployment permits. */
    observationPolicy: z
        .object({
        /** Cap applied to Grade B findings so they cannot trigger Level 2/3. */
        gradeBMaxConfidence: unitInterval(0.5),
        /** Whether Grade C triggers may only run the static staleness check. */
        gradeCStaticOnly: z.boolean().default(true),
    })
        .prefault({}),
    /** Drift thresholds and escalation parameters. */
    thresholds: ThresholdsSchema.prefault({}),
    /** Global activity whitelist; matches bypass drift escalation entirely. */
    whitelistedActivities: z.array(WhitelistEntrySchema).default([]),
    /** Relative directory (under the project root) holding persisted state. */
    storageSubdir: z.string().min(1).default('.metacog'),
    /** Periodic check / reminder configuration. */
    schedule: ScheduleSchema.prefault({}),
    /** Live session-event collection (Stage E). */
    collection: CollectionSchema.prefault({}),
    /** Periodic bare-LLM verdict over the recent window (stage M1). */
    realtime: RealtimeSchema.prefault({}),
    /** v4 signal scoring tunables. */
    signals: SignalsSchema.prefault({}),
    /** Automatic-review degradation policy (bypass, backlog, latency target). */
    judgment: JudgmentSchema.prefault({}),
    /** Level 3 hard-gate configuration (spec 4.4 item 4). */
    gate: GateSchema.prefault({}),
    /** Silent mode: record everything, interrupt about nothing. */
    quiet: QuietSchema.prefault({}),
    /** Contradiction-tree weighting: how hard a cross-goal tension presses. */
    contradictions: ContradictionsSchema.prefault({}),
});
/**
 * Parse a raw loader-supplied config into a fully-defaulted configuration.
 *
 * @param raw - the `config` field of the plugin row, or `undefined`.
 * @returns the validated configuration with every default materialized.
 * @throws when a known key carries a value outside its declared range.
 */
export function parseConfig(raw) {
    return ConfigSchema.parse(raw ?? {});
}
