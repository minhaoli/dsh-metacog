/**
 * dsh-metacog: a project-level metacognitive goal and contradiction monitor.
 *
 * This module is the plugin entry point. It establishes the loadable skeleton
 * the other modules grow into:
 *
 * - a validated configuration (every window, threshold and whitelist exposed),
 * - a single owned lifecycle whose teardown is registered through
 *   `ctx.effect`, so HMR, disable and process shutdown all release it,
 * - feature-detected host wiring: a capability the host lacks is reported once
 *   and skipped, never faked.
 *
 * The layers are kept as separate modules:
 *
 * - `src/data/`     — persistence, CAS, snapshots, hash-chained audit log
 * - `src/analysis/` — deterministic drift rules, trends, escalation machine
 * - `src/evidence/` — project scanning, material discovery, PDF extraction
 * - `src/tools/`    — the tools the model calls
 * - `src/commands/` — the slash-command parsers
 * - `src/`          — host wiring, HTTP channel, scheduling, reporting
 *
 * @module dsh-metacog
 */
import type { Disposer, HostContext } from './host.js';
import type { MetacogConfig } from './config.js';
/** Cordis plugin name used in loader diagnostics. */
export declare const name = "dsh-metacog";
/**
 * Hard dependencies only.
 *
 * Cordis gates plugin activation on EVERY name listed here: `Fiber._refresh`
 * computes an epoch over `Object.keys(this.inject)` and goes INACTIVE as soon as
 * one of them has no implementation, which unloads the plugin entirely. Listing
 * an optional service here would therefore make the plugin vanish on any host
 * that lacks it — the opposite of what an optional dependency should do.
 *
 * So this list must stay minimal: `tools` is the one thing a monitor cannot work
 * without. Everything else is probed through `ctx.get`.
 *
 * `webServer` is the one exception, and it is a hard dependency on purpose: an
 * undeclared service is not linked into this context, so `ctx.get('webServer')`
 * answered `undefined` while the Web GUI was demonstrably serving requests, and
 * the settings card's route silently never registered. Declaring it costs the
 * plugin on a headless host that has no browser carrier — where the card could
 * not render anyway.
 */
export declare const inject: string[];
/**
 * Whether a root is a throwaway directory rather than a workspace.
 *
 * Test fixtures land in the OS temp directory and are deleted moments later.
 * Recording them made the project index grow without bound — 30 of 31 entries
 * were dead temp paths at one point — which turned a helpful "here is what to
 * sweep" list into a list a reader has to filter by eye.
 *
 * Deliberately a path test, not an existence test: a real workspace on a
 * momentarily unmounted drive must survive to be swept later.
 *
 * Exported so the rule can be asserted directly. Reaching it through a full
 * mount plus a confirmed tree exercised the plumbing rather than the rule, and a
 * mutant that deleted the guard went unnoticed.
 *
 * @param projectRoot - absolute path a project was registered under.
 * @param tempDir - the OS temp directory, injectable for tests.
 */
export declare function isDisposableRoot(projectRoot: string, tempDir?: string): boolean;
/** What the host actually offered, recorded once at mount for later stages. */
export interface CapabilityReport {
    readonly systemPrompt: boolean;
    readonly timer: boolean;
    readonly fs: boolean;
    readonly workingDirectory: boolean;
    /** Whether the host exposes the subagent service (needed for derivation). */
    readonly subagents: boolean;
    /** Whether an initiating agent handle can be read (needed for `request.parent`). */
    readonly agents: boolean;
}
/**
 * One live mount: its configuration, the capabilities the host offered, and the
 * registrations it owns.
 */
export interface Mount {
    readonly config: MetacogConfig;
    readonly capabilities: CapabilityReport;
    /**
     * Take ownership of a disposer.
     *
     * Runs the disposer immediately when the mount is already torn down, so a
     * late async registration can never leak past unmount.
     */
    claim(dispose: Disposer): void;
}
/**
 * Read the mount published by {@link apply} for a context.
 *
 * @param ctx - the plugin context handed to `apply`.
 * @returns the mount, or `undefined` when the plugin is not mounted here
 *   (disabled by config, or a context that never ran `apply`).
 */
export declare function getMount(ctx: HostContext): Mount | undefined;
/**
 * Register the plugin on a host context.
 *
 * Runs synchronously so the loader sees a deterministic mount; everything that
 * needs async setup is registered as an effect instead.
 *
 * @param ctx - the live plugin context.
 * @param rawConfig - the `config` field of this plugin's loader row.
 */
export declare function apply(ctx: HostContext, rawConfig?: unknown): void;
