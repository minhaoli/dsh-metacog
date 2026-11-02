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
]);
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
export async function evaluateCall(call, options) {
    const allow = { kind: 'allow' };
    const { config } = options;
    // Quiet mode silences hints and cards, but a hard block is protection rather
    // than a notification — unless the operator explicitly turned that off too. The
    // distinction matters because this is the one path that stops an irreversible
    // action; going quiet about it while still letting it through would be the worst
    // of both.
    // The quiet section is optional here on purpose: a config assembled by a test,
    // or by an older profile that predates the section, must get the safe default
    // (still block) rather than a crash in the one place that stops an irreversible
    // action.
    const quiet = config.quiet ?? { enabled: false, keepHardBlock: true, suppressPromptBlock: false };
    if (quiet.enabled && !quiet.keepHardBlock)
        return { decision: allow, shadow: false };
    if (config.gate.neverBlocked.includes(call.name))
        return { decision: allow, shadow: false };
    if (READ_ONLY_TOOLS.has(call.name))
        return { decision: allow, shadow: false };
    const sessionId = call.agent?.session?.id ?? call.agent?.id;
    if (sessionId === undefined)
        return { decision: allow, shadow: false };
    const resolved = await options.storeForSession(sessionId);
    if (resolved === undefined)
        return { decision: allow, shadow: false };
    const pending = (await resolved.store.readInterventions(resolved.projectId)).filter((record) => record.status === 'pending' && record.level === 3);
    const card = pending[0];
    if (card === undefined)
        return { decision: allow, shadow: false };
    // The card's own Chinese hint is what the user can act on; the technical
    // promptSummary stays out of this message for the same reason it stays out of
    // the prompt block. Old cards have no hint, so the fallback is Chinese too.
    const cardHint = typeof card.hint === 'string' && card.hint.length > 0
        ? card.hint
        : '有一张待决定的对齐检查卡片，用 resolve_intervention 处理。';
    const decision = {
        kind: 'deny',
        reason: `[dsh-metacog] 有一个 Level 3 对齐检查待决定（${card.id}），` +
            '未决定前非只读工具调用会被拦截。' +
            `${cardHint} ` +
            '用 resolve_intervention 记录决定（continue / realign / modify_goals / dismiss）后可解除。',
    };
    return { decision, shadow: config.gate.level3HardBlock !== true };
}
/**
 * Install the gate on the host's pre-execute waterfall.
 *
 * @param options - mount context, config and store resolver.
 * @returns live stats plus the disposer.
 */
export function installGate(options) {
    const { ctx, config } = options;
    const stats = {
        seen: 0,
        denied: 0,
        allowed: 0,
        shadowed: 0,
        armed: config.gate.level3HardBlock === true,
    };
    const listener = async (exec, next) => {
        stats.seen += 1;
        try {
            // An aborted call is not ours to judge; let the registry settle it.
            if (exec.signal?.aborted === true)
                return next();
            const { decision, shadow } = await evaluateCall(exec, options);
            if (decision.kind !== 'deny') {
                stats.allowed += 1;
                return next();
            }
            if (shadow) {
                // Configured off: count what would have happened, and allow the call.
                stats.shadowed += 1;
                stats.allowed += 1;
                return next();
            }
            stats.denied += 1;
            return decision;
        }
        catch (error) {
            // A gate that throws must not take the tool call down with it.
            ctx.logger.warn(`[dsh-metacog] pre-execute gate failed open: ${String(error)}`);
            return next();
        }
    };
    const off = ctx.on('tools/pre-execute', listener);
    return { stats, dispose: () => off() };
}
