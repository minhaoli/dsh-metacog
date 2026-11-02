/**
 * Stage G+: the Level 3 hard gate (spec 4.4 item 4).
 *
 * Verified host contract (2026-10-27, `cordis_inspect_query` `Event.listEvents`
 * with `event: "tools/pre-execute"`): a **waterfall** whose listener may return
 * `{ kind: 'deny', reason, info? }` to refuse a call before it is dispatched.
 * Returning `next()` delegates to the default allow. The registry rechecks
 * cancellation after an async gate settles, so the handler must also observe
 * `exec.signal`.
 *
 * What this module gates:
 *
 * - Only a **pending Level 3** intervention blocks anything. Levels 0–2 are
 *   advisory by design: a monitor that interrupts ordinary work loses the right
 *   to be listened to.
 * - Only tools that are not read-only are blocked. Every inspection path stays
 *   open, otherwise the user cannot even look at the problem being reported.
 * - The monitor's own decision tools are never blocked: the gate asks for a
 *   decision, so refusing the tool that records the decision would deadlock it.
 *
 * The gate is off unless `gate.level3HardBlock` is true. See the config comment
 * for why that default is the safe one.
 *
 * @module dsh-metacog/gate
 */
import type { Disposer, HostContext } from './host.js';
import type { MetacogConfig } from './config.js';
import type { MetacogStore } from './data/store.js';
/** The pending call, as the waterfall hands it over. */
export interface PendingCall {
    readonly name: string;
    readonly arguments?: unknown;
    readonly agent?: {
        readonly id: string;
        readonly session?: {
            readonly id: string;
        };
    };
    readonly signal?: AbortSignal;
}
/** A decision the waterfall understands. */
export type PreToolDecision = {
    kind: 'allow';
} | {
    kind: 'deny';
    reason: string;
};
/** Everything the gate needs. */
export interface GateOptions {
    readonly ctx: HostContext;
    readonly config: MetacogConfig;
    /** Resolve the store for the calling session, or `undefined` when unknown. */
    readonly storeForSession: (sessionId: string) => Promise<{
        store: MetacogStore;
        projectId: string;
    } | undefined>;
}
/** What the gate is currently doing, for the mount log and tests. */
export interface GateStats {
    /** Calls considered by the gate. */
    seen: number;
    /** Calls refused because a Level 3 card was pending. */
    denied: number;
    /** Calls allowed because no Level 3 card was pending. */
    allowed: number;
    /** Calls that would have been denied had the gate been enabled. */
    shadowed: number;
    /** Whether the gate is armed (config on and host hook present). */
    armed: boolean;
}
/**
 * Decide whether one call may proceed.
 *
 * Pure except for the store read, and returns the reason as a value rather than
 * throwing, so a host that logs decisions records something readable.
 *
 * @param call - the pending call.
 * @param options - mount context and config.
 * @returns the waterfall decision plus whether it was a shadow decision.
 */
export declare function evaluateCall(call: PendingCall, options: GateOptions): Promise<{
    decision: PreToolDecision;
    shadow: boolean;
}>;
/**
 * Install the gate on the host's pre-execute waterfall.
 *
 * @param options - mount context, config and store resolver.
 * @returns live stats plus the disposer.
 */
export declare function installGate(options: GateOptions): {
    stats: GateStats;
    dispose: Disposer;
};
