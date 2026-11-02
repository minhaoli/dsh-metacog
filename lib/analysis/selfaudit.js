/**
 * Function F: how well do the rules actually judge?
 *
 * Every drift candidate is logged with two verdicts — the program's and a model's
 * — so the log is a labelled dataset the plugin produces for free. This module
 * turns it into one number per rule: of everything the rule called drift, how much
 * did a second opinion reject?
 *
 * That number is the only honest answer to "is the monitor getting better". Without
 * it, tuning a threshold is a guess and a noisy rule keeps costing the user's trust
 * without anyone noticing.
 *
 * Nothing here is a decision. A rule is reported as noisy; it is not silently
 * switched off, because a rule that looks bad on ten samples may be right on the
 * next hundred.
 *
 * @module dsh-metacog/analysis/selfaudit
 */
/** Samples a rule needs before its rate means anything. */
export const MIN_RULE_SAMPLES = 10;
/** Rejection rate above which a rule is reported as noisy. */
export const NOISY_RULE_THRESHOLD = 0.5;
/**
 * Aggregate the judgement log by rule.
 *
 * @param records - every judgement record for one project.
 * @returns one row per rule, noisiest first.
 */
export function assessRules(records) {
    const byType = new Map();
    for (const record of records) {
        const bucket = byType.get(record.signalType) ?? {
            confirmed: 0,
            dismissed: 0,
            pending: 0,
            why: new Map(),
        };
        if (record.status === 'confirmed')
            bucket.confirmed += 1;
        else if (record.status === 'dismissed') {
            bucket.dismissed += 1;
            // Only rejections carry a "why": a confirmation means the rule was right,
            // and its reason describes the drift rather than a defect in the rule.
            if (record.modelWhy !== undefined) {
                bucket.why.set(record.modelWhy, (bucket.why.get(record.modelWhy) ?? 0) + 1);
            }
        }
        else
            bucket.pending += 1;
        byType.set(record.signalType, bucket);
    }
    const rows = [];
    for (const [signalType, bucket] of byType) {
        const settled = bucket.confirmed + bucket.dismissed;
        const rate = settled === 0 ? null : bucket.dismissed / settled;
        rows.push({
            signalType,
            candidates: settled + bucket.pending,
            confirmed: bucket.confirmed,
            dismissed: bucket.dismissed,
            pending: bucket.pending,
            falsePositiveRate: rate,
            verdict: settled < MIN_RULE_SAMPLES
                ? 'insufficient'
                : rate !== null && rate > NOISY_RULE_THRESHOLD
                    ? 'noisy'
                    : 'healthy',
            byWhy: [...bucket.why.entries()]
                .map(([why, count]) => ({ why, count }))
                .sort((left, right) => right.count - left.count),
        });
    }
    return rows.sort((left, right) => {
        const leftRate = left.falsePositiveRate ?? -1;
        const rightRate = right.falsePositiveRate ?? -1;
        if (leftRate !== rightRate)
            return rightRate - leftRate;
        return right.candidates - left.candidates;
    });
}
/**
 * Identity shared by a signal and the draft a judgement was made from.
 *
 * Judgement records carry the draft, not the signal id (the signal does not
 * exist yet when the candidate is queued), so this is the only join available.
 * Missing pieces yield `undefined`, which never matches.
 */
function coverageKey(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const candidate = value;
    if (typeof candidate.signalType !== 'string' || typeof candidate.observedAt !== 'string') {
        return undefined;
    }
    const activityIds = Array.isArray(candidate.activityIds)
        ? candidate.activityIds.filter((id) => typeof id === 'string')
        : [];
    return `${candidate.signalType}::${candidate.observedAt}::${activityIds.join(',')}`;
}
/**
 * Measure each rule's review coverage, not just its rejection rate.
 *
 * `assessRules` only sees candidates that went through the queue. A rule that
 * escalates directly never produces one, so its health row is built from
 * nothing while its conclusions keep reaching the user. This function makes
 * that gap countable.
 *
 * A signal counts as reviewed only when a judgement record can be matched to
 * it; the join is the draft's signal type, observation time and activity ids.
 * Legacy signals whose judgement predates the stored draft stay uncounted
 * rather than being assumed reviewed.
 *
 * @param signals - recorded signals for the project (or the report period).
 * @param judgments - judgement records, including sampled ones.
 * @returns one row per rule, largest blind spot first.
 */
export function assessRuleCoverage(signals, judgments) {
    const judgedKeys = new Set();
    for (const record of judgments) {
        const key = coverageKey(record.draft);
        if (key !== undefined)
            judgedKeys.add(key);
    }
    const byType = new Map();
    for (const signal of signals) {
        const bucket = byType.get(signal.signalType) ?? { reviewed: 0, bypassed: 0 };
        if (signal.reviewedBy === 'bypass') {
            bucket.bypassed += 1;
        }
        else {
            const key = coverageKey(signal);
            if (key !== undefined && judgedKeys.has(key))
                bucket.reviewed += 1;
        }
        byType.set(signal.signalType, bucket);
    }
    const sampled = new Map();
    for (const record of judgments) {
        if (record.sampled !== true)
            continue;
        sampled.set(record.signalType, (sampled.get(record.signalType) ?? 0) + 1);
    }
    const rows = [];
    for (const [signalType, bucket] of byType) {
        const unreviewedBypass = Math.max(0, bucket.bypassed - (sampled.get(signalType) ?? 0));
        rows.push({
            signalType,
            reviewed: bucket.reviewed,
            bypassed: bucket.bypassed,
            unreviewedBypass,
            underrepresented: bucket.bypassed > bucket.reviewed,
        });
    }
    return rows.sort((left, right) => right.unreviewedBypass - left.unreviewedBypass || right.bypassed - left.bypassed);
}
