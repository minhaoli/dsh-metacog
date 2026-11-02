import { describeAudit, selectAuditSample } from './audit.js';
/**
 * Group the model's rejection reasons.
 *
 * Only settled judgements with a named reason are counted. A pending record has no
 * verdict, and a record with a free-text reason but no `modelWhy` predates the
 * field — counting either as a category would invent a bucket.
 *
 * @param judgments - every judgement, settled or not.
 * @returns per-reason counts, most frequent first, plus the denominator.
 */
export function undecidableReasons(judgments) {
    const labelled = judgments.filter((record) => record.status !== 'pending' && record.modelWhy !== undefined);
    const counts = new Map();
    for (const record of labelled) {
        const why = record.modelWhy;
        counts.set(why, (counts.get(why) ?? 0) + 1);
    }
    const total = labelled.length;
    const rows = [...counts.entries()]
        .map(([why, count]) => ({ why, count, share: total === 0 ? 0 : count / total }))
        .sort((left, right) => right.count - left.count || left.why.localeCompare(right.why));
    const settled = judgments.filter((record) => record.status !== 'pending').length;
    return { rows, settled, unlabelled: settled - total };
}
/**
 * How much of the period's activity was actually inspected by the model.
 *
 * This is the audit-coverage number the report used to leave blank. It is not
 * stratified sampling — that is a separate mechanism — but it is the honest
 * denominator: "of the N activities recorded, M were reviewed, K were not".
 *
 * @param activities - the period's activities.
 * @param judgments - judgements created in the same period.
 */
export function auditCoverage(activities, judgments) {
    // An activity is "reviewed" when some judgement names it. The id sets are small
    // enough that a Set is cheaper than indexing the whole store.
    const judged = new Set();
    for (const record of judgments) {
        for (const id of record.activityIds)
            judged.add(id);
    }
    // The stratified sample: which records the audit mechanism picked for a human
    // look. This is the only path that can produce the missing class — measured on
    // the real project, the model rejects 249 records and confirms none, so waiting
    // for the existing channels to fill in a positive sample never happens.
    const sample = selectAuditSample(judgments);
    const sampleNote = describeAudit(sample, 0);
    const reviewed = activities.filter((activity) => judged.has(activity.id)).length;
    const recorded = activities.length;
    return {
        recorded,
        reviewed,
        share: recorded === 0 ? 0 : reviewed / recorded,
        undecided: judgments.filter((record) => record.status === 'pending').length,
        sampled: sample.length,
        sampleNote,
    };
}
/**
 * Whether the thresholds in force were derived or guessed.
 *
 * They were guessed: the values are engineering estimates on an uncalibrated
 * score, and `fitCalibration` refuses to fit while only one class exists. This
 * function exists so the report can say *why* rather than leaving a blank, and so
 * the answer changes automatically once a calibration exists.
 *
 * @param calibrated - whether a calibration curve is in force.
 * @param samples - settled samples available to a fit.
 */
export function thresholdProvenance(calibrated, samples) {
    if (calibrated) {
        return { derived: true, note: '阈值由校准曲线给出' };
    }
    return {
        derived: false,
        note: samples === 0
            ? '阈值为工程估计值：还没有任何已结算样本，无法求解'
            : `阈值为工程估计值：只有 ${samples} 条可用样本，两类样本不足，无法求解`,
    };
}
