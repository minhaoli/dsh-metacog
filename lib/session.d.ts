import type { Disposer, HostAgent, HostContext, HostSession } from './host.js';
import type { MetacogConfig } from './config.js';
import type { MetacogStore } from './data/store.js';
/** How the dedicated session is named. Kept in one place so find and create agree. */
export declare function metacogSessionTitle(workspaceName: string): string;
/** Derive a workspace name from an absolute root path. */
export declare function workspaceNameOf(projectRoot: string): string;
/** What resolving the session produced. */
export type SessionResolution = {
    readonly status: 'created';
    readonly sessionId: string;
    readonly title: string;
    /** Where the session was grouped, or why it could not be. */
    readonly grouping: string;
    /**
     * The live agent for the new conversation.
     *
     * Carried so the caller can deliver the first instruction through
     * `agent.followup` instead of a reminder: the reminder path assembles the
     * prompt without an agent in context, which is exactly what leaves the
     * `{{model}}` variable unresolved.
     */
    readonly agent?: HostAgent;
} | {
    readonly status: 'existing';
    readonly sessionId: string;
    readonly title: string;
    readonly agent?: HostAgent;
} | {
    /** The host cannot mint sessions; the caller must open one by hand. */
    readonly status: 'unsupported';
    readonly reason: string;
};
/** Everything session management needs. */
export interface MetacogSessionOptions {
    readonly ctx: HostContext;
    readonly config: MetacogConfig;
    readonly store: MetacogStore;
    readonly projectId: string;
    readonly projectRoot: string;
    /**
     * The conversation that triggered initialisation.
     *
     * Read only to inherit its agent preset. The preset owns the prompt section
     * that references `{{model}}`, so a session created without it dies on its
     * first turn with `prompt variable "{{model}}" has no value`.
     */
    readonly inheritFrom?: HostSession;
    /**
     * Tool names this deployment registers globally.
     *
     * The whitelist is built by intersecting with this set: `tools.restrict` treats
     * an unknown name as a programming error and throws, so a build without one of
     * the optional tools would lose the session over a capability it never used.
     */
    readonly knownTools?: ReadonlySet<string>;
}
/**
 * Where the dedicated session currently stands.
 *
 * The three cases are not interchangeable, and treating them as one boolean is
 * what makes a "session already exists" check wrong in practice:
 *
 * - `live` — an agent is running; the conversation can be entered immediately.
 * - `archived` — the log still exists but the session is hidden from the
 *   sidebar. Rebuilding must unarchive the SAME session, not mint a new one,
 *   otherwise the user's history is stranded under a hidden row.
 * - `gone` — the log is missing entirely. Only here is a new session correct.
 */
export type MetacogSessionState = {
    readonly kind: 'live';
    readonly sessionId: string;
    readonly title: string;
} | {
    readonly kind: 'archived';
    readonly sessionId: string;
    readonly title: string;
} | {
    readonly kind: 'gone';
} | {
    readonly kind: 'unknown';
    readonly reason: string;
};
/**
 * Inspect the dedicated session without creating anything.
 *
 * Checks the live store first, then persistence, then archiving. A session that
 * exists on disk but is archived reports `archived` so the caller can offer
 * "restore it" instead of silently creating a duplicate conversation.
 *
 * @param options - host context, store and project identity.
 */
export declare function inspectMetacogSession(options: MetacogSessionOptions): Promise<MetacogSessionState>;
/**
 * Locate the dedicated session for a project, without creating one.
 *
 * @param options - host context, store and project identity.
 * @returns the live session and its title, or `undefined`.
 */
export declare function findMetacogSession(options: MetacogSessionOptions): Promise<{
    session: HostSession;
    title: string;
} | undefined>;
/**
 * Resolve the display name of the workspace owning a directory.
 *
 * The registry title is what the user sees in the sidebar, so naming the session
 * after the directory basename would disagree with its own workspace whenever the
 * user renamed that workspace. Falls back to the basename when no workspace owns
 * the directory yet.
 *
 * @param ctx - host context.
 * @param projectRoot - absolute project directory.
 */
export declare function resolveWorkspaceName(ctx: HostContext, projectRoot: string): Promise<string>;
/**
 * Work out which model a new metacog agent should run on.
 *
 * A freshly created agent has no model of its own. Prompt assembly then cannot
 * resolve the `{{model}}` variable behind the persona section, and the session
 * dies with `prompt variable "{{model}}" has no value` — which reads like a
 * model problem but is really a missing agent option.
 *
 * Precedence: the invoking session's current model (what the user is already
 * using), then the deployment default. Returning `undefined` is honest — the
 * caller reports it instead of creating an agent that cannot assemble a prompt.
 *
 * @param ctx - host context.
 * @param session - the session that triggered initialisation.
 */
export declare function resolveInheritedModel(ctx: HostContext, session: HostSession | undefined): {
    provider: string;
    model: string;
    reasoningEffort?: string;
} | undefined;
/**
 * Ensure the dedicated session exists.
 *
 * @param options - host context, store and project identity.
 * @param rebuild - when a session already exists and this is true, the caller
 *   has confirmed it should be reused rather than refused. Reuse is the only
 *   "rebuild" possible: a DSH session cannot be deleted from a plugin, so the
 *   existing conversation is reused and a fresh instruction is delivered into
 *   it, which is what the user actually wants when they say "redo it".
 * @returns what happened, or an `unsupported` verdict naming what is missing.
 */
export declare function ensureMetacogSession(options: MetacogSessionOptions, _rebuild?: boolean, 
/**
 * The model the new agent must run on.
 *
 * Passed explicitly because an agent created without one cannot assemble its
 * first prompt: the persona section references `{{model}}` and assembly fails.
 */
model?: {
    provider: string;
    model: string;
    reasoningEffort?: string;
}): Promise<SessionResolution>;
/**
 * Build the one-line message that wakes a metacog session.
 *
 * Deliberately short. Everything that used to live here — the ordered steps, the
 * prohibitions, the rebuild arguments — is now a registered system-prompt section
 * in `protocol.ts`, where it is re-read on every turn instead of scrolling out of
 * context after the first. What remains in the message is only what a section
 * cannot know: which workspace this is, and whether a tree already exists.
 *
 * @param workspaceName - human name of the workspace.
 * @param hasTree - whether a confirmed tree already exists.
 * @param treeVersion - version of that tree, so the rebuild proof is concrete.
 */
export declare function buildInitKickoff(workspaceName: string, hasTree: boolean, treeVersion?: number): string;
/**
 * Deliver a message by starting a turn on the agent itself.
 *
 * This is the correct path for the first instruction of a conversation. The
 * prompt is assembled inside the agent's own driver chain, so `context.agent` is
 * present and the `{{model}}` / `{{provider}}` variables resolve.
 *
 * The reminder path (`schedule.create`) assembles without an agent in context,
 * which fails with `prompt variable "{{model}}" has no value` — the reminder is
 * meant to bring a user back, not to bootstrap a session.
 *
 * @param agent - the live agent to wake, when one is available.
 * @param text - the message body.
 * @returns whether the message was admitted.
 */
export declare function followupToAgent(agent: HostAgent | undefined, text: string): boolean;
/**
/**
 * Deliver a message through the session domain.
 *
 * This is the path the desktop UI uses to admit a prompt, so it resumes a cold
 * session first and assembles the prompt with the agent in context. Both matter:
 * a reminder-delivered message reaches a session whose assembly has no agent and
 * dies on `prompt variable "{{model}}" has no value`.
 *
 * @param ctx - host context.
 * @param sessionId - the conversation to put the message into.
 * @param text - the message body.
 */
export declare function deliverViaController(ctx: HostContext, sessionId: string, text: string): Promise<{
    ok: true;
} | {
    ok: false;
    reason: string;
}>;
/**
 * Deliver a message into the metacog session.
 *
 * Uses `schedule.create`, which is the supported way to put text into a session
 * and wake it. A failed delivery is reported rather than thrown: the session
 * still exists, and the caller can tell the user to open it manually.
 *
 * @param options - host context.
 * @param sessionId - target session.
 * @param title - reminder title, shown in the schedule list.
 * @param prompt - the message body.
 */
export declare function deliverToSession(ctx: HostContext, sessionId: string, title: string, prompt: string): Promise<{
    ok: true;
} | {
    ok: false;
    reason: string;
}>;
/** Register the slash command that starts initialisation from the composer. */
export declare function registerInitCommand(ctx: HostContext, 
/**
 * Runs the initialisation. It receives the invoking agent because an
 * interactive question is only accepted from the exact live runtime root, and
 * a slash command is the one place that handle is available.
 */
run: (agent: HostAgent) => Promise<string>): Disposer | undefined;
