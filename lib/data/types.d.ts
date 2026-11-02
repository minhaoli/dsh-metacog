/**
 * Canonical data model for the metacognitive monitor.
 *
 * Every structure the spec defines lives here exactly once, as a zod schema
 * plus the inferred TypeScript type. The schema is the source of truth: it
 * validates both what a tool accepts and what a store returns, so a corrupted
 * or hand-edited state file is rejected at the boundary instead of silently
 * flowing into the analyser.
 *
 * Persistence never trusts a caller's object shape. Tools parse their input
 * through these schemas, the analyser builds values through these schemas, and
 * the store re-parses on read.
 *
 * @module dsh-metacog/data/types
 */
import { z } from 'zod';
/** ISO-8601 timestamp string that JavaScript can actually parse. */
export declare const IsoTimestampSchema: z.ZodString;
/** Non-empty identifier with no path separators, so it is safe as a filename. */
export declare const SafeIdSchema: z.ZodString;
/** Deepest goal the program accepts. A sanity limit, not a semantic one. */
export declare const MAX_GOAL_DEPTH = 9;
/**
 * Depth of a goal: 0 is the root, larger is closer to executable work.
 *
 * Depth is a property of the content, not a constant of the design. The same
 * project reads as two levels at a coarse grain and five at a fine one, so a fixed
 * ladder forced the user either to merge (losing information) or to split
 * (manufacturing empty nodes). The `L0`–`L3` names are gone for the same reason:
 * they encoded a position that the tree itself can state.
 */
export declare const GoalDepthSchema: z.ZodNumber;
export type GoalDepth = z.infer<typeof GoalDepthSchema>;
/**
 * Where each legacy level lands after migration.
 *
 * Kept beside the schema so the store's lazy normalisation and any explicit
 * migration read the same table.
 */
export declare const LEGACY_LEVEL_DEPTH: Readonly<Record<string, number>>;
export declare const GoalStatusSchema: z.ZodEnum<{
    draft: "draft";
    active: "active";
    at_risk: "at_risk";
    blocked: "blocked";
    done: "done";
    deprecated: "deprecated";
}>;
export type GoalStatus = z.infer<typeof GoalStatusSchema>;
export declare const ExplorationPolicySchema: z.ZodEnum<{
    allowed: "allowed";
    limited: "limited";
    approval_required: "approval_required";
}>;
export type ExplorationPolicy = z.infer<typeof ExplorationPolicySchema>;
/**
 * How day-to-day work is judged against a goal.
 *
 * Deliberately separate from `successCriteria`: that field answers "when is the
 * goal complete", this one answers "which activities plausibly move it".
 * Confusing the two is what makes a monitor cry wolf over necessary dependency
 * work.
 */
export declare const GoalAlignmentSchema: z.ZodObject<{
    relevantActivities: z.ZodDefault<z.ZodArray<z.ZodString>>;
    allowedMethods: z.ZodDefault<z.ZodArray<z.ZodString>>;
    excludedActivities: z.ZodDefault<z.ZodArray<z.ZodString>>;
    explorationPolicy: z.ZodDefault<z.ZodEnum<{
        allowed: "allowed";
        limited: "limited";
        approval_required: "approval_required";
    }>>;
}, z.core.$strip>;
export type GoalAlignment = z.infer<typeof GoalAlignmentSchema>;
export declare const GoalNodeSchema: z.ZodObject<{
    id: z.ZodString;
    projectId: z.ZodString;
    parentId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    depth: z.ZodNumber;
    title: z.ZodString;
    description: z.ZodDefault<z.ZodString>;
    status: z.ZodDefault<z.ZodEnum<{
        draft: "draft";
        active: "active";
        at_risk: "at_risk";
        blocked: "blocked";
        done: "done";
        deprecated: "deprecated";
    }>>;
    priority: z.ZodDefault<z.ZodNumber>;
    confirmedByUser: z.ZodDefault<z.ZodBoolean>;
    successCriteria: z.ZodDefault<z.ZodArray<z.ZodString>>;
    alignment: z.ZodPrefault<z.ZodObject<{
        relevantActivities: z.ZodDefault<z.ZodArray<z.ZodString>>;
        allowedMethods: z.ZodDefault<z.ZodArray<z.ZodString>>;
        excludedActivities: z.ZodDefault<z.ZodArray<z.ZodString>>;
        explorationPolicy: z.ZodDefault<z.ZodEnum<{
            allowed: "allowed";
            limited: "limited";
            approval_required: "approval_required";
        }>>;
    }, z.core.$strip>>;
    paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
    evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
    deadline: z.ZodOptional<z.ZodString>;
    startedAt: z.ZodOptional<z.ZodString>;
    doneAt: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
}, z.core.$strip>;
export type GoalNode = z.infer<typeof GoalNodeSchema>;
export declare const ContradictionTypeSchema: z.ZodEnum<{
    core: "core";
    main: "main";
    secondary: "secondary";
    unclassified: "unclassified";
}>;
export declare const TrendDirectionSchema: z.ZodEnum<{
    unknown: "unknown";
    rising: "rising";
    stable: "stable";
    falling: "falling";
}>;
export type TrendDirection = z.infer<typeof TrendDirectionSchema>;
/** Intensity band: an integer 1–5, or null when evidence is insufficient. */
export declare const IntensitySchema: z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>;
/**
 * One goal a tension presses on, and how hard.
 *
 * `weight` is a fraction of full pressure: 1 means the tension is a first-class
 * problem for that goal, 0.5 means it constrains the goal without defining it.
 * The primary goal always weighs 1; weights are what make a cross-goal tension
 * comparable between the goals it touches.
 */
export declare const ContradictionGoalLinkSchema: z.ZodObject<{
    goalId: z.ZodString;
    weight: z.ZodNumber;
}, z.core.$strip>;
export type ContradictionGoalLink = z.infer<typeof ContradictionGoalLinkSchema>;
export declare const ContradictionNodeSchema: z.ZodPipe<z.ZodObject<{
    id: z.ZodString;
    projectId: z.ZodString;
    parentId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    primaryGoalId: z.ZodString;
    relatedGoalIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    relatedGoals: z.ZodOptional<z.ZodArray<z.ZodObject<{
        goalId: z.ZodString;
        weight: z.ZodNumber;
    }, z.core.$strip>>>;
    type: z.ZodDefault<z.ZodEnum<{
        core: "core";
        main: "main";
        secondary: "secondary";
        unclassified: "unclassified";
    }>>;
    confirmedByUser: z.ZodDefault<z.ZodBoolean>;
    title: z.ZodString;
    description: z.ZodDefault<z.ZodString>;
    poleA: z.ZodDefault<z.ZodString>;
    poleB: z.ZodDefault<z.ZodString>;
    intensity: z.ZodDefault<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
    trend: z.ZodDefault<z.ZodEnum<{
        unknown: "unknown";
        rising: "rising";
        stable: "stable";
        falling: "falling";
    }>>;
    rationale: z.ZodDefault<z.ZodString>;
    resolutionHint: z.ZodDefault<z.ZodString>;
    evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
    resolvedAt: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
}, z.core.$strip>, z.ZodTransform<{
    id: string;
    projectId: string;
    parentId: string | null;
    primaryGoalId: string;
    relatedGoalIds: string[];
    type: "core" | "main" | "secondary" | "unclassified";
    confirmedByUser: boolean;
    title: string;
    description: string;
    poleA: string;
    poleB: string;
    intensity: number | null;
    trend: "unknown" | "rising" | "stable" | "falling";
    rationale: string;
    resolutionHint: string;
    evidence: string[];
    createdAt: string;
    updatedAt: string;
    relatedGoals?: {
        goalId: string;
        weight: number;
    }[] | undefined;
    resolvedAt?: string | undefined;
}, {
    id: string;
    projectId: string;
    parentId: string | null;
    primaryGoalId: string;
    relatedGoalIds: string[];
    type: "core" | "main" | "secondary" | "unclassified";
    confirmedByUser: boolean;
    title: string;
    description: string;
    poleA: string;
    poleB: string;
    intensity: number | null;
    trend: "unknown" | "rising" | "stable" | "falling";
    rationale: string;
    resolutionHint: string;
    evidence: string[];
    createdAt: string;
    updatedAt: string;
    relatedGoals?: {
        goalId: string;
        weight: number;
    }[] | undefined;
    resolvedAt?: string | undefined;
}>>;
export type ContradictionNode = z.infer<typeof ContradictionNodeSchema>;
/**
 * The parts of a contradiction that goal weighting reads.
 *
 * Structural rather than `ContradictionNode` so the pure functions below can be
 * unit-tested with plain objects and reused by projections that do not carry a
 * whole node. A full `ContradictionNode` satisfies it.
 */
export interface ContradictionLinkSource {
    primaryGoalId: string;
    relatedGoalIds?: readonly string[];
    relatedGoals?: readonly ContradictionGoalLink[];
}
/** The weight knobs the burden calculation reads (a subset of the plugin config). */
export interface ContradictionWeightSettings {
    /** Weight a related link gets when the node carries none of its own. */
    defaultRelatedWeight: number;
    /**
     * When false, per-node weights are ignored and every related link gets the
     * default: one project-wide answer instead of a per-tension one.
     */
    allowNodeOverride?: boolean;
}
/** One tension's share of a goal's burden. */
export interface ContradictionBurdenContribution {
    contradictionId: string;
    weight: number;
    /** The node's stored reading; null means no evidence has been recorded yet. */
    intensity: number | null;
    /** `intensity × weight`; 0 when intensity is null. */
    score: number;
}
/**
 * Aggregated contradiction pressure on one goal.
 *
 * `total` is the sum of `intensity × weight` over every unresolved tension that
 * touches the goal. It is a relative burden score — meaningful when comparing
 * goals inside one project, not a physical quantity. A tension with no intensity
 * reading contributes 0 and is counted in `unmeasured`, so `total` is a floor
 * rather than a measurement whenever `unmeasured > 0`.
 */
export interface GoalContradictionBurden {
    goalId: string;
    total: number;
    /** Tensions that touch this goal and are still unresolved. */
    count: number;
    /** The strongest single contribution. */
    peak: number;
    /** Tensions counted in `count` that have no intensity reading yet. */
    unmeasured: number;
    /** Strongest first. */
    contributions: ContradictionBurdenContribution[];
}
/** A contradiction plus the reading the burden needs; a full node satisfies it. */
export interface ContradictionBurdenSource extends ContradictionLinkSource {
    id: string;
    intensity: number | null;
    resolvedAt?: string;
}
/**
 * Resolve a contradiction's goal links to effective weights.
 *
 * Three sources merge, in precedence order:
 *
 * 1. `primaryGoalId` — always weight 1: the tension belongs to that goal.
 * 2. `relatedGoals` — explicit weights, honoured only when node overrides are
 *    allowed (`allowNodeOverride !== false`).
 * 3. `relatedGoalIds` — the pre-weight field. Every id not already covered gets
 *    `defaultRelatedWeight`, which is why an old node keeps working unchanged
 *    and why changing the configured default changes the answer for it.
 *
 * The result contains no goal twice and never lists the primary goal as a
 * related link.
 */
export declare function contradictionGoalLinks(node: ContradictionLinkSource, settings: ContradictionWeightSettings): ContradictionGoalLink[];
/** How hard one tension presses on one goal; 0 when it does not touch it. */
export declare function contradictionGoalWeight(node: ContradictionLinkSource, goalId: string, settings: ContradictionWeightSettings): number;
/**
 * Compute one goal's contradiction burden.
 *
 * Pure: the same nodes and settings always give the same number, so it can be
 * unit-tested without a store and fed straight into goal recommendation.
 * Resolved tensions are excluded — they remain in the tree as history but no
 * longer press on the goal.
 *
 * @param goalId - goal whose burden is wanted.
 * @param contradictions - every contradiction in the project.
 * @param settings - weight knobs, normally `config.contradictions`.
 * @returns the aggregated burden, with a per-tension breakdown.
 */
export declare function computeGoalContradictionBurden(goalId: string, contradictions: readonly ContradictionBurdenSource[], settings: ContradictionWeightSettings): GoalContradictionBurden;
export declare const ContradictionObservationSchema: z.ZodObject<{
    id: z.ZodString;
    projectId: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
    contradictionId: z.ZodString;
    observedAt: z.ZodString;
    intensity: z.ZodDefault<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
    computedTrend: z.ZodDefault<z.ZodEnum<{
        unknown: "unknown";
        rising: "rising";
        stable: "stable";
        falling: "falling";
    }>>;
    evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
    confidence: z.ZodNumber;
    rationale: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export type ContradictionObservation = z.infer<typeof ContradictionObservationSchema>;
export declare const ObservationGradeSchema: z.ZodEnum<{
    A: "A";
    B: "B";
    C: "C";
}>;
export type ObservationGrade = z.infer<typeof ObservationGradeSchema>;
/**
 * How one activity was judged against the tree.
 *
 * `unbound` is a statement about the *tree's* coverage, not about the activity's
 * direction: no goal claims any path the activity touched. It is not a weaker
 * `scope_drift` and must never be read as one — an activity nobody can place has
 * not been shown to serve anything else, so calling it drift would assert
 * something the judge never established. It is also not `uncertain`, which says
 * "I had too little to go on"; `unbound` says "I looked and the tree has no
 * claim on this", and the difference is what makes path-coverage measurable.
 *
 * Records written before this value existed carry only the first four. Some of
 * their `uncertain` rows were in truth unbound activities; that cannot be
 * recovered, so they are deliberately neither migrated nor guessed at.
 */
export declare const AlignmentDecisionSchema: z.ZodEnum<{
    aligned: "aligned";
    exploratory: "exploratory";
    scope_drift: "scope_drift";
    uncertain: "uncertain";
    unbound: "unbound";
}>;
export type AlignmentDecision = z.infer<typeof AlignmentDecisionSchema>;
export declare const MonitorCategorySchema: z.ZodEnum<{
    goal_alignment: "goal_alignment";
    structure_validity: "structure_validity";
    judgment_quality: "judgment_quality";
}>;
export type MonitorCategory = z.infer<typeof MonitorCategorySchema>;
export declare const DriftSignalTypeSchema: z.ZodEnum<{
    scope_drift: "scope_drift";
    core_bypass: "core_bypass";
    goal_staleness: "goal_staleness";
    contradiction_shift: "contradiction_shift";
    repeated_failure_loop: "repeated_failure_loop";
    deadline_risk: "deadline_risk";
}>;
export type DriftSignalType = z.infer<typeof DriftSignalTypeSchema>;
export declare const ResponseLevelSchema: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>;
export type ResponseLevel = z.infer<typeof ResponseLevelSchema>;
export declare const ActivitySourceSchema: z.ZodEnum<{
    tool_event: "tool_event";
    user_input: "user_input";
    manual: "manual";
    turn: "turn";
}>;
export type ActivitySource = z.infer<typeof ActivitySourceSchema>;
export declare const ActivityRecordSchema: z.ZodObject<{
    id: z.ZodString;
    eventFingerprint: z.ZodString;
    projectId: z.ZodString;
    sessionId: z.ZodString;
    timestamp: z.ZodString;
    source: z.ZodEnum<{
        tool_event: "tool_event";
        user_input: "user_input";
        manual: "manual";
        turn: "turn";
    }>;
    observationGrade: z.ZodEnum<{
        A: "A";
        B: "B";
        C: "C";
    }>;
    summary: z.ZodString;
    evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
    candidateGoalIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    alignmentConfidence: z.ZodDefault<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
    decision: z.ZodEnum<{
        aligned: "aligned";
        exploratory: "exploratory";
        scope_drift: "scope_drift";
        uncertain: "uncertain";
        unbound: "unbound";
    }>;
    rationale: z.ZodDefault<z.ZodString>;
    trace: z.ZodOptional<z.ZodObject<{
        toolNames: z.ZodDefault<z.ZodArray<z.ZodString>>;
        toolResults: z.ZodDefault<z.ZodArray<z.ZodObject<{
            tool: z.ZodString;
            ok: z.ZodDefault<z.ZodUnion<readonly [z.ZodBoolean, z.ZodNull]>>;
            excerpt: z.ZodDefault<z.ZodString>;
            outcome: z.ZodDefault<z.ZodNullable<z.ZodEnum<{
                "tests-pass": "tests-pass";
                "tests-fail": "tests-fail";
                "build-pass": "build-pass";
                "build-fail": "build-fail";
            }>>>;
            signature: z.ZodDefault<z.ZodString>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ActivityRecord = z.infer<typeof ActivityRecordSchema>;
export declare const DriftSignalSchema: z.ZodObject<{
    id: z.ZodString;
    projectId: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
    observedAt: z.ZodString;
    monitorCategory: z.ZodEnum<{
        goal_alignment: "goal_alignment";
        structure_validity: "structure_validity";
        judgment_quality: "judgment_quality";
    }>;
    signalType: z.ZodEnum<{
        scope_drift: "scope_drift";
        core_bypass: "core_bypass";
        goal_staleness: "goal_staleness";
        contradiction_shift: "contradiction_shift";
        repeated_failure_loop: "repeated_failure_loop";
        deadline_risk: "deadline_risk";
    }>;
    level: z.ZodUnion<readonly [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>, z.ZodLiteral<3>]>;
    relatedGoalIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    relatedContradictionIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    activityIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    confidence: z.ZodNumber;
    evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
    hint: z.ZodOptional<z.ZodString>;
    reviewedBy: z.ZodDefault<z.ZodEnum<{
        review: "review";
        bypass: "bypass";
    }>>;
    rationale: z.ZodDefault<z.ZodString>;
    interventionId: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type DriftSignal = z.infer<typeof DriftSignalSchema>;
export declare const InterventionDecisionSchema: z.ZodEnum<{
    continue: "continue";
    realign: "realign";
    modify_goals: "modify_goals";
    dismiss: "dismiss";
}>;
export type InterventionDecision = z.infer<typeof InterventionDecisionSchema>;
export declare const InterventionStatusSchema: z.ZodEnum<{
    pending: "pending";
    resolved: "resolved";
    superseded: "superseded";
}>;
export declare const InterventionLevelSchema: z.ZodUnion<readonly [z.ZodLiteral<2>, z.ZodLiteral<3>]>;
export declare const InterventionRecordSchema: z.ZodObject<{
    id: z.ZodString;
    projectId: z.ZodString;
    sessionId: z.ZodOptional<z.ZodString>;
    signalId: z.ZodString;
    level: z.ZodUnion<readonly [z.ZodLiteral<2>, z.ZodLiteral<3>]>;
    status: z.ZodDefault<z.ZodEnum<{
        pending: "pending";
        resolved: "resolved";
        superseded: "superseded";
    }>>;
    promptSummary: z.ZodString;
    hint: z.ZodOptional<z.ZodString>;
    suggestedActions: z.ZodDefault<z.ZodArray<z.ZodString>>;
    decision: z.ZodOptional<z.ZodEnum<{
        continue: "continue";
        realign: "realign";
        modify_goals: "modify_goals";
        dismiss: "dismiss";
    }>>;
    rationale: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodString;
    decidedAt: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type InterventionRecord = z.infer<typeof InterventionRecordSchema>;
/** How one drift candidate was settled. */
export declare const JudgmentStatusSchema: z.ZodEnum<{
    pending: "pending";
    confirmed: "confirmed";
    dismissed: "dismissed";
}>;
/**
 * One drift candidate, and what the program and a model each made of it.
 *
 * Written when a rule fires. It does not become a signal at that moment: a rule
 * judging a string like `pwsh (tool call)` produces mostly noise, so the operator
 * only hears about tension the program and a model agree on. The second verdict
 * arrives in an hourly batch rather than per activity, because judging one tool
 * call at a time is both expensive and blind to what the hour was about.
 *
 * The record outlives its decision on purpose. A log of what the rules got wrong
 * is the only evidence that can say whether they are improving.
 */
export declare const JudgmentRecordSchema: z.ZodObject<{
    id: z.ZodString;
    projectId: z.ZodString;
    createdAt: z.ZodString;
    activityIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    signalType: z.ZodEnum<{
        scope_drift: "scope_drift";
        core_bypass: "core_bypass";
        goal_staleness: "goal_staleness";
        contradiction_shift: "contradiction_shift";
        repeated_failure_loop: "repeated_failure_loop";
        deadline_risk: "deadline_risk";
    }>;
    summary: z.ZodDefault<z.ZodString>;
    programReason: z.ZodDefault<z.ZodString>;
    draft: z.ZodOptional<z.ZodUnknown>;
    sampled: z.ZodDefault<z.ZodBoolean>;
    status: z.ZodDefault<z.ZodEnum<{
        pending: "pending";
        confirmed: "confirmed";
        dismissed: "dismissed";
    }>>;
    modelVerdict: z.ZodOptional<z.ZodEnum<{
        drift: "drift";
        not_drift: "not_drift";
    }>>;
    modelReason: z.ZodOptional<z.ZodString>;
    modelWhy: z.ZodOptional<z.ZodEnum<{
        "no-matching-goal": "no-matching-goal";
        "missed-success-criteria": "missed-success-criteria";
        "outside-allowed-methods": "outside-allowed-methods";
        "hit-excluded-activity": "hit-excluded-activity";
        "contradicts-goal": "contradicts-goal";
        unclear: "unclear";
    }>>;
    modelHowToAdjust: z.ZodOptional<z.ZodString>;
    modelConfidence: z.ZodOptional<z.ZodNumber>;
    decidedAt: z.ZodOptional<z.ZodString>;
    notified: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type JudgmentRecord = z.infer<typeof JudgmentRecordSchema>;
/** A goal list that tolerates records written before `depth` existed. */
export declare const GoalNodeListSchema: z.ZodPreprocess<z.ZodArray<z.ZodObject<{
    id: z.ZodString;
    projectId: z.ZodString;
    parentId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    depth: z.ZodNumber;
    title: z.ZodString;
    description: z.ZodDefault<z.ZodString>;
    status: z.ZodDefault<z.ZodEnum<{
        draft: "draft";
        active: "active";
        at_risk: "at_risk";
        blocked: "blocked";
        done: "done";
        deprecated: "deprecated";
    }>>;
    priority: z.ZodDefault<z.ZodNumber>;
    confirmedByUser: z.ZodDefault<z.ZodBoolean>;
    successCriteria: z.ZodDefault<z.ZodArray<z.ZodString>>;
    alignment: z.ZodPrefault<z.ZodObject<{
        relevantActivities: z.ZodDefault<z.ZodArray<z.ZodString>>;
        allowedMethods: z.ZodDefault<z.ZodArray<z.ZodString>>;
        excludedActivities: z.ZodDefault<z.ZodArray<z.ZodString>>;
        explorationPolicy: z.ZodDefault<z.ZodEnum<{
            allowed: "allowed";
            limited: "limited";
            approval_required: "approval_required";
        }>>;
    }, z.core.$strip>>;
    paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
    evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
    deadline: z.ZodOptional<z.ZodString>;
    startedAt: z.ZodOptional<z.ZodString>;
    doneAt: z.ZodOptional<z.ZodString>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
}, z.core.$strip>>, unknown>;
export declare const TreeSnapshotSchema: z.ZodObject<{
    version: z.ZodNumber;
    projectId: z.ZodString;
    createdAt: z.ZodString;
    reason: z.ZodDefault<z.ZodString>;
    goals: z.ZodPreprocess<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        projectId: z.ZodString;
        parentId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        depth: z.ZodNumber;
        title: z.ZodString;
        description: z.ZodDefault<z.ZodString>;
        status: z.ZodDefault<z.ZodEnum<{
            draft: "draft";
            active: "active";
            at_risk: "at_risk";
            blocked: "blocked";
            done: "done";
            deprecated: "deprecated";
        }>>;
        priority: z.ZodDefault<z.ZodNumber>;
        confirmedByUser: z.ZodDefault<z.ZodBoolean>;
        successCriteria: z.ZodDefault<z.ZodArray<z.ZodString>>;
        alignment: z.ZodPrefault<z.ZodObject<{
            relevantActivities: z.ZodDefault<z.ZodArray<z.ZodString>>;
            allowedMethods: z.ZodDefault<z.ZodArray<z.ZodString>>;
            excludedActivities: z.ZodDefault<z.ZodArray<z.ZodString>>;
            explorationPolicy: z.ZodDefault<z.ZodEnum<{
                allowed: "allowed";
                limited: "limited";
                approval_required: "approval_required";
            }>>;
        }, z.core.$strip>>;
        paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
        evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
        deadline: z.ZodOptional<z.ZodString>;
        startedAt: z.ZodOptional<z.ZodString>;
        doneAt: z.ZodOptional<z.ZodString>;
        createdAt: z.ZodString;
        updatedAt: z.ZodString;
    }, z.core.$strip>>, unknown>;
    contradictions: z.ZodArray<z.ZodPipe<z.ZodObject<{
        id: z.ZodString;
        projectId: z.ZodString;
        parentId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        primaryGoalId: z.ZodString;
        relatedGoalIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
        relatedGoals: z.ZodOptional<z.ZodArray<z.ZodObject<{
            goalId: z.ZodString;
            weight: z.ZodNumber;
        }, z.core.$strip>>>;
        type: z.ZodDefault<z.ZodEnum<{
            core: "core";
            main: "main";
            secondary: "secondary";
            unclassified: "unclassified";
        }>>;
        confirmedByUser: z.ZodDefault<z.ZodBoolean>;
        title: z.ZodString;
        description: z.ZodDefault<z.ZodString>;
        poleA: z.ZodDefault<z.ZodString>;
        poleB: z.ZodDefault<z.ZodString>;
        intensity: z.ZodDefault<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
        trend: z.ZodDefault<z.ZodEnum<{
            unknown: "unknown";
            rising: "rising";
            stable: "stable";
            falling: "falling";
        }>>;
        rationale: z.ZodDefault<z.ZodString>;
        resolutionHint: z.ZodDefault<z.ZodString>;
        evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
        resolvedAt: z.ZodOptional<z.ZodString>;
        createdAt: z.ZodString;
        updatedAt: z.ZodString;
    }, z.core.$strip>, z.ZodTransform<{
        id: string;
        projectId: string;
        parentId: string | null;
        primaryGoalId: string;
        relatedGoalIds: string[];
        type: "core" | "main" | "secondary" | "unclassified";
        confirmedByUser: boolean;
        title: string;
        description: string;
        poleA: string;
        poleB: string;
        intensity: number | null;
        trend: "unknown" | "rising" | "stable" | "falling";
        rationale: string;
        resolutionHint: string;
        evidence: string[];
        createdAt: string;
        updatedAt: string;
        relatedGoals?: {
            goalId: string;
            weight: number;
        }[] | undefined;
        resolvedAt?: string | undefined;
    }, {
        id: string;
        projectId: string;
        parentId: string | null;
        primaryGoalId: string;
        relatedGoalIds: string[];
        type: "core" | "main" | "secondary" | "unclassified";
        confirmedByUser: boolean;
        title: string;
        description: string;
        poleA: string;
        poleB: string;
        intensity: number | null;
        trend: "unknown" | "rising" | "stable" | "falling";
        rationale: string;
        resolutionHint: string;
        evidence: string[];
        createdAt: string;
        updatedAt: string;
        relatedGoals?: {
            goalId: string;
            weight: number;
        }[] | undefined;
        resolvedAt?: string | undefined;
    }>>>;
}, z.core.$strip>;
export type TreeSnapshot = z.infer<typeof TreeSnapshotSchema>;
export declare const AuditActorSchema: z.ZodEnum<{
    user_confirmed: "user_confirmed";
    system_auto: "system_auto";
    manual_tool: "manual_tool";
}>;
export type AuditActor = z.infer<typeof AuditActorSchema>;
export declare const AuditActionSchema: z.ZodEnum<{
    resolve_intervention: "resolve_intervention";
    init_trees: "init_trees";
    tree_reset: "tree_reset";
    update_l0: "update_l0";
    update_l1: "update_l1";
    update_lower_goal: "update_lower_goal";
    update_core_contradiction: "update_core_contradiction";
    reclassify_contradiction: "reclassify_contradiction";
    migrate_goal_depth: "migrate_goal_depth";
    merge_trees: "merge_trees";
    purge: "purge";
}>;
export type AuditAction = z.infer<typeof AuditActionSchema>;
export declare const AuditLogEntrySchema: z.ZodObject<{
    id: z.ZodString;
    projectId: z.ZodString;
    timestamp: z.ZodString;
    actor: z.ZodEnum<{
        user_confirmed: "user_confirmed";
        system_auto: "system_auto";
        manual_tool: "manual_tool";
    }>;
    action: z.ZodEnum<{
        resolve_intervention: "resolve_intervention";
        init_trees: "init_trees";
        tree_reset: "tree_reset";
        update_l0: "update_l0";
        update_l1: "update_l1";
        update_lower_goal: "update_lower_goal";
        update_core_contradiction: "update_core_contradiction";
        reclassify_contradiction: "reclassify_contradiction";
        migrate_goal_depth: "migrate_goal_depth";
        merge_trees: "merge_trees";
        purge: "purge";
    }>;
    beforeVersion: z.ZodNumber;
    afterVersion: z.ZodNumber;
    targetIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    reason: z.ZodDefault<z.ZodString>;
    evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
    prevHash: z.ZodString;
    entryHash: z.ZodString;
}, z.core.$strip>;
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;
export declare const GeneratedReportSchema: z.ZodObject<{
    id: z.ZodString;
    projectId: z.ZodString;
    type: z.ZodEnum<{
        daily: "daily";
        weekly: "weekly";
        monthly: "monthly";
    }>;
    generatedAt: z.ZodString;
    periodStart: z.ZodString;
    periodEnd: z.ZodString;
    goalTreeVersion: z.ZodNumber;
    observationIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    signalIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    interventionIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    markdown: z.ZodString;
}, z.core.$strip>;
export type GeneratedReport = z.infer<typeof GeneratedReportSchema>;
/** Marker used as `prevHash` on the first audit record of a project. */
export declare const GENESIS_HASH = "GENESIS";
/**
 * Who the project belongs to and what surrounds it.
 *
 * Derivation cannot work without this. A model reading only the files can see
 * *what is being done*, but not *why it matters* — that lives in the user's
 * role, the intent behind the work, the constraints pressing on it, and who
 * consumes the result. Without this layer the model can only restate document
 * headings, which is transcription, not derivation.
 *
 * Stored on the project rather than passed per call: it is stable information,
 * and re-typing it every session is how it ends up omitted.
 */
export declare const ProjectContextSchema: z.ZodObject<{
    role: z.ZodDefault<z.ZodString>;
    intent: z.ZodDefault<z.ZodString>;
    constraints: z.ZodDefault<z.ZodArray<z.ZodString>>;
    stakeholders: z.ZodDefault<z.ZodArray<z.ZodString>>;
    projectSummary: z.ZodDefault<z.ZodString>;
    stage: z.ZodDefault<z.ZodString>;
    deliverables: z.ZodDefault<z.ZodArray<z.ZodString>>;
    updatedAt: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type ProjectContext = z.infer<typeof ProjectContextSchema>;
/**
 * Persisted tree state for one project.
 *
 * `version` is the single monotonic counter guarding structural writes; every
 * mutation compares the caller's `expectedVersion` against it before writing.
 */
export declare const TreeStateSchema: z.ZodObject<{
    projectId: z.ZodString;
    version: z.ZodNumber;
    confirmed: z.ZodDefault<z.ZodBoolean>;
    projectContext: z.ZodOptional<z.ZodObject<{
        role: z.ZodDefault<z.ZodString>;
        intent: z.ZodDefault<z.ZodString>;
        constraints: z.ZodDefault<z.ZodArray<z.ZodString>>;
        stakeholders: z.ZodDefault<z.ZodArray<z.ZodString>>;
        projectSummary: z.ZodDefault<z.ZodString>;
        stage: z.ZodDefault<z.ZodString>;
        deliverables: z.ZodDefault<z.ZodArray<z.ZodString>>;
        updatedAt: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    metacogSessionId: z.ZodOptional<z.ZodString>;
    projectRoot: z.ZodOptional<z.ZodString>;
    goals: z.ZodDefault<z.ZodPreprocess<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        projectId: z.ZodString;
        parentId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        depth: z.ZodNumber;
        title: z.ZodString;
        description: z.ZodDefault<z.ZodString>;
        status: z.ZodDefault<z.ZodEnum<{
            draft: "draft";
            active: "active";
            at_risk: "at_risk";
            blocked: "blocked";
            done: "done";
            deprecated: "deprecated";
        }>>;
        priority: z.ZodDefault<z.ZodNumber>;
        confirmedByUser: z.ZodDefault<z.ZodBoolean>;
        successCriteria: z.ZodDefault<z.ZodArray<z.ZodString>>;
        alignment: z.ZodPrefault<z.ZodObject<{
            relevantActivities: z.ZodDefault<z.ZodArray<z.ZodString>>;
            allowedMethods: z.ZodDefault<z.ZodArray<z.ZodString>>;
            excludedActivities: z.ZodDefault<z.ZodArray<z.ZodString>>;
            explorationPolicy: z.ZodDefault<z.ZodEnum<{
                allowed: "allowed";
                limited: "limited";
                approval_required: "approval_required";
            }>>;
        }, z.core.$strip>>;
        paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
        evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
        deadline: z.ZodOptional<z.ZodString>;
        startedAt: z.ZodOptional<z.ZodString>;
        doneAt: z.ZodOptional<z.ZodString>;
        createdAt: z.ZodString;
        updatedAt: z.ZodString;
    }, z.core.$strip>>, unknown>>;
    contradictions: z.ZodDefault<z.ZodArray<z.ZodPipe<z.ZodObject<{
        id: z.ZodString;
        projectId: z.ZodString;
        parentId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
        primaryGoalId: z.ZodString;
        relatedGoalIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
        relatedGoals: z.ZodOptional<z.ZodArray<z.ZodObject<{
            goalId: z.ZodString;
            weight: z.ZodNumber;
        }, z.core.$strip>>>;
        type: z.ZodDefault<z.ZodEnum<{
            core: "core";
            main: "main";
            secondary: "secondary";
            unclassified: "unclassified";
        }>>;
        confirmedByUser: z.ZodDefault<z.ZodBoolean>;
        title: z.ZodString;
        description: z.ZodDefault<z.ZodString>;
        poleA: z.ZodDefault<z.ZodString>;
        poleB: z.ZodDefault<z.ZodString>;
        intensity: z.ZodDefault<z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>>;
        trend: z.ZodDefault<z.ZodEnum<{
            unknown: "unknown";
            rising: "rising";
            stable: "stable";
            falling: "falling";
        }>>;
        rationale: z.ZodDefault<z.ZodString>;
        resolutionHint: z.ZodDefault<z.ZodString>;
        evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
        resolvedAt: z.ZodOptional<z.ZodString>;
        createdAt: z.ZodString;
        updatedAt: z.ZodString;
    }, z.core.$strip>, z.ZodTransform<{
        id: string;
        projectId: string;
        parentId: string | null;
        primaryGoalId: string;
        relatedGoalIds: string[];
        type: "core" | "main" | "secondary" | "unclassified";
        confirmedByUser: boolean;
        title: string;
        description: string;
        poleA: string;
        poleB: string;
        intensity: number | null;
        trend: "unknown" | "rising" | "stable" | "falling";
        rationale: string;
        resolutionHint: string;
        evidence: string[];
        createdAt: string;
        updatedAt: string;
        relatedGoals?: {
            goalId: string;
            weight: number;
        }[] | undefined;
        resolvedAt?: string | undefined;
    }, {
        id: string;
        projectId: string;
        parentId: string | null;
        primaryGoalId: string;
        relatedGoalIds: string[];
        type: "core" | "main" | "secondary" | "unclassified";
        confirmedByUser: boolean;
        title: string;
        description: string;
        poleA: string;
        poleB: string;
        intensity: number | null;
        trend: "unknown" | "rising" | "stable" | "falling";
        rationale: string;
        resolutionHint: string;
        evidence: string[];
        createdAt: string;
        updatedAt: string;
        relatedGoals?: {
            goalId: string;
            weight: number;
        }[] | undefined;
        resolvedAt?: string | undefined;
    }>>>>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
}, z.core.$strip>;
export type TreeState = z.infer<typeof TreeStateSchema>;
