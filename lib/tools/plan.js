/**
 * The plan declaration tools.
 *
 * A plan is what turns "this session did something" into "this session did what
 * it said it would". Two of the five signals read it directly — S3 needs the
 * tool whitelist, S4 needs the structured steps — and without it both report an
 * absence, so a session that never declares a plan is monitored by S5 alone at
 * 0.25 coverage, which is below the escalation floor.
 *
 * That asymmetry drives the interface: `allowedTools` is the field worth asking
 * for, because it is the one the benchmark actually validates. Steps are
 * optional and structured, and rejected outright if they are prose, because
 * prose cannot be matched against the tool-call trace.
 *
 * @module dsh-metacog/tools/plan
 */
import { DeclaredPlanSchema, PlanStepSchema, planAllowedTools, } from '../data/signals.js';
import { assessGoalConcreteness } from '../analysis/collapse.js';
import { GateError } from '../governance.js';
import { defineMetacogTool, loadProject } from './shared.js';
/**
 * Report which signals this plan can drive.
 *
 * Rendered as a receipt rather than a log line: a session that declares only
 * steps should be told immediately that S3 is reading them, or that neither
 * source named a tool, instead of discovering it from a report three days later.
 *
 * @param plan - the declared plan.
 * @returns per-signal availability.
 */
function signalReceipt(plan) {
    const out = [];
    const tools = planAllowedTools(plan);
    if (plan.allowedTools.length > 0) {
        out.push({ signal: 's3_tool_novel', status: 'available', detail: `白名单 ${plan.allowedTools.length} 个工具` });
    }
    else if (tools.length > 0) {
        out.push({
            signal: 's3_tool_novel',
            status: 'available',
            detail: `未单独声明 allowedTools，已从步骤的 expects.tool 汇总出 ${tools.length} 个工具`,
        });
    }
    else {
        out.push({
            signal: 's3_tool_novel',
            status: 'not_applicable',
            detail: '没有声明 allowedTools，步骤也没有写 expects.tool，S3 取不到值',
        });
    }
    if (plan.steps.length > 0) {
        out.push({ signal: 's4_plan_match', status: 'available', detail: `${plan.steps.length} 个步骤` });
    }
    else {
        out.push({ signal: 's4_plan_match', status: 'not_applicable', detail: '没有声明 steps，S4 取不到值' });
    }
    out.push({ signal: 's5_progress', status: 'available', detail: '不依赖计划，始终可用' });
    return out;
}
/**
 * Turn a step description from the model into a validated step.
 *
 * @param raw - one step as supplied.
 * @param index - position, for the error message.
 * @returns the validated step.
 */
function parseStep(raw, index) {
    const parsed = PlanStepSchema.safeParse(raw);
    if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new GateError('INVALID_PLAN_STEP', `step ${index + 1} is invalid: ${first?.path.join('.') ?? '?'} ${first?.message ?? 'unrecognised'}. ` +
            'A step needs `intent` (a sentence for the reader) and `expects` describing what completion looks like.', { issues: parsed.error.issues });
    }
    return parsed.data;
}
/**
 * Gate a stated goal on being checkable, or record that it was accepted vague.
 *
 * Shared by `declare_plan` and `revise_plan` on purpose: a revision that skipped
 * this would be a one-call bypass of the whole rule, and the two entry points
 * disagreeing about what counts as a real goal is worse than either answer.
 *
 * A vague goal is not a style problem. S4 compares the plan's steps against this
 * sentence, and the periodic model review uses it as the thing the work is
 * measured against; "推进项目" gives both of them nothing to compare with, so
 * every step then matches equally and nothing can be called off-target.
 *
 * The escape hatch exists because a genuinely exploratory session is legitimate,
 * but it demands a reason and leaves a mark on the plan — silently accepting is
 * the one option ruled out.
 *
 * @param goal - the goal as supplied, already trimmed.
 * @param options.allowVagueGoal - whether the caller asked to accept a vague goal.
 * @param options.reason - the caller's justification, already trimmed.
 * @param options.candidateTitle - title of the linked goal, offered as a rewrite.
 * @returns whether the goal was admitted as vague.
 * @throws {GateError} `GOAL_NOT_CONCRETE`, or `REASON_REQUIRED` when the escape
 *   hatch is used without a reason.
 */
function admitGoal(goal, options) {
    const assessment = assessGoalConcreteness(goal);
    if (assessment.concrete)
        return false;
    if (!options.allowVagueGoal) {
        const candidate = options.candidateTitle === undefined
            ? ''
            : `目标树里的「${options.candidateTitle}」就是一个现成的候选。`;
        throw new GateError('GOAL_NOT_CONCRETE', `goal 不够具体：${assessment.reason}。${assessment.suggestion ?? ''}` +
            `可以先从目标树里挑一个可执行叶子。${candidate}` +
            '确实需要一个模糊目标时，传 allowVagueGoal: true 并写明 reason。', { goal });
    }
    if (options.reason.length === 0) {
        throw new GateError('REASON_REQUIRED', 'allowVagueGoal 需要同时给出非空 reason：放行一个模糊目标会削弱下游判定，理由必须留在计划里。', { goal });
    }
    return true;
}
/**
 * `metacog_declare_plan`: record what this session intends to do.
 */
export function declarePlanTool(env) {
    return defineMetacogTool({
        name: 'metacog_declare_plan',
        description: 'Declare what this session intends to do, so the monitor can compare it with what actually ' +
            'happens. The goal is the part only you can supply. The tool set is read from `allowedTools` ' +
            'when you give one, and otherwise from each step\'s `expects.tool` — so declaring structured ' +
            'steps alone is enough for the scope check to work. Steps must be structured: each says what ' +
            'completing it looks like (a tool, a path pattern, or a checkable outcome), because a ' +
            'sentence in prose can never be matched against the tool-call trace. A step with an empty ' +
            '`expects` can never be marked complete, so give every step at least one expectation. ' +
            'Declare before starting work; revising later is legitimate and recorded, silently ' +
            'abandoning the plan is not.',
        parameters: {
            type: 'object',
            properties: {
                goal: { type: 'string', description: 'What this session is for, in one sentence.' },
                linkedGoalId: {
                    type: 'string',
                    description: 'Goal node id this session serves, when it serves one. Must be an existing node.',
                },
                deadline: { type: 'string', description: 'ISO timestamp for the plan as a whole, when it has one.' },
                allowVagueGoal: {
                    type: 'boolean',
                    description: 'Accept a goal that names nothing checkable. Requires `reason` and marks the plan, because ' +
                        'a vague goal leaves S4 and the model review with nothing to compare against. Rewriting ' +
                        'the goal is almost always the better move.',
                },
                reason: {
                    type: 'string',
                    description: 'Why a vague goal is being accepted. Required when allowVagueGoal is true.',
                },
                allowedTools: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Tools this session permits itself. Optional: when omitted, the set is the union of ' +
                        "every step's `expects.tool`. A tool outside it is reported with a suggestion to revise " +
                        'the plan, not as a violation.',
                },
                steps: {
                    type: 'array',
                    description: 'Ordered steps. Optional, but declaring none leaves S4 unable to score anything. ' +
                        'Each step needs `intent` plus an `expects` object; a step with an empty `expects` ' +
                        'can never be marked complete.',
                    items: {
                        type: 'object',
                        properties: {
                            intent: { type: 'string', description: 'One sentence a human will read.' },
                            expects: {
                                type: 'object',
                                properties: {
                                    tool: { type: 'string', description: 'Tool name that must be called (exact match).' },
                                    pathGlob: {
                                        type: 'string',
                                        description: 'Path pattern that must be touched. `*` does not cross directories, `**` does.',
                                    },
                                    assert: {
                                        type: 'string',
                                        enum: ['tests-pass', 'build-pass', 'file-changed'],
                                        description: 'A checkable outcome rather than an action.',
                                    },
                                },
                                additionalProperties: false,
                            },
                            optional: { type: 'boolean', description: 'Whether this step is required for completion.' },
                        },
                        required: ['intent', 'expects'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['goal'],
            additionalProperties: false,
        },
        outputSchema: { type: 'object' },
        async run(args, exec) {
            const input = (args ?? {});
            const { projectId, store } = await loadProject(env, exec);
            const goal = typeof input.goal === 'string' ? input.goal.trim() : '';
            if (goal.length === 0) {
                throw new GateError('MISSING_GOAL', 'a plan needs a goal: one sentence saying what this session is for.');
            }
            // Read once: the concreteness check offers the linked node's title as a
            // rewrite, and the link itself has to be validated. One read, both answers.
            const state = await store.readState(projectId);
            const linkedId = typeof input.linkedGoalId === 'string' && input.linkedGoalId.length > 0 ? input.linkedGoalId : undefined;
            const linked = linkedId === undefined ? undefined : state?.goals.find((node) => node.id === linkedId);
            // Before any other validation: a goal that names nothing checkable cannot
            // be compared against, and burying that behind a later error would let the
            // session fix the wrong thing first.
            const vagueGoal = admitGoal(goal, {
                allowVagueGoal: input.allowVagueGoal === true,
                reason: typeof input.reason === 'string' ? input.reason.trim() : '',
                candidateTitle: linked?.title,
            });
            // A linked goal must exist; a dangling link would make the report attribute
            // this session's work to a node nobody can look up.
            if (linkedId !== undefined && linked === undefined) {
                throw new GateError('UNKNOWN_GOAL', `goal "${linkedId}" does not exist in this project.`, {
                    linkedGoalId: linkedId,
                });
            }
            const steps = (input.steps ?? []).map((raw, index) => parseStep(raw, index));
            const now = new Date().toISOString();
            const candidate = {
                id: `plan_${Date.now().toString(36)}`,
                goal,
                ...(typeof input.linkedGoalId === 'string' && input.linkedGoalId.length > 0
                    ? { linkedGoalId: input.linkedGoalId }
                    : {}),
                ...(typeof input.deadline === 'string' && input.deadline.length > 0 ? { deadline: input.deadline } : {}),
                // Persisted, not merely announced: S4, the model review and the "what are
                // you doing today" prompt all compare work against this sentence, and a
                // vague one weakens every comparison. A downstream reader has to be able
                // to learn that without re-running the judgement.
                ...(vagueGoal
                    ? { vagueGoal: true, vagueGoalReason: typeof input.reason === 'string' ? input.reason.trim() : '' }
                    : {}),
                allowedTools: Array.isArray(input.allowedTools) ? input.allowedTools.filter((t) => typeof t === 'string') : [],
                steps,
                declaredAt: now,
            };
            const parsed = DeclaredPlanSchema.safeParse(candidate);
            if (!parsed.success) {
                throw new GateError('INVALID_PLAN', 'the plan did not validate', { issues: parsed.error.issues });
            }
            const plan = parsed.data;
            await store.writeSignalState({
                projectId,
                final: 0,
                consecutiveHigh: 0,
                stepsSeen: 0,
                planId: plan.id,
                plan,
                updatedAt: now,
            });
            const signals = signalReceipt(plan);
            const missing = signals.filter((s) => s.status === 'not_applicable');
            return {
                projectId,
                plan,
                signals,
                note: (missing.length === 0
                    ? '计划已记录，三个可计算信号全部就绪。'
                    : `计划已记录，但 ${missing.map((m) => m.signal).join('、')} 取不到值：${missing
                        .map((m) => m.detail)
                        .join('；')}`) +
                    (vagueGoal ? ' 目标已按 allowVagueGoal 放行并标记为模糊：下游拿它做对照时依据会变弱。' : ''),
            };
        },
    });
}
/**
 * `metacog_revise_plan`: change the plan mid-session.
 *
 * Needed because a legitimate change of direction is normal, and without a way to
 * record it, the change looks exactly like drift. Revising is an explicit act
 * with an audit trail, not a silent overwrite.
 */
export function revisePlanTool(env) {
    return defineMetacogTool({
        name: 'metacog_revise_plan',
        description: 'Change the declared plan after work has started. Use this when the direction legitimately ' +
            'moves — a dependency turned out to be broken, the user changed what they want, a step proved ' +
            'impossible. Recording the change keeps it out of the drift count: an unrevised plan makes ' +
            'every subsequent step look like scope drift, which is noise, not signal. Supply only the ' +
            'fields that change; the rest are kept.',
        parameters: {
            type: 'object',
            properties: {
                goal: { type: 'string', description: 'New goal sentence, when the objective changed.' },
                allowedTools: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Replacement whitelist. Replaces the previous one entirely.',
                },
                steps: {
                    type: 'array',
                    description: 'Replacement step list. Replaces the previous one entirely.',
                    items: { type: 'object' },
                },
                reason: { type: 'string', description: 'Why the plan changed. Recorded in the audit trail.' },
                allowVagueGoal: {
                    type: 'boolean',
                    description: 'Accept a new goal that names nothing checkable. Requires `reason`. Only relevant when ' +
                        '`goal` is supplied; revising other fields never re-judges the goal.',
                },
            },
            required: ['reason'],
            additionalProperties: false,
        },
        outputSchema: { type: 'object' },
        async run(args, exec) {
            const input = (args ?? {});
            const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
            if (reason.length === 0) {
                throw new GateError('MISSING_REASON', 'revising a plan needs a reason; it is recorded in the audit trail.');
            }
            const { projectId, store } = await loadProject(env, exec);
            const state = await store.readSignalState(projectId);
            if (state?.planId === undefined) {
                throw new GateError('NO_PLAN', 'no plan has been declared for this project; use metacog_declare_plan first.');
            }
            // The previous plan is not persisted separately: the revision carries the
            // whole new plan, and the audit trail records that a revision happened. A
            // full plan history would be a second source of truth for "what was
            // declared", and the two would disagree the first time one write failed.
            //
            // Which makes the merge below load-bearing rather than cosmetic. "Supply
            // only the fields that change; the rest are kept" is what the description
            // promises, and the earlier code did the opposite: an omitted
            // `allowedTools` or `steps` became `[]`, and `linkedGoalId`/`deadline`
            // were dropped outright. A model that only wanted to add one tool wiped
            // its own whitelist — and the plan being revised was the only copy.
            const previous = state.plan;
            const now = new Date().toISOString();
            const steps = input.steps === undefined
                ? (previous?.steps ?? [])
                : input.steps.map((raw, index) => parseStep(raw, index));
            const allowedTools = Array.isArray(input.allowedTools)
                ? input.allowedTools.filter((t) => typeof t === 'string')
                : (previous?.allowedTools ?? []);
            // A revision that changes the goal clears the same bar the declaration did,
            // or the rule is bypassed with a second call. When the goal is untouched it
            // is not re-judged: a revision that only adds a tool must not fail on a goal
            // the user already accepted.
            const goalProvided = typeof input.goal === 'string' && input.goal.trim().length > 0;
            const goal = goalProvided ? (input.goal ?? '').trim() : (previous?.goal ?? '（未修改）');
            const tree = goalProvided && previous?.linkedGoalId !== undefined ? await store.readState(projectId) : undefined;
            const vagueGoal = goalProvided
                ? admitGoal(goal, {
                    allowVagueGoal: input.allowVagueGoal === true,
                    reason,
                    candidateTitle: previous?.linkedGoalId === undefined
                        ? undefined
                        : tree?.goals.find((node) => node.id === previous.linkedGoalId)?.title,
                })
                : // An untouched goal keeps the mark it already carried: re-judging it
                    // here would let a revision that only adds a tool fail on a goal the
                    // user already accepted.
                    (previous?.vagueGoal ?? false);
            const vagueGoalReason = goalProvided
                ? vagueGoal
                    ? reason
                    : ''
                : (previous?.vagueGoalReason ?? '');
            const candidate = {
                id: state.planId,
                goal,
                ...(previous?.linkedGoalId === undefined ? {} : { linkedGoalId: previous.linkedGoalId }),
                ...(previous?.deadline === undefined ? {} : { deadline: previous.deadline }),
                ...(vagueGoal ? { vagueGoal: true, vagueGoalReason } : {}),
                allowedTools,
                steps,
                // The declaration time is history, not state to be refreshed: moving it
                // on every revision would erase how long the session has been running.
                declaredAt: previous?.declaredAt ?? now,
                revisedAt: now,
            };
            const parsed = DeclaredPlanSchema.safeParse(candidate);
            if (!parsed.success) {
                throw new GateError('INVALID_PLAN', 'the revised plan did not validate', { issues: parsed.error.issues });
            }
            const plan = parsed.data;
            // The EMA state is deliberately reset. The old score measured behaviour
            // against the old plan; keeping it would charge the new plan for drift that
            // belonged to the previous one.
            await store.writeSignalState({
                projectId,
                final: 0,
                consecutiveHigh: 0,
                stepsSeen: state.stepsSeen,
                planId: plan.id,
                plan,
                updatedAt: now,
            });
            const signals = signalReceipt(plan);
            return {
                projectId,
                plan,
                signals,
                note: `计划已修订（原因：${reason}）。漂移分数已归零，旧分数不再累计。` +
                    (vagueGoal ? ' 新目标已按 allowVagueGoal 放行并标记为模糊。' : ''),
            };
        },
    });
}
