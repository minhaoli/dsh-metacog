/**
 * Storage-free views over a goal array: which leaves are executable, and how a
 * completed subtree folds for display.
 *
 * The two questions share a home because both are pure projections of the same
 * array — neither reads the store, neither writes one, and both are needed by
 * more than one caller. Keeping them here rather than inside a tool means the
 * report and both write paths compute the same answer from the same code.
 *
 * The fold defaults to **off**. Initialisation and the first look at a tree must
 * show every goal: a monitor whose completed branches have already vanished is
 * one whose state the user cannot check, and "already folded" is indistinguishable
 * from "never existed". Only a caller that explicitly asks for a fold gets one.
 *
 * @module dsh-metacog/analysis/collapse
 */
/** Ids of every node below `id`, in input order. Cycle-safe. */
function descendantsOf(id, childrenOf, goals) {
    const seen = new Set([id]);
    const queue = [...(childrenOf.get(id) ?? [])];
    const collected = [];
    while (queue.length > 0) {
        const node = queue.shift();
        if (seen.has(node.id))
            continue;
        seen.add(node.id);
        collected.push(node);
        queue.push(...(childrenOf.get(node.id) ?? []));
    }
    // Input order keeps the projection stable regardless of how the queue walked.
    const order = new Map(goals.map((goal, index) => [goal.id, index]));
    return collected.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
}
/**
 * Group a goal array for display, optionally folding completed subtrees.
 *
 * A group folds when every node **below** its parent is done. The stricter
 * "whole subtree" reading is deliberate: folding on direct children alone would
 * hide an active grandchild under a parent that happens to have only finished
 * children, and a hidden active goal is worse than a long list.
 *
 * @param goals - the tree, as any order; a node whose parent is absent is
 *   treated as a root rather than dropped.
 * @param options - see {@link CollapseOptions}.
 */
export function collapseCompleted(goals, options = {}) {
    const childrenOf = new Map();
    const present = new Set(goals.map((goal) => goal.id));
    for (const goal of goals) {
        if (goal.parentId === null || goal.parentId === undefined)
            continue;
        if (!present.has(goal.parentId))
            continue;
        const siblings = childrenOf.get(goal.parentId);
        if (siblings === undefined)
            childrenOf.set(goal.parentId, [goal]);
        else
            siblings.push(goal);
    }
    const groups = [];
    const collapsedGroups = new Map();
    for (const goal of goals) {
        const children = childrenOf.get(goal.id) ?? [];
        if (children.length === 0)
            continue;
        const descendants = descendantsOf(goal.id, childrenOf, goals);
        const allDone = descendants.every((node) => node.status === 'done');
        const collapsed = allDone && options.collapseDone === true;
        const group = {
            id: goal.id,
            parent: goal,
            children,
            allDone,
            collapsed,
            descendants,
            summary: collapsed ? `已完成（${descendants.length} 个子目标）` : '',
        };
        groups.push(group);
        if (collapsed)
            collapsedGroups.set(goal.id, group);
    }
    const foldedIds = new Set();
    for (const group of collapsedGroups.values()) {
        for (const node of group.descendants)
            foldedIds.add(node.id);
    }
    return {
        groups,
        visible: goals.filter((goal) => !foldedIds.has(goal.id)),
        folded: goals.filter((goal) => foldedIds.has(goal.id)),
        anyCollapsed: collapsedGroups.size > 0,
    };
}
/**
 * Completion phrases that assert no checkable outcome.
 *
 * A leaf is the most concrete level of the tree, so its `successCriteria` is the
 * only place "how is this done?" can be answered. "完成" answers it with the
 * question itself. The list is exact-match after normalisation, never a
 * substring test — "完成登录页并跑通 e2e" must pass, only the bare "完成" fails.
 *
 * Chinese and English entries sit together because a tree may mix them; adding
 * a phrase here is the whole mechanism, so a later reader can tune the rule
 * without touching the gate.
 */
export const GENERIC_CRITERIA = [
    // Chinese: pure platitudes.
    '完成', '完成了', '完成它', '完成目标', '完成工作', '完成任务', '完成既定目标',
    '做完', '做完了', '做完它', '做好', '做好了', '做好它', '做好工作', '做好这件事',
    '搞定', '搞定了', '推进', '推进了', '推进一下', '推进工作', '向前推进', '继续推进',
    '按计划推进', '按计划完成', '如期完成', '按时完成',
    '落实', '落实到位', '到位', '执行', '执行完', '继续', '跟进', '跟进一下',
    '达成', '达成了', '实现', '实现了', '交付', '交付了', '上线', '上线了',
    '改进', '改进一下', '优化', '优化一下', '完善', '完善一下', '提升', '提升一下',
    '处理', '处理一下', '解决', '解决了', '结束', '结束了', '收尾',
    '看看', '注意一下', '尽量', '尽力', '争取', '尽快', '待定', '视情况', '看情况',
    '好', '行', '可', '了',
    // English: the same failure in another language.
    'done', 'finish', 'finished', 'complete', 'completed', 'end', 'closed',
    'ok', 'okay', 'tbd', 'todo', 'tba', 'n/a', 'na', 'improve', 'improved',
    'progress', 'inprogress', 'works', 'working', 'good', 'success', 'successful',
];
/**
 * Strip what never carries meaning in a criterion: case, whitespace, punctuation
 * and symbols. "完成。" and "完成" are the same claim, in both senses.
 */
function normaliseCriterion(text) {
    return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}
const GENERIC_NORMALISED = new Set(GENERIC_CRITERIA.map((phrase) => normaliseCriterion(phrase)));
/**
 * Whether a criterion is a bare platitude.
 *
 * An entry that is empty after normalisation is **not** generic — it is blank,
 * and `inspectLeafActionability` reports the two separately because "you wrote
 * nothing" and "you wrote '完成'" need different fixes.
 */
export function isGenericCriterion(criterion) {
    const normalised = normaliseCriterion(criterion);
    if (normalised.length === 0)
        return false;
    return GENERIC_NORMALISED.has(normalised);
}
/**
 * Words that name no object on their own.
 *
 * Narrower than {@link GENERIC_CRITERIA}, and separate from it on purpose. That
 * list answers "is this phrase a platitude"; these are the nouns and particles
 * that let a platitude fill a whole sentence — "推进项目" is not in the list, but
 * it is the same empty claim with a placeholder attached. Merging them would
 * change what `isGenericCriterion` means for a leaf's success criteria, which is
 * a different question.
 */
const GOAL_FILLER_WORDS = [
    '项目', '工作', '任务', '事情', '东西', '目标', '内容', '方面', '部分', '相关',
    '一下', '一些', '一点', '继续', '接着', '然后', '今天', '今日', '当前', '现在',
    '本次', '这次', '这个', '那个', '我们', '咱们', '进行', '开展', '起来', '等等',
    '的', '地', '得', '了', '着', '并', '和', '与', '把', '将', '对', '再', '又',
];
/** Nouns that name something a session can hand over and someone else can check. */
const DELIVERABLE_NOUNS = [
    '报告', '文档', '测试', '用例', '断言', '代码', '脚本', '清单', '列表', '结论',
    '实验', '表格', '图表', '数据', '树', '节点', '卡片', '信号', '规则', '配置',
    '快照', '归档', '迁移', '接口', '端点', '模块', '函数', '方法', '路由', '页面',
    '组件', '索引', '目录', '文件', '条目', '计划', '方案', '流程', '提示', '模板',
    '字段', '枚举', '类型', '构建', '部署', '版本', '日志', '异常', '缺陷', '基准',
    '样本', '步骤', '子任务', 'README', 'readme',
];
/** A path with at least one separator, or a file with a code-ish extension. */
const PATH_LIKE = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+|\b[A-Za-z0-9_-]+\.(?:ts|tsx|js|mjs|cjs|jsx|json|md|yml|yaml|py|go|rs|java|c|cpp|css|html|txt|toml|ini)\b/;
/** Tools whose name in the goal makes it checkable by a call trace. */
const TOOL_LIKE = /\b(?:edit|write|read|glob|grep|pwsh|bash|shell|web_search|web_fetch|subagent|spawn_teammate|metacog_[a-z_]+|goal_tree_[a-z_]+|check_drift|contradiction_observe)\b/i;
/** Something a reader could check afterwards without asking a follow-up question. */
const MEASURABLE_LIKE = /\d|%|通过|失败|版本|第\s*\d+\s*(?:条|个|步|项)/;
/** A term the author deliberately quoted, which is a name for something. */
const QUOTED_TERM = /「[^」]+」|“[^”]+”|"[^"]+"|'[^']+'/;
/**
 * Whether the text names an identifier rather than an ordinary word.
 *
 * This is the signal that lets "把 S4 的窗口切分改成贪心" through: `S4` is a
 * thing a reviewer can point at, while the sentence around it is prose. The
 * distinction from a dictionary word matters — accepting any Latin run would let
 * "improve things" pass, which is precisely the vague goal this check exists to
 * refuse.
 *
 * A token counts when it carries a digit (`S4`, `F5`), a separator (`api.ts`,
 * `declare_plan`), or an internal capital (`coverageFloor`). A bare lowercase or
 * capitalised word does not.
 */
function hasIdentifier(text) {
    for (const token of text.match(/[A-Za-z][A-Za-z0-9_.-]*/g) ?? []) {
        if (token.length < 2)
            continue;
        if (/[0-9]/.test(token))
            return true;
        if (/[_.-]/.test(token))
            return true;
        if (/[a-z][A-Z]/.test(token))
            return true;
    }
    return false;
}
/**
 * Strip a sentence down to nothing by matching known empty phrases.
 *
 * Longest match first, so "完成目标" is consumed as the one phrase it is rather
 * than as "完成" plus a stray noun. Greedy prefix matching can fail where a
 * shorter choice would have led to full consumption, which errs toward calling a
 * sentence concrete — the safe direction: refusing real work is worse than
 * accepting one vague goal.
 */
function consumesEntirely(text, vocabulary) {
    const sorted = [...vocabulary].sort((a, b) => b.length - a.length);
    let rest = text;
    let guard = 0;
    while (rest.length > 0 && guard < 200) {
        guard += 1;
        const hit = sorted.find((word) => word.length > 0 && rest.startsWith(word));
        if (hit === undefined)
            return false;
        rest = rest.slice(hit.length);
    }
    return rest.length === 0;
}
/** Han characters only, so a long English word does not count as a long goal. */
function hanLength(text) {
    return [...text].filter((char) => /\p{Script=Han}/u.test(char)).length;
}
/**
 * Whether a stated session goal names something that can be checked.
 *
 * The contract, because more than one caller needs it — `declare_plan` and
 * `revise_plan` gate on it today, and "what are you doing today?" will ask the
 * same question of a human answer:
 *
 * - **Input**: one sentence, already trimmed by the caller. No context is
 *   assumed; this is a pure function of the string.
 * - **Output**: `concrete: true` when the goal names a path or file, a tool, a
 *   deliverable noun, a measurable result, an identifier (`S4`, `api.ts`,
 *   `coverageFloor`) or a quoted term. Otherwise `concrete: false` with a
 *   `reason` saying which test failed and a `suggestion` giving a rewrite shape.
 * - **Not concrete** means "this sentence cannot be compared with what the
 *   session actually did", never "this goal is unimportant". A vague goal makes
 *   S4 and the model review compare against nothing.
 *
 * Deliberately conservative: any one concrete signal is enough. A goal that
 * passes may still be a poor goal — judging quality needs context this function
 * does not have — but a goal that fails cannot be judged at all.
 *
 * @param goal - the sentence to assess.
 * @returns the verdict, with a reason and suggestion when it is not concrete.
 */
export function assessGoalConcreteness(goal) {
    const text = goal.trim();
    if (text.length === 0) {
        return {
            concrete: false,
            reason: 'goal 是空的，没有说明要做什么',
            suggestion: '写成「动词 + 具体对象 + 可验证结果」，例如「给 src/api.ts 加 /models 端点的测试」。',
        };
    }
    // 1. Nothing but platitudes and placeholders: "推进项目", "继续优化".
    if (consumesEntirely(normaliseCriterion(text), [...GENERIC_CRITERIA, ...GOAL_FILLER_WORDS])) {
        return {
            concrete: false,
            reason: `「${text}」整句由泛词组成（推进/完成/优化一类），没有说清具体做什么`,
            suggestion: '写成「动词 + 具体对象 + 可验证结果」，例如「给 src/api.ts 加 /models 端点的测试」。',
        };
    }
    // 2. Any single concrete signal is enough to pass.
    if (PATH_LIKE.test(text) ||
        TOOL_LIKE.test(text) ||
        DELIVERABLE_NOUNS.some((noun) => text.includes(noun)) ||
        MEASURABLE_LIKE.test(text) ||
        hasIdentifier(text) ||
        QUOTED_TERM.test(text)) {
        return { concrete: true };
    }
    // 3. Nothing checkable, and too short to be hiding one.
    const suggestion = '写出具体的对象或结果，例如「给 src/api.ts 加 /models 端点的测试」。';
    const length = hanLength(text);
    if (length < 8) {
        return {
            concrete: false,
            reason: `「${text}」只有 ${length} 个字，且没有指出具体对象`,
            suggestion,
        };
    }
    // 4. Long enough, still nothing to check.
    return {
        concrete: false,
        reason: `「${text}」没有可验证的对象：既没有路径或文件名，也没有工具名、交付物名词或可测量的结果`,
        suggestion,
    };
}
/**
 * Check that every leaf states at least one checkable completion condition.
 *
 * A leaf with no `successCriteria`, only whitespace entries, or nothing but
 * platitudes can never be judged done from the outside — so it is either a goal
 * that should have children, or an unfinished one. Both are worth refusing at
 * the write path, where the user can still fix it.
 *
 * @param goals - the whole tree, in any order.
 */
export function inspectLeafActionability(goals) {
    const parentIds = new Set();
    for (const goal of goals) {
        if (goal.parentId !== null && goal.parentId !== undefined)
            parentIds.add(goal.parentId);
    }
    const issues = [];
    let leaves = 0;
    for (const goal of goals) {
        if (parentIds.has(goal.id))
            continue;
        leaves += 1;
        const submitted = goal.successCriteria ?? [];
        const present = submitted.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
        if (submitted.length === 0) {
            issues.push({ goalId: goal.id, title: goal.title, reason: 'missing', dismissed: [] });
            continue;
        }
        if (present.length === 0) {
            issues.push({ goalId: goal.id, title: goal.title, reason: 'blank', dismissed: [] });
            continue;
        }
        if (present.every((entry) => isGenericCriterion(entry))) {
            issues.push({ goalId: goal.id, title: goal.title, reason: 'generic', dismissed: present });
        }
    }
    return { leaves, issues };
}
const REASON_LABELS = {
    missing: 'no successCriteria at all',
    blank: 'only blank entries',
    generic: 'only generic phrases',
};
/**
 * One refusal message naming every offending leaf and why.
 *
 * All of them, not the first: a caller repairing a tree should need one pass,
 * not one call per node.
 */
export function describeLeafActionability(report) {
    const byReason = new Map([
        ['missing', []],
        ['blank', []],
        ['generic', []],
    ]);
    for (const issue of report.issues)
        byReason.get(issue.reason)?.push(issue);
    const parts = [
        `${report.issues.length} of ${report.leaves} leaf goals are not executable. A leaf has no ` +
            'children, so its successCriteria is the only place "how is this done?" can be answered; ' +
            'a leaf without one can never be judged done from the outside.',
    ];
    for (const reason of ['missing', 'blank', 'generic']) {
        const rows = byReason.get(reason) ?? [];
        if (rows.length === 0)
            continue;
        const named = rows.map((issue) => issue.dismissed.length === 0
            ? `"${issue.title}"`
            : `"${issue.title}" (${issue.dismissed.join(', ')})`);
        parts.push(`${REASON_LABELS[reason]}: ${named.join('; ')}.`);
    }
    parts.push('Name the artifact, the check or the observable outcome instead — "README documents 安装/卸载" ' +
        'or "npm test exits 0" — or give the goal children so the concrete work is one level down. ' +
        'Pass allowNonActionableLeaves: true with a reason only to park a placeholder on purpose.');
    return parts.join('\n');
}
/** Stable payload for the gate error, so both callers report the same shape. */
export function leafActionabilityDetails(report) {
    const reasons = { missing: [], blank: [], generic: [] };
    for (const issue of report.issues) {
        reasons[issue.reason].push(issue.title);
    }
    return {
        goals: report.issues.map((issue) => ({
            id: issue.goalId,
            title: issue.title,
            reason: issue.reason,
        })),
        reasons,
    };
}
