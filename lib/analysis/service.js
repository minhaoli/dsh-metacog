/**
 * The analysis service: one place that turns a project's recorded state into
 * new observations, activities, signals and interventions.
 *
 * Tools call into this module rather than into the individual analysers, so the
 * ordering below is enforced once instead of at every call site:
 *
 * 1. fingerprint dedupe — a repeated event returns the original record;
 * 2. alignment judgement — deterministic, grade-capped;
 * 3. activity append — only after the verdict exists;
 * 4. detector sweep — staleness, bypass, drift, contradiction shift;
 * 5. escalation — levels from the configured thresholds, deduped by class;
 * 6. intervention append — only when the machine said to open one;
 * 7. observation recording — trends recomputed from the stored stream.
 *
 * Nothing here writes a contradiction's `trend` field: the node keeps whatever
 * it holds, and the computed direction travels on the observation record and in
 * the tool's return value (spec 0.4 item 3, spec 2.2).
 *
 * @module dsh-metacog/analysis/service
 */
import { createHash, randomUUID } from 'node:crypto';
import { computeGoalContradictionBurden } from '../data/types.js';
import { judgeAlignment, mayEscalate, } from './alignment.js';
import { detectContradictionPressure, detectContradictionShift, detectCoreBypass, detectDeadlineRisk, detectGoalStaleness, detectScopeDrift, dominantContradiction, } from './drift.js';
import { decideEscalation, level1Hint, suggestedActions, } from './escalation.js';
import { computeTrend, observationsInWindow } from './trend.js';
/**
 * Build the goal → contradiction context for one detector sweep.
 *
 * Pure over the tree and config: no store access, so the sweep pays for it once
 * and the same state always yields the same context.
 *
 * @param state - current tree.
 * @param config - resolved configuration (weights live in `config.contradictions`).
 * @returns one entry per goal that at least one unresolved tension touches.
 */
export function goalContradictionContext(state, config) {
    const context = new Map();
    const byId = new Map(state.contradictions.map((node) => [node.id, node]));
    for (const goal of state.goals) {
        const burden = computeGoalContradictionBurden(goal.id, state.contradictions, config.contradictions);
        if (burden.count === 0)
            continue;
        context.set(goal.id, {
            total: burden.total,
            count: burden.count,
            peak: burden.peak,
            unmeasured: burden.unmeasured,
            contradictions: burden.contributions.map((item) => ({
                id: item.contradictionId,
                title: byId.get(item.contradictionId)?.title ?? item.contradictionId,
                intensity: item.intensity,
                weight: item.weight,
            })),
        });
    }
    return context;
}
/**
 * Attach the goal contradiction burden to each draft's rationale.
 *
 * The burden is appended as context, not folded into confidence or level: a
 * detector's verdict must stay exactly what its own evidence says. Signals that
 * concern no goal, or goals no tension touches, are returned untouched.
 *
 * @param drafts - detector output for this sweep.
 * @param state - current tree.
 * @param config - resolved configuration.
 * @returns drafts with a read-only context clause where one exists.
 */
export function attachGoalBurdenContext(drafts, state, config) {
    const context = goalContradictionContext(state, config);
    if (context.size === 0)
        return [...drafts];
    const titles = new Map(state.goals.map((goal) => [goal.id, goal.title]));
    return drafts.map((draft) => {
        const parts = [];
        for (const goalId of draft.relatedGoalIds) {
            const burden = context.get(goalId);
            if (burden === undefined)
                continue;
            const named = burden.contradictions
                .map((item) => `${item.title}（${item.intensity === null ? '强度未测量' : `强度 ${item.intensity}`}）`)
                .join('、');
            parts.push(`「${titles.get(goalId) ?? goalId}」矛盾负担 ${burden.total.toFixed(1)}：${named}`);
        }
        if (parts.length === 0)
            return draft;
        return { ...draft, rationale: `${draft.rationale}（只读上下文：${parts.join('；')}）` };
    });
}
/**
 * Build a dedupe fingerprint for a tool-call event (spec 4.2 step 1).
 *
 * A tool call has a host-assigned `callId`, so the fingerprint needs no content
 * hash: the same call replayed collapses on identity, which is exactly the
 * idempotence the spec requires.
 *
 * @param sessionId - session that produced the call.
 * @param callId - host tool-call id.
 */
export function toolCallFingerprint(sessionId, callId) {
    return `tool:${sessionId}:${callId}`;
}
/**
 * Build a fingerprint for a user message.
 *
 * @param sessionId - session that produced the message.
 * @param seq - monotonic message sequence inside the session.
 */
export function userMessageFingerprint(sessionId, seq) {
    return `user:${sessionId}:${seq}`;
}
/**
 * Build a content-addressed fingerprint for a manually reported activity.
 *
 * Manual reports have no host identity, so the same description submitted twice
 * must collapse on content. Text is normalized first so trailing whitespace or
 * incidental punctuation cannot manufacture a second record.
 *
 * @param sessionId - session reporting the activity.
 * @param summary - activity description.
 * @param evidence - supporting evidence lines.
 */
export function manualFingerprint(sessionId, summary, evidence) {
    const canonical = [
        summary.trim().replace(/\s+/g, ' ').toLowerCase(),
        ...[...evidence].map((item) => item.trim()).sort(),
    ].join('\u0000');
    const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 32);
    return `manual:${sessionId}:${digest}`;
}
/**
 * Record an observed activity and run every drift detector over it.
 *
 * @param store - project store.
 * @param state - current tree state (read by the caller under its own CAS read).
 * @param projectId - project id.
 * @param request - the activity plus context.
 * @param config - resolved configuration.
 * @returns what this run appended, or `duplicate: true` for a replayed event.
 */
export async function runActivityCheck(store, state, projectId, request, config) {
    const now = request.now ?? new Date();
    // Step 1: dedupe before any judging, so a replay cannot double-count.
    const existing = await store.findActivityByFingerprint(projectId, request.eventFingerprint);
    if (existing !== undefined) {
        return {
            // No `verdict`: this run judged nothing, and re-judging a stored activity
            // against a tree that has moved since would report a decision the record
            // never carried.
            activity: existing,
            duplicate: true,
            signals: [],
            interventions: [],
            level1Hints: [],
            trends: [],
        };
    }
    // Step 2: judge. The verdict object is the model's description reconciled with
    // the program's rules; the model cannot write a verdict directly.
    const verdict = judgeAlignment({
        summary: request.summary,
        evidence: request.evidence,
        source: request.source,
        grade: request.grade,
        toolName: request.toolName,
        paths: request.paths,
    }, state.goals, config);
    const candidateGoalIds = request.candidateGoalIds !== undefined && request.candidateGoalIds.length > 0
        ? request.candidateGoalIds
        : verdict.candidateGoalIds;
    const activity = {
        id: `act_${randomUUID()}`,
        eventFingerprint: request.eventFingerprint,
        projectId,
        sessionId: request.sessionId,
        timestamp: now.toISOString(),
        source: request.source,
        observationGrade: request.grade,
        summary: request.summary,
        evidence: request.evidence,
        candidateGoalIds,
        alignmentConfidence: verdict.confidence,
        decision: verdict.decision,
        rationale: verdict.rationale,
        ...(request.trace === undefined ? {} : { trace: request.trace }),
    };
    await store.appendActivity(projectId, activity);
    const driftInput = {
        state,
        activities: await store.readActivities(projectId),
        observations: await store.readObservations(projectId),
        signals: await store.readSignals(projectId),
        config,
        now,
    };
    // Step 4: detectors. Scope drift is per-activity; the rest are project-wide and
    // are skipped when this run is a replay (already handled above).
    //
    // `unbound` says "no goal claims this", never "this serves something else", so
    // the activity must not become a drift signal. `detectScopeDrift` already
    // refuses anything that is not `scope_drift`; the explicit guard keeps that
    // true even if the record's vocabulary moves again — which is exactly what
    // happened when `unbound` entered the enum, so the guard is now load-bearing
    // rather than merely defensive.
    //
    // `core_bypass` is the other place an unbound activity would bite: it counts
    // activities that "served neither the contradiction nor its goals", and an
    // unbound record carries no candidate goals at all, so a raw pass would read
    // "nobody claims this" as "this avoided the goal" and let repeats of it open a
    // card. Unbound activities are therefore withheld from that detector: an
    // activity nobody could place is not evidence that anything was avoided.
    const drafts = [
        ...(verdict.decision === 'unbound' ? [] : detectScopeDrift(activity, driftInput)),
        ...detectCoreBypass({
            ...driftInput,
            activities: driftInput.activities.filter((entry) => entry.decision !== 'unbound'),
        }),
        ...detectGoalStaleness(driftInput),
        ...detectContradictionPressure(driftInput),
    ];
    if (request.blockerHint !== undefined) {
        drafts.push(...detectContradictionShift(request.blockerHint, driftInput));
    }
    // Read-only context: the sweep has the burden in hand before anything is
    // persisted. Escalation never consults it; only the rationale carries it.
    const contextualDrafts = attachGoalBurdenContext(drafts, state, config);
    // Deferred mode stops here: the caller queues these as candidates and a later
    // batch decides. Nothing reaches the signal stream on a single rule hit.
    if (request.deferSignals === true) {
        return {
            activity,
            duplicate: false,
            verdict,
            signals: [],
            interventions: [],
            level1Hints: [],
            trends: [],
            drafts: contextualDrafts,
        };
    }
    const result = await persistDrafts(store, projectId, state, contextualDrafts, driftInput, {
        activityIds: [activity.id],
        sessionId: request.sessionId,
        mayEscalate: mayEscalate(request.grade, config),
        config,
        now,
    });
    return { activity, duplicate: false, ...result, verdict };
}
/**
 * Publish drafts that a second opinion has already endorsed.
 *
 * Kept separate from {@link runActivityCheck} because the two happen at different
 * times: screening is per activity, publishing is per review batch. Sharing
 * `persistDrafts` keeps repeat counting and escalation in one place either way.
 *
 * @param store - project store.
 * @param state - current confirmed tree.
 * @param projectId - owning project.
 * @param drafts - candidates the model also called drift.
 * @param config - thresholds.
 * @param now - timestamp for the publication.
 */
export async function publishDrafts(store, state, projectId, drafts, config, now, options = {}) {
    const driftInput = {
        state,
        activities: await store.readActivities(projectId),
        observations: await store.readObservations(projectId),
        signals: await store.readSignals(projectId),
        config,
        now,
    };
    return persistDrafts(store, projectId, state, drafts, driftInput, {
        activityIds: drafts.flatMap((draft) => draft.activityIds),
        // Review-confirmed drafts have already passed the grade gate upstream, so
        // the default stays true. A caller publishing rule drafts directly (the
        // high-precision path) passes the activity's own grade decision instead.
        mayEscalate: options.mayEscalate ?? true,
        // Independent of `mayEscalate`: this says whether a model saw the draft,
        // not whether its grade allowed escalation. The self-audit needs both.
        bypassed: options.bypassed === true,
        config,
        now,
    });
}
/** Shared tail of both check entry points. */
async function persistDrafts(store, projectId, state, drafts, driftInput, options) {
    const signals = [];
    const interventions = [];
    const level1Hints = [];
    let known = await store.readSignals(projectId);
    let knownInterventions = await store.readInterventions(projectId);
    for (const draft of drafts) {
        // Signal-level dedupe: the same detector over the same binding must not
        // record twice inside the window; that would inflate its own repeat count.
        const duplicate = known.some((signal) => signal.signalType === draft.signalType &&
            signal.observedAt === draft.observedAt &&
            sameMembers(signal.relatedContradictionIds, draft.relatedContradictionIds) &&
            sameMembers(signal.relatedGoalIds, draft.relatedGoalIds));
        if (duplicate)
            continue;
        const intensity = intensityFor(draft, driftInput);
        const decision = decideEscalation({
            signalType: draft.signalType,
            relatedContradictionIds: draft.relatedContradictionIds,
            relatedGoalIds: draft.relatedGoalIds,
            confidence: draft.confidence,
            intensity,
            mayEscalate: options.mayEscalate,
            signals: known,
            interventions: knownInterventions,
            config: options.config,
            now: options.now,
        });
        const signal = {
            id: `sig_${randomUUID()}`,
            projectId,
            // A timer tick has no session; omitting the field says so, while an empty
            // string would be a lie the schema rightly rejects.
            ...(options.sessionId === undefined || options.sessionId.length === 0
                ? {}
                : { sessionId: options.sessionId }),
            observedAt: draft.observedAt,
            monitorCategory: draft.monitorCategory,
            signalType: draft.signalType,
            level: decision.level,
            relatedGoalIds: draft.relatedGoalIds,
            relatedContradictionIds: draft.relatedContradictionIds,
            activityIds: [...new Set([...draft.activityIds, ...options.activityIds])],
            confidence: draft.confidence,
            evidence: draft.evidence,
            // Optional on the stored shape, so a missing or empty hint is omitted
            // rather than written as "": an empty string would mean "there is a hint
            // and it says nothing", which disables the Chinese fallback. Old drafts
            // replayed from the judgment log predate the field entirely.
            ...(typeof draft.hint === 'string' && draft.hint.length > 0 ? { hint: draft.hint } : {}),
            // The provenance marker the self-audit reads: a bypassed signal must stay
            // distinguishable from one a model actually reviewed.
            reviewedBy: options.bypassed === true ? 'bypass' : 'review',
            rationale: `${draft.rationale} Escalation: ${decision.rationale}`,
        };
        if (decision.openIntervention) {
            const record = buildIntervention(signal, state, options.now);
            const stored = await store.appendIntervention(projectId, record);
            signal.interventionId = stored.id;
            interventions.push(stored);
            knownInterventions = [...knownInterventions, stored];
        }
        else if (decision.level === 1) {
            level1Hints.push(level1Hint(signal));
        }
        const stored = await store.appendSignal(projectId, signal);
        known = [...known, stored];
        signals.push({ signal: stored, decision });
    }
    return {
        signals,
        interventions,
        level1Hints,
        trends: recomputeTouchedTrends(state, driftInput),
    };
}
/** Recompute trends for every contradiction in the tree, from the run's stream. */
function recomputeTouchedTrends(state, input) {
    return state.contradictions.map((node) => {
        const trend = computeTrend(input.observations, node.id, input.config.thresholds.windowMinutes);
        return {
            contradictionId: node.id,
            title: node.title,
            trend: trend.trend,
            intensity: trend.lastIntensity,
            rationale: trend.rationale,
        };
    });
}
/**
 * Record a contradiction observation and return its computed trend.
 *
 * The trend is computed **before** the new observation is appended when the
 * caller asks for the trend of the history (which is the spec's definition:
 * `computedTrend` is derived from the prior window). The observation is then
 * persisted with that value, so the stored stream is self-describing.
 *
 * @param store - project store.
 * @param projectId - project id.
 * @param input - the observation to record.
 * @param config - resolved configuration.
 * @returns the stored observation and the node's trend after appending.
 */
export async function recordObservation(store, projectId, input, config) {
    const history = await store.readObservations(projectId);
    // The trend recorded on the observation describes the history that led to it.
    const trendFromHistory = computeTrend(history, input.contradictionId, config.thresholds.windowMinutes);
    const observation = {
        id: `obs_${randomUUID()}`,
        projectId,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        contradictionId: input.contradictionId,
        observedAt: input.observedAt,
        intensity: input.intensity,
        computedTrend: trendFromHistory.trend,
        evidence: input.evidence,
        confidence: input.confidence,
        rationale: input.rationale,
    };
    await store.appendObservation(projectId, observation);
    const after = [...history, observation];
    return {
        observation,
        trend: computeTrend(after, input.contradictionId, config.thresholds.windowMinutes),
    };
}
/**
 * Recompute the trend of one contradiction from its stored stream, without
 * recording anything. Used by the read-only surfaces so a trend query never
 * mutates the history it reads.
 *
 * @param store - project store.
 * @param projectId - project id.
 * @param contradictionId - node to inspect.
 * @param config - resolved configuration.
 */
export async function readContradictionTrend(store, projectId, contradictionId, config) {
    const history = await store.readObservations(projectId);
    return computeTrend(history, contradictionId, config.thresholds.windowMinutes);
}
/** Highest recorded intensity for a draft's contradictions, 0 when unknown. */
function intensityFor(draft, input) {
    let max = 0;
    for (const id of draft.relatedContradictionIds) {
        const node = input.state.contradictions.find((item) => item.id === id);
        if (node?.intensity !== null && node?.intensity !== undefined)
            max = Math.max(max, node.intensity);
        const observed = observationsInWindow(input.observations, id, input.config.thresholds.windowMinutes);
        for (const item of observed) {
            if (item.intensity !== null)
                max = Math.max(max, item.intensity);
        }
    }
    return max;
}
/** Order-insensitive array equality. */
function sameMembers(left, right) {
    if (left.length !== right.length)
        return false;
    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.every((value, index) => value === sortedRight[index]);
}
/**
 * Build the intervention record a Level 2/3 signal opens.
 *
 * @param signal - the escalated signal.
 * @param state - current tree, used to name goals and the blocking contradiction.
 * @param now - clock injection.
 */
export function buildIntervention(signal, state, now) {
    const goals = signal.relatedGoalIds
        .map((id) => state.goals.find((goal) => goal.id === id))
        .filter((goal) => goal !== undefined);
    const contradiction = signal.relatedContradictionIds
        .map((id) => state.contradictions.find((node) => node.id === id))
        .find((node) => node !== undefined);
    const level = signal.level === 3 ? 3 : 2;
    const targetText = contradiction !== undefined
        ? `${contradiction.type} contradiction "${contradiction.title}"`
        : goals.length > 0
            ? goals.map((goal) => `depth-${goal.depth} "${goal.title}"`).join(', ')
            : 'the confirmed tree';
    return {
        id: `iv_${randomUUID()}`,
        projectId: signal.projectId,
        ...(signal.sessionId === undefined ? {} : { sessionId: signal.sessionId }),
        signalId: signal.id,
        level,
        status: 'pending',
        promptSummary: `${signal.signalType} near ${targetText}: ${signal.rationale} ` +
            `Choose whether to continue, realign, modify the tree, or dismiss.`,
        // Carried from the signal so the card's prompt line can show the Chinese
        // hint instead of the technical summary above. Old signals have no hint at
        // all, so the field is omitted rather than written as an empty string.
        ...(typeof signal.hint === 'string' && signal.hint.length > 0
            ? { hint: signal.hint }
            : {}),
        suggestedActions: suggestedActions(level, signal.signalType, goals.map((goal) => goal.title), contradiction?.title),
        createdAt: now.toISOString(),
    };
}
/**
 * Summarise the current blocking contradiction for the prompt and reports.
 *
 * @param input - current project facts.
 */
export { dominantContradiction };
/**
 * Run the checks that need no activity: goal staleness, contradiction pressure
 * and the optional contradiction-shift probe.
 *
 * Kept separate from {@link runActivityCheck} because it must never fabricate an
 * `ActivityRecord`: a static check observed nothing, and writing a phantom
 * activity would pollute the very drift statistics the report is built from.
 *
 * @param store - project store.
 * @param state - current tree state.
 * @param projectId - project id.
 * @param blockerHint - the bottleneck the caller believes is current, if any.
 * @param config - resolved configuration.
 * @param now - clock injection.
 * @param sessionId - session the check runs in, or `undefined` for a timer tick
 *   that runs outside any conversation.
 * @returns the appended signals and hints, with no activity.
 */
export async function runStaticCheck(store, state, projectId, blockerHint, config, now, sessionId) {
    const driftInput = {
        state,
        activities: await store.readActivities(projectId),
        observations: await store.readObservations(projectId),
        signals: await store.readSignals(projectId),
        config,
        now,
    };
    const drafts = [
        ...detectGoalStaleness(driftInput),
        ...detectContradictionPressure(driftInput),
        ...(blockerHint === undefined ? [] : detectContradictionShift(blockerHint, driftInput)),
        ...detectDeadlineRisk(driftInput),
    ];
    // Same read-only context as the activity path: the static sweep evaluates
    // goals, so it records what each touched goal is already carrying.
    const contextualDrafts = attachGoalBurdenContext(drafts, state, config);
    // A static check has no grade A evidence behind it, so it may record and hint
    // but never open a card. `mayEscalate: false` states that once, here.
    return persistDrafts(store, projectId, state, contextualDrafts, driftInput, {
        activityIds: [],
        sessionId,
        mayEscalate: false,
        config,
        now,
    });
}
/**
 * Count signals by level, for a compact status line.
 *
 * @param signals - signals to count.
 */
export function countLevels(signals) {
    const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
    for (const signal of signals)
        counts[signal.level] += 1;
    return counts;
}
