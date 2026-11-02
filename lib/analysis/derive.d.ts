/**
 * Goal and contradiction derivation.
 *
 * This is the layer that turns a pile of files into a candidate tree. It works
 * by asking a model to read the material and explain itself, then checking that
 * explanation against the rules a goal or contradiction must satisfy.
 *
 * Three decisions shape the implementation:
 *
 * 1. **The model proposes, the program adjudicates.** Every node the model emits
 *    passes a gate that rejects transcriptions, generic trade-offs and unsupported
 *    claims. A rejected item is not dropped silently — it becomes a question for
 *    the user, because "I suspect a tension here but cannot justify it" is useful
 *    information.
 * 2. **User context is required input.** A model reading only the files can see
 *    what is being done, never why it matters. Without the user's role, intent and
 *    constraints, the honest output is "I cannot derive this" — not a tree made of
 *    document headings.
 * 3. **Empty is a valid answer.** `noContradictionFound` is a first-class result.
 *    A system that always finds tension is usually wrong.
 *
 * @module dsh-metacog/analysis/derive
 */
import { z } from 'zod';
import type { HostContext } from '../host.js';
import type { MaterialScan, TaskDirectoryView } from '../evidence/discover.js';
import type { ProjectContext } from '../data/types.js';
/**
 * One derived goal, as the model reports it.
 *
 * `tempId` exists because real node ids are assigned by the program after the
 * user confirms; the model only needs stable references within its own answer.
 */
export declare const DerivedGoalSchema: z.ZodObject<{
    tempId: z.ZodString;
    parentTempId: z.ZodDefault<z.ZodString>;
    depth: z.ZodNumber;
    title: z.ZodString;
    description: z.ZodDefault<z.ZodString>;
    derivation: z.ZodString;
    evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
    successCriteria: z.ZodDefault<z.ZodArray<z.ZodString>>;
    relevantActivities: z.ZodDefault<z.ZodArray<z.ZodString>>;
    allowedMethods: z.ZodDefault<z.ZodArray<z.ZodString>>;
    paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
    deadline: z.ZodDefault<z.ZodString>;
    confidence: z.ZodDefault<z.ZodNumber>;
    alternative: z.ZodDefault<z.ZodString>;
    status: z.ZodDefault<z.ZodEnum<{
        draft: "draft";
        active: "active";
        at_risk: "at_risk";
        blocked: "blocked";
        done: "done";
        deprecated: "deprecated";
    }>>;
    statusBasis: z.ZodDefault<z.ZodEnum<{
        session: "session";
        none: "none";
        deliverable: "deliverable";
        mtime: "mtime";
    }>>;
    statusEvidence: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export type DerivedGoal = z.infer<typeof DerivedGoalSchema>;
/** Where a tension comes from. Drives how it is discussed later. */
export declare const ConstraintKindSchema: z.ZodEnum<{
    unknown: "unknown";
    deadline: "deadline";
    "rule-decay": "rule-decay";
    resource: "resource";
    budget: "budget";
    technical: "technical";
    people: "people";
    information: "information";
}>;
export declare const DerivedContradictionSchema: z.ZodObject<{
    tempId: z.ZodString;
    parentTempId: z.ZodDefault<z.ZodString>;
    title: z.ZodString;
    poleA: z.ZodString;
    poleB: z.ZodString;
    constraintKind: z.ZodDefault<z.ZodEnum<{
        unknown: "unknown";
        deadline: "deadline";
        "rule-decay": "rule-decay";
        resource: "resource";
        budget: "budget";
        technical: "technical";
        people: "people";
        information: "information";
    }>>;
    blocksGoalTempIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
    consequence: z.ZodDefault<z.ZodString>;
    evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
    confidence: z.ZodDefault<z.ZodNumber>;
    mitigationHint: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export type DerivedContradiction = z.infer<typeof DerivedContradictionSchema>;
/** What the model says it read, so the user can audit the basis. */
export declare const EvidenceManifestEntrySchema: z.ZodObject<{
    path: z.ZodString;
    why: z.ZodDefault<z.ZodString>;
    useful: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
/** Project background the model reads out of the documents themselves. */
export declare const ProjectProfileSchema: z.ZodObject<{
    summary: z.ZodDefault<z.ZodString>;
    stage: z.ZodDefault<z.ZodString>;
    deliverables: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;
/** The full derivation result. */
export declare const DerivationOutputSchema: z.ZodObject<{
    evidenceManifest: z.ZodDefault<z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        why: z.ZodDefault<z.ZodString>;
        useful: z.ZodDefault<z.ZodBoolean>;
    }, z.core.$strip>>>;
    goals: z.ZodDefault<z.ZodArray<z.ZodObject<{
        tempId: z.ZodString;
        parentTempId: z.ZodDefault<z.ZodString>;
        depth: z.ZodNumber;
        title: z.ZodString;
        description: z.ZodDefault<z.ZodString>;
        derivation: z.ZodString;
        evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
        successCriteria: z.ZodDefault<z.ZodArray<z.ZodString>>;
        relevantActivities: z.ZodDefault<z.ZodArray<z.ZodString>>;
        allowedMethods: z.ZodDefault<z.ZodArray<z.ZodString>>;
        paths: z.ZodDefault<z.ZodArray<z.ZodString>>;
        deadline: z.ZodDefault<z.ZodString>;
        confidence: z.ZodDefault<z.ZodNumber>;
        alternative: z.ZodDefault<z.ZodString>;
        status: z.ZodDefault<z.ZodEnum<{
            draft: "draft";
            active: "active";
            at_risk: "at_risk";
            blocked: "blocked";
            done: "done";
            deprecated: "deprecated";
        }>>;
        statusBasis: z.ZodDefault<z.ZodEnum<{
            session: "session";
            none: "none";
            deliverable: "deliverable";
            mtime: "mtime";
        }>>;
        statusEvidence: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>>;
    contradictions: z.ZodDefault<z.ZodArray<z.ZodObject<{
        tempId: z.ZodString;
        parentTempId: z.ZodDefault<z.ZodString>;
        title: z.ZodString;
        poleA: z.ZodString;
        poleB: z.ZodString;
        constraintKind: z.ZodDefault<z.ZodEnum<{
            unknown: "unknown";
            deadline: "deadline";
            "rule-decay": "rule-decay";
            resource: "resource";
            budget: "budget";
            technical: "technical";
            people: "people";
            information: "information";
        }>>;
        blocksGoalTempIds: z.ZodDefault<z.ZodArray<z.ZodString>>;
        consequence: z.ZodDefault<z.ZodString>;
        evidence: z.ZodDefault<z.ZodArray<z.ZodString>>;
        confidence: z.ZodDefault<z.ZodNumber>;
        mitigationHint: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>>>;
    projectProfile: z.ZodDefault<z.ZodObject<{
        summary: z.ZodDefault<z.ZodString>;
        stage: z.ZodDefault<z.ZodString>;
        deliverables: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    noContradictionFound: z.ZodDefault<z.ZodBoolean>;
    openQuestions: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export type DerivationOutput = z.infer<typeof DerivationOutputSchema>;
/**
 * One session that plausibly belongs to a task directory.
 *
 * Derivation runs as a subagent and cannot reach the plugin's host services, so
 * this is what the plugin process collected and hands over as material. Each
 * entry says *how* it was matched, because "the session ran in this directory"
 * and "the session mentioned this directory in its title" are different facts.
 */
export interface SessionEvidence {
    readonly sessionId: string;
    readonly title: string;
    /** ISO timestamp of the last activity, `''` when the store does not say. */
    readonly lastActivityAt: string;
    readonly archived: boolean;
    /** How it was attached to the directory. */
    readonly matchedBy: 'cwd' | 'title' | 'content';
    /** Task directory it was attached to; `''` when it belongs to none. */
    readonly directory: string;
    /** Best excerpt, only when content search actually ran. */
    readonly snippet?: string;
}
/**
 * Session history as material for the prompt.
 *
 * `contentSearchUsed: false` is not a failure: it means the semantic engine was
 * missing, the index was not built, or the embedding backend was down. The
 * prompt then says so in words, because titles and timestamps can show *that*
 * work happened but never that it finished.
 */
export interface SessionMaterial {
    readonly sessions: readonly SessionEvidence[];
    readonly contentSearchUsed: boolean;
    readonly degradedReason?: string;
}
/**
 * Render session material for the derivation prompt.
 *
 * Never invents content: a session without a snippet is listed as a title and a
 * time, and when the engine was unavailable the block states outright that
 * conversation content did not participate in the judgement.
 *
 * @param material - collected session evidence.
 */
export declare function renderSessionEvidence(material: SessionMaterial): string;
/**
 * JSON Schema handed to the subagent's `outputSchema`.
 *
 * Written as plain JSON rather than generated from zod: the subagent validates
 * against this document, and a generator that drifts from the zod parser would
 * let values through one gate and fail the other.
 */
export declare const DERIVATION_JSON_SCHEMA: {
    readonly type: "object";
    readonly properties: {
        readonly evidenceManifest: {
            readonly type: "array";
            readonly description: "Which files you actually read, and why";
            readonly items: {
                readonly type: "object";
                readonly properties: {
                    readonly path: {
                        readonly type: "string";
                    };
                    readonly why: {
                        readonly type: "string";
                    };
                    readonly useful: {
                        readonly type: "boolean";
                    };
                };
                readonly required: readonly ["path"];
                readonly additionalProperties: false;
            };
        };
        readonly goals: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly properties: {
                    readonly tempId: {
                        readonly type: "string";
                    };
                    readonly parentTempId: {
                        readonly type: "string";
                        readonly description: "父目标的 tempId；根目标留空字符串 \"\"";
                    };
                    readonly depth: {
                        readonly type: "integer";
                    };
                    readonly title: {
                        readonly type: "string";
                    };
                    readonly description: {
                        readonly type: "string";
                    };
                    readonly derivation: {
                        readonly type: "string";
                    };
                    readonly evidence: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly successCriteria: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly relevantActivities: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                        readonly description: string;
                    };
                    readonly allowedMethods: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                        readonly description: "允许的实现手段或工具（如「typescript」「pytest」）。命中也算服务于该目标。";
                    };
                    readonly paths: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                        readonly description: string;
                    };
                    readonly deadline: {
                        readonly type: "string";
                        readonly description: string;
                    };
                    readonly confidence: {
                        readonly type: "number";
                    };
                    readonly alternative: {
                        readonly type: "string";
                    };
                    readonly status: {
                        readonly type: "string";
                        readonly enum: readonly ["draft", "active", "at_risk", "blocked", "done", "deprecated"];
                        readonly description: string;
                    };
                    readonly statusBasis: {
                        readonly type: "string";
                        readonly enum: readonly ["deliverable", "session", "mtime", "none"];
                        readonly description: string;
                    };
                    readonly statusEvidence: {
                        readonly type: "string";
                        readonly description: "具体依据：文件名、会话标题、日期或计数。没有证据时写「无完成证据」。";
                    };
                };
                readonly required: readonly ["tempId", "depth", "title", "derivation", "status", "statusBasis", "statusEvidence"];
                readonly additionalProperties: false;
            };
        };
        readonly contradictions: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly properties: {
                    readonly tempId: {
                        readonly type: "string";
                    };
                    readonly parentTempId: {
                        readonly type: "string";
                        readonly description: string;
                    };
                    readonly title: {
                        readonly type: "string";
                    };
                    readonly poleA: {
                        readonly type: "string";
                    };
                    readonly poleB: {
                        readonly type: "string";
                    };
                    readonly constraintKind: {
                        readonly type: "string";
                        readonly enum: readonly ["rule-decay", "resource", "budget", "deadline", "technical", "people", "information", "unknown"];
                    };
                    readonly blocksGoalTempIds: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly consequence: {
                        readonly type: "string";
                    };
                    readonly evidence: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly confidence: {
                        readonly type: "number";
                    };
                    readonly mitigationHint: {
                        readonly type: "string";
                    };
                };
                readonly required: readonly ["tempId", "title", "poleA", "poleB"];
                readonly additionalProperties: false;
            };
        };
        readonly projectProfile: {
            readonly type: "object";
            readonly description: "从文档读出的项目背景：这是什么项目、现在处于哪个阶段、要交付什么";
            readonly properties: {
                readonly summary: {
                    readonly type: "string";
                };
                readonly stage: {
                    readonly type: "string";
                };
                readonly deliverables: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "string";
                    };
                };
            };
            readonly additionalProperties: false;
        };
        readonly noContradictionFound: {
            readonly type: "boolean";
        };
        readonly openQuestions: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
        };
    };
    readonly required: readonly ["goals", "contradictions"];
    readonly additionalProperties: false;
};
/** A rejected item and why, surfaced to the user as a question. */
export interface Rejection {
    kind: 'goal' | 'contradiction';
    tempId: string;
    code: string;
    message: string;
}
/**
 * Whether a derivation merely restates its title.
 *
 * A real derivation explains the reasoning behind a goal and therefore shares
 * little verbatim text with it. One that echoes the title back is transcription
 * dressed as analysis, which is the exact failure this whole layer exists to
 * avoid.
 *
 * Structural evidence is the exception, and it is the one that matters here:
 * when a project is one directory per task, the goal *is* named after the
 * directory, and any honest derivation will reuse the name. "系庆ppt 目录下有 38
 * 个文件，其中 12 个是 pptx 定稿" is reasoning about the workspace, not a document
 * heading copied into the tree — so a title echo backed by a path or a count is
 * allowed, while one that repeats the title with nothing to show for it is not.
 *
 * @param title - the goal title.
 * @param derivation - the claimed reasoning.
 * @param evidence - cited paths/facts.
 */
export declare function looksLikeTranscription(title: string, derivation: string, evidence: readonly string[]): boolean;
/** Whether two poles form one of the contentless trade-off pairs. */
export declare function isGenericTradeoff(poleA: string, poleB: string): boolean;
/**
 * Gate one contradiction draft.
 *
 * @returns a rejection code, or `undefined` when the draft is acceptable.
 */
export declare function contradictionRejection(c: DerivedContradiction): string | undefined;
/** A derivation result plus what the program rejected and why. */
export interface DerivationReview {
    output: DerivationOutput;
    rejections: Rejection[];
    /** Nodes whose confidence was capped by a quality gate. */
    capped: {
        tempId: string;
        reason: string;
    }[];
    questions: string[];
}
/** What programmatic path binding produced. */
export interface PathBindingResult {
    readonly goals: DerivedGoal[];
    /** L1 goals that were bound, for logging and tests. */
    readonly bound: {
        tempId: string;
        title: string;
        directory: string;
    }[];
    /** L1 titles left without a path, so the review can ask the user. */
    readonly unmatched: string[];
}
/**
 * Bind L1 goals to task directories by title, then let deeper goals inherit.
 *
 * The model is no longer asked to copy directory names: the scan already knows
 * them, and a copy is both unreliable and unnecessary. A model-provided path is
 * trusted as-is (it may know a subdirectory the scan did not classify); only
 * empty L1 paths are matched. A tie between two equally good directories is
 * left unbound — a wrong binding is worse than a missing one.
 *
 * @param goals - reviewed goals, in tree order.
 * @param directories - task-directory view from the scan, when available.
 */
export declare function bindL1Paths(goals: readonly DerivedGoal[], directories: TaskDirectoryView | undefined): PathBindingResult;
/**
 * Whether a background field still carries a placeholder instead of an answer.
 *
 * "未确认：从文件看是…" is the model telling the user it guessed. Treating that
 * as background is how a whole tree gets confirmed on a guess, so both the
 * derivation review and confirmation treat these phrases as "not answered".
 *
 * @param value - the `projectContext.role` (or similar) text.
 */
export declare function isPlaceholderContext(value: string): boolean;
/**
 * Apply every quality gate to a raw derivation.
 *
 * Rejected contradictions are not discarded: each becomes an open question so
 * the user can decide whether the suspicion is worth keeping. Rejected goals are
 * kept but capped, because a badly justified goal is still a hypothesis worth
 * showing.
 *
 * @param raw - parsed derivation output.
 * @param context - user background; a placeholder role becomes an open question.
 * @param projectRoot - root used to check that `paths` exist on disk.
 */
export declare function reviewDerivation(raw: DerivationOutput, context?: ProjectContext, projectRoot?: string, directories?: TaskDirectoryView): DerivationReview;
/** Everything the prompt needs. */
export interface DerivationPromptInput {
    materials: MaterialScan;
    context: ProjectContext;
    /** Prior tree summary, when re-deriving an existing project. */
    priorSummary?: string;
    /** Top-level structure read as tasks. Omitted on older callers. */
    directories?: TaskDirectoryView;
    /** Session history collected by the plugin process. Omitted when none. */
    sessions?: SessionMaterial;
}
/**
 * Build the derivation prompt.
 *
 * The structure follows the three distinctions the answer depends on: what a
 * goal is, what a contradiction is, and why user context matters. The explicit
 * permission to find nothing is load-bearing — without it a model will invent a
 * tension to satisfy the request.
 *
 * The material list carries titles only. Deciding which few files matter is the
 * model's job; handing it every path up front spends the prompt budget on
 * material it will not use and nudges it toward reading too much.
 *
 * The number of files to read is deliberately not specified: the model decides
 * how much evidence it needs, and a fixed quota would override that judgement.
 *
 * @param input - materials, context and optional prior state.
 */
export declare function buildDerivationPrompt(input: DerivationPromptInput): string;
/** What happened when derivation was attempted. */
export type DerivationOutcome = {
    readonly status: 'ok';
    readonly review: DerivationReview;
    readonly usage: DerivationUsage;
} | {
    readonly status: 'unavailable';
    readonly reason: string;
} | {
    readonly status: 'failed';
    readonly reason: string;
};
/** Bookkeeping the caller can log and report. */
export interface DerivationUsage {
    readonly provider: string;
    readonly childId: string;
    readonly stopReason: string;
    /** Wall-clock milliseconds for the whole activation. */
    readonly elapsedMs: number;
    /** Total characters in the prompt, a proxy for input size. */
    readonly promptChars: number;
    /** Characters in the model's textual output. */
    readonly outputChars: number;
}
/** Everything derivation needs from the host. */
export interface DeriveOptions {
    readonly ctx: HostContext;
    readonly prompt: string;
    /** Working directory handed to the child so it can read project files. */
    readonly cwd: string;
    /** User background; a placeholder role becomes an open question. */
    readonly context?: ProjectContext;
    /** Task directories from the scan, used for programmatic L1 path binding. */
    readonly directories?: TaskDirectoryView;
    readonly timeoutMs?: number;
}
/**
 * Ask a subagent to perform the derivation.
 *
 * Failure modes are all reported as values rather than thrown, because every one
 * of them has a caller-side response: unavailable means degrade, failed means
 * tell the user why, ok means proceed to review.
 *
 * @param options - host context, prompt and workspace.
 */
export declare function deriveWithSubagent(options: DeriveOptions): Promise<DerivationOutcome>;
