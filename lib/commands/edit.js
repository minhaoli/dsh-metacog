/**
 * User-facing edit commands: `/metacog-goal` and `/metacog-contradiction`.
 *
 * Everything the model can do to the tree already has a tool. What was missing
 * was the other direction: a user who wants to fix one title should not have to
 * describe the change in prose and let a model retype it. These commands take
 * the change directly.
 *
 * What they deliberately do NOT do is skip the rules. A command is a second
 * entry point to the same governed write, not a privileged one:
 *
 * - the same CAS check refuses a stale version,
 * - the same structural gate demands `userConfirmed` for L0 and core changes,
 * - the same audit entry records who changed what and why.
 *
 * The only difference from the tool path is *who* supplies `userConfirmed`: for
 * a command the user typed it themselves, so `--force` is the confirmation. The
 * reason stays mandatory either way.
 *
 * This module is pure parsing plus formatting. The write itself goes through the
 * existing tools, so there is exactly one implementation of the governed write.
 *
 * @module dsh-metacog/commands/edit
 */
import { GateError } from '../governance.js';
import { ContradictionTypeSchema, ExplorationPolicySchema, GoalStatusSchema, } from '../data/types.js';
/** Goal statuses a command may assign. */
const GOAL_STATUSES = GoalStatusSchema.options;
/** Contradiction types a command may assign. */
const CONTRADICTION_TYPES = ContradictionTypeSchema.options;
/** Exploration policies a command may assign. */
const EXPLORATION_POLICIES = ExplorationPolicySchema.options;
/**
 * Split a command line into tokens, keeping `--key=value` and quoted values.
 *
 * The value may contain spaces when quoted; `--successCriteria="a, b"` becomes
 * one token with the quotes already stripped.
 *
 * @param raw - everything after the command name.
 * @returns tokens in order.
 */
export function tokenize(raw) {
    const tokens = [];
    let current = '';
    let quote;
    for (const char of raw) {
        if (quote !== undefined) {
            if (char === quote)
                quote = undefined;
            else
                current += char;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === ' ' || char === '\t' || char === '\n') {
            if (current.length > 0) {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        current += char;
    }
    if (current.length > 0)
        tokens.push(current);
    return tokens;
}
/**
 * Parse `--key=value` pairs plus positional tokens.
 *
 * @param tokens - tokenized command line.
 * @returns positional tokens, keyed flags, and bare `--flag` names.
 */
function splitFlags(tokens) {
    const positional = [];
    const flags = new Map();
    const bare = new Set();
    for (const token of tokens) {
        if (!token.startsWith('--')) {
            positional.push(token);
            continue;
        }
        const body = token.slice(2);
        const eq = body.indexOf('=');
        if (eq === -1)
            bare.add(body);
        else
            flags.set(body.slice(0, eq), body.slice(eq + 1));
    }
    return { positional, flags, bare };
}
/** List fields accept a comma-separated value; an empty value clears nothing. */
function listValue(value) {
    if (value === undefined)
        return undefined;
    const items = value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    return items.length === 0 ? undefined : items;
}
/**
 * Accept either a bare `YYYY-MM-DD` date or a full ISO timestamp.
 *
 * A bare date becomes midnight UTC of that day. Users type dates; requiring a
 * full timestamp with milliseconds would make the flag unusable by hand.
 *
 * @param value - the flag value.
 * @returns a valid ISO timestamp, or `undefined` when unparseable.
 */
function normalizeDate(value) {
    const trimmed = value.trim();
    if (trimmed.length === 0)
        return undefined;
    const bare = /^\d{4}-\d{2}-\d{2}$/;
    const candidate = bare.test(trimmed) ? `${trimmed}T00:00:00.000Z` : trimmed;
    const parsed = Date.parse(candidate);
    if (Number.isNaN(parsed))
        return undefined;
    return new Date(parsed).toISOString();
}
/** Assign a trimmed string field when the flag carries content. */
function setString(fields, key, value) {
    if (value !== undefined && value.trim().length > 0)
        fields[key] = value.trim();
}
/**
 * Parse one `/metacog-goal` line.
 *
 * @param raw - everything after the command name.
 * @returns the parsed request.
 * @throws {GateError} when a required part is missing or a value is invalid.
 */
export function parseGoalCommand(raw) {
    const { positional, flags, bare } = splitFlags(tokenize(raw));
    const reason = (flags.get('reason') ?? '').trim();
    if (reason.length === 0) {
        throw new GateError('REASON_REQUIRED', 'a tree change must state why; add --reason="...". The reason is written to the audit log ' +
            'and is what makes a later "why did the yardstick move" answerable.');
    }
    const confirmed = bare.has('force') || flags.has('force');
    const add = positional[0] === 'add';
    const target = add ? undefined : positional[0];
    if (!add && (target === undefined || target.length === 0)) {
        throw new GateError('INVALID_ARGS', 'name the goal to change, by id or exact title: ' +
            '/metacog-goal "目标标题" --status=done --reason="..."');
    }
    const fields = {};
    setString(fields, 'title', flags.get('title'));
    setString(fields, 'description', flags.get('description'));
    const status = flags.get('status');
    if (status !== undefined) {
        if (!GOAL_STATUSES.includes(status)) {
            throw new GateError('INVALID_ARGS', `--status must be one of ${GOAL_STATUSES.join(', ')}; got "${status}"`);
        }
        fields.status = status;
    }
    const priority = flags.get('priority');
    if (priority !== undefined) {
        const parsed = Number(priority);
        if (!Number.isInteger(parsed)) {
            throw new GateError('INVALID_ARGS', `--priority must be an integer; got "${priority}"`);
        }
        fields.priority = parsed;
    }
    for (const [flag, key] of [
        ['successCriteria', 'successCriteria'],
        ['evidence', 'evidence'],
        ['relevantActivities', 'relevantActivities'],
        ['allowedMethods', 'allowedMethods'],
        ['excludedActivities', 'excludedActivities'],
    ]) {
        const parsed = listValue(flags.get(flag));
        if (parsed !== undefined)
            fields[key] = parsed;
    }
    const policy = flags.get('explorationPolicy');
    if (policy !== undefined) {
        if (!EXPLORATION_POLICIES.includes(policy)) {
            throw new GateError('INVALID_ARGS', `--explorationPolicy must be one of ${EXPLORATION_POLICIES.join(', ')}; got "${policy}"`);
        }
        fields.explorationPolicy = policy;
    }
    // Dates accept `YYYY-MM-DD` as well as a full ISO timestamp: a user typing a
    // deadline writes a date, not a time with milliseconds and a zone.
    const deadline = flags.get('deadline');
    if (deadline !== undefined) {
        const iso = normalizeDate(deadline);
        if (iso === undefined) {
            throw new GateError('INVALID_ARGS', `--deadline must be YYYY-MM-DD or an ISO timestamp; got "${deadline}"`);
        }
        fields.deadline = iso;
    }
    const startedAt = flags.get('startedAt');
    if (startedAt !== undefined) {
        const iso = normalizeDate(startedAt);
        if (iso === undefined) {
            throw new GateError('INVALID_ARGS', `--startedAt must be YYYY-MM-DD or an ISO timestamp; got "${startedAt}"`);
        }
        fields.startedAt = iso;
    }
    if (add) {
        const depth = flags.get('depth');
        const parentId = flags.get('parent');
        if (flags.get('title') === undefined) {
            throw new GateError('INVALID_ARGS', 'adding a goal needs --title="..."');
        }
        if (depth === undefined || !Number.isInteger(Number(depth))) {
            throw new GateError('INVALID_ARGS', 'adding a goal needs --depth=<integer>');
        }
        if (parentId === undefined) {
            throw new GateError('INVALID_ARGS', 'adding a goal needs --parent=<id or title>');
        }
        fields.depth = Number(depth);
        fields.parent = parentId;
    }
    else if (Object.keys(fields).length === 0) {
        throw new GateError('INVALID_ARGS', 'nothing to change: pass at least one field flag.');
    }
    return {
        action: add ? 'add' : 'set',
        ...(target === undefined ? {} : { target }),
        fields,
        reason,
        confirmed,
    };
}
/**
 * Parse one `/metacog-contradiction` line.
 *
 * @param raw - everything after the command name.
 * @returns the parsed request.
 * @throws {GateError} when a required part is missing or a value is invalid.
 */
export function parseContradictionCommand(raw) {
    const { positional, flags, bare } = splitFlags(tokenize(raw));
    const reason = (flags.get('reason') ?? '').trim();
    if (reason.length === 0) {
        throw new GateError('REASON_REQUIRED', 'a contradiction change must state why; add --reason="...".');
    }
    const confirmed = bare.has('force') || flags.has('force');
    const target = positional[0];
    if (target === undefined || target.length === 0) {
        throw new GateError('INVALID_ARGS', 'name the contradiction to change, by id or exact title: ' +
            '/metacog-contradiction "张力标题" --intensity=4 --reason="..."');
    }
    const fields = {};
    for (const key of ['title', 'description', 'poleA', 'poleB', 'rationale', 'resolutionHint']) {
        setString(fields, key, flags.get(key));
    }
    const type = flags.get('type');
    if (type !== undefined) {
        if (!CONTRADICTION_TYPES.includes(type)) {
            throw new GateError('INVALID_ARGS', `--type must be one of ${CONTRADICTION_TYPES.join(', ')}; got "${type}"`);
        }
        fields.type = type;
    }
    const intensity = flags.get('intensity');
    if (intensity !== undefined) {
        const parsed = Number(intensity);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 5) {
            throw new GateError('INVALID_ARGS', `--intensity must be an integer 0-5; got "${intensity}"`);
        }
        fields.intensity = parsed;
    }
    const evidence = listValue(flags.get('evidence'));
    if (evidence !== undefined)
        fields.evidence = evidence;
    if (Object.keys(fields).length === 0) {
        throw new GateError('INVALID_ARGS', 'nothing to change: pass at least one field flag.');
    }
    return { action: 'set', target, fields, reason, confirmed };
}
/**
 * Format one successful edit for the user.
 *
 * @param outcome - what the governed write changed.
 * @returns a compact multi-line summary; the version and audit id are always
 *   shown because they are how a later question about this change is answered.
 */
export function describeOutcome(outcome) {
    const lines = [`已更新，版本 → ${outcome.version}`];
    if (outcome.auditAction !== undefined)
        lines.push(`动作: ${outcome.auditAction}`);
    if (outcome.changed.length > 0)
        lines.push(`改动: ${outcome.changed.join(', ')}`);
    if (outcome.added !== undefined && outcome.added.length > 0) {
        lines.push(`新增: ${outcome.added.join(', ')}`);
    }
    if (outcome.removed !== undefined && outcome.removed.length > 0) {
        lines.push(`删除: ${outcome.removed.join(', ')}`);
    }
    lines.push(`审计: ${outcome.auditEntryId}`);
    return lines.join('\n');
}
/** Usage text for `/metacog-goal`, shown when the line cannot be parsed. */
export const GOAL_USAGE = [
    '用法：',
    '  /metacog-goal <id 或标题> --status=done --reason="..."',
    '  /metacog-goal <id 或标题> --title="新标题" --description="..." --reason="..."',
    '  /metacog-goal <id 或标题> --successCriteria="甲,乙" --relevantActivities="丙" --reason="..."',
    '  /metacog-goal <id 或标题> --deadline=2026-11-30 --reason="定截止"',
    '  /metacog-goal add --parent=<id 或标题> --depth=2 --title="新目标" --reason="..."',
    '',
    '可改字段：title / description / status / priority / successCriteria / evidence /',
    '         relevantActivities / allowedMethods / excludedActivities / explorationPolicy /',
    '         deadline / startedAt',
    '日期可写 2026-11-30 或完整 ISO 时间。设了 deadline 才会有 1/4、1/2、3/4 的分档提醒。',
    '改 L0 或 core 需要加 --force 表示你本人确认。',
].join('\n');
/** Usage text for `/metacog-contradiction`. */
export const CONTRADICTION_USAGE = [
    '用法：',
    '  /metacog-contradiction <id 或标题> --intensity=4 --reason="..."',
    '  /metacog-contradiction <id 或标题> --title="新标题" --type=main --reason="..."',
    '',
    '可改字段：title / description / poleA / poleB / type / intensity /',
    '         rationale / resolutionHint / evidence',
    '改 core 矛盾需要加 --force 表示你本人确认。',
].join('\n');
