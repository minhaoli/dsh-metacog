/**
 * Filesystem-backed persistence with per-project isolation, application-level
 * CAS, version snapshots and an append-only hash-chained audit log.
 *
 * Layout under `<projectRoot>/<storageSubdir>/`:
 *
 * ```
 * state/<projectId>.json          current tree state (version-guarded)
 * snapshots/<projectId>/<v>.json  every committed TreeSnapshot
 * observations/<projectId>.jsonl  append-only observation stream
 * activities/<projectId>.jsonl    append-only activity stream
 * signals/<projectId>.jsonl       append-only drift signal stream
 * interventions/<projectId>.jsonl pending/resolved intervention records
 * judgments/<projectId>.jsonl     recorded drift judgements
 * audit/<projectId>.jsonl         append-only hash-chained audit log
 * reports/<projectId>.jsonl       generated reports
 * verdicts/<projectId>.jsonl      realtime bare-LLM verdicts (separate from signals)
 * signal-state/<projectId>.json   aggregation state carried between steps
 * file-baseline/<projectId>.json  file hashes the scanner compares against
 * checkpoint/<projectId>.json     index-build resume point
 * rebuilds/<projectId>/<v>-<t>.json  pre-rebuild tree kept as a restore point
 * session/<projectId>.json        monitor state bound to a session
 * archive/<projectId>/            a purged project's stored records
 * signals-archive/<projectId>/    signals moved out of the live stream
 * activities-archive/<projectId>/ activities moved out of the live stream
 * ```
 *
 * Isolation and integrity rules this module enforces:
 *
 * - Every record carries `projectId`, and every path is derived from it, so two
 *   projects can never read each other's trees, observations or reports.
 * - Structural writes go through {@link TreeStore.commit}, which refuses when
 *   `expectedVersion` does not match what is on disk. There is no silent
 *   overwrite path.
 * - The audit log is append-only in the API surface: there is no update or
 *   delete entry point, and each entry's `entryHash` chains to the previous
 *   one's, so tampering is detectable.
 *
 * @module dsh-metacog/data/store
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

import {
  ActivityRecordSchema,
  AuditLogEntrySchema,
  ContradictionObservationSchema,
  DriftSignalSchema,
  GeneratedReportSchema,
  InterventionRecordSchema,
  JudgmentRecordSchema,
  TreeSnapshotSchema,
  TreeStateSchema,
  GENESIS_HASH,
  type ActivityRecord,
  type AuditAction,
  type AuditActor,
  type AuditLogEntry,
  type ContradictionObservation,
  type DriftSignal,
  type GeneratedReport,
  type GoalNode,
  type ContradictionNode,
  type InterventionRecord,
  type JudgmentRecord,
  type ProjectContext,
  type TreeSnapshot,
  type TreeState,
} from './types.js'
import { SignalStateSchema, type SignalState } from './signals.js'

/**
 * One realtime verdict record.
 *
 * A separate stream from `signals/` on purpose: a signal is a rule detector's
 * output, a verdict is a model's holistic read of a window. They answer
 * different questions, and mixing them would let one chain's threshold
 * contaminate the other's history.
 */
export const VerdictRecordSchema = z.object({
  /** Stable record id, generated when the caller does not supply one. */
  id: z.string().min(1),
  projectId: z.string().min(1),
  /** When the verdict was produced, ISO. */
  at: z.string().min(1),
  /** Start of the activity window this verdict covers, ISO. */
  windowStart: z.string().min(1),
  /** End of the window, ISO (the tick's clock). */
  windowEnd: z.string().min(1),
  /** Alignment score; `null` when the goal was vague and no score was defensible. */
  match: z.number().min(0).max(1).nullable(),
  goalId: z.string().min(1).nullable(),
  reason: z.string(),
  expectNext: z.string(),
  /** `null` when there was no previous expectation to compare against. */
  fulfilled: z.boolean().nullable(),
  provider: z.string(),
  model: z.string(),
  elapsedMs: z.number().int().nonnegative(),
  inputChars: z.number().int().nonnegative(),
  outputChars: z.number().int().nonnegative(),
})
export type VerdictRecord = z.infer<typeof VerdictRecordSchema>
/** Everything a caller supplies; the store mints `id` when it is absent. */
export type VerdictRecordInput = Omit<VerdictRecord, 'id'> & { readonly id?: string }

/** CAS rejection: the caller's `expectedVersion` did not match the store. */
export class VersionConflictError extends Error {
  readonly code = 'VERSION_CONFLICT'
  constructor(
    readonly projectId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `version conflict for project "${projectId}": expected ${expectedVersion}, ` +
        `actual ${actualVersion}. Re-read the tree and retry with the current version.`,
    )
    this.name = 'VersionConflictError'
  }
}

/** Structural precondition the caller cannot satisfy by retrying unchanged. */
export class StoreInvariantError extends Error {
  readonly code = 'STORE_INVARIANT'
  constructor(message: string) {
    super(message)
    this.name = 'StoreInvariantError'
  }
}

/** Manifest written alongside an atomic replacement, for crash recovery. */
interface AtomicWriteOptions {
  /** Content to persist. */
  content: string
  /** Final destination path. */
  path: string
}

/**
 * Write a file atomically: a sibling temp file plus `rename`.
 *
 * `rename` within one directory is atomic on both NTFS and POSIX, so a crash
 * leaves either the old file or the new one, never a truncated mix.
 *
 * @param options - target path and full content.
 */
async function writeFileAtomic({ content, path }: AtomicWriteOptions): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temp, content, 'utf8')
  await rename(temp, path)
}

/**
 * Read a JSON file, returning `undefined` when it does not exist.
 *
 * A file that exists but does not parse is a hard error: treating it as absent
 * would silently reset a project's version counter and break CAS guarantees.
 *
 * @param path - absolute file path.
 * @returns parsed value, or `undefined` when absent.
 */
async function readJsonIfExists(path: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new StoreInvariantError(`corrupt JSON at ${path}: ${String(error)}`)
  }
}

/**
 * Append one JSON line, creating the file when absent.
 *
 * @param path - absolute `.jsonl` path.
 * @param record - JSON-serializable record.
 */
async function appendJsonLine(path: string, record: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // Read-then-write rather than `appendFile`: the store stays free of file
  // handles, so an aborted operation leaves no lingering descriptor, and a
  // torn write can never produce a half line.
  const existing = await readTextIfExists(path)
  const next = `${existing}${JSON.stringify(record)}\n`
  await writeFileAtomic({ path, content: next })
}

/**
 * Read a text file, returning an empty string when it does not exist.
 *
 * @param path - absolute file path.
 */
async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/**
 * Parse a `.jsonl` file into records.
 *
 * A malformed line is a hard error: silently dropping records would let the
 * analyser compute trends over a hole in the history.
 *
 * @param path - absolute `.jsonl` path.
 * @returns parsed records, oldest first.
 */
async function readJsonLines(path: string): Promise<unknown[]> {
  const text = await readTextIfExists(path)
  if (text.length === 0) return []
  const lines = text.split('\n')
  const records: unknown[] = []
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) continue
    try {
      records.push(JSON.parse(line))
    } catch (error) {
      throw new StoreInvariantError(`corrupt JSONL at ${path}:${index + 1}: ${String(error)}`)
    }
  }
  return records
}

/**
 * Canonical serialization for hashing: keys sorted, no whitespace.
 *
 * Hash stability must not depend on property insertion order, so the audit
 * chain hashes this projection rather than `JSON.stringify` of the raw object.
 *
 * @param value - JSON value to canonicalize.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
  return `{${entries.join(',')}}`
}

/**
 * The fields an audit entry hashes. `entryHash` itself is excluded, and
 * `prevHash` is included so the chain covers ordering.
 */
function auditHashPayload(entry: Omit<AuditLogEntry, 'entryHash'>): string {
  return canonicalize({
    id: entry.id,
    projectId: entry.projectId,
    timestamp: entry.timestamp,
    actor: entry.actor,
    action: entry.action,
    beforeVersion: entry.beforeVersion,
    afterVersion: entry.afterVersion,
    targetIds: entry.targetIds,
    reason: entry.reason,
    evidence: entry.evidence,
    prevHash: entry.prevHash,
  })
}

/**
 * Compute an audit entry's SHA-256 hash.
 *
 * @param entry - the entry without its own `entryHash`.
 * @returns lowercase hex digest.
 */
export function computeAuditHash(entry: Omit<AuditLogEntry, 'entryHash'>): string {
  return createHash('sha256').update(auditHashPayload(entry), 'utf8').digest('hex')
}

/** Result of verifying a project's audit chain. */
export interface AuditVerification {
  /** Whether every link and hash checked out. */
  valid: boolean
  /** Number of entries examined. */
  entries: number
  /** Human-readable reasons, empty when `valid`. */
  problems: string[]
}

/** What a caller must supply to commit a structural change. */
export interface CommitRequest {
  /** Version the caller read; must equal the stored version. */
  expectedVersion: number
  /** Goal nodes after the change. */
  goals: GoalNode[]
  /** Contradiction nodes after the change. */
  contradictions: ContradictionNode[]
  /** Why this change is happening; recorded in the snapshot and audit log. */
  reason: string
  /** Audit action class. */
  action: AuditAction
  /** Who is acting. */
  actor: AuditActor
  /** Node ids the change touched. */
  targetIds: string[]
  /** Evidence supporting the change. */
  evidence?: string[]
  /** Mark the project confirmed (used by `goal_tree_confirm`). */
  markConfirmed?: boolean
}

/** Outcome of a successful commit. */
export interface CommitResult {
  /** The new tree state. */
  state: TreeState
  /** The snapshot written for the new version. */
  snapshot: TreeSnapshot
  /** The audit entry appended for the new version. */
  audit: AuditLogEntry
}

/**
 * Per-project persistence facade.
 *
 * One instance is created per project root; every method takes or derives a
 * `projectId`, and the id is part of every path, so cross-project reads are
 * structurally impossible rather than merely discouraged.
 */
export class MetacogStore {
  /** Absolute directory holding this project's persisted state. */
  readonly root: string
  private readonly queued = new Map<string, Promise<unknown>>()

  /**
   * @param projectRoot - absolute project root directory.
   * @param storageSubdir - relative directory for this plugin's state.
   */
  constructor(
    readonly projectRoot: string,
    readonly storageSubdir: string,
  ) {
    this.root = join(projectRoot, storageSubdir)
  }

  private statePath(projectId: string): string {
    return join(this.root, 'state', `${projectId}.json`)
  }
  private snapshotDir(projectId: string): string {
    return join(this.root, 'snapshots', projectId)
  }
  private snapshotPath(projectId: string, version: number): string {
    return join(this.snapshotDir(projectId), `${version}.json`)
  }
  private milestoneArchiveDir(projectId: string): string {
    return join(this.root, 'archive', projectId)
  }
  private fileBaselinePath(projectId: string): string {
    return join(this.root, 'file-baseline', `${projectId}.json`)
  }
  private observationsPath(projectId: string): string {
    return join(this.root, 'observations', `${projectId}.jsonl`)
  }
  private activitiesPath(projectId: string): string {
    return join(this.root, 'activities', `${projectId}.jsonl`)
  }
  private signalsPath(projectId: string): string {
    return join(this.root, 'signals', `${projectId}.jsonl`)
  }
  private signalStatePath(projectId: string): string {
    return join(this.root, 'signal-state', `${projectId}.json`)
  }
  /**
   * Read the cross-step signal state, or `undefined` before the first step.
   *
   * Absence is meaningful and is preserved: a project with no state has never
   * been scored, which is different from a project scored at zero.
   *
   * @param projectId - owning project.
   */
  async readSignalState(projectId: string): Promise<SignalState | undefined> {
    try {
      const raw = await readFile(this.signalStatePath(projectId), 'utf8')
      return SignalStateSchema.parse(JSON.parse(raw))
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code === 'ENOENT') return undefined
      throw error
    }
  }
  /**
   * Persist the cross-step signal state.
   *
   * Written whole rather than appended: the state is a single current value, and
   * an append log would make every read replay the whole history to find it.
   *
   * @param state - validated state.
   */
  async writeSignalState(state: SignalState): Promise<SignalState> {
    const parsed = SignalStateSchema.parse(state)
    await this.withProjectLock(parsed.projectId, async () => {
      await writeFileAtomic({
        path: this.signalStatePath(parsed.projectId),
        content: `${JSON.stringify(parsed, null, 2)}\n`,
      })
    })
    return parsed
  }
  private signalsArchiveDir(projectId: string): string {
    return join(this.root, 'signals-archive', projectId)
  }
  private activitiesArchiveDir(projectId: string): string {
    return join(this.root, 'activities-archive', projectId)
  }
  private interventionsPath(projectId: string): string {
    return join(this.root, 'interventions', `${projectId}.jsonl`)
  }
  private judgmentsPath(projectId: string): string {
    return join(this.root, 'judgments', `${projectId}.jsonl`)
  }
  private auditPath(projectId: string): string {
    return join(this.root, 'audit', `${projectId}.jsonl`)
  }
  private reportsPath(projectId: string): string {
    return join(this.root, 'reports', `${projectId}.jsonl`)
  }
  private verdictsPath(projectId: string): string {
    return join(this.root, 'verdicts', `${projectId}.jsonl`)
  }

  /**
   * Serialize every mutation of one project.
   *
   * Two tool calls (or a tool call and a periodic check) can reach this store
   * concurrently in the same process; without a per-project queue both would
   * read the same version and the second rename would silently win. The queue
   * makes read-check-write atomic within the process, and {@link commit}'s
   * version comparison covers everything else.
   *
   * @param projectId - project whose lock to take.
   * @param operation - work to run under the lock.
   */
  private async withProjectLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queued.get(projectId) ?? Promise.resolve()
    // Swallow the predecessor's rejection: this task's own result is what
    // matters, and an unhandled rejection here would mask the real error.
    const current = previous.then(operation, operation)
    this.queued.set(
      projectId,
      current.then(
        () => undefined,
        () => undefined,
      ),
    )
    try {
      return await current
    } finally {
      if (this.queued.get(projectId) === undefined) this.queued.delete(projectId)
    }
  }

  /**
   * Read a project's current tree state.
   *
   * @param projectId - project to read.
   * @returns the state, or `undefined` when the project has never been initialised.
   */
  async readState(projectId: string): Promise<TreeState | undefined> {
    const raw = await readJsonIfExists(this.statePath(projectId))
    if (raw === undefined) return undefined
    return TreeStateSchema.parse(raw)
  }

  /**
   * Initialise a project's tree state, or overwrite an unconfirmed draft.
   *
   * `goal_tree_init` uses this to replace the candidate tree; a project that is
   * already confirmed refuses re-initialisation so a stray call cannot discard
   * user-confirmed structure.
   *
   * @param projectId - project to initialise.
   * @param goals - candidate goal nodes.
   * @param contradictions - candidate contradiction nodes.
   * @param options.force - replace an existing unconfirmed draft.
   * @returns the new state at version 0 (confirmation bumps it to 1).
   */
  async initialize(
    projectId: string,
    goals: GoalNode[],
    contradictions: ContradictionNode[],
    options: { force?: boolean; projectContext?: ProjectContext } = {},
  ): Promise<TreeState> {
    return this.withProjectLock(projectId, async () => {
      const existing = await this.readState(projectId)
      if (existing?.confirmed === true) {
        throw new StoreInvariantError(
          `project "${projectId}" already has a confirmed tree (version ${existing.version}); ` +
            `re-initialisation is refused. Use the edit tools to change confirmed structure.`,
        )
      }
      if (existing !== undefined && options.force !== true) {
        throw new StoreInvariantError(
          `project "${projectId}" already has an unconfirmed draft (version ${existing.version}); ` +
            `pass force: true to replace it.`,
        )
      }
      const now = new Date().toISOString()
      // Project context survives re-initialisation unless a new one is supplied:
      // it describes the user and the project, not the tree being rebuilt.
      const projectContext =
        options.projectContext === undefined
          ? existing?.projectContext
          : { ...options.projectContext, updatedAt: now }
      // An existing project keeps its current version number. Rewinding to 0
      // would make the next confirmation reuse a version whose snapshot is
      // already on disk, silently overwriting the tree that was just replaced.
      const state: TreeState = TreeStateSchema.parse({
        projectId,
        // Remember the path this id came from: the id is a hash, so this is the
        // only way a later process can rebuild the store without a tool call.
        projectRoot: this.projectRoot,
        version: existing?.version ?? 0,
        confirmed: false,
        ...(projectContext === undefined ? {} : { projectContext }),
        goals,
        contradictions,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      await writeFileAtomic({ path: this.statePath(projectId), content: JSON.stringify(state) })
      return state
    })
  }

  /**
   * Clear a confirmed tree so it can be derived again from scratch.
   *
   * Re-derivation is normally refused because the tree is the yardstick: an
   * activity judged aligned against "T3" yesterday would refer to a goal that no
   * longer exists today. That reasoning holds for *drift*, not for a user who
   * says the project itself is being restated — so the refusal is lifted under
   * two conditions that a stray call cannot satisfy by accident:
   *
   * - `expectedVersion` must equal the stored version, which proves the caller
   *   read the current tree before discarding it;
   * - the previous tree is copied to `rebuilds/<projectId>/` and the reset is
   *   recorded as a `tree_reset` audit entry, so the discard is reversible and
   *   visible in the chain.
   *
   * The version number is deliberately not rewound. Snapshots are stored per
   * version, so reusing a number would overwrite the tree that was just
   * replaced; the next confirmation simply commits the version after it.
   *
   * Observation, activity and signal streams are left untouched: they are
   * append-only history, and records naming contradictions from the replaced
   * tree simply never match the new ids.
   *
   * @param projectId - project to reset.
   * @param options.expectedVersion - version the caller believes is current.
   * @param options.reason - why the tree is being discarded; written to the audit log.
   * @returns the cleared state, the backup path and the audit entry id.
   * @throws {VersionConflictError} when `expectedVersion` is stale.
   * @throws {StoreInvariantError} when there is no confirmed tree to reset.
   */
  async resetForRebuild(
    projectId: string,
    options: { expectedVersion: number; reason: string },
  ): Promise<{ state: TreeState; backupPath: string; auditEntryId: string }> {
    return this.withProjectLock(projectId, async () => {
      const existing = await this.readState(projectId)
      if (existing === undefined) {
        throw new StoreInvariantError(
          `project "${projectId}" has no tree to rebuild; run goal_tree_init first.`,
        )
      }
      if (existing.version !== options.expectedVersion) {
        throw new VersionConflictError(projectId, options.expectedVersion, existing.version)
      }
      if (existing.confirmed !== true) {
        throw new StoreInvariantError(
          `project "${projectId}" is not confirmed (version ${existing.version}); ` +
            'pass force: true to replace the draft instead of resetting a confirmed tree.',
        )
      }

      const now = new Date().toISOString()
      // Colons and dots are legal on NTFS but break copy-paste and shell use, so
      // the timestamp is flattened before it becomes part of a filename.
      const stamp = now.replace(/[:.]/g, '-')
      const backupPath = join(this.root, 'rebuilds', projectId, `${existing.version}-${stamp}.json`)
      await writeFileAtomic({ path: backupPath, content: JSON.stringify(existing, null, 2) })

      const audit = await this.appendAudit(projectId, {
        actor: 'user_confirmed',
        action: 'tree_reset',
        beforeVersion: existing.version,
        afterVersion: existing.version,
        targetIds: [
          ...existing.goals.map((node) => node.id),
          ...existing.contradictions.map((node) => node.id),
        ],
        reason: options.reason,
        evidence: [],
      })

      const state: TreeState = TreeStateSchema.parse({
        projectId,
        projectRoot: this.projectRoot,
        version: existing.version,
        confirmed: false,
        ...(existing.projectContext === undefined
          ? {}
          : { projectContext: existing.projectContext }),
        goals: [],
        contradictions: [],
        createdAt: existing.createdAt,
        updatedAt: now,
      })
      await writeFileAtomic({ path: this.statePath(projectId), content: JSON.stringify(state) })
      return { state, backupPath, auditEntryId: audit.id }
    })
  }

  /**
   * Rewrite a tree written before goals carried `depth`.
   *
   * Reading already tolerates the legacy `level` field, so this is not what makes an
   * old project usable — it is what makes the conversion auditable. Without it, the
   * old records would be silently reinterpreted on every read and the audit chain
   * would keep no trace of the change.
   *
   * Idempotent: a project that already carries `depth` is left untouched.
   *
   * @param projectId - project to migrate.
   * @returns whether a migration was written.
   */
  async migrateLegacyTree(projectId: string): Promise<boolean> {
    return this.withProjectLock(projectId, async () => {
      const raw = await readJsonIfExists(this.statePath(projectId))
      if (raw === null || typeof raw !== 'object') return false
      const rawGoals = (raw as { goals?: unknown }).goals
      const usesLevel =
        Array.isArray(rawGoals) &&
        rawGoals.some(
          (node) =>
            node !== null &&
            typeof node === 'object' &&
            'level' in (node as Record<string, unknown>) &&
            !('depth' in (node as Record<string, unknown>)),
        )
      if (!usesLevel) return false

      const current = TreeStateSchema.parse(raw)
      const now = new Date().toISOString()
      const nextVersion = current.version + 1
      const snapshot: TreeSnapshot = TreeSnapshotSchema.parse({
        version: nextVersion,
        projectId,
        createdAt: now,
        reason: 'goal level migrated to depth',
        goals: current.goals,
        contradictions: current.contradictions,
      })
      await this.appendAudit(projectId, {
        actor: 'system_auto',
        action: 'migrate_goal_depth',
        beforeVersion: current.version,
        afterVersion: nextVersion,
        targetIds: current.goals.map((node) => node.id),
        reason: 'goal level (L0-L3) migrated to depth (0-3); no structural change',
        evidence: [],
      })
      await writeFileAtomic({
        path: this.snapshotPath(projectId, nextVersion),
        content: JSON.stringify(snapshot),
      })
      const state: TreeState = TreeStateSchema.parse({
        ...current,
        version: nextVersion,
        updatedAt: now,
      })
      await writeFileAtomic({ path: this.statePath(projectId), content: JSON.stringify(state) })
      return true
    })
  }

  /**
   * Read the stored project context.
   *
   * @param projectId - project to read.
   * @returns the context, or `undefined` when never supplied.
   */
  async readProjectContext(projectId: string): Promise<ProjectContext | undefined> {
    const state = await this.readState(projectId)
    return state?.projectContext
  }

  /**
   * Store or replace the project context without touching the tree.
   *
   * Deliberately not a versioned structural change: the context describes the
   * setting the tree lives in, and editing it must not invalidate confirmed
   * nodes or produce snapshots that differ only in prose.
   *
   * @param projectId - project to update.
   * @param context - the new context.
   * @returns the context as stored.
   */
  async setProjectContext(projectId: string, context: ProjectContext): Promise<ProjectContext> {
    return this.withProjectLock(projectId, async () => {
      const existing = await this.readState(projectId)
      if (existing === undefined) {
        throw new StoreInvariantError(
          `project "${projectId}" has no tree state; run goal_tree_init first.`,
        )
      }
      const now = new Date().toISOString()
      const next: ProjectContext = { ...context, updatedAt: now }
      const state: TreeState = TreeStateSchema.parse({
        ...existing,
        projectContext: next,
        updatedAt: now,
      })
      await writeFileAtomic({ path: this.statePath(projectId), content: JSON.stringify(state) })
      return next
    })
  }

  /**
   * Read the dedicated metacognitive session id.
   *
   * Kept beside the project state rather than inside it: the binding must exist
   * *before* any tree does, because the session is where the tree gets derived.
   * Storing it on `TreeState` would create a chicken-and-egg requirement.
   *
   * @param projectId - project to read.
   * @returns the session id, or `undefined` when none was recorded.
   */
  async readMetacogSessionId(projectId: string): Promise<string | undefined> {
    const path = join(this.root, 'session', `${projectId}.json`)
    const raw = await readJsonIfExists(path)
    if (raw === undefined) return undefined
    const parsed = raw as { sessionId?: unknown }
    return typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0
      ? parsed.sessionId
      : undefined
  }

  /**
   * Record the dedicated metacognitive session id.
   *
   * Deliberately independent of the tree: initialisation binds the session
   * first, then derives the tree inside it.
   *
   * @param projectId - project to update.
   * @param sessionId - the session that owns initialisation.
   */
  async setMetacogSessionId(projectId: string, sessionId: string): Promise<void> {
    await this.withProjectLock(projectId, async () => {
      const path = join(this.root, 'session', `${projectId}.json`)
      await writeFileAtomic({
        path,
        content: JSON.stringify({ projectId, sessionId, boundAt: new Date().toISOString() }),
      })
    })
  }

  /**
   * Read when the monitor last reported back to the user.
   *
   * A judgement window is not a fixed period. "The last 24 hours" re-judges work
   * the user already answered and skips work older than a day that was never
   * judged at all. The honest boundary is the previous report: everything that
   * happened since then, and nothing before it.
   *
   * @param projectId - project to read.
   * @returns ISO timestamp of the last report, or `undefined` when never reported.
   */
  async readCheckpoint(projectId: string): Promise<string | undefined> {
    const path = join(this.root, 'checkpoint', `${projectId}.json`)
    const raw = await readJsonIfExists(path)
    if (raw === undefined) return undefined
    const parsed = raw as { lastReportAt?: unknown }
    return typeof parsed.lastReportAt === 'string' && parsed.lastReportAt.length > 0
      ? parsed.lastReportAt
      : undefined
  }

  /**
   * Record that the monitor has just reported to the user.
   *
   * Written only after a report actually reached them: moving the boundary on a
   * failed call would silently drop the activities it never judged.
   *
   * @param projectId - project to update.
   * @param at - ISO timestamp of the report.
   */
  async setCheckpoint(projectId: string, at: string): Promise<void> {
    await this.withProjectLock(projectId, async () => {
      const path = join(this.root, 'checkpoint', `${projectId}.json`)
      await writeFileAtomic({
        path,
        content: JSON.stringify({ projectId, lastReportAt: at }),
      })
    })
  }

  /**
   * Read the realtime verdict window start.
   *
   * A separate file from the report checkpoint on purpose: the 5-minute
   * verdict and the 25-minute sweep cover different questions and must not
   * advance each other's window. Sharing one would make whichever runs first
   * silently starve the other of activities.
   *
   * @param projectId - project to read.
   * @returns ISO timestamp of the last realtime tick, or `undefined`.
   */
  async readRealtimeCheckpoint(projectId: string): Promise<string | undefined> {
    const path = join(this.root, 'checkpoint', 'realtime', `${projectId}.json`)
    const raw = await readJsonIfExists(path)
    if (raw === undefined) return undefined
    const parsed = raw as { lastVerdictAt?: unknown }
    return typeof parsed.lastVerdictAt === 'string' && parsed.lastVerdictAt.length > 0
      ? parsed.lastVerdictAt
      : undefined
  }

  /**
   * Record the end of the last realtime window.
   *
   * Written only after a successful verdict or an idle window, never after a
   * failed call: a failure must retry the same activities on the next tick.
   *
   * @param projectId - project to update.
   * @param at - ISO timestamp of the tick.
   */
  async setRealtimeCheckpoint(projectId: string, at: string): Promise<void> {
    await this.withProjectLock(projectId, async () => {
      const path = join(this.root, 'checkpoint', 'realtime', `${projectId}.json`)
      await writeFileAtomic({
        path,
        content: JSON.stringify({ projectId, lastVerdictAt: at }),
      })
    })
  }

  /**
   * Append one realtime verdict record.
   *
   * Kept out of the `signals/` stream deliberately: a verdict is a model's
   * holistic read, a signal is a rule detector's finding. The two chains keep
   * separate histories so neither threshold contaminates the other.
   *
   * @param input - verdict fields; `id` is minted when absent.
   * @returns the validated record as written.
   */
  async appendVerdict(input: VerdictRecordInput): Promise<VerdictRecord> {
    const record = VerdictRecordSchema.parse({
      ...input,
      id: input.id ?? `verdict_${randomUUID()}`,
    })
    await this.withProjectLock(record.projectId, async () => {
      await appendJsonLine(this.verdictsPath(record.projectId), record)
    })
    return record
  }

  /**
   * Read a project's verdict stream, optionally bounded by `at`.
   *
   * @param projectId - owning project.
   * @param options.since - inclusive lower bound on `at`.
   * @param options.until - inclusive upper bound on `at`.
   * @returns records oldest first.
   */
  async readVerdicts(
    projectId: string,
    options: { since?: Date; until?: Date } = {},
  ): Promise<VerdictRecord[]> {
    const raw = await readJsonLines(this.verdictsPath(projectId))
    const parsed = raw.map((item) => VerdictRecordSchema.parse(item))
    const since = options.since?.getTime()
    const until = options.until?.getTime()
    return parsed.filter((record) => {
      const at = Date.parse(record.at)
      if (!Number.isFinite(at)) return false
      if (since !== undefined && at < since) return false
      if (until !== undefined && at > until) return false
      return true
    })
  }

  /**
   * Commit a structural change under CAS.
   *
   * Performs, in one project-locked critical section: version comparison, state
   * write, snapshot write, audit append. A mismatch throws
   * {@link VersionConflictError} and touches nothing.
   *
   * @param projectId - project to mutate.
   * @param request - the change and its audit metadata.
   * @returns the committed state, snapshot and audit entry.
   * @throws {VersionConflictError} when `expectedVersion` is stale.
   */
  async commit(projectId: string, request: CommitRequest): Promise<CommitResult> {
    return this.withProjectLock(projectId, async () => {
      const current = await this.readState(projectId)
      // A project may be confirmed without a prior draft. The derivation path
      // never writes an intermediate empty tree — an empty draft would read as
      // "this project has no objectives" — so the first commit is also the
      // first write. Version 0 is accepted as "no tree yet".
      if (current === undefined) {
        if (request.expectedVersion !== 0) {
          throw new VersionConflictError(projectId, request.expectedVersion, 0)
        }
      } else if (current.version !== request.expectedVersion) {
        throw new VersionConflictError(projectId, request.expectedVersion, current.version)
      }

      const now = new Date().toISOString()
      const nextVersion = current === undefined ? 1 : current.version + 1
      const base: TreeState =
        current === undefined
          ? TreeStateSchema.parse({
              projectId,
              projectRoot: this.projectRoot,
              version: 0,
              confirmed: false,
              goals: [],
              contradictions: [],
              createdAt: now,
              updatedAt: now,
            })
          : current
      const state: TreeState = TreeStateSchema.parse({
        ...base,
        version: nextVersion,
        confirmed: request.markConfirmed === true ? true : base.confirmed,
        goals: request.goals,
        contradictions: request.contradictions,
        updatedAt: now,
      })
      const snapshot: TreeSnapshot = TreeSnapshotSchema.parse({
        version: nextVersion,
        projectId,
        createdAt: now,
        reason: request.reason,
        goals: request.goals,
        contradictions: request.contradictions,
      })

      // Append the audit entry before publishing state: if the audit write
      // fails, the state file still carries the old version and the caller can
      // retry safely.
      const audit = await this.appendAudit(projectId, {
        actor: request.actor,
        action: request.action,
        beforeVersion: current?.version ?? 0,
        afterVersion: nextVersion,
        targetIds: request.targetIds,
        reason: request.reason,
        evidence: request.evidence ?? [],
      })

      await writeFileAtomic({
        path: this.snapshotPath(projectId, nextVersion),
        content: JSON.stringify(snapshot),
      })
      await writeFileAtomic({ path: this.statePath(projectId), content: JSON.stringify(state) })

      return { state, snapshot, audit }
    })
  }

  /**
   * Read one historical snapshot.
   *
   * Reports bind to the version they were generated against, so this must keep
   * working after later versions exist.
   *
   * @param projectId - project to read.
   * @param version - snapshot version.
   * @returns the snapshot, or `undefined` when that version was never written.
   */
  async readSnapshot(projectId: string, version: number): Promise<TreeSnapshot | undefined> {
    const raw = await readJsonIfExists(this.snapshotPath(projectId, version))
    if (raw === undefined) return undefined
    return TreeSnapshotSchema.parse(raw)
  }

  /**
   * List every snapshot written for a project.
   *
   * Read-only and unbounded by design: the number of snapshots is the number of
   * structural changes, which reports need in full to compare a period's start
   * against its end.
   *
   * @param projectId - project to read.
   * @returns snapshots oldest version first.
   */
  async listSnapshots(projectId: string): Promise<TreeSnapshot[]> {
    const directory = join(this.root, 'snapshots', projectId)
    let names: string[]
    try {
      names = await readdir(directory)
    } catch {
      return []
    }
    const versions = names
      .filter((name) => name.endsWith('.json'))
      .map((name) => Number.parseInt(name.slice(0, -5), 10))
      .filter((version) => Number.isInteger(version) && version >= 0)
      .sort((left, right) => left - right)
    const snapshots: TreeSnapshot[] = []
    for (const version of versions) {
      const raw = await readJsonIfExists(this.snapshotPath(projectId, version))
      if (raw !== undefined) snapshots.push(TreeSnapshotSchema.parse(raw))
    }
    return snapshots
  }

  /**
   * Read the audit chain for a project.
   *
   * @param projectId - project to read.
   * @returns entries oldest first.
   */
  async readAuditLog(projectId: string): Promise<AuditLogEntry[]> {
    const raw = await readJsonLines(this.auditPath(projectId))
    return raw.map((entry) => AuditLogEntrySchema.parse(entry))
  }

  /**
   * Append one audit entry, linking it to the previous entry's hash.
   *
   * Not exported as a tool and not reachable from the interaction layer: the
   * only way an entry enters the log is through a governed commit.
   *
   * @param projectId - project to append to.
   * @param fields - the entry minus id/timestamp/hashes.
   * @returns the appended entry.
   */
  private async appendAudit(
    projectId: string,
    fields: Omit<AuditLogEntry, 'id' | 'projectId' | 'timestamp' | 'prevHash' | 'entryHash'>,
  ): Promise<AuditLogEntry> {
    const existing = await this.readAuditLog(projectId)
    const previous = existing[existing.length - 1]
    const prevHash = previous?.entryHash ?? GENESIS_HASH
    const draft: Omit<AuditLogEntry, 'entryHash'> = {
      id: `audit_${randomUUID()}`,
      projectId,
      timestamp: new Date().toISOString(),
      ...fields,
      prevHash,
    }
    const entry: AuditLogEntry = AuditLogEntrySchema.parse({
      ...draft,
      entryHash: computeAuditHash(draft),
    })
    await appendJsonLine(this.auditPath(projectId), entry)
    return entry
  }

  /**
   * Verify a project's audit chain end to end.
   *
   * Checks three things per entry: the recomputed hash equals the stored one,
   * `prevHash` equals the previous entry's `entryHash`, and the very first
   * entry links to {@link GENESIS_HASH}.
   *
   * @param projectId - project to verify.
   * @returns verification outcome with concrete problems listed.
   */
  async verifyAuditChain(projectId: string): Promise<AuditVerification> {
    const entries = await this.readAuditLog(projectId)
    const problems: string[] = []
    let expectedPrev = GENESIS_HASH
    for (const [index, entry] of entries.entries()) {
      if (entry.prevHash !== expectedPrev) {
        problems.push(
          `entry ${index} (${entry.id}): prevHash ${entry.prevHash} does not match expected ${expectedPrev}`,
        )
      }
      const { entryHash, ...rest } = entry
      const recomputed = computeAuditHash(rest)
      if (recomputed !== entryHash) {
        problems.push(
          `entry ${index} (${entry.id}): entryHash ${entryHash} does not match recomputed ${recomputed}`,
        )
      }
      expectedPrev = entryHash
    }
    return { valid: problems.length === 0, entries: entries.length, problems }
  }

  /**
   * Append an audit entry for an event that does not change the tree.
   *
   * `resolve_intervention` is the case this exists for: recording a user's
   * decision is auditable (spec 2.4 lists the action) but leaves both trees
   * untouched, so it must not consume a version. `beforeVersion` and
   * `afterVersion` are therefore identical, and the hash chain still extends.
   *
   * @param projectId - project to append to.
   * @param fields - the entry minus id/timestamp/hashes/versions.
   * @returns the appended entry.
   */
  async appendStandaloneAudit(
    projectId: string,
    fields: Omit<
      AuditLogEntry,
      'id' | 'projectId' | 'timestamp' | 'prevHash' | 'entryHash' | 'beforeVersion' | 'afterVersion'
    >,
  ): Promise<AuditLogEntry> {
    return this.withProjectLock(projectId, async () => {
      const current = await this.readState(projectId)
      const version = current?.version ?? 0
      return this.appendAudit(projectId, {
        ...fields,
        beforeVersion: version,
        afterVersion: version,
      })
    })
  }

  /**
   * Append a contradiction observation.
   *
   * @param projectId - owning project.
   * @param observation - validated observation record.
   */
  async appendObservation(
    projectId: string,
    observation: ContradictionObservation,
  ): Promise<ContradictionObservation> {
    const parsed = ContradictionObservationSchema.parse(observation)
    if (parsed.projectId !== projectId) {
      throw new StoreInvariantError(
        `observation projectId "${parsed.projectId}" does not match "${projectId}"`,
      )
    }
    await this.withProjectLock(projectId, async () => {
      await appendJsonLine(this.observationsPath(projectId), parsed)
    })
    return parsed
  }

  /**
   * Read a project's observation stream.
   *
   * @param projectId - owning project.
   * @param options.since - inclusive lower bound on `observedAt`.
   * @returns observations oldest first.
   */
  async readObservations(
    projectId: string,
    options: { since?: Date } = {},
  ): Promise<ContradictionObservation[]> {
    const raw = await readJsonLines(this.observationsPath(projectId))
    const parsed = raw.map((item) => ContradictionObservationSchema.parse(item))
    if (options.since === undefined) return parsed
    const cutoff = options.since.getTime()
    return parsed.filter((item) => Date.parse(item.observedAt) >= cutoff)
  }

  /**
   * Append an activity record.
   *
   * @param projectId - owning project.
   * @param record - validated activity record.
   */
  async appendActivity(projectId: string, record: ActivityRecord): Promise<ActivityRecord> {
    const parsed = ActivityRecordSchema.parse(record)
    if (parsed.projectId !== projectId) {
      throw new StoreInvariantError(
        `activity projectId "${parsed.projectId}" does not match "${projectId}"`,
      )
    }
    await this.withProjectLock(projectId, async () => {
      await appendJsonLine(this.activitiesPath(projectId), parsed)
    })
    return parsed
  }

  /**
   * Read a project's activity stream.
   *
   * @param projectId - owning project.
   * @param options.since - inclusive lower bound on `timestamp`.
   */
  async readActivities(projectId: string, options: { since?: Date } = {}): Promise<ActivityRecord[]> {
    const raw = await readJsonLines(this.activitiesPath(projectId))
    const parsed = raw.map((item) => ActivityRecordSchema.parse(item))
    if (options.since === undefined) return parsed
    const cutoff = options.since.getTime()
    return parsed.filter((item) => Date.parse(item.timestamp) >= cutoff)
  }

  /**
   * Find an activity by its dedupe fingerprint.
   *
   * @param projectId - owning project.
   * @param eventFingerprint - fingerprint to look for.
   * @returns the existing record, or `undefined`.
   */
  async findActivityByFingerprint(
    projectId: string,
    eventFingerprint: string,
  ): Promise<ActivityRecord | undefined> {
    const activities = await this.readActivities(projectId)
    return activities.find((item) => item.eventFingerprint === eventFingerprint)
  }

  /**
   * Append a drift signal.
   *
   * @param projectId - owning project.
   * @param signal - validated signal record.
   */
  async appendSignal(projectId: string, signal: DriftSignal): Promise<DriftSignal> {
    const parsed = DriftSignalSchema.parse(signal)
    if (parsed.projectId !== projectId) {
      throw new StoreInvariantError(
        `signal projectId "${parsed.projectId}" does not match "${projectId}"`,
      )
    }
    await this.withProjectLock(projectId, async () => {
      await appendJsonLine(this.signalsPath(projectId), parsed)
    })
    return parsed
  }

  /**
   * Read a project's drift signal stream.
   *
   * @param projectId - owning project.
   * @param options.since - inclusive lower bound on `observedAt`.
   */
  async readSignals(projectId: string, options: { since?: Date } = {}): Promise<DriftSignal[]> {    const raw = await readJsonLines(this.signalsPath(projectId))
    const parsed = raw.map((item) => DriftSignalSchema.parse(item))
    if (options.since === undefined) return parsed
    const cutoff = options.since.getTime()
    return parsed.filter((item) => Date.parse(item.observedAt) >= cutoff)
  }

  /**
   * Move every stored signal into an archive file and empty the live stream.
   *
   * Signals are evidence of what the rules once said, so deleting them would erase
   * the only record of how the monitor behaved. Keeping them live is equally wrong:
   * a batch produced by a collector that no longer exists keeps inflating every
   * level count and repeat tally, which is how 1459 stale `scope_drift` rows made
   * the escalation statistics meaningless.
   *
   * The archive is one file per run, named by the moment it was taken, so the
   * history stays readable and nothing is overwritten.
   *
   * @param projectId - owning project.
   * @param reason - why the archive is being taken; recorded beside the data.
   * @returns how many signals moved, and where they went.
   */
  async archiveSignals(
    projectId: string,
    reason: string,
  ): Promise<{ archived: number; path: string | null }> {
    return this.withProjectLock(projectId, async () => {
      const live = await this.readSignals(projectId)
      if (live.length === 0) return { archived: 0, path: null }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const directory = this.signalsArchiveDir(projectId)
      const path = join(directory, `${stamp}.jsonl`)
      await mkdir(directory, { recursive: true })
      await writeFileAtomic({
        path,
        content: live.map((signal) => JSON.stringify(signal)).join('\n') + '\n',
      })
      await writeFileAtomic({ path: `${path}.meta.json`, content: JSON.stringify({ projectId, reason, archivedAt: new Date().toISOString(), count: live.length }) })
      // Empty rather than delete: the file must keep existing so the append path
      // does not have to recreate its directory on the next signal.
      await writeFileAtomic({ path: this.signalsPath(projectId), content: '' })
      return { archived: live.length, path }
    })
  }

  /**
   * Move the activity stream into a dated archive and empty it.
   *
   * Mirrors `archiveSignals`, with one difference that matters: emptying this stream
   * breaks the link from every past judgement back to the activity it judged. The
   * judgement rows keep their `activityIds`, and those ids now point at an archive
   * rather than at the live stream. That is why the tool makes it opt-in.
   *
   * @param projectId - owning project.
   * @param reason - why, stored beside the archive.
   * @returns how many moved and where.
   */
  async archiveActivities(
    projectId: string,
    reason: string,
  ): Promise<{ archived: number; path: string | null }> {
    return this.withProjectLock(projectId, async () => {
      const live = await this.readActivities(projectId)
      if (live.length === 0) return { archived: 0, path: null }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const directory = this.activitiesArchiveDir(projectId)
      const path = join(directory, `${stamp}.jsonl`)
      await mkdir(directory, { recursive: true })
      await writeFileAtomic({
        path,
        content: live.map((activity) => JSON.stringify(activity)).join('\n') + '\n',
      })
      await writeFileAtomic({
        path: `${path}.meta.json`,
        content: JSON.stringify({ projectId, reason, archivedAt: new Date().toISOString(), count: live.length }),
      })
      // Empty rather than delete, so the append path keeps its directory.
      await writeFileAtomic({ path: this.activitiesPath(projectId), content: '' })
      return { archived: live.length, path }
    })
  }

  /**
   * Write a milestone snapshot: the tree, plus the judgement statistics that go
   * with it.
   *
   * The tree already snapshots itself on every commit, so the tree alone is not
   * worth archiving twice. What this adds is the *pairing* — which tree the
   * statistics were measured against. Six months from now the interesting question
   * is not "what did the tree say" but "when we changed the tree, did the
   * judgements get better", and that cannot be answered from either half alone.
   *
   * Not called automatically. A milestone is a decision: the user confirmed new
   * structure, or a phase ended, or the thresholds changed. Stamping one on every
   * commit would produce a directory nobody reads.
   *
   * @param projectId - owning project.
   * @param label - short human name for this milestone.
   * @param note - why it was taken.
   * @returns where it landed, and the version it captured.
   */
  async archiveMilestone(
    projectId: string,
    label: string,
    note: string,
  ): Promise<{ path: string; version: number }> {
    return this.withProjectLock(projectId, async () => {
      const state = await this.readState(projectId)
      if (state === undefined) {
        throw new StoreInvariantError(`project "${projectId}" has no tree to archive`)
      }

      const [activities, signals, judgments, interventions, observations] = await Promise.all([
        this.readActivities(projectId),
        this.readSignals(projectId),
        this.readJudgments(projectId),
        this.readInterventions(projectId),
        this.readObservations(projectId),
      ])

      const decided = judgments.filter((record) => record.status !== 'pending')
      const settled = decided.length
      const dismissed = decided.filter((record) => record.status === 'dismissed').length
      const confirmed = decided.filter((record) => record.status === 'confirmed').length

      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const safeLabel = label.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'milestone'
      const directory = this.milestoneArchiveDir(projectId)
      const path = join(directory, `${stamp}-${safeLabel}.json`)
      await mkdir(directory, { recursive: true })

      await writeFileAtomic({
        path,
        content: JSON.stringify(
          {
            projectId,
            label,
            note,
            archivedAt: new Date().toISOString(),
            version: state.version,
            tree: state,
            counts: {
              goals: state.goals.length,
              confirmedGoals: state.goals.filter((goal) => goal.confirmedByUser).length,
              doneGoals: state.goals.filter((goal) => goal.status === 'done').length,
              contradictions: state.contradictions.length,
              resolvedContradictions: state.contradictions.filter((node) => node.resolvedAt !== undefined).length,
              activities: activities.length,
              signals: signals.length,
              judgments: judgments.length,
              observations: observations.length,
              interventions: interventions.length,
            },
            // The numbers that would let a later reader tell whether the monitor got
            // better. `falsePositiveRate` is deliberately not computed: with no
            // confirmed positives it would be 1.0, which reads as a catastrophic
            // result rather than as "there is nothing to divide by yet".
            judgementStats: {
              settled,
              dismissed,
              confirmed,
              pending: judgments.length - settled,
              note:
                settled === 0
                  ? '还没有已结算的判定，无法给出精确率'
                  : `已结算 ${settled} 条，其中确认 ${confirmed}、驳回 ${dismissed}`,
            },
          },
          null,
          2,
        ),
      })
      return { path, version: state.version }
    })
  }

  /**
   * List the milestones archived for a project, newest first.
   *
   * Archive was write-only: a milestone could be recorded but never read back, so
   * "did the judgement improve after the tree changed" had both halves on disk and
   * no way to compare them.
   *
   * A file that fails to parse is skipped rather than throwing: one corrupt entry
   * must not make the whole history unreadable.
   *
   * @param projectId - owning project.
   * @returns summaries, newest first.
   */
  async listMilestones(projectId: string): Promise<
    { path: string; label: string; note: string; archivedAt: string; version: number; counts: Record<string, number> }[]
  > {
    const directory = this.milestoneArchiveDir(projectId)
    let names: string[]
    try {
      names = await readdir(directory)
    } catch {
      // No archive directory is the normal case for a young project.
      return []
    }
    const rows: {
      path: string
      label: string
      note: string
      archivedAt: string
      version: number
      counts: Record<string, number>
    }[] = []
    for (const name of names.sort().reverse()) {
      if (!name.endsWith('.json')) continue
      const path = join(directory, name)
      try {
        const raw = await readFile(path, 'utf8')
        const parsed = JSON.parse(raw) as {
          label?: unknown
          note?: unknown
          archivedAt?: unknown
          version?: unknown
          counts?: unknown
        }
        rows.push({
          path,
          label: typeof parsed.label === 'string' ? parsed.label : name,
          note: typeof parsed.note === 'string' ? parsed.note : '',
          archivedAt: typeof parsed.archivedAt === 'string' ? parsed.archivedAt : '',
          version: typeof parsed.version === 'number' ? parsed.version : 0,
          counts:
            parsed.counts !== null && typeof parsed.counts === 'object'
              ? (parsed.counts as Record<string, number>)
              : {},
        })
      } catch {
        // Skipped deliberately: see the doc comment.
      }
    }
    return rows
  }

  /**
   * Read one archived milestone in full, including the tree it captured.
   *
   * @param projectId - owning project.
   * @param path - absolute path from {@link listMilestones}.
   * @returns the stored document, or `undefined` when it cannot be read.
   */
  async readMilestone(projectId: string, path: string): Promise<Record<string, unknown> | undefined> {
    // Fenced to this project's archive directory: the path arrives from a client,
    // and a route that reads any path it is handed is a file-read primitive.
    const directory = this.milestoneArchiveDir(projectId)
    if (!path.startsWith(directory)) return undefined
    try {
      const raw = await readFile(path, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Read the stored file baseline for a project.
   *
   * Kept out of the activity stream on purpose: it is derived state, not evidence.
   * A corrupt baseline should cost one missed diff, not a corrupt judgement history,
   * so a parse failure is treated as "no baseline yet" rather than propagated.
   *
   * @param projectId - owning project.
   * @returns the baseline, or `undefined` when there is none.
   */
  async readFileBaseline(projectId: string): Promise<Record<string, { size: number; hash: string }> | undefined> {
    try {
      const raw = await readFile(this.fileBaselinePath(projectId), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object') return undefined
      return parsed as Record<string, { size: number; hash: string }>
    } catch {
      return undefined
    }
  }

  /**
   * Replace the stored file baseline.
   *
   * @param projectId - owning project.
   * @param baseline - the fingerprint map to store.
   */
  async writeFileBaseline(
    projectId: string,
    baseline: Record<string, { size: number; hash: string }>,
  ): Promise<void> {
    await mkdir(dirname(this.fileBaselinePath(projectId)), { recursive: true })
    await writeFileAtomic({ path: this.fileBaselinePath(projectId), content: JSON.stringify(baseline) })
  }

  /**
   * Read every intervention record for a project.
   *
   * Interventions are stored as an append-only stream of versions; the latest
   * record for an id wins, so a `pending` record superseded by a `resolved` one
   * resolves to the latter.
   *
   * @param projectId - owning project.
   * @returns current records, deduplicated to the newest version per id.
   */
  async readInterventions(projectId: string): Promise<InterventionRecord[]> {
    const raw = await readJsonLines(this.interventionsPath(projectId))
    const parsed = raw.map((item) => InterventionRecordSchema.parse(item))
    const latest = new Map<string, InterventionRecord>()
    for (const record of parsed) latest.set(record.id, record)
    return [...latest.values()]
  }

  /**
   * Append one version of an intervention record.
   *
   * @param projectId - owning project.
   * @param record - validated intervention record.
   */
  async appendIntervention(
    projectId: string,
    record: InterventionRecord,
  ): Promise<InterventionRecord> {
    const parsed = InterventionRecordSchema.parse(record)
    if (parsed.projectId !== projectId) {
      throw new StoreInvariantError(
        `intervention projectId "${parsed.projectId}" does not match "${projectId}"`,
      )
    }
    await this.withProjectLock(projectId, async () => {
      await appendJsonLine(this.interventionsPath(projectId), parsed)
    })
    return parsed
  }

  /**
   * Read a project's drift-candidate log.
   *
   * Stored as an append-only stream of versions: a candidate is written once as
   * `pending` and re-appended once the model settles it, so the original program
   * verdict survives after the decision is made.
   *
   * @param projectId - owning project.
   * @returns current records, deduplicated to the newest version per id.
   */
  async readJudgments(projectId: string): Promise<JudgmentRecord[]> {
    const raw = await readJsonLines(this.judgmentsPath(projectId))
    const parsed = raw.map((item) => JudgmentRecordSchema.parse(item))
    const latest = new Map<string, JudgmentRecord>()
    for (const record of parsed) latest.set(record.id, record)
    return [...latest.values()]
  }

  /**
   * Append one version of a judgement record.
   *
   * @param projectId - owning project.
   * @param record - validated record.
   */
  async appendJudgment(projectId: string, record: JudgmentRecord): Promise<JudgmentRecord> {
    const parsed = JudgmentRecordSchema.parse(record)
    if (parsed.projectId !== projectId) {
      throw new StoreInvariantError(
        `judgment projectId "${parsed.projectId}" does not match "${projectId}"`,
      )
    }
    await this.withProjectLock(projectId, async () => {
      await appendJsonLine(this.judgmentsPath(projectId), parsed)
    })
    return parsed
  }

  /**
   * Append a generated report.
   *
   * @param projectId - owning project.
   * @param report - validated report.
   */
  async appendReport(projectId: string, report: GeneratedReport): Promise<GeneratedReport> {
    const parsed = GeneratedReportSchema.parse(report)
    if (parsed.projectId !== projectId) {
      throw new StoreInvariantError(
        `report projectId "${parsed.projectId}" does not match "${projectId}"`,
      )
    }
    await this.withProjectLock(projectId, async () => {
      await appendJsonLine(this.reportsPath(projectId), parsed)
    })
    return parsed
  }

  /**
   * Read a project's reports.
   *
   * @param projectId - owning project.
   * @returns reports oldest first.
   */
  async readReports(projectId: string): Promise<GeneratedReport[]> {
    const raw = await readJsonLines(this.reportsPath(projectId))
    return raw.map((item) => GeneratedReportSchema.parse(item))
  }
}
