/**
 * Shared plumbing for every tool this plugin registers.
 *
 * Responsibilities kept here so individual tool modules stay declarative:
 *
 * - resolving the project root for a call (and refusing when there is none),
 * - constructing the per-call store,
 * - converting a thrown domain error into a structured refusal the model can
 *   act on, rather than a stack trace,
 * - rendering results as a single text block.
 *
 * @module dsh-metacog/tools/shared
 */
import { join } from 'node:path';
import { MetacogStore } from '../data/store.js';
import { GateError } from '../governance.js';
import { StoreInvariantError, VersionConflictError } from '../data/store.js';
/**
 * Build a failure envelope from a thrown value.
 *
 * @param error - whatever was thrown.
 * @returns a stable, model-readable failure.
 */
export function toFailure(error) {
    if (error instanceof GateError) {
        return { ok: false, error: { code: error.code, message: error.message, details: error.details } };
    }
    if (error instanceof VersionConflictError) {
        return {
            ok: false,
            error: {
                code: error.code,
                message: error.message,
                details: {
                    projectId: error.projectId,
                    expectedVersion: error.expectedVersion,
                    actualVersion: error.actualVersion,
                },
            },
        };
    }
    if (error instanceof StoreInvariantError) {
        return { ok: false, error: { code: error.code, message: error.message } };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { code: 'INTERNAL', message } };
}
/**
 * Create the shared tool environment for one plugin mount.
 *
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 * @returns the environment every tool handler closes over.
 */
export function createToolEnvironment(ctx, config) {
    const stores = new Map();
    return {
        ctx,
        config,
        async resolveProjectRoot(exec, explicit) {
            // An explicit root wins. The settings card already resolved the project from
            // the id it was asked about, and this function's other sources are all
            // session-scoped: honouring them would let a card action land on whichever
            // workspace the conversation happens to be in.
            if (typeof explicit === 'string' && explicit.length > 0)
                return explicit;
            const workingDirectory = ctx.get('workingDirectory');
            const session = exec.agent?.session;
            const fromSession = session === undefined ? undefined : workingDirectory?.get(session);
            if (typeof fromSession === 'string' && fromSession.length > 0)
                return fromSession;
            const headerCwd = session?.header?.cwd;
            if (typeof headerCwd === 'string' && headerCwd.length > 0)
                return headerCwd;
            const fallback = workingDirectory?.defaultDirectory;
            if (typeof fallback === 'string' && fallback.length > 0)
                return fallback;
            throw new GateError('NO_PROJECT_ROOT', 'this call has no project root: the host exposed no working directory for the ' +
                'current session. Metacognitive state is project-scoped and cannot be recorded ' +
                'without one.');
        },
        storeFor(projectRoot) {
            const key = join(projectRoot, config.storageSubdir);
            let store = stores.get(key);
            if (store === undefined) {
                store = new MetacogStore(projectRoot, config.storageSubdir);
                stores.set(key, store);
            }
            return store;
        },
    };
}
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
export function deriveProjectId(projectRoot) {
    const normalized = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    const base = normalized.split('/').pop() ?? 'project';
    const safeBase = base.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'project';
    // djb2: cheap, deterministic, and adequate for disambiguating path suffixes.
    let hash = 5381;
    for (let index = 0; index < normalized.length; index += 1) {
        hash = ((hash << 5) + hash + normalized.charCodeAt(index)) | 0;
    }
    const digest = (hash >>> 0).toString(16).padStart(8, '0');
    return `${safeBase}-${digest}`;
}
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
export async function loadProject(env, exec) {
    // A caller that already resolved the project — the settings card, which was
    // asked about one specific id — puts the root on the context. It has to win
    // over the session lookup, or a card action would land on whichever workspace
    // the conversation happens to be in.
    const pinned = exec.projectRoot;
    const projectRoot = await env.resolveProjectRoot(exec, typeof pinned === 'string' ? pinned : undefined);
    const projectId = deriveProjectId(projectRoot);
    const store = env.storeFor(projectRoot);
    return { projectRoot, projectId, store };
}
/**
 * Reject an argument object that carries keys the tool never declared.
 *
 * The registry validates model arguments against `parameters` before
 * `execute` runs, but a wrong key that silently disappears is the worst kind
 * of failure: the caller believes it changed something and the store says
 * otherwise. Checking here means a typo surfaces as a refusal with the
 * accepted names, on every host build.
 *
 * @param args - the raw argument object.
 * @param parameters - the tool's declared JSON Schema.
 * @param toolName - name used in the message.
 * @throws {GateError} `UNKNOWN_ARGUMENT` naming the offending keys.
 */
function assertKnownArguments(args, parameters, toolName) {
    if (typeof args !== 'object' || args === null || Array.isArray(args))
        return;
    const declared = parameters.properties;
    if (typeof declared !== 'object' || declared === null)
        return;
    const known = new Set(Object.keys(declared));
    const unknown = Object.keys(args).filter((key) => !known.has(key));
    if (unknown.length === 0)
        return;
    throw new GateError('UNKNOWN_ARGUMENT', `${toolName} does not accept ${unknown.map((key) => `"${key}"`).join(', ')}. ` +
        `Accepted arguments: ${[...known].join(', ')}.`, { unknown, accepted: [...known] });
}
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
export function toLosslessJson(value) {
    return sanitize(value, new Set());
}
/** Recursively replace `undefined` with `null`. */
function sanitize(value, seen) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== 'object')
        return value;
    // Dates are JSON-safe through toJSON; leave them for the serializer.
    if (value instanceof Date)
        return value;
    // A self-referential value cannot be shipped, but this must not recurse while
    // discovering that.
    if (seen.has(value))
        return null;
    seen.add(value);
    try {
        if (Array.isArray(value))
            return value.map((item) => sanitize(item, seen));
        const source = value;
        const out = {};
        for (const key of Object.keys(source))
            out[key] = sanitize(source[key], seen);
        return out;
    }
    finally {
        seen.delete(value);
    }
}
/**
 * Declare one tool.
 *
 * Wraps the definition so every handler shares the outcome envelope, the error
 * mapping and the single text-block rendering.
 *
 * @param definition - name, description, parameter schema and handler.
 * @returns a registry-ready tool definition.
 */
export function defineMetacogTool(definition) {
    return {
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    data: definition.outputSchema,
                },
                required: ['ok'],
            },
            render: (_args, value) => renderOutcome(value),
        },
        async execute(args, exec) {
            try {
                assertKnownArguments(args, definition.parameters, definition.name);
                const data = await definition.run(args, exec);
                return { ok: true, data: toLosslessJson(data) };
            }
            catch (error) {
                return toFailure(error);
            }
        },
    };
}
/**
 * Render a tool outcome as one readable text block.
 *
 * Failures render as a short refusal with the code and message, because the
 * model needs the reason to decide what to do next, not the JSON envelope.
 *
 * @param value - the tool's returned value.
 */
export function renderOutcome(value) {
    const text = isFailure(value)
        ? `REFUSED [${value.error.code}]\n${value.error.message}${value.error.details === undefined
            ? ''
            : `\n\ndetails: ${JSON.stringify(value.error.details, null, 2)}`}`
        : JSON.stringify(value.data, null, 2);
    return [{ type: 'text', text }];
}
/**
 * Narrow a value to a failure envelope.
 *
 * @param value - the tool's returned value.
 */
function isFailure(value) {
    return (typeof value === 'object' &&
        value !== null &&
        value.ok === false &&
        typeof value.error === 'object');
}
