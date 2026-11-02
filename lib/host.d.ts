/**
 * Runtime host contract for the small slice of the Cordis/DSH surface this
 * plugin actually touches.
 *
 * Everything here was verified against the live host on 2026-10-27 via
 * `cordis_inspect_query` (host Service / Event providers) and against the
 * shipped sources of `dsh-notify`, `dsh-better-edit` and `dsh-better-sidebar`
 * inside the DSH asar. Nothing is speculative: a member appears here only
 * because some shipped plugin calls it, or because the inspect contract
 * declares it.
 *
 * The DSH host does NOT ship resolvable type packages for plugins
 * (`@deepseek-ai/cordis` and `@deepseek-ai/dsh-tools` live inside app.asar and
 * fail `import.meta.resolve` from a profile plugin). Declaring the narrow
 * structural types here keeps `tsc --strict` meaningful without inventing
 * imports that would break at runtime.
 *
 * @module dsh-metacog/host
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
/** One HTTP route the host's browser carrier serves. */
export interface HostWebRoute {
    readonly kind: 'exact' | 'prefix';
    readonly path: string;
    readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
/** Content block the host renders as tool output. */
export interface TextBlock {
    type: 'text';
    text: string;
}
/** Content block union accepted by `ToolOutputDefinition.render`. */
export type ContentBlock = TextBlock;
/**
 * Regex-free JSON Schema node subset accepted by `ctx.tools.register`.
 *
 * The registry validates model arguments against exactly this structure, so it
 * is written as plain JSON Schema rather than the `defineTool` DSL (that DSL is
 * host-internal and not importable from a plugin).
 */
export interface JsonSchemaNode {
    type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
    properties?: Record<string, JsonSchemaNode>;
    required?: string[];
    additionalProperties?: boolean;
    items?: JsonSchemaNode;
    enum?: (string | number | boolean | null)[];
    const?: string | number | boolean | null;
    description?: string;
    default?: unknown;
}
/** Minimal agent handle the tool execution context exposes. */
export interface HostAgent {
    readonly id: string;
    readonly session?: HostSession;
    /**
     * Queue a user message and wake the agent.
     *
     * Preferred over `schedule.create` for starting a conversation: the message is
     * admitted inside the agent's own driver chain, so prompt assembly receives
     * `context.agent` and the `{{model}}` / `{{provider}}` variables resolve.
     * A reminder-delivered message has no agent in its assembly context and fails
     * with `prompt variable "{{model}}" has no value`.
     */
    followup?(message: UserMessageLike): void;
}
/** A user-authored message, in the shape the inbox accepts. */
export interface UserMessageLike {
    readonly id: string;
    readonly role: 'user';
    readonly content: readonly ContentBlock[];
    readonly source: {
        readonly kind: 'user';
    };
}
/** Live session handle; `header.cwd` is the project root signal. */
export interface HostSession {
    readonly id: string;
    readonly header?: {
        cwd?: string;
        /**
         * The agent preset this conversation runs.
         *
         * A new conversation must inherit it. The preset owns the prompt sections
         * that reference `{{model}}`, so a session created without it produces a
         * conversation whose first prompt cannot assemble.
         */
        agentPreset?: string;
    };
    /**
     * The model this session's requests are built with.
     *
     * A new agent must inherit this. Creating one without a model leaves the
     * prompt's `{{model}}` variable unset, and assembly then fails with
     * `prompt variable "{{model}}" has no value`.
     */
    requestContext?(): SessionRequestModel | undefined;
}
/** The model identity a session currently runs on. */
export interface SessionRequestModel {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}
/** Execution context handed to a registered tool's `execute`. */
export interface ToolRunContext {
    readonly callId: string;
    readonly name: string;
    readonly arguments: unknown;
    readonly agent?: HostAgent;
    readonly signal: AbortSignal;
}
/** Tool definition accepted by `ctx.tools.register`. */
export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    output: {
        schema: JsonSchemaNode;
        render(args: unknown, value: unknown): ContentBlock[];
    };
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
    isConcurrencySafe?(args: unknown): boolean;
    timeoutMs?: number;
}
/** Prompt section / context contribution accepted by `ctx.systemPrompt`. */
export interface PromptSection {
    name: string;
    order?: number;
    text: string | ((ctx: AssembleContext) => string);
    complete?: boolean;
}
/** Assembly context passed to a dynamic prompt `text` function. */
export interface AssembleContext {
    readonly agent?: HostAgent;
}
/** Disposer returned by every registration entry point. */
export type Disposer = () => void;
/**
 * The slice of `Context` this plugin uses.
 *
 * Optional members are the ones the host may legitimately lack (an older
 * build, or a headless deployment); every call site feature-detects instead of
 * assuming presence.
 */
export interface HostContext {
    /**
     * Read an optional host service without declaring it as a hard dependency.
     *
     * Cordis forbids reading an undeclared service as a property; feature
     * detection must go through `ctx.get`, which returns `undefined` when the
     * service is not provided or its provider is inactive.
     */
    get(name: 'systemPrompt'): HostContext['systemPrompt'];
    get(name: 'timer'): HostContext['timer'];
    get(name: 'fs'): HostContext['fs'];
    get(name: 'sessions'): HostContext['sessions'];
    get(name: 'sessionPersistence'): HostContext['sessionPersistence'];
    get(name: 'workspaceRegistry'): HostContext['workspaceRegistry'];
    get(name: 'userQuestions'): HostContext['userQuestions'];
    get(name: 'sessionTitle'): HostContext['sessionTitle'];
    get(name: 'schedule'): HostContext['schedule'];
    get(name: 'commands'): HostContext['commands'];
    get(name: 'agentDefaultModel'): HostContext['agentDefaultModel'];
    get(name: 'sessionController'): HostContext['sessionController'];
    get(name: 'workspaceRegistry'): HostContext['workspaceRegistry'];
    get(name: 'workingDirectory'): HostContext['workingDirectory'];
    get(name: 'subagents'): HostContext['subagents'];
    get(name: 'agents'): HostContext['agents'];
    get(name: 'webServer'): HostContext['webServer'];
    get(name: string): unknown;
    readonly logger: {
        debug(...args: unknown[]): void;
        info(...args: unknown[]): void;
        warn(...args: unknown[]): void;
    };
    on(name: string, listener: (...args: never[]) => void): Disposer;
    effect(setup: () => Disposer | Promise<Disposer>): void;
    readonly tools?: {
        register(definition: ToolDefinition): Disposer;
    };
    /**
     * The browser HTTP carrier (`ctx.get('webServer')`).
     *
     * Declared in `inject` on purpose. An undeclared service is not linked into
     * this plugin's context, and `ctx.get` then answers `undefined` even while the
     * Web GUI is serving requests — which is exactly how the settings card's route
     * went missing on the first attempt.
     */
    readonly webServer?: {
        register(route: HostWebRoute): Disposer;
        getOrigin(): string;
    };
    readonly systemPrompt?: {
        section(section: PromptSection): Disposer;
        context(context: PromptSection): Disposer;
    };
    readonly timer?: {
        interval(callback: () => void, delay: number): Disposer;
    };
    readonly fs?: unknown;
    readonly workingDirectory?: {
        get(session: HostSession): string | undefined;
        readonly defaultDirectory?: string;
    };
    /**
     * Subagent service (`ctx.get('subagents')`).
     *
     * Verified against the live host: `startActivation` accepts an
     * `outputSchema` and resolves with a `SubagentResult` whose `structured`
     * field carries the schema-validated object. This is the only channel a
     * plugin has for asking a model to read files and return a judgement; without
     * it the derivation layer must degrade to handing instructions to the caller.
     */
    readonly subagents?: {
        list(): string[];
        /** Resolve the effective nesting limit; `undefined` means provider-managed. */
        resolveMaxDepth(configured?: number): number | undefined;
        /** Provider capabilities, when the provider is registered and inspectable. */
        getProvider?(name: string): {
            readonly capabilities?: {
                readonly outputSchema: boolean;
            };
        } | undefined;
        startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>;
    };
    /** Agent service, used only to obtain the initiating agent handle. */
    readonly agents?: {
        currentInitiator(): HostAgent | undefined;
        /**
         * Create an agent for a prepared session.
         *
         * The session must exist first (`sessions.create`), because the agent loop
         * attaches its log writer to that session. Creation is async: the returned
         * handle's agent is usable only after the promise settles.
         */
        create(options: CreateAgentOptions): Promise<AgentHandle>;
        /**
         * Resume a persisted session into a live agent.
         *
         * Used to restore the metacog conversation when its log exists but no agent
         * is running — the user closed the tab, or the app restarted. Resuming keeps
         * the same session id, which is what makes "rebuild" reuse the existing
         * conversation instead of stranding its history in a hidden row.
         */
        resume(options: ResumeAgentOptions): Promise<AgentHandle>;
        /** All live top-level agents, in registration order. */
        roots?(): HostAgent[];
        /** Look up a live agent by session id. */
        get?(id: string): HostAgent | undefined;
    };
    /** Session store, used to mint the dedicated metacog session. */
    readonly sessions?: {
        create(id?: string, options?: CreateSessionOptions): HostSession;
        get(id: string): HostSession | undefined;
        list(): HostSession[];
    };
    /** Session titles; `rename` pins a title so auto-generation stops. */
    readonly sessionTitle?: {
        rename(session: HostSession, title: string): {
            title: string;
        };
        get(session: HostSession): {
            title: string;
        } | undefined;
    };
    /** Durable reminders, also the way to deliver a message into a session. */
    readonly schedule?: {
        create(sessionId: string, request: {
            title: string;
            prompt: string;
            after_seconds?: number;
        }, signal?: AbortSignal): Promise<{
            id: string;
        }>;
    };
    /** Human-command registry; a slash command is a first-class UI entry point. */
    readonly commands?: {
        register(definition: CommandDefinition): Disposer;
    };
    /**
     * Workspace registry. Workspace membership is a durable association that is
     * separate from a session's `cwd`, so a plugin-created session must be
     * attached explicitly to appear under its project in the sidebar.
     */
    readonly workspaceRegistry?: {
        create(path: string, title?: string): Promise<WorkspaceRef>;
        resolveByPath(path: string): Promise<WorkspaceRef | undefined>;
        list(): WorkspaceRef[];
        /** Bring an archived session back into the visible list. */
        unarchiveSession(sessionId: string): Promise<void>;
    };
    /** Durable session storage: distinguishes `archived` from `deleted`. */
    readonly sessionPersistence?: {
        stat(id: string): Promise<{
            header: Record<string, unknown>;
            revision: unknown;
        } | undefined>;
    };
    /** Interactive questions, rendered as a card the user answers. */
    readonly userQuestions?: {
        ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>;
    };
    /** The deployment's default model, used when the current session has none. */
    readonly agentDefaultModel?: {
        currentSelection(): {
            provider: string;
            model: string;
            reasoningEffort?: string;
        };
    };
    /**
     * Session-domain service behind the GUI's own session namespace.
     *
     * This is the supported way to create a conversation and to put text into it.
     * Both are what the desktop UI itself calls, so they handle what a plugin
     * cannot reasonably reimplement: workspace membership, agent-preset
     * inheritance, and resuming a cold session before admitting a prompt.
     */
    readonly sessionController?: {
        /** Resolve a live agent, resuming the session when it is cold. */
        resolveAgent(sessionId: string): Promise<{
            agent: HostAgent;
        } | {
            error: unknown;
        }>;
        /** Create one ordinary session for a new conversation. */
        create(request: SessionCreateRequest): Promise<SessionCreateValue>;
        /** Admit one prompt, resuming its session first when needed. */
        prompt(request: SessionPromptRequest, signal?: AbortSignal): Promise<{
            accepted: true;
        }>;
    };
}
/** Arguments accepted by `sessionController.create`. */
export interface SessionCreateRequest {
    readonly workspaceId?: string;
    readonly cwd?: string;
    readonly sessionId?: string;
    /** Preset the new conversation should run; omit for the deployment default. */
    readonly agentPreset?: string;
}
/** What `sessionController.create` returns. */
export interface SessionCreateValue {
    readonly sessionId: string;
    readonly agentPreset?: string;
}
/** Arguments accepted by `sessionController.prompt`. */
export interface SessionPromptRequest {
    readonly requestId: string;
    readonly sessionId: string;
    readonly mode: 'queue' | 'steer';
    readonly content: readonly ContentBlock[];
    readonly clientTimeZone?: string;
}
/** The slice of a workspace this plugin uses. */
export interface WorkspaceRef {
    readonly id: string;
    readonly path: string;
    readonly title: string;
    readonly sessionIds: readonly string[];
    /** Sessions the user archived out of the sidebar. */
    readonly archivedSessionIds?: readonly string[];
    attachSession(sessionId: string): Promise<void>;
}
/** One question shown to the user. */
export interface AskUserQuestionItem {
    readonly id: string;
    readonly question: string;
    readonly detail?: string;
    readonly header?: string;
    readonly options?: {
        readonly label: string;
        readonly description?: string;
    }[];
    readonly multiSelect?: boolean;
}
/** What `userQuestions.ask` accepts. */
export interface AskUserQuestionRequest {
    readonly questions: AskUserQuestionItem[];
    /** Required for a human answer: must be the exact live runtime root. */
    readonly agent?: HostAgent;
    readonly signal?: AbortSignal;
    readonly wait?: {
        readonly callId: string;
        readonly timed?: boolean;
    };
}
/** What the user chose. */
export interface AskUserQuestionAnswer {
    readonly answers: {
        readonly id: string;
        readonly selected: string[];
        readonly custom?: string;
    }[];
}
/** One prompt section, as registered into an agent's scope. */
export interface HostPromptSection {
    readonly name: string;
    readonly order: number;
    readonly text: string | ((context: unknown) => string);
    readonly interpolate?: boolean;
}
/** Narrow view of the `systemPrompt` service from inside one agent's scope. */
export interface HostSystemPromptScope {
    section(section: HostPromptSection): Disposer;
}
/** Mask applied to the global tool registry for one agent's scope. */
export interface HostToolRestriction {
    readonly allow?: readonly string[];
    readonly deny?: readonly string[];
}
/** Narrow view of the `tools` registry from inside one agent's scope. */
export interface HostToolScope {
    restrict(filter: HostToolRestriction): Disposer;
}
/**
 * The context handed to `CreateAgentOptions.setup`.
 *
 * It *is* the new agent's own scope, so anything registered here — a prompt
 * section, a tool restriction — applies to exactly that conversation. Services are
 * read through `get`, which returns `undefined` instead of throwing, because a
 * deployment missing one of them must still get a working session.
 */
export interface HostAgentScope {
    get(name: 'systemPrompt'): HostSystemPromptScope | undefined;
    get(name: 'tools'): HostToolScope | undefined;
    get(name: string): unknown;
}
/** Options accepted by `ctx.agents.create`. */
export interface CreateAgentOptions {
    readonly sessionId: string;
    readonly parentAgent?: HostAgent;
    readonly meta?: {
        readonly cwd?: string;
        /**
         * Preset the new agent joins.
         *
         * Not cosmetic: the preset owns the persona prompt section, and that section
         * is what references `{{model}}`. An agent created without it cannot assemble
         * its first prompt and dies with `prompt variable "{{model}}" has no value`.
         */
        readonly agentPreset?: string;
    };
    /**
     * Runs once with the new agent's context, before its first turn.
     *
     * This is the only place where a plugin can shape *one* conversation's prompt
     * and toolset without touching every session in the profile.
     */
    readonly setup?: (scope: HostAgentScope, agent: HostAgent) => void;
    readonly agentOptions?: {
        readonly provider?: string;
        readonly model?: string;
        readonly reasoningEffort?: string;
    };
    readonly signal?: AbortSignal;
}
/** Handle returned by `ctx.agents.create`. */
export interface AgentHandle {
    readonly agent: HostAgent;
    dispose(): Promise<void>;
}
/** Options accepted by `ctx.agents.resume`. */
export interface ResumeAgentOptions {
    /** The persisted session to bring back to life. */
    readonly resumeSessionId: string;
    readonly agentOptions?: {
        readonly provider?: string;
        readonly model?: string;
        readonly reasoningEffort?: string;
    };
    readonly signal?: AbortSignal;
}
/** Options accepted by `ctx.sessions.create`. */
export interface CreateSessionOptions {
    readonly seed?: readonly unknown[];
    readonly meta?: {
        readonly cwd?: string;
        readonly parentSession?: string;
    };
}
/** A slash command the model or the user can invoke. */
export interface CommandDefinition {
    readonly name: string;
    readonly description: string;
    readonly input?: {
        readonly hint: string;
        readonly attachments?: boolean;
    };
    readonly handler: (invocation: CommandInvocation) => Promise<CommandResult> | CommandResult;
}
/** What a command handler receives. */
export interface CommandInvocation {
    readonly commandId: string;
    readonly agent: HostAgent;
    readonly rawInput: string;
    readonly signal: AbortSignal;
}
/** What a command handler returns. */
export type CommandResult = {
    readonly kind: 'success';
    readonly text?: string;
} | {
    readonly kind: 'error';
    readonly text: string;
};
/**
 * A subagent activation request.
 *
 * Narrowed to the fields this plugin sets. `outputSchema` is the important one:
 * it makes the child return a schema-validated object instead of prose, which
 * is what turns "ask a model" into a usable programmatic step.
 */
export interface SubagentActivationSpec {
    /** Registered provider name (from `subagents.list()`). */
    readonly provider: string;
    readonly label: string;
    readonly request: {
        readonly prompt: ContentBlock[];
        readonly parent: HostAgent;
        /** JSON Schema the child's structured result must satisfy. */
        readonly outputSchema?: Record<string, unknown>;
        readonly cwd?: string;
        readonly agentOptions?: {
            readonly provider?: string;
            readonly model?: string;
            readonly reasoningEffort?: string;
        };
    };
    readonly signal: AbortSignal;
    readonly delivery: 'parent' | 'caller';
}
/** Result produced by one subagent activation. */
export interface SubagentActivation {
    readonly childId: string;
    readonly messageId?: string;
    readonly result: Promise<SubagentResultShape>;
    dispose(): Promise<void>;
}
/** What a subagent returns. */
export interface SubagentResultShape {
    readonly output: ContentBlock[];
    /** The schema-validated object, when `outputSchema` was supplied. */
    readonly structured?: unknown;
    readonly diagnostic?: string;
    readonly stopReason: string;
}
/** Plugin entry point shape the Cordis loader calls. */
export interface PluginModule {
    name: string;
    inject: string[];
    apply(ctx: HostContext, config?: unknown): void;
}
