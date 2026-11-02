/**
 * The v4 signal contract: five signal scores, their three-state availability,
 * the aggregation that turns them into one number, and the plan a session
 * declares up front.
 *
 * Kept apart from `types.ts` on purpose. Everything here is *new* in v4 and
 * nothing here is persisted as project state; `types.ts` holds the structures a
 * store reads and writes, and mixing an unproven contract into it would make a
 * later revision of the contract look like a store migration.
 *
 * Two rules run through the whole file, and both are enforced by the types
 * rather than by a caller remembering them:
 *
 * - A score that cannot be computed is never `0`. Zero means "measured, and it
 *   is fine"; absence means "not measured". Collapsing the two is how a missing
 *   signal silently reads as a clean one.
 * - A score is not a probability. Nothing here is calibrated, so the type name
 *   says `Score` and every threshold derived from it is named `theta*Score`.
 *
 * @module dsh-metacog/data/signals
 */
import { z } from 'zod';
/**
 * Which signals v4 defines.
 *
 * The names are stable keys: they appear in the aggregation weights, in config,
 * and in a report. Adding one is a contract change, so the list is closed.
 *
 * `s1_semantic` used to be reserved here for a semantic-drift channel that was
 * never given a producer. It has been removed rather than left as a placeholder:
 * an id nothing emits is indistinguishable from a broken one, and a reader has to
 * open the aggregator to learn it carries no weight. Semantic drift is not planned.
 */
export declare const SignalIdSchema: z.ZodEnum<{
    s2_class: "s2_class";
    s3_tool_novel: "s3_tool_novel";
    s4_plan_match: "s4_plan_match";
    s5_progress: "s5_progress";
    b_repeat: "b_repeat";
    b_error_streak: "b_error_streak";
    b_alternating: "b_alternating";
    b_monologue: "b_monologue";
}>;
export type SignalId = z.infer<typeof SignalIdSchema>;
/**
 * Why a signal produced no score.
 *
 * Distinguishing these matters for the coverage floor and for the report: a
 * signal that is structurally inapplicable (no plan was declared) and one that
 * merely failed to run (embedding service down) both contribute no weight, but
 * only the first is a reason to ask the user for something.
 */
export declare const SignalAbsenceReasonSchema: z.ZodEnum<{
    no_declared_plan: "no_declared_plan";
    no_allowed_tools: "no_allowed_tools";
    data_not_collected: "data_not_collected";
    dependency_failed: "dependency_failed";
    insufficient_history: "insufficient_history";
}>;
export type SignalAbsenceReason = z.infer<typeof SignalAbsenceReasonSchema>;
/**
 * One signal's result for one step: either a score in [0, 1], or an explicit
 * reason it has none.
 *
 * Modelled as a discriminated union rather than `{ score: number | null,
 * reason?: string }` so that reading `.score` without first checking
 * `status === 'available'` is a type error. The null-and-reason shape compiles
 * fine and produces `undefined + 0` at runtime, which is how a missing signal
 * becomes a silent zero.
 */
export declare const SignalScoreSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    status: z.ZodLiteral<"available">;
    signal: z.ZodEnum<{
        s2_class: "s2_class";
        s3_tool_novel: "s3_tool_novel";
        s4_plan_match: "s4_plan_match";
        s5_progress: "s5_progress";
        b_repeat: "b_repeat";
        b_error_streak: "b_error_streak";
        b_alternating: "b_alternating";
        b_monologue: "b_monologue";
    }>;
    score: z.ZodNumber;
    evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>, z.ZodObject<{
    status: z.ZodLiteral<"not_applicable">;
    signal: z.ZodEnum<{
        s2_class: "s2_class";
        s3_tool_novel: "s3_tool_novel";
        s4_plan_match: "s4_plan_match";
        s5_progress: "s5_progress";
        b_repeat: "b_repeat";
        b_error_streak: "b_error_streak";
        b_alternating: "b_alternating";
        b_monologue: "b_monologue";
    }>;
    reason: z.ZodEnum<{
        no_declared_plan: "no_declared_plan";
        no_allowed_tools: "no_allowed_tools";
        data_not_collected: "data_not_collected";
        dependency_failed: "dependency_failed";
        insufficient_history: "insufficient_history";
    }>;
    detail: z.ZodDefault<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    status: z.ZodLiteral<"missing">;
    signal: z.ZodEnum<{
        s2_class: "s2_class";
        s3_tool_novel: "s3_tool_novel";
        s4_plan_match: "s4_plan_match";
        s5_progress: "s5_progress";
        b_repeat: "b_repeat";
        b_error_streak: "b_error_streak";
        b_alternating: "b_alternating";
        b_monologue: "b_monologue";
    }>;
    reason: z.ZodEnum<{
        no_declared_plan: "no_declared_plan";
        no_allowed_tools: "no_allowed_tools";
        data_not_collected: "data_not_collected";
        dependency_failed: "dependency_failed";
        insufficient_history: "insufficient_history";
    }>;
    detail: z.ZodDefault<z.ZodString>;
}, z.core.$strip>], "status">;
export type SignalScore = z.infer<typeof SignalScoreSchema>;
/**
 * The three independent dimensions the five signals are folded into.
 *
 * Weighting happens here and not per signal, because S3 and S2 measure the same
 * thing at two grains: a tool outside the whitelist is a special case of a class
 * distribution shift, so giving both an independent weight double-counts one
 * event. S1 carries no weight at all and is used only when the other dimensions
 * are unavailable.
 */
export declare const AggregationDimensionSchema: z.ZodEnum<{
    scope: "scope";
    plan: "plan";
    progress: "progress";
    behaviour: "behaviour";
}>;
export type AggregationDimension = z.infer<typeof AggregationDimensionSchema>;
/**
 * Which signals feed which dimension. A dimension is available when at least one
 * of its signals is.
 */
export declare const DIMENSION_SIGNALS: Readonly<Record<AggregationDimension, readonly SignalId[]>>;
/**
 * Signals that are still computed but no longer decide anything.
 *
 * S2 measures how far the mix of action classes has moved from the session's own
 * opening baseline. That baseline is the defect, not a tuning problem: it is
 * fixed to the first five steps, so the most ordinary working rhythm there is —
 * read for a while, then start writing — has an empty intersection with it, and
 * `1 - Jaccard` returns exactly 1.0. Weighted at 0.5 for the scope dimension
 * that lands on `thetaHintScore`, so a normal session is told it has drifted
 * before it has done anything wrong. No threshold fixes that; the comparison
 * itself is between two incomparable things.
 *
 * So it keeps running — the number is still worth reading in a report, and
 * computing it costs nothing — but it no longer reaches the aggregate, and in
 * particular it cannot dominate the scope dimension through `max()`.
 *
 * Re-enable it only when the baseline becomes *plan-relative* (what this session
 * said it would do, rather than what it happened to do first), which is the
 * comparison S2 was reaching for.
 *
 * Consequence of retiring it, stated once so it is not later discovered as a
 * mystery: a session that declares no plan now has only S3 for scope and only S4
 * for plan. With neither, the only available weight is progress at 0.25 — below
 * the 0.4 coverage floor — so the deterministic layer cannot escalate at all.
 * That is accepted on purpose (work that never declared an intent has not been
 * shown to deviate from one), but it is a real behaviour change and it is pinned
 * by `test/signal-retirement.test.mjs`.
 */
export declare const RETIRED_SIGNALS: ReadonlySet<SignalId>;
/**
 * Dimension weights, held apart from the config schema so the constants the
 * aggregation is tested against live in one readable place.
 *
 * These are engineering estimates, not calibrated values. They are also the sole
 * input to `coverage`, which is why that number can only take five values.
 */
export declare const DIMENSION_WEIGHTS: Readonly<Record<AggregationDimension, number>>;
/**
 * One step's aggregation: the weighted score, how much of the weight was
 * actually available, and per-dimension detail.
 *
 * `coverage` is `availableWeight / totalWeight` and therefore can only be one of
 * {0, 0.25, 0.5, 0.75, 1}, given the weights above. It is *not* a probability and
 * not a confidence; it says how much of the intended evidence was present.
 */
export declare const StepAggregateSchema: z.ZodObject<{
    riskScore: z.ZodNullable<z.ZodNumber>;
    availableWeight: z.ZodNumber;
    coverage: z.ZodNumber;
    behaviourScore: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    dimensions: z.ZodDefault<z.ZodArray<z.ZodObject<{
        dimension: z.ZodEnum<{
            scope: "scope";
            plan: "plan";
            progress: "progress";
            behaviour: "behaviour";
        }>;
        weight: z.ZodNumber;
        score: z.ZodNumber;
    }, z.core.$strip>>>;
    absent: z.ZodDefault<z.ZodArray<z.ZodObject<{
        signal: z.ZodEnum<{
            s2_class: "s2_class";
            s3_tool_novel: "s3_tool_novel";
            s4_plan_match: "s4_plan_match";
            s5_progress: "s5_progress";
            b_repeat: "b_repeat";
            b_error_streak: "b_error_streak";
            b_alternating: "b_alternating";
            b_monologue: "b_monologue";
        }>;
        status: z.ZodEnum<{
            no_declared_plan: "no_declared_plan";
            no_allowed_tools: "no_allowed_tools";
            data_not_collected: "data_not_collected";
            dependency_failed: "dependency_failed";
            insufficient_history: "insufficient_history";
        }>;
    }, z.core.$strip>>>;
    retired: z.ZodDefault<z.ZodArray<z.ZodObject<{
        signal: z.ZodEnum<{
            s2_class: "s2_class";
            s3_tool_novel: "s3_tool_novel";
            s4_plan_match: "s4_plan_match";
            s5_progress: "s5_progress";
            b_repeat: "b_repeat";
            b_error_streak: "b_error_streak";
            b_alternating: "b_alternating";
            b_monologue: "b_monologue";
        }>;
        score: z.ZodNumber;
        evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>>;
}, z.core.$strip>;
export type StepAggregate = z.infer<typeof StepAggregateSchema>;
/**
 * EMA parameters for the smoothed score.
 *
 * `beta` is the weight of the newest observation. The default of 0.4 is chosen
 * so a single-step burst peaks at 0.400 — below the 0.500 hint threshold — which
 * means a one-off excursion is recorded and not acted on. That is a deliberate
 * tradeoff, not an oversight: raising beta to 0.5 puts the burst peak exactly on
 * the threshold, which is a worse place to sit than clearly below it.
 */
export declare const EmaConfigSchema: z.ZodObject<{
    beta: z.ZodDefault<z.ZodNumber>;
    initial: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type EmaConfig = z.infer<typeof EmaConfigSchema>;
/**
 * Response thresholds, deliberately named `Score` and not `Probability`.
 *
 * The two numbers are borrowed from v3's loss-matrix crossing points (0.500 for
 * silent→hint, 0.875 for hint→card), but v3 derived them under an assumption
 * that does not hold here: that the score they act on is a *calibrated*
 * probability. Ours is not, so these are starting values chosen for having a
 * defensible origin, not optimal decision boundaries. Renaming them to
 * `thetaCardProbability` would assert the calibration we do not have.
 */
export declare const ResponseThresholdsSchema: z.ZodObject<{
    thetaHintScore: z.ZodDefault<z.ZodNumber>;
    thetaCardScore: z.ZodDefault<z.ZodNumber>;
    consecutiveStepsForCard: z.ZodDefault<z.ZodNumber>;
    coverageFloor: z.ZodDefault<z.ZodNumber>;
}, z.core.$strip>;
export type ResponseThresholds = z.infer<typeof ResponseThresholdsSchema>;
/**
 * A declared plan: what this session intends to do, in a form a program can
 * check against what actually happened.
 *
 * The steps are structured, not prose. That is not a preference: the observed
 * side is generated by `collect.ts` from tool arguments, so a plan written in
 * free Chinese would share no strings with it, and plan matching would be
 * permanently zero. `intent` exists for the human reader and feeds no
 * computation.
 */
export declare const PlanStepSchema: z.ZodObject<{
    intent: z.ZodString;
    expects: z.ZodObject<{
        tool: z.ZodOptional<z.ZodString>;
        pathGlob: z.ZodOptional<z.ZodString>;
        assert: z.ZodOptional<z.ZodEnum<{
            "tests-pass": "tests-pass";
            "build-pass": "build-pass";
            "file-changed": "file-changed";
        }>>;
    }, z.core.$strip>;
    optional: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
/**
 * The plan itself.
 *
 * `allowedTools` is the field S3 reads, and it is the one the benchmark actually
 * validates: the 0.843 row comes from declaring a tool manifest, not from
 * detailed steps. So when a session can supply only one thing, it should be this
 * and not the step list.
 */
export declare const DeclaredPlanSchema: z.ZodObject<{
    id: z.ZodString;
    goal: z.ZodString;
    linkedGoalId: z.ZodOptional<z.ZodString>;
    deadline: z.ZodOptional<z.ZodString>;
    allowedTools: z.ZodDefault<z.ZodArray<z.ZodString>>;
    steps: z.ZodDefault<z.ZodArray<z.ZodObject<{
        intent: z.ZodString;
        expects: z.ZodObject<{
            tool: z.ZodOptional<z.ZodString>;
            pathGlob: z.ZodOptional<z.ZodString>;
            assert: z.ZodOptional<z.ZodEnum<{
                "tests-pass": "tests-pass";
                "build-pass": "build-pass";
                "file-changed": "file-changed";
            }>>;
        }, z.core.$strip>;
        optional: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>>;
    declaredAt: z.ZodString;
    revisedAt: z.ZodOptional<z.ZodString>;
    vagueGoal: z.ZodDefault<z.ZodBoolean>;
    vagueGoalReason: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export type DeclaredPlan = z.infer<typeof DeclaredPlanSchema>;
/**
 * The tool set a plan actually permits.
 *
 * An explicit `allowedTools` always wins: it is the field the benchmark
 * validates, and a session that took the trouble to name it means it. When there
 * is none, the step list is just as good a source — every step already names the
 * tool that completes it — and asking for both was the main reason sessions
 * declared neither. A step whose `expects` carries no `tool` contributes nothing:
 * an `assert`-only step says what finishing looks like, not what will be called.
 *
 * Deriving here rather than at the call site keeps one definition of "the tools
 * in force" for S3 and for the receipt a declaration returns; two would disagree
 * the first time one of them learned a new source.
 *
 * @param plan - the declared plan.
 * @returns the tools in force, deduplicated and in declaration order; empty when
 *   neither source names one.
 */
export declare function planAllowedTools(plan: DeclaredPlan): string[];
/**
 * The cross-step state the EMA needs, one per project.
 *
 * This must be persisted, and that is not an optimisation. `final` is cumulative:
 * it is the memory that makes a slow drift visible at all. Held only in memory it
 * resets to zero on every restart, so a project that restarts often would never
 * accumulate enough to reach the card threshold no matter how it behaves — the
 * "3 consecutive steps" condition would be unmeetable, and the monitor would
 * quietly never escalate.
 *
 * `stepsSeen` is kept for a different reason: a card opened at step 7 of a run
 * that only ever saw 8 steps means something else than one opened at step 7 of
 * step 400, and without the count the report cannot say which happened.
 */
export declare const SignalStateSchema: z.ZodObject<{
    projectId: z.ZodString;
    final: z.ZodDefault<z.ZodNumber>;
    consecutiveHigh: z.ZodDefault<z.ZodNumber>;
    stepsSeen: z.ZodDefault<z.ZodNumber>;
    lastAggregate: z.ZodOptional<z.ZodObject<{
        riskScore: z.ZodNullable<z.ZodNumber>;
        availableWeight: z.ZodNumber;
        coverage: z.ZodNumber;
        behaviourScore: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
        dimensions: z.ZodDefault<z.ZodArray<z.ZodObject<{
            dimension: z.ZodEnum<{
                scope: "scope";
                plan: "plan";
                progress: "progress";
                behaviour: "behaviour";
            }>;
            weight: z.ZodNumber;
            score: z.ZodNumber;
        }, z.core.$strip>>>;
        absent: z.ZodDefault<z.ZodArray<z.ZodObject<{
            signal: z.ZodEnum<{
                s2_class: "s2_class";
                s3_tool_novel: "s3_tool_novel";
                s4_plan_match: "s4_plan_match";
                s5_progress: "s5_progress";
                b_repeat: "b_repeat";
                b_error_streak: "b_error_streak";
                b_alternating: "b_alternating";
                b_monologue: "b_monologue";
            }>;
            status: z.ZodEnum<{
                no_declared_plan: "no_declared_plan";
                no_allowed_tools: "no_allowed_tools";
                data_not_collected: "data_not_collected";
                dependency_failed: "dependency_failed";
                insufficient_history: "insufficient_history";
            }>;
        }, z.core.$strip>>>;
        retired: z.ZodDefault<z.ZodArray<z.ZodObject<{
            signal: z.ZodEnum<{
                s2_class: "s2_class";
                s3_tool_novel: "s3_tool_novel";
                s4_plan_match: "s4_plan_match";
                s5_progress: "s5_progress";
                b_repeat: "b_repeat";
                b_error_streak: "b_error_streak";
                b_alternating: "b_alternating";
                b_monologue: "b_monologue";
            }>;
            score: z.ZodNumber;
            evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>;
    planId: z.ZodOptional<z.ZodString>;
    plan: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        goal: z.ZodString;
        linkedGoalId: z.ZodOptional<z.ZodString>;
        deadline: z.ZodOptional<z.ZodString>;
        allowedTools: z.ZodDefault<z.ZodArray<z.ZodString>>;
        steps: z.ZodDefault<z.ZodArray<z.ZodObject<{
            intent: z.ZodString;
            expects: z.ZodObject<{
                tool: z.ZodOptional<z.ZodString>;
                pathGlob: z.ZodOptional<z.ZodString>;
                assert: z.ZodOptional<z.ZodEnum<{
                    "tests-pass": "tests-pass";
                    "build-pass": "build-pass";
                    "file-changed": "file-changed";
                }>>;
            }, z.core.$strip>;
            optional: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strip>>>;
        declaredAt: z.ZodString;
        revisedAt: z.ZodOptional<z.ZodString>;
        vagueGoal: z.ZodDefault<z.ZodBoolean>;
        vagueGoalReason: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>;
    updatedAt: z.ZodString;
}, z.core.$strip>;
export type SignalState = z.infer<typeof SignalStateSchema>;
/**
 * Advance the persisted state by one step.
 *
 * Pure: takes the previous state and returns the next, so the caller owns
 * persistence and a test can replay a whole run without a store.
 *
 * @param previous - state before this step.
 * @param aggregate - this step's aggregation.
 * @param config - EMA parameters.
 * @param thresholds - response thresholds, for the consecutive counter.
 * @param now - timestamp to stamp.
 * @returns the state after this step.
 */
export declare function advanceSignalState(previous: SignalState | undefined, projectId: string, aggregate: StepAggregate, config: EmaConfig, thresholds: ResponseThresholds, now: Date): SignalState;
/**
 * Decide the response level from a persisted state.
 *
 * Thin wrapper so callers do not hand-assemble the four arguments, and so the
 * coverage floor keeps being checked inside `decideLevelFromScore`.
 *
 * @param state - state after this step.
 * @param thresholds - configured thresholds.
 * @returns the level to record.
 */
export declare function decideLevelFromState(state: SignalState, thresholds: ResponseThresholds): 0 | 1 | 2 | 3;
/**
 * Aggregate one step's signals into a single score and a coverage figure.
 *
 * A dimension's score is the maximum of its available signals. Maximum and not
 * mean, because the dimension asks "did anything leave the permitted scope" —
 * one out-of-scope tool is not diluted by the nine in-scope calls beside it.
 *
 * S1 is excluded from the weighted score entirely. It is the fallback: when no
 * dimension is available it is consulted alone, and when any dimension is
 * available it is ignored. Giving it a small weight instead would make it
 * present in every score while never being able to change a decision.
 *
 * @param scores - one entry per signal that was evaluated this step.
 * @param weights - dimension weights; defaults to the module constants.
 * @returns the aggregate, with `riskScore: null` when nothing was measurable.
 */
export declare function aggregateStep(scores: readonly SignalScore[], weights?: Readonly<Record<AggregationDimension, number>>): StepAggregate;
/**
 * Advance the smoothed score by one step.
 *
 * A step with no measurable signal does not decay the score toward zero: it
 * carries it forward. Decaying on missing data would let a signal outage clear a
 * drift that is still happening, and would make the score depend on how often
 * collection happened to succeed.
 *
 * @param previous - `final` from the step before.
 * @param aggregate - this step's aggregation.
 * @param beta - weight of the newest observation.
 * @returns `final` for this step.
 */
export declare function advanceEma(previous: number, aggregate: StepAggregate, beta: number): number;
/**
 * Decide the response level from a smoothed score.
 *
 * The coverage floor is checked here and not by the caller, so that "no
 * escalation without enough evidence" cannot be forgotten at one call site. The
 * grade gate is *not* checked here: it belongs to the caller, because this
 * function has no activity to inspect.
 *
 * @param final - smoothed score.
 * @param aggregate - this step's aggregation, for coverage.
 * @param consecutiveHigh - how many consecutive steps have been at or above the
 *   card threshold, including this one.
 * @param thresholds - configured thresholds.
 * @returns the level to record.
 */
export declare function decideLevelFromScore(final: number, aggregate: StepAggregate, consecutiveHigh: number, thresholds: ResponseThresholds): 0 | 1 | 2 | 3;
