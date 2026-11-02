import type { ActivityRecord, GoalNode } from '../data/types.js';
/** Default ceiling for the rendered prompt, in estimated tokens. */
export declare const DEFAULT_MAX_INPUT_TOKENS = 1000;
/** Default wall-clock ceiling for one verdict call. */
export declare const DEFAULT_TIMEOUT_MS = 20000;
/** Hard cap on goals sent to the model: more would stop being "relevant". */
export declare const MAX_GOALS = 2;
/**
 * The one-line explanation shown when the plan's goal is vague.
 *
 * It names the consequence (both the realtime verdict and plan matching are
 * unreliable) and the action (`metacog_revise_plan`), because "the goal is
 * vague" alone leaves the user with nothing to do about it.
 */
export declare const VAGUE_GOAL_HINT = "\u672C\u6B21\u4F1A\u8BDD\u76EE\u6807\u88AB\u6807\u8BB0\u4E3A\u6A21\u7CCA\uFF0C\u5B9E\u65F6\u5224\u5B9A\u4E0E\u8BA1\u5212\u5339\u914D\u90FD\u4E0D\u591F\u53EF\u9760\uFF1B\u5EFA\u8BAE\u7528 metacog_revise_plan \u8865\u4E00\u4E2A\u5177\u4F53\u76EE\u6807\u3002";
/**
 * The hint a vague goal produces, or `undefined` for a concrete goal.
 *
 * @param input - the verdict input carrying the plan's vagueness fact.
 * @returns a clamped one-line hint.
 */
export declare function vagueGoalHint(input: VerdictInput): string | undefined;
/** One goal as the model sees it: no description, criteria or evidence. */
export interface VerdictGoal {
    readonly id: string;
    readonly title: string;
    readonly relevantActivities: readonly string[];
    readonly paths: readonly string[];
}
/** One activity line as the model sees it. */
export interface VerdictActivity {
    /** ISO timestamp, or an already-formatted clock string. */
    readonly at: string;
    /** One-line summary of what happened. */
    readonly action: string;
    /** Paths the activity touched, when known. */
    readonly paths?: readonly string[];
}
/** Everything one verdict call needs from the caller. */
export interface VerdictInput {
    readonly goals: readonly VerdictGoal[];
    readonly activities: readonly VerdictActivity[];
    /**
     * Whether the session's declared goal was accepted as vague
     * (`DeclaredPlan.vagueGoal`).
     *
     * A vague goal is not a weaker goal; it is a goal whose text does not name a
     * checkable target. Asking "how well does this work match it" then has no
     * defensible answer, so the call must say so instead of producing a number
     * that looks like a measurement.
     */
    readonly vagueGoal?: boolean;
    /** Why the vague goal was accepted; shown to the model and the user. */
    readonly vagueGoalReason?: string;
}
/** The strict five-field answer. */
export interface Verdict {
    /**
     * Alignment score, or `null` when the goal is vague and no reliable score
     * can be produced.
     *
     * `null` is not zero and not "unknown so treat as fine": it is the explicit
     * statement that this question is unanswerable for this goal. Callers must
     * check for it before comparing against a threshold.
     */
    readonly match: number | null;
    readonly goalId: string | null;
    readonly reason: string;
    /**
     * What the model expects to see next, in one short sentence.
     *
     * Persisted per project and compared with the following window's activity by
     * the next stage: a model's own expectation is a sharper signal than a
     * match score, and it costs no extra call — only this field.
     */
    readonly expectNext: string;
    /**
     * Whether the previous expectation was met: `true` / `false`, or `null` when
     * there was no previous expectation to compare against.
     *
     * Deliberately a separate question from `match`: work can stay fully aligned
     * while the direction changes from what was predicted, which is a normal
     * change of mind, not drift. `false` here is a prompt to look, never a drift
     * conclusion.
     */
    readonly fulfilled: boolean | null;
}
/** Provider-reported usage, kept optional because not every adapter reports it. */
export interface TokenUsageLike {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly reasoningTokens?: number;
}
/** Cost facts for one call, recorded even when the call fails. */
export interface VerdictMeta {
    readonly provider: string;
    readonly model: string;
    readonly elapsedMs: number;
    readonly inputChars: number;
    readonly outputChars: number;
    readonly usage?: TokenUsageLike;
}
/** Why a verdict call did not produce a usable answer. */
export type VerdictReasonKey = 'unavailable' | 'no_model' | 'no_adapter' | 'model_missing' | 'timeout' | 'aborted' | 'auth' | 'rate_limit' | 'network' | 'invalid_output' | 'other';
/** A failed call: never thrown, always returned. */
export interface VerdictFailure {
    readonly ok: false;
    readonly status: 'failed' | 'unavailable';
    readonly reason: string;
    readonly reasonKey: VerdictReasonKey;
    readonly meta?: VerdictMeta;
}
/** One persisted expectation, with the verdict that produced it. */
export interface ExpectationRecord {
    readonly expectNext: string;
    /** When the expectation was recorded, ISO. */
    readonly at: string;
    /** The match score of the call that produced it; `null` when vague. */
    readonly match: number | null;
    /** The goal that call named, when any. */
    readonly goalId: string | null;
}
/**
 * The previous expectation and the one just produced.
 *
 * `fulfilled` is answered by the same call that produced `current`: the model
 * has both the previous expectation and this window in front of it, so asking
 * again (or guessing locally) would be a second, worse judgement. It stays
 * `null` when there was no previous expectation, and `false` is only a prompt
 * to look — the drift decision still belongs to `match` and `reason`.
 */
export interface ExpectationComparison {
    readonly previous: ExpectationRecord | null;
    readonly current: ExpectationRecord;
    readonly fulfilled: boolean | null;
}
/** A successful call with its parsed answer. */
export interface VerdictSuccess {
    readonly ok: true;
    readonly status: 'ok';
    readonly verdict: Verdict;
    readonly meta: VerdictMeta;
    readonly expectation: ExpectationComparison;
    /**
     * Hints this verdict itself produced, already clamped.
     *
     * Only a vague goal produces one today: "the goal is vague, so this verdict
     * is unreliable; consider revising the plan". A low score is deliberately
     * *not* turned into a hint here — that decision belongs to the scheduler,
     * which owns the threshold and must skip it when `match` is null.
     */
    readonly hints: readonly string[];
}
/**
 * An empty window: no model call is made at all.
 *
 * This is a result rather than an error so a scheduler can skip the tick
 * without inspecting activities itself. It is also the cheapest possible
 * outcome: an idle window costs one local check, not a request.
 */
export interface VerdictIdle {
    readonly ok: true;
    readonly status: 'idle';
    readonly reason: string;
}
export type VerdictResult = VerdictSuccess | VerdictFailure | VerdictIdle;
/** The slice of the host `llm` service this module calls. */
export interface LlmStreamChunk {
    readonly type: string;
    readonly text?: string;
    readonly usage?: TokenUsageLike;
}
/** One user-message text block, in the host's request shape. */
export interface LlmTextMessage {
    readonly role: 'user';
    readonly content: readonly {
        readonly type: 'text';
        readonly text: string;
    }[];
}
/** Options this module passes to `llm.stream`. */
export interface LlmGenerateOptions {
    readonly provider: string;
    readonly model: string;
    readonly messages: readonly LlmTextMessage[];
    readonly maxTokens?: number;
    readonly signal?: AbortSignal;
}
/** The service surface, narrowed so tests can stand in a fake. */
export interface LlmServiceLike {
    stream(options: LlmGenerateOptions): AsyncIterable<LlmStreamChunk> | Promise<AsyncIterable<LlmStreamChunk>>;
}
/**
 * Estimate tokens conservatively enough for a budget check.
 *
 * ASCII runs at four characters per token; every non-ASCII code point counts
 * as one token. That over-estimates CJK rather than under-estimating it,
 * which is the safe direction for a hard ceiling.
 *
 * @param text - rendered prompt or any fragment.
 * @returns estimated token count.
 */
export declare function estimateTokens(text: string): number;
/**
 * Pick the goals the window is most plausibly about.
 *
 * Path ownership is the strongest signal, then activity keywords. When nothing
 * matches, the first goals are kept rather than sending an empty goal list: a
 * verdict with no goal to name would always answer `goalId: null` and say
 * nothing about whether the work is on target.
 *
 * @param goals - candidate goals, in caller order.
 * @param activities - the window.
 * @param limit - maximum goals to return (default {@link MAX_GOALS}).
 * @returns up to `limit` goals, most relevant first.
 */
export declare function selectRelevantGoals(goals: readonly VerdictGoal[], activities: readonly VerdictActivity[], limit?: number): VerdictGoal[];
/** The rendered prompt plus what actually fit. */
export interface VerdictPrompt {
    readonly text: string;
    readonly goals: readonly VerdictGoal[];
    readonly activities: number;
    readonly estimatedTokens: number;
}
/** Budget and shaping knobs for {@link buildVerdictPrompt}. */
export interface BuildPromptOptions {
    readonly maxInputTokens?: number;
    readonly maxActivities?: number;
    readonly maxGoals?: number;
    /**
     * The previous expectation, when one was persisted. `null` (or absent) means
     * this is the first verdict for the project, and the prompt says so
     * explicitly so the model answers `fulfilled: null` instead of guessing.
     */
    readonly previousExpectNext?: string | null;
}
/**
 * Build the one user message for a verdict call.
 *
 * Goals are selected first, then the newest activity lines are added while the
 * estimate stays under the budget. Dropping the oldest lines rather than the
 * newest is intentional: the question is what the current window is about, and
 * the newest work is the best evidence for that.
 *
 * @param input - goals and activities for this window.
 * @param options - budget and shaping knobs.
 * @returns the prompt and the subset of goals/activities it contains.
 */
export declare function buildVerdictPrompt(input: VerdictInput, options?: BuildPromptOptions): VerdictPrompt;
export type VerdictParseResult = {
    readonly ok: true;
    readonly verdict: Verdict;
} | {
    readonly ok: false;
    readonly error: string;
};
/**
 * Parse and validate the strict five-field answer.
 *
 * Extra fields are rejected rather than ignored: the contract says five
 * fields, and silently accepting a sixth makes the next prompt change
 * impossible to reason about. `goalId` is checked against the ids that were
 * actually sent, so a model cannot name a goal the caller never offered.
 *
 * When `hasPrevious` is `false`, `fulfilled` is normalized to `null` even if
 * the model returned a boolean. A first call has nothing to compare against,
 * and letting a stray `false` through would read as "failed on the first try".
 *
 * @param text - raw model output.
 * @param goalIds - ids sent in the prompt, when known.
 * @param options.hasPrevious - whether a previous expectation was sent.
 * @returns the verdict, or a readable reason it is unusable.
 */
export declare function parseVerdict(text: string, goalIds?: readonly string[], options?: {
    readonly hasPrevious?: boolean;
    readonly allowNullMatch?: boolean;
}): VerdictParseResult;
/** A classified failure: a stable key for suppression plus a human sentence. */
export interface ClassifiedFailure {
    readonly key: VerdictReasonKey;
    readonly reason: string;
}
/**
 * Classify one failure into a suppression key.
 *
 * The key is what makes "suppress by reason" real: a missing model and a
 * dropped socket must not mask each other. The raw message is kept for the
 * reminder so the user can tell what actually happened.
 *
 * @param error - thrown value from the adapter or the stream.
 * @param timedOut - whether this module's own timeout fired.
 * @param aborted - whether the caller's signal aborted the call.
 * @returns stable key and message.
 */
export declare function classifyVerdictFailure(error: unknown, timedOut?: boolean, aborted?: boolean): ClassifiedFailure;
/** Persisted suppression state, keyed by {@link VerdictReasonKey}. */
export interface FailureState {
    readonly version: 1;
    /** reasonKey → ISO time it was first suppressed. */
    readonly suppressed: Record<string, string>;
    readonly updatedAt: string;
}
/**
 * Where the failure state lives, following the project's storage convention.
 *
 * @param projectRoot - project directory.
 * @param storageSubdir - configured `.metacog`-style subdirectory.
 * @returns absolute path of the JSON state file.
 */
export declare function failureStatePath(projectRoot: string, storageSubdir: string): string;
/** A state with nothing suppressed. */
export declare function emptyFailureState(now?: Date): FailureState;
/** Read the persisted state; a missing or corrupt file reads as empty. */
export declare function readFailureState(path: string): FailureState;
/** Write the state atomically (temp + rename). */
export declare function writeFailureState(path: string, state: FailureState): void;
/** Persisted expectations, one per project. */
export interface ExpectationState {
    readonly version: 1;
    /** projectId → the latest expectation recorded for it. */
    readonly projects: Record<string, ExpectationRecord>;
    readonly updatedAt: string;
}
/**
 * Where per-project expectations live, following the storage convention.
 *
 * @param projectRoot - project directory.
 * @param storageSubdir - configured `.metacog`-style subdirectory.
 * @returns absolute path of the JSON state file.
 */
export declare function expectationStatePath(projectRoot: string, storageSubdir: string): string;
/** A state with no recorded expectation. */
export declare function emptyExpectationState(now?: Date): ExpectationState;
/** Read persisted expectations; a missing or corrupt file reads as empty. */
export declare function readExpectationState(path: string): ExpectationState;
/** Write expectations atomically (temp + rename). */
export declare function writeExpectationState(path: string, state: ExpectationState): void;
/** Options for {@link RealtimeFailureReminder}. */
export interface FailureReminderOptions {
    /** Persisted state file, usually {@link failureStatePath}. */
    readonly statePath: string;
    /** How one reminder reaches the user. */
    readonly remind: (message: string) => void;
    /** Clock injection point for deterministic tests. */
    readonly now?: () => Date;
}
/**
 * Remind once per failure reason, stay quiet until a success re-arms.
 *
 * State is persisted because a restart is not a recovery: without the file,
 * every launch would repeat the same "model not found" reminder and the user
 * would learn to ignore it. A success clears every suppression, so a later
 * failure of any kind is worth one new reminder.
 */
export declare class RealtimeFailureReminder {
    #private;
    constructor(options: FailureReminderOptions);
    /** Reasons currently suppressed, sorted for stable assertions. */
    get suppressedKeys(): readonly string[];
    /**
     * Record one failure and remind only when this reason is not suppressed.
     *
     * @param reasonKey - classified key.
     * @param reason - human sentence for the reminder.
     * @returns whether a reminder was emitted.
     */
    recordFailure(reasonKey: string, reason: string): boolean;
    /**
     * Record one success: clear every suppression so a later failure re-arms.
     *
     * @returns whether anything was cleared.
     */
    recordSuccess(): boolean;
}
/** Options for {@link runRealtimeVerdict}. */
export interface RunVerdictOptions {
    /** Host `llm` service, or undefined when the deployment has none. */
    readonly llm: LlmServiceLike | undefined;
    /** Provider route; empty means the caller must resolve the global model. */
    readonly provider: string;
    /** Model id; empty means the caller must resolve the global model. */
    readonly model: string;
    readonly maxInputTokens?: number;
    readonly timeoutMs?: number;
    readonly maxOutputTokens?: number;
    readonly signal?: AbortSignal;
    /** Reminder state machine; when present, failures and successes update it. */
    readonly reminder?: RealtimeFailureReminder;
    /** Clock injection point for deterministic cost facts. */
    readonly now?: () => number;
    /** Project the expectation belongs to; omit to skip expectation persistence. */
    readonly projectId?: string;
    /** Per-project expectation state file; omit to skip persistence. */
    readonly expectationPath?: string;
    /** ISO clock injection for the expectation timestamp. */
    readonly nowIso?: () => string;
}
/**
 * Run one bare verdict call.
 *
 * Never throws: every failure becomes a {@link VerdictFailure} with a stable
 * reason key, so a scheduler can decide what to do without a try/catch around
 * every tick. A timeout aborts the adapter's stream and wins the race even if
 * the adapter ignores the signal.
 *
 * @param input - goals and activities for this window.
 * @param options - service, model route, budget, timeout and reminder.
 * @returns the parsed verdict or a classified failure.
 */
export declare function runRealtimeVerdict(input: VerdictInput, options: RunVerdictOptions): Promise<VerdictResult>;
/** Project one stored goal into the model-facing shape. */
export declare function toVerdictGoal(goal: GoalNode): VerdictGoal;
/** Project one activity record into the model-facing shape. */
export declare function toVerdictActivity(activity: ActivityRecord): VerdictActivity;
