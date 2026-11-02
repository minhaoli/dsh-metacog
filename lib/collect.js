/**
 * Live observation from the host's session event feed.
 *
 * The plugin subscribes to exactly one host event (`session/event`) and turns a
 * narrow slice of it into `ActivityRecord`s. Everything here obeys three rules
 * that keep a passive listener from becoming a liability:
 *
 * 1. **Never blocking.** The feed is fire-and-forget and the host logs and
 *    contains observer failures, so a throw would be silent data loss. Every
 *    handler is wrapped and every failure is downgraded to a warning.
 * 2. **Never inventing evidence.** Events that carry no verifiable payload —
 *    a turn boundary, a reasoning step — are ignored outright. Only tool calls
 *    and explicit user messages produce records, and both are graded honestly:
 *    a tool call is Grade A only when it names a real artifact.
 * 3. **Never double counting.** Each record is keyed by its host identity
 *    (`sessionId + callId` for tools, `sessionId + seq` for messages), so a
 *    replayed or re-delivered event collapses in the store's dedupe path.
 *
 * Tool results are deliberately *not* recorded as activities. A result is the
 * consequence of a call that was already recorded; recording both would double
 * every count the escalation machine reads.
 *
 * @module dsh-metacog/collect
 */
import { createHash } from 'node:crypto';
import { userMessageFingerprint } from './analysis/service.js';
/**
 * The results a single turn may keep.
 *
 * Bounded because a turn that runs fifty shell commands would otherwise grow the
 * record without limit, and only the last few describe where it ended up.
 */
const MAX_TURN_RESULTS = 8;
/**
 * Open a fresh bucket for one turn.
 *
 * @param turn - turn number this bucket belongs to.
 * @param report - the assistant message that opened it, when there was one.
 * @returns an empty bucket.
 */
function emptyBucket(turn, report = '') {
    return { turn, report, evidence: [], toolNames: [], toolResults: [], toolPaths: [] };
}
/** How many call id → tool name pairs the collector remembers. */
const CALL_NAME_LIMIT = 500;
/**
 * Tools whose calls are pure observation of the agent's own metacog state.
 *
 * Recording these as project activity would create a feedback loop: reading the
 * goal tree would look like an activity aligned with every goal, and the drift
 * counters would slowly fill with the monitor watching itself.
 */
const SELF_TOOL_NAMES = new Set([
    'goal_tree_init',
    'goal_tree_confirm',
    'goal_tree_edit',
    'contradiction_tree_edit',
    'goal_tree_view',
    'check_drift',
    'contradiction_observe',
    'resolve_intervention',
    'generate_report',
]);
/**
 * Read-only tools that carry no project signal on their own.
 *
 * A `read` of a config file, a `glob` for a filename pattern or a `todo_write`
 * bookkeeping call says nothing about goal alignment, and treating them as
 * activity would bury real signal under routine tooling noise. They are counted
 * as ignored, which is honest: the collector saw the event and declined it.
 */
const NOISE_TOOL_NAMES = new Set([
    'todo_write',
    'session_list',
    'list_agents',
    'ask_user_question',
    'job_list',
    'job_output',
    'schedule_list',
    // Reading and searching are how work is *looked at*, never what it is. A call
    // that merely opens a file produces an activity whose summary can only be
    // "read (tool call)" — a string no rule can judge, which is how the first real
    // run ended up calling 100% of activity "drift".
    'read',
    'glob',
    'grep',
    'list_dir',
    'ls',
    'metacog_read_document',
]);
/**
 * Parse a tool's arguments, tolerating both the object and JSON-string forms.
 *
 * @param rawArguments - arguments as the host reports them.
 */
function parseArguments(rawArguments) {
    if (typeof rawArguments === 'object' && rawArguments !== null) {
        return rawArguments;
    }
    if (typeof rawArguments !== 'string' || rawArguments.trim().length === 0)
        return undefined;
    try {
        const parsed = JSON.parse(rawArguments);
        return typeof parsed === 'object' && parsed !== null
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
/** Tools whose effect is a file change, so the summary should name the file. */
const FILE_WRITE_TOOL_NAMES = new Set(['edit', 'write', 'multi_edit', 'better_edit', 'apply_patch']);
/** Shell-style tools, whose effect is what the command did. */
const SHELL_TOOL_NAMES = new Set(['pwsh', 'bash', 'shell']);
/**
 * Turn one tool call into a sentence a rule can actually judge.
 *
 * `"edit (tool call)"` names no object: no goal can match it, so every such call
 * reads as drift. What a project actually changes is its files and its commands,
 * so those are the two things worth naming — and that is what "monitor the
 * output, not the keystroke" means in practice.
 *
 * @param toolName - the tool that ran.
 * @param rawArguments - its arguments as the host reports them.
 * @returns a summary, or `undefined` when this tool says nothing useful.
 */
export function describeToolCall(toolName, rawArguments) {
    const args = parseArguments(rawArguments);
    if (args === undefined)
        return undefined;
    if (FILE_WRITE_TOOL_NAMES.has(toolName)) {
        const paths = [
            ...(typeof args.file_path === 'string' ? [args.file_path] : []),
            ...(typeof args.path === 'string' ? [args.path] : []),
            ...(Array.isArray(args.files)
                ? args.files.filter((item) => typeof item === 'string')
                : []),
        ];
        const unique = [...new Set(paths)];
        if (unique.length === 0)
            return `修改文件（${toolName}）`;
        if (unique.length === 1)
            return `修改 ${unique[0]}`;
        return `修改 ${unique.length} 个文件：${unique.slice(0, 4).join('、')}`;
    }
    if (SHELL_TOOL_NAMES.has(toolName)) {
        if (typeof args.command === 'string' && args.command.trim().length > 0) {
            const first = args.command.split(/\r?\n/)[0]?.trim() ?? '';
            return `执行命令：${clamp(first, 120)}`;
        }
        return '执行命令';
    }
    return undefined;
}
/**
 * Classify a tool result as evidence about a checkable outcome.
 *
 * The v4 progress signal (S5) asks a narrow question: did anything verifiably
 * change? "The tests went from failing to passing" is the clearest answer to it,
 * and it is only visible in the *result*, which the collector used to discard.
 *
 * The classification is deliberately conservative. It reads the head of the
 * output for a small set of markers that only a test or build run produces, and
 * returns `null` for everything else — including a `pwsh` call that merely listed
 * a directory, which shares no markers with a test run and must not be counted
 * as a failed test simply because it printed nothing.
 *
 * @param toolName - tool that produced the result.
 * @param data - the `tool/result` payload.
 * @returns the recorded result, or `undefined` when it carries nothing usable.
 */
export function describeToolResult(toolName, data) {
    if (typeof data !== 'object' || data === null)
        return undefined;
    const payload = data;
    // The digest of the arguments that produced this result, captured when the call
    // was seen. Absent for records written before it existed, and absent reads as
    // "unknown" rather than "matches everything else that is absent".
    const signature = typeof payload.signature === 'string' ? payload.signature : '';
    // Success flag, tri-state: absent stays absent.
    //
    // The host payload carries neither `ok` nor `success` — it carries `isError`
    // (dsh-llm's `createToolResultMessage`). Reading only the first two left `ok`
    // permanently null, so a failed `edit` produced the same record as a successful
    // one, and the `file-changed` plan assertion was satisfied by a write that never
    // happened.
    //
    // `isError` is not the inverse of "did something useful", which is why this is
    // not simply `ok = !isError`:
    //
    // - `isError: true`  → the call itself failed. Unambiguously not progress.
    // - `isError: false` → the call ran. It says nothing about what it achieved: a
    //   test suite that exits non-zero is still a call that ran, and the host
    //   reports exactly that as `isError: false`. The outcome word lists are what
    //   judge the result; this flag only answers "did the tool break".
    //
    // A failed call therefore becomes `false`, a completed one `true`, and silence
    // stays `null`. Folding the middle case into `false` would make every ordinary
    // command look like a failure and hand S5 a false alarm on every turn.
    let ok = null;
    if (typeof payload.ok === 'boolean')
        ok = payload.ok;
    else if (typeof payload.success === 'boolean')
        ok = payload.success;
    else if (typeof payload.isError === 'boolean')
        ok = !payload.isError;
    else if (payload.error !== undefined)
        ok = false;
    const text = extractResultText(payload.output ?? payload.content ?? payload.error ?? data);
    if (text.length === 0 && ok === null)
        return undefined;
    return {
        tool: toolName,
        ok,
        excerpt: clamp(text, 240),
        outcome: classifyOutcome(text),
        signature,
    };
}
/**
 * A short, stable digest of a tool call's arguments.
 *
 * Used to tell "called the same tool again" from "called it with the same
 * arguments again" — the difference between normal iteration and a stuck loop.
 *
 * `JSON.stringify` is not enough on its own: key order is insertion order, so the
 * same logical call can serialise two ways. The object is therefore sorted before
 * hashing. A digest rather than the raw arguments keeps the record small and stops
 * a long command line from being copied into every activity row.
 *
 * @param args - the `arguments` field of one `tool/call`.
 * @returns a 16-character hex digest, or empty when there is nothing to hash.
 */
export function signatureOf(args) {
    if (args === undefined || args === null)
        return '';
    const canonical = canonicalise(args);
    if (canonical === undefined)
        return '';
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
/** Stable JSON for a value: object keys sorted, everything else as-is. */
function canonicalise(value, depth = 0) {
    // Bounded: arguments are small, but a pathological payload must not recurse
    // forever inside an event listener.
    if (depth > 6)
        return undefined;
    if (value === null)
        return 'null';
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    if (typeof value === 'string')
        return JSON.stringify(value);
    if (Array.isArray(value)) {
        const parts = [];
        for (const item of value) {
            const part = canonicalise(item, depth + 1);
            if (part === undefined)
                return undefined;
            parts.push(part);
        }
        return `[${parts.join(',')}]`;
    }
    if (typeof value === 'object') {
        const entries = Object.entries(value);
        const sorted = [...entries].sort(([left], [right]) => left.localeCompare(right));
        const parts = [];
        for (const [key, item] of sorted) {
            const part = canonicalise(item, depth + 1);
            if (part === undefined)
                return undefined;
            parts.push(`${JSON.stringify(key)}:${part}`);
        }
        return `{${parts.join(',')}}`;
    }
    // Functions and symbols cannot appear in a JSON payload; treat them as absent.
    return undefined;
}
/**
 * Pull readable text out of a result payload.
 *
 * Pays attention to `isError` on content blocks, because a failed tool call
 * returns its message there rather than throwing.
 *
 * @param value - candidate payload.
 * @returns the text, or an empty string.
 */
function extractResultText(value) {
    if (typeof value === 'string')
        return value;
    if (Array.isArray(value)) {
        const parts = [];
        for (const item of value) {
            if (typeof item === 'string')
                parts.push(item);
            else if (typeof item === 'object' && item !== null) {
                const block = item;
                if (typeof block.text === 'string')
                    parts.push(block.text);
                else if (typeof block.content === 'string')
                    parts.push(block.content);
            }
        }
        return parts.join('\n').trim();
    }
    if (typeof value === 'object' && value !== null) {
        const obj = value;
        if (typeof obj.text === 'string')
            return obj.text;
        if (typeof obj.content === 'string')
            return obj.content;
        if (typeof obj.message === 'string')
            return obj.message;
        // A JSON blob with none of the known fields: its key order is not evidence.
        return '';
    }
    return '';
}
/**
 * Markers that identify a test run's verdict.
 *
 * Both English and Chinese, because the shell here reports either depending on
 * the runner. Kept as separate lists rather than one regex so a marker cannot
 * accidentally be counted in both directions.
 */
const TEST_FAIL_MARKERS = [
    'tests failed',
    'test failed',
    'failing tests',
    'failures:',
    'failed, ',
    'assertionerror',
    'tests:  1 failed',
    '测试失败',
    '断言失败',
    // pytest and jest end with a bare counts line — "1 failed, 7 passed in 2.3s".
    // Every marker above needs a word before "failed", so that line matched nothing
    // and a failing run looked like an unrecognised output.
    //
    // Kept narrow on purpose: a bare "failed" would also match "compilation failed"
    // and report a build error as a test failure.
    'failed,',
    'failed in ',
    '1 failed',
    // pytest also lists each failure as "FAILED tests/test_x.py::test_a".
    'failed tests/',
    'failed  tests/',
];
const TEST_PASS_MARKERS = [
    'tests passed',
    'all tests pass',
    'test suites? passed',
    'passing',
    'ok, ',
    '测试通过',
    '全部通过',
    // The same counts line without a failure: "8 passed in 1.2s". Evaluated after
    // the fail markers, so "1 failed, 7 passed" still reads as a failure.
    ' passed',
];
const BUILD_FAIL_MARKERS = ['error ts', 'build failed', 'compilation failed', 'cannot find module', '编译失败', '构建失败'];
const BUILD_PASS_MARKERS = ['build succeeded', 'built successfully', 'compiled successfully', '构建成功', '编译成功'];
/**
 * Decide what a result says about a checkable outcome.
 *
 * A failure marker wins over a pass marker at the same level: a run that printed
 * both "3 passed" and "1 failed" failed.
 *
 * The host's success flag is not consulted. It says whether the tool call
 * returned without throwing, which is true for `pytest` exiting 1 — the flag and
 * the outcome are different questions, and conflating them would mark every
 * failing test run as a success.
 *
 * @param text - result text.
 * @returns the outcome class, or `null`.
 */
function classifyOutcome(text) {
    const lower = text.toLowerCase();
    const has = (markers) => markers.some((m) => lower.includes(m));
    // Build outcomes are checked first. A build failure prints "compilation failed"
    // and often also the word "failed" on its own line, so testing for test markers
    // first reported build errors as test failures. The build is the outer
    // operation; when it failed, the tests never ran.
    const buildFail = has(BUILD_FAIL_MARKERS);
    if (buildFail)
        return 'build-fail';
    const testFail = has(TEST_FAIL_MARKERS);
    const testPass = has(TEST_PASS_MARKERS);
    if (testFail)
        return 'tests-fail';
    if (testPass)
        return 'tests-pass';
    const buildPass = has(BUILD_PASS_MARKERS);
    if (buildPass)
        return 'build-pass';
    // A bare counts line with no leading word: "2 failed", "0 failed". The markers
    // above all need a word before the number, and enumerating "1 failed", "2
    // failed", … is the kind of list that silently misses "37 failed".
    if (/^\s*\d+\s+failed/im.test(text))
        return 'tests-fail';
    if (/^\s*\d+\s+passed/im.test(text))
        return 'tests-pass';
    // No textual marker. A failed flag alone is not a test outcome — it could be a
    // missing file — so this stays null rather than guessing.
    return null;
}
/**
 * Normalize a free-text fragment for matching and storage.
 *
 * @param value - raw text.
 * @param limit - maximum characters to keep.
 */
function clamp(value, limit) {
    const collapsed = value.replace(/\s+/g, ' ').trim();
    return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1).trimEnd()}…`;
}
/**
 * Pull the text out of a user message payload.
 *
 * Verified host contract (`SessionEventMap['user/message']` is the
 * `UserMessage` itself, not a wrapper): `content` is a block array. A block
 * list is the only documented shape, but a plain string is accepted rather
 * than silently dropping a message that a different host build might send.
 *
 * @param data - the `user/message` payload.
 * @returns the message text, or an empty string.
 */
function userMessageText(data) {
    if (data === null || data === undefined)
        return '';
    if (typeof data === 'string')
        return data;
    const content = data.content;
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (typeof block === 'object' &&
            block !== null &&
            block.type === 'text' &&
            typeof block.text === 'string') {
            parts.push(block.text);
        }
    }
    return parts.join(' ').trim();
}
/**
 * Extract the artifact-looking strings out of a tool's raw arguments.
 *
 * This is the evidence extraction that makes a tool call Grade A: a call that
 * touches a real path, symbol or commit has something verifiable behind it,
 * and a call that does not is honestly downgraded to Grade B. Only *shape*
 * is judged here — whether a path exists is the analyser's problem, not the
 * collector's, because a write to a not-yet-created file is still evidence.
 *
 * @param toolName - the tool that ran.
 * @param rawArguments - its arguments as a JSON string (host contract).
 * @returns candidate evidence strings.
 */
function toolEvidence(toolName, rawArguments) {
    const evidence = [];
    const push = (value) => {
        const text = clamp(value, 240);
        if (text.length > 0 && !evidence.includes(text))
            evidence.push(text);
    };
    if (typeof rawArguments === 'string') {
        let parsed;
        try {
            parsed = JSON.parse(rawArguments);
        }
        catch {
            // A malformed argument blob is still a call that happened; the summary
            // records it and evidence stays empty, which forces Grade B.
            return evidence;
        }
        collectFromValue(toolName, parsed, push, 0);
        return evidence;
    }
    collectFromValue(toolName, rawArguments, push, 0);
    return evidence;
}
/** Argument keys that conventionally carry a file path. */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'paths', 'files'];
/**
 * File paths one tool call named.
 *
 * `tool/call` is the only event that carries arguments — `tool/result` has none —
 * so this is the one moment a path can be captured. The keys are the conventional
 * spellings across the host's tools; anything else is left alone rather than
 * guessed at, because a mis-attributed path would satisfy a plan step for the
 * wrong reason and a false completion is worse than a missing one.
 *
 * Every tool is read, not only the write tools. A step declaring
 * `pathGlob: 'src/*.ts'` asks whether that path was touched, and a read of it is
 * a touch: the matcher is checking the step's own declaration, not building a
 * picture of what was modified.
 *
 * @param rawArguments - arguments as the host reports them (object or JSON string).
 * @returns distinct paths in first-seen order; `[]` when the call named none.
 */
function pathsOfToolCall(rawArguments) {
    const args = parseArguments(rawArguments);
    if (args === undefined)
        return [];
    const found = [];
    const seen = new Set();
    const push = (value) => {
        if (typeof value !== 'string')
            return;
        const text = value.trim();
        if (text.length === 0 || text.length > 400)
            return;
        if (seen.has(text))
            return;
        seen.add(text);
        found.push(text);
    };
    for (const key of PATH_KEYS) {
        const value = args[key];
        if (Array.isArray(value)) {
            for (const item of value)
                push(item);
            continue;
        }
        push(value);
    }
    return found;
}
/** Fields that conventionally carry a verifiable artifact. */
const EVIDENCE_KEYS = new Set([
    'file_path',
    'filePath',
    'path',
    'paths',
    'dir',
    'cwd',
    'command',
    'pattern',
    'url',
    'query',
    'target',
    'commit',
    'branch',
    'symbol',
]);
/**
 * Walk a parsed argument tree and collect artifact-shaped values.
 *
 * Depth is bounded because tool arguments can nest arbitrarily and a hostile or
 * merely large payload must not turn a listener into a CPU sink.
 */
function collectFromValue(toolName, value, push, depth) {
    if (depth > 3)
        return;
    if (typeof value === 'string') {
        // A long free-text argument is prose, not an artifact, unless the tool is
        // one whose payload is inherently a reference.
        if (value.length > 0 && value.length <= 400)
            push(`${toolName}: ${value}`);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value.slice(0, 12))
            collectFromValue(toolName, item, push, depth + 1);
        return;
    }
    if (typeof value !== 'object' || value === null)
        return;
    for (const [key, item] of Object.entries(value)) {
        if (EVIDENCE_KEYS.has(key)) {
            collectFromValue(toolName, item, push, depth + 1);
            continue;
        }
        // Nested one level for wrapper objects like `{ arguments: {...} }`.
        if (depth < 1 && typeof item === 'object' && item !== null) {
            collectFromValue(toolName, item, push, depth + 1);
        }
    }
}
/**
 * Build the collection record for one tool call.
 *
 * @param sessionId - session that produced the call.
 * @param data - the `tool/call` payload.
 * @returns the activity to record, or `undefined` when it is not activity.
 */
export function collectToolCall(sessionId, data) {
    if (typeof data !== 'object' || data === null)
        return undefined;
    const call = data;
    const toolName = typeof call.name === 'string' ? call.name : '';
    const callId = typeof call.callId === 'string' ? call.callId : '';
    if (toolName.length === 0 || callId.length === 0)
        return undefined;
    if (SELF_TOOL_NAMES.has(toolName) || NOISE_TOOL_NAMES.has(toolName))
        return undefined;
    const evidence = toolEvidence(toolName, call.arguments);
    // Grade A requires verifiable support. A call with no artifact in
    // its arguments is real activity but unreferenced, so it is sampled at B.
    const grade = evidence.length > 0 ? 'A' : 'B';
    return {
        summary: clamp(describeToolCall(toolName, call.arguments) ?? `${toolName} (tool call)`, 200),
        evidence,
        grade,
        sessionId,
        fingerprint: `tool:${sessionId}:${callId}`,
        source: 'tool_event',
        toolName,
    };
}
/**
 * Build the collection record for one user message.
 *
 * A user message is direct, first-hand description of what the user is doing;
 * the spec grades exactly that as Grade A. The message text is its own evidence
 * because the user authored it, so the record carries the clamped text.
 *
 * @param sessionId - session that produced the message.
 * @param seq - the event's log sequence, used as the dedupe identity.
 * @param data - the `user/message` payload.
 * @returns the activity to record, or `undefined` for an empty message.
 */
export function collectUserMessage(sessionId, seq, data) {
    const text = userMessageText(data);
    if (text.length === 0)
        return undefined;
    // Host-injected blocks arrive on the same feed as what the user typed. They are
    // infrastructure — runtime context, memory snapshots, discipline reminders — and
    // treating them as intent produced 210 of 383 "user messages" in the first real
    // run, every one of which the model then had to reject as not being activity.
    if (isInjectedBlock(text))
        return undefined;
    // No length floor: what the user asked for is the primary statement of intent
    // this monitor has, and discarding "继续" also discards the moment a long task
    // pivoted. A short message is judged as a short message, not dropped.
    return {
        summary: clamp(text, 240),
        evidence: [`user message: ${clamp(text, 240)}`],
        grade: 'A',
        sessionId,
        fingerprint: userMessageFingerprint(sessionId, seq ?? 'noseq'),
        source: 'user_input',
    };
}
/**
 * Prefixes the host uses for content it injects rather than content a person wrote.
 *
 * Matched at the start of the message, which is where every one of them appears in
 * practice; a user quoting one of these phrases mid-sentence is still recorded.
 */
const INJECTED_PREFIXES = [
    'Current runtime context.',
    'This snapshot supersedes earlier',
    'Time sampled while preparing turn',
    'MNEMON RUNTIME MEMORY SNAPSHOT',
    '<system-reminder>',
    '[MNEMON]',
    '`context_compact` done:',
    '`context_compact` result shadowed.',
    '（过程纪律提醒）',
    'This is an automatically generated checkpoint',
    'The working directory changed from',
];
/**
 * Whether a message is host-injected scaffolding rather than a user utterance.
 *
 * @param text - the extracted message text.
 */
export function isInjectedBlock(text) {
    const head = text.trimStart();
    return INJECTED_PREFIXES.some((prefix) => head.startsWith(prefix));
}
/**
 * Build the activity for one completed conversation turn.
 *
 * The unit of monitoring is a *turn*, not a tool call. What a turn did is stated
 * by its own closing report; the calls it made along the way are how it got
 * there, so they become the evidence behind that report rather than separate
 * activities. This is also the only summary with enough meaning for a rule to
 * judge: `edit (tool call)` names no object, which is why the first live run
 * called 100% of activity drift.
 *
 * @param sessionId - session the turn belongs to.
 * @param turn - turn number, used for the dedupe identity.
 * @param report - the assistant's final message of that turn.
 * @param evidence - artifacts the turn touched.
 */
export function collectTurnReport(sessionId, turn, report, evidence = [], trace = {}) {
    const text = report.trim();
    // Only genuine emptiness is skipped. Length was a proxy for "said nothing",
    // and it was the wrong proxy: "改完了" is a real claim about the turn, and the
    // judgement layer is better placed to weigh a short reply than a character
    // count is to throw it away.
    if (text.length === 0)
        return undefined;
    return {
        summary: clamp(text, 480),
        evidence: [...evidence],
        grade: evidence.length > 0 ? 'A' : 'B',
        sessionId,
        fingerprint: `turn:${sessionId}:${turn}`,
        source: 'turn',
        // Carried through even when empty: an empty sequence is a fact about the turn
        // (it called no tools), and `undefined` would mean "this record predates the
        // field", which the signal layer has to distinguish to avoid scoring silence
        // as compliance.
        toolNames: [...(trace.toolNames ?? [])],
        toolResults: [...(trace.toolResults ?? [])],
        toolPaths: (trace.toolPaths ?? []).map((paths) => [...paths]),
    };
}
/**
 * Subscribe the collector to the host feed.
 *
 * @param options - mount context, policy and sinks.
 * @returns the stats object (live) plus the disposer.
 */
export function installCollector(options) {
    const { ctx, config } = options;
    const stats = {
        seen: 0,
        recorded: 0,
        ignored: 0,
        skippedUninitialized: 0,
        errors: 0,
    };
    // Serialising the sink keeps records in feed order and bounds concurrency:
    // the feed can deliver several events in one tick, and each sink call reads
    // and appends files. One in-flight chain is cheaper than N racing chains.
    let chain = Promise.resolve();
    const enqueue = (work) => {
        chain = chain.then(work).catch((error) => {
            stats.errors += 1;
            // Never rethrow into the host feed: observer failures must not affect the
            // committed append this feed follows.
            ctx.logger.warn(`[dsh-metacog] collector dropped an event: ${String(error)}`);
        });
    };
    // One turn's report being accumulated, keyed by session: several conversations
    // can be in flight, and the turn number guards against a late event from an
    // earlier turn landing in this bucket.
    const inFlight = new Map();
    // callId -> tool name, scoped per session.
    //
    // Not one flat map: `inFlight` is keyed by session, and a lookup table that is
    // not would attribute one session's result to another session's tool if two
    // ever produced the same call id. The host uses UUIDs so a collision is not
    // expected, but the isolation boundary should match the rest of the collector
    // rather than rely on that.
    const callNames = new Map();
    // Arguments digest per call id, so a result can be matched back to the exact
    // call that produced it. `tool/result` carries no arguments, and "the same call
    // twice" is what distinguishes a stuck loop from ordinary iteration — without
    // this the behaviour track has nothing to compare.
    const callSignatures = new Map();
    /** Record one activity, or account for why it was not. */
    const deliver = async (session, activity) => {
        const resolved = await options.storeForSession(session.id, session.header?.cwd);
        if (resolved === undefined) {
            // The project has no confirmed tree yet, so there is nothing to align
            // against. Recording anyway would produce `uncertain` rows that pollute
            // the very statistics the report reads.
            stats.skippedUninitialized += 1;
            return;
        }
        await options.onActivity(activity, resolved);
        stats.recorded += 1;
    };
    const handle = async (session, event) => {
        // A subagent's work rolls up into the turn that spawned it; counting it
        // separately would double every activity.
        if (session.header?.origin === 'subagent') {
            stats.ignored += 1;
            return;
        }
        // What the user asked for is activity in its own right. A turn's report is
        // the model's account of what it did with that intent; the request that
        // produced the turn is the other half, and dropping it lost the moment a
        // long task pivoted.
        if (event.type === 'user/message') {
            const message = collectUserMessage(session.id, event.seq, event.data);
            if (message === undefined) {
                stats.ignored += 1;
                return;
            }
            await deliver(session, message);
            return;
        }
        if (event.type === 'tool/call') {
            const data = event.data;
            const name = typeof data?.name === 'string' ? data.name : '';
            const turn = typeof data?.turn === 'number' ? data.turn : undefined;
            if (name.length === 0 || turn === undefined || SELF_TOOL_NAMES.has(name)) {
                stats.ignored += 1;
                return;
            }
            // A noise tool still counts as a call for the class distribution, it just
            // does not become an activity of its own. Recording it as activity was the
            // thing that made the first run call 100% of activity drift (a `read` can
            // only be summarised as "read (tool call)"); recording nothing at all
            // instead would leave the class distribution missing its READ half, which
            // is what S2 measures. So the two decisions are separated: noise tools feed
            // the sequence, not the activities.
            const existingNoise = inFlight.get(session.id);
            const noiseBucket = existingNoise === undefined || existingNoise.turn !== turn
                ? emptyBucket(turn)
                : existingNoise;
            if (NOISE_TOOL_NAMES.has(name)) {
                noiseBucket.toolNames.push(name);
                // Pushed even though the call is noise: `toolPaths` is index-aligned with
                // `toolNames`, and the noise bucket becomes the in-flight bucket, so a
                // missing entry here would shift every later call's paths by one.
                noiseBucket.toolPaths.push(pathsOfToolCall(data?.arguments));
                inFlight.set(session.id, noiseBucket);
                stats.ignored += 1;
                return;
            }
            // The bucket is opened by the first call of a turn, not by the report:
            // otherwise every artifact a turn touched before it spoke would be lost.
            const existing = inFlight.get(session.id);
            const bucket = existing === undefined || existing.turn !== turn
                ? emptyBucket(turn)
                : existing;
            inFlight.set(session.id, bucket);
            bucket.toolNames.push(name);
            // The arguments are in hand here and nowhere else: `tool/result` carries no
            // arguments, so a path not captured now is lost for this call.
            bucket.toolPaths.push(pathsOfToolCall(data?.arguments));
            // Keep the call id, because `tool/result` does not carry the tool name: the
            // host appends results as `{ turn, step, message: { source: { callId }, ... } }`.
            // Reading `data.name` there matched nothing, so every result was dropped
            // before it could be parsed.
            const rawCallId = data?.callId;
            if (typeof rawCallId === 'string' && rawCallId.length > 0) {
                const perSession = callNames.get(session.id) ?? new Map();
                perSession.set(rawCallId, name);
                // Bounded per session. Eviction is by insertion order, which is only
                // safe because a matched pair is deleted below: what remains here is
                // either waiting for a result or already orphaned.
                if (perSession.size > CALL_NAME_LIMIT) {
                    const oldest = perSession.keys().next();
                    if (!oldest.done)
                        perSession.delete(oldest.value);
                }
                callNames.set(session.id, perSession);
                // The arguments digest rides alongside the name: the result event carries
                // no arguments of its own, and without them a repeated call is
                // indistinguishable from a repeated tool.
                const perSessionSignatures = callSignatures.get(session.id) ?? new Map();
                perSessionSignatures.set(rawCallId, signatureOf(data?.arguments));
                if (perSessionSignatures.size > CALL_NAME_LIMIT) {
                    const oldestSignature = perSessionSignatures.keys().next();
                    if (!oldestSignature.done)
                        perSessionSignatures.delete(oldestSignature.value);
                }
                callSignatures.set(session.id, perSessionSignatures);
            }
            for (const item of toolEvidence(name, data?.arguments)) {
                if (bucket.evidence.length >= 12)
                    break;
                if (!bucket.evidence.includes(item))
                    bucket.evidence.push(item);
            }
            stats.ignored += 1;
            return;
        }
        // Tool results carry the only evidence of a checkable outcome: a test that
        // went from failing to passing lives in the result, not in the call. Before
        // this branch existed S5 had no input at all.
        if (event.type === 'tool/result') {
            // Verified host shape (dsh-agent-loop's `appendToolResult`): the payload is
            // `{ turn, step, message }`, and everything about the result lives inside
            // `message` — `{ role: 'tool', source: { callId }, toolCallId, content, isError }`.
            // There is no `name` at the top level, which is why this branch used to
            // discard every result: it required `data.name` and always saw ''.
            const data = event.data;
            const turn = typeof data?.turn === 'number' ? data.turn : undefined;
            const message = (data?.message ?? {});
            const rawId = message.source?.callId ?? message.toolCallId;
            const callId = typeof rawId === 'string' ? rawId : '';
            const perSession = callNames.get(session.id);
            const name = perSession?.get(callId) ?? '';
            // The digest recorded when the call was seen, so the result can be matched to
            // the exact arguments that produced it.
            const signaturesForSession = callSignatures.get(session.id);
            const callSignature = signaturesForSession?.get(callId) ?? '';
            // Release on match: the pairing is one-shot, and keeping it would let a long
            // turn evict entries that are still waiting for their result.
            if (name.length > 0 && callId.length > 0)
                perSession?.delete(callId);
            if (callSignature.length > 0 && callId.length > 0)
                signaturesForSession?.delete(callId);
            const bucket = inFlight.get(session.id);
            if (name.length === 0 ||
                turn === undefined ||
                bucket === undefined ||
                bucket.turn !== turn ||
                SELF_TOOL_NAMES.has(name)) {
                stats.ignored += 1;
                return;
            }
            const result = describeToolResult(name, {
                content: message.content,
                isError: message.isError,
                ...(data?.error === undefined ? {} : { error: data.error }),
                ...(callSignature.length === 0 ? {} : { signature: callSignature }),
            });
            // Bounded: a turn that runs fifty commands must not grow the record without
            // limit, and the last few results are the ones that describe where it ended.
            if (result !== undefined) {
                bucket.toolResults.push(result);
                if (bucket.toolResults.length > MAX_TURN_RESULTS)
                    bucket.toolResults.shift();
            }
            stats.ignored += 1;
            return;
        }
        if (event.type === 'assistant/message') {
            const data = event.data;
            const turn = typeof data?.turn === 'number' ? data.turn : undefined;
            const text = turn === undefined ? '' : userMessageText(data?.message);
            if (turn === undefined || text.length === 0) {
                stats.ignored += 1;
                return;
            }
            const bucket = inFlight.get(session.id);
            // Later messages in the same turn supersede earlier ones: the closing
            // report is what the turn is actually claiming it did.
            if (bucket === undefined || bucket.turn !== turn) {
                inFlight.set(session.id, emptyBucket(turn, text));
            }
            else {
                bucket.report = text;
            }
            stats.ignored += 1;
            return;
        }
        if (event.type !== 'turn/end') {
            stats.ignored += 1;
            return;
        }
        const data = event.data;
        const turn = typeof data?.turn === 'number' ? data.turn : undefined;
        const kind = typeof data?.reason?.kind === 'string' ? data.reason.kind : '';
        const bucket = inFlight.get(session.id);
        inFlight.delete(session.id);
        const activity = bucket === undefined || turn === undefined || bucket.turn !== turn || kind !== 'completed'
            ? undefined
            : collectTurnReport(session.id, turn, bucket.report, bucket.evidence, {
                toolNames: bucket.toolNames,
                toolResults: bucket.toolResults,
                toolPaths: bucket.toolPaths,
            });
        if (activity === undefined) {
            stats.ignored += 1;
            return;
        }
        await deliver(session, activity);
    };
    const listener = (session, event) => {
        stats.seen += 1;
        if (!config.collection.enabled)
            return;
        enqueue(() => handle(session, event));
    };
    const off = ctx.on('session/event', listener);
    return {
        stats,
        dispose: () => {
            off();
            // The chain is not awaited here: disposal is synchronous by contract, and
            // pending work already holds its own file handles which close on their
            // own. Dropping the reference is what stops new work from being queued.
            chain = Promise.resolve();
        },
    };
}
/**
 * Describe the collector's capability boundary for the API table and logs.
 *
 * @param available - whether the host exposed the feed.
 */
export function collectorBoundary(available) {
    return available
        ? 'session/event subscribed; tool calls and user messages are collected at ' +
            'the grade their payload supports (A with an artifact, B otherwise)'
        : 'unsupported: host exposes no session event feed; collection stays off and ' +
            'drift checks run on manual input only (Grade C degradation)';
}
