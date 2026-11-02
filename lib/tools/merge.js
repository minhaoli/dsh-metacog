import { GateError } from '../governance.js';
import { defineMetacogTool, loadProject } from './shared.js';
import { mergeTrees, checkMergedShape } from '../analysis/merge.js';
import { ContradictionTypeSchema } from '../data/types.js';
/**
 * Turn the caller's loose candidate description into a real `TreeState`-shaped
 * pair of arrays, filling the fields the merge reads.
 *
 * The candidate is not a stored tree: it exists only for this call, so it needs
 * no version, no project binding and no audit history.
 */
function materialiseCandidate(projectId, input, now) {
    const goals = [
        {
            id: 'L0_candidate',
            projectId,
            parentId: null,
            depth: 0,
            title: input.rootTitle,
            description: '',
            status: 'active',
            priority: 0,
            confirmedByUser: true,
            successCriteria: [],
            alignment: {
                relevantActivities: [],
                allowedMethods: [],
                excludedActivities: [],
                explorationPolicy: 'limited',
            },
            // The candidate tree carries no path claims: a merge is about goal
            // structure, and inventing an owner here would bind work to a goal on
            // the strength of a field the caller never supplied.
            paths: [],
            evidence: [],
            createdAt: now,
            updatedAt: now,
        },
    ];
    for (const goal of input.goals ?? []) {
        goals.push({
            id: goal.id,
            projectId,
            // A depth-1 candidate node with no stated parent belongs under the
            // candidate's own root. Making the caller repeat an internal id they
            // never saw would be an API that leaks its own bookkeeping.
            parentId: goal.parentId ?? (goal.depth === 1 ? 'L0_candidate' : null),
            depth: goal.depth,
            title: goal.title,
            description: goal.description ?? '',
            status: 'active',
            priority: 0,
            confirmedByUser: true,
            successCriteria: goal.successCriteria ?? [],
            alignment: {
                relevantActivities: [],
                allowedMethods: [],
                excludedActivities: [],
                explorationPolicy: 'limited',
            },
            // See the root node above: candidate nodes make no path claims.
            paths: [],
            evidence: goal.evidence ?? [],
            createdAt: now,
            updatedAt: now,
        });
    }
    const contradictions = (input.contradictions ?? []).map((node) => ({
        id: node.id,
        projectId,
        parentId: null,
        primaryGoalId: node.primaryGoalId,
        relatedGoalIds: node.relatedGoalIds ?? [],
        // Weights are part of the link, not decoration: merging a candidate tree
        // must not silently downgrade a weighted cross-goal tension to the default.
        relatedGoals: node.relatedGoals,
        type: node.type ?? 'unclassified',
        confirmedByUser: true,
        title: node.title,
        description: node.description ?? '',
        poleA: node.poleA,
        poleB: node.poleB,
        intensity: null,
        trend: 'unknown',
        rationale: '',
        resolutionHint: '',
        evidence: node.evidence ?? [],
        createdAt: now,
        updatedAt: now,
    }));
    return { goals, contradictions };
}
/**
 * Register `metacog_merge_tree`.
 *
 * @param env - shared tool environment.
 */
export function metacogMergeTreeTool(env) {
    return defineMetacogTool({
        name: 'metacog_merge_tree',
        description: 'Fold a candidate goal tree into the main tree. One workspace holds one tree, and a ' +
            'confirmed tree is never re-derived because that would invalidate every past judgement — ' +
            'this is how the yardstick grows instead. Duplicates are reconciled by title (the main ' +
            'node keeps its id and the candidate\'s links are remapped), new nodes are added, and the ' +
            'act lands as one `merge_trees` audit entry. Without `confirm: true` it only previews what ' +
            'would happen. Use it when a new scan surfaced a whole line of work that belongs under no ' +
            'existing node; do NOT use it because documents were edited.',
        parameters: {
            type: 'object',
            properties: {
                expectedVersion: { type: 'integer', description: 'Version read from goal_tree_view.' },
                reason: {
                    type: 'string',
                    description: 'Why the two trees are being merged. Required and audited: this is the record of ' +
                        'why the yardstick grew.',
                },
                strategy: {
                    type: 'string',
                    enum: ['keep-main', 'take-candidate'],
                    description: 'How to resolve a node present on both sides. keep-main (default) keeps the main ' +
                        'tree\'s wording; take-candidate replaces it while keeping the main id.',
                },
                rootTitle: {
                    type: 'string',
                    description: 'The candidate tree\'s own root goal. Required.',
                },
                goals: {
                    type: 'array',
                    description: 'Candidate goals below its root. Depth 1 and deeper.',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string' },
                            parentId: { type: 'string' },
                            depth: { type: 'integer', minimum: 1 },
                            title: { type: 'string' },
                            description: { type: 'string' },
                            successCriteria: { type: 'array', items: { type: 'string' } },
                            evidence: { type: 'array', items: { type: 'string' } },
                        },
                        required: ['id', 'depth', 'title'],
                        additionalProperties: false,
                    },
                },
                contradictions: {
                    type: 'array',
                    description: 'Candidate contradictions. Their goal references are remapped on merge.',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string' },
                            primaryGoalId: { type: 'string' },
                            relatedGoalIds: { type: 'array', items: { type: 'string' } },
                            relatedGoals: {
                                type: 'array',
                                description: '跨目标张力权重（0–1）；与 relatedGoalIds 配套，合并时原样保留。',
                                items: {
                                    type: 'object',
                                    properties: {
                                        goalId: { type: 'string' },
                                        weight: { type: 'number', minimum: 0, maximum: 1 },
                                    },
                                    required: ['goalId', 'weight'],
                                    additionalProperties: false,
                                },
                            },
                            type: {
                                type: 'string',
                                enum: [...ContradictionTypeSchema.options],
                            },
                            title: { type: 'string' },
                            description: { type: 'string' },
                            poleA: { type: 'string' },
                            poleB: { type: 'string' },
                            evidence: { type: 'array', items: { type: 'string' } },
                        },
                        required: ['id', 'primaryGoalId', 'title', 'poleA', 'poleB'],
                        additionalProperties: false,
                    },
                },
                confirm: {
                    type: 'boolean',
                    description: 'Must be true to write. Absent or false only previews the merge and reports what ' +
                        'would change, which is the safe default for an operation that reshapes the yardstick.',
                },
                userConfirmed: {
                    type: 'boolean',
                    description: 'Required true when the merge would modify the confirmed L0 root goal.',
                },
            },
            required: ['expectedVersion', 'reason', 'rootTitle'],
            additionalProperties: false,
        },
        outputSchema: { type: 'object' },
        async run(args, exec) {
            const input = (args ?? {});
            if (typeof input.expectedVersion !== 'number') {
                throw new GateError('INVALID_ARGS', 'expectedVersion is required and must be an integer');
            }
            const reason = (input.reason ?? '').trim();
            if (reason.length === 0) {
                throw new GateError('REASON_REQUIRED', 'a merge must state why; it reshapes the yardstick every past judgement was measured ' +
                    'against, so the reason is what makes that answerable later.');
            }
            const rootTitle = (input.rootTitle ?? '').trim();
            if (rootTitle.length === 0) {
                throw new GateError('INVALID_ARGS', 'rootTitle is required: a candidate tree needs a root.');
            }
            const { projectId, store } = await loadProject(env, exec);
            const current = await store.readState(projectId);
            if (current === undefined || current.confirmed !== true) {
                throw new GateError('NOT_CONFIRMED', 'there is no confirmed tree to merge into. Run goal_tree_confirm first: a merge grows ' +
                    'an existing yardstick, it does not create one.');
            }
            const now = new Date().toISOString();
            const candidate = materialiseCandidate(projectId, {
                rootTitle,
                ...(input.goals === undefined ? {} : { goals: input.goals }),
                ...(input.contradictions === undefined ? {} : { contradictions: input.contradictions }),
            }, now);
            const merged = mergeTrees(current, {
                projectId,
                version: 0,
                confirmed: true,
                goals: candidate.goals,
                contradictions: candidate.contradictions,
                createdAt: now,
                updatedAt: now,
            }, { ...(input.strategy === undefined ? {} : { strategy: input.strategy }), now });
            const shapeProblems = checkMergedShape(merged.goals);
            if (shapeProblems.length > 0) {
                throw new GateError('TREE_SHAPE', `the merge would produce an invalid tree: ${shapeProblems.join('; ')}. ` +
                    'Fix the candidate\'s depth or parent references and retry.', { problems: shapeProblems });
            }
            const changed = merged.report.addedGoalIds.length > 0 ||
                merged.report.addedContradictionIds.length > 0 ||
                merged.report.replacedGoalIds.length > 0;
            if (input.confirm !== true) {
                return {
                    projectId,
                    mode: 'preview',
                    version: current.version,
                    report: merged.report,
                    wouldChange: changed,
                    note: changed
                        ? '这是预览，没有写入。确认无误后加 confirm: true 再调一次。'
                        : '候选树与主树没有差异，合并不会改变任何东西。',
                };
            }
            if (!changed) {
                // Nothing to commit: a version bump with no change would make the audit
                // log claim a merge that never happened.
                return {
                    projectId,
                    mode: 'merged',
                    version: current.version,
                    auditEntryId: '',
                    report: merged.report,
                    note: '候选树与主树没有差异，未写入。',
                };
            }
            const commit = await store.commit(projectId, {
                expectedVersion: input.expectedVersion,
                goals: merged.goals,
                contradictions: merged.contradictions,
                reason: `${reason} — 合并候选树「${rootTitle}」：新增 ${merged.report.addedGoalIds.length} 个目标、${merged.report.addedContradictionIds.length} 条矛盾，去重 ${merged.report.keptGoalIds.length} 个`,
                action: 'merge_trees',
                actor: input.userConfirmed === true ? 'user_confirmed' : 'manual_tool',
                targetIds: [...merged.report.addedGoalIds, ...merged.report.addedContradictionIds],
                evidence: [],
            });
            return {
                projectId,
                mode: 'merged',
                version: commit.state.version,
                auditEntryId: commit.audit.id,
                report: merged.report,
            };
        },
    });
}
