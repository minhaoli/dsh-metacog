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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ConfigSchema } from './config.js';
/**
 * Where the card's settings live. One file per user, not per project.
 *
 * `DSH_METACOG_OVERRIDES` redirects this path. It exists for test isolation:
 * without it, a developer who once flipped a switch in the settings card would
 * see unrelated test failures, because the tests would read the real user
 * override file. The variable is read on every call, never cached — tests set
 * it at runtime, after this module has already been evaluated.
 */
export function overridesPath() {
    const redirected = process.env.DSH_METACOG_OVERRIDES;
    if (typeof redirected === 'string' && redirected.trim().length > 0)
        return redirected;
    return join(homedir(), '.dsh', 'metacog-overrides.yml');
}
/**
 * The subset of config the card is allowed to change.
 *
 * Deliberately narrow. `storageSubdir` and `observationPolicy` are excluded: the
 * first decides where data already lives, so changing it from a card would look
 * like every record vanished, and the second is a deployment decision about what
 * evidence the host can supply. Neither is a preference.
 */
export const EDITABLE_PATHS = [
    'enabled',
    'quiet.enabled',
    'quiet.keepHardBlock',
    'quiet.suppressPromptBlock',
    'gate.level3HardBlock',
    'schedule.enabled',
    'schedule.checkIntervalMinutes',
    'schedule.autoReport',
    'thresholds.windowMinutes',
    'thresholds.repeatThreshold',
    'thresholds.minConfidence',
    'thresholds.highIntensityThreshold',
    'thresholds.staleDaysThreshold',
    // The v4 signal tunables. These decide how sensitive the judgement is, which is
    // exactly the sort of thing a user has to try rather than read about: the
    // defaults were derived for an uncalibrated score, so "is 0.875 too eager for
    // me" can only be answered by moving it and watching what happens.
    'signals.emaBeta',
    'signals.thetaHintScore',
    'signals.thetaCardScore',
    'signals.consecutiveStepsForCard',
    'signals.coverageFloor',
    // Collection switches. `enabled` decides whether the feed is recorded at all;
    // the truncation length is how much of a user message survives into a record.
    'collection.enabled',
    'collection.summaryMaxChars',
    // Realtime verdict. The switch is off by default because it spends a model
    // call every few minutes; the provider/model pair is editable so the user can
    // point it at a small model instead of the one driving the conversation.
    'realtime.enabled',
    'realtime.provider',
    'realtime.model',
    'realtime.intervalMinutes',
    'realtime.maxInputTokens',
    'realtime.timeoutMs',
    'realtime.hintThreshold',
    // Contradiction weights. How much a cross-goal tension counts against a goal
    // is a judgement about this deployment, not a constant: the same tension can
    // be decisive in one project and background in another. Exposing it here is
    // what makes "the weight is adjustable" true for a user who never opens a
    // profile file; `allowNodeOverride` is the escape hatch for a single node
    // whose weight genuinely differs from the default.
    'contradictions.defaultRelatedWeight',
    'contradictions.allowNodeOverride',
];
/** Read the override document, or an empty object when there is none. */
export function readOverrides() {
    try {
        const raw = readFileSync(overridesPath(), 'utf8');
        const parsed = parseYaml(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return {};
        return parsed;
    }
    catch (error) {
        // A missing file is the normal case. A corrupt one is reported and ignored, so
        // the plugin still mounts with the profile's own settings.
        if (error.code !== 'ENOENT') {
            console.warn(`[dsh-metacog] could not read ${overridesPath()}: ${String(error)}`);
        }
        return {};
    }
}
/** Merge a nested override object into a base config object, one level at a time. */
function deepMerge(base, override) {
    const out = { ...base };
    for (const [key, value] of Object.entries(override)) {
        const before = out[key];
        if (value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            before !== null &&
            typeof before === 'object' &&
            !Array.isArray(before)) {
            out[key] = deepMerge(before, value);
        }
        else {
            out[key] = value;
        }
    }
    return out;
}
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
export function resolveConfig(profileConfig) {
    const base = (profileConfig ?? {});
    const overrides = readOverrides();
    if (Object.keys(overrides).length === 0) {
        return { config: ConfigSchema.parse(base), applied: false };
    }
    try {
        return { config: ConfigSchema.parse(deepMerge(base, overrides)), applied: true };
    }
    catch (error) {
        const problem = String(error);
        console.warn(`[dsh-metacog] overrides in ${overridesPath()} were rejected and ignored; ` +
            `running with the profile config. Reason: ${problem}`);
        return { config: ConfigSchema.parse(base), applied: false, problem };
    }
}
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
export async function writeOverride(path, value, profileConfig) {
    if (!EDITABLE_PATHS.includes(path)) {
        throw new Error(`"${path}" is not editable from the card`);
    }
    const current = readOverrides();
    const next = deepMerge(current, nestValue(path, value));
    // Validate the merged result against the profile before touching disk: a value
    // that cannot load must not be written, or the next start would need manual repair.
    const base = (profileConfig ?? {});
    ConfigSchema.parse(deepMerge(base, next));
    const target = overridesPath();
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.tmp`;
    writeFileSync(temp, stringifyYaml(next, { lineWidth: 0 }) +
        '\n# 由设置卡写入；改这里等价于改卡片，重启生效。\n', 'utf8');
    renameSync(temp, target);
    return next;
}
/** `a.b.c` + value → `{a: {b: {c: value}}}`. */
function nestValue(path, value) {
    const parts = path.split('.');
    let node = {};
    const root = node;
    for (let index = 0; index < parts.length - 1; index += 1) {
        const child = {};
        node[parts[index]] = child;
        node = child;
    }
    node[parts[parts.length - 1]] = value;
    return root;
}
/**
 * Read one editable value from a resolved config by dotted path.
 *
 * @param config - resolved config.
 * @param path - dotted path.
 * @returns the value, or `undefined` when the path names nothing.
 */
export function readPath(config, path) {
    let node = config;
    for (const part of path.split('.')) {
        if (node === null || typeof node !== 'object')
            return undefined;
        node = node[part];
    }
    return node;
}
