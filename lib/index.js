import { resolveConfig } from './settings.js';
import { createToolEnvironment, deriveProjectId } from './tools/shared.js';
import { homedir, tmpdir } from 'node:os';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { installCollector } from './collect.js';
import { installApi } from './api.js';
import { installScheduler, installRealtimeScheduler } from './schedule.js';
import { installGate } from './gate.js';
import { buildInitKickoff, deliverToSession, deliverViaController, ensureMetacogSession, followupToAgent, inspectMetacogSession, registerInitCommand, resolveInheritedModel, resolveWorkspaceName, } from './session.js';
import { MetacogStore } from './data/store.js';
import { generateReport, generateWorkspaceReport, renderPromptBlock } from './report.js';
import { runActivityCheck, publishDrafts } from './analysis/service.js';
import { coverageHint, pendingInterventionHint } from './analysis/escalation.js';
import { scoreTurn } from './analysis/score.js';
import { declarePlanTool, revisePlanTool } from './tools/plan.js';
import { classifyTool } from './analysis/signals/index.js';
import { assessWindow, judgmentFromDraft, reviewPendingJudgments, ReviewFailureNotifier, splitDraftsByPrecision, isBypassSampled } from './analysis/judgment.js';
import { goalTreeConfirmTool, goalTreeInitTool, goalTreeViewTool, } from './tools/tree-lifecycle.js';
import { contradictionTreeEditTool, goalTreeEditTool } from './tools/tree-edit.js';
import { metacogScanTool } from './tools/scan.js';
import { metacogAskUserTool } from './tools/ask.js';
import { metacogDraftCriteriaTool } from './tools/criteria.js';
import { metacogReadDocumentTool } from './tools/document.js';
import { metacogArchiveTool } from './tools/archive.js';
import { deleteDirectories, metacogPurgeTool } from './tools/purge.js';
import { metacogArchiveMilestoneTool } from './tools/milestone.js';
import { describeChanges, diffFingerprints, fingerprintTree } from './evidence/changes.js';
import { generateReportTool } from './tools/report.js';
import { metacogReviseTool } from './tools/revise.js';
import { metacogMergeTreeTool } from './tools/merge.js';
import { CONTRADICTION_USAGE, GOAL_USAGE, describeOutcome, parseContradictionCommand, parseGoalCommand, } from './commands/edit.js';
import { checkDriftTool, contradictionObserveTool, pathsFromEvidence, resolveInterventionTool, } from './tools/drift.js';
/** Cordis plugin name used in loader diagnostics. */
export const name = 'dsh-metacog';
/**
 * Hard dependencies only.
 *
 * Cordis gates plugin activation on EVERY name listed here: `Fiber._refresh`
 * computes an epoch over `Object.keys(this.inject)` and goes INACTIVE as soon as
 * one of them has no implementation, which unloads the plugin entirely. Listing
 * an optional service here would therefore make the plugin vanish on any host
 * that lacks it — the opposite of what an optional dependency should do.
 *
 * So this list must stay minimal: `tools` is the one thing a monitor cannot work
 * without. Everything else is probed through `ctx.get`.
 *
 * `webServer` is the one exception, and it is a hard dependency on purpose: an
 * undeclared service is not linked into this context, so `ctx.get('webServer')`
 * answered `undefined` while the Web GUI was demonstrably serving requests, and
 * the settings card's route silently never registered. Declaring it costs the
 * plugin on a headless host that has no browser carrier — where the card could
 * not render anyway.
 */
export const inject = ['tools', 'webServer'];
/**
 * Whether a root is a throwaway directory rather than a workspace.
 *
 * Test fixtures land in the OS temp directory and are deleted moments later.
 * Recording them made the project index grow without bound — 30 of 31 entries
 * were dead temp paths at one point — which turned a helpful "here is what to
 * sweep" list into a list a reader has to filter by eye.
 *
 * Deliberately a path test, not an existence test: a real workspace on a
 * momentarily unmounted drive must survive to be swept later.
 *
 * Exported so the rule can be asserted directly. Reaching it through a full
 * mount plus a confirmed tree exercised the plumbing rather than the rule, and a
 * mutant that deleted the guard went unnoticed.
 *
 * @param projectRoot - absolute path a project was registered under.
 * @param tempDir - the OS temp directory, injectable for tests.
 */
export function isDisposableRoot(projectRoot, tempDir = tmpdir()) {
    if (tempDir.length > 0) {
        const normalized = projectRoot.replace(/[\\/]+$/, '');
        const temp = tempDir.replace(/[\\/]+$/, '');
        // Equality as well as containment: nobody's workspace is the OS temp root
        // itself, and a project registered there is a fixture that named the
        // directory rather than a subdirectory of it.
        if (normalized === temp)
            return true;
        // `startsWith` alone would let a workspace literally named `<temp>foo` slip
        // through; requiring a separator after the temp prefix keeps "the temp
        // directory" from matching "a sibling whose name begins with the same letters".
        const prefix = temp.endsWith(sep) ? temp : `${temp}${sep}`;
        if (`${normalized}${sep}`.startsWith(prefix))
            return true;
    }
    // A `metacog-*` directory under any temp-like location is a fixture by naming
    // convention; the check is on the parent, not the workspace's own name.
    return /[\\/](Temp|tmp)[\\/]metacog-[^\\/]+$/i.test(projectRoot);
}
/** Host capabilities this plugin can use when present, but does not require. */
const OPTIONAL_CAPABILITIES = [
    'systemPrompt',
    'timer',
    'fs',
    'workingDirectory',
    'subagents',
    'agents',
];
/**
 * Live mounts by context.
 *
 * A WeakMap rather than a property on the host context: the context object
 * belongs to the loader and must not be mutated, and the weak key lets the
 * whole mount record disappear with its context.
 */
const mounts = new WeakMap();
/**
 * Read the mount published by {@link apply} for a context.
 *
 * @param ctx - the plugin context handed to `apply`.
 * @returns the mount, or `undefined` when the plugin is not mounted here
 *   (disabled by config, or a context that never ran `apply`).
 */
export function getMount(ctx) {
    return mounts.get(ctx);
}
/**
 * Probe optional host services.
 *
 * @param ctx - the live plugin context.
 * @returns which optional capabilities resolved.
 */
function detectCapabilities(ctx) {
    const report = {
        systemPrompt: ctx.get('systemPrompt') !== undefined,
        timer: ctx.get('timer') !== undefined,
        fs: ctx.get('fs') !== undefined,
        workingDirectory: ctx.get('workingDirectory') !== undefined,
        subagents: ctx.get('subagents') !== undefined,
        agents: ctx.get('agents') !== undefined,
    };
    // One-shot probe. Whether optional services resolve at mount time is a
    // deployment fact that cannot be settled statically: `subagents` in particular
    // is documented with `requiresUndefinedCheck`, so it may legitimately be
    // absent. Logging it once is the cheapest way to learn which branch of the
    // derivation design (LLM vs degraded) this host will take.
    const subagents = ctx.get('subagents');
    if (subagents !== undefined) {
        let providers = [];
        try {
            providers = subagents.list();
        }
        catch (error) {
            ctx.logger.warn(`[dsh-metacog] subagents.list() threw: ${String(error)}`);
        }
        ctx.logger.info(`[dsh-metacog] subagents: present, providers=[${providers.join(', ')}], ` +
            `maxDepth=${subagents.resolveMaxDepth?.(undefined) ?? 'unknown'}`);
    }
    else {
        ctx.logger.info('[dsh-metacog] subagents: absent; derivation will degrade to the two-step path');
    }
    const agents = ctx.get('agents');
    if (agents !== undefined) {
        let initiator = 'none';
        try {
            // During `apply` there is usually no initiating agent; this is the value
            // that matters for derivation later, so record it now as a baseline.
            initiator = agents.currentInitiator()?.id ?? 'none';
        }
        catch (error) {
            initiator = `threw:${String(error)}`;
        }
        ctx.logger.info(`[dsh-metacog] agents: present, initiator at mount=${initiator}`);
    }
    else {
        ctx.logger.info('[dsh-metacog] agents: absent; cannot obtain a parent agent handle');
    }
    return report;
}
/**
 * Register the plugin on a host context.
 *
 * Runs synchronously so the loader sees a deterministic mount; everything that
 * needs async setup is registered as an effect instead.
 *
 * @param ctx - the live plugin context.
 * @param rawConfig - the `config` field of this plugin's loader row.
 */
export function apply(ctx, rawConfig) {
    // The card writes its own override file rather than the profile patch, so the
    // effective config is the profile's with those overrides merged on top. A bad
    // override is reported and skipped instead of stopping the mount -- a settings
    // toggle must not be able to break startup.
    const resolved = resolveConfig(rawConfig);
    const config = resolved.config;
    if (resolved.applied) {
        ctx.logger.info('[dsh-metacog] settings from the card override the profile config');
    }
    if (resolved.problem !== undefined) {
        ctx.logger.warn(`[dsh-metacog] card settings ignored: ${resolved.problem}`);
    }
    if (!config.enabled) {
        ctx.logger.info('[dsh-metacog] disabled by config; nothing registered');
        return;
    }
    const capabilities = detectCapabilities(ctx);
    for (const capability of OPTIONAL_CAPABILITIES) {
        if (!capabilities[capability]) {
            // Report the gap once, at mount, as an accurate capability boundary.
            ctx.logger.info(`[dsh-metacog] host does not expose "${capability}"; related features stay inactive`);
        }
    }
    /** Everything this mount owns, released in one place. */
    const owned = [];
    let disposed = false;
    const release = (dispose) => {
        try {
            dispose();
        }
        catch (error) {
            // One failing disposer must not strand the rest.
            ctx.logger.warn(`[dsh-metacog] disposer threw during teardown: ${String(error)}`);
        }
    };
    const mount = {
        config,
        capabilities,
        claim(dispose) {
            if (!disposed) {
                owned.push(dispose);
                return;
            }
            // Registered after teardown started: honour the claim by releasing now.
            release(dispose);
        },
    };
    ctx.effect(() => async () => {
        if (disposed)
            return;
        disposed = true;
        // Reverse order mirrors construction order teardown: later registrations
        // may depend on earlier ones.
        for (const dispose of owned.splice(0).reverse())
            release(dispose);
        mounts.delete(ctx);
    });
    mounts.set(ctx, mount);
    // Tool registration. `ctx.tools` is the one hard dependency (`inject`), so a
    // missing registry means the plugin refuses to mount rather than half-work.
    const tools = ctx.tools;
    if (tools === undefined) {
        throw new Error('[dsh-metacog] host injected "tools" but exposes no tool registry');
    }
    // ---------------------------------------------------------- collection + schedule
    // Projects this mount monitors. Filled by two paths — the event feed and any
    // tool that resolves a project — and read by the periodic sweep. It is a
    // runtime fact rebuilt on every mount, never persisted.
    const monitored = new Map();
    /**
     * Action classes seen per project, for the S2 baseline.
     *
     * In memory on purpose. It answers "what does this session normally do", and a
     * baseline that survived a restart would compare today's work against whatever
     * the project happened to be doing last week — which is not a baseline, it is a
     * memory of a different task.
     */
    const classHistory = new Map();
    /** Classes kept per project; older ones stop influencing the baseline. */
    const CLASS_HISTORY_LIMIT = 40;
    /** Last score per project, for the settings card and the report. */
    const lastScore = new Map();
    /**
     * Why the deterministic layer is silent, per project.
     *
     * The v4 score can stay at level 0 because coverage is below the floor rather
     * than because nothing happened. Stored so the prompt block can explain the
     * silence; cleared as soon as coverage recovers.
     */
    const coverageNotes = new Map();
    const environment = createToolEnvironment(ctx, config);
    // Register a project for the periodic sweep as soon as any tool resolves it.
    // Tools are the second way a project becomes known (the feed is the first),
    // and a project confirmed through `goal_tree_confirm` must be monitored even
    // if no session event ever arrives afterward.
    const registerProject = async (projectRoot) => {
        const projectId = deriveProjectId(projectRoot);
        if (monitored.has(projectId))
            return;
        const store = environment.storeFor(projectRoot);
        const state = await store.readState(projectId);
        if (state === undefined || !state.confirmed)
            return;
        monitored.set(projectId, { projectId, store, projectRoot });
        void rememberProject(projectId, projectRoot);
    };
    const toolFactories = [
        goalTreeInitTool,
        metacogScanTool,
        metacogAskUserTool,
        metacogDraftCriteriaTool,
        metacogReadDocumentTool,
        goalTreeConfirmTool,
        goalTreeViewTool,
        goalTreeEditTool,
        contradictionTreeEditTool,
        checkDriftTool,
        contradictionObserveTool,
        resolveInterventionTool,
        declarePlanTool,
        revisePlanTool,
        generateReportTool,
        metacogReviseTool,
        metacogArchiveTool,
        metacogPurgeTool,
        metacogArchiveMilestoneTool,
        metacogMergeTreeTool,
    ];
    const registeredTools = [];
    // Kept by name so the slash commands can drive the very same tool instance.
    // A command must not re-implement the governed write: one CAS check, one
    // structural gate, one audit path.
    const toolByName = new Map();
    for (const factory of toolFactories) {
        const definition = factory(environment);
        // Wrap `execute` so every tool call that resolves a project also enrols it
        // for the periodic sweep. Wrapping once here beats threading a callback
        // through eight tool modules, and the tool's own return value is untouched.
        const inner = definition.execute.bind(definition);
        const wrapped = {
            ...definition,
            async execute(args, exec) {
                // Migrate before the tool reads, so it works on the current shape. The
                // legacy `level` field is tolerated on read, but only a real write makes the
                // conversion auditable — and doing it here keeps every tool out of it.
                try {
                    const root = await environment.resolveProjectRoot(exec);
                    await environment.storeFor(root).migrateLegacyTree(deriveProjectId(root));
                }
                catch {
                    // Migration is bookkeeping: a failure must never fail a tool call.
                }
                const outcome = await inner(args, exec);
                try {
                    await registerProject(await environment.resolveProjectRoot(exec));
                }
                catch {
                    // Enrolment is bookkeeping: losing it must never fail a tool call.
                }
                return outcome;
            },
        };
        mount.claim(tools.register(wrapped));
        toolByName.set(definition.name, wrapped);
        registeredTools.push(definition.name);
    }
    // ------------------------------------------------------------------- collection
    // Live collection. The feed is observed, never intercepted: nothing here can
    // change what the host commits, and every failure is contained to a warning.
    const collector = installCollector({
        ctx,
        config,
        async storeForSession(sessionId, cwd) {
            const root = resolveSessionRoot(sessionId, cwd, ctx);
            if (root === undefined)
                return undefined;
            const store = environment.storeFor(root);
            const projectId = deriveProjectId(root);
            // Only a confirmed project can be monitored: an unconfirmed tree is a
            // draft whose nodes are not yet allowed to drive judgements.
            const state = await store.readState(projectId);
            if (state === undefined || !state.confirmed)
                return undefined;
            monitored.set(projectId, { projectId, store, projectRoot: root });
            void rememberProject(projectId, root);
            return { store, projectId };
        },
        async onActivity(activity, context) {
            const state = await context.store.readState(context.projectId);
            if (state === undefined)
                return;
            // v4 scoring runs alongside the rule detectors, not instead of them. The
            // rules produce the drafts the model reviews; the score produces the level.
            // Replacing the rules outright would throw away the review path that is
            // the only place a drafts' rationale gets a second opinion, and replacing
            // the score with the rules is what v4 exists to stop doing.
            try {
                const previous = await context.store.readSignalState(context.projectId);
                const plan = previous?.plan;
                const history = classHistory.get(context.projectId) ?? [];
                const scored = scoreTurn(activity, context.projectId, plan, previous, history, { beta: config.signals.emaBeta, initial: 0 }, {
                    thetaHintScore: config.signals.thetaHintScore,
                    thetaCardScore: config.signals.thetaCardScore,
                    consecutiveStepsForCard: config.signals.consecutiveStepsForCard,
                    coverageFloor: config.signals.coverageFloor,
                }, new Date());
                await context.store.writeSignalState(scored.state);
                // The class history is session-scoped and lives in memory: it exists only
                // to establish what this session normally does, and a baseline carried
                // across restarts would compare today's work against last week's.
                classHistory.set(context.projectId, [
                    ...history,
                    ...(activity.toolNames ?? []).map(classifyTool),
                ].slice(-CLASS_HISTORY_LIMIT));
                lastScore.set(context.projectId, scored);
                // Level 0 from the v4 score has two different meanings: "nothing to
                // report" and "too little coverage to judge". Only the second one needs
                // explaining, and without it a plan-less session looks broken.
                const latest = scored.steps[scored.steps.length - 1];
                const note = coverageHint(latest?.aggregate.coverage ?? 0, config.signals.coverageFloor, plan !== undefined);
                if (note === undefined)
                    coverageNotes.delete(context.projectId);
                else
                    coverageNotes.set(context.projectId, note);
            }
            catch (error) {
                // A scoring failure must not stop the activity from being recorded. The
                // rule path below still runs, and the monitor degrades to v3 behaviour
                // rather than dropping the turn entirely.
                ctx.logger?.warn?.(`metacog: v4 scoring failed: ${String(error)}`);
            }
            const outcome = await runActivityCheck(context.store, state, context.projectId, {
                summary: activity.summary,
                evidence: activity.evidence,
                // Same extractor as `check_drift`, on purpose: the collector and the
                // tool are two doors into one judge, and a path that arrives through
                // one must not be invisible through the other.
                paths: pathsFromEvidence(activity.evidence),
                source: activity.source,
                grade: activity.grade,
                sessionId: activity.sessionId,
                eventFingerprint: activity.fingerprint,
                ...(activity.toolName === undefined ? {} : { toolName: activity.toolName }),
                // The per-call trace, when the collector produced one. Handing it over
                // is what lets the stored record carry the tool sequence at all: the
                // store re-parses every record through `ActivityRecordSchema`, so a
                // field that is not passed here does not reach disk, however carefully
                // the collector computed it.
                ...(activity.toolNames === undefined && activity.toolResults === undefined
                    ? {}
                    : {
                        trace: {
                            toolNames: [...(activity.toolNames ?? [])],
                            toolResults: [...(activity.toolResults ?? [])],
                        },
                    }),
                // Rule hits are candidates by default. High-precision rules are facts
                // already present in the record, so they are split out and published
                // immediately below; the rest wait for the review queue.
                deferSignals: true,
            }, config);
            const split = splitDraftsByPrecision(outcome.drafts ?? [], { excludedByGoalId: outcome.verdict?.excludedByGoalId }, config.judgment.allowUnreviewedEscalation);
            if (split.direct.length > 0) {
                const published = await publishDrafts(context.store, state, context.projectId, split.direct, config, new Date(), 
                // The direct path skips review, not the grade gate: a Grade B
                // observation may still be recorded but may never open a card.
                { mayEscalate: activity.grade === 'A', bypassed: true });
                if (published.level1Hints.length > 0)
                    pushPromptHints(published.level1Hints);
                // A3: sampling writes an extra review candidate for a fraction of
                // bypassed drafts. The signal already went out; the candidate exists so
                // the model's verdict can reach the rule-health sample.
                for (const draft of split.direct) {
                    if (!isBypassSampled(draft, config.judgment.bypassSampleRate))
                        continue;
                    await context.store.appendJudgment(context.projectId, judgmentFromDraft(context.projectId, draft, activity.summary, { sampled: true }));
                }
            }
            for (const draft of split.review) {
                await context.store.appendJudgment(context.projectId, judgmentFromDraft(context.projectId, draft, activity.summary));
            }
        },
    });
    mount.claim(collector.dispose);
    // The two in-memory maps belong to this mount, so they must not outlive it.
    // `classHistory` especially: an unload/reload that kept it would make S2 compare
    // the new session against whatever the previous mount happened to be doing,
    // which is the exact confusion the comment on that map says it exists to avoid.
    mount.claim(() => {
        classHistory.clear();
        lastScore.clear();
        coverageNotes.clear();
    });
    // ---------------------------------------------------------------------- reports
    // The dynamic prompt block. `AssembleContext` exposes only `scope`/`signal`
    // (verified against the live contract), so the text cannot resolve a project
    // by itself. It renders from this mount's cache instead, and the cache is
    // refreshed whenever the mount records something. With nothing recorded yet
    // the block is the static rule alone: it never guesses a project.
    const promptCache = { state: undefined, pending: [], hints: [], plan: undefined };
    const refreshPromptCache = async () => {
        // The system-prompt section is assembled without a session, so it cannot
        // know which project it is rendering for. Showing only the first project
        // meant a pending Level 3 card in any other workspace was invisible in the
        // prompt — the gate still blocked, but nothing told the model why.
        //
        // So: the tree shown is the first project's (there is one yardstick per
        // conversation, and the first is the one this mount saw), while pending
        // decisions are collected from every monitored project, each labelled with
        // its own project id.
        const project = monitored.values().next();
        if (project.done === true) {
            promptCache.state = undefined;
            promptCache.pending = [];
            promptCache.hints = [];
            promptCache.plan = undefined;
            return;
        }
        const { store, projectId } = project.value;
        promptCache.state = await store.readState(projectId);
        // Read alongside the tree because the block renders both: a plan in force
        // suppresses the "declare one" line, and that decision has to be made from
        // the same project the tree came from.
        promptCache.plan = (await store.readSignalState(projectId))?.plan;
        const allPending = [];
        const hints = [];
        for (const monitoredProject of monitored.values()) {
            const pending = (await monitoredProject.store.readInterventions(monitoredProject.projectId)).filter((record) => record.status === 'pending');
            allPending.push(...pending);
            const multiple = monitored.size > 1;
            hints.push(...pending.map((record) => {
                // Chinese, and the record's own hint when it has one. The project
                // suffix stays because a pending card in another workspace must be
                // attributable when several projects are monitored.
                const line = pendingInterventionHint(record);
                return multiple ? `${line}（项目 ${monitoredProject.projectId}）` : line;
            }));
        }
        // One standing explanation for the tree this block renders. It is removed
        // as soon as coverage recovers, so it cannot outlive the condition.
        const coverageNote = coverageNotes.get(projectId);
        if (coverageNote !== undefined)
            hints.push(coverageNote);
        promptCache.pending = allPending;
        // Quiet mode stops *advertising* a pending card; it does not stop the card
        // from existing. The decision is still reachable through the tools and still
        // shows up in a report — what goes away is the interruption.
        promptCache.hints = config.quiet.enabled ? [] : hints;
    };
    mount.claim(() => {
        // Drop the cached state with the mount so a stale tree cannot be rendered
        // by a context that outlives it.
        promptCache.state = undefined;
        promptCache.pending = [];
        promptCache.hints = [];
        promptCache.plan = undefined;
    });
    const prompt = ctx.get('systemPrompt');
    if (prompt !== undefined) {
        mount.claim(prompt.section({
            name: 'dsh-metacog',
            // High but not last: later sections may still want the final word.
            order: 900,
            text: () => {
                // Assembly is synchronous by contract, so this returns the cached
                // render and schedules a refresh for the next turn. A one-turn lag is
                // acceptable for a monitor; blocking assembly on file I/O is not.
                void refreshPromptCache().catch(() => { });
                // Quiet mode can drop the block as well. Off by default: the block is
                // passive context, not a card, and removing it also removes the model's
                // awareness that a decision is waiting.
                if (config.quiet.enabled && config.quiet.suppressPromptBlock)
                    return '';
                return renderPromptBlock(promptCache.state, promptCache.pending, promptCache.hints, config, promptCache.plan);
            },
        }));
    }
    // -------------------------------------------------------------------- scheduling
    // The periodic sweep. Static checks only: a tick has no conversation, so it
    // is Grade C by construction and may record and hint but never open a card.
    // When each project was last sent to the model for a second opinion. In memory
    // on purpose: a restart re-reviewing the queue once is harmless, whereas losing
    // the stamp can only cause an extra call, never a missed candidate.
    const lastReviewAt = new Map();
    /**
     * Per-project "review is unavailable" notifier.
     *
     * M1's `RealtimeFailureReminder` supplies the suppression/re-arm state; the
     * state file is separate from the realtime verdict one so a realtime success
     * cannot silently clear a review suppression (and vice versa).
     */
    const reviewNotifiers = new Map();
    const reviewNotifierFor = (projectRoot) => {
        const statePath = join(projectRoot, config.storageSubdir, 'judgment-review-failures.json');
        let notifier = reviewNotifiers.get(statePath);
        if (notifier === undefined) {
            notifier = new ReviewFailureNotifier({
                statePath,
                remind: (message) => pushPromptHints([message]),
            });
            reviewNotifiers.set(statePath, notifier);
        }
        return notifier;
    };
    /**
     * Where the project index lives.
     *
     * Deliberately not inside a project's own `.metacog`: the whole point is to find
     * projects whose paths are otherwise unknown, which includes projects the user
     * has since moved. One file per plugin profile, keyed by nothing — it is a list.
     */
    const projectIndexPath = () => join(homedir(), '.dsh', 'metacog-projects.json');
    /**
     * The fixed id cross-workspace reports are filed under.
     *
     * A real project id is a hash of a workspace path, and a report that covers
     * every workspace has no single path to hash. A stable non-hash id keeps those
     * records in one place and makes them trivially distinguishable from a
     * per-project report.
     */
    const GLOBAL_REPORT_PROJECT_ID = 'global-all-workspaces';
    /**
     * Where cross-workspace reports and their Markdown copies live.
     *
     * Under `~/.dsh`, not inside any project: the file describes the union of every
     * workspace, so filing it under one of them would be wrong the moment a second
     * workspace exists.
     */
    const globalReportStore = () => new MetacogStore(join(homedir(), '.dsh', 'metacog-global'), '.');
    /**
     * Every monitored workspace whose tree is confirmed.
     *
     * The one list both the timer and the card generate from, so a hand-generated
     * report and an automatic one cover the same set. A draft tree is excluded: it
     * holds goals nobody agreed to, and letting one in would make the summary
     * depend on a half-finished derivation.
     */
    const confirmedWorkspaces = async () => {
        const sources = [];
        for (const project of monitored.values()) {
            const state = await project.store.readState(project.projectId);
            if (state === undefined || !state.confirmed)
                continue;
            sources.push({ store: project.store, state, projectId: project.projectId });
        }
        return sources;
    };
    /** Read the index, tolerating a missing or corrupt file. */
    const readProjectIndex = async () => {
        try {
            const raw = await readFile(projectIndexPath(), 'utf8');
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed))
                return [];
            return parsed.filter((entry) => typeof entry === 'object' &&
                entry !== null &&
                typeof entry.projectId === 'string' &&
                typeof entry.projectRoot === 'string');
        }
        catch {
            // No index yet, or an unreadable one. Neither is an error: the index is an
            // optimisation, and a project still registers the moment it is touched.
            return [];
        }
    };
    /** Add one project to the index, keeping it free of duplicates. */
    const rememberProject = async (projectId, projectRoot) => {
        try {
            // Throwaway directories are not workspaces. A test suite creating a temp
            // project for every case used to append one entry each, and since the index
            // only ever grows the file filled with roots that no longer existed. The
            // sweep skipped them harmlessly, but a list that is mostly dead pointers is
            // not something a user should have to reason about.
            if (isDisposableRoot(projectRoot))
                return;
            const existing = await readProjectIndex();
            if (existing.some((entry) => entry.projectId === projectId && entry.projectRoot === projectRoot))
                return;
            const next = [...existing.filter((entry) => entry.projectId !== projectId), { projectId, projectRoot }];
            await mkdir(dirname(projectIndexPath()), { recursive: true });
            await writeFile(projectIndexPath(), JSON.stringify(next, null, 2), 'utf8');
        }
        catch (error) {
            // A failed index write costs discovery on the next start, nothing more.
            ctx.logger.warn(`[dsh-metacog] could not record project ${projectId} in the index: ${String(error)}`);
        }
    };
    /**
     * Register every project this plugin has ever seen, from its own index.
     *
     * The periodic sweep needs a project list, and normally it gets one as a side
     * effect of a tool call or an event. That leaves a real gap: start the app, touch
     * nothing, and the sweep has nothing to sweep while looking perfectly healthy.
     *
     * The index is a plain list of absolute project roots. It is written whenever a
     * project is registered, so a restart can rebuild each store without the user
     * having to call a tool first.
     */
    const discoverPersistedProjects = async () => {
        const roots = await readProjectIndex();
        for (const root of roots) {
            if (monitored.has(root.projectId))
                continue;
            // A root that no longer holds a confirmed tree is skipped rather than
            // registered and then erroring on every tick.
            try {
                const store = new MetacogStore(root.projectRoot, config.storageSubdir);
                const state = await store.readState(root.projectId);
                if (state === undefined || !state.confirmed)
                    continue;
                monitored.set(root.projectId, { projectId: root.projectId, store, projectRoot: root.projectRoot });
            }
            catch (error) {
                ctx.logger.warn(`[dsh-metacog] could not reopen project ${root.projectId}: ${String(error)}`);
            }
        }
    };
    // Where timer findings reach the user. Both timers share this sink: the next
    // turn's prompt block reads the cache, so a tick needs no new channel. Quiet
    // mode filters at the source, keeping "record but do not interrupt" a
    // property of the collector rather than a promise each renderer remembers.
    const pushPromptHints = (hints) => {
        if (config.quiet.enabled)
            return;
        if (hints.length === 0)
            return;
        promptCache.hints = [...new Set([...promptCache.hints, ...hints])].slice(0, 8);
    };
    const scheduler = installScheduler({
        ctx,
        config,
        // Everything registered so far, plus whatever a previous run left behind.
        //
        // Without the second half the sweep only ever checks projects that a tool or
        // the event feed happened to register *this* process. After a restart with
        // nobody touching a tool, `monitored` stays empty and the periodic check
        // silently never runs — the monitor looks awake and is doing nothing, which is
        // the worst state for it to be in.
        projects: async () => {
            await discoverPersistedProjects();
            return [...monitored.values()];
        },
        // Where a timer tick's findings reach the user.
        //
        // The sweep used to collect hints and drop them: `onHints` was optional and
        // nothing passed it, so a tick could notice something and have no way to say it
        // outside the next report. They now land in the same prompt cache the per-turn
        // block reads, which means the next turn sees them without a new channel.
        onHints(hints) {
            pushPromptHints(hints);
        },
        // A timer tick with `schedule.autoReport` on writes one report per elapsed
        // period. `generateReport` is the same function the tool and the card's route
        // call, so an automatic report and a hand-generated one differ only in who
        // asked — no second code path, no chance of the two drifting apart.
        // Cross-workspace reports.
        //
        // One report covers every workspace that has a confirmed tree, and it is
        // written to a global sink rather than into any single workspace: a file
        // living inside `D:\documents\A\.metacog` would look like it belonged to A
        // while describing B and C as well. The record file is the same one the card
        // reads, so the panel and the timer never disagree about what exists.
        //
        // `generateWorkspaceReport` is the same renderer the tool and the card's
        // route use; it merges the trees and streams before rendering, so an
        // automatic report and a hand-generated one differ only in who asked.
        report: {
            async readExisting() {
                const sink = globalReportStore();
                return await sink.readReports(GLOBAL_REPORT_PROJECT_ID);
            },
            async generate(type, at) {
                await generateWorkspaceReport({
                    workspaces: await confirmedWorkspaces(),
                    config,
                    type,
                    // `at` is the end of the closed period the timer is filling in. Without
                    // it the report would resolve to the period containing the wall clock,
                    // which at 00:05 is the day that just started and is still empty.
                    ...(at === undefined ? {} : { now: at }),
                    targetStore: globalReportStore(),
                    targetProjectId: GLOBAL_REPORT_PROJECT_ID,
                });
            },
        },
        // The model is consulted at most once per review interval, not once per
        // activity: a batch sees what the hour was about, and one call is cheaper
        // than a hundred. A full batch forces the call early.
        async review(project, state) {
            const now = Date.now();
            const last = lastReviewAt.get(project.projectId) ?? 0;
            const quiet = now - last < config.thresholds.reviewIntervalMinutes * 60_000;
            // File changes first: they are cheap, they need no model, and they answer a
            // question the activity stream cannot. A turn that says nothing while three
            // files changed is invisible to the tool-call path.
            const fileHints = [];
            if (config.collection.enabled && project.projectRoot !== undefined) {
                try {
                    const stored = await project.store.readFileBaseline(project.projectId);
                    const previous = stored === undefined
                        ? undefined
                        : new Map(Object.entries(stored).map(([path, value]) => [path, value]));
                    // One walk, not two: `fingerprintTree` is the expensive part, so the diff
                    // and the new baseline both come from the same map.
                    const { files, skipped } = await fingerprintTree(project.projectRoot);
                    const changes = diffFingerprints(previous, files);
                    if (changes.length > 0) {
                        const report = { changes, scanned: files.size, skipped, hadBaseline: previous !== undefined };
                        fileHints.push(...describeChanges(report).map((line) => `[metacog 文件变化] ${line}`));
                    }
                    // Store the new baseline whether or not anything changed: the next diff
                    // must be against what is on disk now, not against the last interesting
                    // moment.
                    await project.store.writeFileBaseline(project.projectId, Object.fromEntries(files));
                }
                catch (error) {
                    ctx.logger.warn(`[dsh-metacog] file scan failed for ${project.projectId}: ${String(error)}`);
                }
            }
            // Cost short-circuit, checked before anything else can spend a model call.
            //
            // The queue is read on every tick regardless of the interval, because "is
            // there anything to review" is cheap and answering it is what lets the sweep
            // skip the expensive part. Without this the sweep called the model once per
            // interval on an empty queue, which on an idle machine is a steady trickle of
            // calls that can only ever return nothing.
            const pending = (await project.store.readJudgments(project.projectId)).filter((record) => record.status === 'pending');
            if (pending.length === 0)
                return fileHints;
            if (quiet && pending.length < config.thresholds.reviewBatchSize)
                return fileHints;
            try {
                // A timer tick has no calling agent. The child is attributed to the
                // project's own metacog session when one is bound; without any agent the
                // model call cannot start, so this also decides whether the sweep can
                // judge at all.
                const boundSessionId = await project.store
                    .readMetacogSessionId(project.projectId)
                    .catch(() => undefined);
                const parent = boundSessionId === undefined ? undefined : ctx.get('agents')?.get?.(boundSessionId);
                const outcome = await reviewPendingJudgments({
                    ctx,
                    store: project.store,
                    projectId: project.projectId,
                    state,
                    config,
                    ...(project.projectRoot === undefined ? {} : { cwd: project.projectRoot }),
                    ...(parent === undefined ? {} : { parent }),
                });
                if (outcome.problem !== undefined) {
                    ctx.logger.warn(`[dsh-metacog] judgment review skipped: ${outcome.problem}`);
                    reviewNotifierFor(project.projectRoot).noteFailure(outcome.problem);
                }
                else {
                    // A completed pass re-arms the reminder: the next outage is worth one
                    // new line even if it has the same reason as the previous one.
                    reviewNotifierFor(project.projectRoot).noteSuccess();
                }
                // Only a completed pass resets the clock; a failed one retries next tick.
                if (outcome.problem === undefined)
                    lastReviewAt.set(project.projectId, now);
                // Nothing queued means no rule objected, which is not the same as "the
                // period was fine": rules only see single activities. So a quiet queue
                // triggers one holistic look at the interval's activities instead.
                if (outcome.reviewed === 0) {
                    // The window is "since the last check", not "the last N minutes".
                    //
                    // Two windows were in use: the slash command judged since its own stored
                    // checkpoint, the timer judged a fixed interval. The timer's version
                    // re-judged work the previous tick had already covered whenever the
                    // interval was shorter than the gap between ticks, and skipped work
                    // entirely when the interval was longer. One checkpoint, shared, is the
                    // only version that neither repeats nor loses.
                    const checkpoint = await project.store.readCheckpoint(project.projectId).catch(() => undefined);
                    const since = checkpoint === undefined
                        ? now - config.thresholds.windowMinutes * 60_000
                        : Date.parse(checkpoint);
                    const recent = (await project.store.readActivities(project.projectId))
                        .filter((item) => Date.parse(item.timestamp) >= since)
                        .map((item) => ({
                        summary: item.summary,
                        decision: item.decision,
                        timestamp: item.timestamp,
                    }));
                    // Nothing happened in the window: no model call, and move the checkpoint
                    // so the next tick starts from here rather than re-scanning the gap.
                    if (recent.length === 0) {
                        await project.store.setCheckpoint(project.projectId, new Date(now).toISOString()).catch(() => { });
                        return [...fileHints, ...outcome.hints];
                    }
                    const verdict = await assessWindow({
                        ctx,
                        state,
                        activities: recent,
                        ...(project.projectRoot === undefined ? {} : { cwd: project.projectRoot }),
                        label: 'metacog-sweep',
                        ...(parent === undefined ? {} : { parent }),
                    });
                    if (verdict.status === 'ok' && verdict.assessment.drifted) {
                        const suggestion = verdict.assessment.suggestions[0];
                        return [
                            ...outcome.hints,
                            `[metacog 巡检] 最近一段工作偏离了目标：${verdict.assessment.reason}` +
                                (suggestion === undefined ? '' : ` 建议：${suggestion}`),
                        ];
                    }
                }
                return outcome.hints;
            }
            catch (error) {
                ctx.logger.warn(`[dsh-metacog] judgment review failed: ${String(error)}`);
                return [];
            }
        },
    });
    mount.claim(scheduler.dispose);
    // ------------------------------------------------------- Realtime verdicts
    // A second, independent cadence beside the 25-minute sweep. It shares the
    // project set and the hint sink, nothing else: its window, checkpoint and
    // failure state are its own, so neither timer can starve or silence the
    // other. It stays off unless `realtime.enabled` is on.
    const defaultModel = () => {
        const agents = ctx.get('agents');
        return agents?.defaultModel?.();
    };
    const realtime = installRealtimeScheduler({
        ctx,
        config,
        projects: async () => {
            await discoverPersistedProjects();
            return [...monitored.values()];
        },
        llm: ctx.get('llm'),
        defaultModel,
        onHints(hints) {
            pushPromptHints(hints);
        },
    });
    mount.claim(realtime.dispose);
    // ------------------------------------------------------------ Settings card
    // The card is a Client plugin, so this is only the Host half of its channel:
    // the browser cannot read `.metacog/` itself. Reads go through the mount's
    // store cache, which means a card request shares the same per-project lock as
    // a tool call and can never observe a half-written file. Writes reuse
    // `generateReport` and `archiveSignals` — the same functions the tools call —
    // so a click and a model call leave the same audit trail.
    const api = installApi(ctx, {
        config,
        // The raw profile row, before the card's overrides: used to validate a written
        // override against a full shape rather than against itself.
        profileConfig: rawConfig,
        storeFor: (root) => environment.storeFor(root),
        // The tree edit goes through the registered tool, so the card inherits every
        // gate the model-facing surface has: CAS, L0 confirmation, L1 reason, leaf-only
        // delete, and the audit entry.
        editTree: async (args) => {
            const tool = toolByName.get('goal_tree_edit');
            if (tool === undefined)
                return { ok: false, error: 'goal_tree_edit is not registered' };
            // `projectRoot` is this route's own routing hint, not a tool argument. The
            // tool resolves its workspace from `resolveProjectRoot`, which is
            // session-scoped — so the root has to travel in the invocation context or a
            // card action would edit whichever workspace the conversation is in.
            const { projectRoot, ...toolArgs } = args;
            const root = String(projectRoot ?? '');
            const outcome = await tool.execute(toolArgs, {
                callId: `card-${Date.now()}`,
                name: 'goal_tree_edit',
                arguments: toolArgs,
                // A card write is short and has no cancellation channel of its own; a
                // signal that never aborts is the honest representation of that.
                signal: new AbortController().signal,
                projectRoot: root,
                rawInput: '',
            });
            return outcome;
        },
        // Cross-workspace reports live in the global sink. The card reads and writes
        // there too, so the panel and the timer never disagree about what exists.
        readReports: () => globalReportStore().readReports(GLOBAL_REPORT_PROJECT_ID),
        reportRoot: () => globalReportStore().root,
        async generateReport(type) {
            return await generateWorkspaceReport({
                workspaces: await confirmedWorkspaces(),
                config,
                type,
                targetStore: globalReportStore(),
                targetProjectId: GLOBAL_REPORT_PROJECT_ID,
            });
        },
        async listRoots() {
            const roots = new Set();
            for (const project of monitored.values()) {
                if (project.projectRoot !== undefined)
                    roots.add(project.projectRoot);
            }
            // A fresh mount has seen no session event yet, so the sweep set is empty;
            // the workspace registry still knows every directory that may hold a tree.
            for (const workspace of ctx.get('workspaceRegistry')?.list() ?? [])
                roots.add(workspace.path);
            return [...roots];
        },
        // Read-only: the card shows which model the monitor would use, and says it
        // cannot change it. A plugin writing the global model selection would be
        // reaching outside its own configuration.
        defaultModel() {
            const agents = ctx.get('agents');
            try {
                return agents?.defaultModel?.();
            }
            catch {
                return undefined;
            }
        },
        // The static half of a tick: no agent, no model call. Recorded hints are
        // returned so the card can show what a click found.
        async runSweep(projectId) {
            const project = monitored.get(projectId);
            if (project === undefined)
                return { ran: false, signals: 0, hints: [] };
            const state = await project.store.readState(projectId);
            if (state === undefined)
                return { ran: false, signals: 0, hints: [] };
            const outcome = await assessWindow({
                ctx,
                state,
                activities: (await project.store.readActivities(projectId)).map((item) => ({
                    summary: item.summary,
                    decision: item.decision,
                    timestamp: item.timestamp,
                })),
                ...(project.projectRoot === undefined ? {} : { cwd: project.projectRoot }),
                label: 'metacog-card-sweep',
            });
            const hints = outcome.status === 'ok' && outcome.assessment.drifted
                ? [`巡检：${outcome.assessment.reason}`]
                : [];
            return { ran: true, signals: hints.length, hints };
        },
        // Same guards as the tool: the caller has already matched the id, and this
        // refuses to delete anything the tool would refuse.
        async purgeProject(root, projectId, reason, scope) {
            const store = environment.storeFor(root);
            const root2 = join(root, config.storageSubdir);
            // The directory list and the per-project layout rule live in
            // `tools/purge.ts` and are imported here rather than copied. This used to be
            // a second hand-maintained list, and it drifted: three archives
            // (`archive/`, `activities-archive/`, `rebuilds/`) were added to neither
            // copy, so "delete everything" left every historical goal tree on disk.
            const { present: deleted, files, bytes } = await deleteDirectories(root2, projectId, scope);
            // Only for the records scope. `everything` deletes `audit/` itself, so writing an
            // entry afterwards recreated the directory the caller just asked to be rid of —
            // which is why a "delete everything" left one file behind.
            if (scope !== 'everything') {
                await store.appendStandaloneAudit(projectId, {
                    action: 'purge',
                    actor: 'manual_tool',
                    targetIds: [],
                    reason,
                    evidence: [`deleted: ${deleted.join(', ') || '(none)'}`, `files: ${files}`, `bytes: ${bytes}`],
                });
            }
            return { deleted, files, bytes };
        },
    });
    if (api !== undefined)
        mount.claim(api);
    // ---------------------------------------------------------------- Level 3
    // The hard gate (spec 4.4 item 4). `tools/pre-execute` is a waterfall whose
    // listener may deny a call before dispatch. Off unless explicitly enabled.
    const gate = installGate({
        ctx,
        config,
        async storeForSession(sessionId) {
            // Resolve the project from the session's own working directory, not from
            // "whichever project happens to be first". With more than one monitored
            // workspace the old first-entry lookup gated the wrong project: a pending
            // Level 3 card in workspace B blocked nothing in workspace A, and a call
            // from A was judged against B's tree.
            const session = ctx.get('sessions')?.get?.(sessionId);
            const sessionCwd = session === undefined
                ? undefined
                : (ctx.get('workingDirectory')?.get(session) ?? session.header?.cwd);
            if (sessionCwd !== undefined && sessionCwd.length > 0) {
                const projectId = deriveProjectId(sessionCwd);
                const known = monitored.get(projectId);
                if (known !== undefined) {
                    return { store: known.store, projectId };
                }
                // Not registered yet: the session belongs to a project this mount has
                // never seen. Reading its state directly is still correct, and it lets
                // the gate work on the first call of a fresh workspace.
                const store = environment.storeFor(sessionCwd);
                const state = await store.readState(projectId);
                if (state !== undefined && state.confirmed) {
                    return { store, projectId };
                }
            }
            // No cwd to go on: fall back to the only project, and only when there is
            // exactly one. Guessing among several is how the wrong tree gets gated.
            if (monitored.size !== 1)
                return undefined;
            const project = monitored.values().next();
            if (project.done === true)
                return undefined;
            return { store: project.value.store, projectId: project.value.projectId };
        },
    });
    mount.claim(gate.dispose);
    // ------------------------------------------------------- metacog session
    // The dedicated conversation where goals are established and later reviewed.
    //
    // Initialisation is a one-time act with a durable home: not whichever working
    // conversation happens to be open, but one named place the user can return to.
    // The command below is the entry point — a slash command is available from the
    // composer in every session, including the empty one, which is exactly where a
    // user starting a new project finds themselves.
    // Every tool name the host exposes globally, as a set.
    //
    // The metacog session's tool whitelist is intersected with this: `restrict`
    // treats an unknown name as a programming error, so a build missing one of the
    // optional tools would lose the session over a capability it never used.
    //
    // It must include the host's own tools, not just this plugin's. Seeding the set
    // from `registeredTools` alone dropped every host tool from the allow list —
    // including `ask_user_question`, which is why a session listed its questions as
    // prose instead of opening the popup: the tool had been filtered out of existence.
    const knownToolNames = new Set(registeredTools);
    const globalSchemas = tools.schemas;
    if (typeof globalSchemas === 'function') {
        try {
            for (const schema of globalSchemas.call(tools)) {
                if (typeof schema?.name === 'string' && schema.name.length > 0) {
                    knownToolNames.add(schema.name);
                }
            }
        }
        catch (error) {
            ctx.logger.warn(`[dsh-metacog] could not read the global tool list: ${String(error)}`);
        }
    }
    const startInitialisation = async (agent) => {
        // The project is the directory THIS conversation works in.
        //
        // `workingDirectory.defaultDirectory` is a deployment-wide fallback, not the
        // current project. Using it here is what silently created a second workspace
        // under the default directory instead of placing the new conversation under
        // the project the user was looking at. The session header is the only
        // correct source.
        const session = agent.session;
        const sessionCwd = session === undefined
            ? undefined
            : (ctx.get('workingDirectory')?.get(session) ?? session.header?.cwd);
        const discovered = monitored.values().next();
        const projectRoot = sessionCwd !== undefined && sessionCwd.length > 0
            ? sessionCwd
            : discovered.done === true
                ? undefined
                : discovered.value.projectRoot;
        if (projectRoot === undefined || projectRoot.length === 0) {
            return ('无法确定当前会话所在的项目目录。' +
                '请在该项目的工作区里打开一个会话，再执行 /metacog-init。');
        }
        const projectId = deriveProjectId(projectRoot);
        const store = environment.storeFor(projectRoot);
        const state = await store.readState(projectId);
        const hasTree = state?.confirmed === true;
        // The workspace's own display title beats the directory basename: the user
        // may have renamed the workspace, and the session name should match what
        // they see in the sidebar.
        const workspaceName = await resolveWorkspaceName(ctx, projectRoot);
        // The new conversation must run on a real model. Without one its very first
        // prompt cannot assemble, and the failure reads as a model problem.
        const model = resolveInheritedModel(ctx, session);
        // Where does the conversation stand? This decides the question, not a
        // boolean "have we initialised before": a project can be initialised while
        // its session was closed, archived, or deleted, and each case needs a
        // different answer from the user.
        const sessionState = await inspectMetacogSession({ ctx, config, store, projectId, projectRoot });
        // Nothing to rebuild: proceed straight to initialisation.
        if (!hasTree && sessionState.kind !== 'live' && sessionState.kind !== 'archived') {
            return await runInitialisation({
                ctx, config, store, projectId, projectRoot, workspaceName, hasTree,
                ...{ model },
                inheritFrom: session,
                knownTools: knownToolNames,
            });
        }
        // There is something to decide. Ask, rather than narrating a paragraph the
        // user has to read and act on manually.
        const questions = ctx.get('userQuestions');
        if (questions === undefined) {
            return (`当前工作区${hasTree ? `已有目标树（版本 ${state?.version ?? '?'}）` : ''}` +
                `${sessionState.kind === 'live' ? '，且认知监控会话正在运行' : ''}。\n` +
                '本环境不支持弹窗确认，请直接打开认知监控会话操作。');
        }
        const choice = await askRebuildChoice(ctx, agent, {
            projectRoot,
            hasTree,
            version: state?.version,
            sessionState,
        });
        if (choice === undefined) {
            return '已取消。没有改动任何东西。';
        }
        if (choice === 'keep') {
            const where = sessionState.kind === 'live' || sessionState.kind === 'archived'
                ? `会话「${sessionState.title}」`
                : '认知监控会话';
            return `保持现状。请到${where}里查看或调整。`;
        }
        // Rebuilding: reuse the existing conversation whenever one survives, so the
        // record of how these goals were arrived at stays in one place.
        return await runInitialisation({
            ctx, config, store, projectId, projectRoot, workspaceName,
            // The tree is being replaced, so the kickoff must say so: it carries the
            // version number the rebuild proof needs. `force: true` + `expectedVersion`
            // is what makes the reset deliberate rather than accidental.
            hasTree: true,
            forceSession: sessionState.kind === 'archived' || sessionState.kind === 'live'
                ? sessionState.sessionId
                : undefined,
            ...{ model },
            inheritFrom: session,
            // Same as the first-build branch above: without this the rebuild path
            // intersects the whitelist with an empty set, drops every tool, and the
            // session cannot act. The two branches must stay identical here.
            knownTools: knownToolNames,
        });
    };
    const initCommand = registerInitCommand(ctx, startInitialisation);
    if (initCommand !== undefined)
        mount.claim(initCommand);
    // A second opinion on demand.
    //
    // The scheduled review runs at most once per interval, which is right for normal
    // operation and useless for checking whether the review works at all. This
    // command settles the queue immediately, and doubles as the only way to exercise
    // the model path without waiting an hour.
    const slash = ctx.get('commands');
    if (slash !== undefined) {
        mount.claim(slash.register({
            name: 'metacog-check',
            description: '立刻问一次模型：最近这段工作有没有偏离目标（顺带结算待复核的漂移候选）',
            handler: async (invocation) => {
                try {
                    const session = invocation.agent.session;
                    const cwd = session === undefined
                        ? undefined
                        : (ctx.get('workingDirectory')?.get(session) ?? session.header?.cwd);
                    if (cwd === undefined || cwd.length === 0) {
                        return { kind: 'error', text: '无法确定当前项目目录，请在工作区里执行。' };
                    }
                    const store = environment.storeFor(cwd);
                    const projectId = deriveProjectId(cwd);
                    const state = await store.readState(projectId);
                    if (state === undefined || !state.confirmed) {
                        return {
                            kind: 'error',
                            text: '这个项目还没有确认过的目标树，没有评判的标尺。先执行 /metacog-init。',
                        };
                    }
                    // The queue is settled in the same pass: a manual check that ignored
                    // pending candidates would report "no drift" while a stack of them sat
                    // unanswered right behind it.
                    //
                    // One review sees at most 20 candidates, and a backlog can be far
                    // larger — the first real run had 119 waiting. Asking by hand is an
                    // explicit "settle this now", so it drains in rounds instead of
                    // leaving 99 behind without saying so.
                    let outcome = await reviewPendingJudgments({
                        ctx,
                        store,
                        projectId,
                        state,
                        config,
                        cwd,
                        parent: invocation.agent,
                    });
                    for (let round = 1; round < 8; round += 1) {
                        if (outcome.problem !== undefined || outcome.reviewed === 0)
                            break;
                        const rest = (await store.readJudgments(projectId)).filter((record) => record.status === 'pending');
                        if (rest.length === 0)
                            break;
                        const next = await reviewPendingJudgments({
                            ctx,
                            store,
                            projectId,
                            state,
                            config,
                            cwd,
                            parent: invocation.agent,
                        });
                        outcome = {
                            ...next,
                            reviewed: outcome.reviewed + next.reviewed,
                            confirmed: outcome.confirmed + next.confirmed,
                            dismissed: outcome.dismissed + next.dismissed,
                            hints: [...new Set([...outcome.hints, ...next.hints])],
                            ...(next.problem === undefined ? {} : { problem: next.problem }),
                        };
                        if (next.reviewed === 0)
                            break;
                    }
                    // A manual check is also an honest place to say the automatic
                    // reviewer is down: the outcome is right in front of the user.
                    if (outcome.problem !== undefined) {
                        reviewNotifierFor(cwd).noteFailure(outcome.problem);
                    }
                    else {
                        reviewNotifierFor(cwd).noteSuccess();
                    }
                    // The window is "since the last report", not "the last 24 hours".
                    // A fixed period re-judges work the user already answered and skips
                    // work older than a day that was never judged at all.
                    const checkpoint = await store.readCheckpoint(projectId);
                    const allActivities = await store.readActivities(projectId);
                    const scoped = checkpoint === undefined
                        ? allActivities
                        : allActivities.filter((item) => Date.parse(item.timestamp) > Date.parse(checkpoint));
                    const activities = scoped.map((item) => ({
                        summary: item.summary,
                        decision: item.decision,
                        timestamp: item.timestamp,
                    }));
                    const verdict = await assessWindow({
                        ctx,
                        state,
                        activities,
                        cwd,
                        label: 'metacog-check',
                        parent: invocation.agent,
                    });
                    const lines = [];
                    const span = checkpoint === undefined ? '首次检查' : `自上次汇报（${checkpoint}）以来`;
                    if (verdict.status === 'ok') {
                        lines.push(verdict.assessment.drifted
                            ? `判定：${span}的工作偏离了目标。`
                            : `判定：${span}的工作仍在服务目标。`);
                        if (verdict.assessment.reason.length > 0) {
                            lines.push(`理由：${verdict.assessment.reason}`);
                        }
                        if (verdict.assessment.suggestions.length > 0) {
                            lines.push('建议：');
                            for (const suggestion of verdict.assessment.suggestions)
                                lines.push(`- ${suggestion}`);
                        }
                        // Only now does the boundary move: a report that never reached the
                        // user must not consume the activities it was supposed to judge.
                        await store.setCheckpoint(projectId, new Date().toISOString());
                    }
                    else if (verdict.status === 'empty') {
                        lines.push(checkpoint === undefined
                            ? '还没有记录到任何活动，无从判断。'
                            : `自上次汇报（${checkpoint}）以来没有新活动。`);
                    }
                    else {
                        lines.push(`复核没能进行：${verdict.reason}`);
                    }
                    lines.push('');
                    lines.push(outcome.reviewed === 0
                        ? '待复核队列：空。'
                        : `待复核队列：检查 ${outcome.reviewed} 条，确认 ${outcome.confirmed} 条，驳回 ${outcome.dismissed} 条。`);
                    if (outcome.problem !== undefined)
                        lines.push(`队列复核未完成：${outcome.problem}`);
                    lines.push(...outcome.hints);
                    return { kind: 'success', text: lines.join('\n') };
                }
                catch (error) {
                    return { kind: 'error', text: `复核失败：${String(error)}` };
                }
            },
        }));
    }
    // ------------------------------------------------ direct user edit commands
    //
    // The tools let a model change the tree; these let the user do it without
    // dictating the change in prose. Both go through the same tool instance, so
    // the CAS check, the structural gate and the audit entry are identical.
    if (slash !== undefined) {
        const runTool = async (name, args, invocation) => {
            const tool = toolByName.get(name);
            if (tool === undefined) {
                return { ok: false, error: { code: 'TOOL_MISSING', message: `${name} is not registered` } };
            }
            const result = await tool.execute(args, {
                callId: `cmd-${Date.now().toString(36)}`,
                name,
                arguments: args,
                signal: invocation.signal ?? new AbortController().signal,
                agent: invocation.agent,
            });
            return result;
        };
        mount.claim(slash.register({
            name: 'metacog-goal',
            description: '直接改目标字段（标题/状态/优先级/成功标准/对齐规则），不经模型转述',
            input: { hint: '<id 或标题> --status=done --reason="..." ｜ add --parent=… --depth=… --title=…' },
            handler: async (invocation) => {
                let parsed;
                try {
                    parsed = parseGoalCommand(invocation.rawInput ?? '');
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return { kind: 'error', text: `${message}\n\n${GOAL_USAGE}` };
                }
                try {
                    const view = await runTool('goal_tree_view', {}, invocation);
                    if (!view.ok) {
                        return {
                            kind: 'error',
                            text: view.error.code === 'NOT_INITIALIZED'
                                ? '这个项目还没有目标树。先执行 /metacog-init 建树。'
                                : `读取树失败：${view.error.message}`,
                        };
                    }
                    const data = view.data;
                    const version = data.version;
                    if (parsed.action === 'add') {
                        const parentRef = String(parsed.fields.parent ?? '');
                        const parent = data.goals.find((goal) => goal.id === parentRef) ??
                            data.goals.find((goal) => goal.title === parentRef);
                        if (parent === undefined) {
                            return {
                                kind: 'error',
                                text: `找不到父目标「${parentRef}」。用 /metacog-goal 前先 goal_tree_view 看一下 id。`,
                            };
                        }
                        const created = await runTool('goal_tree_edit', {
                            expectedVersion: version,
                            creates: [
                                {
                                    depth: Number(parsed.fields.depth),
                                    parentId: parent.id,
                                    title: String(parsed.fields.title),
                                    ...(typeof parsed.fields.description === 'string'
                                        ? { description: parsed.fields.description }
                                        : {}),
                                    ...(Array.isArray(parsed.fields.successCriteria)
                                        ? { successCriteria: parsed.fields.successCriteria }
                                        : {}),
                                    ...(Array.isArray(parsed.fields.evidence)
                                        ? { evidence: parsed.fields.evidence }
                                        : {}),
                                },
                            ],
                            reason: parsed.reason,
                            actorHint: 'user',
                            ...(parsed.confirmed ? { userConfirmed: true } : {}),
                        }, invocation);
                        if (!created.ok) {
                            return { kind: 'error', text: `新增失败 [${created.error.code}]：${created.error.message}` };
                        }
                        const out = created.data;
                        return {
                            kind: 'success',
                            text: describeOutcome({
                                version: out.version,
                                auditEntryId: out.auditEntryId,
                                auditAction: out.auditAction,
                                changed: [],
                                added: out.addedGoalIds,
                            }),
                        };
                    }
                    const targetRef = String(parsed.target ?? '');
                    const goal = data.goals.find((node) => node.id === targetRef) ??
                        data.goals.find((node) => node.title === targetRef);
                    if (goal === undefined) {
                        return {
                            kind: 'error',
                            text: `找不到目标「${targetRef}」。可用 id 或完全一致的标题。`,
                        };
                    }
                    const patch = { id: goal.id };
                    for (const [key, value] of Object.entries(parsed.fields)) {
                        if (key === 'depth' || key === 'parent')
                            continue;
                        patch[key] = value;
                    }
                    const edited = await runTool('goal_tree_edit', {
                        expectedVersion: version,
                        updates: [patch],
                        reason: parsed.reason,
                        actorHint: 'user',
                        ...(parsed.confirmed ? { userConfirmed: true } : {}),
                    }, invocation);
                    if (!edited.ok) {
                        const hint = edited.error.code === 'L0_CONFIRMATION_REQUIRED'
                            ? '\n\n这是根目标，改它需要加 --force 表示你本人确认。'
                            : edited.error.code === 'VERSION_CONFLICT'
                                ? '\n\n树在读取后被改过，重试一次即可。'
                                : '';
                        return {
                            kind: 'error',
                            text: `修改失败 [${edited.error.code}]：${edited.error.message}${hint}`,
                        };
                    }
                    const out = edited.data;
                    const extra = out.contradictionsNeedingReview.length > 0
                        ? `\n注意：这些矛盾可能因为本次改动需要重评：${out.contradictionsNeedingReview.join(', ')}`
                        : '';
                    return {
                        kind: 'success',
                        text: describeOutcome({
                            version: out.version,
                            auditEntryId: out.auditEntryId,
                            auditAction: out.auditAction,
                            changed: out.changedGoalIds,
                            removed: out.removedGoalIds,
                        }) + extra,
                    };
                }
                catch (error) {
                    return { kind: 'error', text: `执行失败：${String(error)}` };
                }
            },
        }));
        mount.claim(slash.register({
            name: 'metacog-contradiction',
            description: '直接改矛盾字段（标题/两极/类型/强度/理由/解法），不经模型转述',
            input: { hint: '<id 或标题> --intensity=4 --reason="..." ｜ --type=main --force' },
            handler: async (invocation) => {
                let parsed;
                try {
                    parsed = parseContradictionCommand(invocation.rawInput ?? '');
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return { kind: 'error', text: `${message}\n\n${CONTRADICTION_USAGE}` };
                }
                try {
                    const view = await runTool('goal_tree_view', {}, invocation);
                    if (!view.ok) {
                        return {
                            kind: 'error',
                            text: view.error.code === 'NOT_INITIALIZED'
                                ? '这个项目还没有目标树。先执行 /metacog-init 建树。'
                                : `读取树失败：${view.error.message}`,
                        };
                    }
                    const data = view.data;
                    const targetRef = String(parsed.target ?? '');
                    const node = data.contradictions.find((item) => item.id === targetRef) ??
                        data.contradictions.find((item) => item.title === targetRef);
                    if (node === undefined) {
                        return {
                            kind: 'error',
                            text: `找不到矛盾「${targetRef}」。可用 id 或完全一致的标题。`,
                        };
                    }
                    const patch = { id: node.id };
                    for (const [key, value] of Object.entries(parsed.fields))
                        patch[key] = value;
                    const edited = await runTool('contradiction_tree_edit', {
                        expectedVersion: data.version,
                        updates: [patch],
                        reason: parsed.reason,
                        actorHint: 'user',
                        ...(parsed.confirmed ? { userConfirmed: true } : {}),
                    }, invocation);
                    if (!edited.ok) {
                        const hint = edited.error.code === 'CORE_CONFIRMATION_REQUIRED'
                            ? '\n\n这是 core 矛盾，改它需要加 --force 表示你本人确认。'
                            : edited.error.code === 'VERSION_CONFLICT'
                                ? '\n\n树在读取后被改过，重试一次即可。'
                                : '';
                        return {
                            kind: 'error',
                            text: `修改失败 [${edited.error.code}]：${edited.error.message}${hint}`,
                        };
                    }
                    const out = edited.data;
                    return {
                        kind: 'success',
                        text: describeOutcome({
                            version: out.version,
                            auditEntryId: out.auditEntryId,
                            auditAction: out.auditAction,
                            changed: [
                                ...new Set([...out.changedContradictionIds, ...out.reclassifiedContradictionIds]),
                            ],
                        }),
                    };
                }
                catch (error) {
                    return { kind: 'error', text: `执行失败：${String(error)}` };
                }
            },
        }));
    }
    ctx.logger.info(`[dsh-metacog] mounted; window=${config.thresholds.windowMinutes}m ` +
        `repeat=${config.thresholds.repeatThreshold} ` +
        `minConfidence=${config.thresholds.minConfidence} ` +
        `highIntensity=${config.thresholds.highIntensityThreshold} ` +
        `staleDays=${config.thresholds.staleDaysThreshold} ` +
        `whitelist=${config.whitelistedActivities.length} ` +
        `tools=${registeredTools.join(',')} ` +
        `collection=${config.collection.enabled ? 'on' : 'off'} ` +
        `timer=${capabilities.timer ? 'on' : 'off'} ` +
        `interval=${config.schedule.enabled ? `${config.schedule.checkIntervalMinutes}m` : 'off'} ` +
        `level3Gate=${config.gate.level3HardBlock ? 'enforce' : 'shadow'}`);
}
/**
 * Resolve a session's project root from the host's own signals.
 *
 * Mirrors the tool path in `shared.ts` but takes the session id and cwd the
 * event feed hands over, because the collector has no tool execution context.
 *
 * @param _sessionId - session the event came from. Unused: the root is taken
 *   from the header cwd or the working directory service, never from the id.
 * @param headerCwd - the session header's cwd, when present.
 * @param ctx - plugin context.
 * @returns absolute project root, or `undefined`.
 */
function resolveSessionRoot(_sessionId, headerCwd, ctx) {
    if (typeof headerCwd === 'string' && headerCwd.length > 0)
        return headerCwd;
    const directory = ctx.get('workingDirectory');
    if (directory === undefined)
        return undefined;
    // The live lookup needs the session handle, which the feed does not retain;
    // the header cwd is the durable signal and is used above when available.
    const fallback = directory.defaultDirectory;
    if (typeof fallback === 'string' && fallback.length > 0)
        return fallback;
    return undefined;
}
/**
 * Ask the user what to do about an existing tree or session.
 *
 * A card beats a paragraph: telling the user to go somewhere else and type
 * "重建" is delegating the plugin's own job back to them.
 *
 * @returns `rebuild`, `keep`, or `undefined` when dismissed.
 */
async function askRebuildChoice(ctx, agent, facts) {
    const questions = ctx.get('userQuestions');
    if (questions === undefined)
        return undefined;
    const { hasTree, version, sessionState } = facts;
    const where = sessionState.kind === 'live'
        ? `会话「${sessionState.title}」正在运行`
        : sessionState.kind === 'archived'
            ? `会话「${sessionState.title}」已归档`
            : sessionState.kind === 'gone'
                ? '原会话已被删除'
                : sessionState.reason;
    const stateLine = hasTree
        ? `这个工作区已有一棵确认过的目标树（版本 ${version ?? '?'}），${where}。`
        : `还没有目标树，${where}。`;
    const detail = sessionState.kind === 'gone'
        ? '重建会新建一个认知监控会话。'
        : '重建会在原有会话里重新推导，历史对话保留，但现有目标树会被替换。';
    try {
        const answer = await questions.ask({
            agent,
            questions: [
                {
                    id: 'rebuild',
                    header: '认知监控',
                    question: `${stateLine}要重新初始化吗？`,
                    detail,
                    options: [
                        {
                            label: '重建',
                            description: sessionState.kind === 'gone'
                                ? '新建会话并重新推导目标与矛盾'
                                : '在原有会话中重新推导，替换现有目标树',
                        },
                        {
                            label: '保持现状',
                            description: hasTree ? '不做任何改动，去会话里查看' : '取消本次初始化',
                        },
                    ],
                },
            ],
        });
        const first = answer.answers[0];
        const selected = first?.selected?.[0];
        if (selected === '重建')
            return 'rebuild';
        if (selected === '保持现状')
            return 'keep';
        return undefined;
    }
    catch (error) {
        ctx.logger.warn(`[dsh-metacog] rebuild question failed: ${String(error)}`);
        return undefined;
    }
}
/**
 * Create or reuse the session, then deliver the initialisation instruction.
 *
 * @param input - resolved project identity plus what the caller decided.
 * @returns the text shown to the user.
 */
async function runInitialisation(input) {
    const { ctx, config, store, projectId, projectRoot, workspaceName, hasTree } = input;
    // The version is what makes a rebuild admissible: without it the tool cannot
    // tell a deliberate restatement from an accidental wipe. Reading it here means
    // the kickoff carries the exact number instead of asking the model to look.
    const treeVersion = hasTree ? (await store.readState(projectId))?.version : undefined;
    // A missing model is not a reason to refuse: the host resolves it the same way
    // the GUI does. What a missing model does do is leave the preset's persona
    // section unassemblable, so the failure is reported rather than swallowed.
    const resolution = await ensureMetacogSession({
        ctx, config, store, projectId, projectRoot,
        // The triggering conversation supplies the preset the new one inherits.
        ...(input.inheritFrom === undefined ? {} : { inheritFrom: input.inheritFrom }),
        ...(input.knownTools === undefined ? {} : { knownTools: input.knownTools }),
    }, hasTree, input.model);
    if (resolution.status === 'unsupported') {
        return (`无法创建认知监控会话：${resolution.reason}。` +
            '请手动新建一个会话，并在其中调用 goal_tree_init。');
    }
    // One line, and only what the protocol section cannot know. Everything
    // procedural lives in the session's system prompt and is re-read each turn.
    const instruction = buildInitKickoff(workspaceName, hasTree, treeVersion);
    // Delivery order, most reliable first:
    //   1. agent.followup — the agent's own inbox, admitted inside its driver
    //      chain, so prompt assembly carries `context.agent` and `{{model}}`
    //      resolves. This is what the schedule service itself uses.
    //   2. sessionController.prompt — the GUI's path; needs the remote codec, so
    //      it is a fallback rather than the primary.
    //   3. schedule reminder — last resort; a fresh session cannot assemble a
    //      prompt this way, so the caller is warned explicitly.
    let deliveryNote = '';
    if (!followupToAgent(resolution.agent, instruction)) {
        const viaController = await deliverViaController(ctx, resolution.sessionId, instruction);
        if (!viaController.ok) {
            const delivery = await deliverToSession(ctx, resolution.sessionId, '认知监控初始化', instruction);
            if (!delivery.ok) {
                return (`会话「${resolution.title}」已创建，但无法自动投递第一条消息：` +
                    `${viaController.reason}；${delivery.reason}。` +
                    '请打开那个会话并手动说「开始认知监控初始化」。');
            }
            deliveryNote =
                '\n（本次通过提醒投递；若该会话报 prompt 变量错误，在那个会话里随手发一条消息即可恢复。）';
        }
    }
    // A workspace-attachment problem is not fatal — the conversation exists and
    // will open — but it means the session will not appear under the project in
    // the sidebar, so the user deserves to know rather than hunt for it.
    const groupingNote = resolution.status === 'created' &&
        resolution.grouping !== undefined &&
        !resolution.grouping.startsWith('attached to workspace')
        ? `\n（工作区归属异常：${resolution.grouping}）`
        : '';
    return (`已在会话「${resolution.title}」中开始认知监控初始化，请切换到那个会话继续。` +
        groupingNote +
        deliveryNote);
}
/** Total files and bytes under a path, or `undefined` when it does not exist. */
async function measurePath(path) {
    let info;
    try {
        info = await stat(path);
    }
    catch {
        return undefined;
    }
    if (!info.isDirectory())
        return { files: 1, bytes: info.size };
    let files = 0;
    let bytes = 0;
    for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = await measurePath(`${path}/${entry.name}`);
        if (child === undefined)
            continue;
        files += child.files;
        bytes += child.bytes;
    }
    return { files, bytes };
}
