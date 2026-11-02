import { bindPaths, normalizePath } from './paths.js';
/**
 * Normalize text for matching: lowercase, collapse whitespace, strip ASCII
 * punctuation that never carries meaning across languages.
 *
 * @param value - raw text.
 * @returns normalized text.
 */
function normalize(value) {
    return value
        .toLowerCase()
        .replace(/[\s\u3000]+/g, ' ')
        .replace(/[.,;:!?'"`()[\]{}<>/\\|]/g, ' ')
        .replace(/ {2,}/g, ' ')
        .trim();
}
/**
 * Substring match with a short-token guard.
 *
 * A one- or two-character pattern matches almost anything in Chinese text, so
 * short patterns require an exact token match instead of a substring hit.
 *
 * @param haystack - normalized text to search.
 * @param needle - normalized pattern.
 */
function matches(haystack, needle) {
    if (needle.length === 0)
        return false;
    if (needle.length <= 2) {
        return haystack.split(' ').includes(needle) || haystack === needle;
    }
    return haystack.includes(needle);
}
/**
 * Find the whitelist entry covering an activity.
 *
 * @param input - the activity.
 * @param entries - configured whitelist.
 * @returns the matching entry, if any.
 */
export function matchWhitelist(input, entries) {
    const summary = normalize(input.summary);
    return entries.find((entry) => {
        if (input.toolName !== undefined && entry.toolNames.includes(input.toolName))
            return true;
        return entry.summaryContains.some((pattern) => matches(summary, normalize(pattern)));
    });
}
/** Goals that may legitimately claim an activity: user-confirmed and live. */
function monitorableGoals(goals) {
    return goals.filter((goal) => goal.confirmedByUser &&
        goal.status !== 'done' &&
        goal.status !== 'deprecated' &&
        goal.status !== 'draft');
}
/**
 * Look for an alignment rule covering the activity.
 *
 * Path ownership is checked first, and against every goal at once. A prefix
 * claim is a statement about the tree rather than a phrase, so it must not lose
 * to whichever keyword happens to match earlier in goal order.
 *
 * @param activity - normalized activity text.
 * @param goals - candidate goals, in priority order.
 * @param binding - path placement, when the activity touched file paths.
 * @returns the first hit, if any.
 */
function findAlignmentHit(activity, goals, binding) {
    if (binding !== undefined && binding.kind === 'bound') {
        const goal = goals.find((candidate) => binding.goalIds.includes(candidate.id));
        if (goal !== undefined)
            return { goal, kind: 'path', goalIds: [...binding.goalIds] };
    }
    for (const goal of goals) {
        for (const pattern of goal.alignment.excludedActivities) {
            if (matches(activity, normalize(pattern)))
                return { goal, kind: 'excluded' };
        }
        for (const pattern of goal.alignment.relevantActivities) {
            if (matches(activity, normalize(pattern)))
                return { goal, kind: 'relevant' };
        }
        for (const pattern of goal.alignment.allowedMethods) {
            if (matches(activity, normalize(pattern)))
                return { goal, kind: 'method' };
        }
    }
    return undefined;
}
/**
 * Goals whose text or criteria plausibly relate to the activity.
 *
 * This is a weak, cheap signal used to fill `candidateGoalIds` and to raise
 * confidence when an alignment rule also matched. It never decides a verdict on
 * its own.
 *
 * @param activity - normalized activity text.
 * @param goals - candidate goals.
 * @returns matching goal ids.
 */
function relatedGoalIds(activity, goals) {
    const ids = [];
    for (const goal of goals) {
        const needles = [goal.title, ...goal.successCriteria]
            .map(normalize)
            .filter((value) => value.length >= 3);
        if (needles.some((needle) => matches(activity, needle)))
            ids.push(goal.id);
    }
    return ids;
}
/**
 * Order goals so more structurally important ones win ties.
 *
 * @param goals - goals to order.
 * @returns a new array, shallowest first, then by descending priority.
 */
function byImportance(goals) {
    return goals
        .slice()
        .sort((left, right) => left.depth - right.depth || right.priority - left.priority);
}
/**
 * Judge one activity against the confirmed goal tree.
 *
 * @param input - the activity.
 * @param goals - full goal list; unconfirmed and terminal goals are ignored.
 * @param config - resolved plugin configuration.
 * @returns the verdict, with confidence already capped by grade.
 */
export function judgeAlignment(input, goals, config) {
    const gradeCap = gradeConfidenceCap(input.grade, config);
    const minConfidence = config.thresholds.minConfidence;
    // Rule 1: Grade C carries no activity evidence. The spec allows only the
    // static staleness check at that grade, so an activity verdict is impossible.
    if (input.grade === 'C') {
        return {
            decision: 'uncertain',
            candidateGoalIds: [],
            confidence: 0,
            hint: '这次操作没有可验证的记录，暂时无法判断方向；用 check_drift 补一条带证据的活动。',
            rationale: 'observation grade C: no reliable activity context is available, so no alignment ' +
                'judgement can be made. Only static goal-staleness checks apply.',
        };
    }
    const active = byImportance(monitorableGoals(goals));
    const activity = normalize(`${input.summary} ${input.evidence.join(' ')}`);
    // Path placement is computed once and read twice: as positive attribution
    // (rule 3) and to tell "no goal claims this" apart from "nothing matched" in
    // the fallback (rule 6). Entries that normalize to nothing are dropped first,
    // so junk input cannot manufacture an unbound verdict where the judgement
    // without paths would have applied.
    //
    // The gate matters as much as the binding: a tree where no monitorable goal
    // declares a path has no path model at all, and there "no goal claims this
    // file" means "the feature is unused", not "this work belongs nowhere". Such a
    // tree keeps the judgement it had before path ownership existed.
    const pathModelInUse = active.some((goal) => goal.paths.some((owned) => normalizePath(owned).length > 0));
    const touchedPaths = pathModelInUse
        ? (input.paths ?? []).filter((path) => normalizePath(path).length > 0)
        : [];
    const binding = touchedPaths.length === 0 ? undefined : bindPaths(touchedPaths, active);
    if (active.length === 0) {
        return {
            decision: 'uncertain',
            candidateGoalIds: [],
            confidence: 0,
            hint: '还没有已确认的目标，无法判断这次操作的方向；先运行 goal_tree_confirm 确认目标树。',
            rationale: 'no user-confirmed active goal exists yet, so there is nothing to align against; ' +
                'confirm the goal tree before drift can be judged.',
        };
    }
    // Rule 2: the global whitelist. A user-registered activity is a decision made
    // in advance, so it is aligned by definition and never escalates.
    const whitelisted = matchWhitelist(input, config.whitelistedActivities);
    if (whitelisted !== undefined) {
        return {
            decision: 'aligned',
            candidateGoalIds: relatedGoalIds(activity, active),
            confidence: 1,
            hint: `这条活动属于白名单「${whitelisted.label}」，记为在范围内，不会升级。`,
            rationale: `activity matches the global whitelist entry "${whitelisted.label}"; recorded at Level 0 and never escalated.`,
            whitelistLabel: whitelisted.label,
        };
    }
    // Rule 3: path ownership. A goal that declared a prefix has already decided
    // that work under it serves the goal, so touching a file there is positive
    // attribution — the strongest evidence available short of the whitelist, and
    // the only rule that answers "which goal" without reading prose. A path no
    // goal claims never reaches this branch: absence of a claim is not evidence of
    // departure, and rule 6 handles it as `unbound` instead.
    const hit = findAlignmentHit(activity, active, binding);
    if (hit !== undefined && hit.kind === 'path') {
        const related = relatedGoalIds(activity, active);
        const candidateGoalIds = [...hit.goalIds, ...related.filter((id) => !hit.goalIds.includes(id))];
        const shared = hit.goalIds.length > 1
            ? ` (also claimed by ${hit.goalIds.length - 1} other goal(s), all kept as candidates)`
            : '';
        return {
            decision: 'aligned',
            candidateGoalIds,
            confidence: Math.min(gradeCap, 0.95),
            hint: `这次改动的文件属于目标「${hit.goal.title}」声明的范围，记为在推进该目标。`,
            rationale: `the activity touched ${binding?.bindings.length ?? 0} path(s) under a prefix goal ` +
                `"${hit.goal.title}" declares as its own${shared}; a declared path prefix is positive ` +
                `attribution, so the work is placed on the confirmed tree at Level 0 and never escalated.`,
            matchedGoalId: hit.goal.id,
            pathBinding: binding,
        };
    }
    // Rule 4: an explicit exclusion is the one place `scope_drift` is cheap. It
    // still requires Grade A: at Grade B the activity description is an inference,
    // and punishing an inference as over-engineering is exactly the false positive
    // the grade cap exists to prevent.
    if (hit !== undefined && hit.kind === 'excluded') {
        if (input.grade !== 'A') {
            return {
                decision: 'uncertain',
                candidateGoalIds: [hit.goal.id],
                confidence: Math.min(gradeCap, 0.4),
                hint: `活动可能落在目标「${hit.goal.title}」的排除项里，但证据不够强，先记为待定。`,
                rationale: `the activity may fall under excluded activities of goal "${hit.goal.title}", but ` +
                    `observation grade ${input.grade} is not strong enough to assert over-engineering.`,
                excludedByGoalId: hit.goal.id,
            };
        }
        return {
            decision: 'scope_drift',
            candidateGoalIds: [hit.goal.id],
            confidence: gradeCap,
            hint: `活动命中了目标「${hit.goal.title}」的排除项；若这是新需求，用 metacog_revise_plan 更新声明。`,
            rationale: `the activity matches an excluded activity of goal "${hit.goal.title}", which the user registered as out of scope.`,
            excludedByGoalId: hit.goal.id,
        };
    }
    // Rule 5: registered exploration covers planned reading, dependency work and
    // permitted methods. `explorationPolicy` decides how that is reported.
    if (hit !== undefined && (hit.kind === 'relevant' || hit.kind === 'method')) {
        const related = relatedGoalIds(activity, active);
        const candidateGoalIds = related.includes(hit.goal.id) ? related : [hit.goal.id, ...related];
        const policy = hit.goal.alignment.explorationPolicy;
        if (policy === 'allowed') {
            return {
                decision: 'exploratory',
                candidateGoalIds,
                confidence: Math.min(gradeCap, 0.9),
                hint: `目标「${hit.goal.title}」允许这类探索，记为在推进，不会升级。`,
                rationale: `goal "${hit.goal.title}" registers this as relevant activity or an allowed method with explorationPolicy "allowed"; treated as sanctioned exploration, not drift.`,
                matchedGoalId: hit.goal.id,
            };
        }
        if (policy === 'limited') {
            return {
                decision: 'exploratory',
                candidateGoalIds,
                confidence: Math.min(gradeCap, 0.75),
                hint: `目标「${hit.goal.title}」只允许有限探索，这次记为探索性工作。`,
                rationale: `goal "${hit.goal.title}" registers this as an allowed method but only tolerates limited exploration; recorded as exploratory at Level 0.`,
                matchedGoalId: hit.goal.id,
            };
        }
        // approval_required: the activity is legitimate only if the user approved it.
        return {
            decision: 'uncertain',
            candidateGoalIds,
            confidence: Math.min(gradeCap, 0.5),
            hint: `目标「${hit.goal.title}」要求先批准这类探索；补一条批准记录，或把判据写清楚。`,
            rationale: `goal "${hit.goal.title}" requires explicit approval before this kind of exploration; without a recorded approval the judgement stays uncertain.`,
            matchedGoalId: hit.goal.id,
        };
    }
    // Rule 6: no rule matched. An activity whose touched paths no goal claims is
    // `unbound`, not drift. "I cannot place this" is a different claim from "this
    // is off-target", and reporting the first as the second is the false positive
    // this verdict exists to prevent. It is not a weak drift signal either: it is
    // not a drift signal at all, so nothing downstream may escalate on it.
    if (binding !== undefined && binding.kind === 'unbound') {
        const shown = binding.unboundPaths.slice(0, 3).join(', ');
        return {
            decision: 'unbound',
            candidateGoalIds: [],
            confidence: 0,
            hint: `改动的文件不属于任何目标（${binding.unboundPaths.slice(0, 3).join(', ')}）；若这是新方向，用 goal_tree_edit 把路径挂到目标上。`,
            rationale: `none of the ${binding.bindings.length} path(s) this activity touched is claimed by a ` +
                `confirmed active goal (${shown}${binding.unboundPaths.length > 3 ? ', …' : ''}); ` +
                `recorded as unbound — no goal claims this work, which is not a drift verdict and never escalates.`,
            pathBinding: binding,
        };
    }
    // Everything weaker than Grade A degrades to `uncertain` (spec 4.2 step 4).
    if (input.grade !== 'A') {
        return {
            decision: 'uncertain',
            candidateGoalIds: [],
            confidence: Math.min(gradeCap, 0.3),
            hint: '证据强度不够（B 级），先记为待定；补充文件或提交证据后再判断。',
            rationale: `no alignment rule matched, but observation grade ${input.grade} is too weak to assert drift (spec 4.2 step 4).`,
        };
    }
    if (gradeCap < minConfidence) {
        return {
            decision: 'uncertain',
            candidateGoalIds: [],
            confidence: gradeCap,
            hint: '没有匹配到任何目标的判据，把握不足，先记为待定；检查判据是否覆盖这类工作。',
            rationale: `no alignment rule matched and confidence ${gradeCap.toFixed(2)} is below the configured floor ${minConfidence}; reported as uncertain rather than drift.`,
        };
    }
    const titles = active
        .slice(0, 3)
        .map((goal) => `depth-${goal.depth} "${goal.title}"`)
        .join(', ');
    return {
        decision: 'scope_drift',
        candidateGoalIds: [],
        confidence: gradeCap,
        hint: '这次活动没有匹配任何目标的判据；若它属于当前工作，用 metacog_revise_plan 补进声明。',
        rationale: `grade A activity does not match any confirmed active goal's success criteria, ` +
            `alignment rules or allowed methods (checked: ${titles}${active.length > 3 ? ', …' : ''}), ` +
            `and is not whitelisted.`,
    };
}
/**
 * Confidence ceiling implied by an observation grade.
 *
 * @param grade - A, B or C.
 * @param config - configuration carrying the Grade B cap.
 * @returns the ceiling in 0–1.
 */
export function gradeConfidenceCap(grade, config) {
    if (grade === 'A')
        return 1;
    if (grade === 'B')
        return config.observationPolicy.gradeBMaxConfidence;
    return 0;
}
/**
 * Whether a verdict may feed the escalation counters.
 *
 * Grade B findings are advisory: they may be recorded and shown, but they must
 * never open a Level 2 or Level 3 intervention.
 *
 * @param grade - the grade the activity was observed at.
 * @param config - configuration carrying the observation policy.
 */
export function mayEscalate(grade, _config) {
    // Spec 4.1 makes the Grade B restriction unconditional: "不得直接触发 Level
    // 2/3 告警". There is deliberately no configuration escape hatch here, because
    // a threshold that lets sampled evidence open a blocking card would defeat
    // the grade system the rest of the analyser is built on.
    return grade === 'A';
}
