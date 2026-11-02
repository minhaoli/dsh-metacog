/**
 * `metacog_archive_milestone`: stamp the current tree and its judgement statistics.
 *
 * The tree snapshots itself on every commit, so the tree alone is not worth
 * archiving twice. What is missing is the pairing: these statistics were measured
 * against that tree. Half a year from now the useful question is not "what did the
 * tree say" but "when we changed it, did the judgements get better", and neither
 * half answers that alone.
 *
 * Deliberately manual. A milestone is a decision — structure was confirmed, a phase
 * ended, thresholds moved. Stamping one on every commit would fill a directory
 * nobody opens, and a directory nobody opens is indistinguishable from no archive.
 *
 * @module dsh-metacog/tools/milestone
 */
import { GateError } from '../governance.js';
import { defineMetacogTool, loadProject } from './shared.js';
/** Register `metacog_archive_milestone`. */
export function metacogArchiveMilestoneTool(env) {
    return defineMetacogTool({
        name: 'metacog_archive_milestone',
        description: 'Write a milestone record: the current goal tree plus the judgement statistics measured ' +
            'against it. Use it when something changes the yardstick — after goal_tree_confirm, when a ' +
            'phase ends, or before changing thresholds — so a later comparison of "did the judgement ' +
            'get better" has both halves. Nothing is deleted and the tree is unaffected. Not needed on ' +
            'every commit: the snapshot stream already covers that.',
        parameters: {
            type: 'object',
            properties: {
                label: {
                    type: 'string',
                    description: 'Short name for this milestone, e.g. "v4-confirmed" or "before-beta-0.4".',
                },
                note: {
                    type: 'string',
                    description: 'Optional. Why this point is worth remembering, for a reader months later. ' +
                        'Leaving it out is allowed: the label and the captured snapshot already ' +
                        'identify what was archived.',
                },
            },
            required: ['label'],
            additionalProperties: false,
        },
        outputSchema: { type: 'object' },
        async run(args, exec) {
            const input = (args ?? {});
            const label = typeof input.label === 'string' ? input.label.trim() : '';
            const note = typeof input.note === 'string' ? input.note.trim() : '';
            if (label.length === 0) {
                throw new GateError('INVALID_ARGS', 'label is required: an unnamed milestone cannot be found later');
            }
            const { projectId, store } = await loadProject(env, exec);
            const state = await store.readState(projectId);
            if (state === undefined) {
                throw new GateError('NOT_INITIALIZED', 'no tree exists for this project; there is nothing to archive');
            }
            const outcome = await store.archiveMilestone(projectId, label, note);
            return {
                projectId,
                version: outcome.version,
                path: outcome.path,
                next: `已归档版本 ${outcome.version} 的快照与判定统计，位于 ${outcome.path}。`,
            };
        },
    });
}
