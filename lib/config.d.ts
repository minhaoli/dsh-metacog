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
 * One entry of the global activity whitelist. Entries match either by
 * substring against the activity summary (case-insensitive) or by exact tool
 * name, so a user can register both "读论文" and `web_search`.
 */
export declare const WhitelistEntrySchema: z.ZodObject<{
    label: z.ZodString;
    summaryContains: z.ZodDefault<z.ZodArray<z.ZodString>>;
    toolNames: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
/** Escalation and drift-detection tunables. */
export declare const ThresholdsSchema: z.ZodObject<{
    windowMinutes: z.ZodDefault<z.ZodNumber>;
    repeatThreshold: z.ZodDefault<z.ZodNumber>;
    minConfidence: z.ZodDefault<z.ZodNumber>;
    highIntensityThreshold: z.ZodDefault<z.ZodNumber>;
    staleDaysThreshold: z.ZodDefault<z.ZodNumber>;
    reviewIntervalMinutes: z.ZodDefault<z.ZodNumber>;
    reviewBatchSize: z.ZodDefault<z.ZodNumber>;
    judgmentLogThreshold: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
/** Periodic scheduling tunables (spec Stage F). */
export declare const ScheduleSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    checkIntervalMinutes: z.ZodDefault<z.ZodNumber>;
    autoReport: z.ZodDefault<z.ZodBoolean>;
    autoReportTypes: z.ZodDefault<z.ZodArray<z.ZodEnum<{
        daily: "daily";
        weekly: "weekly";
        monthly: "monthly";
    }>>>;
}, z.core.$strip>;
/** Live collection tunables (spec Stage E). */
export declare const CollectionSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    summaryMaxChars: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
/**
 * Realtime bare-LLM verdict channel.
 *
 * Off by default: this is a second, independent judgement that costs a model
 * call every few minutes, so it is a choice the user makes rather than a
 * default the monitor imposes. `provider` / `model` empty means "follow the
 * harness's global selection"; resolving that belongs to the caller, because
 * the verdict module deliberately does not read global model state.
 */
export declare const RealtimeSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    provider: z.ZodDefault<z.ZodString>;
    model: z.ZodDefault<z.ZodString>;
    intervalMinutes: z.ZodDefault<z.ZodNumber>;
    maxInputTokens: z.ZodDefault<z.ZodNumber>;
    timeoutMs: z.ZodDefault<z.ZodNumber>;
    hintThreshold: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type RealtimeConfig = z.infer<typeof RealtimeSchema>;
/**
 * v4 signal tunables.
 *
 * Weights live in `data/signals.ts` as constants rather than here: they are part
 * of the aggregation contract, and a weight that can be edited in a profile file
 * is a contract that can silently change between two runs of the same test.
 * What is configurable is the tuning that legitimately differs per deployment.
 */
export declare const SignalsSchema: z.ZodObject<{
    emaBeta: z.ZodDefault<z.ZodNumber>;
    thetaHintScore: z.ZodDefault<z.ZodNumber>;
    thetaCardScore: z.ZodDefault<z.ZodNumber>;
    consecutiveStepsForCard: z.ZodDefault<z.ZodNumber>;
    coverageFloor: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type SignalsConfig = z.infer<typeof SignalsSchema>;
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
export declare const JudgmentSchema: z.ZodObject<{
    allowUnreviewedEscalation: z.ZodDefault<z.ZodBoolean>;
    backlogLimit: z.ZodDefault<z.ZodNumber>;
    maxLatencyMinutes: z.ZodDefault<z.ZodNumber>;
    bypassSampleRate: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type JudgmentConfig = z.infer<typeof JudgmentSchema>;
/** Level 3 enforcement tunables (spec 4.4 item 4). */ export declare const GateSchema: z.ZodObject<{
    level3HardBlock: z.ZodDefault<z.ZodBoolean>;
    neverBlocked: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
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
export declare const QuietSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    keepHardBlock: z.ZodDefault<z.ZodBoolean>;
    suppressPromptBlock: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
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
export declare const ContradictionsSchema: z.ZodObject<{
    defaultRelatedWeight: z.ZodDefault<z.ZodNumber>;
    allowNodeOverride: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type ContradictionsConfig = z.infer<typeof ContradictionsSchema>;
export declare const ConfigSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    observationPolicy: z.ZodPrefault<z.ZodObject<{
        gradeBMaxConfidence: z.ZodDefault<z.ZodNumber>;
        gradeCStaticOnly: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    thresholds: z.ZodPrefault<z.ZodObject<{
        windowMinutes: z.ZodDefault<z.ZodNumber>;
        repeatThreshold: z.ZodDefault<z.ZodNumber>;
        minConfidence: z.ZodDefault<z.ZodNumber>;
        highIntensityThreshold: z.ZodDefault<z.ZodNumber>;
        staleDaysThreshold: z.ZodDefault<z.ZodNumber>;
        reviewIntervalMinutes: z.ZodDefault<z.ZodNumber>;
        reviewBatchSize: z.ZodDefault<z.ZodNumber>;
        judgmentLogThreshold: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    whitelistedActivities: z.ZodDefault<z.ZodArray<z.ZodObject<{
        label: z.ZodString;
        summaryContains: z.ZodDefault<z.ZodArray<z.ZodString>>;
        toolNames: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
    storageSubdir: z.ZodDefault<z.ZodString>;
    schedule: z.ZodPrefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        checkIntervalMinutes: z.ZodDefault<z.ZodNumber>;
        autoReport: z.ZodDefault<z.ZodBoolean>;
        autoReportTypes: z.ZodDefault<z.ZodArray<z.ZodEnum<{
            daily: "daily";
            weekly: "weekly";
            monthly: "monthly";
        }>>>;
    }, z.core.$strip>>;
    collection: z.ZodPrefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        summaryMaxChars: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    realtime: z.ZodPrefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        provider: z.ZodDefault<z.ZodString>;
        model: z.ZodDefault<z.ZodString>;
        intervalMinutes: z.ZodDefault<z.ZodNumber>;
        maxInputTokens: z.ZodDefault<z.ZodNumber>;
        timeoutMs: z.ZodDefault<z.ZodNumber>;
        hintThreshold: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    signals: z.ZodPrefault<z.ZodObject<{
        emaBeta: z.ZodDefault<z.ZodNumber>;
        thetaHintScore: z.ZodDefault<z.ZodNumber>;
        thetaCardScore: z.ZodDefault<z.ZodNumber>;
        consecutiveStepsForCard: z.ZodDefault<z.ZodNumber>;
        coverageFloor: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    judgment: z.ZodPrefault<z.ZodObject<{
        allowUnreviewedEscalation: z.ZodDefault<z.ZodBoolean>;
        backlogLimit: z.ZodDefault<z.ZodNumber>;
        maxLatencyMinutes: z.ZodDefault<z.ZodNumber>;
        bypassSampleRate: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>>;
    gate: z.ZodPrefault<z.ZodObject<{
        level3HardBlock: z.ZodDefault<z.ZodBoolean>;
        neverBlocked: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    quiet: z.ZodPrefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        keepHardBlock: z.ZodDefault<z.ZodBoolean>;
        suppressPromptBlock: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
    contradictions: z.ZodPrefault<z.ZodObject<{
        defaultRelatedWeight: z.ZodDefault<z.ZodNumber>;
        allowNodeOverride: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type WhitelistEntry = z.infer<typeof WhitelistEntrySchema>;
export type Thresholds = z.infer<typeof ThresholdsSchema>;
export type ScheduleConfig = z.infer<typeof ScheduleSchema>;
export type CollectionConfig = z.infer<typeof CollectionSchema>;
export type GateConfig = z.infer<typeof GateSchema>;
export type MetacogConfig = z.infer<typeof ConfigSchema>;
/** Thresholds with every key present (zod defaults applied). */
export type ResolvedThresholds = z.output<typeof ThresholdsSchema>;
/**
 * Parse a raw loader-supplied config into a fully-defaulted configuration.
 *
 * @param raw - the `config` field of the plugin row, or `undefined`.
 * @returns the validated configuration with every default materialized.
 * @throws when a known key carries a value outside its declared range.
 */
export declare function parseConfig(raw: unknown): MetacogConfig;
