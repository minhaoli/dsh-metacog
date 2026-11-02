/**
 * Analysis-layer tools: `check_drift`, `contradiction_observe` and
 * `resolve_intervention`.
 *
 * These are the only entries into the analysis layer. Each one keeps its own
 * responsibility narrow:
 *
 * - `check_drift` judges one activity (or runs the static checks) and returns
 *   whatever the escalation machine decided;
 * - `contradiction_observe` records one timestamped intensity reading and
 *   returns the trend computed from the stream — it never writes the node's
 *   `trend` field;
 * - `resolve_intervention` records the user's decision and audits it, touching
 *   no tree and no trend.
 *
 * @module dsh-metacog/tools/drift
 */
import { ObservationGradeSchema } from '../data/types.js';
import { GateError } from '../governance.js';
import { countLevels, manualFingerprint, recordObservation, runActivityCheck, runStaticCheck, } from '../analysis/service.js';
import { dominantContradiction } from '../analysis/drift.js';
import { pendingInterventionHint } from '../analysis/escalation.js';
import { defineMetacogTool, loadProject } from './shared.js';
/**
 * A leading `<tool>: ` tag, as the collector writes it.
 *
 * Lowercase only, and the colon must be followed by whitespace: that is what
 * keeps a Windows path such as `C:\src\x.ts` from being read as a tagged value.
 */
const TOOL_TAG = /^[a-z][a-z0-9_]*:\s+/;
/**
 * A relative path with at least one separator.
 *
 * The character class admits only what a path segment can contain, so a URL, a
 * glob, a prose sentence, a command or a symbol such as `Foo.bar` cannot match.
 * The separator requirement is the conservative half: a bare filename is not
 * taken as a path, because nothing in an evidence line says it is one.
 */
const RELATIVE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/;
/**
 * File paths an activity's evidence actually names.
 *
 * Evidence is the only place a recorded activity carries files: the collector
 * writes `<tool>: <value>` for every artifact-shaped argument, and a manually
 * reported activity mixes paths with commands, symbols, URLs and prose. Path
 * ownership is positive attribution — a touched path moves work onto the goal
 * that declared the prefix — so guessing is worse than staying silent: this
 * keeps an entry only when, after stripping a leading `<tool>: ` tag, it is an
 * unambiguous project-relative path.
 *
 * Both callers of {@link runActivityCheck} use this function, so the two entry
 * points cannot drift apart on what counts as a touched file. An activity that
 * names no file yields `[]`, which is judged exactly as it was before path
 * ownership existed.
 *
 * @param evidence - evidence lines as the caller or collector recorded them.
 * @returns distinct candidate paths, in first-seen order; `[]` when none.
 */
export function pathsFromEvidence(evidence) {
    const found = [];
    const seen = new Set();
    for (const line of evidence) {
        const candidate = line.trim().replace(TOOL_TAG, '').trim();
        const slashed = candidate.replace(/\\/g, '/');
        if (!RELATIVE_PATH.test(slashed))
            continue;
        // `..` is left as a literal segment by the path module because it cannot
        // know the project root, so an activity cannot prove where it landed.
        if (slashed.split('/').includes('..'))
            continue;
        const key = slashed.replace(/^\.\//, '').toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        found.push(candidate);
    }
    return found;
}
/**
 * Register `check_drift`.
 *
 * @param env - shared tool environment.
 */
export function checkDriftTool(env) {
    return defineMetacogTool({
        name: 'check_drift',
        description: 'Judge whether current work still serves the confirmed goal tree, and escalate when it ' +
            'does not. Supply an activity you observed (summary plus verifiable evidence and an ' +
            'observation grade A/B/C) for an alignment verdict: aligned, exploratory, scope_drift or ' +
            'uncertain. Omit the activity to run the static checks only (goal staleness and ' +
            'contradiction pressure), which read the recorded history rather than guessing. ' +
            'Re-sending an activity with the same eventFingerprint is idempotent. Level 2/3 cards are ' +
            'opened only for grade A evidence and only when no pending card already covers the same ' +
            'signal class.',
        parameters: {
            type: 'object',
            properties: {
                activity: {
                    type: 'object',
                    description: 'One observed activity. Omit for a static check. Grade C carries no activity ' +
                        'judgement at all (static checks still run).',
                    properties: {
                        summary: { type: 'string', description: 'What actually happened.' },
                        evidence: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Verifiable support: file paths, symbols, test results, commits.',
                        },
                        grade: {
                            type: 'string',
                            enum: [...ObservationGradeSchema.options],
                            description: 'A: direct description plus verifiable tool/file events. B: recent session ' +
                                'summary only. C: no reliable activity context.',
                        },
                        source: {
                            type: 'string',
                            enum: ['tool_event', 'user_input', 'manual'],
                            description: 'Where the observation came from. Defaults to manual.',
                        },
                        toolName: { type: 'string', description: 'Tool name when this came from a tool call.' },
                        sessionId: {
                            type: 'string',
                            description: 'Session the activity belongs to; defaults to the current one.',
                        },
                        eventFingerprint: {
                            type: 'string',
                            description: 'Stable dedupe key. Defaults to a content hash of summary+evidence, so the same ' +
                                'report twice records once.',
                        },
                        candidateGoalIds: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Goals you believe this serves; recorded as-is for auditing.',
                        },
                    },
                    required: ['summary', 'grade'],
                },
                blockerHint: {
                    type: 'string',
                    description: 'The bottleneck you believe now limits progress. If no confirmed main contradiction ' +
                        'covers it, a contradiction_shift signal is raised.',
                },
            },
            required: [],
            additionalProperties: false,
        },
        outputSchema: { type: 'object' },
        async run(args, exec) {
            const input = (args ?? {});
            const { projectId, store } = await loadProject(env, exec);
            const state = await store.readState(projectId);
            if (state === undefined) {
                throw new GateError('NOT_INITIALIZED', 'no tree exists; run goal_tree_init and goal_tree_confirm first.');
            }
            const now = new Date();
            const sessionId = input.activity?.sessionId ?? exec.agent?.session?.id ?? 'unknown-session';
            const config = env.config;
            const capabilityNotes = [
                'Level 3 is a real gate: while a level-3 intervention is pending, non-read-only tool ' +
                    'calls are denied by a pre-execute hook.',
                'Signals are recorded from what you report at the stated grade; the plugin cannot read ' +
                    'the conversation body, so grade A requires you to pass verifiable evidence.',
            ];
            let result;
            let mode;
            if (input.activity === undefined) {
                mode = 'static';
                // A static check must not invent an activity: it reports only what the
                // recorded history supports (staleness, contradiction pressure).
                result = {
                    duplicate: false,
                    ...(await runStaticCheck(store, state, projectId, input.blockerHint, config, now, sessionId)),
                };
            }
            else {
                mode = 'activity';
                const summary = input.activity.summary?.trim();
                if (summary === undefined || summary.length === 0) {
                    throw new GateError('INVALID_ARGS', 'activity.summary is required when activity is supplied');
                }
                const grade = input.activity.grade;
                if (grade !== 'A' && grade !== 'B' && grade !== 'C') {
                    throw new GateError('INVALID_ARGS', 'activity.grade must be "A", "B" or "C"');
                }
                const evidence = input.activity.evidence ?? [];
                if (grade === 'A' && evidence.length === 0) {
                    throw new GateError('GRADE_EVIDENCE_REQUIRED', 'grade A asserts that verifiable tool/file events support this activity, so at least ' +
                        'one evidence entry is required. Use grade B if you only have a session summary.');
                }
                result = await runActivityCheck(store, state, projectId, {
                    summary,
                    evidence,
                    // A path the activity names is positive attribution, so it must
                    // reach the judge: `evidence` documents paths as its own content,
                    // and this is the only file reference a reported activity carries.
                    paths: pathsFromEvidence(evidence),
                    source: input.activity.source ?? 'manual',
                    grade,
                    sessionId,
                    toolName: input.activity.toolName,
                    candidateGoalIds: input.activity.candidateGoalIds,
                    blockerHint: input.blockerHint,
                    eventFingerprint: input.activity.eventFingerprint ?? manualFingerprint(sessionId, summary, evidence),
                    now,
                }, config);
            }
            const allSignals = await store.readSignals(projectId);
            const interventions = await store.readInterventions(projectId);
            const pending = interventions.filter((record) => record.status === 'pending');
            const driftInput = {
                state,
                activities: await store.readActivities(projectId),
                observations: await store.readObservations(projectId),
                signals: allSignals,
                config,
                now,
            };
            const dominant = dominantContradiction(driftInput);
            return {
                projectId,
                mode,
                ...(result.activity === undefined ? {} : { activity: result.activity }),
                // The verdict's own Chinese hint, alongside the activity's technical
                // rationale: a caller reading this output gets both registers.
                ...(result.verdict === undefined ? {} : { verdictHint: result.verdict.hint }),
                duplicate: result.duplicate,
                signals: result.signals.map((entry) => ({
                    id: entry.signal.id,
                    signalType: entry.signal.signalType,
                    level: entry.signal.level,
                    monitorCategory: entry.signal.monitorCategory,
                    confidence: entry.signal.confidence,
                    relatedGoalIds: entry.signal.relatedGoalIds,
                    relatedContradictionIds: entry.signal.relatedContradictionIds,
                    ...(typeof entry.signal.hint === 'string' && entry.signal.hint.length > 0
                        ? { hint: entry.signal.hint }
                        : {}),
                    rationale: entry.signal.rationale,
                    escalation: entry.decision.rationale,
                    escalationHint: entry.decision.hint,
                    repeatCount: entry.decision.repeatCount,
                })),
                interventions: result.interventions.map((record) => ({
                    id: record.id,
                    level: record.level,
                    status: record.status,
                    ...(typeof record.hint === 'string' && record.hint.length > 0
                        ? { hint: record.hint }
                        : {}),
                    promptSummary: record.promptSummary,
                    suggestedActions: record.suggestedActions,
                })),
                level1Hints: result.level1Hints,
                pendingDecisions: pending.map((record) => ({
                    id: record.id,
                    level: record.level,
                    hint: pendingInterventionHint(record),
                })),
                ...(dominant === undefined
                    ? {}
                    : {
                        dominantContradiction: {
                            id: dominant.node.id,
                            title: dominant.node.title,
                            type: dominant.node.type,
                            intensity: dominant.intensity,
                            trend: dominant.trend,
                        },
                    }),
                trends: result.trends,
                levelCounts: countLevels(allSignals),
                capabilityNotes,
            };
        },
    });
}
/**
 * Register `contradiction_observe`.
 *
 * @param env - shared tool environment.
 */
export function contradictionObserveTool(env) {
    return defineMetacogTool({
        name: 'contradiction_observe',
        description: 'Record one timestamped intensity reading for a contradiction and get back the trend ' +
            'computed from the observation history inside the configured window. This is the only way ' +
            'to move a contradiction trend: the node field is derived from this stream and is never ' +
            'written directly. Intensity is 1-5 or null when evidence is insufficient; three usable ' +
            'observations are needed before any direction other than "unknown" is reported.',
        parameters: {
            type: 'object',
            properties: {
                contradictionId: { type: 'string', description: 'Contradiction node id.' },
                intensity: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 5,
                    description: '1-5; 0 means "no level can be justified" and is stored as null.',
                },
                evidence: { type: 'array', items: { type: 'string' } },
                confidence: { type: 'number', description: '0-1 confidence in this reading.' },
                rationale: { type: 'string', description: 'Why this intensity, in one or two sentences.' },
                observedAt: {
                    type: 'string',
                    description: 'ISO timestamp; defaults to now. Used when recording a past reading.',
                },
                sessionId: { type: 'string' },
            },
            required: ['contradictionId', 'intensity', 'rationale'],
            additionalProperties: false,
        },
        outputSchema: { type: 'object' },
        async run(args, exec) {
            const input = (args ?? {});
            const { projectId, store } = await loadProject(env, exec);
            const state = await store.readState(projectId);
            if (state === undefined) {
                throw new GateError('NOT_INITIALIZED', 'no tree exists; run goal_tree_init and goal_tree_confirm first.');
            }
            const contradictionId = input.contradictionId;
            if (contradictionId === undefined || !state.contradictions.some((n) => n.id === contradictionId)) {
                throw new GateError('UNKNOWN_CONTRADICTION', `contradiction "${contradictionId ?? ''}" does not exist in this project's tree`);
            }
            // `0` is the wire encoding of "insufficient evidence": the schema cannot
            // express null because the host validator rejects type arrays.
            const intensity = input.intensity === undefined || input.intensity === 0 ? null : input.intensity;
            if (intensity !== null && (!Number.isInteger(intensity) || intensity < 1 || intensity > 5)) {
                throw new GateError('INVALID_ARGS', 'intensity must be an integer 1-5, or 0 for unknown');
            }
            const confidence = input.confidence ?? 1;
            if (!(confidence >= 0 && confidence <= 1)) {
                throw new GateError('INVALID_ARGS', 'confidence must be between 0 and 1');
            }
            const rationale = input.rationale?.trim();
            if (rationale === undefined || rationale.length === 0) {
                throw new GateError('INVALID_ARGS', 'rationale is required; a bare number is not evidence');
            }
            const observedAt = input.observedAt ?? new Date().toISOString();
            if (Number.isNaN(Date.parse(observedAt))) {
                throw new GateError('INVALID_ARGS', 'observedAt must be an ISO-8601 timestamp');
            }
            const { observation, trend } = await recordObservation(store, projectId, {
                contradictionId,
                observedAt,
                intensity,
                evidence: input.evidence ?? [],
                confidence,
                rationale,
                sessionId: input.sessionId ?? exec.agent?.session?.id,
            }, env.config);
            return {
                projectId,
                observationId: observation.id,
                contradictionId,
                observedAt,
                intensity,
                trendAtRecordTime: observation.computedTrend,
                trendNow: trend.trend,
                sampleSize: trend.sampleSize,
                rationale: trend.rationale,
                nodeTrendUnchanged: 'the contradiction node still holds its previous trend value: trends are derived from ' +
                    'this observation stream, never assigned directly.',
            };
        },
    });
}
/**
 * Register `resolve_intervention`.
 *
 * @param env - shared tool environment.
 */
export function resolveInterventionTool(env) {
    return defineMetacogTool({
        name: 'resolve_intervention',
        description: 'Record the user\'s decision on a pending Level 2/3 intervention: continue, realign, ' +
            'modify_goals or dismiss. The decision is stored on the intervention record and written to ' +
            'the append-only audit log; it does not edit the goal or contradiction trees, and it never ' +
            'touches a contradiction trend. Deciding also lifts a Level 3 tool gate for this class.',
        parameters: {
            type: 'object',
            properties: {
                interventionId: { type: 'string', description: 'Id from check_drift or the prompt hint.' },
                decision: {
                    type: 'string',
                    enum: ['continue', 'realign', 'modify_goals', 'dismiss'],
                },
                rationale: {
                    type: 'string',
                    description: 'Why this decision; audited. Required — a bare decision is not a record.',
                },
            },
            required: ['interventionId', 'decision', 'rationale'],
            additionalProperties: false,
        },
        outputSchema: { type: 'object' },
        async run(args, exec) {
            const input = (args ?? {});
            const { projectId, store } = await loadProject(env, exec);
            const interventionId = input.interventionId;
            if (interventionId === undefined) {
                throw new GateError('INVALID_ARGS', 'interventionId is required');
            }
            const decision = input.decision;
            if (decision !== 'continue' &&
                decision !== 'realign' &&
                decision !== 'modify_goals' &&
                decision !== 'dismiss') {
                throw new GateError('INVALID_ARGS', 'decision must be continue, realign, modify_goals or dismiss');
            }
            const rationale = input.rationale?.trim();
            if (rationale === undefined || rationale.length === 0) {
                throw new GateError('REASON_REQUIRED', 'rationale is required to resolve an intervention');
            }
            // One implementation, shared with the settings card's route: both surfaces
            // must leave the same audit entry and supersede the same siblings.
            const decided = await resolveInterventionDecision(store, projectId, interventionId, decision, rationale);
            return {
                projectId: decided.projectId,
                interventionId: decided.interventionId,
                level: decided.level,
                status: decided.status,
                decision: decided.decision,
                rationale: decided.rationale,
                decidedAt: decided.decidedAt,
                auditEntryId: decided.auditEntryId,
                supersededIds: decided.supersededIds,
                treeUnchanged: 'the goal and contradiction trees were not modified by this decision; use ' +
                    'goal_tree_edit or contradiction_tree_edit to act on it, with the reason recorded.',
                level3GateActive: decided.level3GateActive,
            };
        },
    });
}
/**
 * Record the user's decision on one pending intervention.
 *
 * Extracted from the tool so the settings card can settle a card too. Both callers
 * must leave the same audit trail and apply the same supersede rule, and the only
 * way to guarantee that is one implementation: a card that resolved cards its own
 * way would eventually diverge from the tool, and the audit log would then depend
 * on which surface the user happened to click.
 *
 * @param store - the project's store.
 * @param projectId - owning project.
 * @param interventionId - card to decide.
 * @param decision - what the user chose.
 * @param rationale - why; audited, so it is required.
 */
export async function resolveInterventionDecision(store, projectId, interventionId, decision, rationale) {
    const records = await store.readInterventions(projectId);
    const target = records.find((record) => record.id === interventionId);
    if (target === undefined) {
        throw new GateError('UNKNOWN_INTERVENTION', `no intervention "${interventionId}" in this project`);
    }
    if (target.status !== 'pending') {
        throw new GateError('NOT_PENDING', `intervention "${interventionId}" is already ${target.status} (decision: ${target.decision ?? 'none'})`);
    }
    const decidedAt = new Date().toISOString();
    const resolved = await store.appendIntervention(projectId, {
        ...target,
        status: 'resolved',
        decision,
        rationale,
        decidedAt,
    });
    // Supersede other open cards for the same signal class: once the user has ruled
    // on this class, asking again is noise, and leaving them pending would keep a
    // stale Level 3 gate armed.
    const signals = await store.readSignals(projectId);
    const targetSignal = signals.find((signal) => signal.id === target.signalId);
    const superseded = [];
    if (targetSignal !== undefined) {
        for (const other of records) {
            if (other.id === target.id || other.status !== 'pending')
                continue;
            const otherSignal = signals.find((signal) => signal.id === other.signalId);
            if (otherSignal === undefined)
                continue;
            const sameClass = otherSignal.signalType === targetSignal.signalType &&
                sameMembers(otherSignal.relatedContradictionIds, targetSignal.relatedContradictionIds);
            if (!sameClass)
                continue;
            await store.appendIntervention(projectId, { ...other, status: 'superseded' });
            superseded.push(other.id);
        }
    }
    const audit = await store.appendStandaloneAudit(projectId, {
        actor: 'user_confirmed',
        action: 'resolve_intervention',
        targetIds: [target.id],
        reason: `${decision}: ${rationale}`,
        evidence: [],
    });
    const after = await store.readInterventions(projectId);
    const level3Active = after.some((record) => record.status === 'pending' && record.level === 3);
    return {
        projectId,
        interventionId: target.id,
        level: target.level,
        status: resolved.status,
        decision,
        rationale,
        decidedAt,
        auditEntryId: audit.id,
        supersededIds: superseded,
        level3GateActive: level3Active,
    };
}
/** Order-insensitive array equality, matching the service's rule exactly. */
function sameMembers(left, right) {
    if (left.length !== right.length)
        return false;
    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.every((value, index) => value === sortedRight[index]);
}
