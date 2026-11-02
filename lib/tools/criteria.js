/**
 * `metacog_draft_criteria`: suggest activity criteria for goals that lack them.
 *
 * A goal's `relevantActivities` is the only field the alignment matcher reads,
 * so a tree whose goals all have empty criteria matches nothing and every
 * activity lands in `uncertain`. Derivation is too heavy to also produce these
 * well, so this tool asks the bare LLM channel one small question per goal:
 * which short activity phrases serve this goal, and which are clearly outside
 * it.
 *
 * The result is a **suggestion**, never a write. Criteria decide every later
 * judgement; silently changing them from a generation call would make the
 * monitor's yardstick move without the user seeing it. `dryRun` defaults to
 * true, and even `dryRun: false` only changes the reported intent — writing is
 * the caller's job through `goal_tree_edit` or the next `goal_tree_confirm`.
 *
 * @module dsh-metacog/tools/criteria
 */
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { GateError } from '../governance.js';
import { defineMetacogTool, loadProject } from './shared.js';
/** Default goals processed in one call. */
const DEFAULT_LIMIT = 8;
/** Hard ceiling, so one call cannot spend an unbounded number of model calls. */
const MAX_LIMIT = 20;
/** Hard ceiling for a single criterion, in code points. */
const MAX_CRITERION_CHARS = 16;
/**
 * Words that name no particular activity. A criterion equal to one of these
 * matches almost every summary, which is indistinguishable from having no
 * criterion at all while looking generated.
 */
const GENERIC_CRITERIA = new Set([
    '工作',
    '任务',
    '项目',
    '开发',
    '修改',
    '测试',
    '代码',
    '文档',
    '研究',
    '学习',
    '优化',
    '内容',
    '事情',
    '东西',
    '活动',
    '其他',
    '日常',
    'work',
    'task',
    'project',
    'development',
    'coding',
    'testing',
    'documentation',
    'research',
]);
/** Normalize a criterion for equality/overlap checks. */
function normalizeCriterion(text) {
    return text
        .toLowerCase()
        .replace(/[\s\u3000]+/g, '')
        .replace(/[.,;:!?'"`()[\]{}<>/\\|]/g, '');
}
/**
 * Gate one candidate criterion.
 *
 * A criterion is a phrase that appears inside an activity summary, not a
 * sentence about one: punctuation, an over-long phrase, or a word that names
 * nothing all make the matcher unusable.
 */
function checkCriterion(text) {
    const value = text.trim();
    const length = [...value].length;
    if (length < 2)
        return { value, problem: 'TOO_SHORT' };
    if (length > MAX_CRITERION_CHARS)
        return { value, problem: 'TOO_LONG' };
    if (/[。！？；;，,\n\r]/.test(value))
        return { value, problem: 'SENTENCE' };
    if (GENERIC_CRITERIA.has(normalizeCriterion(value)))
        return { value, problem: 'GENERIC' };
    return { value };
}
/** Whether two criteria overlap (equal, or one contains the other). */
function criteriaOverlap(left, right) {
    const a = normalizeCriterion(left);
    const b = normalizeCriterion(right);
    if (a.length === 0 || b.length === 0)
        return false;
    return a === b || (a.length >= 2 && b.includes(a)) || (b.length >= 2 && a.includes(b));
}
/** Deduplicate strings by normalized form, preserving order. */
function dedupe(items) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
        const key = normalizeCriterion(item);
        if (key.length === 0 || seen.has(key))
            continue;
        seen.add(key);
        out.push(item);
    }
    return out;
}
/** Strip a Markdown fence around the JSON object. */
function stripFence(text) {
    const trimmed = text.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    const body = fenced?.[1];
    return typeof body === 'string' ? body.trim() : trimmed;
}
/**
 * Parse the model's JSON answer.
 *
 * Arrays are required (an empty array is allowed here; the quality gate turns
 * it into "unable"). A non-JSON answer is a failed call, not an empty
 * suggestion: the two mean different things to the user.
 */
function parseCriteriaOutput(text) {
    const stripped = stripFence(text);
    if (stripped.length === 0)
        return { ok: false, error: '模型返回了空内容' };
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start < 0 || end < start)
        return { ok: false, error: '模型没有返回 JSON 对象' };
    let raw;
    try {
        raw = JSON.parse(stripped.slice(start, end + 1));
    }
    catch (error) {
        return { ok: false, error: `模型返回的 JSON 无法解析：${String(error)}` };
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: '模型返回的不是 JSON 对象' };
    }
    const record = raw;
    const relevant = record.relevantActivities;
    const excluded = record.excludedActivities;
    if (!Array.isArray(relevant))
        return { ok: false, error: '模型输出缺少 relevantActivities 数组' };
    if (excluded !== undefined && !Array.isArray(excluded)) {
        return { ok: false, error: 'excludedActivities 必须是数组' };
    }
    const strings = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
    const unable = record.unable === true;
    const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
    return {
        ok: true,
        value: {
            relevantActivities: strings(relevant),
            excludedActivities: strings(excluded),
            unable,
            reason,
        },
    };
}
/** Collect directory names and representative file names under a goal's paths. */
async function collectClues(projectRoot, paths) {
    const directories = new Set();
    const files = new Set();
    const root = resolve(projectRoot);
    for (const rawPath of paths.slice(0, 3)) {
        const cleaned = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
        if (cleaned.length === 0)
            continue;
        const absolute = resolve(root, cleaned);
        const rel = relative(root, absolute);
        if (rel.startsWith('..') || isAbsolute(rel))
            continue;
        try {
            const info = await stat(absolute);
            if (info.isFile()) {
                files.add(basename(absolute));
                const parent = dirname(rel);
                if (parent !== '.' && parent.length > 0)
                    directories.add(basename(parent));
                continue;
            }
            if (!info.isDirectory())
                continue;
            const entries = await readdir(absolute, { withFileTypes: true });
            const subdirectories = [];
            for (const entry of entries.slice(0, 40)) {
                if (entry.name.startsWith('.') || entry.name === 'node_modules')
                    continue;
                if (entry.isDirectory()) {
                    directories.add(entry.name);
                    subdirectories.push(entry.name);
                }
                else if (entry.isFile())
                    files.add(entry.name);
            }
            // A path often points at a package directory whose files live one level
            // down (`src/analysis/verdict.ts`). One bounded look into the first few
            // subdirectories gives the model representative file names without
            // walking the tree.
            for (const subdirectory of subdirectories.slice(0, 2)) {
                try {
                    const nested = await readdir(resolve(absolute, subdirectory), { withFileTypes: true });
                    for (const entry of nested.slice(0, 10)) {
                        if (entry.isFile() && !entry.name.startsWith('.'))
                            files.add(entry.name);
                    }
                }
                catch {
                    // An unreadable subdirectory is skipped; the other clues still stand.
                }
            }
        }
        catch {
            // A path that does not exist is not an error: the goal may bind a
            // directory that has not been created yet, and title/description are
            // still enough to ask the question.
        }
    }
    return {
        directories: [...directories].sort().slice(0, 20),
        files: [...files].sort().slice(0, 15),
    };
}
/** Render the one user message for one goal. */
function buildCriteriaPrompt(goal, clues) {
    const clip = (text, max) => {
        const clean = text.replace(/\s+/g, ' ').trim();
        return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`;
    };
    const paths = goal.paths.length === 0 ? '（无）' : goal.paths.slice(0, 5).join('、');
    return [
        '为下面的目标生成活动判据（用于判断活动是否服务于它）。',
        '只输出一行 JSON：{"relevantActivities":["短词"],"excludedActivities":["短词"],"unable":false,"reason":""}。',
        `目标标题：${clip(goal.title, 80)}`,
        `目标描述：${clip(goal.description, 300) || '（无）'}`,
        `绑定路径：${paths}`,
        `候选线索：目录：${clues.directories.join('、') || '（无）'}；文件：${clues.files.join('、') || '（无）'}`,
        '要求：判据是活动摘要里会出现的短词（2-16字），不是整句、不带句号；',
        'relevantActivities 与 excludedActivities 不能重叠；无法判断时 unable=true 并在 reason 说明，不要编泛词。',
    ].join('\n');
}
/** Resolve the model route from config, falling back to the harness default. */
function resolveRoute(ctx, config) {
    const provider = config.realtime.provider.trim();
    const model = config.realtime.model.trim();
    if (provider.length > 0 && model.length > 0)
        return { provider, model };
    const agents = ctx.get('agents');
    const global = agents?.defaultModel?.();
    return {
        provider: provider.length > 0 ? provider : (global?.provider ?? ''),
        model: model.length > 0 ? model : (global?.model ?? ''),
    };
}
/** Run one bare model call and return its text. */
async function callCriteriaModel(llm, route, prompt, timeoutMs, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    const onAbort = () => controller.abort();
    if (signal.aborted)
        controller.abort();
    else
        signal.addEventListener('abort', onAbort, { once: true });
    try {
        const stream = await llm.stream({
            provider: route.provider,
            model: route.model,
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
            maxTokens: 300,
            signal: controller.signal,
        });
        let text = '';
        for await (const chunk of stream) {
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string')
                text += chunk.text;
        }
        return text;
    }
    finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
    }
}
/** Turn one parsed answer into a suggestion or an "unable" entry. */
function suggestionFrom(goal, parsed) {
    const rejected = [];
    const accept = (items) => {
        const out = [];
        for (const item of items) {
            const checked = checkCriterion(item);
            if (checked.problem !== undefined) {
                rejected.push(`${checked.value}:${checked.problem}`);
                continue;
            }
            out.push(checked.value);
        }
        return dedupe(out);
    };
    const relevant = accept(parsed.relevantActivities);
    const excluded = accept(parsed.excludedActivities);
    if (parsed.unable) {
        return {
            goalId: goal.id,
            title: goal.title,
            status: 'unable',
            relevantActivities: [],
            excludedActivities: [],
            reason: parsed.reason.length > 0 ? parsed.reason : '模型表示无法判断',
            rejected,
        };
    }
    // Check overlap on the model's raw lists, before the generic/sentence gate
    // drops an item: "写测试" vs "测试" is a contradiction in the answer even
    // though "测试" alone would be rejected as generic. Filtering first would
    // hide the overlap and turn a bad answer into a clean-looking suggestion.
    const rawClash = parsed.relevantActivities.find((item) => parsed.excludedActivities.some((other) => criteriaOverlap(item, other)));
    if (rawClash !== undefined) {
        return {
            goalId: goal.id,
            title: goal.title,
            status: 'unable',
            relevantActivities: [],
            excludedActivities: [],
            reason: `relevantActivities 与 excludedActivities 重叠：${rawClash}`,
            rejected,
        };
    }
    if (relevant.length === 0) {
        const detail = rejected.length === 0 ? '' : `（${rejected.join('；')}）`;
        return {
            goalId: goal.id,
            title: goal.title,
            status: 'unable',
            relevantActivities: [],
            excludedActivities: [],
            reason: `模型没有给出可用的判据${detail}`,
            rejected,
        };
    }
    return {
        goalId: goal.id,
        title: goal.title,
        status: 'suggested',
        relevantActivities: relevant,
        excludedActivities: excluded,
        reason: '',
        rejected,
    };
}
/**
 * Register `metacog_draft_criteria`.
 *
 * @param env - shared tool environment.
 */
export function metacogDraftCriteriaTool(env) {
    return defineMetacogTool({
        name: 'metacog_draft_criteria',
        description: 'Suggest activity criteria (relevantActivities / excludedActivities) for goals that have ' +
            'none. Each goal is one small bare-LLM call with only its title, description, bound paths ' +
            'and a few directory/file clues — never the whole tree. Returns suggestions only: nothing ' +
            'is written, so apply them through goal_tree_edit (or the next goal_tree_confirm). Defaults ' +
            'to the first 8 leaf goals without criteria; pass goalIds/overwrite to narrow or widen.',
        parameters: {
            type: 'object',
            properties: {
                goalIds: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Specific goal ids to draft for. Omit to take all leaf goals that lack criteria. ' +
                        'Unknown ids are reported in `skipped`.',
                },
                overwrite: {
                    type: 'boolean',
                    description: 'Draft for goals that already have criteria too. Default false: existing criteria are ' +
                        'never replaced by a suggestion.',
                },
                dryRun: {
                    type: 'boolean',
                    description: 'Default true. This tool never writes the tree; false only records that the caller ' +
                        'intended to apply the result elsewhere.',
                },
                limit: {
                    type: 'integer',
                    description: `Maximum goals processed in one call. Defaults to ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}.`,
                },
            },
            additionalProperties: false,
        },
        outputSchema: { type: 'object' },
        async run(args, exec) {
            const input = (args ?? {});
            const { projectRoot, projectId, store } = await loadProject(env, exec);
            const state = await store.readState(projectId);
            if (state === undefined || !state.confirmed) {
                throw new GateError('NO_CONFIRMED_TREE', 'this project has no confirmed goal tree to draft criteria for');
            }
            const llm = env.ctx.get('llm');
            if (llm === undefined || typeof llm.stream !== 'function') {
                throw new GateError('LLM_UNAVAILABLE', 'the host exposes no llm service, so no criteria can be drafted; no empty suggestion is returned');
            }
            const route = resolveRoute(env.ctx, env.config);
            if (route.provider.length === 0 || route.model.length === 0) {
                throw new GateError('LLM_NOT_CONFIGURED', 'realtime.provider / realtime.model are empty and no global model could be resolved; ' +
                    'configure a model before drafting criteria');
            }
            const overwrite = input.overwrite === true;
            const dryRun = input.dryRun !== false;
            const rawLimit = typeof input.limit === 'number' && Number.isFinite(input.limit) ? Math.floor(input.limit) : DEFAULT_LIMIT;
            const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit));
            const childIds = new Set(state.goals.map((goal) => goal.parentId).filter((id) => typeof id === 'string'));
            const hasCriteria = (goal) => goal.alignment.relevantActivities.length > 0;
            const isLiveLeaf = (goal) => !childIds.has(goal.id) && goal.status !== 'done' && goal.status !== 'deprecated';
            const skipped = [];
            let candidates;
            const explicit = Array.isArray(input.goalIds)
                ? input.goalIds.filter((id) => typeof id === 'string' && id.length > 0)
                : undefined;
            if (explicit === undefined) {
                candidates = state.goals.filter((goal) => isLiveLeaf(goal));
            }
            else {
                candidates = [];
                for (const id of explicit) {
                    const goal = state.goals.find((item) => item.id === id);
                    if (goal === undefined) {
                        skipped.push({ goalId: id, reason: 'unknown_goal' });
                        continue;
                    }
                    if (goal.status === 'done' || goal.status === 'deprecated') {
                        skipped.push({ goalId: id, reason: `goal_${goal.status}` });
                        continue;
                    }
                    candidates.push(goal);
                }
            }
            const eligible = candidates.filter((goal) => {
                if (!overwrite && hasCriteria(goal)) {
                    skipped.push({ goalId: goal.id, reason: 'has_criteria' });
                    return false;
                }
                return true;
            });
            const selected = eligible.slice(0, limit);
            const suggestions = [];
            for (const goal of selected) {
                try {
                    const clues = await collectClues(projectRoot, goal.paths);
                    const prompt = buildCriteriaPrompt(goal, clues);
                    const text = await callCriteriaModel(llm, route, prompt, env.config.realtime.timeoutMs, exec.signal);
                    const parsed = parseCriteriaOutput(text);
                    if (!parsed.ok) {
                        suggestions.push({
                            goalId: goal.id,
                            title: goal.title,
                            status: 'failed',
                            relevantActivities: [],
                            excludedActivities: [],
                            reason: parsed.error,
                            rejected: [],
                        });
                        continue;
                    }
                    suggestions.push(suggestionFrom(goal, parsed.value));
                }
                catch (error) {
                    // One goal's failure must not abort the batch: the other goals still
                    // have usable suggestions.
                    suggestions.push({
                        goalId: goal.id,
                        title: goal.title,
                        status: 'failed',
                        relevantActivities: [],
                        excludedActivities: [],
                        reason: error instanceof Error ? error.message : String(error),
                        rejected: [],
                    });
                }
            }
            const counts = {
                suggested: suggestions.filter((item) => item.status === 'suggested').length,
                unable: suggestions.filter((item) => item.status === 'unable').length,
                failed: suggestions.filter((item) => item.status === 'failed').length,
            };
            return {
                projectId,
                projectRoot,
                dryRun,
                wrote: false,
                totalGoals: state.goals.length,
                eligible: eligible.length,
                processed: selected.length,
                truncated: Math.max(0, eligible.length - selected.length),
                suggestions,
                skipped,
                counts,
                note: '这些只是建议，没有写库。确认后用 goal_tree_edit 把 relevantActivities / ' +
                    'excludedActivities 写进目标；判据决定后续所有判定，不能由一次生成调用静默改掉。',
            };
        },
    });
}
