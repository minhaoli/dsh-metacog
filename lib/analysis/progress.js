/** How many days of span count as "short" versus "long". */
const SHORT_SPAN_DAYS = 14;
const LONG_SPAN_DAYS = 90;
/** Stage thresholds as fractions of the span. */
const QUARTER = 0.25;
const HALF = 0.5;
const THREE_QUARTER = 0.75;
/**
 * Pick the stage for an elapsed fraction.
 *
 * The boundaries are inclusive at the lower end: exactly a quarter elapsed is
 * the quarter checkpoint, not still "early". A reminder that fires one tick
 * after the mark would be a reminder about a moment that already passed.
 *
 * @param elapsed - fraction of the span consumed, 0–1.
 * @returns the stage name.
 */
export function stageFor(elapsed) {
    if (elapsed < 0)
        return 'not-started';
    if (elapsed >= 1)
        return 'overdue';
    if (elapsed >= THREE_QUARTER)
        return 'three-quarter';
    if (elapsed >= HALF)
        return 'half';
    if (elapsed >= QUARTER)
        return 'quarter';
    return 'early';
}
/**
 * Which goal depths a span of this length should be checked at.
 *
 * The rule exists to stop the monitor from nagging: a two-year root goal with no
 * activity today is not stalled, and a three-day leaf goal with no activity
 * today probably is.
 *
 * @param spanDays - the goal's total span in days.
 * @returns the depths worth checking.
 */
export function depthsForSpan(spanDays) {
    if (spanDays <= SHORT_SPAN_DAYS)
        return [2, 3, 4, 5, 6, 7, 8, 9];
    if (spanDays <= LONG_SPAN_DAYS)
        return [1, 2, 3];
    return [0, 1];
}
/**
 * Days between two ISO timestamps.
 *
 * @param from - earlier timestamp.
 * @param to - later timestamp.
 * @returns the difference in days, possibly fractional.
 */
function daysBetween(from, to) {
    return (Date.parse(to) - Date.parse(from)) / 86_400_000;
}
/**
 * Evaluate every dated goal against the current time.
 *
 * @param goals - the confirmed tree.
 * @param options - current time and the last recorded movement per goal.
 * @param options.lastTouched - for each goal id, the timestamp of its most
 *   recent *aligned or exploratory activity*. Node edits are deliberately not
 *   included: setting a deadline is an edit, and treating it as progress would
 *   let a user silence a reminder by touching the goal.
 * @returns one finding per dated goal, plus the undated count for reporting.
 */
export function evaluateProgress(goals, options) {
    const nowIso = options.now.toISOString();
    const findings = [];
    let undated = 0;
    for (const goal of goals) {
        if (!goal.confirmedByUser)
            continue;
        if (goal.status !== 'active' && goal.status !== 'at_risk')
            continue;
        if (goal.deadline === undefined) {
            undated += 1;
            continue;
        }
        const startedAt = goal.startedAt ?? goal.createdAt;
        const spanDays = daysBetween(startedAt, goal.deadline);
        if (!Number.isFinite(spanDays) || spanDays <= 0) {
            // A deadline at or before the start is a data error, not a schedule. Say
            // so once instead of producing a nonsensical "overdue by -3 days".
            findings.push({
                goalId: goal.id,
                title: goal.title,
                depth: goal.depth,
                stage: 'not-started',
                elapsed: null,
                daysLeft: null,
                hasProgress: false,
                shouldRemind: true,
                message: `目标「${goal.title}」的截止时间不晚于开始时间，日期需要修正。`,
            });
            continue;
        }
        const elapsed = daysBetween(startedAt, nowIso) / spanDays;
        const daysLeft = daysBetween(nowIso, goal.deadline);
        const stage = stageFor(elapsed);
        const lastTouched = options.lastTouched.get(goal.id);
        const hasProgress = lastTouched !== undefined && Date.parse(lastTouched) > Date.parse(startedAt);
        const relevantDepth = depthsForSpan(spanDays).includes(goal.depth);
        // Reminders only fire at a checkpoint, only for a depth this span is judged
        // at, and only when the goal looks stalled. Anything else is noise.
        const atCheckpoint = stage === 'overdue' || stage === 'three-quarter' || stage === 'half' || stage === 'quarter';
        const shouldRemind = relevantDepth && atCheckpoint && !hasProgress;
        findings.push({
            goalId: goal.id,
            title: goal.title,
            depth: goal.depth,
            stage,
            elapsed,
            daysLeft,
            hasProgress,
            shouldRemind,
            message: describeFinding(goal, stage, daysLeft, hasProgress),
        });
    }
    return { findings, undated };
}
/**
 * Turn one finding into the sentence a report or reminder shows.
 *
 * @param goal - the goal being described.
 * @param stage - where it sits relative to its deadline.
 * @param daysLeft - days remaining, negative when overdue.
 * @param hasProgress - whether movement was recorded.
 * @returns one sentence, no advice attached.
 */
function describeFinding(goal, stage, daysLeft, hasProgress) {
    const movement = hasProgress ? '有推进记录' : '没有推进记录';
    if (stage === 'overdue') {
        return `目标「${goal.title}」已逾期 ${Math.abs(Math.round(daysLeft))} 天，${movement}。`;
    }
    const left = Math.round(daysLeft);
    const pct = stage === 'three-quarter' ? 75 : stage === 'half' ? 50 : stage === 'quarter' ? 25 : 0;
    if (pct === 0) {
        return `目标「${goal.title}」还有 ${left} 天到期，${movement}。`;
    }
    return `目标「${goal.title}」已走过 ${pct}% 的时间，剩 ${left} 天，${movement}。`;
}
