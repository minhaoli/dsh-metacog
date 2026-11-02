import { GateError } from '../governance.js';
import { generateReport } from '../report.js';
import { defineMetacogTool, loadProject } from './shared.js';
/** Report cadences the tool accepts. */
const REPORT_TYPES = ['daily', 'weekly', 'monthly'];
/**
 * `generate_report`: build one daily/weekly/monthly report over the recorded
 * stream, bound to the tree version it read.
 *
 * @param env - tool environment.
 */
export function generateReportTool(env) {
    return defineMetacogTool({
        name: 'generate_report',
        description: 'Generate a periodic report over this project\'s recorded activity stream. It states what ' +
            'the period was made of — which directories were touched, with which actions, producing ' +
            'which files, with the slice of time each group covers — preceded by the monitor\'s own ' +
            'counts. Facts only: the report never advises, and a file name appears only when an ' +
            'activity\'s evidence carried its path. Prose is capped at 400 (daily) / 600 (weekly) / ' +
            '800 (monthly) characters, least significant activity groups are cut first, and the body ' +
            'says 已截断 rather than silently overflowing. Calibration status, audit coverage, ' +
            'undecidable reasons and threshold validation are one-line placeholders until milestones ' +
            'A and B land. Each report is bound to the tree version it read, and a readable copy is ' +
            'written to <storage>/reports/markdown/<type>-<YYYY-MM-DD>.md. `collapseDone` folds ' +
            'finished subtrees in the goal section; it is a presentation switch only and changes no ' +
            'stored data. It defaults to false, so the full tree is listed until a caller asks for ' +
            'the folded view.',
        parameters: {
            type: 'object',
            properties: {
                type: {
                    type: 'string',
                    enum: [...REPORT_TYPES],
                    description: 'daily (last day), weekly (last 7 days) or monthly (last 30 days).',
                },
                collapseDone: {
                    type: 'boolean',
                    description: 'Fold every subtree whose goals are all done into one summary line on its parent. ' +
                        'Presentation only: no stored goal, contradiction or activity is changed. ' +
                        'Default false (list every goal; a done goal is merely marked).',
                },
            },
            required: ['type'],
            additionalProperties: false,
        },
        outputSchema: {
            type: 'object',
            properties: {
                reportId: { type: 'string' },
                type: { type: 'string' },
                goalTreeVersion: { type: 'number' },
                periodStart: { type: 'string' },
                periodEnd: { type: 'string' },
                observationIds: { type: 'array', items: { type: 'string' } },
                signalIds: { type: 'array', items: { type: 'string' } },
                interventionIds: { type: 'array', items: { type: 'string' } },
                markdown: { type: 'string' },
            },
        },
        async run(args, exec) {
            const input = args;
            const type = input.type;
            if (type !== 'daily' && type !== 'weekly' && type !== 'monthly') {
                throw new GateError('INVALID_REPORT_TYPE', `report type must be one of ${REPORT_TYPES.join(', ')}; got ${JSON.stringify(type)}.`);
            }
            // Presentation-only, and false unless asked: the tool never changes what a
            // report is built from, only how the goal section is laid out.
            const collapseDone = input.collapseDone === true;
            const { projectId, store } = await loadProject(env, exec);
            const state = await store.readState(projectId);
            if (state === undefined) {
                throw new GateError('NOT_INITIALIZED', 'this project has no metacognitive state yet; run goal_tree_init and goal_tree_confirm first.');
            }
            const report = await generateReport({
                store,
                state,
                projectId,
                config: env.config,
                type,
                collapseDone,
            });
            return {
                reportId: report.id,
                type: report.type,
                goalTreeVersion: report.goalTreeVersion,
                periodStart: report.periodStart,
                periodEnd: report.periodEnd,
                observationIds: report.observationIds,
                signalIds: report.signalIds,
                interventionIds: report.interventionIds,
                markdown: report.markdown,
            };
        },
    });
}
