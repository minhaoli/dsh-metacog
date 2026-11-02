/**
 * The periodic drift sweep.
 *
 * Verified host contract (2026-10-27, `cordis_inspect_query` host `Service`
 * provider): the recurring primitive is `ctx.timer.interval(callback, delay)`,
 * which returns a disposer and is bound to the plugin's fiber. `ctx.jobs` is
 * *not* a general scheduler — its `JobKindMap` holds only `'bash'` and each job
 * needs an owner plus an attached controller, so it models a one-shot background
 * command's output ring, not a periodic pulse. `ctx.schedule` does fire on a
 * schedule but its semantics are "deliver a prompt into a Session", which wakes
 * the user; that is opt-in and off by default.
 *
 * Because the sweep runs on a timer with no conversation attached, everything
 * it produces is Grade C by construction: it may run the static
 * checks and it may *hint*, but it may never invent an activity or open a card.
 * `runStaticCheck` already enforces that with `mayEscalate: false`.
 *
 * **The sweep never touches the goal tree.** Initialisation and monitoring are
 * separate phases: the tree is derived once, confirmed by the user, and then
 * held fixed as the yardstick for judging alignment. A timer that re-derived it
 * whenever documents changed would invalidate every past judgement, because an
 * activity recorded as advancing goal T3 would refer to a goal that no longer
 * exists. Changes come only from the user, through `metacog_revise`.
 *
 * @module dsh-metacog/schedule
 */
import type { Disposer, HostContext } from './host.js'
import type { MetacogConfig } from './config.js'
import type { MetacogStore } from './data/store.js'
import type { TreeState } from './data/types.js'
import { runStaticCheck } from './analysis/service.js'
import { clampHint } from './analysis/escalation.js'
import {
  RealtimeFailureReminder,
  expectationStatePath,
  failureStatePath,
  runRealtimeVerdict,
  toVerdictActivity,
  toVerdictGoal,
  type LlmServiceLike,
  type RunVerdictOptions,
  type VerdictInput,
  type VerdictResult,
} from './analysis/verdict.js'

/** One project the sweep knows how to check. */export interface MonitoredProject {
  readonly projectId: string
  readonly store: MetacogStore
  readonly projectRoot: string
}

/** How a single sweep went, for the mount's diagnostics. */
export interface SweepResult {
  readonly projectId: string
  readonly signals: number
  readonly hints: string[]
}

/** Aggregate stats the mount can log and tests can assert on. */
export interface SchedulerStats {
  /** Number of ticks that actually ran a sweep. */
  ticks: number
  /** Projects checked across all ticks. */
  checks: number
  /** Signals appended across all ticks. */
  signals: number
  /** Ticks skipped because no project was registered yet. */
  idle: number
  /** Errors contained during a sweep. */
  errors: number
  /** Reports generated automatically across all ticks. */
  autoReports: number
  /** Whether the timer is currently installed. */
  running: boolean
}

/** A cadence the scheduler may generate on its own. */
export type AutoReportType = 'daily' | 'weekly' | 'monthly'

/**
 * How long a report period must be over before it is generated.
 *
 * The period a report covers ends at midnight: a `daily` report generated at
 * 01:00 covers the day that just finished. Generating at the tick nearest the
 * boundary is fine, but generating *the current* period is not — it would
 * summarize a period that has not happened yet and then never regenerate it.
 */
const PERIOD_START_HOUR = 0

/** Human labels, for the hint line. */
const LABELS: Readonly<Record<AutoReportType, string>> = {
  daily: '日报',
  weekly: '周报',
  monthly: '月报',
}

/**
 * The calendar day a report period should be filed under.
 *
 * Local time, because that is what the user means by "today's report" — and
 * `report.ts` already names its markdown files by local date for the same
 * reason. Comparing UTC days would split a day in two for anyone east of
 * Greenwich and file an evening report under tomorrow.
 */
function localDay(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * The period this cadence should report on, at this instant.
 *
 * "The period that just ended", not "the period now contains": the timer exists
 * to describe a finished span. A daily report written at 00:05 describes the day
 * before it, which is also the day whose file it lands in.
 *
 * `report.ts` resolves the same span from the report's own `now` — it lands on
 * the period containing that instant — so the scheduler passes the *end* of the
 * closed period, not the wall clock. Passing the wall clock would make the
 * report describe the new, empty day.
 */
function closedPeriod(
  type: AutoReportType,
  now: Date,
): { start: Date; end: Date } | undefined {
  const midnight = new Date(now)
  midnight.setHours(PERIOD_START_HOUR, 0, 0, 0)

  if (type === 'daily') {
    const start = new Date(midnight)
    start.setDate(start.getDate() - 1)
    return { start, end: midnight }
  }

  if (type === 'weekly') {
    // The week that ended at the most recent midnight. Weeks start Monday, so a
    // tick on Monday morning reports the seven days before it.
    const end = new Date(midnight)
    const start = new Date(midnight)
    start.setDate(start.getDate() - 7)
    return { start, end }
  }

  // Monthly: the previous calendar month, which has no fixed length.
  const end = new Date(midnight)
  end.setDate(1)
  const start = new Date(end)
  start.setMonth(start.getMonth() - 1)
  return { start, end }
}

/** Everything the scheduler needs from the mount. */
export interface SchedulerOptions {
  readonly ctx: HostContext
  readonly config: MetacogConfig
  /** Enumerate the projects worth checking on each tick. */
  readonly projects: () => Promise<readonly MonitoredProject[]>
  /** Collect hints for the prompt layer (called with this tick's output). */
  readonly onHints?: (hints: readonly string[], result: readonly SweepResult[]) => void
  /**
   * Second-opinion pass over queued drift candidates.
   *
   * Runs on the same tick as the static check: the queue only grows between ticks,
   * so this is its natural cadence. Returning hints is how a judgement log that has
   * grown worth reading reaches the user.
   */
  readonly review?: (project: MonitoredProject, state: TreeState) => Promise<readonly string[]>
  /**
   * Generate one report covering every monitored workspace.
   *
   * Injected rather than imported so the scheduler keeps no dependency on the
   * report builder: `report.ts` is a large module and the scheduler's job is
   * timing, not prose. It also keeps this file testable without a tree.
   *
   * `readExisting` is what the scheduler deduplicates against. It lives on the
   * same object because the records are written by the same sink: asking any
   * single project's store would miss reports written for the whole set.
   */
  readonly report?: {
    readonly readExisting: () => Promise<readonly { type: string; periodEnd: string }[]>
    /**
     * @param type - cadence to generate.
     * @param at - the instant the report should treat as "now", i.e. the end of
     *   the period being written. Defaults to the wall clock for a manual run.
     */
    readonly generate: (type: AutoReportType, at?: Date) => Promise<void>
  }
  /** Clock injection for tests. */
  readonly now?: () => Date
}

/**
 * Install the periodic sweep.
 *
 * The timer is created lazily on install and disposed through the returned
 * disposer, which `mount.claim` owns. A configuration with `schedule.enabled`
 * false installs nothing at all — not an inert timer — so the honest report is
 * "no timer was created" rather than "a timer exists and does nothing".
 *
 * @param options - mount context, policy and project source.
 * @returns stats plus the disposer (a no-op when disabled).
 */
export function installScheduler(options: SchedulerOptions): {
  stats: SchedulerStats
  dispose: Disposer
  /** Run one sweep immediately, as `schedule`-less tests and tools do. */
  sweep: () => Promise<SweepResult[]>
} {
  const { ctx, config } = options
  const stats: SchedulerStats = {
    ticks: 0,
    checks: 0,
    signals: 0,
    idle: 0,
    errors: 0,
    autoReports: 0,
    running: false,
  }

  const clock = options.now ?? (() => new Date())

  /**
   * Generate any report whose period has closed and been reported on already.
   *
   * Idempotence comes from the stored records, not from a counter in memory: the
   * timer is rebuilt on every mount, and a memory-only "last generated" value
   * would either regenerate the same period on every restart or — if it started
   * empty and treated "no memory" as "nothing generated" — generate one on every
   * tick forever.
   *
   * The identity of a report is its period, so the check is "is there already a
   * record of this cadence covering this period". Regenerating would replace the
   * markdown file and append a second row, and the card would then show two
   * dailies for one day.
   */
  const generateDueReports = async (now: Date): Promise<readonly string[]> => {
    if (!config.schedule.autoReport || options.report === undefined) return []
    const types = config.schedule.autoReportTypes
    if (types.length === 0) return []

    // One report per cadence per period, covering every workspace. The
    // deduplication therefore asks the sink, not a single project: the whole point
    // of a cross-workspace report is that it is written once, no matter how many
    // workspaces contributed.
    const existing = await options.report.readExisting()
    const hints: string[] = []
    for (const type of types) {
      const period = closedPeriod(type, now)
      if (period === undefined) continue
      const covered = localDay(period.end)
      const already = existing.some(
        (record) => record.type === type && localDay(new Date(record.periodEnd)) === covered,
      )
      if (already) continue
      try {
        // The *end* of the closed period, not the wall clock: the report
        // resolves which period it covers from this instant, so passing `now`
        // would have it describe the new, still-empty day.
        await options.report.generate(type, period.end)
        stats.autoReports += 1
        hints.push(`[metacog 报告] ${LABELS[type]}已生成（${covered}）`)
      } catch (error) {
        // A report that fails must not take the sweep with it: the tick's other
        // work has already been recorded by this point.
        stats.errors += 1
        ctx.logger.warn(`[dsh-metacog] auto ${type} report failed: ${String(error)}`)
      }
    }
    return hints
  }

  const sweep = async (): Promise<SweepResult[]> => {
    const projects = await options.projects()
    if (projects.length === 0) {
      stats.idle += 1
      return []
    }
    const results: SweepResult[] = []
    for (const project of projects) {
      try {
        const state = await project.store.readState(project.projectId)
        if (state === undefined || !state.confirmed) continue
        const outcome = await runStaticCheck(
          project.store,
          state,
          project.projectId,
          undefined,
          config,
          clock(),
          // No session is attached to a timer tick, so the record omits the
          // field rather than naming a session that does not exist.
          undefined,
        )
        stats.checks += 1
        stats.signals += outcome.signals.length
        const reviewHints =
          options.review === undefined ? [] : await options.review(project, state)
        results.push({
          projectId: project.projectId,
          signals: outcome.signals.length,
          hints: [...outcome.level1Hints, ...reviewHints],
        })
      } catch (error) {
        stats.errors += 1
        // One project's failure must not stop the rest, and must not reach the
        // host: a throwing timer callback would be cancelled by the runtime.
        ctx.logger.warn(
          `[dsh-metacog] periodic sweep failed for ${project.projectId}: ${String(error)}`,
        )
      }
    }

    // Reports are written once for the whole set, after the per-project work.
    // Writing them inside the loop produced one report per workspace per tick,
    // which is the opposite of "a summary of everything".
    const reportHints = await generateDueReports(clock())
    if (reportHints.length > 0) {
      results.push({ projectId: '', signals: 0, hints: [...reportHints] })
    }
    const hints = results.flatMap((result) => result.hints)
    if (hints.length > 0) options.onHints?.(hints, results)
    return results
  }

  const timer = ctx.get('timer')

  if (!config.schedule.enabled || timer === undefined) {
    return { stats, dispose: () => {}, sweep }
  }

  const delayMs = config.schedule.checkIntervalMinutes * 60_000
  // `interval` runs the callback on the host's timer; the first run happens one
  // interval in, which is what a monitor wants — mounting is not evidence of
  // anything, so there is nothing to check at t=0.
  const stop = timer.interval(() => {
    stats.ticks += 1
    void sweep().catch((error: unknown) => {
      stats.errors += 1
      ctx.logger.warn(`[dsh-metacog] periodic sweep threw: ${String(error)}`)
    })
  }, delayMs)
  stats.running = true

  return {
    stats,
    dispose: () => {
      if (!stats.running) return
      stats.running = false
      stop()
    },
    sweep,
  }
}

/**
 * Describe the scheduling capability boundary for the API table and logs.
 *
 * @param available - whether the host exposed `ctx.timer.interval`.
 * @param enabled - whether the configuration asked for periodic checks.
 */
export function schedulerBoundary(available: boolean, enabled: boolean): string {
  if (!available) {
    return (
      'unsupported: host exposes no ctx.timer.interval; periodic checks stay off ' +
      'and drift analysis runs only when a tool is invoked'
    )
  }
  if (!enabled) {
    return 'supported but disabled by config (schedule.enabled = false); no timer is created'
  }
  return 'supported: ctx.timer.interval drives a Grade C static sweep; the disposer stops it'
}

/** One project's outcome in one realtime tick. */
export interface RealtimeTickResult {
  readonly projectId: string
  readonly status: 'verdict' | 'idle' | 'failed' | 'skipped'
  readonly match?: number
  readonly hints: readonly string[]
}

/** Aggregate stats the realtime mount can log and tests can assert on. */
export interface RealtimeSchedulerStats {
  /** Timer callbacks that fired. */
  ticks: number
  /** Projects that had a non-empty window and reached the verdict call. */
  checks: number
  /** Verdict records written. */
  verdicts: number
  /** Empty windows (or a verdict `idle`) that made no model call. */
  idle: number
  /** Hints emitted (low match or failure reminders). */
  hints: number
  /** Contained errors across ticks. */
  errors: number
  /** Whether the timer is currently installed. */
  running: boolean
}

/** Everything the realtime scheduler needs from the mount. */
export interface RealtimeSchedulerOptions {
  readonly ctx: HostContext
  readonly config: MetacogConfig
  readonly projects: () => Promise<readonly MonitoredProject[]>
  /** Host `llm` service; `ctx.get('llm')` is used when omitted. */
  readonly llm?: LlmServiceLike
  /** Resolve the global model when `realtime.provider/model` are empty. */
  readonly defaultModel?: () => { provider?: string; model?: string } | undefined
  /** Where hints reach the prompt cache. Quiet mode filters before this call. */
  readonly onHints?: (hints: readonly string[]) => void
  /** Per-project reminder state; the default persists under the project's storage. */
  readonly reminderFor?: (project: MonitoredProject) => RealtimeFailureReminder
  /** Verdict runner, injectable so tests do not need a live model. */
  readonly runVerdict?: (input: VerdictInput, options: RunVerdictOptions) => Promise<VerdictResult>
  /** Clock injection for tests. */
  readonly now?: () => Date
  /** Timer injection for tests; defaults to `ctx.get('timer')`. */
  readonly timer?: { interval(callback: () => void, delayMs: number): Disposer }
}

/**
 * One Chinese hint for a low realtime match.
 *
 * The action is written before the model's reason on purpose: `clampHint` cuts
 * the tail, and a hint whose action was cut is no longer actionable. `match`
 * is only passed here when it is a real number; a vague goal reports `null` and
 * is explained by the verdict layer's own hint instead of a fabricated score.
 *
 * @param match - realtime match score, 0–1.
 * @param goalLabel - goal title or id the verdict named, when known.
 * @param reason - the model's short reason for the low match.
 * @returns a clamped, actionable Chinese line.
 */
export function realtimeHint(
  match: number,
  goalLabel: string | undefined,
  reason: string,
): string {
  // The label is clamped on its own so a long goal title cannot push the action
  // out of the 60-character budget; the model's reason is last and may be cut.
  const label = clampHint(goalLabel ?? '未命名目标', 6)
  return clampHint(
    `[metacog 实时] 匹配度 ${match.toFixed(2)} 偏低（${label}）：` +
      '方向若变，用 metacog_revise_plan 更新。' +
      `${reason}`,
  )
}

/**
 * Install the independent 5-minute realtime verdict timer.
 *
 * Runs beside the 25-minute sweep, not inside it: the two have different
 * cadences, different windows and different failure semantics, and sharing a
 * tick would make the slower one either miss windows or repeat them. They
 * share only the project set and the prompt-cache hint channel.
 *
 * The window is "since the last realtime checkpoint", stored separately from
 * the report checkpoint. On an empty window the checkpoint still advances (so
 * the next tick starts from here) but no model is called and no verdict is
 * recorded. On failure the checkpoint deliberately does not advance: the same
 * activities are retried next tick.
 *
 * @param options - mount context, project source, model route and sinks.
 * @returns stats, the disposer, and a `tick` a test can drive directly.
 */
export function installRealtimeScheduler(options: RealtimeSchedulerOptions): {
  stats: RealtimeSchedulerStats
  dispose: Disposer
  tick: () => Promise<RealtimeTickResult[]>
} {
  const { ctx, config } = options
  const stats: RealtimeSchedulerStats = {
    ticks: 0,
    checks: 0,
    verdicts: 0,
    idle: 0,
    hints: 0,
    errors: 0,
    running: false,
  }
  const clock = options.now ?? (() => new Date())
  const runVerdict = options.runVerdict ?? runRealtimeVerdict
  const timer =
    options.timer ??
    (ctx.get('timer') as { interval(callback: () => void, delayMs: number): Disposer } | undefined)

  const reminders = new Map<string, RealtimeFailureReminder>()
  const emitHints = (hints: readonly string[]): void => {
    if (hints.length === 0) return
    // Quiet mode stops the interruption, not the recording; the verdict record
    // is written either way, only the hint surface goes silent.
    if (config.quiet.enabled) return
    stats.hints += hints.length
    options.onHints?.(hints)
  }

  const reminderFor = (project: MonitoredProject): RealtimeFailureReminder => {
    const existing = reminders.get(project.projectId)
    if (existing !== undefined) return existing
    const created =
      options.reminderFor?.(project) ??
      new RealtimeFailureReminder({
        statePath: failureStatePath(project.projectRoot, config.storageSubdir),
        remind: (message) => emitHints([message]),
      })
    reminders.set(project.projectId, created)
    return created
  }

  const resolveRoute = (): { provider: string; model: string } => {
    const provider = config.realtime.provider.trim()
    const model = config.realtime.model.trim()
    if (provider.length > 0 && model.length > 0) return { provider, model }
    const global = options.defaultModel?.()
    return {
      provider: provider.length > 0 ? provider : (global?.provider ?? ''),
      model: model.length > 0 ? model : (global?.model ?? ''),
    }
  }

  const tick = async (): Promise<RealtimeTickResult[]> => {
    const projects = await options.projects()
    const results: RealtimeTickResult[] = []
    const route = resolveRoute()
    const llm = options.llm ?? (ctx.get('llm') as LlmServiceLike | undefined)

    for (const project of projects) {
      try {
        const state = await project.store.readState(project.projectId)
        if (state === undefined || !state.confirmed) continue

        const now = clock()
        const nowMs = now.getTime()
        const nowIso = now.toISOString()
        const checkpoint = await project.store.readRealtimeCheckpoint(project.projectId)
        const parsedCheckpoint = checkpoint === undefined ? Number.NaN : Date.parse(checkpoint)
        const sinceMs = Number.isFinite(parsedCheckpoint)
          ? parsedCheckpoint
          : nowMs - config.realtime.intervalMinutes * 60_000

        const activities = (await project.store.readActivities(project.projectId)).filter((activity) => {
          const at = Date.parse(activity.timestamp)
          return Number.isFinite(at) && at >= sinceMs && at <= nowMs
        })

        if (activities.length === 0) {
          // Nothing to judge: advance the boundary so the next tick does not
          // rescan the same gap, but spend no model call and write no record.
          await project.store
            .setRealtimeCheckpoint(project.projectId, nowIso)
            .catch((error: unknown) => {
              stats.errors += 1
              ctx.logger.warn(
                `[dsh-metacog] could not advance realtime checkpoint for ${project.projectId}: ${String(error)}`,
              )
            })
          stats.idle += 1
          results.push({ projectId: project.projectId, status: 'idle', hints: [] })
          continue
        }

        stats.checks += 1
        const goals = state.goals
          .filter((goal) => goal.status !== 'done' && goal.status !== 'deprecated')
          .map(toVerdictGoal)
        const input: VerdictInput = {
          goals,
          activities: activities.map(toVerdictActivity),
        }
        const reminder = reminderFor(project)

        const result = await runVerdict(input, {
          llm,
          provider: route.provider,
          model: route.model,
          maxInputTokens: config.realtime.maxInputTokens,
          timeoutMs: config.realtime.timeoutMs,
          projectId: project.projectId,
          expectationPath: expectationStatePath(project.projectRoot, config.storageSubdir),
        })

        if (result.status === 'idle') {
          await project.store.setRealtimeCheckpoint(project.projectId, nowIso).catch(() => undefined)
          stats.idle += 1
          results.push({ projectId: project.projectId, status: 'idle', hints: [] })
          continue
        }

        if (!result.ok) {
          stats.errors += 1
          // Keep the failed window's *start* as the checkpoint. A failure must
          // retry the same activities on the next tick, and without a stored
          // boundary the fallback "last interval from now" would slide forward
          // and silently skip them. Writing the start (not the end) means the
          // window may overlap slightly, never disappear.
          await project.store
            .setRealtimeCheckpoint(project.projectId, new Date(sinceMs).toISOString())
            .catch(() => undefined)
          // The reminder state machine owns "first failure / same reason quiet /
          // recovery re-arms"; the scheduler only feeds it the classified key.
          reminder.recordFailure(result.reasonKey, result.reason)
          results.push({ projectId: project.projectId, status: 'failed', hints: [] })
          continue
        }

        reminder.recordSuccess()
        await project.store.appendVerdict({
          projectId: project.projectId,
          at: nowIso,
          windowStart: new Date(sinceMs).toISOString(),
          windowEnd: nowIso,
          match: result.verdict.match,
          goalId: result.verdict.goalId,
          reason: result.verdict.reason,
          expectNext: result.verdict.expectNext,
          fulfilled: result.verdict.fulfilled,
          provider: result.meta.provider,
          model: result.meta.model,
          elapsedMs: result.meta.elapsedMs,
          inputChars: result.meta.inputChars,
          outputChars: result.meta.outputChars,
        })
        // Only after the record is durable does the window move: a failed
        // append must retry the same activities, not skip them.
        await project.store.setRealtimeCheckpoint(project.projectId, nowIso)
        stats.verdicts += 1

        // A vague goal produces its own clamped hint (the verdict layer cannot
        // score it); the low-match branch only runs when a real number exists.
        const hints: string[] = [...result.hints]
        if (
          result.verdict.match !== null &&
          result.verdict.match < config.realtime.hintThreshold
        ) {
          const goal = state.goals.find((item) => item.id === result.verdict.goalId)
          hints.push(
            realtimeHint(
              result.verdict.match,
              goal?.title ?? result.verdict.goalId ?? undefined,
              result.verdict.reason,
            ),
          )
        }
        if (hints.length > 0) emitHints(hints)
        results.push({
          projectId: project.projectId,
          status: 'verdict',
          match: result.verdict.match ?? undefined,
          hints,
        })
      } catch (error) {
        stats.errors += 1
        // A throwing tick must not cancel the timer: the next interval still runs.
        ctx.logger.warn(
          `[dsh-metacog] realtime verdict failed for ${project.projectId}: ${String(error)}`,
        )
        results.push({ projectId: project.projectId, status: 'failed', hints: [] })
      }
    }

    return results
  }

  if (!config.realtime.enabled || timer === undefined) {
    return { stats, dispose: () => {}, tick }
  }

  const delayMs = config.realtime.intervalMinutes * 60_000
  // First run one interval in, like the sweep: mounting is not evidence, so
  // there is nothing to judge at t=0.
  const stop = timer.interval(() => {
    stats.ticks += 1
    void tick().catch((error: unknown) => {
      stats.errors += 1
      ctx.logger.warn(`[dsh-metacog] realtime tick threw: ${String(error)}`)
    })
  }, delayMs)
  stats.running = true

  return {
    stats,
    dispose: () => {
      if (!stats.running) return
      stats.running = false
      stop()
    },
    tick,
  }
}
