/**
 * Settings the user changed from the card.
 *
 * The card could write straight into the profile's `cordis.patch.yml` and it would
 * work — until the day the write is malformed, at which point the whole plugin (and
 * possibly its neighbours) fails to load, and the reason is a YAML error inside a
 * file the user never edited by hand. A settings toggle should not be able to break
 * startup.
 *
 * So the card writes here instead: one small file the plugin owns, merged over the
 * profile config at mount time. Two consequences, both intended:
 *
 * - A corrupt override file costs the overrides, not the plugin. The parse failure
 *   is logged and the profile config is used as-is.
 * - Everything the card can change is visible in one place, and the profile file
 *   stays exactly as the user wrote it.
 *
 * Writes are atomic (temp + rename) for the same reason the store uses it: a crash
 * mid-write must not leave a half-parsed document.
 *
 * @module dsh-metacog/settings
 */
import { type MetacogConfig } from './config.js';
/**
 * Where the card's settings live. One file per user, not per project.
 *
 * `DSH_METACOG_OVERRIDES` redirects this path. It exists for test isolation:
 * without it, a developer who once flipped a switch in the settings card would
 * see unrelated test failures, because the tests would read the real user
 * override file. The variable is read on every call, never cached — tests set
 * it at runtime, after this module has already been evaluated.
 */
export declare function overridesPath(): string;
/**
 * The subset of config the card is allowed to change.
 *
 * Deliberately narrow. `storageSubdir` and `observationPolicy` are excluded: the
 * first decides where data already lives, so changing it from a card would look
 * like every record vanished, and the second is a deployment decision about what
 * evidence the host can supply. Neither is a preference.
 */
export declare const EDITABLE_PATHS: readonly ["enabled", "quiet.enabled", "quiet.keepHardBlock", "quiet.suppressPromptBlock", "gate.level3HardBlock", "schedule.enabled", "schedule.checkIntervalMinutes", "schedule.autoReport", "thresholds.windowMinutes", "thresholds.repeatThreshold", "thresholds.minConfidence", "thresholds.highIntensityThreshold", "thresholds.staleDaysThreshold", "signals.emaBeta", "signals.thetaHintScore", "signals.thetaCardScore", "signals.consecutiveStepsForCard", "signals.coverageFloor", "collection.enabled", "collection.summaryMaxChars", "realtime.enabled", "realtime.provider", "realtime.model", "realtime.intervalMinutes", "realtime.maxInputTokens", "realtime.timeoutMs", "realtime.hintThreshold", "contradictions.defaultRelatedWeight", "contradictions.allowNodeOverride"];
export type EditablePath = (typeof EDITABLE_PATHS)[number];
/** Read the override document, or an empty object when there is none. */
export declare function readOverrides(): Record<string, unknown>;
/**
 * Resolve the effective configuration: profile config, overlaid with the card's.
 *
 * Validation happens after the merge, so an override that puts a value out of range
 * fails loudly instead of silently shaping behaviour. The one exception is the
 * override file itself — a bad override should not stop the plugin from mounting,
 * so a merge that fails validation falls back to the profile config and says so.
 *
 * @param profileConfig - the config from the plugin row.
 * @returns the effective config plus whether overrides were applied.
 */
export declare function resolveConfig(profileConfig: unknown): {
    config: MetacogConfig;
    applied: boolean;
    problem?: string;
};
/**
 * Set one editable value, leaving everything else in the override file alone.
 *
 * The value is validated by running it through the full schema first, so a bad
 * number is refused here rather than becoming a startup failure next time.
 *
 * @param path - dotted path, must be in {@link EDITABLE_PATHS}.
 * @param value - the new value.
 * @param profileConfig - the profile config, used to validate against a full shape.
 * @returns the settings that were written.
 */
export declare function writeOverride(path: string, value: unknown, profileConfig: unknown): Promise<Record<string, unknown>>;
/**
 * Read one editable value from a resolved config by dotted path.
 *
 * @param config - resolved config.
 * @param path - dotted path.
 * @returns the value, or `undefined` when the path names nothing.
 */
export declare function readPath(config: MetacogConfig, path: string): unknown;
