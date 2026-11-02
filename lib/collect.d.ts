import type { Disposer, HostContext } from './host.js';
import type { MetacogConfig } from './config.js';
import type { MetacogStore } from './data/store.js';
/**
 * Structural shape of the `session/event` payload this module consumes.
 *
 * Declared narrowly and verified against the live host on 2026-10-27 (inspect
 * `Event.listEvents` with `event: "session/event"`): the signature is
 * `(session, event)` and every payload field lives under `event.data`.
 */
export interface SessionEventLike {
    readonly type: string;
    readonly seq?: number;
    readonly time?: number;
    readonly data?: unknown;
}
/** The session handle the feed passes alongside the event. */
export interface SessionLike {
    readonly id: string;
    readonly header?: {
        cwd?: string;
    };
}
/** One collected activity, before it reaches the analysis service. */
export interface CollectedActivity {
    readonly summary: string;
    readonly evidence: string[];
    readonly grade: 'A' | 'B';
    readonly sessionId: string;
    readonly fingerprint: string;
    readonly toolName?: string;
    /**
     * Every tool this activity's window called, in order.
     *
     * Present on turn activities and absent on single tool events (which are their
     * own one-element window). The v4 signals need the sequence, not one name:
     * `s3_tool_novel` asks whether *any* call left the declared whitelist, and a
     * turn that read four files and then ran one undeclared shell command is a
     * different fact from a turn that only read files. A single `toolName` cannot
     * express that, and neither can the set — order matters for replaying the
     * score step by step.
     */
    readonly toolNames?: string[];
    /**
     * Tool results recorded in this window, paired with the tool that produced
     * them.
     *
     * Kept to a summary of each result rather than the payload: the analyser needs
     * to know *whether* a test went from failing to passing, not what the whole
     * test log said, and the full transcript already lives in the session log.
     */
    readonly toolResults?: CollectedToolResult[];
    /**
     * File paths each call named, parallel to {@link toolNames}.
     *
     * Index-aligned rather than flattened, because a plan step is judged against a
     * *slice* of the turn: "the step that edited src/api" can only be recognised
     * if the path stays attached to the call that carried it. A call that named no
     * file contributes an empty array, so the two lists never drift apart.
     *
     * Optional for the same reason as `toolNames`: records written before this
     * existed carry none, and an absent list must read as "not recorded" rather
     * than "touched nothing".
     */
    readonly toolPaths?: string[][];
    /**
     * Where the activity came from.
     *
     * `turn` is the normal case now: the unit of monitoring is a completed
     * conversation turn and the report it closed with, not an individual tool call.
     */
    readonly source: 'tool_event' | 'user_input' | 'turn';
}
/**
 * One tool's outcome, reduced to what the progress signal can use.
 *
 * `ok` is the host's own success flag when it reports one. It is deliberately
 * tri-state: a missing flag is not a failure, and treating it as one would make
 * every tool whose result shape we do not recognise look like a failed step.
 */
export interface CollectedToolResult {
    readonly tool: string;
    readonly ok: boolean | null;
    /** First line or so of the result, enough to classify it. */
    readonly excerpt: string;
    /**
     * What the this result appears to say about a checkable outcome.
     *
     * `null` when nothing recognisable was found. Distinguishing "no signal" from
     * "signals failure" matters: a `pwsh` call that ran `ls` is not evidence that
     * tests failed.
     */
    readonly outcome: 'tests-pass' | 'tests-fail' | 'build-pass' | 'build-fail' | null;
    /**
     * Digest of the arguments that produced this result.
     *
     * Empty when the call's arguments were not seen. The behaviour track compares
     * this to decide whether two consecutive calls were the *same* call, which is
     * what separates a stuck loop from ordinary iteration.
     */
    readonly signature: string;
}
/** What the collector recorded, for the mount's own diagnostics. */
export interface CollectorStats {
    /** Events seen on the feed, including ignored ones. */
    seen: number;
    /** Activities handed to the analysis path. */
    recorded: number;
    /** Events ignored because they carry no verifiable activity. */
    ignored: number;
    /** Activities dropped because the project was not initialized. */
    skippedUninitialized: number;
    /** Handlers that threw (contained, never propagated). */
    errors: number;
}
/**
 * Turn one tool call into a sentence a rule can actually judge.
 *
 * `"edit (tool call)"` names no object: no goal can match it, so every such call
 * reads as drift. What a project actually changes is its files and its commands,
 * so those are the two things worth naming — and that is what "monitor the
 * output, not the keystroke" means in practice.
 *
 * @param toolName - the tool that ran.
 * @param rawArguments - its arguments as the host reports them.
 * @returns a summary, or `undefined` when this tool says nothing useful.
 */
export declare function describeToolCall(toolName: string, rawArguments: unknown): string | undefined;
/**
 * Classify a tool result as evidence about a checkable outcome.
 *
 * The v4 progress signal (S5) asks a narrow question: did anything verifiably
 * change? "The tests went from failing to passing" is the clearest answer to it,
 * and it is only visible in the *result*, which the collector used to discard.
 *
 * The classification is deliberately conservative. It reads the head of the
 * output for a small set of markers that only a test or build run produces, and
 * returns `null` for everything else — including a `pwsh` call that merely listed
 * a directory, which shares no markers with a test run and must not be counted
 * as a failed test simply because it printed nothing.
 *
 * @param toolName - tool that produced the result.
 * @param data - the `tool/result` payload.
 * @returns the recorded result, or `undefined` when it carries nothing usable.
 */
export declare function describeToolResult(toolName: string, data: unknown): CollectedToolResult | undefined;
/**
 * A short, stable digest of a tool call's arguments.
 *
 * Used to tell "called the same tool again" from "called it with the same
 * arguments again" — the difference between normal iteration and a stuck loop.
 *
 * `JSON.stringify` is not enough on its own: key order is insertion order, so the
 * same logical call can serialise two ways. The object is therefore sorted before
 * hashing. A digest rather than the raw arguments keeps the record small and stops
 * a long command line from being copied into every activity row.
 *
 * @param args - the `arguments` field of one `tool/call`.
 * @returns a 16-character hex digest, or empty when there is nothing to hash.
 */
export declare function signatureOf(args: unknown): string;
/**
 * Build the collection record for one tool call.
 *
 * @param sessionId - session that produced the call.
 * @param data - the `tool/call` payload.
 * @returns the activity to record, or `undefined` when it is not activity.
 */
export declare function collectToolCall(sessionId: string, data: unknown): CollectedActivity | undefined;
/**
 * Build the collection record for one user message.
 *
 * A user message is direct, first-hand description of what the user is doing;
 * the spec grades exactly that as Grade A. The message text is its own evidence
 * because the user authored it, so the record carries the clamped text.
 *
 * @param sessionId - session that produced the message.
 * @param seq - the event's log sequence, used as the dedupe identity.
 * @param data - the `user/message` payload.
 * @returns the activity to record, or `undefined` for an empty message.
 */
export declare function collectUserMessage(sessionId: string, seq: number | undefined, data: unknown): CollectedActivity | undefined;
/**
 * Whether a message is host-injected scaffolding rather than a user utterance.
 *
 * @param text - the extracted message text.
 */
export declare function isInjectedBlock(text: string): boolean;
/**
 * Build the activity for one completed conversation turn.
 *
 * The unit of monitoring is a *turn*, not a tool call. What a turn did is stated
 * by its own closing report; the calls it made along the way are how it got
 * there, so they become the evidence behind that report rather than separate
 * activities. This is also the only summary with enough meaning for a rule to
 * judge: `edit (tool call)` names no object, which is why the first live run
 * called 100% of activity drift.
 *
 * @param sessionId - session the turn belongs to.
 * @param turn - turn number, used for the dedupe identity.
 * @param report - the assistant's final message of that turn.
 * @param evidence - artifacts the turn touched.
 */
export declare function collectTurnReport(sessionId: string, turn: number, report: string, evidence?: readonly string[], trace?: {
    toolNames?: readonly string[];
    toolResults?: readonly CollectedToolResult[];
    toolPaths?: readonly (readonly string[])[];
}): CollectedActivity | undefined;
/** Everything the collector needs from the mount. */
export interface CollectorOptions {
    readonly ctx: HostContext;
    readonly config: MetacogConfig;
    /** Resolve the store for a session, or `undefined` when not initialized. */
    readonly storeForSession: (sessionId: string, cwd: string | undefined) => Promise<{
        store: MetacogStore;
        projectId: string;
    } | undefined>;
    /** Hand a collected activity to the analysis path. */
    readonly onActivity: (activity: CollectedActivity, context: {
        store: MetacogStore;
        projectId: string;
    }) => Promise<void>;
}
/**
 * Subscribe the collector to the host feed.
 *
 * @param options - mount context, policy and sinks.
 * @returns the stats object (live) plus the disposer.
 */
export declare function installCollector(options: CollectorOptions): {
    stats: CollectorStats;
    dispose: Disposer;
};
/**
 * Describe the collector's capability boundary for the API table and logs.
 *
 * @param available - whether the host exposed the feed.
 */
export declare function collectorBoundary(available: boolean): string;
