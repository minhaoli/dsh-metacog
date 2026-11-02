/**
 * The Level 0–3 escalation state machine.
 *
 * Every threshold decision lives here, and every one of them is taken from
 * configuration rather than hard-coded at a call site, so an operator can retune
 * the monitor without touching code. The rules, in order:
 *
 * - Level 0: recorded silently. Everything that is not escalated stops here.
 * - Level 1: one in-context hint, no answer required. Triggered by a single
 *   high-confidence drift, or by a blocking contradiction that has not eased.
 * - Level 2: a pending intervention card. Needs `repeatThreshold` same-class
 *   high-confidence signals inside the window, and no open pending card for
 *   that class.
 * - Level 3: a gate. Needs a `core_bypass` that has itself repeated to the
 *   threshold, with the contradiction's observed intensity at or above 4, and
 *   no open pending card.
 *
 * The "no open pending card" precondition is what makes the ladder idempotent:
 * once a card is open, further signals of the same class are recorded at Level 1
 * instead of opening a second card, so a long drift produces one decision, not a
 * stack of them.
 *
 * @module dsh-metacog/analysis/escalation
 */
import type { DriftSignal, DriftSignalType, InterventionRecord, ResponseLevel } from '../data/types.js';
import type { MetacogConfig } from '../config.js';
/** One escalation decision for one draft signal. */
export interface EscalationDecision {
    /** Level to record on the signal. */
    level: ResponseLevel;
    /** Whether this decision opens a new intervention record. */
    openIntervention: boolean;
    /** Same-class signals counted inside the window, including this one. */
    repeatCount: number;
    /** Number of interventions already pending for this class, before deciding. */
    pendingForClass: number;
    /**
     * One or two Chinese lines telling the user what happened and what to do.
     *
     * The prompt block reads this, never `rationale`: the latter names thresholds
     * and signal classes for the audit trail and reads as an accusation when shown
     * to a person.
     */
    hint: string;
    /** One-sentence justification, quoting the thresholds that fired. */
    rationale: string;
}
/** Everything the machine reads. */
export interface EscalationContext {
    /** The draft's signal class. */
    signalType: DriftSignalType;
    relatedContradictionIds: readonly string[];
    relatedGoalIds: readonly string[];
    /** Confidence of the incoming signal. */
    confidence: number;
    /** Highest observed intensity of its contradiction, when it has one. */
    intensity: number;
    /** Whether the activity that produced it may escalate at all (grade gate). */
    mayEscalate: boolean;
    /** Already-recorded signals, any age. */
    signals: readonly DriftSignal[];
    /** Current intervention records, deduplicated to newest per id. */
    interventions: readonly InterventionRecord[];
    config: MetacogConfig;
    now: Date;
}
/** Intensity at which a core bypass becomes a Level 3 gate (spec 4.4 item 4). */
export declare const LEVEL3_MIN_INTENSITY = 4;
/**
 * Decide the response level for one draft signal.
 *
 * @param context - the draft plus the project's recorded history.
 * @returns the level, whether to open an intervention, and why.
 */
export declare function decideEscalation(context: EscalationContext): EscalationDecision;
/**
 * Suggested actions attached to a Level 2/3 card (spec 4.4 item 3).
 *
 * @param level - 2 or 3.
 * @param signalType - the signal that opened the card.
 * @param goalTitles - readable names for the affected goals.
 * @param contradictionTitle - the blocking contradiction, when known.
 * @returns the candidate actions the user can choose between.
 */
export declare function suggestedActions(level: 2 | 3, signalType: DriftSignalType, goalTitles: readonly string[], contradictionTitle: string | undefined): string[];
/**
 * One hint's budget, in characters.
 *
 * The prompt block is read at a glance; a hint that needs a third line has
 * stopped being a hint and become the rationale it was split from.
 */
export declare const HINT_MAX_CHARS = 60;
/**
 * Trim a hint to the budget, marking the cut rather than silently dropping text.
 *
 * @param text - candidate hint.
 * @param limit - character budget; defaults to {@link HINT_MAX_CHARS}.
 */
export declare function clampHint(text: string, limit?: number): string;
/**
 * Explain why a step was not escalated for lack of evidence coverage.
 *
 * The coverage floor is checked in the signal aggregator, which returns level 0
 * without saying anything. Silence there is indistinguishable from "the monitor
 * is broken": a session without a declared plan can sit at 0.25 coverage for a
 * long time, and the user never learns that the monitor was simply blind.
 *
 * @param coverage - available weight / total weight for this step (0–1).
 * @param floor - configured minimum coverage.
 * @param hasPlan - whether the session declared a plan.
 * @returns a Chinese explanation, or `undefined` when coverage is sufficient.
 */
export declare function coverageHint(coverage: number, floor: number, hasPlan: boolean): string | undefined;
/**
 * Render the one-line Level 1 hint injected into the prompt (spec 4.4 item 2).
 *
 * Only `signal.hint` is rendered. The technical `rationale` used to be appended
 * here, which put threshold names and signal classes in front of the model (and
 * the user) as if they were advice. Signals written before the split carry an
 * empty hint, so they get a generic Chinese line instead of the old English
 * sentence.
 *
 * @param signal - the Level 1 signal.
 * @returns a single short line.
 */
export declare function level1Hint(signal: DriftSignal): string;
/**
 * Render the reminder injected while a Level 2/3 card is pending.
 *
 * Prefers the record's own Chinese hint; a record written before the split has
 * none, and its `promptSummary` is technical, so the fallback names the tool
 * that resolves the card rather than showing that summary.
 *
 * @param record - the pending intervention.
 * @returns a single short line naming the decision awaited.
 */
export declare function pendingInterventionHint(record: InterventionRecord): string;
