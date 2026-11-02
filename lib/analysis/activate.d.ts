/**
 * One structured subagent call, shared by everything that needs a model verdict.
 *
 * Derivation already had this plumbing inline. Drift review needs the same thing —
 * a prompt in, a schema-validated object out — so it lives here instead of being
 * written twice with two subtly different failure behaviours.
 *
 * The contract is deliberately value-based: a caller must be able to distinguish
 * "this host cannot run a subagent" (degrade) from "the model failed" (report) from
 * "the model answered" (proceed). Throwing would collapse those three into one.
 *
 * @module dsh-metacog/analysis/activate
 */
import type { HostAgent, HostContext } from '../host.js';
/** What the caller wants the model to do. */
export interface StructuredRequest {
    /** Full prompt. The schema is supplied separately. */
    readonly prompt: string;
    /** JSON Schema the answer must satisfy. */
    readonly schema: Record<string, unknown>;
    /** Workspace the child runs in. */
    readonly cwd?: string;
    /** Label shown in the host's child listing. */
    readonly label?: string;
    /** Hard deadline; the child is aborted when it passes. */
    readonly timeoutMs?: number;
    /**
     * Agent the child is attributed to.
     *
     * Required in practice whenever the call does not originate inside a tool: a
     * slash command and a timer tick both run in the plugin's own context, where
     * `agents.currentInitiator()` has nothing to report, and relying on it made the
     * review fail with "no initiating agent is in context" the moment it was
     * triggered by hand.
     */
    readonly parent?: HostAgent;
}
/** Cost/identity of one completed call. */
export interface ActivationUsage {
    readonly provider: string;
    readonly childId: string;
    readonly stopReason: string;
    readonly elapsedMs: number;
    readonly promptChars: number;
    readonly outputChars: number;
}
/** Outcome of one attempt. */
export type StructuredOutcome = {
    readonly status: 'ok';
    readonly structured: unknown;
    readonly usage: ActivationUsage;
} | {
    readonly status: 'unavailable';
    readonly reason: string;
} | {
    readonly status: 'failed';
    readonly reason: string;
};
/**
 * Run one structured subagent call.
 *
 * @param ctx - host context.
 * @param request - prompt, schema and limits.
 */
export declare function activateStructured(ctx: HostContext, request: StructuredRequest): Promise<StructuredOutcome>;
