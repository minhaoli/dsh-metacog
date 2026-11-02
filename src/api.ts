/**
 * Stage H: the settings card's data channel.
 *
 * The card is a Client plugin, and a browser half cannot read `.metacog/` off
 * disk. This module is the Host side of that divide: one prefix route under
 * `/api/metacog` that answers the small set of questions the card asks, and
 * performs the two actions it offers.
 *
 * Three rules shape it:
 *
 * - **The route never invents a project.** A request names a project id, and the
 *   id is resolved against the roots this mount actually knows. A caller cannot
 *   point the route at an arbitrary directory.
 * - **Every action reuses the governed write path.** Generating a report and
 *   archiving signals call the same functions the tools call, so a card click
 *   and a model tool call leave the same audit trail.
 * - **Cross-origin writes are refused.** A browser POST from another origin
 *   carries an `Origin` header that does not match `Host`; there is no reason
 *   for the card's own same-origin requests to be rejected.
 *
 * @module dsh-metacog/api
 */
import { IncomingMessage, ServerResponse } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'

import type { Disposer, HostContext, ToolRunContext } from './host.js'
import type { MetacogConfig } from './config.js'
import { EDITABLE_PATHS, readOverrides, readPath, writeOverride } from './settings.js'
import type { MetacogStore } from './data/store.js'
import { InterventionDecisionSchema, type GeneratedReport, type TreeState } from './data/types.js'
import { deriveProjectId } from './tools/shared.js'
import { metacogDraftCriteriaTool } from './tools/criteria.js'
import { resolveInterventionDecision } from './tools/drift.js'
import { generateReport, reportCadenceDir, reportMarkdownPath, type ReportType } from './report.js'
import { summarizeAchievements } from './analysis/achievements.js'

/** What the route needs from the mount it belongs to. */
export interface ApiOptions {
  /** Resolved plugin configuration, for thresholds and the storage subdirectory. */
  readonly config: MetacogConfig
  /**
   * Absolute project roots this mount can serve.
   *
   * The mount owns this set: the periodic sweep knows the projects it monitors,
   * and the workspace registry supplies the rest. Returning an empty list is
   * legitimate — the card then shows an empty state instead of an error.
   */
  readonly listRoots: () => Promise<string[]>
  /** Store for one root, reusing the mount's cache so reads share one lock. */
  readonly storeFor: (root: string) => MetacogStore
  /**
   * The profile config as written, before card overrides.
   *
   * Needed to validate a written override against a full shape: the effective
   * config already contains the old overrides, so validating against it would let a
   * value pass that fails once the profile changes.
   */
  readonly profileConfig?: unknown
  /**
   * The model the harness would use for a monitor call, when it can be read.
   *
   * Optional and read-only: a plugin writing the global model selection would be
   * reaching outside its own configuration, and the card says so rather than
   * offering a control that does not exist.
   */
  readonly defaultModel?: () => { provider?: string; model?: string } | undefined
  /** Run the static half of a sweep for one project; the model half needs a session. */
  readonly runSweep?: (projectId: string) => Promise<{ ran: boolean; signals: number; hints: string[] }>
  /**
   * Where cross-workspace reports are read from.
   *
   * Reports cover every workspace at once and are written to a global sink, so
   * asking any single project's store would return nothing — the card would show
   * an empty list while the files sat on disk. Injected rather than derived here
   * because the sink's location is the mount's decision, not the route's.
   */
  readonly readReports?: () => Promise<readonly GeneratedReport[]>
  /** Generate one report covering every workspace. */
  readonly generateReport?: (type: ReportType) => Promise<GeneratedReport>
  /** The global sink's root, for the "open folder" action. */
  readonly reportRoot?: () => string
  /**
   * Hand a path to the desktop shell.
   *
   * Injectable so a test can assert on the target without launching an editor or
   * popping a "Windows cannot find the file" dialog on the user's screen. The
   * default is {@link openInShell}.
   */
  readonly opener?: (target: string, what: 'file' | 'folder') => Promise<{ ok: boolean; error?: string }>
  /** Clear one project's record, using the same rules the tool enforces. */
  readonly purgeProject?: (
    root: string,
    projectId: string,
    reason: string,
    scope: 'records' | 'everything',
  ) => Promise<{ deleted: string[]; files: number; bytes: number }>
  /**
   * Edit the goal tree through the governed write path.
   *
   * Injected as the *tool instance* rather than re-implemented here: the tool
   * carries the compare-and-set check, the structural gate (L0 needs
   * `userConfirmed`, L1 needs a reason, only a leaf can be deleted) and the audit
   * entry. A second write path would be a second set of rules, and the two would
   * drift until one of them let through something the other refused.
   */
  readonly editTree?: (args: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; error?: string }>
}

/** A resolved project, or nothing when the id names no known root. */
interface ResolvedProject {
  readonly root: string
  readonly projectId: string
}

/**
 * The slice of the host `llm` service the model picker reads.
 *
 * Kept structural rather than importing the host package: the route only needs
 * two read calls, and a test can stand in a fake without constructing an
 * adapter registry.
 */
interface LlmCatalogLike {
  listProviders(): unknown
  listModels(provider: string): unknown
}

/** Report cadences the action endpoint accepts. */
const REPORT_TYPES: readonly ReportType[] = ['daily', 'weekly', 'monthly']

/**
 * Mount the card's HTTP channel.
 *
 * @param ctx - plugin context.
 * @param options - roots and stores owned by the mount.
 * @returns the disposer removing the route, or `undefined` when the host has no
 *   web server (a headless deployment has nowhere to serve the card either).
 */
export function installApi(ctx: HostContext, options: ApiOptions): Disposer | undefined {
  // Property access, not `ctx.get`: the service is declared in `inject`, so it is
  // linked into this context and present here whenever the plugin mounts.
  const webServer = ctx.webServer
  if (webServer === undefined) {
    ctx.logger.warn('[dsh-metacog] host injected "webServer" but exposes no route registry')
    return undefined
  }

  const resolveProject = async (projectId: string | null): Promise<ResolvedProject | undefined> => {
    const roots = await options.listRoots()
    for (const root of roots) {
      const derived = deriveProjectId(root)
      if (projectId !== null && derived !== projectId) continue
      const store = options.storeFor(root)
      const state = await store.readState(derived)
      // The "no tree, skip it" rule exists for the implicit case: a caller asking for
      // "whichever project" must not be handed an empty scaffold.
      //
      // It must not apply when the caller named an id. A shell project — a workspace
      // someone opened once and abandoned — has no tree but *is* on the list the card
      // shows, so refusing to resolve it meant the card could display it and every
      // action against it answered 404. That is why deleting one did nothing: the
      // request never reached the delete.
      if (projectId === null && state === undefined) continue
      return { root, projectId: derived }
    }
    return undefined
  }

  const handler: RouteHandler = async (req, res) => {
    try {
      if (!sameOrigin(req)) {
        send(res, 403, { ok: false, error: 'cross-origin request rejected' })
        return
      }
      const url = new URL(req.url ?? '/api/metacog', 'http://dsh.local')
      const path = url.pathname.replace(/\/+$/, '')
      const method = (req.method ?? 'GET').toUpperCase()

      if (method === 'GET' && path === '/api/metacog/projects') {
        const projects = await collectProjects(options)
        send(res, 200, { ok: true, projects })
        return
      }

      if (method === 'GET' && path === '/api/metacog/reports') {
        const project = await resolveProject(url.searchParams.get('projectId'))
        if (project === undefined) {
          send(res, 404, { ok: false, error: 'no such project' })
          return
        }
        // Cross-workspace reports live in the global sink, not in this project's
        // store. Reading the project's own records would list nothing while the
        // files sat on disk.
        const reports = await (options.readReports?.() ?? Promise.resolve([]))
        send(res, 200, { ok: true, projectId: project.projectId, reports: reports.map(reportSummary) })
        return
      }

      if (method === 'GET' && path === '/api/metacog/report') {
        const project = await resolveProject(url.searchParams.get('projectId'))
        if (project === undefined) {
          send(res, 404, { ok: false, error: 'no such project' })
          return
        }
        const reportId = url.searchParams.get('reportId')
        const reports = await (options.readReports?.() ?? Promise.resolve([]))
        const report = reports.find((item) => item.id === reportId)
        if (report === undefined) {
          send(res, 404, { ok: false, error: 'no such report' })
          return
        }
        send(res, 200, { ok: true, report: { ...reportSummary(report), markdown: report.markdown } })
        return
      }

      if (method === 'POST' && path === '/api/metacog/report') {
        const body = await readJson(req)
        const type = typeof body.type === 'string' ? body.type : 'daily'
        if (!REPORT_TYPES.includes(type as ReportType)) {
          send(res, 400, { ok: false, error: `type must be one of ${REPORT_TYPES.join(', ')}` })
          return
        }
        const project = await resolveProject(projectIdOf(body))
        if (project === undefined) {
          send(res, 404, { ok: false, error: 'no such project' })
          return
        }
        // The card's button produces the same cross-workspace report the timer
        // does, so a hand-generated report and an automatic one are the same
        // document rather than two files with different scopes.
        const report = await (options.generateReport?.(type as ReportType) ??
          Promise.reject(new Error('report generation is not wired')))
        send(res, 200, { ok: true, report: reportSummary(report) })
        return
      }

      if (method === 'POST' && path === '/api/metacog/signals/archive') {
        const body = await readJson(req)
        const project = await resolveProject(projectIdOf(body))
        if (project === undefined) {
          send(res, 404, { ok: false, error: 'no such project' })
          return
        }
        const result = await options
          .storeFor(project.root)
          .archiveSignals(project.projectId, 'archived from the settings card')
        send(res, 200, { ok: true, archived: result.archived, path: result.path })
        return
      }

      if (method === 'GET' && path === '/api/metacog/usage') {
        const project = await resolveProject(url.searchParams.get('projectId'))
        if (project === undefined) {
          send(res, 404, { ok: false, error: 'no such project' })
          return
        }
        // Reported as counts, not tokens. The activity stream carries no token
        // usage, so a token figure here would be invented; what is real is how much
        // the monitor itself asked the model to do, and how much of the record it
        // is sitting on.
        const store = options.storeFor(project.root)
        const [activities, signals, judgments, interventions, reports] = await Promise.all([
          store.readActivities(project.projectId),
          store.readSignals(project.projectId),
          store.readJudgments(project.projectId),
          store.readInterventions(project.projectId),
          store.readReports(project.projectId),
        ])
        const settled = judgments.filter((row) => row.status !== 'pending')
        send(res, 200, {
          ok: true,
          projectId: project.projectId,
          usage: {
            activities: activities.length,
            signals: signals.length,
            judgments: judgments.length,
            pendingJudgments: judgments.length - settled.length,
            interventions: interventions.length,
            pendingInterventions: interventions.filter((row) => row.status === 'pending').length,
            reports: reports.length,
            // Stated explicitly, because its absence is the honest answer:
            tokenUsage: null,
            tokenUsageNote: '活动流里没有 token 用量，这里不编造数字',
          },
        })
        return
      }

      if (method === 'GET' && path === '/api/metacog/llm') {
        // What the monitor may use for its model calls. Read-only: pointing the
        // whole harness at a model is a different setting on a different surface,
        // and a plugin writing it would be reaching outside its own config.
        const agent = options.defaultModel?.()
        send(res, 200, {
          ok: true,
          llm: {
            provider: agent?.provider ?? null,
            model: agent?.model ?? null,
            note:
              agent === undefined
                ? '读不到全局模型。复核与巡检会沿用调用方的模型；设置卡只能显示，不能改。'
                : '复核与巡检沿用这个模型。插件没有自己的模型配置，改这里会改到全局。',
          },
        })
        return
      }

      if (method === 'GET' && path === '/api/metacog/models') {
        // The settings card needs to offer a model picker, so this route is a
        // read-only passthrough of the host's provider catalog. It never writes
        // the global selection: choosing a model for the monitor belongs in the
        // plugin's own config, and a card that silently changed the harness
        // default would be reaching outside its own surface.
        const llm = ctx.get('llm') as LlmCatalogLike | undefined
        if (llm === undefined || typeof llm.listProviders !== 'function') {
          send(res, 200, { ok: true, providers: [], note: '宿主没有 llm 服务，无法列出模型' })
          return
        }
        try {
          send(res, 200, { ok: true, providers: await listProviderModels(llm) })
        } catch (error) {
          send(res, 500, { ok: false, error: String(error) })
        }
        return
      }

      if (method === 'POST' && path === '/api/metacog/criteria') {
        // The card needs the same suggestions the model gets from
        // `metacog_draft_criteria`. Reusing the tool (not a second prompt here)
        // keeps the quality gates, the per-goal cap and the "no empty array"
        // failure contract in one place.
        const body = await readJson(req)
        const project = await resolveProject(projectIdOf(body))
        if (project === undefined) {
          send(res, 404, { ok: false, error: 'no such project' })
          return
        }
        const tool = metacogDraftCriteriaTool({
          ctx,
          config: options.config,
          // The card already resolved the project from the id it was asked
          // about; the tool must not fall back to the session's workspace.
          resolveProjectRoot: async (_exec, explicit) => explicit ?? project.root,
          storeFor: options.storeFor,
        })
        const args: Record<string, unknown> = {}
        if (Array.isArray(body.goalIds)) {
          args.goalIds = body.goalIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
        }
        if (typeof body.limit === 'number') args.limit = body.limit
        if (typeof body.overwrite === 'boolean') args.overwrite = body.overwrite
        // The endpoint is a suggestion surface. It never writes: the user has to
        // tick suggestions and confirm through /tree/edit.
        args.dryRun = true
        const outcome = (await tool.execute(args, {
          callId: 'api-criteria',
          name: 'metacog_draft_criteria',
          arguments: args,
          signal: new AbortController().signal,
          projectRoot: project.root,
        } as ToolRunContext & { projectRoot: string })) as {
          ok: boolean
          data?: Record<string, unknown>
          error?: { code?: string; message?: string }
        }
        if (!outcome.ok) {
          const code = outcome.error?.code
          const status = code === 'LLM_UNAVAILABLE' || code === 'LLM_NOT_CONFIGURED' ? 503 : 400
          send(res, status, outcome)
          return
        }
        send(res, 200, { ok: true, projectId: project.projectId, ...(outcome.data ?? {}) })
        return
      }

      if (method === 'GET' && path === '/api/metacog/verdicts') {
        const project = await resolveProject(url.searchParams.get('projectId'))
        if (project === undefined) {
          send(res, 404, { ok: false, error: 'no such project' })
          return
        }
        const rawLimit = Number(url.searchParams.get('limit') ?? '20')
        const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.floor(rawLimit))) : 20
        const store = options.storeFor(project.root)
        const [records, state] = await Promise.all([
          store.readVerdicts(project.projectId),
          store.readState(project.projectId),
        ])
        const titleById = new Map((state?.goals ?? []).map((goal) => [goal.id, goal.title]))
        const verdicts = records
          .slice(-limit)
          .reverse()
          .map((record) => ({
            ...record,
            goalTitle: record.goalId === null ? null : titleById.get(record.goalId) ?? null,
          }))
        send(res, 200, { ok: true, projectId: project.projectId, verdicts })
        return
      }

      if (method === 'POST' && path === '/api/metacog/sweep') {
        const body = await readJson(req)
        const project = await resolveProject(projectIdOf(body))
        if (project === undefined) {
          send(res, 404, { ok: false, error: 'no such project' })
          return
        }
        // The sweep needs no agent: it is a static check over recorded activity and
        // file changes. The model-review half is skipped here on purpose — a card
        // click has no conversation to attribute a subagent call to, so claiming to
        // have run a review would be false.
        const started = Date.now()
        const result = await options.runSweep?.(project.projectId)
        send(res, 200, {
          ok: true,
          projectId: project.projectId,
          sweep: {
            ran: result?.ran ?? false,
            signals: result?.signals ?? 0,
            hints: result?.hints ?? [],
            elapsedMs: Date.now() - started,
            note:
              '只跑了静态检查与文件扫描。模型复核需要会话上下文，请用 /metacog-check 或在工具里调用。',
          },
        })
        return
      }

      if (method === 'POST' && path === '/api/metacog/milestone') {
        const body = await readJson(req)
        const project = await resolveProject(projectIdOf(body))
        if (project === undefined) {
          send(res, 404, { ok: false, error: 'no such project' })
          return
        }
        const label = typeof body.label === 'string' ? body.label.trim() : ''
        const note = typeof body.note === 'string' ? body.note.trim() : ''
        if (label.length === 0) {
          send(res, 400, { ok: false, error: 'label is required' })
          return
        }
        // The note is optional. Requiring it produced one-word answers, and the
        // label plus the captured snapshot already say what was archived; the
        // reason is a nicety, not the record.
        const archived = await options.storeFor(project.root).archiveMilestone(project.projectId, label, note)
        send(res, 200, { ok: true, version: archived.version, path: archived.path })
        return
      }

      // Reading archived milestones.
      //
      // Archive was write-only: a milestone could be recorded but never seen again,
      // so the comparison it exists for — "did judgement improve after the tree
      // changed" — had both halves on disk with no way to line them up.
      if (method === 'GET' && path === '/api/metacog/milestone') {
        const project = await resolveProject(url.searchParams.get('projectId'))
        if (project === undefined) {
          send(res, 404, { ok: false, error: 'no such project' })
          return
        }
        const store = options.storeFor(project.root)
        const id = url.searchParams.get('milestonePath')
        if (id !== null && id.length > 0) {
          // A specific milestone, in full. The store fences the path to this
          // project's archive directory, so a caller cannot read arbitrary files.
          const milestone = await store.readMilestone(project.projectId, id)
          if (milestone === undefined) {
            send(res, 404, { ok: false, error: 'no such milestone' })
            return
          }
          send(res, 200, { ok: true, milestone })
          return
        }
        const milestones = await store.listMilestones(project.projectId)
        send(res, 200, { ok: true, projectId: project.projectId, milestones })
        return
      }

      if (method === 'GET' && path === '/api/metacog/settings') {
        // What the card may change, with the current effective value and whether it
        // came from the override file. Sending the shape rather than a bare value
        // lets the card render "changed" without knowing the schema.
        const overrides = readOverrides()
        const flat = EDITABLE_PATHS.map((dotted) => {
          const parts = dotted.split('.')
          let node: unknown = overrides
          let overridden = true
          for (const part of parts) {
            if (node === null || typeof node !== 'object' || !(part in (node as object))) {
              overridden = false
              break
            }
            node = (node as Record<string, unknown>)[part]
          }
          return {
            path: dotted,
            value: readPath(options.config, dotted),
            overridden,
            // A restart is needed because the running mount already parsed its
            // config; pretending otherwise would make the card look broken.
            requiresRestart: true,
          }
        })
        send(res, 200, { ok: true, editable: flat })
        return
      }

      if (method === 'POST' && path === '/api/metacog/settings') {
        const body = await readJson(req)
        const dotted = typeof body.path === 'string' ? body.path : ''
        if (dotted.length === 0) {
          send(res, 400, { ok: false, error: 'path is required' })
          return
        }
        try {
          await writeOverride(dotted, body.value, options.profileConfig)
        } catch (error) {
          send(res, 400, { ok: false, error: String(error) })
          return
        }
        send(res, 200, { ok: true, path: dotted, value: body.value, requiresRestart: true })
        return
      }

      if (method === 'POST' && path === '/api/metacog/purge') {
        const body = await readJson(req)
        const project = await resolveProject(projectIdOf(body))
        if (project === undefined) {
          send(res, 404, { ok: false, error: 'no such project' })
          return
        }
        // Same contract as the tool: the id must be typed out, and the reason is
        // recorded. A card that could clear the record with one click would make
        // the typed-id rule pointless.
        const confirm = typeof body.confirmProjectId === 'string' ? body.confirmProjectId.trim() : ''
        const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
        if (confirm !== project.projectId) {
          send(res, 400, {
            ok: false,
            error: `confirmation does not match this project (resolved "${project.projectId}")`,
          })
          return
        }
        // Reason is optional; the record of what was deleted is what the audit needs.
        const scope = body.scope === 'everything' ? 'everything' : 'records'
        const purged = await options.purgeProject?.(project.root, project.projectId, reason, scope)
        send(res, 200, { ok: true, purged })
        return
      }

      // Settling a pending intervention from the card.
      //
      // The card could show a count of pending decisions but not act on one, so the
      // only way to close a card was a tool call in a conversation. That is why the
      // feedback channels stayed empty: the surface that lists "needs your
      // decision" had no way to take one.
      if (method === 'POST' && path === '/api/metacog/intervention') {
        const body = await readJson(req)
        const project = await resolveProject(projectIdOf(body))
        if (project === undefined) {
          send(res, 404, { ok: false, error: 'no such project' })
          return
        }
        const interventionId = typeof body.interventionId === 'string' ? body.interventionId.trim() : ''
        const decision = typeof body.decision === 'string' ? body.decision : ''
        const rationale = typeof body.rationale === 'string' ? body.rationale.trim() : ''
        if (interventionId.length === 0) {
          send(res, 400, { ok: false, error: 'interventionId is required' })
          return
        }
        // The schema's own option list, so the route cannot drift from what the
        // store accepts: adding a decision to the enum teaches this route too.
        const decisions = InterventionDecisionSchema.options
        if (!decisions.includes(decision as (typeof decisions)[number])) {
          send(res, 400, { ok: false, error: `decision must be one of ${decisions.join(', ')}` })
          return
        }
        // The reason is required here as it is in the tool: the audit entry is the
        // whole point of recording a decision.
        if (rationale.length === 0) {
          send(res, 400, { ok: false, error: 'rationale is required' })
          return
        }
        try {
          const decided = await resolveInterventionDecision(
            options.storeFor(project.root),
            project.projectId,
            interventionId,
            decision as (typeof decisions)[number],
            rationale,
          )
          send(res, 200, { ok: true, decided })
        } catch (error) {
          // A card that is no longer pending is a normal race, not a server fault.
          send(res, 400, { ok: false, error: String(error) })
        }
        return
      }

      // Opening a file or a folder is the one action here that runs the desktop
      // shell. It is deliberately not a general "open any path" endpoint: the
      // path is rebuilt from the project root and the cadence on every call, so a
      // request can only ever ask for a report file this plugin writes.
      if (method === 'POST' && path === '/api/metacog/report/open') {
        const body = await readJson(req)
        const project = await resolveProject(projectIdOf(body))
        if (project === undefined) {
          send(res, 404, { ok: false, error: 'no such project' })
          return
        }
        const type = typeof body.type === 'string' ? body.type : ''
        const what = body.what === 'folder' ? 'folder' : 'file'
        if (!REPORT_TYPES.includes(type as ReportType)) {
          send(res, 400, { ok: false, error: `type must be one of ${REPORT_TYPES.join(', ')}` })
          return
        }
        // `at` picks the bucket: the card sends the report's period end, so the
        // button opens the file for the period being looked at rather than
        // today's. Defaulting to now keeps the button working when nothing is
        // selected.
        const rawAt = typeof body.at === 'string' ? body.at : ''
        const parsedAt = rawAt === '' ? new Date() : new Date(rawAt)
        const at = Number.isNaN(parsedAt.getTime()) ? new Date() : parsedAt
        // The sink's root, not the project's: reports are cross-workspace now, so
        // the file for this period lives under the global directory. Falling back
        // to the project root keeps a deployment without a global sink working.
        const storage = options.reportRoot?.() ?? join(project.root, options.config.storageSubdir)
        const target =
          what === 'folder'
            ? reportCadenceDir(storage, type as ReportType)
            : reportMarkdownPath(storage, type as ReportType, at)
        // Checked before handing the path to the shell: opening a file that does
        // not exist yet is not a shell error to show the user, it is "you have not
        // generated one of these". The folder is created on demand because
        // "show me where they will go" is a legitimate question before the first
        // report exists.
        if (what === 'folder') {
          await mkdir(target, { recursive: true }).catch(() => {})
        } else {
          const exists = await stat(target).then(
            () => true,
            () => false,
          )
          if (!exists) {
            send(res, 404, {
              ok: false,
              path: target,
              error: `这个周期的${type === 'daily' ? '日报' : type === 'weekly' ? '周报' : '月报'}还没生成过，文件不存在`,
            })
            return
          }
        }
        const outcome = await (options.opener ?? openInShell)(target, what)
        send(res, outcome.ok ? 200 : 500, { ok: outcome.ok, path: target, error: outcome.error })
        return
      }

      // Editing the goal tree from the card.
      //
      // The whole argument object is forwarded to the tool unchanged: the card is
      // a second *surface* for the governed write, not a second implementation of
      // it. Whatever the tool refuses — a stale version, an L1 edit without a
      // reason, deleting a node that still has children — is refused here for the
      // same reason and with the same message.
      if (method === 'POST' && path === '/api/metacog/tree/edit') {
        const body = await readJson(req)
        const project = await resolveProject(projectIdOf(body))
        if (project === undefined) {
          send(res, 404, { ok: false, error: 'no such project' })
          return
        }
        if (options.editTree === undefined) {
          send(res, 501, { ok: false, error: 'tree editing is not wired on this mount' })
          return
        }
        const args = body.args
        if (args === null || typeof args !== 'object' || Array.isArray(args)) {
          send(res, 400, { ok: false, error: 'args must be an object' })
          return
        }
        // `expectedVersion` is the card's optimistic-concurrency token. Requiring
        // it here means a stale card cannot silently overwrite a tree someone else
        // changed — the same guarantee the tool gives a model caller.
        if (typeof (args as Record<string, unknown>).expectedVersion !== 'number') {
          send(res, 400, { ok: false, error: 'args.expectedVersion is required' })
          return
        }
        const outcome = await options.editTree({ ...(args as Record<string, unknown>), projectRoot: project.root })
        // The tool reports refusals as `{ok:false, error}` rather than throwing, so
        // the status follows its verdict instead of this route guessing.
        send(res, outcome.ok ? 200 : 400, outcome)
        return
      }

      send(res, 404, { ok: false, error: `unknown endpoint ${method} ${path}` })
    } catch (error) {
      // A card that fails must not take the web server down with it.
      ctx.logger.warn(`[dsh-metacog] settings card request failed: ${String(error)}`)
      send(res, 500, { ok: false, error: String(error) })
    }
  }

  return webServer.register({ kind: 'prefix', path: '/api/metacog', handler })
}

/** One route handler signature, kept local so the module carries no host types. */
type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/** Write one JSON response. */
function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** Read a small JSON request body; anything malformed becomes an empty object. */
function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 65_536) {
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') {
        resolve({})
        return
      }
      try {
        const parsed: unknown = JSON.parse(raw)
        resolve(parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

/**
 * Reject a request whose `Origin` disagrees with `Host`.
 *
 * Same-origin card requests match; a cross-site form post does not. A request
 * with no `Origin` (a local script, curl) is allowed — the card is not the only
 * legitimate caller and refusing it would break scripted checks.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  // No origin at all is a same-origin fetch or a non-browser client; both are allowed.
  if (origin === undefined || origin.length === 0) return true

  // The desktop client is an Electron renderer. Its fetches carry an opaque origin —
  // `file://` or the literal `null` — and the previous rule rejected both. That blocked
  // every POST from the card while GETs (which do not send an origin) sailed through,
  // so the list appeared and every button did nothing. It looked exactly like a broken
  // delete; it was the CSRF guard turning away the host's own UI.
  //
  // The guard exists to stop a *remote page* from driving this local server. Opaque
  // origins are exactly what a local app sends, and a remote site cannot forge them:
  // the browser sets this header itself.
  if (origin === 'null' || origin.startsWith('file://')) {
    // A local page can send a request but cannot read the response, so the exposure is a
    // blind write rather than data theft. Requiring a JSON content type keeps an
    // ordinary HTML form (which can only send form encodings) from driving the writes.
    const method = (req.method ?? 'GET').toUpperCase()
    if (method === 'GET' || method === 'HEAD') return true
    const type = String(req.headers['content-type'] ?? '')
    return type.includes('application/json')
  }

  const host = String(req.headers.host ?? '')
  try {
    const parsed = new URL(origin)
    return parsed.host === host && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
  } catch {
    return false
  }
}

/** Read a project id out of a request body, refusing anything that is not a string. */
function projectIdOf(body: Record<string, unknown>): string | null {
  const value = body.projectId
  return typeof value === 'string' && value.length > 0 ? value : null
}

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
export function openInShell(
  target: string,
  what: 'file' | 'folder',
): Promise<{ ok: boolean; error?: string }> {
  return launchChain(planFor(target, what))
}

/**
 * Try each candidate command in order until one actually starts.
 *
 * This shape is taken from `dsh-better-sidebar`'s `launchExternal`, which solves
 * the same problem and documents the reason for a chain rather than one command:
 * its note on #412 records that a single `rundll32` route reported
 * `{ started: true }` while nothing opened. One command that lies is worse than
 * two where the second can succeed.
 *
 * The resolution rule is the part that matters: `spawn` emitting `spawn` is NOT
 * success. A detached child can start and die immediately — measured here, VSCode
 * spawned and exited with code 1, leaving no process — so this waits a short grace
 * period and treats "exited right away" as a failure worth trying the next
 * candidate for.
 *
 * @param chain - candidate commands, best first.
 */
async function launchChain(
  chain: readonly { run: string; args: string[] }[],
): Promise<{ ok: boolean; error?: string }> {
  const failures: string[] = []
  for (const [index, spec] of chain.entries()) {
    const outcome = await launchOne(spec)
    if (outcome.ok) return outcome
    failures.push(`${spec.run}: ${outcome.error ?? 'did not start'}`)
    // Only the last candidate's failure is worth reporting, plus how many were
    // tried: a chain of three identical errors is noise.
    if (index === chain.length - 1) break
  }
  return { ok: false, error: failures.join(' | ') }
}

/**
 * Start one command and decide whether it really took.
 *
 * On Windows this does NOT use `spawn`, and that is the whole point. DSH runs its
 * children inside a Windows Job Object (`dsh-subprocess-local` kills the tree when
 * the host exits). A process started with `spawn` belongs to that job, so an editor
 * launched from here is torn down the moment the launcher exits — measured: every
 * `spawn` variant started VSCode and left zero processes, while the same
 * executable launched through WMI left eleven.
 *
 * `Win32_Process.Create` asks the WMI service to start the process, so it is a
 * child of `WmiPrvSE.exe` rather than of this plugin, and the job does not contain
 * it. That is what makes the window survive.
 *
 * Everywhere else `spawn` is used as before.
 *
 * @param spec - the command to run.
 */
function launchOne(spec: { run: string; args: string[] }): Promise<{ ok: boolean; error?: string }> {
  if (process.platform === 'win32') return launchViaWmi(spec)
  return launchViaSpawn(spec)
}

/**
 * Start a process outside this plugin's job object, through the WMI service.
 *
 * Quoting matters more here than with `spawn`: WMI takes one command line string,
 * not an argv array, so every argument has to be quoted for the target program's
 * own parser. Arguments are wrapped and embedded quotes are escaped, which is the
 * Windows convention.
 *
 * @param spec - the command to run.
 */
function launchViaWmi(spec: { run: string; args: string[] }): Promise<{ ok: boolean; error?: string }> {
  const quote = (value: string): string => `"${value.replace(/"/g, '\\"')}"`
  const commandLine = [spec.run, ...spec.args].map(quote).join(' ')
  return new Promise((resolve) => {
    try {
      const result = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          // `ReturnValue` is 0 on success and a Win32 error code otherwise; the
          // process id is only meaningful when it is 0.
          `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${commandLine.replace(/'/g, "''")}' } -ErrorAction SilentlyContinue; if ($null -eq $r) { 'ERR:none' } else { "$($r.ReturnValue)|$($r.ProcessId)" }`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      ).trim()
      const [code, pid] = result.split('|')
      if (code === '0') {
        resolve({ ok: true })
        return
      }
      resolve({ ok: false, error: `WMI returned ${code === undefined ? 'no result' : code} (pid ${pid ?? '-'})` })
    } catch (error) {
      resolve({ ok: false, error: String(error) })
    }
  })
}

/**
 * Start a process as a child of this one.
 *
 * Used on platforms without a job object to escape, where a detached child does
 * outlive its parent.
 *
 * @param spec - the command to run.
 */
function launchViaSpawn(spec: { run: string; args: string[] }): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: { ok: boolean; error?: string }): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    try {
      const child = spawn(spec.run, spec.args, {
        detached: true,
        stdio: 'ignore',
        // `false`, not `true`. `windowsHide` suppresses the window of a *console*
        // program, but `explorer.exe` and an editor are GUI programs: hiding them
        // makes the action look like it did nothing.
        windowsHide: false,
      })
      child.on('error', (error: unknown) => finish({ ok: false, error: String(error) }))
      child.on('exit', (code) => {
        // A launcher that exits 0 handed the work off successfully; anything else
        // means it gave up, and the next candidate deserves a turn.
        finish(code === 0 ? { ok: true } : { ok: false, error: `exited with code ${String(code)}` })
      })
      // Still running after the grace period: it opened its own window, which is
      // the normal case for an editor that was not already running.
      setTimeout(() => {
        if (settled) return
        child.unref()
        finish({ ok: true })
      }, 700)
    } catch (error) {
      finish({ ok: false, error: String(error) })
    }
  })
}

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
export function planFor(target: string, what: 'file' | 'folder'): { run: string; args: string[] }[] {
  const platform = process.platform
  if (platform === 'win32') {
    if (what === 'folder') return [{ run: 'explorer.exe', args: [target] }]
    // The user's own default application, resolved from the registry and started
    // by its executable path.
    //
    // `rundll32 url.dll,FileProtocolHandler` is the tidier-looking route and it is
    // what the sidebar plugin uses, but measured here it returns success and opens
    // nothing — the same #412 failure. Resolving the handler and passing the file
    // as an argument works, and it still honours whatever the user has associated
    // with the extension, so "default application" is preserved.
    const chain: { run: string; args: string[] }[] = []
    const handler = windowsHandlerFor(target)
    if (handler !== undefined) chain.push(handler)
    // The editor's URL scheme: a second route for the case where the association
    // resolves to something that cannot take a plain path.
    const url = editorUrl(target)
    if (url !== undefined && !cmdUnsafe(url)) {
      chain.push({ run: 'cmd.exe', args: ['/d', '/c', 'start', '', url] })
    }
    // Notepad last: it needs no association at all, so the button always does
    // something visible rather than nothing.
    chain.push({ run: 'notepad.exe', args: [target] })
    return chain
  }
  if (platform === 'darwin') return [{ run: 'open', args: [target] }]
  return [{ run: 'xdg-open', args: [target] }]
}

/**
 * The editor URL scheme for a local file, when one is registered.
 *
 * `vscode://file/<slash path>` is what the sidebar plugin hands to the OS. The
 * scheme has to exist: on a machine without VSCode the chain skips straight to the
 * generic handler rather than launching a dead protocol.
 *
 * @param target - absolute path to the file.
 */
function editorUrl(target: string): string | undefined {
  const scheme = ['vscode', 'cursor', 'zed'].find((name) => schemeRegistered(name))
  if (scheme === undefined) return undefined
  // Collapse repeated separators first: a Windows path that already contains both
  // kinds turns into `C://Users//x`, which no editor resolves.
  const slashed = target.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  // A drive-letter path needs a leading slash after `file`, giving
  // `vscode://file/C:/...`.
  return `${scheme}://file/${slashed.replace(/^\/+/, '')}`
}

/** Whether a URL scheme has a registered handler. */
function schemeRegistered(scheme: string): boolean {
  try {
    execFileSync('reg.exe', ['query', `HKCR\\${scheme}\\shell\\open\\command`, '/ve'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    return true
  } catch {
    return false
  }
}

/** Characters `cmd.exe` would reinterpret, which disqualify the `start` route. */
const CMD_METACHARACTERS = /[&|<>^%!()]/

/**
 * Whether a string is unsafe to pass through `cmd.exe`.
 *
 * `start` is the shortest working route on Windows but it goes through cmd's
 * parser, so anything with shell metacharacters has to take the `rundll32` route
 * instead.
 *
 * @param value - the URL or path about to be passed to `cmd /c start`.
 */
function cmdUnsafe(value: string): boolean {
  return CMD_METACHARACTERS.test(value)
}

/**
 * Resolve the program the user's system opens this file type with.
 *
 * Two levels, and only one of them is where a naive lookup looks:
 *
 * 1. `HKCU\...\FileExts\<ext>\UserChoice` holds the per-user ProgID. This is what
 *    Explorer honours. The ProgID lives in a value **named** `ProgId`, so it must
 *    be read with `reg query ... /v ProgId`. Reading `/ve` (the unnamed default)
 *    returns `(value not set)` and makes an association that exists look absent —
 *    that mistake sent an earlier version down the Notepad fallback.
 * 2. That ProgID's `shell\open\command` gives `"<exe>" "%1"`.
 *
 * @param target - absolute path whose extension decides the handler.
 * @returns the executable and arguments, or `undefined` when nothing is registered.
 */
function windowsHandlerFor(target: string): { run: string; args: string[] } | undefined {
  const extension = extname(target).toLowerCase()
  if (extension === '') return undefined

  /** Read one registry value; `(value not set)` and failures both become ''. */
  const query = (key: string, valueName?: string): string => {
    try {
      const args = valueName === undefined ? ['query', key, '/ve'] : ['query', key, '/v', valueName]
      const out = execFileSync('reg.exe', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
      const lines = out.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
      const last = lines[lines.length - 1]
      if (last === undefined) return ''
      const match = last.match(/REG_\w+\s+(.*)$/)
      const value = (match?.[1] ?? last).trim()
      // `(value not set)` is localised, so the parentheses identify it without
      // depending on the language.
      if (value.startsWith('(') && value.endsWith(')')) return ''
      return value
    } catch {
      return ''
    }
  }

  const progId = query(
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${extension}\\UserChoice`,
    'ProgId',
  )
  if (progId === '') return undefined
  const command = query(`HKCR\\${progId}\\shell\\open\\command`)
  if (command === '') return undefined

  const parsed = command.match(/^"([^"]+)"\s*(.*)$/) ?? command.match(/^(\S+)\s*(.*)$/)
  if (parsed === null) return undefined
  const exe = parsed[1] as string
  const template = (parsed[2] ?? '').trim()
  // The template quotes `%1` because Explorer substitutes a raw command line.
  // `spawn`/WMI pass an argv array instead, so those quotes would become part of
  // the filename. Strip them and let the launcher quote.
  const args = template
    .split(/\s+/)
    .filter((part) => part !== '')
    .flatMap((part) => {
      if (!part.includes('%1')) return [part]
      return [part.replace(/%1/g, target).replace(/^"|"$/g, '')]
    })
  return { run: exe, args }
}


/** Compact report metadata; the body is fetched separately. */
function reportSummary(report: GeneratedReport): Record<string, unknown> {
  return {
    id: report.id,
    type: report.type,
    generatedAt: report.generatedAt,
    periodStart: report.periodStart,
    periodEnd: report.periodEnd,
    goalTreeVersion: report.goalTreeVersion,
    chars: report.markdown.length,
  }
}

/** Everything the card needs about one project, in one round trip. */
async function describeProject(
  options: ApiOptions,
  root: string,
): Promise<Record<string, unknown> | undefined> {
  const projectId = deriveProjectId(root)
  const store = options.storeFor(root)
  const state = await store.readState(projectId)
  if (state === undefined) return undefined

  const [activities, judgments, signals, interventions, reports, snapshots] = await Promise.all([
    store.readActivities(projectId),
    store.readJudgments(projectId),
    store.readSignals(projectId),
    store.readInterventions(projectId),
    store.readReports(projectId),
    store.listSnapshots(projectId),
  ])

  const lastActivity = activities.reduce<string | undefined>(
    (latest, activity) => (latest === undefined || activity.timestamp > latest ? activity.timestamp : latest),
    undefined,
  )

  return {
    projectId,
    root,
    title: rootGoalTitle(state),
    version: state.version,
    confirmed: state.confirmed,
    // A workspace can have a state file and nothing else: the tree was started and
    // abandoned, so the card shows a project with 0 goals and no activity. Marking it
    // keeps the list honest — an empty shell is not the same thing as a monitored
    // project, and "delete did nothing" is usually this, not a bug.
    shell:
      state.goals.length === 0 &&
      activities.length === 0 &&
      judgments.length === 0 &&
      reports.length === 0,
    updatedAt: state.updatedAt,
    goals: goalCounts(state),
    contradictions: contradictionCounts(state),
    activities: activityCounts(activities, lastActivity),
    judgments: {
      total: judgments.length,
      pending: judgments.filter((item) => item.status === 'pending').length,
      confirmed: judgments.filter((item) => item.status === 'confirmed').length,
      dismissed: judgments.filter((item) => item.status === 'dismissed').length,
    },
    signals: { live: signals.length },
    interventions: {
      total: interventions.length,
      pending: interventions.filter((record) => record.status === 'pending').length,
      // The pending cards themselves, trimmed to what the panel renders. A count
      // alone left the user knowing a decision was needed but not what it was
      // about, which is why the card could not be settled from here.
      open: interventions
        .filter((record) => record.status === 'pending')
        .map((record) => ({
          id: record.id,
          level: record.level,
          createdAt: record.createdAt,
          promptSummary: record.promptSummary,
          // The signal that raised it, and the actions the analyser proposed: the
          // two things a reader needs to decide without opening a conversation.
          signalId: record.signalId,
          suggestedActions: record.suggestedActions,
        })),
    },
    reports: { total: reports.length, latestAt: reports.at(-1)?.generatedAt },
    // The tree page needs the nodes themselves, not just counts. Trimmed to the
    // fields the panel shows: sending whole nodes would put the audit evidence and
    // alignment rules into the browser for no reader.
    nodes: state.goals.map((goal) => ({
      id: goal.id,
      parentId: goal.parentId,
      depth: goal.depth,
      title: goal.title,
      description: goal.description,
      status: goal.status,
      priority: goal.priority,
      deadline: goal.deadline ?? null,
      // The criterion gap is the single most useful number on this page: a goal
      // with neither field can never be judged aligned, so "aligned is always 0" is
      // explained here rather than in the glossary.
      relevantActivities: goal.alignment?.relevantActivities ?? [],
      allowedMethods: goal.alignment?.allowedMethods ?? [],
      successCriteria: goal.successCriteria ?? [],
    })),
    contradictionNodes: state.contradictions.map((node) => ({
      id: node.id,
      parentId: node.parentId,
      primaryGoalId: node.primaryGoalId,
      type: node.type,
      title: node.title,
      description: node.description,
      poleA: node.poleA,
      poleB: node.poleB,
      intensity: node.intensity,
      trend: node.trend,
      resolvedAt: node.resolvedAt ?? null,
    })),
    // Counted here so the card does not have to re-derive the rule client-side and
    // drift from it.
    criteriaGap: {
      total: state.goals.length,
      missing: state.goals.filter(
        (goal) =>
          (goal.alignment?.relevantActivities?.length ?? 0) === 0 &&
          (goal.alignment?.allowedMethods?.length ?? 0) === 0,
      ).length,
    },
    snapshots: { total: snapshots.length, latestVersion: snapshots.at(-1)?.version },
    // Overall progress, computed by the same function the report prints. The card
    // used to show no completion figure at all, so the one number that answers
    // "how far along is this" was only visible by generating a report.
    progress: summarizeAchievements(state),
    data: await measureStorage(root, options.config.storageSubdir),
    config: {
      schedule: options.config.schedule,
      thresholds: options.config.thresholds,
      gate: options.config.gate,
      storageSubdir: options.config.storageSubdir,
    },
  }
}

/**
 * List providers and their models for the settings card.
 *
 * One provider whose adapter throws must not hide the others: the card can
 * still offer a working model, and an empty list for one route is an honest
 * answer rather than a failed request. Provider/model ids are the contract;
 * the display names are optional because not every adapter supplies one.
 *
 * @param llm - host `llm` service (narrowed).
 * @returns one entry per provider, each with its available models.
 */
async function listProviderModels(
  llm: LlmCatalogLike,
): Promise<Array<{ provider: string; displayName?: string; models: Array<{ id: string; displayName?: string }> }>> {
  const rawProviders: unknown = await llm.listProviders()
  const providers = Array.isArray(rawProviders) ? rawProviders : []
  const result: Array<{
    provider: string
    displayName?: string
    models: Array<{ id: string; displayName?: string }>
  }> = []

  for (const item of providers) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const provider = typeof record.id === 'string' ? record.id : ''
    if (provider.length === 0) continue
    const displayName = typeof record.name === 'string' && record.name.length > 0 ? record.name : undefined

    let models: Array<{ id: string; displayName?: string }> = []
    try {
      const rawModels: unknown = await llm.listModels(provider)
      if (Array.isArray(rawModels)) {
        models = rawModels.flatMap((model) => {
          if (model === null || typeof model !== 'object') return []
          const entry = model as Record<string, unknown>
          const id = typeof entry.id === 'string' ? entry.id : ''
          if (id.length === 0) return []
          const name = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : undefined
          return [name === undefined ? { id } : { id, displayName: name }]
        })
      }
    } catch {
      // A provider that cannot answer still appears, with no models: removing it
      // would make a transient adapter failure look like a provider that does
      // not exist.
      models = []
    }

    result.push(displayName === undefined ? { provider, models } : { provider, displayName, models })
  }

  return result
}

/** Every project root that currently holds a readable tree. */
async function collectProjects(options: ApiOptions): Promise<Record<string, unknown>[]> {
  const roots = await options.listRoots()
  const seen = new Set<string>()
  const described: Record<string, unknown>[] = []
  for (const root of roots) {
    const projectId = deriveProjectId(root)
    if (seen.has(projectId)) continue
    seen.add(projectId)
    const describedOne = await describeProject(options, root)
    if (describedOne !== undefined) described.push(describedOne)
  }
  // Most recently active first, so the card opens on the project the user is
  // actually working in instead of whichever id sorts first.
  return described.sort((left, right) => {
    const leftAt = String((left.activities as { lastAt?: string }).lastAt ?? left.updatedAt ?? '')
    const rightAt = String((right.activities as { lastAt?: string }).lastAt ?? right.updatedAt ?? '')
    if (leftAt !== rightAt) return rightAt.localeCompare(leftAt)
    return String(left.projectId).localeCompare(String(right.projectId))
  })
}

/** The confirmed root goal's title, or the project id when nothing is confirmed. */
function rootGoalTitle(state: TreeState): string {
  const root = state.goals.find((goal) => goal.depth === 0)
  return root?.title ?? '(未命名)'
}

/** Goal counts the card renders as a short statistic row. */
function goalCounts(state: TreeState): Record<string, number> {
  const depths = state.goals.map((goal) => goal.depth)
  return {
    total: state.goals.length,
    active: state.goals.filter((goal) => goal.status === 'active').length,
    done: state.goals.filter((goal) => goal.status === 'done').length,
    atRisk: state.goals.filter((goal) => goal.status === 'at_risk').length,
    maxDepth: depths.length === 0 ? 0 : Math.max(...depths),
  }
}

/** Contradiction counts by role. */
function contradictionCounts(state: TreeState): Record<string, number> {
  return {
    total: state.contradictions.length,
    core: state.contradictions.filter((node) => node.type === 'core').length,
    main: state.contradictions.filter((node) => node.type === 'main').length,
    secondary: state.contradictions.filter((node) => node.type === 'secondary').length,
    unclassified: state.contradictions.filter((node) => node.type === 'unclassified').length,
  }
}

/** Alignment decision distribution over the whole recorded stream. */
function activityCounts(
  activities: readonly { decision: string; timestamp: string }[],
  lastAt: string | undefined,
): Record<string, unknown> {
  const count = (decision: string): number =>
    activities.filter((activity) => activity.decision === decision).length
  return {
    total: activities.length,
    aligned: count('aligned'),
    exploratory: count('exploratory'),
    scopeDrift: count('scope_drift'),
    uncertain: count('uncertain'),
    // Kept apart from `uncertain` on purpose: this is the path-coverage number.
    // It answers "how many activities could no goal claim", which is the measure
    // a reader needs before deciding whether the tree should register more
    // `paths` — a question `uncertain` cannot answer, because it mixes "the tree
    // has no claim on this" with "there was not enough to judge".
    unbound: count('unbound'),
    lastAt,
  }
}

/** Bytes held by each stream directory, so the card can show what an archive frees. */
async function measureStorage(root: string, subdir: string): Promise<Record<string, number>> {
  const base = join(root, subdir)
  const sizes: Record<string, number> = {}
  let directories: string[]
  try {
    directories = await readdir(base)
  } catch {
    return sizes
  }
  for (const name of directories) {
    sizes[name] = await directorySize(join(base, name))
  }
  return sizes
}

/** Recursive byte count of one directory; failures count as zero. */
async function directorySize(path: string): Promise<number> {
  let total = 0
  let entries: string[]
  try {
    entries = await readdir(path)
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(path, entry)
    try {
      const info = await stat(child)
      if (info.isDirectory()) total += await directorySize(child)
      else total += info.size
    } catch {
      // A file that vanished between readdir and stat contributes nothing.
    }
  }
  return total
}
