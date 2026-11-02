/**
 * Collect what finished inside a period.
 *
 * @param state - current tree state.
 * @param start - period start.
 * @param end - period end.
 * @returns achievements, newest first.
 */
export function collectAchievements(state, start, end) {
    const out = [];
    const within = (iso) => {
        if (iso === undefined)
            return false;
        const t = Date.parse(iso);
        return !Number.isNaN(t) && t >= start.getTime() && t <= end.getTime();
    };
    for (const goal of state.goals) {
        if (goal.status === 'done' && within(goal.doneAt)) {
            out.push({ kind: 'goal', id: goal.id, title: goal.title, at: goal.doneAt, depth: goal.depth });
        }
    }
    for (const node of state.contradictions) {
        if (within(node.resolvedAt)) {
            out.push({
                kind: 'contradiction',
                id: node.id,
                title: node.title,
                at: node.resolvedAt,
                intensityBefore: node.intensity,
            });
        }
    }
    return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
/**
 * Compute `U(g,t)`: how pressing a goal is.
 *
 * Higher means more pressing, and the measure is the time actually left, not the
 * fraction of the original span. An earlier version used the fraction and it was
 * wrong in a way that inverted the ordering: with both goals created 30 days ago,
 * one due in 2 days scored 0.063 and one due in 30 days scored 0.500 — because
 * the 2-day goal's remaining slice of a 62-day span is tiny. A 2-day deadline is
 * more pressing than a 30-day one; anything that says otherwise is a bug, no
 * matter how defensible the formula looks.
 *
 * So: remaining days, mapped through a hyperbola so it stays in a bounded range
 * while preserving order. `1/(1 + days/7)` gives 1.0 today, 0.5 in a week, 0.19
 * in a month, and never reaches zero.
 *
 * An overdue goal is pinned above every future one at 2.0 — an overdue goal is the
 * most urgent thing on the tree, not the least.
 *
 * A goal with no deadline gets a small constant above zero. It is not zero: an
 * undated goal still matters, and returning 0 would sort it below every dated
 * goal regardless of what the user said.
 *
 * @param goal - the goal.
 * @param now - reference time.
 * @returns a comparable number; larger is more pressing.
 */
export function urgencyOf(goal, now) {
    const priorityBoost = (goal.priority ?? 0) * 0.1;
    if (goal.deadline === undefined)
        return 0.02 + priorityBoost;
    const deadline = Date.parse(goal.deadline);
    if (Number.isNaN(deadline))
        return 0.02 + priorityBoost;
    const daysLeft = (deadline - now.getTime()) / 86_400_000;
    if (daysLeft < 0)
        return 2 + priorityBoost;
    return 1 / (1 + daysLeft / 7) + priorityBoost;
}
/**
 * Find goals that are absorbing effort while a more pressing one waits.
 *
 * The definition is deliberately conjunctive. High share alone is not a trap —
 * focused work on the most important goal looks exactly like that. It becomes a
 * trap when the effort goes to something deep, unimportant by urgency, and a
 * more urgent sibling is stalled.
 *
 * @param state - current tree state.
 * @param activities - activities in the period.
 * @param now - reference time.
 * @returns traps, worst first.
 */
export function detectDetailTraps(state, activities, now) {
    if (activities.length === 0 || state.goals.length === 0)
        return [];
    const maxDepth = Math.max(...state.goals.map((g) => g.depth), 1);
    const active = state.goals.filter((g) => g.status === 'active' || g.status === 'at_risk');
    if (active.length === 0)
        return [];
    // Attribute each activity to whichever candidate goal it names. Activities that
    // name several count once for each: the question is "how much of the work
    // touched this goal", not "which goal owns this activity".
    const counts = new Map();
    for (const activity of activities) {
        for (const goalId of activity.candidateGoalIds) {
            counts.set(goalId, (counts.get(goalId) ?? 0) + 1);
        }
    }
    if (counts.size === 0)
        return [];
    const lastTouch = new Map();
    for (const activity of activities) {
        const t = Date.parse(activity.timestamp);
        if (Number.isNaN(t))
            continue;
        for (const goalId of activity.candidateGoalIds) {
            const best = lastTouch.get(goalId) ?? 0;
            if (t > best)
                lastTouch.set(goalId, t);
        }
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const traps = [];
    for (const goal of active) {
        const count = counts.get(goal.id) ?? 0;
        if (count === 0)
            continue;
        const share = count / total;
        const depthRatio = goal.depth / maxDepth;
        const urgency = urgencyOf(goal, now);
        // A more urgent sibling that has not been touched at all in the period.
        const moreUrgentStalled = active
            .filter((other) => other.id !== goal.id)
            .filter((other) => urgencyOf(other, now) > urgency * 1.2)
            .filter((other) => (counts.get(other.id) ?? 0) === 0);
        // The condition from the design doc: high share AND deep AND low urgency AND
        // a more urgent goal is stalled. All four, or it is just focused work.
        if (share < 0.3 || depthRatio < 0.5 || moreUrgentStalled.length === 0)
            continue;
        const last = lastTouch.get(goal.id);
        const staleDays = last === undefined ? 0 : Math.max(0, Math.floor((now.getTime() - last) / 86_400_000));
        const crowded = moreUrgentStalled.sort((a, b) => urgencyOf(b, now) - urgencyOf(a, now))[0];
        // The filter above guarantees a non-empty list, but the guard costs nothing
        // and a crash in a report is worse than a missing sentence.
        if (crowded === undefined)
            continue;
        traps.push({
            goalId: goal.id,
            title: goal.title,
            depth: goal.depth,
            share,
            depthRatio,
            staleDays,
            crowdedOut: {
                goalId: crowded.id,
                title: crowded.title,
                urgency: urgencyOf(crowded, now),
            },
            summary: `在 depth-${goal.depth} 的「${goal.title}」上占了 ${(share * 100).toFixed(0)}% 的活动，` +
                `但 depth-${crowded.depth} 的「${crowded.title}」紧迫度更高且本期无推进`,
        });
    }
    return traps.sort((a, b) => b.share - a.share);
}
/**
 * Summarise how far along the tree is.
 *
 * Completion is a plain ratio of goals, not a weighted score. A weighted version
 * would need to know how much each goal matters, and that is exactly the thing
 * the tree does not record — inventing weights would make the progress bar move
 * in ways the user cannot predict from their own tree.
 *
 * @param state - current tree state.
 * @returns the summary.
 */
export function summarizeAchievements(state) {
    const confirmed = state.goals.filter((g) => g.confirmedByUser);
    const done = confirmed.filter((g) => g.status === 'done');
    const depths = [...new Set(confirmed.map((g) => g.depth))].sort((a, b) => a - b);
    const byDepth = depths.map((depth) => {
        const atDepth = confirmed.filter((g) => g.depth === depth);
        return { depth, total: atDepth.length, done: atDepth.filter((g) => g.status === 'done').length };
    });
    const resolved = state.contradictions.filter((c) => c.resolvedAt !== undefined);
    const completion = confirmed.length === 0 ? 0 : done.length / confirmed.length;
    return {
        totalGoals: confirmed.length,
        doneGoals: done.length,
        completion,
        totalContradictions: state.contradictions.length,
        resolvedContradictions: resolved.length,
        byDepth,
        line: `目标 ${done.length}/${confirmed.length} 完成（${(completion * 100).toFixed(0)}%）` +
            (state.contradictions.length === 0
                ? ''
                : `，矛盾 ${resolved.length}/${state.contradictions.length} 已解决`),
    };
}
/**
 * The contradictions whose intensity fell over a period.
 *
 * Reported because a falling tension is progress even when no goal finished, and
 * the goal tree alone cannot show it.
 *
 * @param before - observations or nodes at the start of the period.
 * @param nodes - current nodes.
 * @returns the improvements.
 */
export function easingContradictions(before, nodes) {
    const prior = new Map(before.map((n) => [n.id, n.intensity]));
    const out = [];
    for (const node of nodes) {
        const was = prior.get(node.id);
        if (was === null || was === undefined)
            continue;
        if (node.intensity === null)
            continue;
        if (node.intensity < was)
            out.push({ id: node.id, title: node.title, from: was, to: node.intensity });
    }
    return out.sort((a, b) => b.from - b.to - (a.from - a.to));
}
