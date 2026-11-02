/**
 * One structured subagent call, shared by everything that needs a model verdict.
 *
 * Derivation already had this plumbing inline. Drift review needs the same thing —
 * a prompt in, a schema-validated object out — so it lives here instead of being
 * written twice with two subtly different failure behaviours.
 *
 * The contract is deliberately value-based: a caller must be able to distinguish
 * "this host cannot run a subagent" (degrade) from "the model failed" (report) from
 * "the model answered" (proceed). Throwing would collapse those three into one.
 *
 * @module dsh-metacog/analysis/activate
 */
/** Default deadline for one call. */
const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * Run one structured subagent call.
 *
 * @param ctx - host context.
 * @param request - prompt, schema and limits.
 */
export async function activateStructured(ctx, request) {
    const subagents = ctx.get('subagents');
    if (subagents === undefined) {
        return { status: 'unavailable', reason: 'host does not provide the subagents service' };
    }
    let providers = [];
    try {
        providers = subagents.list();
    }
    catch (error) {
        return { status: 'unavailable', reason: `subagents.list() failed: ${String(error)}` };
    }
    const provider = providers[0];
    if (provider === undefined) {
        return { status: 'unavailable', reason: 'no subagent provider is registered' };
    }
    const maxDepth = subagents.resolveMaxDepth?.(undefined);
    if (maxDepth !== undefined && maxDepth <= 1) {
        return {
            status: 'unavailable',
            reason: `subagent nesting limit is ${maxDepth}; a plugin-initiated child would exceed it`,
        };
    }
    // An explicit parent wins: command and timer call paths have no "current
    // initiating agent" to fall back on, and the implicit lookup returns undefined
    // there rather than something useful.
    const parent = request.parent ?? ctx.get('agents')?.currentInitiator();
    if (parent === undefined) {
        return {
            status: 'unavailable',
            reason: 'no agent to attribute the child to: the call did not come from a tool, ' +
                'and the caller passed no parent agent',
        };
    }
    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
        const activation = await subagents.startActivation({
            provider,
            label: request.label ?? 'metacog-structured',
            request: {
                prompt: [{ type: 'text', text: request.prompt }],
                parent,
                outputSchema: request.schema,
                ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
            },
            signal: controller.signal,
            delivery: 'caller',
        });
        try {
            const result = await activation.result;
            const elapsedMs = Date.now() - startedAt;
            const outputText = (result.output ?? []).map((block) => block.text).join(' ');
            if (result.stopReason !== 'completed') {
                return {
                    status: 'failed',
                    reason: `subagent stopped with "${result.stopReason}" after ${elapsedMs}ms` +
                        (result.diagnostic === undefined ? '' : `: ${result.diagnostic}`),
                };
            }
            if (result.structured === undefined) {
                return {
                    status: 'failed',
                    reason: 'the provider returned no structured output; it may not support outputSchema. ' +
                        'Falling back requires the two-step path.',
                };
            }
            return {
                status: 'ok',
                structured: result.structured,
                usage: {
                    provider,
                    childId: activation.childId,
                    stopReason: result.stopReason,
                    elapsedMs,
                    promptChars: request.prompt.length,
                    outputChars: outputText.length,
                },
            };
        }
        finally {
            await activation.dispose().catch(() => { });
        }
    }
    catch (error) {
        return { status: 'failed', reason: `startActivation threw: ${String(error)}` };
    }
    finally {
        clearTimeout(timer);
    }
}
