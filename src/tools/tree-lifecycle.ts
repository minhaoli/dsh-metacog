/**
 * Tree lifecycle tools: scan-and-draft, user confirmation, and read-only view.
 *
 * These three implement spec 3.1–3.3: evidence scan produces an unconfirmed
 * candidate tree, the user confirms or edits it, and only then does the tree
 * become a basis for monitoring. Nothing here can produce a *confirmed* node
 * without the user saying so.
 *
 * @module dsh-metacog/tools/tree-lifecycle
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { buildTree, renderTreeText } from '../analysis/tree-text.js'
import { isPlaceholderContext } from '../analysis/derive.js'

import {
  ContradictionNodeSchema,
  ContradictionTypeSchema,
  ExplorationPolicySchema,
  GoalNodeSchema,
  MAX_GOAL_DEPTH,
  computeGoalContradictionBurden,
  contradictionGoalLinks,
  type ContradictionGoalLink,
  type ContradictionNode,
  type GoalNode,
  type TreeState,
} from '../data/types.js'
import { describeScan } from '../evidence/scanner.js'
import { discoverMaterials, summarize, taskDirectoryView } from '../evidence/discover.js'
import type { TaskDirectoryView } from '../evidence/discover.js'
import {
  buildDerivationPrompt,
  deriveWithSubagent,
  type SessionEvidence,
  type SessionMaterial,
} from '../analysis/derive.js'
import { computeTrend } from '../analysis/trend.js'
import {
  collapseCompleted,
  describeLeafActionability,
  inspectLeafActionability,
  leafActionabilityDetails,
} from '../analysis/collapse.js'
import type { ProjectContext } from '../data/types.js'
import { assertContradictionTreeShape, assertEvidence, assertGoalTreeShape, GateError } from '../governance.js'
import {
  defineMetacogTool,
  loadProject,
  type ToolEnvironment,
} from './shared.js'
import type { ToolDefinition } from '../host.js'

/** Reject a cross-goal weight outside [0,1] with a message the caller can act on. */
function assertContradictionWeight(weight: number, contradictionTitle: string): number {
  if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
    throw new GateError(
      'INVALID_ARGS',
      `contradiction "${contradictionTitle}" has a cross-goal weight of ${weight}; ` +
        'a weight must be between 0 and 1 (the primary goal always counts as 1).',
      { title: contradictionTitle, weight },
    )
  }
  return weight
}

/** A preview the user has actually been shown, tied to one tree version. */
interface PreviewRecord {
  readonly projectId: string
  readonly version: number
  readonly previewedAt: string
  /** L1 titles the user explicitly said have no deadline. */
  readonly noDeadlineGoalRefs: string[]
}

/** Where the last preview for one project is kept. */
function previewRecordPath(projectRoot: string, projectId: string): string {
  return join(projectRoot, 'preview', `${projectId}.json`)
}

/** Read the preview record, or `undefined` when the project was never previewed. */
async function readPreviewRecord(projectRoot: string, projectId: string): Promise<PreviewRecord | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(previewRecordPath(projectRoot, projectId), 'utf8'))
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const record = raw as Record<string, unknown>
    if (typeof record.projectId !== 'string' || record.projectId !== projectId) return undefined
    if (typeof record.version !== 'number' || !Number.isInteger(record.version)) return undefined
    if (typeof record.previewedAt !== 'string') return undefined
    const noDeadlineGoalRefs = Array.isArray(record.noDeadlineGoalRefs)
      ? record.noDeadlineGoalRefs.filter((item): item is string => typeof item === 'string')
      : []
    return { projectId, version: record.version, previewedAt: record.previewedAt, noDeadlineGoalRefs }
  } catch {
    return undefined
  }
}

/** Persist that this version was previewed, atomically. */
async function writePreviewRecord(projectRoot: string, record: PreviewRecord): Promise<void> {
  const path = previewRecordPath(projectRoot, record.projectId)
  await mkdir(join(projectRoot, 'preview'), { recursive: true })
  const temp = `${path}.tmp`
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  await rename(temp, path)
}

/**
 * What `goal_tree_init` returns.
 *
 * Two shapes share this type because the tool has two honest outcomes:
 * `derived` when a model produced a candidate structure, and `discovery-only`
 * when it could not (no subagent service, no initiator, provider failure). The
 * latter still reports what was found on disk so the caller can act on it,
 * rather than pretending nothing happened.
 */
export interface InitResult {
  projectId: string
  projectRoot: string
  version: number
  mode: 'derived' | 'discovery-only'
  /** Files found per category, always present. */
  materials: Record<string, number>
  inspectedPaths: string[]
  warnings: string[]
  contextStored: boolean
  /** Project background read from the documents; `derived` runs only. */
  projectProfile?: { summary: string; stage: string; deliverables: string[] }
  /**
   * Present only when a previously confirmed tree was cleared to make room for
   * this derivation. Names where the replaced tree was backed up, so the discard
   * is recoverable rather than merely recorded.
   */
  rebuild: { previousVersion: number; backupPath: string; auditEntryId: string } | null

  /** `derived` only: candidate goals with their derivation. */
  goals: {
    tempId: string
    title: string
    description: string
    depth: number
    parentTempId: string | null
    derivation: string
    evidence: string[]
    successCriteria: string[]
    /** Alignment criteria: the only fields the activity matcher reads. */
    relevantActivities: string[]
    allowedMethods: string[]
    confidence: number
    alternative: string
  }[]
  /** `derived` only: accepted contradictions. */
  contradictions: unknown[]
  noContradictionFound?: boolean
  openQuestions: string[]
  rejections?: unknown[]
  capped?: unknown[]
  /** Token/时间成本，供调用方评估。 */
  usage: unknown

  /** `discovery-only` only. */
  skippedDirs?: { path: string; reason: string }[]
}

/** The root goal the user accepts, possibly reworded by them. */
interface RootAcceptance {
  title: string
  description?: string
  evidence: string[]
  successCriteria?: string[]
  /**
   * Alignment rules for the root, in either the nested or the flat shape.
   *
   * The root is a goal like any other and the criteria gate applies to it, so
   * dropping these here would make the root impossible to satisfy without
   * `allowMissingCriteria`.
   */
  alignment?: {
    relevantActivities?: string[]
    allowedMethods?: string[]
    excludedActivities?: string[]
    explorationPolicy?: 'allowed' | 'limited' | 'approval_required'
  }
  relevantActivities?: string[]
  allowedMethods?: string[]
  excludedActivities?: string[]
  explorationPolicy?: 'allowed' | 'limited' | 'approval_required'
  /** Path prefixes the root owns; see {@link GoalAcceptance.paths}. */
  paths?: string[]
  /** ISO deadline; omitted means the user has not answered yet. */
  deadline?: string
}

/**
 * One non-root node the user accepts.
 *
 * `depth` is required: the tree no longer has a fixed ladder, so the caller states
 * how deep this goal sits rather than picking one of four names. `parentRef` names
 * what it hangs from — by title, as the caller knows goals before ids exist — and
 * may be omitted only at depth 1, where the parent is the root.
 */
interface GoalAcceptance {
  title: string
  description?: string
  /** Defaults to 1: the only depth whose parent is unambiguous. */
  depth?: number
  parentRef?: string
  evidence: string[]
  successCriteria?: string[]
  /**
   * Alignment rules, either nested as the spec models them (`alignment: {...}`)
   * or spread flat on the item. Both shapes are accepted because the nested
   * form is what the data model says and the flat form is what an earlier
   * version of this tool documented; accepting both is cheaper than breaking
   * either caller.
   */
  alignment?: {
    relevantActivities?: string[]
    allowedMethods?: string[]
    excludedActivities?: string[]
    explorationPolicy?: 'allowed' | 'limited' | 'approval_required'
  }
  relevantActivities?: string[]
  allowedMethods?: string[]
  excludedActivities?: string[]
  explorationPolicy?: 'allowed' | 'limited' | 'approval_required'
  /**
   * Path prefixes this goal owns, relative to the project root.
   *
   * Same many-to-many contract as the data model: several goals may claim one
   * path, and the deepest claim wins. Omitting it claims nothing, which is what
   * every tree confirmed before this field existed already meant.
   */
  paths?: string[]
  /** ISO deadline; omitted means the user has not answered yet. */
  deadline?: string
}

interface ContradictionAcceptance {
  title: string
  description?: string
  poleA: string
  poleB: string
  evidence: string[]
  type?: 'core' | 'main' | 'secondary' | 'unclassified'
  primaryGoalRef: string
  relatedGoalRefs?: string[]
  /**
   * Cross-goal links with an explicit strength (0–1).
   *
   * Preferred over `relatedGoalRefs` when weights matter: a ref there is read
   * with `config.contradictions.defaultRelatedWeight`, which is right for an
   * old caller and wrong for a tension whose weight the user just chose.
   * Passing both is refused rather than merged.
   */
  relatedGoals?: { goalRef: string; weight?: number }[]
  /**
   * Stable reference within this call, so children can point at this item.
   *
   * Optional because a hand-written tree may not need ids at all; a derivation
   * output already carries one per contradiction and can pass it through.
   */
  tempId?: string
  /**
   * Parent contradiction: a `tempId` or a title from this same call.
   *
   * Empty or absent means top level. A contradiction tree has no depth limit
   * and is deliberately independent of goal depth — a root tension may have
   * concrete forms under it, and those may have their own.
   */
  parentTempId?: string
  rationale?: string
  resolutionHint?: string
  /** 1–5 when the user already has a reading; omitted means "no evidence yet". */
  intensity?: number | null
}

/**
 * The slice of `dsh-session-query-vector` this module calls.
 *
 * Deliberately loose: the service belongs to another plugin, and a version skew
 * that changes a field must degrade to "titles and times only", not crash the
 * derivation. Nothing here is trusted to exist.
 */
interface SessionQueryLike {
  searchSessions?: (request: unknown, exec: unknown) => Promise<unknown>
}

interface SessionSearchItem {
  header?: { id?: unknown; cwd?: unknown; title?: unknown }
  bestMatch?: { snippet?: unknown; time?: unknown }
}

/** Normalize a filesystem path for workspace comparisons (Windows-safe). */
function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Collect the session history that may explain which tasks are finished.
 *
 * Derivation runs as a subagent and cannot reach host services, so this runs in
 * the plugin process and hands over plain data. Three sources are combined:
 * live sessions (`sessions.list`), archived ones (workspace registry), and —
 * when the semantic engine is available — content hits attached by cwd.
 *
 * Every source is optional. A missing engine, a cold index or an embedding
 * backend that is down all end in `contentSearchUsed: false` with a reason, and
 * the prompt says in words that conversation content did not participate. It
 * never fabricates a snippet to fill the gap.
 *
 * @param ctx - host context.
 * @param projectRoot - absolute workspace root.
 * @param directories - the task directories, used for title matching.
 * @param exec - tool run context, forwarded to the query engine.
 */
export async function collectSessionMaterial(
  ctx: ToolEnvironment['ctx'],
  projectRoot: string,
  directories: TaskDirectoryView,
  exec: unknown,
): Promise<SessionMaterial> {
  const root = normalizePath(projectRoot)
  const withinWorkspace = (cwd: string): boolean => {
    if (cwd === '') return false
    const normalized = normalizePath(cwd)
    return normalized === root || normalized.startsWith(`${root}/`)
  }
  const directoryOf = (cwd: string, title: string): string => {
    if (withinWorkspace(cwd)) {
      const relative = normalizePath(cwd).slice(root.length).replace(/^\/+/, '')
      if (relative !== '') return relative.split('/')[0] ?? ''
    }
    // A session that ran at the workspace root still belongs to a task when its
    // title names that task's directory.
    const hit = directories.roots.find((root) => title.includes(root.name))
    return hit?.name ?? ''
  }

  const collected = new Map<string, SessionEvidence>()
  const archivedIds = new Set<string>()
  try {
    const workspaces = ctx.get('workspaceRegistry')?.list() ?? []
    for (const workspace of workspaces) {
      if (!withinWorkspace(workspace.path)) continue
      for (const id of workspace.archivedSessionIds ?? []) archivedIds.add(id)
    }
  } catch {
    // The registry is optional; archived sessions simply go unseen.
  }

  const liveSessions = (() => {
    try {
      return ctx.get('sessions')?.list() ?? []
    } catch {
      return []
    }
  })()
  const persistence = ctx.get('sessionPersistence')
  const titles = ctx.get('sessionTitle')

  for (const id of new Set([...liveSessions.map((session) => session.id), ...archivedIds])) {
    let header: Record<string, unknown> = {}
    try {
      header = (await persistence?.stat(id))?.header ?? {}
    } catch {
      // A session that vanished mid-walk is skipped, not fatal.
    }
    const live = liveSessions.find((session) => session.id === id)
    const cwd = typeof header.cwd === 'string' ? header.cwd : (live?.header?.cwd ?? '')
    const inWorkspace = withinWorkspace(cwd)
    let title = typeof header.title === 'string' ? header.title : ''
    if (title === '' && live !== undefined) {
      try {
        title = titles?.get(live)?.title ?? ''
      } catch {
        title = ''
      }
    }
    const directory = directoryOf(cwd, title)
    // A session belongs here when it ran in the workspace, or when its title
    // names one of the task directories (an archived session may have lost cwd).
    if (!inWorkspace && (cwd !== '' || directory === '')) continue
    if (title === '' && directory === '') continue
    const stamp = header.updatedAt ?? header.lastActivityAt ?? header.createdAt
    collected.set(id, {
      sessionId: id,
      title: title === '' ? '(未命名会话)' : title,
      lastActivityAt: typeof stamp === 'string' ? stamp : '',
      archived: archivedIds.has(id),
      matchedBy: inWorkspace ? 'cwd' : 'title',
      directory,
    })
  }

  let contentSearchUsed = false
  let degradedReason: string | undefined
  const engine = ctx.get('sessionQuery') as SessionQueryLike | undefined
  if (engine === undefined || typeof engine.searchSessions !== 'function') {
    degradedReason = '宿主未提供 sessionQuery 服务（未安装语义检索插件或索引未建）'
  } else {
    try {
      const queries = [
        ...directories.roots.slice(0, 4).map((directory) => directory.name),
        '定稿 交付 已完成 完成',
      ]
      for (const query of queries) {
        const result = (await engine.searchSessions({ query }, exec)) as
          | { items?: SessionSearchItem[] }
          | undefined
        for (const item of result?.items ?? []) {
          const itemCwd = typeof item.header?.cwd === 'string' ? item.header.cwd : ''
          if (!withinWorkspace(itemCwd)) continue
          const id = typeof item.header?.id === 'string' ? item.header.id : ''
          if (id === '') continue
          const snippet = typeof item.bestMatch?.snippet === 'string' ? item.bestMatch.snippet : ''
          const time = typeof item.bestMatch?.time === 'string' ? item.bestMatch.time : ''
          const directory = directoryOf(itemCwd, '')
          const existing = collected.get(id)
          collected.set(id, {
            sessionId: id,
            title: existing?.title ?? (typeof item.header?.title === 'string' ? item.header.title : '(未命名会话)'),
            lastActivityAt: existing?.lastActivityAt !== undefined && existing.lastActivityAt !== '' ? existing.lastActivityAt : time,
            archived: existing?.archived ?? archivedIds.has(id),
            matchedBy: existing === undefined ? 'content' : existing.matchedBy,
            directory: existing?.directory ?? directory,
            ...(snippet.trim() === '' ? {} : { snippet }),
          })
        }
      }
      contentSearchUsed = true
    } catch (error) {
      degradedReason = `sessionQuery 检索失败：${String(error).slice(0, 120)}`
    }
  }

  const sessions = [...collected.values()].sort((left, right) =>
    right.lastActivityAt.localeCompare(left.lastActivityAt),
  )
  return {
    sessions,
    contentSearchUsed,
    ...(degradedReason === undefined ? {} : { degradedReason }),
  }
}

/**
 * Register `goal_tree_init`.
 *
 * Scans the project and writes an unconfirmed candidate tree at version 0.
 *
 * @param env - shared tool environment.
 */
export function goalTreeInitTool(env: ToolEnvironment): ToolDefinition {
  return defineMetacogTool<InitResult>({
    name: 'goal_tree_init',
    description:
      'Scan the project for evidence (README, docs/, manifests, git history) and write an ' +
      'unconfirmed candidate goal tree and contradiction tree at version 0. Every candidate ' +
      'carries the real file or commit it came from. Nothing becomes a monitoring basis until ' +
      'goal_tree_confirm runs. L1 candidates are derived from actual document structure, so a ' +
      'project that documents one objective yields one L1 rather than a padded set.',
    parameters: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description:
            'Replace an existing unconfirmed draft. On a confirmed tree, force alone is not ' +
            'enough: it re-enables derivation only together with expectedVersion, which proves ' +
            'the current tree was read before being discarded.',
        },
        expectedVersion: {
          type: 'integer',
          description:
            'Required when rebuilding a confirmed tree. Pass the version returned by ' +
            'goal_tree_view; a stale number is refused rather than silently overwriting a tree ' +
            'the caller never saw.',
        },
        reason: {
          type: 'string',
          description:
            'Why the confirmed tree is being discarded. Written to the audit log so a later ' +
            'reader can tell a deliberate restatement from an accidental wipe.',
        },
        userContext: {
          type: 'object',
          description:
            '你的角色、意图与约束。推导必须依赖这一层：只看文件能知道「在做什么」，' +
            '推不出「为什么重要」。存进项目状态，后续可省略。',
          properties: {
            role: { type: 'string', description: '你在项目中的角色。' },
            intent: { type: 'string', description: '这个项目为什么存在，你要它达成什么。' },
            constraints: {
              type: 'array',
              items: { type: 'string' },
              description: '已知约束：截止时间、预算、人力、合规。',
            },
            stakeholders: {
              type: 'array',
              items: { type: 'string' },
              description: '谁消费或受影响。',
            },
          },
          additionalProperties: false,
        },
        timeoutMs: {
          type: 'integer',
          description: '推导超时，默认 180000（3 分钟）。',
        },
      },
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    async run(args, exec) {
      const input = (args ?? {}) as {
        force?: boolean
        expectedVersion?: number
        reason?: string
        userContext?: {
          role?: string
          intent?: string
          constraints?: string[]
          stakeholders?: string[]
        }
        timeoutMs?: number
      }
      const { projectRoot, projectId, store } = await loadProject(env, exec)

      // Derivation is a one-time act, not a periodic one.
      //
      // A goal tree is the *yardstick* used to judge whether work is on target.
      // If the yardstick were re-derived whenever documents changed, every
      // alignment judgement recorded against the old tree would lose its
      // meaning: an activity that advanced T3 yesterday would refer to a goal
      // that no longer exists today. So re-derivation is refused once confirmed.
      //
      // Changing the tree is a deliberate act with its own entry points:
      // `goal_tree_edit` / `contradiction_tree_edit` for structure, and
      // `metacog_revise` for a user-stated change of intent. Neither reads the
      // documents — they exist because the *project* changed, not because a
      // file was edited.
      const existingState = await store.readState(projectId)
      // A confirmed tree is the yardstick, so re-derivation stays refused by
      // default. It opens only for a caller that proves it saw the tree being
      // discarded (`expectedVersion`) and asks in so many words (`force`), and
      // even then the replaced tree is backed up and the reset is audited.
      let rebuild: InitResult['rebuild'] = null
      if (existingState?.confirmed === true) {
        if (input.force !== true) {
          throw new GateError(
            'ALREADY_INITIALIZED',
            `this project already has a confirmed tree at version ${existingState.version}. ` +
              'A goal tree is the yardstick for judging alignment, so it is derived once and ' +
              'then held fixed; re-deriving it would invalidate every past judgement. ' +
              'Use goal_tree_edit / contradiction_tree_edit to adjust structure, or ' +
              'metacog_revise when the project itself has changed ' +
              '(a goal dropped, a tension resolved). ' +
              'To restate the project from scratch, call again with force: true and ' +
              'expectedVersion set to the current version.',
            { version: existingState.version, confirmed: true },
          )
        }
        if (typeof input.expectedVersion !== 'number') {
          throw new GateError(
            'EXPECTED_VERSION_REQUIRED',
            'rebuilding a confirmed tree needs expectedVersion. Read goal_tree_view first and ' +
              'pass the version it reports: clearing a tree the caller has not seen is ' +
              'indistinguishable from an accidental wipe.',
            { version: existingState.version },
          )
        }
        const reset = await store.resetForRebuild(projectId, {
          expectedVersion: input.expectedVersion,
          reason:
            (input.reason ?? '').trim().length > 0
              ? (input.reason as string)
              : 'confirmed tree cleared to restate the project from scratch',
        })
        rebuild = {
          previousVersion: reset.state.version,
          backupPath: reset.backupPath,
          auditEntryId: reset.auditEntryId,
        }
      }

      // ---- project context: required input for derivation -------------------
      const existingContext = await store.readProjectContext(projectId)
      const supplied = input.userContext
      const projectContext: ProjectContext | undefined =
        supplied === undefined
          ? existingContext
          : {
              role: supplied.role ?? existingContext?.role ?? '',
              intent: supplied.intent ?? existingContext?.intent ?? '',
              constraints: supplied.constraints ?? existingContext?.constraints ?? [],
              stakeholders: supplied.stakeholders ?? existingContext?.stakeholders ?? [],
              projectSummary: existingContext?.projectSummary ?? '',
              stage: existingContext?.stage ?? '',
              deliverables: existingContext?.deliverables ?? [],
            }

      const contextWarning =
        projectContext === undefined || projectContext.role.trim().length === 0
          ? '未提供 userContext（你的角色与意图）。只看文件能推出「在做什么」，' +
            '推不出「为什么重要」，因此推导结果置信度会被压低。建议重跑并传入角色与意图。'
          : undefined

      // ---- material discovery ---------------------------------------------
      const materials = await discoverMaterials(projectRoot)
      const counts = summarize(materials)
      // What the workspace is *made of*: one directory per task, decided by the
      // counts rather than by a fixed depth. Without this the derivation sees a
      // flat file list and can go on reading three documents while a 118-file
      // task directory is never mentioned.
      const directories = taskDirectoryView(materials)
      // Session history is collected here because the derivation subagent cannot
      // reach host services. Missing services degrade to titles and times, and
      // the prompt states that content did not participate.
      const sessions = await collectSessionMaterial(env.ctx, projectRoot, directories, exec)

      // ---- derivation ------------------------------------------------------
      const prompt = buildDerivationPrompt({
        materials,
        directories,
        sessions,
        context:
          projectContext ?? {
            role: '',
            intent: '',
            constraints: [],
            stakeholders: [],
            projectSummary: '',
            stage: '',
            deliverables: [],
          },
      })

      const outcome = await deriveWithSubagent({
        ctx: env.ctx,
        prompt,
        cwd: projectRoot,
        directories,
        ...(projectContext === undefined ? {} : { context: projectContext }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      })

      // Without any derivation the tool cannot honestly produce a tree. Report
      // what was found and why no tree was written; the caller can pass
      // candidates explicitly through goal_tree_confirm instead.
      //
      // Notably: nothing is written to the store here. Creating an empty draft
      // would make `goal_tree_view` report a tree that contains no goals, which
      // reads as "the project has no objectives" rather than "derivation did not
      // run". Absence of state is the honest representation.
      if (outcome.status !== 'ok') {
        const why =
          outcome.status === 'unavailable'
            ? `本环境不支持自动推导：${outcome.reason}`
            : `推导失败：${outcome.reason}`
        return {
          projectId,
          projectRoot,
          version: 0,
          mode: 'discovery-only' as const,
          materials: counts,
          directories,
          sessionEvidence: {
            count: sessions.sessions.length,
            contentSearchUsed: sessions.contentSearchUsed,
            ...(sessions.degradedReason === undefined ? {} : { degradedReason: sessions.degradedReason }),
            sessions: sessions.sessions.slice(0, 10),
          },
          inspectedPaths: materials.files
            .filter((f) => f.category === 'document' || f.category === 'result')
            .slice(0, 40)
            .map((f) => f.path),
          skippedDirs: materials.skippedDirs.slice(0, 20),
          contextStored: projectContext !== undefined,
          rebuild,
          warnings: [
            why,
            ...(contextWarning === undefined ? [] : [contextWarning]),
            ...materials.warnings,
            '未写入目标树。请用 goal_tree_confirm 直接提供目标，或先修复推导能力。',
          ],
          goals: [],
          contradictions: [],
          openQuestions: [],
          usage: null,
        }
      }

      const review = outcome.review
      // Two layers of background, kept apart on purpose: what the user says the
      // project is (role / intent / constraints / stakeholders) and what the
      // documents show it is (projectSummary / stage / deliverables). A
      // disagreement between them is information, so the derived layer never
      // overwrites the stated one.
      const profile = review.output.projectProfile
      const storedContext: ProjectContext | undefined =
        projectContext === undefined &&
        profile.summary.length === 0 &&
        profile.stage.length === 0 &&
        profile.deliverables.length === 0
          ? undefined
          : {
              role: projectContext?.role ?? '',
              intent: projectContext?.intent ?? '',
              constraints: projectContext?.constraints ?? [],
              stakeholders: projectContext?.stakeholders ?? [],
              projectSummary: profile.summary || (projectContext?.projectSummary ?? ''),
              stage: profile.stage || (projectContext?.stage ?? ''),
              deliverables:
                profile.deliverables.length > 0
                  ? profile.deliverables
                  : (projectContext?.deliverables ?? []),
            }

      // Draft nodes: depth becomes a number, and the model's tempIds are kept in
      // the returned payload so confirm can map them back.
      const now = new Date().toISOString()
      const concerns = review.output.goals.map((goal) => ({
        tempId: goal.tempId,
        title: goal.title,
        description: goal.description,
        depth: goal.depth,
        // The subagent output schema cannot express null, so a root goal's
        // absent parent arrives as an empty string. It becomes null here, which
        // is what the tree model and the caller both expect.
        parentTempId: goal.parentTempId === '' ? null : goal.parentTempId,
        derivation: goal.derivation,
        evidence: goal.evidence,
        successCriteria: goal.successCriteria,
        // Carried through to the caller because these two are what the
        // alignment rules match on. Dropping them here would leave the model
        // looking at a candidate tree with no way to see, or fix, the one thing
        // that decides whether any activity can be judged as serving a goal.
        relevantActivities: goal.relevantActivities,
        allowedMethods: goal.allowedMethods,
        confidence: goal.confidence,
        alternative: goal.alternative,
      }))

      // Persist the candidates as draft nodes before asking for confirmation.
      //
      // A derivation costs minutes of model time. Keeping its output only in the
      // tool's return value means a lost context throws all of it away and the
      // user pays for the same reading twice. Drafts are `confirmedByUser: false`
      // with status `draft`, so they cannot drive a single judgement: confirm is
      // still the only act that turns a candidate into a yardstick.
      //
      // Contradictions stay out of the draft. A contradiction node is meaningless
      // without the goal ids it blocks, and those ids only exist after confirm
      // allocates them — storing a half-resolved version would be worse than
      // storing nothing.
      const draftIds = new Map<string, string>()
      for (const goal of review.output.goals) {
        draftIds.set(goal.tempId, `G${goal.depth}_${randomUUID()}`)
      }
      const draftGoals: GoalNode[] = review.output.goals.map((goal) =>
        GoalNodeSchema.parse({
          id: draftIds.get(goal.tempId),
          projectId,
          parentId: goal.parentTempId === '' ? null : (draftIds.get(goal.parentTempId) ?? null),
          depth: goal.depth,
          title: goal.title,
          description: goal.description,
          status: 'draft',
          priority: 0,
          confirmedByUser: false,
          successCriteria: goal.successCriteria,
          alignment: {},
          evidence: goal.evidence,
          createdAt: now,
          updatedAt: now,
        }),
      )

      // Version 0 is a draft marker; the tree itself is written by
      // goal_tree_confirm, which is the only place a node becomes the basis
      // for judging work.
      const state = await store.initialize(projectId, draftGoals, [], {
        force: input.force === true,
        ...(storedContext === undefined ? {} : { projectContext: storedContext }),
      })

      return {
        projectId,
        projectRoot,
        version: state.version,
        mode: 'derived' as const,
        materials: counts,
        directories,
        sessionEvidence: {
          count: sessions.sessions.length,
          contentSearchUsed: sessions.contentSearchUsed,
          ...(sessions.degradedReason === undefined ? {} : { degradedReason: sessions.degradedReason }),
          sessions: sessions.sessions.slice(0, 10),
        },
        inspectedPaths: review.output.evidenceManifest.map((e) => e.path),
        contextStored: storedContext !== undefined,
        projectProfile: profile,
        rebuild,
        warnings: [
          ...(contextWarning === undefined ? [] : [contextWarning]),
          ...materials.warnings,
        ],
        goals: concerns,
        contradictions: review.output.contradictions,
        noContradictionFound: review.output.noContradictionFound,
        openQuestions: review.questions,
        rejections: review.rejections,
        capped: review.capped,
        usage: outcome.usage,
      }
    },
  })
}

/**
 * Register `goal_tree_confirm`.
 *
 * Converts chosen candidates (or user-supplied replacements) into confirmed,
 * active nodes, sets version 1 and writes the genesis audit entry.
 *
 * @param env - shared tool environment.
 */
export function goalTreeConfirmTool(env: ToolEnvironment): ToolDefinition {
  return defineMetacogTool<Record<string, unknown>>({
    name: 'goal_tree_confirm',
    description:
      'Turn the reviewed candidate tree into the confirmed monitoring basis. Accept, rename, ' +
      'add or drop candidates; each supplied L1 may carry successCriteria and alignment rules. ' +
      'Produces version 1, the first TreeSnapshot and the genesis AuditLogEntry. Nodes supplied ' +
      'here become confirmedByUser: true with status "active"; omitted candidates are discarded.',
    parameters: {
      type: 'object',
      properties: {
        expectedVersion: {
          type: 'integer',
          description: 'Version returned by goal_tree_init (normally 0).',
        },
        l0: {
          type: 'object',
          description: 'The root goal. Required: a project must state one reason to exist.',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            evidence: { type: 'array', items: { type: 'string' } },
            successCriteria: { type: 'array', items: { type: 'string' } },
            paths: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Path prefixes this goal owns, relative to the project root. Omitting it claims ' +
                'nothing, which is what a tree confirmed before this field existed already meant.',
            },
            deadline: {
              type: 'string',
              description: 'ISO deadline for this goal. Required for L1 unless noDeadlineGoalRefs names it.',
            },
            alignment: {
              type: 'object',
              description:
                'The root goal needs these too: it is matched against activities like any other ' +
                'goal, and a root with neither relevantActivities nor allowedMethods can never ' +
                'be judged as being served.',
              properties: {
                relevantActivities: { type: 'array', items: { type: 'string' } },
                allowedMethods: { type: 'array', items: { type: 'string' } },
                excludedActivities: { type: 'array', items: { type: 'string' } },
                explorationPolicy: {
                  type: 'string',
                  enum: [...ExplorationPolicySchema.options],
                },
              },
              additionalProperties: false,
            },
          },
          required: ['title', 'evidence'],
        },
        goals: {
          type: 'array',
          description:
            'Every non-root goal, at any depth. Supply only those the evidence supports; do not ' +
            'pad the list. `depth` defaults to 1, the only level whose parent is unambiguous; ' +
            'anything deeper must state it, and `parentRef` names the parent by title.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              depth: { type: 'integer', minimum: 1, maximum: MAX_GOAL_DEPTH },
              parentRef: { type: 'string' },
              evidence: { type: 'array', items: { type: 'string' } },
              successCriteria: { type: 'array', items: { type: 'string' } },
              paths: { type: 'array', items: { type: 'string' } },
              deadline: {
                type: 'string',
                description: 'ISO deadline. Required for L1 unless noDeadlineGoalRefs names it.',
              },
              alignment: {
                type: 'object',
                description:
                  'Activity-alignment rules: what daily work legitimately advances this goal. ' +
                  'Kept separate from successCriteria, which describes the completion condition.',
                properties: {
                  relevantActivities: { type: 'array', items: { type: 'string' } },
                  allowedMethods: { type: 'array', items: { type: 'string' } },
                  excludedActivities: { type: 'array', items: { type: 'string' } },
                  explorationPolicy: {
                    type: 'string',
                    enum: [...ExplorationPolicySchema.options],
                  },
                },
                additionalProperties: false,
              },
            },
            required: ['title', 'evidence'],
          },
        },
        contradictions: {
          type: 'array',
          description:
            'Confirmed tensions. primaryGoalRef is a goal title (or the L0/L1 title) that must ' +
            'exist among the goals supplied in this same call.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              tempId: {
                type: 'string',
                description:
                  '本次调用内的稳定引用，供子矛盾用 parentTempId 指向它；可省略。',
              },
              parentTempId: {
                type: 'string',
                description:
                  '父矛盾的 tempId 或标题；顶层矛盾留空字符串或省略。矛盾树深度不限，' +
                  '且不要求与目标层级对应。',
              },
              poleA: { type: 'string' },
              poleB: { type: 'string' },
              evidence: { type: 'array', items: { type: 'string' } },
              type: {
                type: 'string',
                enum: [...ContradictionTypeSchema.options],
              },
              primaryGoalRef: { type: 'string' },
              relatedGoalRefs: { type: 'array', items: { type: 'string' } },
              relatedGoals: {
                type: 'array',
                description:
                  '跨目标张力：同一矛盾对每个相关目标压得多重（0–1）。' +
                  'primaryGoalRef 始终按 1.0 计；未给 weight 的条目取配置默认权重。',
                items: {
                  type: 'object',
                  properties: {
                    goalRef: { type: 'string' },
                    weight: { type: 'number', minimum: 0, maximum: 1 },
                  },
                  required: ['goalRef'],
                  additionalProperties: false,
                },
              },
              rationale: { type: 'string' },
              resolutionHint: { type: 'string' },
              intensity: {
                type: 'integer',
                description:
                  'Optional 1-5 reading of the tension at confirmation time. Omit when there is no evidence; ' +
                  'the node then holds null until an observation is recorded.',
              },
            },
            required: ['title', 'poleA', 'poleB', 'evidence', 'primaryGoalRef'],
          },
        },
        reason: { type: 'string', description: 'Why the tree was confirmed as it stands.' },
        allowMissingCriteria: {
          type: 'boolean',
          description:
            '确认一个暂时没有对齐判据的树。默认拒绝：目标既没有 relevantActivities 也没有 ' +
            'allowedMethods 时，任何活动都不可能被判成服务于它，整棵树的判定会全部落成 ' +
            'scope_drift。只在明确知道这一点、且马上要补判据时使用。',
        },
        allowNonActionableLeaves: {
          type: 'boolean',
          description:
            'Accept leaves that state no checkable successCriteria. Default refuse: a leaf is the ' +
            'deepest, most concrete level of the tree, so a leaf whose criteria are absent, blank ' +
            'or generic can never be judged done from the outside. Passing true additionally ' +
            'requires a non-empty reason, because the audit entry is the only record that the ' +
            'placeholder was deliberate. This is separate from allowMissingCriteria: that one is ' +
            'about matching activities, this one is about whether a leaf is executable.',
        },
        preview: {
          type: 'boolean',
          description:
            'Show the two trees as human-readable text without writing anything. Records that this ' +
            'version was previewed; a later confirm for the same version is allowed, a confirm ' +
            'without a preview is refused with PREVIEW_REQUIRED.',
        },
        userApproved: {
          type: 'boolean',
          description:
            'Must be true to confirm: an explicit record that the user approved the previewed tree. ' +
            'It does not replace the background questions; it only forces one explicit action.',
        },
        approvalNote: {
          type: 'string',
          description:
            'What the user said when approving, recorded in the audit entry. Required when ' +
            'userApproved is true.',
        },
        allowUnconfirmedContext: {
          type: 'boolean',
          description:
            'Proceed although projectContext.role is empty or still a placeholder ("未确认：…"). ' +
            'Requires a non-empty reason, like allowMissingCriteria; the audit entry records why.',
        },
        noDeadlineGoalRefs: {
          type: 'array',
          items: { type: 'string' },
          description:
            'L1 titles (or ids) the user explicitly said have no deadline. A confirm refuses an L1 ' +
            'without a deadline unless it is listed here. Use "*" only when the user said every L1 ' +
            'has no deadline. Preview records the list so the confirm for the same version inherits it.',
        },
      },
      required: ['expectedVersion', 'l0'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    async run(args, exec) {
      const input = (args ?? {}) as unknown as {
        expectedVersion?: number
        l0?: RootAcceptance
        goals?: GoalAcceptance[]
        contradictions?: ContradictionAcceptance[]
        reason?: string
        allowMissingCriteria?: boolean
        allowNonActionableLeaves?: boolean
        preview?: boolean
        userApproved?: boolean
        approvalNote?: string
        allowUnconfirmedContext?: boolean
        noDeadlineGoalRefs?: string[]
      }
      if (typeof input.expectedVersion !== 'number') {
        throw new GateError('INVALID_ARGS', 'expectedVersion is required and must be an integer')
      }
      const { projectId, store } = await loadProject(env, exec)
      const current = await store.readState(projectId)

      // Two legitimate arrivals:
      //   - a draft exists (version 0): honour its CAS version and its context.
      //   - no state at all: the caller read the derivation output and is
      //     confirming it directly. Requiring an intermediate draft file would
      //     force a write that carries no information, so absence is accepted
      //     as long as the caller asked for version 0 or 1.
      if (current === undefined && input.expectedVersion > 1) {
        throw new GateError(
          'NOT_INITIALIZED',
          `expectedVersion ${input.expectedVersion} was requested but this project has no tree yet. ` +
            'Pass 0 or 1 when confirming a derivation result directly.',
          { expectedVersion: input.expectedVersion },
        )
      }
      if (input.l0 === undefined) {
        throw new GateError(
          'L0_REQUIRED',
          'confirmation must name the root goal; a project cannot be monitored without a ' +
            'stated reason to exist.',
        )
      }
      assertEvidence(input.l0.evidence ?? [], 'the root goal')

      const now = new Date().toISOString()
      const rootGoal = GoalNodeSchema.parse({
        id: `G0_${randomUUID()}`,
        projectId,
        parentId: null,
        depth: 0,
        title: input.l0.title,
        description: input.l0.description ?? '',
        status: 'active',
        priority: 0,
        confirmedByUser: true,
        successCriteria: input.l0.successCriteria ?? [],
        paths: input.l0.paths ?? [],
        ...(input.l0.deadline === undefined ? {} : { deadline: input.l0.deadline }),
        alignment: {
          relevantActivities: input.l0.alignment?.relevantActivities ?? input.l0.relevantActivities ?? [],
          allowedMethods: input.l0.alignment?.allowedMethods ?? input.l0.allowedMethods ?? [],
          excludedActivities: input.l0.alignment?.excludedActivities ?? input.l0.excludedActivities ?? [],
          explorationPolicy:
            input.l0.alignment?.explorationPolicy ?? input.l0.explorationPolicy ?? 'limited',
        },
        evidence: input.l0.evidence,
        createdAt: now,
        updatedAt: now,
      })

      // Build shallow to deep: `parentRef` names a goal by title, so a parent has
      // to exist before its children can be resolved. Sorting also means a bad
      // depth is reported before the tree is half-built.
      // A goal with no stated depth hangs directly under the root: that is the one
      // level whose parent needs no naming. Anything deeper must say so.
      const submitted = (input.goals ?? []).map((item) => ({ ...item, depth: item.depth ?? 1 }))
      const pending = submitted.sort((left, right) => left.depth - right.depth)
      const nonRootGoals: GoalNode[] = []
      const idByTitle = new Map<string, string>([[rootGoal.title, rootGoal.id]])
      for (const item of pending) {
        if (!Number.isInteger(item.depth) || item.depth < 1 || item.depth > MAX_GOAL_DEPTH) {
          throw new GateError(
            'INVALID_ARGS',
            `goal "${item.title}" has depth ${item.depth}; depth must be an integer between 1 ` +
              `and ${MAX_GOAL_DEPTH}`,
            { title: item.title, depth: item.depth },
          )
        }
        assertEvidence(item.evidence ?? [], `goal "${item.title}" (depth ${item.depth})`)

        const parentRef = item.parentRef ?? (item.depth === 1 ? rootGoal.title : undefined)
        if (parentRef === undefined) {
          throw new GateError(
            'PARENT_REQUIRED',
            `goal "${item.title}" sits at depth ${item.depth}, so it must name a parentRef. ` +
              'Only depth-1 goals may leave it out, because their parent is the root.',
            { title: item.title, depth: item.depth },
          )
        }
        const parentId = idByTitle.get(parentRef)
        if (parentId === undefined) {
          throw new GateError(
            'UNKNOWN_GOAL_REF',
            `goal "${item.title}" references parent "${parentRef}", which is not among the ` +
              `goals confirmed in this call. Available: ${[...idByTitle.keys()].join('; ')}`,
            { ref: parentRef, available: [...idByTitle.keys()] },
          )
        }

        const node = GoalNodeSchema.parse({
          id: `G${item.depth}_${randomUUID()}`,
          projectId,
          parentId,
          depth: item.depth,
          title: item.title,
          description: item.description ?? '',
          status: 'active',
          priority: 0,
          confirmedByUser: true,
          successCriteria: item.successCriteria ?? [],
          paths: item.paths ?? [],
          ...(item.deadline === undefined ? {} : { deadline: item.deadline }),
          alignment: {
            relevantActivities: item.alignment?.relevantActivities ?? item.relevantActivities ?? [],
            allowedMethods: item.alignment?.allowedMethods ?? item.allowedMethods ?? [],
            excludedActivities: item.alignment?.excludedActivities ?? item.excludedActivities ?? [],
            explorationPolicy:
              item.alignment?.explorationPolicy ?? item.explorationPolicy ?? 'limited',
          },
          evidence: item.evidence,
          createdAt: now,
          updatedAt: now,
        })
        nonRootGoals.push(node)
        idByTitle.set(node.title, node.id)
      }

      const goals = [rootGoal, ...nonRootGoals]
      // Shape is a program-owned invariant: a tree whose depths contradict its
      // parent links must not reach the store, whoever assembled it.
      assertGoalTreeShape(goals)

      // Criteria completeness is the second invariant, and it is the one that
      // quietly decides whether the whole monitor can say anything at all.
      //
      // `alignment.ts` matches activities against `relevantActivities` and
      // `allowedMethods` only; `successCriteria` describes when a goal is done
      // and never participates. A goal with both lists empty therefore cannot
      // be matched by any activity, and every activity falls through to
      // `scope_drift`. That failure is silent — the tree looks fine, the
      // verdicts look plausible, and the only symptom is `aligned` sitting at
      // zero forever. Refusing here is what keeps that from happening again.
      if (input.allowMissingCriteria !== true) {
        const withoutCriteria = goals.filter(
          (node) =>
            node.alignment.relevantActivities.length === 0 &&
            node.alignment.allowedMethods.length === 0,
        )
        if (withoutCriteria.length > 0) {
          throw new GateError(
            'CRITERIA_REQUIRED',
            `${withoutCriteria.length} of ${goals.length} goals have neither relevantActivities ` +
              `nor allowedMethods, so no activity can ever be judged as serving them: ` +
              `${withoutCriteria.map((node) => `"${node.title}"`).join('; ')}. ` +
              'Add at least one short phrase to relevantActivities (or allowedMethods) on each — ' +
              'those are the only fields the alignment rules match on; successCriteria is a ' +
              'completion condition and does not count. Pass allowMissingCriteria: true only if ' +
              'you know the tree cannot be matched yet and will fill them in immediately.',
            { goals: withoutCriteria.map((node) => node.title) },
          )
        }
      }

      /** Resolve a goal reference by title; ids are not yet known to the user. */
      const resolveGoalRef = (ref: string): string => {
        const match = goals.find((node) => node.title === ref || node.id === ref)
        if (match === undefined) {
          throw new GateError(
            'UNKNOWN_GOAL_REF',
            `contradiction references goal "${ref}", which is not among the goals confirmed ` +
              `in this call. Available: ${goals.map((node) => node.title).join('; ')}`,
            { ref, available: goals.map((node) => node.title) },
          )
        }
        return match.id
      }

      const contradictions: ContradictionNode[] = []
      // Contradictions form their own tree, independent of the goal tree. A
      // parent is named by the caller's tempId (so a derivation can be confirmed
      // as-is) or by title (so a hand-written tree needs no ids), and a child may
      // appear before its parent — resolution is iterative, not positional.
      // Depth is unlimited on purpose: how deep a tension goes is a property of
      // the content, not something a checker should decide.
      let pendingContradictions = [...(input.contradictions ?? [])]
      const contradictionIdByTempId = new Map<string, string>()

      /** Resolve a parent reference; `undefined` means "not built yet". */
      const resolveContradictionParent = (ref: string): string | null | undefined => {
        const trimmed = ref.trim()
        if (trimmed === '') return null
        const byTempId = contradictionIdByTempId.get(trimmed)
        if (byTempId !== undefined) return byTempId
        return contradictions.find((node) => node.title === trimmed)?.id
      }

      while (pendingContradictions.length > 0) {
        const ready: ContradictionAcceptance[] = []
        const blocked: ContradictionAcceptance[] = []
        for (const item of pendingContradictions) {
          if (resolveContradictionParent(item.parentTempId ?? '') === undefined) blocked.push(item)
          else ready.push(item)
        }
        if (ready.length === 0) {
          throw new GateError(
            'UNKNOWN_CONTRADICTION_REF',
            'contradiction parent reference cannot be resolved: ' +
              blocked
                .map((item) => `"${item.title}" -> "${(item.parentTempId ?? '').trim()}"`)
                .join('; ') +
              '. A parentTempId must name another contradiction confirmed in this same call, ' +
              'by tempId or by title.',
            { refs: blocked.map((item) => (item.parentTempId ?? '').trim()) },
          )
        }
        for (const item of ready) {
          assertEvidence(item.evidence ?? [], `contradiction "${item.title}"`)
          if (item.type === 'core' && (item.rationale ?? '').trim().length === 0) {
            throw new GateError(
              'CORE_RATIONALE_REQUIRED',
              `core contradiction "${item.title}" needs a rationale explaining how it follows ` +
                'from the L0 root goal. Core is a structural diagnosis, not a label of importance.',
              { title: item.title },
            )
          }
          const tempId = (item.tempId ?? '').trim()
          if (tempId !== '' && contradictionIdByTempId.has(tempId)) {
            throw new GateError(
              'INVALID_ARGS',
              `two contradictions in this call share tempId "${tempId}"; a tempId is what ` +
                'children use to name their parent, so it has to be unique.',
              { tempId },
            )
          }
          if (item.relatedGoals !== undefined && item.relatedGoalRefs !== undefined) {
            throw new GateError(
              'INVALID_ARGS',
              `contradiction "${item.title}" passed both relatedGoals and relatedGoalRefs. ` +
                'relatedGoals carries the weights, so pass only that one.',
              { title: item.title },
            )
          }
          const relatedGoals: ContradictionGoalLink[] = (item.relatedGoals ?? []).map((link) => ({
            goalId: resolveGoalRef(link.goalRef),
            weight: assertContradictionWeight(
              link.weight ?? env.config.contradictions.defaultRelatedWeight,
              item.title,
            ),
          }))
          const relatedGoalIds =
            item.relatedGoals !== undefined
              ? relatedGoals.map((link) => link.goalId)
              : (item.relatedGoalRefs ?? []).map(resolveGoalRef)
          const parentId = resolveContradictionParent(item.parentTempId ?? '')
          if (parentId === undefined) {
            // Unreachable: the loop only builds items whose parent resolved.
            throw new GateError(
              'UNKNOWN_CONTRADICTION_REF',
              `contradiction "${item.title}" has an unresolvable parent reference`,
            )
          }

          const node = ContradictionNodeSchema.parse({
            id: `C_${randomUUID()}`,
            projectId,
            parentId,
            primaryGoalId: resolveGoalRef(item.primaryGoalRef),
            relatedGoalIds,
            ...(relatedGoals.length === 0 ? {} : { relatedGoals }),
            type: item.type ?? 'unclassified',
            confirmedByUser: true,
            title: item.title,
            description: item.description ?? '',
            poleA: item.poleA,
            poleB: item.poleB,
            // A confirmed node may carry the intensity the user reported while
            // confirming; `trend` stays "unknown" because it is derived from
            // observations and is never assigned directly.
            intensity: item.intensity ?? null,
            trend: 'unknown',
            rationale: item.rationale ?? '',
            resolutionHint: item.resolutionHint ?? '',
            evidence: item.evidence,
            createdAt: now,
            updatedAt: now,
          })
          contradictions.push(node)
          if (tempId !== '') contradictionIdByTempId.set(tempId, node.id)
        }
        pendingContradictions = blocked
      }

      // Program-owned invariant: a contradiction tree whose parent links dangle
      // or loop must not reach the store, and its goal links must resolve
      // against the goals confirmed in this same call.
      assertContradictionTreeShape(contradictions, goals)

      // Hierarchical semantics last: a tree must first be structurally legal and
      // referentially sound before its leaves are asked to be executable. A
      // dangling goal reference (`UNKNOWN_GOAL_REF`) or a broken contradiction
      // shape describes the caller's real bug; answering it with
      // LEAF_NOT_ACTIONABLE would send them to edit a criterion that was never
      // the problem.
      //
      // The rule itself is separate from CRITERIA_REQUIRED above: that one asks
      // whether an activity can ever be *matched* to a goal, this one whether a
      // leaf states a *checkable completion*. Both can fail independently and
      // they have different fixes.
      //
      // Whole tree rather than "this call's goals": every node in a confirm is
      // new, so the two readings coincide here; the edit path keeps the
      // whole-tree rule for the reason recorded in `goal_tree_edit`.
      const leafReport = inspectLeafActionability(goals)
      if (leafReport.issues.length > 0) {
        if (input.allowNonActionableLeaves !== true) {
          throw new GateError(
            'LEAF_NOT_ACTIONABLE',
            describeLeafActionability(leafReport),
            leafActionabilityDetails(leafReport),
          )
        }
        // The escape hatch exists for a deliberate placeholder. Without a stated
        // reason the audit entry cannot tell that from an oversight, so the flag
        // alone is not enough.
        if ((input.reason ?? '').trim().length === 0) {
          throw new GateError(
            'REASON_REQUIRED',
            'allowNonActionableLeaves requires a non-empty reason; the audit entry is the only ' +
              'record that a leaf which cannot be verified was accepted on purpose. ' +
              `${leafReport.issues.length} leaf goals are currently not executable: ` +
              `${leafReport.issues.map((issue) => `"${issue.title}"`).join('; ')}.`,
            leafActionabilityDetails(leafReport),
          )
        }
      }

      const stateVersion = current?.version ?? 0
      const goalTree = buildTree(goals)
      const contradictionTree = buildTree(contradictions)

      // Preview is a read: it renders both trees from the same data a confirm
      // would write, records the version, and returns without touching the tree.
      if (input.preview === true) {
        const goalsText = renderTreeText(goalTree.roots)
        const noDeadlineGoalRefs = Array.isArray(input.noDeadlineGoalRefs)
          ? input.noDeadlineGoalRefs.filter((item): item is string => typeof item === 'string')
          : []
        // An empty contradiction tree is a strong claim, not a blank screen.
        // Say it in words and ask the user to confirm it, instead of letting an
        // empty section read as "the renderer found nothing to show".
        const contradictionsText =
          contradictions.length === 0
            ? '（未发现结构性矛盾）\n请确认：这个项目确实没有结构性张力？如果只是材料没读全，请说明。'
            : renderTreeText(contradictionTree.roots)
        await writePreviewRecord(store.root, {
          projectId,
          version: stateVersion,
          previewedAt: now,
          noDeadlineGoalRefs,
        })
        return {
          preview: true,
          projectId,
          version: stateVersion,
          goalsText,
          contradictionsText,
          contradictionTreeEmpty: contradictions.length === 0,
          noDeadlineGoalRefs,
          warnings: [...goalTree.warnings, ...contradictionTree.warnings],
          note:
            '预览不写库。确认时要求同一版本的预览记录，并传 userApproved:true 与非空 approvalNote；' +
            '缺 deadline 的 L1 要么补日期，要么在 noDeadlineGoalRefs 里说明用户明确说过没有截止时间。',
        }
      }

      // Two-stage confirmation: the preview is what the user actually saw, and
      // it must be for the same version being confirmed. A preview of an older
      // version proves nothing about this tree.
      const previewRecord = await readPreviewRecord(store.root, projectId)
      if (
        previewRecord === undefined ||
        previewRecord.version !== stateVersion ||
        previewRecord.version !== input.expectedVersion
      ) {
        throw new GateError(
          'PREVIEW_REQUIRED',
          `this version (${stateVersion}) has not been previewed. Call goal_tree_confirm with ` +
            'preview: true first, show the returned text to the user, then confirm the same ' +
            'version with userApproved: true and approvalNote.',
          { expectedVersion: input.expectedVersion, stateVersion },
        )
      }
      if (input.userApproved !== true) {
        throw new GateError(
          'APPROVAL_REQUIRED',
          'confirmation requires userApproved: true; the preview alone does not say the user agreed.',
        )
      }
      const approvalNote = (input.approvalNote ?? '').trim()
      if (approvalNote.length === 0) {
        throw new GateError(
          'APPROVAL_NOTE_REQUIRED',
          'userApproved: true requires a non-empty approvalNote recording what the user said; ' +
            'the audit entry is the only trace of that agreement.',
        )
      }

      const role = current?.projectContext?.role
      if (role !== undefined && (role.trim().length === 0 || isPlaceholderContext(role))) {
        if (input.allowUnconfirmedContext !== true) {
          throw new GateError(
            'CONTEXT_UNCONFIRMED',
            'projectContext.role is empty or still a placeholder ' +
              `("${role.trim().length === 0 ? '（空）' : role}"). Ask the user for role, intent and ` +
              'constraints first; a tree confirmed on a guess is not a yardstick. Pass ' +
              'allowUnconfirmedContext: true with a non-empty reason only if that is deliberate.',
            { role },
          )
        }
        if ((input.reason ?? '').trim().length === 0) {
          throw new GateError(
            'REASON_REQUIRED',
            'allowUnconfirmedContext requires a non-empty reason; the audit entry is the only ' +
              'record that the missing background was accepted on purpose.',
          )
        }
      }

      const noDeadlineRefs = input.noDeadlineGoalRefs ?? previewRecord.noDeadlineGoalRefs
      const missingDeadline = goals.filter(
        (node) =>
          node.depth === 1 &&
          (node.deadline ?? '').trim().length === 0 &&
          !noDeadlineRefs.includes('*') &&
          !noDeadlineRefs.includes(node.title) &&
          !noDeadlineRefs.includes(node.id),
      )
      if (missingDeadline.length > 0) {
        throw new GateError(
          'DEADLINE_REQUIRED',
          `${missingDeadline.length} 个 L1 没有预期截止时间：` +
            `${missingDeadline.map((node) => `"${node.title}"`).join('; ')}。` +
            '请向用户确认每个 L1 的截止日期；如果用户明确说没有截止时间，把该目标标题放进 ' +
            'noDeadlineGoalRefs（用户说全部没有时用 "*"）。没有基准就无法判断「是否按期」。',
          { goals: missingDeadline.map((node) => node.title) },
        )
      }

      const commitReason =
        `${(input.reason ?? 'candidate tree confirmed by user').trim()}（用户确认：${approvalNote}）`

      const result = await store.commit(projectId, {
        expectedVersion: input.expectedVersion,
        goals,
        contradictions,
        reason: commitReason,
        action: 'init_trees',
        actor: 'user_confirmed',
        targetIds: goals.map((node) => node.id),
        evidence: [...new Set(goals.flatMap((node) => node.evidence))],
        markConfirmed: true,
      })

      return {
        preview: false,
        projectId,
        version: result.state.version,
        goals: goals.length,
        contradictions: contradictions.length,
        auditEntryId: result.audit.id,
        userApproved: true,
        approvalNote,
        previewedVersion: previewRecord.version,
      }
    },
  })
}

/** Compact projection of a goal for `goal_tree_view`. */
export interface GoalView {
  id: string
  depth: number
  title: string
  /**
   * The node's own wording, as written at confirm or revision time.
   *
   * Projected because a revision that changes only the description is otherwise
   * invisible: the write succeeds, the version bumps, and the caller reads back a
   * node that looks untouched — which invites the same edit again.
   */
  description: string
  status: string
  confirmed: boolean
  parentId: string | null
  priority: number
  successCriteria: string[]
  evidence: string[]
  relevantActivities: string[]
  explorationPolicy: string
  /**
   * Aggregated contradiction pressure on this goal.
   *
   * `Σ intensity × weight` over the unresolved tensions that touch it. Exposed
   * here because goal recommendation needs exactly this number, and computing it
   * in the projection keeps that definition from drifting away from the one the
   * pure function implements.
   */
  contradictionBurden: {
    total: number
    count: number
    peak: number
    unmeasured: number
  }
  /**
   * The tensions behind those numbers, named.
   *
   * A count alone cannot be acted on: "3" does not say whether the goal is
   * blocked by the core tension or by three minor ones. Same set the burden
   * sums over — unresolved, primary or weighted related link — strongest first.
   */
  relatedContradictions: {
    id: string
    title: string
    intensity: number | null
    weight: number
  }[]
  /**
   * Fold state, present only when the caller asked for the collapsed view and
   * this node's whole subtree is done.
   *
   * Its descendants are then absent from `goals`, and this object is the one
   * line that stands in for them. Without the flag the field is absent and every
   * goal is listed: the first look at a tree must never silently hide branches.
   */
  collapsed?: {
    /** Direct children folded away. */
    folded: number
    /** The stand-in line, e.g. `已完成（3 个子目标）`. */
    summary: string
  }
}

/** Compact projection of a contradiction for `goal_tree_view`. */
export interface ContradictionView {
  id: string
  type: string
  title: string
  /** The stated consequence of the tension; `''` when none was given. */
  description: string
  confirmed: boolean
  primaryGoalId: string
  relatedGoalIds: string[]
  /** The contradiction tree's own links, so the hierarchy is readable, not flat. */
  parentId: string | null
  /** Parent ids from the immediate parent up to the root. Empty at top level. */
  parentChain: string[]
  /** Ids of the contradictions that hang directly under this one. */
  childIds: string[]
  /**
   * Every goal this tension presses on, with its effective weight.
   *
   * Resolved through `contradictionGoalLinks`, so the primary goal appears at
   * 1.0 and a legacy id appears at the configured default: this is the list the
   * burden calculation actually reads, not merely what was stored.
   */
  goalLinks: ContradictionGoalLink[]
  /**
   * Root → primary goal, inclusive: the branch this tension sits under.
   *
   * The id alone forces a second call to know what it means; the chain makes the
   * tension readable in the goal tree's own terms, which is the whole point of
   * linking the two trees.
   */
  primaryGoalChain: { id: string; title: string; depth: number }[]
  /**
   * Other goals it presses on, with effective weights.
   *
   * The primary goal is excluded because it already has `primaryGoalChain`;
   * weights here are the resolved ones, so a legacy id appears at the configured
   * default rather than at an invented 1.0.
   */
  relatedGoals: { id: string; title: string; weight: number }[]
  poleA: string
  poleB: string
  /** Why the tension is structural, as recorded at creation or revision. */
  rationale: string
  /** What would relieve it; rewritten by `contradiction_resolved`. */
  resolutionHint: string
  intensity: number | null
  trend: string
  evidence: string[]
}

/**
 * Register `goal_tree_view`.
 *
 * @param env - shared tool environment.
 */
export function goalTreeViewTool(env: ToolEnvironment): ToolDefinition {
  return defineMetacogTool<{
    projectId: string
    version: number
    confirmed: boolean
    goals: GoalView[]
    contradictions: ContradictionView[]
    audit: { entries: number; valid: boolean }
  }>({
    name: 'goal_tree_view',
    description:
      'Read the current goal tree and contradiction tree with their version. Read-only. ' +
      'Contradictions come back with their own hierarchy (parentId, parentChain, childIds) ' +
      'and their effective goal weights, so a tension can be traced from its root to its ' +
      'concrete forms and back to every goal it burdens. Includes whether every node is ' +
      'user-confirmed, current intensity/trend per contradiction, and the audit-chain ' +
      'verification status.',
    parameters: {
      type: 'object',
      properties: {
        collapseDoneGoals: {
          type: 'boolean',
          description:
            'Fold every subtree whose goals are all done into one summary line on its parent ' +
            '(the folded descendants are omitted from `goals`). Default false: the first look at ' +
            'a tree lists every goal, and a done goal is merely marked as such. Folding is ' +
            'presentation only and changes no stored data.',
        },
      },
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    async run(args, exec) {
      const collapseDoneGoals =
        (args as { collapseDoneGoals?: unknown } | undefined)?.collapseDoneGoals === true
      const { projectId, store } = await loadProject(env, exec)
      const state: TreeState | undefined = await store.readState(projectId)
      if (state === undefined) {
        throw new GateError(
          'NOT_INITIALIZED',
          'no tree exists for this project yet; run goal_tree_init to scan for candidates, ' +
            'then goal_tree_confirm to make them the monitoring basis.',
        )
      }
      const audit = await store.verifyAuditChain(projectId)

      // Intensity and trend are derived, not stored: a recorded observation is the
      // only thing that moves them, so reading them back from the node field would
      // show `null` right after a reading was written. The node keeps only what a
      // human edited; the projection says which of the two a caller is looking at.
      const observations = await store.readObservations(projectId)
      // The contradiction tree is projected with its links intact: a flat list
      // cannot answer "what hangs under this tension", and a parent chain is what
      // makes an arbitrary-depth tree readable without a second call.
      const byContradictionId = new Map(state.contradictions.map((node) => [node.id, node]))
      const childIdsByParent = new Map<string, string[]>()
      for (const node of state.contradictions) {
        if (node.parentId === null) continue
        const children = childIdsByParent.get(node.parentId)
        if (children === undefined) childIdsByParent.set(node.parentId, [node.id])
        else children.push(node.id)
      }
      const parentChainOf = (node: ContradictionNode): string[] => {
        const chain: string[] = []
        const seen = new Set<string>([node.id])
        let cursor = node.parentId
        while (cursor !== null && !seen.has(cursor)) {
          chain.push(cursor)
          seen.add(cursor)
          cursor = byContradictionId.get(cursor)?.parentId ?? null
        }
        return chain
      }
      // Goal links read both ways: a contradiction names the branch its primary
      // goal sits on, and a goal names the tensions that press on it. Both are
      // resolved from the same tree state, so the two projections cannot disagree.
      const goalsById = new Map(state.goals.map((goal) => [goal.id, goal]))
      const goalChainOf = (goalId: string): { id: string; title: string; depth: number }[] => {
        const chain: { id: string; title: string; depth: number }[] = []
        const seen = new Set<string>()
        let cursor = goalsById.get(goalId)
        while (cursor !== undefined && !seen.has(cursor.id)) {
          chain.unshift({ id: cursor.id, title: cursor.title, depth: cursor.depth })
          seen.add(cursor.id)
          cursor = cursor.parentId === null ? undefined : goalsById.get(cursor.parentId)
        }
        return chain
      }
      const projection = state.contradictions.map((node) => {
        const trend = computeTrend(observations, node.id, env.config.thresholds.windowMinutes)
        return {
          id: node.id,
          type: node.type,
          title: node.title,
          description: node.description,
          confirmed: node.confirmedByUser,
          primaryGoalId: node.primaryGoalId,
          relatedGoalIds: node.relatedGoalIds,
          parentId: node.parentId,
          parentChain: parentChainOf(node),
          childIds: childIdsByParent.get(node.id) ?? [],
          goalLinks: contradictionGoalLinks(node, env.config.contradictions),
          primaryGoalChain: goalChainOf(node.primaryGoalId),
          relatedGoals: contradictionGoalLinks(node, env.config.contradictions)
            .filter((link) => link.goalId !== node.primaryGoalId)
            .map((link) => ({
              id: link.goalId,
              title: goalsById.get(link.goalId)?.title ?? link.goalId,
              weight: link.weight,
            })),
          poleA: node.poleA,
          poleB: node.poleB,
          rationale: node.rationale,
          resolutionHint: node.resolutionHint,
          /** What a human last wrote on the node; `null` when never edited. */
          intensityEdited: node.intensity,
          /** What the observation stream currently says, or null when it has none. */
          intensityObserved: trend.lastIntensity,
          /** The value to show: the stream wins, because it is the live evidence. */
          intensity: trend.lastIntensity ?? node.intensity,
          trend: trend.trend,
          trendSamples: trend.sampleSize,
          evidence: node.evidence,
        }
      })

      // A fold is a display choice, so it is computed here from the array and
      // never written back: the stored tree keeps every node, and the next call
      // without the flag shows all of them again.
      const collapsedView = collapseCompleted(state.goals, { collapseDone: collapseDoneGoals })
      const collapsedParents = new Map(
        collapsedView.groups
          .filter((group) => group.collapsed)
          .map((group) => [group.id, group] as const),
      )

      return {
        projectId,
        version: state.version,
        confirmed: state.confirmed,
        goals: collapsedView.visible.map((node) => {
          const burden = computeGoalContradictionBurden(
            node.id,
            state.contradictions,
            env.config.contradictions,
          )
          const folded = collapsedParents.get(node.id)
          return {
            id: node.id,
            depth: node.depth,
            title: node.title,
            description: node.description,
            status: node.status,
            confirmed: node.confirmedByUser,
            parentId: node.parentId,
            priority: node.priority,
            successCriteria: node.successCriteria,
            paths: node.paths,
            evidence: node.evidence,
            relevantActivities: node.alignment.relevantActivities,
            explorationPolicy: node.alignment.explorationPolicy,
            ...(folded === undefined
              ? {}
              : { collapsed: { folded: folded.children.length, summary: folded.summary } }),
            contradictionBurden: {
              total: burden.total,
              count: burden.count,
              peak: burden.peak,
              unmeasured: burden.unmeasured,
            },
            relatedContradictions: burden.contributions.map((item) => ({
              id: item.contradictionId,
              title: byContradictionId.get(item.contradictionId)?.title ?? item.contradictionId,
              intensity: item.intensity,
              weight: item.weight,
            })),
          }
        }),
        contradictions: projection,
        audit: { entries: audit.entries, valid: audit.valid },
      }
    },
  })
}

export { describeScan }
