/** Normalize a title for duplicate detection. */
function titleKey(title) {
    return title
        .replace(/\s+/g, '')
        .replace(/[（）()【】\[\]：:、，,。.！!？?—\-_/]/g, '')
        .toLowerCase();
}
/**
 * Pick which root survives when the two trees state different purposes.
 *
 * The main tree's root wins unless the caller explicitly says otherwise: the
 * main tree is what every past judgement was measured against, so replacing its
 * root silently would reinterpret history.
 *
 * @param strategy - the caller's choice.
 * @returns which side's root survives.
 */
export function resolveRoot(strategy) {
    return strategy === 'take-candidate' ? 'candidate' : 'main';
}
/**
 * Merge a candidate tree into the main tree.
 *
 * The rules, in order:
 *
 * 1. The root: one L0 survives, chosen by {@link resolveRoot}. The other root
 *    becomes an L1 under it (so its content is not lost) unless its title
 *    duplicates an existing node, in which case it is dropped and reported.
 * 2. Same id: the main node wins unless the strategy says otherwise.
 * 3. Same normalized title: treated as the same goal. The main node keeps its
 *    id and the candidate's references are remapped onto it, so no link dangles.
 * 4. Otherwise the candidate node is added, keeping its id when free.
 * 5. Contradictions follow their goals through the same remapping; a
 *    contradiction whose primary goal was dropped is reported, not silently
 *    kept pointing at nothing.
 *
 * @param main - the tree that stays.
 * @param candidate - the tree being folded in.
 * @param options - root strategy and timestamp for `updatedAt`.
 * @returns the merged arrays plus a report.
 */
export function mergeTrees(main, candidate, options) {
    const strategy = options.strategy ?? 'keep-main';
    const now = options.now;
    const addedGoalIds = [];
    const keptGoalIds = [];
    const replacedGoalIds = [];
    const addedContradictionIds = [];
    const keptContradictionIds = [];
    const remappedReferences = [];
    const skipped = [];
    const mainGoals = main.goals.map((goal) => ({ ...goal }));
    const mainRoot = mainGoals.find((goal) => goal.depth === 0);
    const candidateRoot = candidate.goals.find((goal) => goal.depth === 0);
    const survivingRoot = resolveRoot(strategy);
    /** Candidate goal id -> id it now carries in the merged tree. */
    const idMap = new Map();
    const byTitle = new Map(mainGoals.map((goal) => [titleKey(goal.title), goal]));
    const usedIds = new Set(mainGoals.map((goal) => goal.id));
    // The root that does not survive becomes an L1 under the surviving root, so
    // its subtree and wording are preserved rather than discarded.
    //
    // Demoting the root pushes its whole subtree down by one level. Forgetting
    // that is not cosmetic: a candidate root at depth 0 with children at depth 1
    // would leave those children at the same depth as their demoted parent, and
    // the shape check would (correctly) refuse the result.
    let depthShift = 0;
    if (candidateRoot !== undefined && survivingRoot === 'main' && mainRoot !== undefined) {
        const existing = byTitle.get(titleKey(candidateRoot.title));
        if (existing !== undefined) {
            // Same stated purpose: treat it as the same node, keep main's id.
            idMap.set(candidateRoot.id, existing.id);
            keptGoalIds.push(existing.id);
            remappedReferences.push({ from: candidateRoot.id, to: existing.id });
        }
        else {
            const demoted = {
                ...candidateRoot,
                depth: 1,
                parentId: mainRoot.id,
                updatedAt: now,
            };
            mainGoals.push(demoted);
            usedIds.add(demoted.id);
            byTitle.set(titleKey(demoted.title), demoted);
            idMap.set(candidateRoot.id, demoted.id);
            addedGoalIds.push(demoted.id);
            depthShift = 1;
        }
    }
    else if (candidateRoot !== undefined) {
        idMap.set(candidateRoot.id, candidateRoot.id);
    }
    // Every remaining candidate goal, shallowest first so parents are mapped
    // before the children that reference them.
    const ordered = [...candidate.goals]
        .filter((goal) => goal.id !== candidateRoot?.id)
        .sort((left, right) => left.depth - right.depth);
    for (const goal of ordered) {
        const existingById = mainGoals.find((node) => node.id === goal.id);
        const existingByTitle = byTitle.get(titleKey(goal.title));
        if (existingById !== undefined) {
            idMap.set(goal.id, existingById.id);
            if (strategy === 'take-candidate') {
                // Replace content but keep identity and place in the tree: an id that
                // moved would orphan every judgement that named it.
                existingById.title = goal.title;
                existingById.description = goal.description;
                existingById.successCriteria = goal.successCriteria;
                existingById.evidence = goal.evidence;
                existingById.alignment = goal.alignment;
                existingById.updatedAt = now;
                replacedGoalIds.push(existingById.id);
            }
            else {
                keptGoalIds.push(existingById.id);
            }
            remappedReferences.push({ from: goal.id, to: existingById.id });
            continue;
        }
        if (existingByTitle !== undefined) {
            // Same goal, different id. Keep the main id and point the candidate's
            // children at it, otherwise the merge would duplicate the node and split
            // its evidence across two ids.
            idMap.set(goal.id, existingByTitle.id);
            if (strategy === 'take-candidate') {
                // Content comes from the candidate, identity stays with main.
                existingByTitle.title = goal.title;
                existingByTitle.description = goal.description;
                existingByTitle.successCriteria = goal.successCriteria;
                existingByTitle.evidence = goal.evidence;
                existingByTitle.alignment = goal.alignment;
                existingByTitle.updatedAt = now;
                replacedGoalIds.push(existingByTitle.id);
            }
            else {
                keptGoalIds.push(existingByTitle.id);
            }
            remappedReferences.push({ from: goal.id, to: existingByTitle.id });
            continue;
        }
        const parentRef = goal.parentId === null ? undefined : idMap.get(goal.parentId);
        if (goal.parentId !== null && parentRef === undefined) {
            skipped.push({
                title: goal.title,
                reason: `parent ${goal.parentId} was not merged, so this node has no place in the tree`,
            });
            continue;
        }
        const id = usedIds.has(goal.id) ? `${goal.id}_m${mainGoals.length}` : goal.id;
        const merged = {
            ...goal,
            id,
            // Shifted with the demoted root so the chain stays contiguous.
            depth: goal.depth + depthShift,
            parentId: parentRef ?? null,
            projectId: main.projectId,
            updatedAt: now,
        };
        mainGoals.push(merged);
        usedIds.add(id);
        byTitle.set(titleKey(merged.title), merged);
        idMap.set(goal.id, id);
        addedGoalIds.push(id);
    }
    // Contradictions: remap their goal references, drop none silently.
    const mainContradictions = main.contradictions.map((node) => ({ ...node }));
    const contradictionByTitle = new Map(mainContradictions.map((node) => [titleKey(node.title), node]));
    const remap = (id) => idMap.get(id) ?? id;
    for (const node of candidate.contradictions) {
        const existing = contradictionByTitle.get(titleKey(node.title));
        if (existing !== undefined) {
            keptContradictionIds.push(existing.id);
            continue;
        }
        const primaryGoalId = remap(node.primaryGoalId);
        const primaryExists = primaryGoalId !== undefined && mainGoals.some((goal) => goal.id === primaryGoalId);
        if (!primaryExists) {
            skipped.push({
                title: node.title,
                reason: `its primary goal ${node.primaryGoalId} was not merged, so the tension would point at nothing`,
            });
            continue;
        }
        const relatedGoalIds = node.relatedGoalIds
            .map((id) => remap(id))
            .filter((id) => id !== undefined && mainGoals.some((goal) => goal.id === id));
        const merged = {
            ...node,
            projectId: main.projectId,
            primaryGoalId,
            relatedGoalIds,
            updatedAt: now,
        };
        mainContradictions.push(merged);
        contradictionByTitle.set(titleKey(merged.title), merged);
        addedContradictionIds.push(merged.id);
    }
    return {
        goals: mainGoals,
        contradictions: mainContradictions,
        report: {
            addedGoalIds,
            keptGoalIds,
            replacedGoalIds,
            addedContradictionIds,
            keptContradictionIds,
            remappedReferences,
            skipped,
        },
    };
}
/**
 * Check the merged result is structurally sound before anyone commits it.
 *
 * The merge itself cannot guarantee this: a candidate tree can be internally
 * valid yet produce a cycle once its root is demoted under the main root.
 *
 * @param goals - the merged goal list.
 * @returns problems found, empty when the shape is sound.
 */
export function checkMergedShape(goals) {
    const problems = [];
    const roots = goals.filter((goal) => goal.depth === 0);
    if (roots.length !== 1) {
        problems.push(`a tree must have exactly one root; found ${roots.length}`);
    }
    const byId = new Map(goals.map((goal) => [goal.id, goal]));
    for (const goal of goals) {
        if (goal.depth === 0) {
            if (goal.parentId !== null)
                problems.push(`root "${goal.title}" must not have a parent`);
            continue;
        }
        if (goal.parentId === null) {
            problems.push(`"${goal.title}" is at depth ${goal.depth} but has no parent`);
            continue;
        }
        const parent = byId.get(goal.parentId);
        if (parent === undefined) {
            problems.push(`"${goal.title}" points at missing parent ${goal.parentId}`);
            continue;
        }
        if (parent.depth !== goal.depth - 1) {
            problems.push(`"${goal.title}" is at depth ${goal.depth} under "${parent.title}" at depth ${parent.depth}`);
        }
    }
    // Cycle detection: walk up from each node.
    for (const goal of goals) {
        const seen = new Set();
        let current = goal;
        while (current !== undefined && current.parentId !== null) {
            if (seen.has(current.id)) {
                problems.push(`cycle detected through "${goal.title}"`);
                break;
            }
            seen.add(current.id);
            current = byId.get(current.parentId);
        }
    }
    return [...new Set(problems)];
}
