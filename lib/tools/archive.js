/**
 * `metacog_archive`: move a live stream into a dated archive.
 *
 * Exists because the live streams are working sets, not histories. A rule that
 * fired on `read (tool call)` produced 1459 rows that no longer describe anything
 * the monitor believes; left in place they dominate every level count and repeat
 * tally, so the escalation statistics stop meaning what they claim.
 *
 * Archiving rather than deleting keeps the record of what the monitor once said,
 * which is exactly the evidence needed to argue that a rule got better.
 *
 * One tool, two streams, asymmetric defaults:
 *
 * - **Signals are archived by default.** They are the monitor's opinions, they go
 *   stale fastest, and reconciling them costs nothing.
 * - **Activities require an explicit opt-in.** They are the primary evidence — what
 *   actually happened. Archived activities mean every past judgement loses its
 *   record of what it was judging, so a report can no longer be re-derived. Saying
 *   that out loud once is worth the extra parameter.
 *
 * @module dsh-metacog/tools/archive
 */
import { GateError } from '../governance.js';
import { defineMetacogTool, loadProject } from './shared.js';
/** Register `metacog_archive`. */
export function metacogArchiveTool(env) {
    return defineMetacogTool({
        name: 'metacog_archive',
        description: 'Move a live stream into a dated archive file and empty it. Nothing is deleted — the ' +
            'archive stays on disk. Signals are archived by default: they are the monitor\'s own ' +
            'opinions, they go stale, and they inflate every level count while they sit in the live ' +
            'stream. Activities are only archived when `includeActivities` is true, because they are ' +
            'the primary evidence: after that, every past judgement loses the record of what it was ' +
            'judging and a report can no longer be re-derived from the data. Use this when the stream ' +
            'contains rows the current rules would no longer produce.',
        parameters: {
            type: 'object',
            properties: {
                reason: {
                    type: 'string',
                    description: '为什么归档。会写在归档文件旁边，供日后追溯。',
                },
                includeActivities: {
                    type: 'boolean',
                    description: 'Also archive the activity stream. Default false. Turning it on means past ' +
                        'judgements can no longer be traced back to the activities they judged.',
                },
            },
            required: ['reason'],
            additionalProperties: false,
        },
        outputSchema: { type: 'object' },
        async run(args, exec) {
            const input = (args ?? {});
            const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
            if (reason.length === 0) {
                throw new GateError('INVALID_ARGS', 'reason is required: an archive without a stated reason is indistinguishable from data loss');
            }
            const includeActivities = input.includeActivities === true;
            const { projectId, store } = await loadProject(env, exec);
            const state = await store.readState(projectId);
            if (state === undefined) {
                throw new GateError('NOT_INITIALIZED', 'no tree exists for this project; nothing to archive against');
            }
            const paths = [];
            const signals = await store.archiveSignals(projectId, reason);
            if (signals.path !== null && signals.path !== undefined)
                paths.push(signals.path);
            let activities = 0;
            if (includeActivities) {
                const moved = await store.archiveActivities(projectId, reason);
                activities = moved.archived;
                if (moved.path !== null && moved.path !== undefined)
                    paths.push(moved.path);
            }
            const parts = [];
            if (signals.archived > 0)
                parts.push(`${signals.archived} 条信号`);
            if (activities > 0)
                parts.push(`${activities} 条活动`);
            if (parts.length === 0) {
                return {
                    projectId,
                    signals: 0,
                    activities: 0,
                    paths,
                    reason,
                    next: '要归档的流都是空的，没有可移动的内容。',
                };
            }
            return {
                projectId,
                signals: signals.archived,
                activities,
                paths,
                reason,
                next: `已归档 ${parts.join('、')}。` +
                    (includeActivities
                        ? ' 注意：活动原文已移出活动流，历史判定不再能追溯到它判的是什么。'
                        : ' 等级统计与重复计数从零开始，历史仍在归档文件里。'),
            };
        },
    });
}
