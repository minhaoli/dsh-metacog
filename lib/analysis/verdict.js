/**
 * Realtime bare-LLM verdict channel.
 *
 * A small model is asked, every few minutes, how well the current window of
 * activity matches the goals it plausibly serves. This module owns only that
 * call: it builds a budgeted prompt, runs one bare user-message turn against
 * the host's `llm` service, parses the strict three-field answer, and records
 * the call's cost facts. It does not decide when to run, and it does not feed
 * any coefficient — the scheduler and the feedback loop are separate stages.
 *
 * Three constraints are deliberate:
 *
 * - **No system prompt.** The user asked for a bare call: one short user
 *   message that states the task and carries the data. Adding a persona or a
 *   rule stack would make this a second monitor with its own prompt contract.
 * - **A hard input budget.** Only one or two relevant goals are sent, and only
 *   `title` / `relevantActivities` / `paths` from each. A whole tree would
 *   turn every five-minute check into a full-context request, which is exactly
 *   the cost this channel exists to avoid.
 * - **Failure is a value, not an exception.** A scheduled check must not die
 *   because a model is missing or a socket timed out; the caller gets a
 *   discriminated result and the reminder state machine decides whether the
 *   user hears about it.
 *
 * @module dsh-metacog/analysis/verdict
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { clampHint } from './escalation.js';
/** Default ceiling for the rendered prompt, in estimated tokens. */
export const DEFAULT_MAX_INPUT_TOKENS = 1000;
/** Default wall-clock ceiling for one verdict call. */
export const DEFAULT_TIMEOUT_MS = 20_000;
/** Hard cap on goals sent to the model: more would stop being "relevant". */
export const MAX_GOALS = 2;
/**
 * The one-line explanation shown when the plan's goal is vague.
 *
 * It names the consequence (both the realtime verdict and plan matching are
 * unreliable) and the action (`metacog_revise_plan`), because "the goal is
 * vague" alone leaves the user with nothing to do about it.
 */
export const VAGUE_GOAL_HINT = '本次会话目标被标记为模糊，实时判定与计划匹配都不够可靠；建议用 metacog_revise_plan 补一个具体目标。';
/**
 * The hint a vague goal produces, or `undefined` for a concrete goal.
 *
 * @param input - the verdict input carrying the plan's vagueness fact.
 * @returns a clamped one-line hint.
 */
export function vagueGoalHint(input) {
    if (input.vagueGoal !== true)
        return undefined;
    return clampHint(VAGUE_GOAL_HINT);
}
/**
 * Make a vague verdict's reason say why it has no score.
 *
 * The model is instructed to explain the vagueness, but a model that answered
 * with an ordinary alignment reason must not leave a `null` match unexplained.
 *
 * @param reason - the model's reason, already length-checked.
 * @returns a reason that names the vague goal.
 */
function vagueReason(reason) {
    return /模糊|无法可靠|无法判断/.test(reason) ? reason : '目标模糊，无法可靠判断';
}
/**
 * Estimate tokens conservatively enough for a budget check.
 *
 * ASCII runs at four characters per token; every non-ASCII code point counts
 * as one token. That over-estimates CJK rather than under-estimating it,
 * which is the safe direction for a hard ceiling.
 *
 * @param text - rendered prompt or any fragment.
 * @returns estimated token count.
 */
export function estimateTokens(text) {
    let ascii = 0;
    let wide = 0;
    for (const character of text) {
        if ((character.codePointAt(0) ?? 0) <= 0x7f)
            ascii += 1;
        else
            wide += 1;
    }
    return Math.ceil(ascii / 4) + wide;
}
/** Normalize a path for segment-aware comparison. */
function normalizePath(path) {
    return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
}
/** Whether an activity path falls under, equals, or contains a goal path. */
function pathMatches(activityPath, goalPath) {
    const activity = normalizePath(activityPath);
    const goal = normalizePath(goalPath);
    if (activity.length === 0 || goal.length === 0)
        return false;
    return activity === goal || activity.startsWith(`${goal}/`) || goal.startsWith(`${activity}/`);
}
/** Score one goal against the window: path hits weigh more than keyword hits. */
function scoreGoal(goal, activities) {
    const keywords = goal.relevantActivities.map((item) => item.trim().toLowerCase()).filter((item) => item.length > 0);
    let score = 0;
    for (const activity of activities) {
        const paths = activity.paths ?? [];
        if (paths.some((path) => goal.paths.some((goalPath) => pathMatches(path, goalPath))))
            score += 2;
        const action = activity.action.toLowerCase();
        if (keywords.some((keyword) => action.includes(keyword)))
            score += 1;
    }
    return score;
}
/**
 * Pick the goals the window is most plausibly about.
 *
 * Path ownership is the strongest signal, then activity keywords. When nothing
 * matches, the first goals are kept rather than sending an empty goal list: a
 * verdict with no goal to name would always answer `goalId: null` and say
 * nothing about whether the work is on target.
 *
 * @param goals - candidate goals, in caller order.
 * @param activities - the window.
 * @param limit - maximum goals to return (default {@link MAX_GOALS}).
 * @returns up to `limit` goals, most relevant first.
 */
export function selectRelevantGoals(goals, activities, limit = MAX_GOALS) {
    if (limit <= 0)
        return [];
    const ranked = goals.map((goal, index) => ({ goal, index, score: scoreGoal(goal, activities) }));
    ranked.sort((left, right) => right.score - left.score || left.index - right.index);
    const matched = ranked.filter((entry) => entry.score > 0);
    return (matched.length > 0 ? matched : ranked).slice(0, limit).map((entry) => entry.goal);
}
/** Clip one field to a character cap, marking the cut. */
function clip(text, max) {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`;
}
/** Default per-field caps for a goal line. */
const GOAL_CAPS = { title: 60, activities: 4, paths: 4 };
/** Tighter caps used only when the default rendering cannot fit the budget. */
const SHORT_GOAL_CAPS = { title: 24, activities: 2, paths: 2 };
/** Render one goal line with only the three permitted fields. */
function goalLine(goal, caps = GOAL_CAPS) {
    const relevant = goal.relevantActivities
        .filter((item) => item.trim().length > 0)
        .slice(0, caps.activities)
        .map((item) => clip(item, 30))
        .join('、') || '（无）';
    const paths = goal.paths
        .filter((item) => item.trim().length > 0)
        .slice(0, caps.paths)
        .map((item) => clip(item, 40))
        .join('、') || '（无）';
    return `- id: ${goal.id} | 标题: ${clip(goal.title, caps.title)} | 相关活动: ${relevant} | 路径: ${paths}`;
}
/** Format an activity timestamp as `HH:MM` when it parses, else keep the text. */
function clockOf(at) {
    const date = new Date(at);
    if (Number.isNaN(date.getTime()))
        return clip(at, 16);
    const pad = (value) => String(value).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** Render one activity line: time, action, and up to two paths. */
function activityLine(activity) {
    const paths = (activity.paths ?? [])
        .filter((path) => path.trim().length > 0)
        .slice(0, 2)
        .map((path) => clip(path, 50));
    const suffix = paths.length > 0 ? ` [${paths.join('、')}]` : '';
    return `- ${clockOf(activity.at)} ${clip(activity.action, 90)}${suffix}`;
}
/** The one instruction block; no persona, no rule stack. */
const PROMPT_HEADER = [
    '两件事分开判断，不要合并：',
    '1) match：本次工作与目标的对齐程度（0到1）。',
    '2) fulfilled：上一次预期是否兑现（true/false；没有上次预期时必须 null）。',
    'fulfilled=false 只说明方向与上次预测不同，不代表偏离；偏离由 match 与 reason 判断。',
    '只输出一行 JSON：{"match":0到1的小数,"goalId":"目标id或null","reason":"不超过20字的中文","expectNext":"接下来应该看到什么，不超过20字","fulfilled":true/false/null}。',
].join('\n');
/**
 * The instruction block used when the plan's goal is vague.
 *
 * `match` is forced to `null` rather than merely allowed to be: a vague goal
 * has no checkable target, so any number would look like a measurement while
 * being an artefact of the prompt. The two questions stay separate exactly as
 * in the concrete header — a changed direction is still not drift.
 */
const VAGUE_PROMPT_HEADER = [
    '两件事分开判断，不要合并：',
    '1) match：目标被标记为模糊，无法可靠判断；match 必须为 null，不要给分数。',
    '2) fulfilled：上一次预期是否兑现（true/false；没有上次预期时必须 null）。',
    'fulfilled=false 只说明方向与上次预测不同，不代表偏离。',
    '只输出一行 JSON：{"match":null,"goalId":"目标id或null","reason":"说明目标模糊导致无法可靠判断，不超过20字","expectNext":"接下来应该看到什么，不超过20字","fulfilled":true/false/null}。',
].join('\n');
/** Assemble the final prompt text. */
function renderPrompt(header, vagueLine, goalLines, activityLines, previousLine) {
    return [
        header,
        ...(vagueLine === undefined ? [] : [vagueLine]),
        previousLine,
        '目标：',
        ...(goalLines.length === 0 ? ['（无）'] : goalLines),
        '活动：',
        ...(activityLines.length === 0 ? ['（窗口内无活动）'] : activityLines),
    ].join('\n');
}
/** Shrink text to a conservative character ceiling as a last resort. */
function truncateToBudget(text, maxTokens) {
    let low = 0;
    let high = text.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (estimateTokens(text.slice(0, middle)) <= maxTokens)
            low = middle;
        else
            high = middle - 1;
    }
    return text.slice(0, low);
}
/**
 * Build the one user message for a verdict call.
 *
 * Goals are selected first, then the newest activity lines are added while the
 * estimate stays under the budget. Dropping the oldest lines rather than the
 * newest is intentional: the question is what the current window is about, and
 * the newest work is the best evidence for that.
 *
 * @param input - goals and activities for this window.
 * @param options - budget and shaping knobs.
 * @returns the prompt and the subset of goals/activities it contains.
 */
export function buildVerdictPrompt(input, options = {}) {
    const maxInputTokens = options.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
    const goals = selectRelevantGoals(input.goals, input.activities, options.maxGoals ?? MAX_GOALS);
    const maxActivities = options.maxActivities ?? 8;
    const lines = input.activities.map(activityLine);
    const previousLine = options.previousExpectNext === undefined || options.previousExpectNext === null
        ? '上次预期：无（首次判定，fulfilled 必须为 null）'
        : `上次预期：${clip(options.previousExpectNext, 40)}`;
    const vague = input.vagueGoal === true;
    const header = vague ? VAGUE_PROMPT_HEADER : PROMPT_HEADER;
    const vagueLine = vague
        ? `本次会话目标被标记为模糊（原因：${clip(input.vagueGoalReason ?? '未说明', 40)}）；判定只能说明无法可靠判断。`
        : undefined;
    let selected = lines.slice(Math.max(0, lines.length - maxActivities));
    let caps = GOAL_CAPS;
    let text = renderPrompt(header, vagueLine, goals.map((goal) => goalLine(goal, caps)), selected, previousLine);
    while (estimateTokens(text) > maxInputTokens && selected.length > 0) {
        selected = selected.slice(1);
        text = renderPrompt(header, vagueLine, goals.map((goal) => goalLine(goal, caps)), selected, previousLine);
    }
    if (estimateTokens(text) > maxInputTokens) {
        caps = SHORT_GOAL_CAPS;
        text = renderPrompt(header, vagueLine, goals.map((goal) => goalLine(goal, caps)), selected, previousLine);
    }
    while (estimateTokens(text) > maxInputTokens && selected.length > 0) {
        selected = selected.slice(1);
        text = renderPrompt(header, vagueLine, goals.map((goal) => goalLine(goal, caps)), selected, previousLine);
    }
    if (estimateTokens(text) > maxInputTokens)
        text = truncateToBudget(text, maxInputTokens);
    return { text, goals, activities: selected.length, estimatedTokens: estimateTokens(text) };
}
/** Strip one Markdown code fence, which models add despite the instruction. */
function stripFence(text) {
    const trimmed = text.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    const body = fenced?.[1];
    return typeof body === 'string' ? body.trim() : trimmed;
}
/**
 * Parse and validate the strict five-field answer.
 *
 * Extra fields are rejected rather than ignored: the contract says five
 * fields, and silently accepting a sixth makes the next prompt change
 * impossible to reason about. `goalId` is checked against the ids that were
 * actually sent, so a model cannot name a goal the caller never offered.
 *
 * When `hasPrevious` is `false`, `fulfilled` is normalized to `null` even if
 * the model returned a boolean. A first call has nothing to compare against,
 * and letting a stray `false` through would read as "failed on the first try".
 *
 * @param text - raw model output.
 * @param goalIds - ids sent in the prompt, when known.
 * @param options.hasPrevious - whether a previous expectation was sent.
 * @returns the verdict, or a readable reason it is unusable.
 */
export function parseVerdict(text, goalIds, options = {}) {
    const stripped = stripFence(text);
    if (stripped.length === 0)
        return { ok: false, error: 'empty model output' };
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start < 0 || end < start)
        return { ok: false, error: 'no JSON object found in model output' };
    let raw;
    try {
        raw = JSON.parse(stripped.slice(start, end + 1));
    }
    catch (error) {
        return { ok: false, error: `invalid JSON: ${String(error)}` };
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: 'verdict must be a JSON object' };
    }
    const record = raw;
    const expected = ['match', 'goalId', 'reason', 'expectNext', 'fulfilled'];
    const missing = expected.filter((key) => !(key in record));
    if (missing.length > 0)
        return { ok: false, error: `missing field: ${missing.join(', ')}` };
    const extra = Object.keys(record).filter((key) => !expected.includes(key));
    if (extra.length > 0)
        return { ok: false, error: `unexpected field: ${extra.join(', ')}` };
    const match = record.match;
    if (match === null) {
        // Null means "the goal is too vague to judge", never "zero". A caller that
        // did not declare a vague goal gets it rejected, so a model cannot opt out
        // of scoring on its own.
        if (options.allowNullMatch !== true) {
            return { ok: false, error: 'match must be a finite number between 0 and 1' };
        }
    }
    else if (typeof match !== 'number' || !Number.isFinite(match) || match < 0 || match > 1) {
        return { ok: false, error: 'match must be a finite number between 0 and 1' };
    }
    const goalId = record.goalId;
    if (goalId !== null && (typeof goalId !== 'string' || goalId.trim().length === 0)) {
        return { ok: false, error: 'goalId must be a non-empty string or null' };
    }
    if (typeof goalId === 'string' && goalIds !== undefined && !goalIds.includes(goalId)) {
        return { ok: false, error: `goalId "${goalId}" is not one of the provided goals` };
    }
    const reason = record.reason;
    if (typeof reason !== 'string')
        return { ok: false, error: 'reason must be a string' };
    const trimmed = reason.trim();
    if (trimmed.length === 0)
        return { ok: false, error: 'reason must not be empty' };
    if ([...trimmed].length > 20)
        return { ok: false, error: 'reason must be at most 20 characters' };
    const expectNext = record.expectNext;
    if (typeof expectNext !== 'string')
        return { ok: false, error: 'expectNext must be a string' };
    const nextTrimmed = expectNext.trim();
    if (nextTrimmed.length === 0)
        return { ok: false, error: 'expectNext must not be empty' };
    if ([...nextTrimmed].length > 20)
        return { ok: false, error: 'expectNext must be at most 20 characters' };
    const fulfilled = record.fulfilled;
    if (fulfilled !== null && typeof fulfilled !== 'boolean') {
        return { ok: false, error: 'fulfilled must be true, false or null' };
    }
    // A first call has no previous expectation to compare against; forcing null
    // here keeps "no baseline" from ever reading as "the first try failed".
    const normalizedFulfilled = options.hasPrevious === false ? null : fulfilled;
    return {
        ok: true,
        verdict: {
            match,
            goalId: typeof goalId === 'string' ? goalId : null,
            reason: trimmed,
            expectNext: nextTrimmed,
            fulfilled: normalizedFulfilled,
        },
    };
}
/**
 * Classify one failure into a suppression key.
 *
 * The key is what makes "suppress by reason" real: a missing model and a
 * dropped socket must not mask each other. The raw message is kept for the
 * reminder so the user can tell what actually happened.
 *
 * @param error - thrown value from the adapter or the stream.
 * @param timedOut - whether this module's own timeout fired.
 * @param aborted - whether the caller's signal aborted the call.
 * @returns stable key and message.
 */
export function classifyVerdictFailure(error, timedOut = false, aborted = false) {
    if (timedOut)
        return { key: 'timeout', reason: '调用超时' };
    if (aborted)
        return { key: 'aborted', reason: '调用被中止' };
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    const message = error instanceof Error ? error.message : String(error);
    const haystack = `${code} ${message}`.toLowerCase();
    if (code === 'NO_ADAPTER')
        return { key: 'no_adapter', reason: message || '没有匹配的模型适配器' };
    if (/model/.test(haystack) && /(not found|unknown|not registered|does not exist|no such)/.test(haystack)) {
        return { key: 'model_missing', reason: message };
    }
    if (/(auth|401|403|api key|credential|unauthorized)/.test(haystack)) {
        return { key: 'auth', reason: message };
    }
    if (/(quota|429|rate limit|too many requests)/.test(haystack)) {
        return { key: 'rate_limit', reason: message };
    }
    if (/(econn|enotfound|etimedout|network|fetch failed|socket|dns|connect)/.test(haystack)) {
        return { key: 'network', reason: message };
    }
    return { key: 'other', reason: message || '未知失败' };
}
/** Collect text and usage from one stream. */
async function collectStream(stream) {
    let text = '';
    let usage;
    for await (const chunk of stream) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string')
            text += chunk.text;
        else if (chunk.type === 'usage' && chunk.usage !== undefined)
            usage = chunk.usage;
    }
    return usage === undefined ? { text } : { text, usage };
}
/**
 * Where the failure state lives, following the project's storage convention.
 *
 * @param projectRoot - project directory.
 * @param storageSubdir - configured `.metacog`-style subdirectory.
 * @returns absolute path of the JSON state file.
 */
export function failureStatePath(projectRoot, storageSubdir) {
    return join(projectRoot, storageSubdir, 'realtime-verdict-failures.json');
}
/** A state with nothing suppressed. */
export function emptyFailureState(now = new Date()) {
    return { version: 1, suppressed: {}, updatedAt: now.toISOString() };
}
/** Read the persisted state; a missing or corrupt file reads as empty. */
export function readFailureState(path) {
    try {
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
            return emptyFailureState();
        const record = raw;
        const suppressed = {};
        const source = record.suppressed;
        if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
            for (const [key, value] of Object.entries(source)) {
                if (typeof value === 'string')
                    suppressed[key] = value;
            }
        }
        return {
            version: 1,
            suppressed,
            updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
        };
    }
    catch {
        return emptyFailureState();
    }
}
/** Write the state atomically (temp + rename). */
export function writeFailureState(path, state) {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(temp, path);
}
/**
 * Where per-project expectations live, following the storage convention.
 *
 * @param projectRoot - project directory.
 * @param storageSubdir - configured `.metacog`-style subdirectory.
 * @returns absolute path of the JSON state file.
 */
export function expectationStatePath(projectRoot, storageSubdir) {
    return join(projectRoot, storageSubdir, 'realtime-verdict-expectations.json');
}
/** A state with no recorded expectation. */
export function emptyExpectationState(now = new Date()) {
    return { version: 1, projects: {}, updatedAt: now.toISOString() };
}
/** Read persisted expectations; a missing or corrupt file reads as empty. */
export function readExpectationState(path) {
    try {
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
            return emptyExpectationState();
        const record = raw;
        const projects = {};
        const source = record.projects;
        if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
            for (const [projectId, value] of Object.entries(source)) {
                if (value === null || typeof value !== 'object' || Array.isArray(value))
                    continue;
                const entry = value;
                if (typeof entry.expectNext !== 'string' || entry.expectNext.trim().length === 0)
                    continue;
                if (typeof entry.at !== 'string')
                    continue;
                const match = entry.match;
                if (match !== null && (typeof match !== 'number' || !Number.isFinite(match)))
                    continue;
                const goalId = entry.goalId;
                if (goalId !== null && typeof goalId !== 'string')
                    continue;
                projects[projectId] = {
                    expectNext: entry.expectNext,
                    at: entry.at,
                    match: typeof match === 'number' ? match : null,
                    goalId: typeof goalId === 'string' ? goalId : null,
                };
            }
        }
        return {
            version: 1,
            projects,
            updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
        };
    }
    catch {
        return emptyExpectationState();
    }
}
/** Write expectations atomically (temp + rename). */
export function writeExpectationState(path, state) {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(temp, path);
}
/**
 * Remind once per failure reason, stay quiet until a success re-arms.
 *
 * State is persisted because a restart is not a recovery: without the file,
 * every launch would repeat the same "model not found" reminder and the user
 * would learn to ignore it. A success clears every suppression, so a later
 * failure of any kind is worth one new reminder.
 */
export class RealtimeFailureReminder {
    #statePath;
    #remind;
    #now;
    #state;
    constructor(options) {
        this.#statePath = options.statePath;
        this.#remind = options.remind;
        this.#now = options.now ?? (() => new Date());
        this.#state = readFailureState(options.statePath);
    }
    /** Reasons currently suppressed, sorted for stable assertions. */
    get suppressedKeys() {
        return Object.keys(this.#state.suppressed).sort();
    }
    /**
     * Record one failure and remind only when this reason is not suppressed.
     *
     * @param reasonKey - classified key.
     * @param reason - human sentence for the reminder.
     * @returns whether a reminder was emitted.
     */
    recordFailure(reasonKey, reason) {
        if (this.#state.suppressed[reasonKey] !== undefined)
            return false;
        const at = this.#now().toISOString();
        this.#state = {
            version: 1,
            suppressed: { ...this.#state.suppressed, [reasonKey]: at },
            updatedAt: at,
        };
        this.#persist();
        this.#remind(`[metacog 实时判定] 失败（${reasonKey}）：${reason}。同类失败将不再提醒；恢复一次后重新启用。`);
        return true;
    }
    /**
     * Record one success: clear every suppression so a later failure re-arms.
     *
     * @returns whether anything was cleared.
     */
    recordSuccess() {
        if (Object.keys(this.#state.suppressed).length === 0)
            return false;
        const at = this.#now().toISOString();
        this.#state = { version: 1, suppressed: {}, updatedAt: at };
        this.#persist();
        return true;
    }
    /** Persist, reporting rather than throwing: a reminder must still fire. */
    #persist() {
        try {
            writeFailureState(this.#statePath, this.#state);
        }
        catch (error) {
            console.warn(`[dsh-metacog] could not persist realtime failure state: ${String(error)}`);
        }
    }
}
/**
 * Run one bare verdict call.
 *
 * Never throws: every failure becomes a {@link VerdictFailure} with a stable
 * reason key, so a scheduler can decide what to do without a try/catch around
 * every tick. A timeout aborts the adapter's stream and wins the race even if
 * the adapter ignores the signal.
 *
 * @param input - goals and activities for this window.
 * @param options - service, model route, budget, timeout and reminder.
 * @returns the parsed verdict or a classified failure.
 */
export async function runRealtimeVerdict(input, options) {
    const provider = options.provider.trim();
    const model = options.model.trim();
    const maxInputTokens = options.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
    const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const now = options.now ?? Date.now;
    const nowIso = options.nowIso ?? (() => new Date().toISOString());
    const started = now();
    // An empty window is the one case where the cheapest call is no call. It is
    // a distinct result rather than an empty prompt: a scheduler can skip the
    // tick on `idle` without re-deriving the same condition, and the model is
    // never asked to judge an empty list.
    if (input.activities.length === 0) {
        return { ok: true, status: 'idle', reason: '窗口内无活动，未调用模型' };
    }
    const projectId = options.projectId;
    const expectationPath = options.expectationPath;
    let previous = null;
    if (projectId !== undefined && expectationPath !== undefined) {
        try {
            previous = readExpectationState(expectationPath).projects[projectId] ?? null;
        }
        catch {
            // A corrupt or unreadable state file means "no baseline", not a failed
            // call: the verdict itself is still worth producing.
            previous = null;
        }
    }
    const prompt = buildVerdictPrompt(input, {
        maxInputTokens,
        ...(previous === null ? {} : { previousExpectNext: previous.expectNext }),
    });
    const metaOf = (outputChars, usage) => ({
        provider,
        model,
        elapsedMs: Math.max(0, now() - started),
        inputChars: prompt.text.length,
        outputChars,
        ...(usage === undefined ? {} : { usage }),
    });
    const fail = (status, reasonKey, reason, meta) => {
        options.reminder?.recordFailure(reasonKey, reason);
        return meta === undefined
            ? { ok: false, status, reason, reasonKey }
            : { ok: false, status, reason, reasonKey, meta };
    };
    const llm = options.llm;
    if (llm === undefined || typeof llm.stream !== 'function') {
        return fail('unavailable', 'unavailable', '宿主没有 llm 服务，无法进行实时判定');
    }
    if (provider.length === 0 || model.length === 0) {
        return fail('failed', 'no_model', 'realtime.provider / realtime.model 为空，且调用方没有解析出全局模型');
    }
    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;
    const onAbort = () => {
        callerAborted = true;
        controller.abort();
    };
    if (options.signal !== undefined) {
        if (options.signal.aborted)
            onAbort();
        else
            options.signal.addEventListener('abort', onAbort, { once: true });
    }
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error('verdict call timed out'));
        }, timeoutMs);
    });
    let output = '';
    let usage;
    try {
        const stream = Promise.resolve().then(() => llm.stream({
            provider,
            model,
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt.text }] }],
            maxTokens: options.maxOutputTokens ?? 200,
            signal: controller.signal,
        }));
        const collected = stream.then((iterable) => collectStream(iterable));
        // The losing side of the race may reject after the timeout; keep that
        // rejection from surfacing as an unhandled one.
        collected.catch(() => undefined);
        const result = await Promise.race([collected, timeout]);
        output = result.text;
        usage = result.usage;
    }
    catch (error) {
        const classified = classifyVerdictFailure(error, timedOut, callerAborted);
        return fail('failed', classified.key, classified.reason, metaOf(output.length, usage));
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
    }
    const meta = metaOf(output.length, usage);
    if (output.trim().length === 0) {
        return fail('failed', 'invalid_output', '模型返回了空内容', meta);
    }
    const vague = input.vagueGoal === true;
    const parsed = parseVerdict(output, prompt.goals.map((goal) => goal.id), {
        hasPrevious: previous !== null,
        allowNullMatch: vague,
    });
    if (!parsed.ok)
        return fail('failed', 'invalid_output', parsed.error, meta);
    // A vague goal can never produce a trustworthy score. The prompt asks for
    // null, and this is the enforcement: even if the model returned a number, it
    // is replaced with null and the reason is made to name the vagueness. A
    // number here would be read as a measurement it is not.
    const verdict = vague
        ? { ...parsed.verdict, match: null, reason: vagueReason(parsed.verdict.reason) }
        : parsed.verdict;
    const current = {
        expectNext: verdict.expectNext,
        at: nowIso(),
        match: verdict.match,
        goalId: verdict.goalId,
    };
    if (projectId !== undefined && expectationPath !== undefined) {
        try {
            const state = readExpectationState(expectationPath);
            const nextState = {
                version: 1,
                projects: { ...state.projects, [projectId]: current },
                updatedAt: current.at,
            };
            writeExpectationState(expectationPath, nextState);
        }
        catch (error) {
            // A failed write must not turn a usable verdict into a failure; the next
            // successful call simply has no previous expectation to compare with.
            console.warn(`[dsh-metacog] could not persist realtime expectation: ${String(error)}`);
        }
    }
    options.reminder?.recordSuccess();
    const hint = vagueGoalHint(input);
    return {
        ok: true,
        status: 'ok',
        verdict,
        meta,
        expectation: { previous, current, fulfilled: verdict.fulfilled },
        hints: hint === undefined ? [] : [hint],
    };
}
/** Project one stored goal into the model-facing shape. */
export function toVerdictGoal(goal) {
    return {
        id: goal.id,
        title: goal.title,
        relevantActivities: goal.alignment.relevantActivities,
        paths: goal.paths,
    };
}
/** Project one activity record into the model-facing shape. */
export function toVerdictActivity(activity) {
    const paths = activity.evidence.filter((item) => item.includes('/') || item.includes('\\'));
    return {
        at: activity.timestamp,
        action: activity.summary,
        ...(paths.length === 0 ? {} : { paths }),
    };
}
