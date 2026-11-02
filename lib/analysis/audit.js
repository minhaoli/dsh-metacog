/**
 * The strata, as the design doc records them.
 *
 * Not configurable: the rates are a deliberate trade of inspection effort against
 * statistical power, and a deployment that lowered them would quietly stop being
 * able to calibrate while still looking like it was trying.
 */
export const AUDIT_STRATA = [
    { name: 'low', from: 0, to: 0.5, rate: 0.02 },
    { name: 'medium', from: 0.5, to: 0.875, rate: 0.15 },
    { name: 'high', from: 0.875, to: 1, rate: 1 },
];
/** Which stratum a score falls in, or `undefined` outside every band. */
export function stratumFor(score) {
    // A score outside [0,1] belongs to no stratum. Without this guard the top band's
    // inclusive upper bound would also swallow 1.5, and an out-of-range value would
    // be audited at 100% as if it were maximally risky.
    if (!Number.isFinite(score) || score < 0 || score > 1)
        return undefined;
    // The top stratum is inclusive of its upper bound; the others are half-open, so
    // a score of exactly 0.5 belongs to `medium` and not to both.
    return AUDIT_STRATA.find((stratum) => score >= stratum.from && (score < stratum.to || stratum.to === 1));
}
/**
 * Select the records to inspect this round.
 *
 * Deterministic in the record id, not random: a re-run of the same period must
 * select the same records, or "this was audited" would be a different set each
 * time the report was generated and the denominator would drift.
 *
 * Only settled-or-pending judgements with a numeric score are candidates. A record
 * whose score cannot be read is skipped rather than guessed at, because a guessed
 * score would put it in a stratum nobody chose.
 *
 * @param records - judgements to consider.
 * @param alreadyAudited - ids already inspected, so a record is not sampled twice.
 */
export function selectAuditSample(records, alreadyAudited = new Set()) {
    const out = [];
    for (const record of records) {
        if (alreadyAudited.has(record.id))
            continue;
        const score = scoreOf(record);
        if (score === undefined)
            continue;
        const stratum = stratumFor(score);
        if (stratum === undefined)
            continue;
        // A deterministic hash of the id, spread over [0,1), compared against the
        // stratum's rate. Same id and same stratum always give the same verdict.
        const bucket = hashToUnit(record.id);
        if (bucket >= stratum.rate)
            continue;
        out.push({
            judgmentId: record.id,
            stratum: stratum.name,
            score,
            inclusionProbability: stratum.rate,
            // Rounded to three decimals: the weight is a design quantity, and printing
            // 33.333333333333336 in a report implies a precision it does not have.
            weight: Math.round((1 / stratum.rate) * 1000) / 1000,
        });
    }
    return out;
}
/**
 * The score a judgement was made on.
 *
 * Read from the drafted signal rather than recomputed: the draft is what the model
 * actually saw, and a recomputed score could differ from it after a config change.
 *
 * @param record - one judgement.
 */
function scoreOf(record) {
    const draft = record.draft;
    if (draft === null || typeof draft !== 'object')
        return undefined;
    const score = draft.score;
    return typeof score === 'number' && Number.isFinite(score) ? score : undefined;
}
/** A stable value in [0,1) derived from a string, by FNV-1a. */
function hashToUnit(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        // The multiply has to stay in 32 bits; `Math.imul` is the only way to do that
        // in JavaScript without losing the low bits to float precision.
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash / 0x100000000;
}
/**
 * Describe what the sampler is currently able to do.
 *
 * The report prints this instead of a rate when the sample is too small to mean
 * anything, so "0 of 3 audited" never reads as "0% drift".
 *
 * @param sample - records selected so far.
 * @param audited - how many of them have actually been labelled.
 */
export function describeAudit(sample, audited) {
    if (sample.length === 0) {
        return '本期没有抽到需要审计的记录';
    }
    if (audited === 0) {
        return `已抽到 ${sample.length} 条待审计，还没有标注结果`;
    }
    const byStratum = new Map();
    for (const record of sample)
        byStratum.set(record.stratum, (byStratum.get(record.stratum) ?? 0) + 1);
    const parts = [...byStratum.entries()].sort().map(([name, count]) => `${name} ${count}`);
    return `抽到 ${sample.length} 条（${parts.join('、')}），已标注 ${audited} 条`;
}
