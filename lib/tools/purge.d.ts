/**
 * `metacog_purge`: delete the monitor's record for one project.
 *
 * This really deletes. An earlier version moved the directories aside to
 * `purge/<timestamp>/`, on the theory that a monitor's history is too valuable to
 * destroy by accident. In practice that made the tool useless for its actual
 * purpose: the polluted record was still on disk, still counted by anything that
 * walked the directory, and "I cleared it" was not true. A clear that does not
 * clear is worse than no clear at all, because the user stops looking.
 *
 * Two properties are kept, and both exist because this cannot be undone:
 *
 * - **The project id must be typed out.** Not a boolean flag. A confirmation
 *   dialog is dismissed by reflex; retyping an id requires reading it, and it
 *   fails loudly when copied from the wrong project.
 * - **The cost is measured before it happens.** File counts and bytes are counted
 *   first, so the receipt states what was destroyed rather than "done".
 *
 * The goal tree is left alone. Purging is about the record — activities, signals,
 * realtime verdicts, judgements, observations, reports — not about the yardstick.
 * Rebuilding the tree is a separate, version-guarded operation with its own tool.
 *
 * @module dsh-metacog/tools/purge
 */
import { type ToolEnvironment } from './shared.js';
import type { ToolDefinition } from '../host.js';
/**
 * Directories holding a project's record, not its yardstick.
 *
 * `records` scope deletes these and leaves `state/` (the goal tree) alone.
 *
 * The list is exported because the settings card reaches this code through the
 * HTTP route rather than through the tool, and the mount used to keep a second
 * hand-copied list for that path. Two lists meant a directory added to one was
 * silently missed by the other — which is exactly how `archive/`,
 * `activities-archive/` and `rebuilds/` came to survive an `everything` purge
 * while the tool reported the project gone.
 */
export declare const RECORD_DIRS: readonly ["activities", "signals", "verdicts", "preview", "signals-archive", "judgments", "observations", "interventions", "reports", "signal-state", "checkpoint", "snapshots", "file-baseline", "audit", "activities-archive", "archive", "rebuilds"];
/**
 * Everything, including the tree and the session binding.
 *
 * `everything` scope. After this the project is gone from the monitor's point of
 * view: no tree, no record, no pointer to a conversation. Re-deriving is
 * `goal_tree_init`'s job, and the audit trail of the purge itself does not survive
 * it — which is stated in the tool description rather than hidden.
 */
export declare const ALL_DIRS: readonly ["activities", "signals", "verdicts", "preview", "signals-archive", "judgments", "observations", "interventions", "reports", "signal-state", "checkpoint", "snapshots", "file-baseline", "audit", "activities-archive", "archive", "rebuilds", "state", "session"];
/**
 * Directories keyed by project id, holding one *directory* per project.
 *
 * The rest hold one file each (`<projectId>.json`, `<projectId>.jsonl`) under a
 * shared directory whose name is the same for every project. Deleting such a
 * shared directory while purging one project would take every other project's
 * data with it, so these get `<dir>/<projectId>` and the shared parent stays.
 */
export declare const PER_PROJECT_DIRS: ReadonlySet<string>;
/** What the tool returns. */
export interface PurgeResult {
    projectId: string;
    /** Directory names that were deleted. */
    deleted: string[];
    /** Directories that did not exist, so nothing was deleted for them. */
    absent: string[];
    /** Files removed, across every deleted directory. */
    files: number;
    /** Bytes removed, across every deleted directory. */
    bytes: number;
    /** The audit entry that records the purge itself; empty for the `everything` scope. */
    auditEntryId: string;
    /** Which scope was applied. */
    scope: 'records' | 'everything';
    /** Whether there was nothing to delete. */
    empty: boolean;
    next: string;
}
/** Register `metacog_purge`. */
export declare function metacogPurgeTool(env: ToolEnvironment): ToolDefinition;
/**
 * Delete one project's directories, measuring before touching anything.
 *
 * Shared with the settings card's HTTP route, which is why the directory list
 * and the per-project layout rule live in one place instead of being copied.
 * A second copy is how three directories came to be missed by one caller and
 * not the other. The two record files that sit directly under the storage root
 * are covered here for the same reason, with their paths resolved by the module
 * that owns them.
 *
 * @param root - the resolved `.metacog` storage root.
 * @param projectId - the project whose entries to remove.
 * @param scope - `records` keeps `state/` and `session/`.
 * @returns what was deleted, what was not there, and the measured cost.
 */
export declare function deleteDirectories(root: string, projectId: string, scope: 'records' | 'everything'): Promise<{
    present: string[];
    absent: string[];
    files: number;
    bytes: number;
}>;
