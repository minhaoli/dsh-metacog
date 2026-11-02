/** Resolve a goal reference by id or exact title. */
function findGoal(goals, ref) {
    if (ref === undefined)
        return undefined;
    return goals.find((goal) => goal.id === ref) ?? goals.find((goal) => goal.title === ref);
}
/** Resolve a contradiction reference by id or exact title. */
function findContradiction(nodes, ref) {
    if (ref === undefined)
        return undefined;
    return nodes.find((node) => node.id === ref) ?? nodes.find((node) => node.title === ref);
}
/**
 * Apply a batch of user-stated revisions to a tree.
 *
 * Pure: returns new arrays and never mutates the input, so the caller decides
 * whether to commit. Nothing here reads the filesystem — a revision is applied
 * because the user said so, not because evidence was found.
 *
 * @param state - current tree.
 * @param requests - the revisions to apply.
 * @param now - ISO timestamp for `updatedAt`.
 * @returns the new nodes plus what was skipped and why.
 */
export function applyRevisions(state, requests, now) {
    const goals = state.goals.map((goal) => ({ ...goal }));
    const contradictions = state.contradictions.map((node) => ({ ...node }));
    const changedGoalIds = [];
    const changedContradictionIds = [];
    const skipped = [];
    const touchGoal = (goal) => {
        goal.updatedAt = now;
        if (!changedGoalIds.includes(goal.id))
            changedGoalIds.push(goal.id);
    };
    const touchContradiction = (node) => {
        node.updatedAt = now;
        if (!changedContradictionIds.includes(node.id))
            changedContradictionIds.push(node.id);
    };
    for (const request of requests) {
        switch (request.kind) {
            case 'goal_changed': {
                const goal = findGoal(goals, request.target);
                if (goal === undefined) {
                    skipped.push({ kind: request.kind, target: request.target, reason: 'goal not found' });
                    break;
                }
                if (request.newTitle !== undefined)
                    goal.title = request.newTitle;
                if (request.newDescription !== undefined)
                    goal.description = request.newDescription;
                if (request.paths !== undefined)
                    goal.paths = [...request.paths];
                touchGoal(goal);
                break;
            }
            case 'goal_achieved': {
                const goal = findGoal(goals, request.target);
                if (goal === undefined) {
                    skipped.push({ kind: request.kind, target: request.target, reason: 'goal not found' });
                    break;
                }
                goal.status = 'done';
                touchGoal(goal);
                break;
            }
            case 'goal_shelved': {
                const goal = findGoal(goals, request.target);
                if (goal === undefined) {
                    skipped.push({ kind: request.kind, target: request.target, reason: 'goal not found' });
                    break;
                }
                goal.status = 'blocked';
                touchGoal(goal);
                break;
            }
            case 'contradiction_resolved': {
                const node = findContradiction(contradictions, request.target);
                if (node === undefined) {
                    skipped.push({ kind: request.kind, target: request.target, reason: 'contradiction not found' });
                    break;
                }
                // A resolved tension stops blocking: intensity drops to the floor and
                // the node keeps its history rather than being deleted. Deleting would
                // erase the record of a real problem the project once had.
                node.intensity = 1;
                node.resolutionHint = request.newDescription ?? node.resolutionHint;
                touchContradiction(node);
                break;
            }
            case 'contradiction_intensified': {
                const node = findContradiction(contradictions, request.target);
                if (node === undefined) {
                    skipped.push({ kind: request.kind, target: request.target, reason: 'contradiction not found' });
                    break;
                }
                if (request.intensity !== undefined)
                    node.intensity = request.intensity;
                touchContradiction(node);
                break;
            }
            case 'contradiction_added': {
                const spec = request.create;
                if (spec === undefined) {
                    skipped.push({ kind: request.kind, reason: 'create payload missing' });
                    break;
                }
                const primary = findGoal(goals, spec.primaryGoalRef);
                if (primary === undefined) {
                    skipped.push({
                        kind: request.kind,
                        target: spec.primaryGoalRef,
                        reason: 'primary goal not found',
                    });
                    break;
                }
                const related = (spec.relatedGoalRefs ?? [])
                    .map((ref) => findGoal(goals, ref))
                    .filter((goal) => goal !== undefined);
                contradictions.push({
                    id: `C_${Math.random().toString(36).slice(2, 12)}`,
                    projectId: state.projectId,
                    parentId: null,
                    primaryGoalId: primary.id,
                    relatedGoalIds: related.map((goal) => goal.id),
                    type: spec.type ?? 'unclassified',
                    confirmedByUser: true,
                    title: spec.title,
                    description: spec.consequence ?? '',
                    poleA: spec.poleA,
                    poleB: spec.poleB,
                    intensity: request.intensity ?? null,
                    trend: 'unknown',
                    // `rationale` answers a different question from `description`: the
                    // latter states what goes wrong, the former why the tension is
                    // structural. Copying one into the other makes the node look like it
                    // has two independent explanations when it has one sentence.
                    rationale: spec.rationale ?? '',
                    resolutionHint: '',
                    evidence: spec.evidence ?? [],
                    createdAt: now,
                    updatedAt: now,
                });
                changedContradictionIds.push(contradictions[contradictions.length - 1].id);
                break;
            }
            case 'root_changed': {
                const root = goals.find((goal) => goal.depth === 0);
                if (root === undefined) {
                    skipped.push({ kind: request.kind, reason: 'no root node' });
                    break;
                }
                if (request.newTitle !== undefined)
                    root.title = request.newTitle;
                if (request.newDescription !== undefined)
                    root.description = request.newDescription;
                touchGoal(root);
                break;
            }
            default: {
                skipped.push({ kind: request.kind, reason: 'unknown revision kind' });
            }
        }
    }
    return {
        goals,
        contradictions,
        outcome: { version: state.version, changedGoalIds, changedContradictionIds, skipped },
    };
}
/** Audit action for a revision, so the log distinguishes it from a tool edit. */
export function auditActionFor(kind) {
    switch (kind) {
        case 'root_changed':
            return 'update_l0';
        case 'contradiction_resolved':
            return 'resolve_intervention';
        case 'contradiction_added':
        case 'contradiction_intensified':
            return 'reclassify_contradiction';
        default:
            return 'update_l1';
    }
}
/** Human-readable summary used in the audit entry and the reply. */
export function describeRevision(request) {
    switch (request.kind) {
        case 'goal_changed': {
            // A description-only edit used to read "改为「(未改名)」", which looks
            // like the edit failed. Say what actually changed.
            const renamed = request.newTitle !== undefined;
            const reworded = request.newDescription !== undefined;
            if (renamed && reworded)
                return `目标「${request.target}」改为「${request.newTitle}」并更新描述`;
            if (renamed)
                return `目标「${request.target}」改为「${request.newTitle}」`;
            if (reworded)
                return `目标「${request.target}」描述已更新`;
            return `目标「${request.target}」未指定改动`;
        }
        case 'goal_achieved':
            return `目标「${request.target}」已达成`;
        case 'goal_shelved':
            return `目标「${request.target}」暂停`;
        case 'contradiction_resolved':
            return `矛盾「${request.target}」已解决`;
        case 'contradiction_intensified':
            return `矛盾「${request.target}」强度更新为 ${request.intensity ?? '未知'}`;
        case 'contradiction_added':
            return `新增矛盾「${request.create?.title ?? '(未命名)'}」`;
        case 'root_changed': {
            const renamed = request.newTitle !== undefined;
            const reworded = request.newDescription !== undefined;
            if (renamed && reworded)
                return `根目标改为「${request.newTitle}」并更新描述`;
            if (renamed)
                return `根目标改为「${request.newTitle}」`;
            if (reworded)
                return '根目标描述已更新';
            return '根目标未指定改动';
        }
        default:
            return String(request.kind);
    }
}
