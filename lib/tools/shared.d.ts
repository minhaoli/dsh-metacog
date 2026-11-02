import type { ContentBlock, HostContext, JsonSchemaNode, ToolDefinition, ToolRunContext } from '../host.js';
import type { MetacogConfig } from '../config.js';
import { MetacogStore } from '../data/store.js';
/** A tool failure the model should read and react to, not crash on. */
export interface ToolFailure {
    ok: false;
    error: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
    };
}
/** Wrap a successful payload in the uniform envelope. */
export interface ToolSuccess<T> {
    ok: true;
    data: T;
}
/**
 * Build a failure envelope from a thrown value.
 *
 * @param error - whatever was thrown.
 * @returns a stable, model-readable failure.
 */
export declare function toFailure(error: unknown): ToolFailure;
/** Environment a tool handler runs against. */
export interface ToolEnvironment {
    readonly ctx: HostContext;
    readonly config: MetacogConfig;
    /**
     * Resolve the project root for this call.
     *
     * @param exec - the tool execution context.
     * @param explicit - a root the caller already resolved, used verbatim.
     * @returns absolute project root.
     * @throws {GateError} `NO_PROJECT_ROOT` when the host cannot supply one.
     */
    resolveProjectRoot(exec: ToolRunContext, explicit?: string): Promise<string>;
    /**
     * Build the store for a project root.
     *
     * @param projectRoot - absolute project root.
     */
    storeFor(projectRoot: string): MetacogStore;
}
/**
 * Create the shared tool environment for one plugin mount.
 *
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 * @returns the environment every tool handler closes over.
 */
export declare function createToolEnvironment(ctx: HostContext, config: MetacogConfig): ToolEnvironment;
/**
 * Derive a stable project id from an absolute project root.
 *
 * Uses the directory basename plus a short digest of the full path so two
 * checkouts of the same directory name never collide, while the id stays
 * readable in filenames.
 *
 * @param projectRoot - absolute project root.
 * @returns filesystem-safe project id.
 */
export declare function deriveProjectId(projectRoot: string): string;
/**
 * Shared read of the facts every analysis tool needs: where the project is,
 * which id it persists under, and the store bound to that root.
 *
 * Resolving these three together is the only correct order — the id is derived
 * from the resolved root, and the store is bound to it — so tools that need all
 * three get them in one call rather than repeating the sequence.
 *
 * @param env - shared tool environment.
 * @param exec - execution context for this call.
 * @returns project root, project id and store.
 */
export declare function loadProject(env: ToolEnvironment, exec: ToolRunContext): Promise<{
    projectRoot: string;
    projectId: string;
    store: MetacogStore;
}>;
/**
 * Drop `undefined` from a tool's return value.
 *
 * The host requires tool output to be *lossless* JSON and rejects a value that
 * contains `undefined` with "value is not lossless JSON". `JSON.stringify`
 * cannot help: it silently omits such properties, so the check has to happen on
 * the live object. Replacing with `null` keeps the key visibly "absent" while
 * staying a legal JSON value.
 *
 * This is the last line of defence. Handlers should already prefer `null`, but
 * one optional property slipping through used to fail the whole call at the
 * registry boundary with a message naming neither the tool's intent nor the
 * offending field.
 *
 * @param value - the value a handler returned.
 * @returns the same shape with every `undefined` replaced by `null`.
 */
export declare function toLosslessJson<T>(value: T): T;
/**
 * Declare one tool.
 *
 * Wraps the definition so every handler shares the outcome envelope, the error
 * mapping and the single text-block rendering.
 *
 * @param definition - name, description, parameter schema and handler.
 * @returns a registry-ready tool definition.
 */
export declare function defineMetacogTool<T>(definition: {
    name: string;
    description: string;
    /** Raw JSON Schema for the `parameters` field. */
    parameters: Record<string, unknown>;
    /** JSON Schema describing the value the handler returns inside `data`. */
    outputSchema: JsonSchemaNode;
    /** Run the tool body; throw to signal failure. */
    run(args: unknown, exec: ToolRunContext): Promise<T>;
}): ToolDefinition;
/**
 * Render a tool outcome as one readable text block.
 *
 * Failures render as a short refusal with the code and message, because the
 * model needs the reason to decide what to do next, not the JSON envelope.
 *
 * @param value - the tool's returned value.
 */
export declare function renderOutcome(value: unknown): ContentBlock[];
