import type { Disposer, HostContext } from './host.js';
import type { MetacogConfig } from './config.js';
import type { MetacogStore } from './data/store.js';
import { type GeneratedReport } from './data/types.js';
import { type ReportType } from './report.js';
/** What the route needs from the mount it belongs to. */
export interface ApiOptions {
    /** Resolved plugin configuration, for thresholds and the storage subdirectory. */
    readonly config: MetacogConfig;
    /**
     * Absolute project roots this mount can serve.
     *
     * The mount owns this set: the periodic sweep knows the projects it monitors,
     * and the workspace registry supplies the rest. Returning an empty list is
     * legitimate — the card then shows an empty state instead of an error.
     */
    readonly listRoots: () => Promise<string[]>;
    /** Store for one root, reusing the mount's cache so reads share one lock. */
    readonly storeFor: (root: string) => MetacogStore;
    /**
     * The profile config as written, before card overrides.
     *
     * Needed to validate a written override against a full shape: the effective
     * config already contains the old overrides, so validating against it would let a
     * value pass that fails once the profile changes.
     */
    readonly profileConfig?: unknown;
    /**
     * The model the harness would use for a monitor call, when it can be read.
     *
     * Optional and read-only: a plugin writing the global model selection would be
     * reaching outside its own configuration, and the card says so rather than
     * offering a control that does not exist.
     */
    readonly defaultModel?: () => {
        provider?: string;
        model?: string;
    } | undefined;
    /** Run the static half of a sweep for one project; the model half needs a session. */
    readonly runSweep?: (projectId: string) => Promise<{
        ran: boolean;
        signals: number;
        hints: string[];
    }>;
    /**
     * Where cross-workspace reports are read from.
     *
     * Reports cover every workspace at once and are written to a global sink, so
     * asking any single project's store would return nothing — the card would show
     * an empty list while the files sat on disk. Injected rather than derived here
     * because the sink's location is the mount's decision, not the route's.
     */
    readonly readReports?: () => Promise<readonly GeneratedReport[]>;
    /** Generate one report covering every workspace. */
    readonly generateReport?: (type: ReportType) => Promise<GeneratedReport>;
    /** The global sink's root, for the "open folder" action. */
    readonly reportRoot?: () => string;
    /**
     * Hand a path to the desktop shell.
     *
     * Injectable so a test can assert on the target without launching an editor or
     * popping a "Windows cannot find the file" dialog on the user's screen. The
     * default is {@link openInShell}.
     */
    readonly opener?: (target: string, what: 'file' | 'folder') => Promise<{
        ok: boolean;
        error?: string;
    }>;
    /** Clear one project's record, using the same rules the tool enforces. */
    readonly purgeProject?: (root: string, projectId: string, reason: string, scope: 'records' | 'everything') => Promise<{
        deleted: string[];
        files: number;
        bytes: number;
    }>;
    /**
     * Edit the goal tree through the governed write path.
     *
     * Injected as the *tool instance* rather than re-implemented here: the tool
     * carries the compare-and-set check, the structural gate (L0 needs
     * `userConfirmed`, L1 needs a reason, only a leaf can be deleted) and the audit
     * entry. A second write path would be a second set of rules, and the two would
     * drift until one of them let through something the other refused.
     */
    readonly editTree?: (args: Record<string, unknown>) => Promise<{
        ok: boolean;
        data?: unknown;
        error?: string;
    }>;
}
/**
 * Mount the card's HTTP channel.
 *
 * @param ctx - plugin context.
 * @param options - roots and stores owned by the mount.
 * @returns the disposer removing the route, or `undefined` when the host has no
 *   web server (a headless deployment has nowhere to serve the card either).
 */
export declare function installApi(ctx: HostContext, options: ApiOptions): Disposer | undefined;
/**
 * Hand one path to the desktop shell.
 *
 * `folder` reveals the directory in the file manager; `file` opens the document
 * in whatever is registered for `.md`. Both use the platform's own opener rather
 * than a bundled viewer: the point is to get the user to the file they already
 * have, not to render it here.
 *
 * The process is detached and unref'd so a spawned editor outlives the request
 * that opened it, and its stdio is ignored so it cannot hold the response open.
 *
 * @param target - absolute path to reveal or open.
 * @param what - whether to open the file itself or its containing folder.
 */
export declare function openInShell(target: string, what: 'file' | 'folder'): Promise<{
    ok: boolean;
    error?: string;
}>;
/**
 * The candidate commands for one target, best first.
 *
 * Split out from {@link openInShell} so the decision can be asserted directly: the
 * previous failures were all "the right process was spawned with the wrong
 * arguments", which is invisible when the only observable is a promise resolving
 * `true`.
 *
 * Windows files go through the *shell* rather than a resolved executable. Direct
 * `spawn` of an editor was measured to start and immediately exit, while the
 * shell-mediated routes are what the sidebar plugin settled on for the same
 * reason.
 *
 * @param target - absolute path to open.
 * @param what - file or its containing folder.
 */
export declare function planFor(target: string, what: 'file' | 'folder'): {
    run: string;
    args: string[];
}[];
