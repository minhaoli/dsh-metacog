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

import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { expectationStatePath, failureStatePath } from '../analysis/verdict.js'
import { GateError } from '../governance.js'
import { defineMetacogTool, loadProject, type ToolEnvironment } from './shared.js'
import type { ToolDefinition } from '../host.js'

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
export const RECORD_DIRS = [
  'activities',
  'signals',
  // A verdict is a model's holistic read of an activity window, kept apart from
  // the rule detectors' `signals/` so neither threshold contaminates the other.
  // Separate streams are still the same record: a purge that left this one on
  // disk would report the finding cleared while the finding was still there —
  // the same lie the module comment refuses for the archive directories.
  'verdicts',
  // The two-stage confirmation (`goal_tree_confirm` with `preview: true`) writes
  // `<projectId>.json` here, recording which tree version the user was actually
  // shown. It is a record of that conversation, not the yardstick: leaving it
  // behind would let a later confirm of the same version pass the preview gate
  // without the tree being shown again.
  'preview',
  'signals-archive',
  'judgments',
  'observations',
  'interventions',
  'reports',
  'signal-state',
  'checkpoint',
  'snapshots',
  'file-baseline',
  'audit',
  // Archived copies: the activity stream moved aside by `metacog_archive`. It is
  // the same facts as `activities/`, one generation older, so keeping it would
  // mean a "cleared" record that still holds everything it ever recorded.
  'activities-archive',
  // The tree's own history: milestone snapshots (`archive/`) and the pre-reset
  // backups `resetForRebuild` writes before replacing a tree. Both contain whole
  // goal trees. Leaving them behind made "the project is gone from the monitor's
  // point of view" false in the one way that matters, since the yardstick was
  // still on disk.
  'archive',
  'rebuilds',
] as const

/**
 * Everything, including the tree and the session binding.
 *
 * `everything` scope. After this the project is gone from the monitor's point of
 * view: no tree, no record, no pointer to a conversation. Re-deriving is
 * `goal_tree_init`'s job, and the audit trail of the purge itself does not survive
 * it — which is stated in the tool description rather than hidden.
 */
export const ALL_DIRS = [...RECORD_DIRS, 'state', 'session'] as const

/**
 * Directories keyed by project id, holding one *directory* per project.
 *
 * The rest hold one file each (`<projectId>.json`, `<projectId>.jsonl`) under a
 * shared directory whose name is the same for every project. Deleting such a
 * shared directory while purging one project would take every other project's
 * data with it, so these get `<dir>/<projectId>` and the shared parent stays.
 */
export const PER_PROJECT_DIRS: ReadonlySet<string> = new Set([
  'snapshots',
  'signals-archive',
  'activities-archive',
  'archive',
  'rebuilds',
])

/** What the tool returns. */
export interface PurgeResult {
  projectId: string
  /** Directory names that were deleted. */
  deleted: string[]
  /** Directories that did not exist, so nothing was deleted for them. */
  absent: string[]
  /** Files removed, across every deleted directory. */
  files: number
  /** Bytes removed, across every deleted directory. */
  bytes: number
  /** The audit entry that records the purge itself; empty for the `everything` scope. */
  auditEntryId: string
  /** Which scope was applied. */
  scope: 'records' | 'everything'
  /** Whether there was nothing to delete. */
  empty: boolean
  next: string
}

/** Register `metacog_purge`. */
export function metacogPurgeTool(env: ToolEnvironment): ToolDefinition {
  return defineMetacogTool<PurgeResult>({
    name: 'metacog_purge',
    description:
      'Permanently delete this project\'s monitor record: activities, signals, realtime ' +
      'verdicts, judgements, observations, intervention cards, reports, snapshots and the signal ' +
      'state. The goal tree ' +
      'is NOT touched — use goal_tree_init to rebuild that. THIS IS A REAL DELETE AND CANNOT BE ' +
      'UNDONE. Requires the project id as confirmation, because a boolean is dismissed by reflex ' +
      'and an id is not. Use it when the record is polluted and inflating every statistic, and ' +
      'read the returned file and byte counts before deciding it was what you wanted.',
    parameters: {
      type: 'object',
      properties: {
        confirmProjectId: {
          type: 'string',
          description:
            'Repeat this project\'s id to confirm. Obtain it from goal_tree_view or a report. ' +
            'A mismatch is refused rather than interpreted as consent.',
        },
        reason: {
          type: 'string',
          description:
            'Why the record is being deleted, when there is something worth saying. Optional: ' +
            'the audit entry records what was destroyed either way.',
        },
        scope: {
          type: 'string',
          enum: ['records', 'everything'],
          description:
            'records (default) deletes the monitor record and keeps the goal tree. ' +
            'everything also deletes the tree and the session binding, leaving the ' +
            'project as if it had never been monitored. Both are irreversible.',
        },
      },
      required: ['confirmProjectId'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    async run(args, exec) {
      const input = (args ?? {}) as { confirmProjectId?: unknown; reason?: unknown; scope?: unknown }
      const confirm = typeof input.confirmProjectId === 'string' ? input.confirmProjectId.trim() : ''
      const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
      const scope = input.scope === 'everything' ? 'everything' : 'records'
      // Optional. When it is empty the audit still records exactly what was destroyed,
      // from the counts measured below — which is the part that matters months later. A
      // mandatory sentence mostly produces "x".
      const note = reason.length > 0 ? reason : '(未填写原因)'

      const { projectRoot, projectId, store } = await loadProject(env, exec)

      // The confirmation is compared against the id this call actually resolves to,
      // not against what the caller claims. That way copying an id from another
      // project's report fails instead of destroying this one.
      if (confirm !== projectId) {
        throw new GateError(
          'INVALID_ARGS',
          `confirmation does not match this project (resolved "${projectId}"). ` +
            'Copy the id from goal_tree_view and pass it as confirmProjectId.',
        )
      }

      const state = await store.readState(projectId)
      if (state === undefined && scope === 'records') {
        throw new GateError('NO_TREE', `project "${projectId}" has no tree, so there is nothing to purge`)
      }

      const root = join(projectRoot, env.config.storageSubdir)
      const { present, absent, files, bytes } = await deleteDirectories(root, projectId, scope)

      // Written after the delete, so a failure part-way leaves the caller knowing
      // what actually happened rather than what was planned.
      // Written only for the records scope: `everything` deletes the audit directory
      // itself, so an entry appended afterwards would recreate a directory the caller
      // asked to be rid of.
      let auditEntryId = ''
      if (scope === 'records') {
        const entry = await store.appendStandaloneAudit(projectId, {
          action: 'purge',
          actor: 'manual_tool',
          targetIds: [],
          reason: note,
          evidence: [
            `scope: ${scope}`,
            `deleted: ${present.join(', ') || '(none)'}`,
            `files: ${files}`,
            `bytes: ${bytes}`,
            `absent: ${absent.join(', ') || '(none)'}`,
          ],
        })
        auditEntryId = entry.id
      }

      return {
        projectId,
        deleted: present,
        absent,
        files,
        bytes,
        auditEntryId,
        scope,
        // Reported explicitly, because "deleted 0 directories, 0 files" reads exactly
        // like a button that did nothing. A project that never had a record is a real
        // answer, not a silent no-op, and saying so is the difference between "the
        // tool is broken" and "there was nothing here".
        empty: present.filter((name) => name !== 'state' && name !== 'session').length === 0,
        next:
          present.filter((name) => name !== 'state' && name !== 'session').length === 0
            ? '这个项目本来就没有可删的记录（只有空的目标树文件和会话绑定）。' +
              (scope === 'everything'
                ? '目标树文件已一并删除。'
                : '要连那个空的目标树文件一起删，选「全部清空」。')
            : scope === 'everything'
              ? '全部已删除：记录、目标树、会话绑定都不在了。这个项目对监控来说等同于从未存在过。要重新开始，用 goal_tree_init。'
              : '记录已永久删除，无法恢复。目标树未受影响。要连树一起删，用 scope: "everything"。',
      }
    },
  })
}

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
export async function deleteDirectories(
  root: string,
  projectId: string,
  scope: 'records' | 'everything',
): Promise<{ present: string[]; absent: string[]; files: number; bytes: number }> {
  const targets = scope === 'everything' ? ALL_DIRS : RECORD_DIRS
  const present: string[] = []
  const absent: string[] = []
  let files = 0
  let bytes = 0

  // Record files that sit directly under the storage root instead of in a
  // directory of their own. Their paths come from the module that owns them:
  // copying the two file names here would recreate the drift this list exists
  // to prevent, because a rename in `verdict.ts` could never fail a test that
  // asserts a copied name. Both callers pass `join(projectRoot, storageSubdir)`
  // as `root`, so splitting it recovers the two arguments the helpers take.
  const rootFileByBasename = new Map<string, string>(
    [failureStatePath(dirname(root), basename(root)), expectationStatePath(dirname(root), basename(root))].map(
      (path) => [basename(path), path],
    ),
  )

  for (const name of targets) {
    const target = PER_PROJECT_DIRS.has(name) ? join(root, name, projectId) : join(root, name)
    const size = await measure(target)
    if (size === undefined) {
      absent.push(name)
      continue
    }
    present.push(name)
    files += size.files
    bytes += size.bytes
  }

  // Root-level files are record, not yardstick: removing the failure state is
  // what makes the next failure remind again, and removing the expectation is
  // what makes the next verdict start from `fulfilled: null`. They are measured
  // in the same pass so the receipt counts every file it destroys.
  for (const [name, target] of rootFileByBasename) {
    const size = await measure(target)
    if (size === undefined) {
      absent.push(name)
      continue
    }
    present.push(name)
    files += size.files
    bytes += size.bytes
  }

  for (const name of present) {
    const target =
      rootFileByBasename.get(name) ??
      (PER_PROJECT_DIRS.has(name) ? join(root, name, projectId) : join(root, name))
    await rm(target, { recursive: true, force: true })
    // Leave the empty parent in place so the append path keeps its directory.
    if (PER_PROJECT_DIRS.has(name)) {
      await mkdirSafe(join(root, name))
    }
  }

  return { present, absent, files, bytes }
}

/** Total files and bytes under a path, or `undefined` when it does not exist. */
async function measure(path: string): Promise<{ files: number; bytes: number } | undefined> {
  let info
  try {
    info = await stat(path)
  } catch {
    return undefined
  }
  if (!info.isDirectory()) return { files: 1, bytes: info.size }

  let files = 0
  let bytes = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = await measure(join(path, entry.name))
    if (child === undefined) continue
    files += child.files
    bytes += child.bytes
  }
  return { files, bytes }
}

/** Create a directory, ignoring the case where it already exists. */
async function mkdirSafe(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true })
  } catch {
    // Best effort: an empty parent directory is a convenience, not a requirement.
  }
}
