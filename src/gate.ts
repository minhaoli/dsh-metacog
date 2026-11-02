/**
 * Stage G+: the Level 3 hard gate (spec 4.4 item 4).
 *
 * Verified host contract (2026-10-27, `cordis_inspect_query` `Event.listEvents`
 * with `event: "tools/pre-execute"`): a **waterfall** whose listener may return
 * `{ kind: 'deny', reason, info? }` to refuse a call before it is dispatched.
 * Returning `next()` delegates to the default allow. The registry rechecks
 * cancellation after an async gate settles, so the handler must also observe
 * `exec.signal`.
 *
 * What this module gates:
 *
 * - Only a **pending Level 3** intervention blocks anything. Levels 0–2 are
 *   advisory by design: a monitor that interrupts ordinary work loses the right
 *   to be listened to.
 * - Only tools that are not read-only are blocked. Every inspection path stays
 *   open, otherwise the user cannot even look at the problem being reported.
 * - The monitor's own decision tools are never blocked: the gate asks for a
 *   decision, so refusing the tool that records the decision would deadlock it.
 *
 * The gate is off unless `gate.level3HardBlock` is true. See the config comment
 * for why that default is the safe one.
 *
 * @module dsh-metacog/gate
 */
import type { Disposer, HostContext } from './host.js'
import type { MetacogConfig } from './config.js'
import type { MetacogStore } from './data/store.js'

/** The pending call, as the waterfall hands it over. */
export interface PendingCall {
  readonly name: string
  readonly arguments?: unknown
  readonly agent?: { readonly id: string; readonly session?: { readonly id: string } }
  readonly signal?: AbortSignal
}

/** A decision the waterfall understands. */
export type PreToolDecision = { kind: 'allow' } | { kind: 'deny'; reason: string }

/** Everything the gate needs. */
export interface GateOptions {
  readonly ctx: HostContext
  readonly config: MetacogConfig
  /** Resolve the store for the calling session, or `undefined` when unknown. */
  readonly storeForSession: (
    sessionId: string,
  ) => Promise<{ store: MetacogStore; projectId: string } | undefined>
}

/** What the gate is currently doing, for the mount log and tests. */
export interface GateStats {
  /** Calls considered by the gate. */
  seen: number
  /** Calls refused because a Level 3 card was pending. */
  denied: number
  /** Calls allowed because no Level 3 card was pending. */
  allowed: number
  /** Calls that would have been denied had the gate been enabled. */
  shadowed: number
  /** Whether the gate is armed (config on and host hook present). */
  armed: boolean
}

/**
 * Tools that only read. Anything not listed here is treated as a mutation,
 * which is the safe direction: an unknown tool is assumed to change state.
 */
const READ_ONLY_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'search',
  'lookup',
  'fetch',
  'web_search',
  'web_fetch',
  'web_call',
  'web_index',
  'session_list',
  'job_list',
  'job_output',
  'schedule_list',
  'list_agents',
  'ls',
  'stat',
])

/**
 * Decide whether one call may proceed.
 *
 * Pure except for the store read, and returns the reason as a value rather than
 * throwing, so a host that logs decisions records something readable.
 *
 * @param call - the pending call.
 * @param options - mount context and config.
 * @returns the waterfall decision plus whether it was a shadow decision.
 */
export async function evaluateCall(
  call: PendingCall,
  options: GateOptions,
): Promise<{ decision: PreToolDecision; shadow: boolean }> {
  const allow: PreToolDecision = { kind: 'allow' }
  const { config } = options

  // Quiet mode silences hints and cards, but a hard block is protection rather
  // than a notification — unless the operator explicitly turned that off too. The
  // distinction matters because this is the one path that stops an irreversible
  // action; going quiet about it while still letting it through would be the worst
  // of both.
  // The quiet section is optional here on purpose: a config assembled by a test,
  // or by an older profile that predates the section, must get the safe default
  // (still block) rather than a crash in the one place that stops an irreversible
  // action.
  const quiet = config.quiet ?? { enabled: false, keepHardBlock: true, suppressPromptBlock: false }
  if (quiet.enabled && !quiet.keepHardBlock) return { decision: allow, shadow: false }

  if (config.gate.neverBlocked.includes(call.name)) return { decision: allow, shadow: false }
  if (READ_ONLY_TOOLS.has(call.name)) return { decision: allow, shadow: false }

  const sessionId = call.agent?.session?.id ?? call.agent?.id
  if (sessionId === undefined) return { decision: allow, shadow: false }

  const resolved = await options.storeForSession(sessionId)
  if (resolved === undefined) return { decision: allow, shadow: false }

  const pending = (await resolved.store.readInterventions(resolved.projectId)).filter(
    (record) => record.status === 'pending' && record.level === 3,
  )
  const card = pending[0]
  if (card === undefined) return { decision: allow, shadow: false }

  // The card's own Chinese hint is what the user can act on; the technical
  // promptSummary stays out of this message for the same reason it stays out of
  // the prompt block. Old cards have no hint, so the fallback is Chinese too.
  const cardHint =
    typeof card.hint === 'string' && card.hint.length > 0
      ? card.hint
      : '有一张待决定的对齐检查卡片，用 resolve_intervention 处理。'
  const decision: PreToolDecision = {
    kind: 'deny',
    reason:
      `[dsh-metacog] 有一个 Level 3 对齐检查待决定（${card.id}），` +
      '未决定前非只读工具调用会被拦截。' +
      `${cardHint} ` +
      '用 resolve_intervention 记录决定（continue / realign / modify_goals / dismiss）后可解除。',
  }
  return { decision, shadow: config.gate.level3HardBlock !== true }
}

/**
 * Install the gate on the host's pre-execute waterfall.
 *
 * @param options - mount context, config and store resolver.
 * @returns live stats plus the disposer.
 */
export function installGate(options: GateOptions): { stats: GateStats; dispose: Disposer } {
  const { ctx, config } = options
  const stats: GateStats = {
    seen: 0,
    denied: 0,
    allowed: 0,
    shadowed: 0,
    armed: config.gate.level3HardBlock === true,
  }

  const listener = async (
    exec: PendingCall,
    next: () => Promise<PreToolDecision>,
  ): Promise<PreToolDecision> => {
    stats.seen += 1
    try {
      // An aborted call is not ours to judge; let the registry settle it.
      if (exec.signal?.aborted === true) return next()
      const { decision, shadow } = await evaluateCall(exec, options)
      if (decision.kind !== 'deny') {
        stats.allowed += 1
        return next()
      }
      if (shadow) {
        // Configured off: count what would have happened, and allow the call.
        stats.shadowed += 1
        stats.allowed += 1
        return next()
      }
      stats.denied += 1
      return decision
    } catch (error) {
      // A gate that throws must not take the tool call down with it.
      ctx.logger.warn(`[dsh-metacog] pre-execute gate failed open: ${String(error)}`)
      return next()
    }
  }

  const off = ctx.on('tools/pre-execute', listener as never)
  return { stats, dispose: () => off() }
}
