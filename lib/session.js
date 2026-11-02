/**
 * The dedicated metacognitive session.
 *
 * Goals and contradictions are not derived in whichever working conversation
 * happens to be open — they are established once in one named conversation, and
 * every later review of them happens in that same place. That gives the user a
 * stable address for "what is this project actually trying to do", separate from
 * the many conversations where the work itself happens.
 *
 * This module owns the lifecycle of that session:
 *
 * - **find** it by its pinned title, so the name is the identity (the session id
 *   is stored too, but a renamed or restored session is still recognisable);
 * - **create** it when absent, with a deterministic title derived from the
 *   workspace so two projects never collide;
 * - **deliver** the initialisation instruction into it, waking the session if it
 *   is idle.
 *
 * It never derives anything itself. Derivation happens inside that session,
 * driven by the instruction this module delivers.
 *
 * @module dsh-metacog/session
 */
import { randomUUID } from 'node:crypto';
import { applyMetacogScope } from './protocol.js';
/** How the dedicated session is named. Kept in one place so find and create agree. */
export function metacogSessionTitle(workspaceName) {
    return `${workspaceName}·认知监控`;
}
/** Derive a workspace name from an absolute root path. */
export function workspaceNameOf(projectRoot) {
    const normalized = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    const base = normalized.split('/').pop() ?? '项目';
    return base.trim().length > 0 ? base.trim() : '项目';
}
/**
 * Inspect the dedicated session without creating anything.
 *
 * Checks the live store first, then persistence, then archiving. A session that
 * exists on disk but is archived reports `archived` so the caller can offer
 * "restore it" instead of silently creating a duplicate conversation.
 *
 * @param options - host context, store and project identity.
 */
export async function inspectMetacogSession(options) {
    const { ctx, store, projectId } = options;
    const sessions = ctx.get('sessions');
    const expectedTitle = metacogSessionTitle(workspaceNameOf(options.projectRoot));
    const storedId = await store.readMetacogSessionId(projectId);
    // Live store: an agent is running, which is the common case.
    if (sessions !== undefined) {
        if (storedId !== undefined) {
            const live = sessions.get(storedId);
            if (live !== undefined) {
                const title = ctx.get('sessionTitle')?.get(live)?.title ?? expectedTitle;
                return { kind: 'live', sessionId: storedId, title };
            }
        }
        // Title fallback: covers a lost store binding or an imported project.
        const titles = ctx.get('sessionTitle');
        if (titles !== undefined) {
            for (const session of sessions.list()) {
                const title = titles.get(session)?.title;
                if (title === expectedTitle) {
                    return { kind: 'live', sessionId: session.id, title };
                }
            }
        }
    }
    if (storedId === undefined)
        return { kind: 'gone' };
    // Not live: does the log still exist?
    const persistence = ctx.get('sessionPersistence');
    if (persistence === undefined) {
        return {
            kind: 'unknown',
            reason: 'host does not provide sessionPersistence; cannot tell whether the session survives',
        };
    }
    let stored;
    try {
        stored = await persistence.stat(storedId);
    }
    catch (error) {
        return { kind: 'unknown', reason: `sessionPersistence.stat failed: ${String(error)}` };
    }
    if (stored === undefined) {
        // The log is gone, so the recorded binding points at nothing.
        return { kind: 'gone' };
    }
    // Archived sessions are excluded from the visible workspace list.
    const registry = ctx.get('workspaceRegistry');
    if (registry !== undefined) {
        try {
            const workspaces = registry.list();
            const archived = workspaces.some((workspace) => (workspace.archivedSessionIds ?? []).some((id) => id === storedId));
            if (archived) {
                const title = stored.header?.title ?? expectedTitle;
                return { kind: 'archived', sessionId: storedId, title };
            }
        }
        catch {
            // Listing failures fall through to the conservative answer below.
        }
    }
    // Persisted but not live and not known to be archived: the user closed it.
    // Reopening is a normal resume, so report it as archived-shaped: something to
    // restore rather than to recreate.
    const title = stored.header?.title ?? expectedTitle;
    return { kind: 'archived', sessionId: storedId, title };
}
/**
 * Locate the dedicated session for a project, without creating one.
 *
 * @param options - host context, store and project identity.
 * @returns the live session and its title, or `undefined`.
 */
export async function findMetacogSession(options) {
    const state = await inspectMetacogSession(options);
    if (state.kind !== 'live')
        return undefined;
    const live = options.ctx.get('sessions')?.get(state.sessionId);
    return live === undefined ? undefined : { session: live, title: state.title };
}
/**
 * Attach a session to the workspace that owns a directory.
 *
 * `sessions.create({ meta: { cwd } })` only sets the session's working
 * directory; it does NOT place the session in a workspace. Workspace membership
 * is a separate durable association owned by `workspaceRegistry`, so the session
 * must be attached explicitly or it will not appear under this project in the
 * sidebar.
 *
 * @param ctx - host context.
 * @param projectRoot - absolute project directory.
 * @param sessionId - session to attach.
 * @returns a note about what happened, for the caller to report honestly.
 */
async function attachToWorkspace(ctx, projectRoot, sessionId) {
    const registry = ctx.get('workspaceRegistry');
    if (registry === undefined)
        return 'host has no workspaceRegistry; session not grouped';
    try {
        // `create` both finds and creates, and realpaths the directory. Using it
        // rather than `resolveByPath` means a project whose directory is not yet a
        // workspace still ends up grouped, instead of silently landing nowhere.
        const workspace = await registry.create(projectRoot);
        await workspace.attachSession(sessionId);
        // Verify, do not assume. `sessionIds` is filtered by the session header's
        // canonical cwd, so an attach that does not appear there means the header
        // cwd does not match this workspace's path — the session would then be
        // invisible under the project even though the attach call returned cleanly.
        // Surfacing that mismatch is the whole point of this check.
        const listed = workspace.sessionIds.includes(sessionId);
        return listed
            ? `attached to workspace "${workspace.title}"`
            : `attached to "${workspace.title}" but not listed there (session cwd does not match the workspace path)`;
    }
    catch (error) {
        return `workspace attach failed: ${String(error)}`;
    }
}
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
export async function resolveWorkspaceName(ctx, projectRoot) {
    const registry = ctx.get('workspaceRegistry');
    if (registry !== undefined) {
        try {
            const workspace = await registry.resolveByPath(projectRoot);
            const title = workspace?.title.trim();
            if (title !== undefined && title.length > 0)
                return title;
        }
        catch {
            // `realpath` rejects on a missing directory; the basename is still usable.
        }
    }
    return workspaceNameOf(projectRoot);
}
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
export function resolveInheritedModel(ctx, session) {
    const current = session?.requestContext?.();
    if (current !== undefined && current.provider.length > 0 && current.model.length > 0) {
        return {
            provider: current.provider,
            model: current.model,
            ...(current.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: current.reasoningEffort }),
        };
    }
    const fallback = ctx.get('agentDefaultModel')?.currentSelection();
    if (fallback !== undefined && fallback.provider.length > 0 && fallback.model.length > 0) {
        return {
            provider: fallback.provider,
            model: fallback.model,
            ...(fallback.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: fallback.reasoningEffort }),
        };
    }
    return undefined;
}
/**
 * Mint a session id for a new metacog conversation.
 *
 * `agents.create` both creates the session and attaches its agent, and it takes
 * the id from the caller. So this plugin must NOT also call `sessions.create`
 * for the same conversation — the agent service would then try to create the
 * session a second time and fail with "already exists".
 *
 * The id is deliberately opaque: `metacog-<time><random>`. It does not embed the
 * project id, because that id is derived from a directory name and a Chinese
 * project would leave a row of underscores in every session identifier. The
 * project binding lives in the store, which is where it is actually read.
 */
function mintSessionId() {
    const stamp = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 10);
    return `metacog-${stamp}${rand}`;
}
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
export async function ensureMetacogSession(options, _rebuild = false, 
/**
 * The model the new agent must run on.
 *
 * Passed explicitly because an agent created without one cannot assemble its
 * first prompt: the persona section references `{{model}}` and assembly fails.
 */
model) {
    const { ctx, store, projectId, projectRoot } = options;
    const sessions = ctx.get('sessions');
    const agents = ctx.get('agents');
    if (sessions === undefined) {
        return { status: 'unsupported', reason: 'host does not provide the sessions service' };
    }
    if (agents === undefined) {
        return { status: 'unsupported', reason: 'host does not provide the agents service' };
    }
    const state = await inspectMetacogSession(options);
    // A live conversation is reused as-is. "Rebuild" means re-deriving the tree,
    // not relocating the discussion: the history of how this project's goals were
    // arrived at belongs in the same place it always lived.
    if (state.kind === 'live') {
        await store.setMetacogSessionId(projectId, state.sessionId);
        // `agents.get` rather than `sessions.get`: delivery needs the agent, whose
        // `followup` starts a turn inside its own driver chain.
        const liveAgent = agents.get?.(state.sessionId);
        return {
            status: 'existing',
            sessionId: state.sessionId,
            title: state.title,
            ...(liveAgent === undefined ? {} : { agent: liveAgent }),
        };
    }
    // Archived or merely closed: restore that exact session instead of minting a
    // new one. Creating a second conversation would strand the original under a
    // hidden row and split the project's history in two.
    if (state.kind === 'archived') {
        const restored = await restoreSession(ctx, projectRoot, state.sessionId, state.title);
        if (restored.ok) {
            await store.setMetacogSessionId(projectId, state.sessionId);
            return {
                status: 'existing',
                sessionId: state.sessionId,
                title: state.title,
            };
        }
        ctx.logger.warn(`[dsh-metacog] could not restore session ${state.sessionId}: ${restored.reason}; ` +
            'creating a new one instead');
    }
    if (state.kind === 'unknown') {
        ctx.logger.warn(`[dsh-metacog] session state unknown: ${state.reason}`);
    }
    const title = metacogSessionTitle(workspaceNameOf(projectRoot));
    // Creation goes through `agents.create`, not `sessionController.create`.
    //
    // `sessionController.create` is decorated `@Remote`: it expects the remote
    // parameter codec and rejects a direct in-process call from plugin code with a
    // bare `RemoteError: session.create`. `agents.create` is the plain service
    // method behind it.
    const preset = options.inheritFrom?.header?.agentPreset;
    const sessionId = mintSessionId();
    let created;
    try {
        created = await agents.create({
            sessionId,
            meta: {
                cwd: projectRoot,
                // The preset owns the prompt section referencing `{{model}}`. Creating
                // a session without it leaves that section unassemblable, which is what
                // produced `prompt variable "{{model}}" has no value`.
                ...(preset === undefined ? {} : { agentPreset: preset }),
            },
            ...(model === undefined ? {} : { agentOptions: model }),
            // Install the standing protocol and the tool whitelist into this one
            // conversation. `setup` receives the new agent's own scope, so the section
            // and the restriction apply here and nowhere else — which is what makes the
            // protocol a system prompt instead of a first message the model must
            // remember.
            setup: (scope) => {
                const applied = applyMetacogScope(scope, options.knownTools ?? new Set());
                // One diagnostic line per created session. `skipped` is otherwise dead
                // weight: those tools are part of the protocol's intent but this
                // deployment never registered them, and without this line the only
                // symptom is a tool the model quietly does not have. The allow list is
                // logged in full too, so a whitelist that matched nothing reads as such.
                ctx.logger.info('[dsh-metacog] session scope: ' +
                    `section=${applied.section} restricted=${applied.restricted} ` +
                    `allowed=[${applied.allowed.join(', ')}] ` +
                    `skipped=[${applied.skipped.join(', ')}]`);
                for (const problem of applied.problems) {
                    ctx.logger.warn(`[dsh-metacog] session scope: ${problem}`);
                }
            },
        });
    }
    catch (error) {
        return { status: 'unsupported', reason: `agents.create failed: ${String(error)}` };
    }
    const createdSessionId = created.agent.id;
    await store.setMetacogSessionId(projectId, createdSessionId);
    // Title and grouping. Both are best-effort: a failure leaves a usable
    // conversation with a provisional name, which beats no conversation.
    const live = sessions?.get(createdSessionId);
    const titles = ctx.get('sessionTitle');
    if (titles !== undefined && live !== undefined) {
        try {
            titles.rename(live, title);
        }
        catch (error) {
            ctx.logger.warn(`[dsh-metacog] could not pin session title: ${String(error)}`);
        }
    }
    const grouping = await attachToWorkspace(ctx, projectRoot, createdSessionId);
    return {
        status: 'created',
        sessionId: createdSessionId,
        title,
        grouping,
        agent: created.agent,
    };
}
/**
 * Bring an existing stored session back to life.
 *
 * Unarchiving and resuming are separate steps with different failure modes, so
 * both are attempted and their outcomes folded into one verdict.
 *
 * @param ctx - host context.
 * @param _projectRoot - directory for the resumed agent. Unused since the
 *   session is resumed by id; kept so the call site reads symmetrically with
 *   the sibling initialisers.
 * @param sessionId - the session to restore.
 * @param title - its pinned title, re-applied after resume.
 */
async function restoreSession(ctx, _projectRoot, sessionId, title) {
    const registry = ctx.get('workspaceRegistry');
    if (registry !== undefined) {
        try {
            await registry.unarchiveSession(sessionId);
        }
        catch (error) {
            // A session that was never archived rejects nothing here in practice, and
            // a failure is not fatal: resume below is what actually brings it back.
            ctx.logger.warn(`[dsh-metacog] unarchiveSession failed: ${String(error)}`);
        }
    }
    const agents = ctx.get('agents');
    const sessions = ctx.get('sessions');
    if (agents === undefined || sessions?.get(sessionId) !== undefined) {
        return sessions?.get(sessionId) !== undefined
            ? { ok: true }
            : { ok: false, reason: 'agents service unavailable' };
    }
    try {
        const handle = await agents.resume({ resumeSessionId: sessionId });
        void handle;
    }
    catch (error) {
        return { ok: false, reason: `agents.resume failed: ${String(error)}` };
    }
    const live = sessions?.get(sessionId);
    const titles = ctx.get('sessionTitle');
    if (live !== undefined && titles !== undefined) {
        try {
            titles.rename(live, title);
        }
        catch {
            // Title is cosmetic; the session is restored either way.
        }
    }
    return { ok: true };
}
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
export function buildInitKickoff(workspaceName, hasTree, treeVersion) {
    const state = hasTree
        ? `已有一棵确认树（version ${treeVersion === undefined ? '未知，先用 goal_tree_view 读出' : treeVersion}），本次是重建。`
        : '目前还没有目标树。';
    return `开始认知监控初始化。工作区：${workspaceName}。${state}`;
}
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
export function followupToAgent(agent, text) {
    if (agent?.followup === undefined)
        return false;
    try {
        agent.followup({
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
        });
        return true;
    }
    catch {
        return false;
    }
}
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
export async function deliverViaController(ctx, sessionId, text) {
    const controller = ctx.get('sessionController');
    if (controller === undefined) {
        return { ok: false, reason: 'host does not provide the sessionController service' };
    }
    try {
        await controller.prompt({
            requestId: randomUUID(),
            sessionId,
            // `queue` appends without interrupting an in-flight turn; a brand new
            // conversation has none, so this is the safe choice either way.
            mode: 'queue',
            content: [{ type: 'text', text }],
            clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        return { ok: true };
    }
    catch (error) {
        return { ok: false, reason: `sessionController.prompt failed: ${String(error)}` };
    }
}
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
export async function deliverToSession(ctx, sessionId, title, prompt) {
    const schedule = ctx.get('schedule');
    if (schedule === undefined) {
        return { ok: false, reason: 'host does not provide the schedule service' };
    }
    try {
        await schedule.create(sessionId, {
            title,
            prompt,
            // Fire immediately: this is a poke, not a reminder for later.
            after_seconds: 1,
        });
        return { ok: true };
    }
    catch (error) {
        return { ok: false, reason: `schedule.create failed: ${String(error)}` };
    }
}
/** Register the slash command that starts initialisation from the composer. */
export function registerInitCommand(ctx, 
/**
 * Runs the initialisation. It receives the invoking agent because an
 * interactive question is only accepted from the exact live runtime root, and
 * a slash command is the one place that handle is available.
 */
run) {
    const commands = ctx.get('commands');
    if (commands === undefined)
        return undefined;
    return commands.register({
        name: 'metacog-init',
        description: '为当前工作区开启认知监控初始化：新建（或复用）专用会话并推导目标与矛盾',
        handler: async (invocation) => {
            try {
                const text = await run(invocation.agent);
                return { kind: 'success', text };
            }
            catch (error) {
                return { kind: 'error', text: `初始化失败：${String(error)}` };
            }
        },
    });
}
