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
import { z } from 'zod'
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

import type { HostAgent, HostContext } from '../host.js'
import type { MaterialScan, TaskDirectoryView } from '../evidence/discover.js'
import { renderTaskDirectories, renderTitles } from '../evidence/discover.js'
import type { ProjectContext } from '../data/types.js'
import { GoalStatusSchema } from '../data/types.js'

// ---------------------------------------------------------------- output schema

/**
 * One derived goal, as the model reports it.
 *
 * `tempId` exists because real node ids are assigned by the program after the
 * user confirms; the model only needs stable references within its own answer.
 */
export const DerivedGoalSchema = z.object({
  tempId: z.string().min(1),
  // Root goals carry no parent, but the subagent's output schema cannot express
  // `null`: the host validator rejects a type array ("type arrays are not
  // supported"). So the wire format uses an empty string and the boundary
  // normalises it back to null.
  parentTempId: z.string().default(''),
  depth: z.number().int().min(0).max(9),
  title: z.string().min(1),
  description: z.string().default(''),
  /** Why this is a goal. Must cite a fact, not restate the title. */
  derivation: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  successCriteria: z.array(z.string()).default([]),
  /**
   * What daily work legitimately advances this goal.
   *
   * `successCriteria` says when the goal is *done*; these two say when an
   * activity is *serving* it. The alignment rules match on the latter only, so a
   * tree derived without them can never produce an `aligned` verdict — every
   * activity falls through to `scope_drift`. They are part of the derivation
   * schema for exactly that reason, not as optional decoration.
   */
  relevantActivities: z.array(z.string()).default([]),
  allowedMethods: z.array(z.string()).default([]),
  /**
   * Relative path prefixes this goal owns.
   *
   * F5 already gives the model one task directory per L1; binding the directory
   * here is what lets path-based alignment work. The review gate rejects
   * absolute paths and paths that do not exist.
   */
  paths: z.array(z.string()).default([]),
  /**
   * ISO deadline, only when the material states one.
   *
   * Empty is the honest answer when no date is evidenced; the review asks the
   * user for it through `openQuestions` rather than inventing a date.
   */
  deadline: z.string().default(''),
  /** 0..1; below 0.5 the node is shown as uncertain rather than as a candidate. */
  confidence: z.number().min(0).max(1).default(0.5),
  /** Another reading of the same facts, offered to the user. */
  alternative: z.string().default(''),
  /**
   * Where the task stands right now, and what that judgement rests on.
   *
   * A tree where every node is `draft` answers none of the questions the user
   * actually asked: it cannot separate "this is finished" from "nobody has
   * touched it". `statusBasis` records the kind of fact, so the review can refuse
   * a status that cites nothing and can label a date-only guess as weak.
   *
   * There is no `unknown` in `GoalStatusSchema`, so "no evidence" is expressed as
   * `draft` **plus** `statusBasis: 'none'` and a sentence saying so in the
   * derivation — never as a silent default.
   */
  status: GoalStatusSchema.default('draft'),
  statusBasis: z.enum(['deliverable', 'session', 'mtime', 'none']).default('none'),
  /** The concrete evidence: a file name, a session title, a date. */
  statusEvidence: z.string().default(''),
})
export type DerivedGoal = z.infer<typeof DerivedGoalSchema>

/** Where a tension comes from. Drives how it is discussed later. */
export const ConstraintKindSchema = z.enum([
  'rule-decay',
  'resource',
  'budget',
  'deadline',
  'technical',
  'people',
  'information',
  'unknown',
])

export const DerivedContradictionSchema = z.object({
  tempId: z.string().min(1),
  /**
   * Parent contradiction's `tempId`, or `''` at the top level.
   *
   * The host's schema validator rejects nullable type arrays, so absence is
   * encoded as an empty string — the same convention `DerivedGoalSchema` uses.
   * Depth is not limited and is independent of goal depth: a root tension may
   * have the concrete forms it takes beneath it, and those may have their own.
   */
  parentTempId: z.string().default(''),
  title: z.string().min(1),
  poleA: z.string().min(1),
  poleB: z.string().min(1),
  constraintKind: ConstraintKindSchema.default('unknown'),
  /** Which derived goals this blocks, by `tempId`. */
  blocksGoalTempIds: z.array(z.string()).default([]),
  /** What happens if it is not addressed. Must be concrete. */
  consequence: z.string().default(''),
  evidence: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  mitigationHint: z.string().default(''),
})
export type DerivedContradiction = z.infer<typeof DerivedContradictionSchema>

/** What the model says it read, so the user can audit the basis. */
export const EvidenceManifestEntrySchema = z.object({
  path: z.string().min(1),
  why: z.string().default(''),
  useful: z.boolean().default(true),
})

/** Project background the model reads out of the documents themselves. */
export const ProjectProfileSchema = z.object({
  /** What the project is, in one or two sentences. */
  summary: z.string().default(''),
  /** Which phase the documents indicate, and on what evidence. */
  stage: z.string().default(''),
  /** What has to be handed over, and to whom. */
  deliverables: z.array(z.string()).default([]),
})
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>

/** The full derivation result. */
export const DerivationOutputSchema = z.object({
  evidenceManifest: z.array(EvidenceManifestEntrySchema).default([]),
  goals: z.array(DerivedGoalSchema).default([]),
  contradictions: z.array(DerivedContradictionSchema).default([]),
  /**
   * What the project is, read from its own files.
   *
   * Asked for separately from the goals because the two answer different
   * questions: the profile says what this workspace *is*, the goals say what it is
   * *for*. Without the first, a goal tree tends to inherit the user's framing
   * rather than the documents'.
   */
  projectProfile: ProjectProfileSchema.default({ summary: '', stage: '', deliverables: [] }),
  /** Legitimate: a project may have no structural tension right now. */
  noContradictionFound: z.boolean().default(false),
  /** Things the model could not decide and needs the user to answer. */
  openQuestions: z.array(z.string()).default([]),
})
export type DerivationOutput = z.infer<typeof DerivationOutputSchema>

// ---------------------------------------------------------------- session evidence

/**
 * One session that plausibly belongs to a task directory.
 *
 * Derivation runs as a subagent and cannot reach the plugin's host services, so
 * this is what the plugin process collected and hands over as material. Each
 * entry says *how* it was matched, because "the session ran in this directory"
 * and "the session mentioned this directory in its title" are different facts.
 */
export interface SessionEvidence {
  readonly sessionId: string
  readonly title: string
  /** ISO timestamp of the last activity, `''` when the store does not say. */
  readonly lastActivityAt: string
  readonly archived: boolean
  /** How it was attached to the directory. */
  readonly matchedBy: 'cwd' | 'title' | 'content'
  /** Task directory it was attached to; `''` when it belongs to none. */
  readonly directory: string
  /** Best excerpt, only when content search actually ran. */
  readonly snippet?: string
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
  readonly sessions: readonly SessionEvidence[]
  readonly contentSearchUsed: boolean
  readonly degradedReason?: string
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
export function renderSessionEvidence(material: SessionMaterial): string {
  const lines: string[] = []
  if (material.sessions.length === 0) {
    lines.push('会话证据：没有找到与本工作区目录相关的会话。')
  } else {
    lines.push(
      `会话证据：${material.sessions.length} 条与本工作区相关的会话（按目录归属）。`,
    )
    for (const session of material.sessions.slice(0, 24)) {
      const archived = session.archived ? '，已归档' : ''
      const when = session.lastActivityAt === '' ? '时间未知' : `最后活动 ${session.lastActivityAt.slice(0, 10)}`
      const where = session.directory === '' ? '未归属目录' : session.directory
      const how = session.matchedBy === 'cwd' ? '按 cwd' : session.matchedBy === 'title' ? '按标题' : '按内容命中'
      lines.push(`- 「${session.title}」（${where}，${how}，${when}${archived}）`)
      if (session.snippet !== undefined && session.snippet.trim().length > 0) {
        lines.push(`    相关片段：${session.snippet.replace(/\s+/g, ' ').slice(0, 160)}`)
      }
    }
  }
  if (!material.contentSearchUsed) {
    const why = material.degradedReason ?? '未提供语义检索服务'
    lines.push(
      `**会话内容未参与判定**（原因：${why}）。上面的标题与时间只能说明「有没有过相关会话」，` +
        '不能证明某件事已完成或未完成；请在晋升为 done 之前要求别的证据，或把疑问写进 openQuestions。',
    )
  }
  return lines.join('\n')
}

/**
 * JSON Schema handed to the subagent's `outputSchema`.
 *
 * Written as plain JSON rather than generated from zod: the subagent validates
 * against this document, and a generator that drifts from the zod parser would
 * let values through one gate and fail the other.
 */
export const DERIVATION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    evidenceManifest: {
      type: 'array',
      description: 'Which files you actually read, and why',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          why: { type: 'string' },
          useful: { type: 'boolean' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    goals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tempId: { type: 'string' },
          parentTempId: {
            type: 'string',
            description: '父目标的 tempId；根目标留空字符串 ""',
          },
          depth: { type: 'integer' },
          title: { type: 'string' },
          description: { type: 'string' },
          derivation: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          successCriteria: { type: 'array', items: { type: 'string' } },
          relevantActivities: {
            type: 'array',
            items: { type: 'string' },
            description:
              '哪些活动算服务于这个目标，用能匹配上活动摘要的短词（如「结构建模」「drift analysis」）。' +
              '这是对齐判定的唯一依据，留空则该目标永远匹配不上任何活动。',
          },
          allowedMethods: {
            type: 'array',
            items: { type: 'string' },
            description:
              '允许的实现手段或工具（如「typescript」「pytest」）。命中也算服务于该目标。',
          },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description:
              '这个目标拥有的相对路径前缀。L1 若对应某个任务目录，填该目录（如「系庆ppt」）；' +
              '更深层可继承或细化。必须是相对路径且真实存在，不允许绝对路径或 ..。',
          },
          deadline: {
            type: 'string',
            description:
              'ISO 截止时间，仅在材料里有明确日期时填写（如 2026-11-07T00:00:00.000Z）；' +
              '没有证据就留空，并把「该 L1 的截止时间」写进 openQuestions，不要编日期。',
          },
          confidence: { type: 'number' },
          alternative: { type: 'string' },
          status: {
            type: 'string',
            enum: ['draft', 'active', 'at_risk', 'blocked', 'done', 'deprecated'],
            description:
              '这个任务级目标现在处于什么状态。done 表示已完成；draft 表示不确定或没有任何完成证据。' +
              '不允许把所有目标一律写成 draft 来回避判断。',
          },
          statusBasis: {
            type: 'string',
            enum: ['deliverable', 'session', 'mtime', 'none'],
            description:
              '完成状态的依据类型：deliverable=终稿/交付类文件；session=会话内容明确说已完成；' +
              'mtime=只有最后修改时间（弱证据）；none=没有证据。',
          },
          statusEvidence: {
            type: 'string',
            description: '具体依据：文件名、会话标题、日期或计数。没有证据时写「无完成证据」。',
          },
        },
        required: ['tempId', 'depth', 'title', 'derivation', 'status', 'statusBasis', 'statusEvidence'],
        additionalProperties: false,
      },
    },
    contradictions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          tempId: { type: 'string' },
          parentTempId: {
            type: 'string',
            description:
              '父矛盾的 tempId；顶层矛盾留空字符串 ""。矛盾树可以多层，深度不限，' +
              '且不要求与目标层级对应。',
          },
          title: { type: 'string' },
          poleA: { type: 'string' },
          poleB: { type: 'string' },
          constraintKind: {
            type: 'string',
            enum: [
              'rule-decay',
              'resource',
              'budget',
              'deadline',
              'technical',
              'people',
              'information',
              'unknown',
            ],
          },
          blocksGoalTempIds: { type: 'array', items: { type: 'string' } },
          consequence: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' },
          mitigationHint: { type: 'string' },
        },
        required: ['tempId', 'title', 'poleA', 'poleB'],
        additionalProperties: false,
      },
    },
    projectProfile: {
      type: 'object',
      description: '从文档读出的项目背景：这是什么项目、现在处于哪个阶段、要交付什么',
      properties: {
        summary: { type: 'string' },
        stage: { type: 'string' },
        deliverables: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    noContradictionFound: { type: 'boolean' },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['goals', 'contradictions'],
  additionalProperties: false,
} as const

// ---------------------------------------------------------------- quality gates

/** Trade-off pairs that describe no situation in particular. */
const GENERIC_PAIRS: [string, string][] = [
  ['速度', '质量'],
  ['快速', '严谨'],
  ['效率', '完整'],
  ['灵活', '规范'],
  ['简单', '完备'],
  ['短期', '长期'],
  ['理想', '现实'],
  ['理论', '实践'],
  ['创新', '稳定'],
  ['自由', '约束'],
  ['fast', 'rigorous'],
  ['speed', 'quality'],
]

/** A rejected item and why, surfaced to the user as a question. */
export interface Rejection {
  kind: 'goal' | 'contradiction'
  tempId: string
  code: string
  message: string
}

/** Normalize text for similarity checks. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[.,;:!?'"`()[\]{}<>/\\|]/g, '')
}

/**
 * Longest common subsequence length, used as a cheap similarity proxy.
 *
 * Chosen over edit distance because it answers the question that matters here:
 * how much of the title's content reappears in the derivation. A derivation that
 * merely repeats the title shares nearly all of it.
 */
function lcsLength(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0
  let prev = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i += 1) {
    const curr = new Array<number>(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? (prev[j - 1] ?? 0) + 1
          : Math.max(prev[j] ?? 0, curr[j - 1] ?? 0)
    }
    prev = curr
  }
  return prev[b.length] ?? 0
}

/**
 * Whether a text cites a structural fact about the workspace.
 *
 * Two shapes count: a project-relative path (`系庆ppt/`, `src/api`) and a count
 * of files (`38 个`, `118 files`). These are facts that only come from walking
 * the tree, so a derivation that rests on them is reasoning about structure
 * rather than copying a document's numbering.
 */
function citesStructuralFact(text: string): boolean {
  if (/[\w\u4e00-\u9fa5._:-]+\/(?:[\w\u4e00-\u9fa5._:-]+)?/.test(text)) return true
  if (/\d+\s*(?:个|份|files?|items?|documents?)/i.test(text)) return true
  return /(?:目录|子目录|文件数|最新改动|最后修改|mtime)/.test(text)
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
export function looksLikeTranscription(
  title: string,
  derivation: string,
  evidence: readonly string[],
): boolean {
  const t = normalize(title)
  const d = normalize(derivation)
  if (d.length === 0) return true
  if (t.length === 0) return false
  const coverage = lcsLength(t, d) / t.length
  if (coverage < 0.3) return false
  // The derivation reuses most of the title, so it needs a reason to be more
  // than an echo: either it explains substantially, or it cites structure.
  if (d.length >= t.length * 2) return false
  const structural =
    citesStructuralFact(derivation) || evidence.some((entry) => citesStructuralFact(entry))
  // A bare "标题 + 38 个文件" still says nothing about what the goal is; require
  // a little more than the title itself before the exemption applies.
  return !(structural && d.length >= t.length + 8)
}

/** Whether two poles form one of the contentless trade-off pairs. */
export function isGenericTradeoff(poleA: string, poleB: string): boolean {
  const a = normalize(poleA)
  const b = normalize(poleB)
  return GENERIC_PAIRS.some(
    ([x, y]) => (a.includes(x) && b.includes(y)) || (a.includes(y) && b.includes(x)),
  )
}

/**
 * Gate one contradiction draft.
 *
 * @returns a rejection code, or `undefined` when the draft is acceptable.
 */
export function contradictionRejection(c: DerivedContradiction): string | undefined {
  if (c.evidence.length === 0) return 'EVIDENCE_REQUIRED'
  if (c.consequence.trim().length < 15) return 'CONSEQUENCE_TOO_VAGUE'
  if (c.blocksGoalTempIds.length === 0) return 'MUST_BLOCK_A_GOAL'
  if (isGenericTradeoff(c.poleA, c.poleB)) return 'GENERIC_TRADEOFF'
  return undefined
}

/** A derivation result plus what the program rejected and why. */
export interface DerivationReview {
  output: DerivationOutput
  rejections: Rejection[]
  /** Nodes whose confidence was capped by a quality gate. */
  capped: { tempId: string; reason: string }[]
  questions: string[]
}

/** Human explanation of a rejection code. */
function describeRejection(code: string): string {
  switch (code) {
    case 'EVIDENCE_REQUIRED':
      return '没有给出来源证据'
    case 'CONSEQUENCE_TOO_VAGUE':
      return '说不清不解决会有什么具体后果'
    case 'MUST_BLOCK_A_GOAL':
      return '没有指明它阻碍哪个目标'
    case 'GENERIC_TRADEOFF':
      return '是「快 vs 好」这类没有具体对象的泛泛对立'
    case 'ORPHAN_CONTRADICTION_PARENT':
      return '引用的父矛盾不在本次结果里（父节点缺失，或父节点本身未通过检验）'
    case 'CONTRADICTION_CYCLE':
      return '父矛盾引用形成环，这条张力没有根'
    default:
      return code
  }
}

/**
 * Drop contradictions whose parent link cannot be honoured.
 *
 * Two ways a hierarchy breaks: a parent that is missing or was itself rejected
 * (an orphan), and a parent chain that loops. Both are rejected rather than
 * silently flattened — a tension stored under the wrong parent would distort
 * every burden computed from the tree, and a loop would hang any reader that
 * walks the chain. Rejecting a parent also rejects its children, transitively.
 *
 * @param items - contradictions that already passed their own quality gates.
 * @returns survivors, plus the rejects with the code that removed each.
 */
function pruneContradictionHierarchy(items: DerivedContradiction[]): {
  kept: DerivedContradiction[]
  rejected: { item: DerivedContradiction; code: string }[]
} {
  const rejected: { item: DerivedContradiction; code: string }[] = []

  const withoutOrphans = (input: DerivedContradiction[]): DerivedContradiction[] => {
    let kept = [...input]
    let changed = true
    while (changed) {
      changed = false
      const known = new Set(kept.map((item) => item.tempId))
      kept = kept.filter((item) => {
        if (item.parentTempId === '' || known.has(item.parentTempId)) return true
        rejected.push({ item, code: 'ORPHAN_CONTRADICTION_PARENT' })
        changed = true
        return false
      })
    }
    return kept
  }

  let kept = withoutOrphans(items)
  const byId = new Map(kept.map((item) => [item.tempId, item]))
  const cyclic = new Set<string>()
  for (const item of kept) {
    const seen = new Set<string>([item.tempId])
    let cursor = item.parentTempId
    while (cursor !== '') {
      if (seen.has(cursor)) {
        cyclic.add(item.tempId)
        break
      }
      seen.add(cursor)
      cursor = byId.get(cursor)?.parentTempId ?? ''
    }
  }
  if (cyclic.size > 0) {
    kept = kept.filter((item) => {
      if (!cyclic.has(item.tempId)) return true
      rejected.push({ item, code: 'CONTRADICTION_CYCLE' })
      return false
    })
    // A child of a cycle member is now an orphan; prune it in the same pass so
    // the returned tree contains no dangling parent at all.
    kept = withoutOrphans(kept)
  }
  return { kept, rejected }
}

/**
 * Normalize a title or directory name for matching.
 *
 * Full-width characters are folded to half-width, case is dropped, and
 * separators/whitespace are removed, so `2026 省会换届` and `2026省会换届`
 * compare equal without guessing at semantics.
 */
function normalizeForMatch(text: string): string {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/[\s\u3000_\-./\\,;:!?'"`()[\]{}<>|]/g, '')
}

/** Length of the common prefix of two normalized strings. */
function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index += 1
  return index
}

/** Character bigrams, used as the last-resort word-level overlap. */
function bigrams(text: string): Set<string> {
  const out = new Set<string>()
  for (let index = 0; index + 1 < text.length; index += 1) out.add(text.slice(index, index + 2))
  return out
}

/**
 * Score how well a goal title names a task directory.
 *
 * Exact and containment matches win; a shared two-character prefix (the
 * 「系庆报告」↔「系庆ppt」 case) is the next strongest signal; a bigram overlap
 * is accepted only when it covers at least half of the longer name. Anything
 * below that is not evidence, and the caller leaves the path unbound.
 */
function directoryScore(title: string, directory: TaskDirectoryView['roots'][number]): number {
  const normalizedTitle = normalizeForMatch(title)
  if (normalizedTitle.length === 0) return 0
  let best = 0
  for (const raw of [directory.name, directory.path]) {
    const normalized = normalizeForMatch(raw)
    if (normalized.length === 0) continue
    if (normalizedTitle === normalized) {
      best = Math.max(best, 1000)
      continue
    }
    if (normalizedTitle.includes(normalized) || normalized.includes(normalizedTitle)) {
      best = Math.max(best, 500 + Math.min(normalizedTitle.length, normalized.length))
      continue
    }
    const prefix = commonPrefixLength(normalizedTitle, normalized)
    if (prefix >= 2) best = Math.max(best, 100 + prefix * 10)
    const titleBigrams = bigrams(normalizedTitle)
    const directoryBigrams = bigrams(normalized)
    let overlap = 0
    for (const gram of titleBigrams) if (directoryBigrams.has(gram)) overlap += 1
    const ratio = overlap / Math.max(titleBigrams.size, directoryBigrams.size, 1)
    if (ratio >= 0.5 && overlap > 0) best = Math.max(best, Math.round(ratio * 50))
  }
  return best
}

/** What programmatic path binding produced. */
export interface PathBindingResult {
  readonly goals: DerivedGoal[]
  /** L1 goals that were bound, for logging and tests. */
  readonly bound: { tempId: string; title: string; directory: string }[]
  /** L1 titles left without a path, so the review can ask the user. */
  readonly unmatched: string[]
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
export function bindL1Paths(
  goals: readonly DerivedGoal[],
  directories: TaskDirectoryView | undefined,
): PathBindingResult {
  const roots = directories?.roots ?? []
  const bound: { tempId: string; title: string; directory: string }[] = []
  const unmatched: string[] = []
  const next = goals.map((goal) => {
    if (goal.depth !== 1 || goal.paths.length > 0) return goal
    if (roots.length === 0) {
      unmatched.push(goal.title)
      return goal
    }
    const scored = roots
      .map((directory) => ({ directory, score: directoryScore(goal.title, directory) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
    const best = scored[0]
    const second = scored[1]
    if (best === undefined || (second !== undefined && second.score === best.score)) {
      unmatched.push(goal.title)
      return goal
    }
    bound.push({ tempId: goal.tempId, title: goal.title, directory: best.directory.path })
    return { ...goal, paths: [best.directory.path] }
  })

  // Deeper goals inherit the nearest ancestor's paths when they have none of
  // their own. A child under an unbound L1 stays unbound as well.
  const byTempId = new Map(next.map((goal) => [goal.tempId, goal]))
  const resolved = next.map((goal) => {
    if (goal.depth <= 1 || goal.paths.length > 0) return goal
    let cursor = goal.parentTempId
    const seen = new Set<string>([goal.tempId])
    while (cursor !== '' && !seen.has(cursor)) {
      seen.add(cursor)
      const parent = byTempId.get(cursor)
      if (parent === undefined) break
      if (parent.paths.length > 0) return { ...goal, paths: [...parent.paths] }
      cursor = parent.parentTempId
    }
    return goal
  })

  return { goals: resolved, bound, unmatched }
}

/**
 * Whether a background field still carries a placeholder instead of an answer.
 *
 * "未确认：从文件看是…" is the model telling the user it guessed. Treating that
 * as background is how a whole tree gets confirmed on a guess, so both the
 * derivation review and confirmation treat these phrases as "not answered".
 *
 * @param value - the `projectContext.role` (or similar) text.
 */
export function isPlaceholderContext(value: string): boolean {
  return /未确认|待确认|从文件看|无法确认|不确定|推测/.test(value)
}

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
export function reviewDerivation(
  raw: DerivationOutput,
  context?: ProjectContext,
  projectRoot?: string,
  directories?: TaskDirectoryView,
): DerivationReview {
  const rejections: Rejection[] = []
  const capped: { tempId: string; reason: string }[] = []
  const questions = [...raw.openQuestions]

  let goals = raw.goals.map((goal) => {
    let next = goal
    if (looksLikeTranscription(goal.title, goal.derivation, goal.evidence)) {
      rejections.push({
        kind: 'goal',
        tempId: goal.tempId,
        code: 'LIKELY_TRANSCRIPTION',
        message: `「${goal.title}」的推导只是在复述标题，没有引用任何可验证事实。`,
      })
      capped.push({ tempId: goal.tempId, reason: 'LIKELY_TRANSCRIPTION' })
      next = { ...next, confidence: Math.min(next.confidence, 0.4) }
    }

    // A task-level goal's status is the answer to "is this finished?", and an
    // unsupported answer is worse than none: it reads as fact. Only depth 1 is
    // gated this way — the root is a purpose, not a task.
    if (next.depth === 1) {
      const evidenceText = next.statusEvidence.trim()
      if (next.statusBasis !== 'none' && evidenceText.length === 0) {
        rejections.push({
          kind: 'goal',
          tempId: next.tempId,
          code: 'STATUS_EVIDENCE_REQUIRED',
          message: `「${next.title}」声称有完成依据（${next.statusBasis}），但没有写出具体证据。`,
        })
        capped.push({ tempId: next.tempId, reason: 'STATUS_EVIDENCE_REQUIRED' })
        next = { ...next, statusBasis: 'none', status: 'draft', confidence: Math.min(next.confidence, 0.4) }
      } else if (next.status !== 'draft' && next.statusBasis === 'none') {
        rejections.push({
          kind: 'goal',
          tempId: next.tempId,
          code: 'STATUS_WITHOUT_EVIDENCE',
          message: `「${next.title}」被标为「${next.status}」，但没有任何完成依据，已降回未判定。`,
        })
        capped.push({ tempId: next.tempId, reason: 'STATUS_WITHOUT_EVIDENCE' })
        next = { ...next, status: 'draft', confidence: Math.min(next.confidence, 0.3) }
      } else if (next.status === 'done' && next.statusBasis === 'mtime') {
        // A stale mtime means "nobody touched it", which is also what an
        // abandoned task looks like. Keep the guess, mark it weak.
        capped.push({ tempId: next.tempId, reason: 'STATUS_FROM_MTIME_ONLY' })
        next = { ...next, confidence: Math.min(next.confidence, 0.5) }
        questions.push(
          `「${next.title}」的「已完成」只凭最后修改时间推断（${evidenceText}）；` +
            '如果只是搁置，请改成 draft 或 blocked。',
        )
      }
    }
    // R3: bind paths and deadline, but never let a guess through. Invalid
    // values are dropped and asked about; a fabricated path or a past deadline
    // would silently become a monitoring basis.
    const invalidPaths: string[] = []
    const reviewedPaths: string[] = []
    for (const rawPath of next.paths ?? []) {
      const value = rawPath.trim()
      if (value.length === 0) continue
      if (isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).includes('..')) {
        invalidPaths.push(`${value}（绝对路径或越界）`)
        continue
      }
      const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '')
      if (projectRoot !== undefined) {
        const absolute = join(projectRoot, normalized)
        const rel = relative(projectRoot, absolute)
        if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(absolute)) {
          invalidPaths.push(`${value}（不存在）`)
          continue
        }
      }
      if (!reviewedPaths.includes(normalized)) reviewedPaths.push(normalized)
    }
    if (invalidPaths.length > 0) {
      rejections.push({
        kind: 'goal',
        tempId: next.tempId,
        code: 'PATH_INVALID',
        message: `「${next.title}」的 paths 无效：${invalidPaths.join('、')}。已丢弃，不写入树。`,
      })
      capped.push({ tempId: next.tempId, reason: 'PATH_INVALID' })
      questions.push(`「${next.title}」的 paths 无法采用：${invalidPaths.join('、')}。请给出真实存在的相对目录。`)
      next = { ...next, paths: reviewedPaths, confidence: Math.min(next.confidence, 0.5) }
    } else {
      next = { ...next, paths: reviewedPaths }
    }

    const rawDeadline = (next.deadline ?? '').trim()
    if (rawDeadline.length > 0) {
      const parsed = Date.parse(rawDeadline)
      const past = Number.isFinite(parsed) && parsed < Date.now() && next.status !== 'done'
      if (!Number.isFinite(parsed) || past) {
        rejections.push({
          kind: 'goal',
          tempId: next.tempId,
          code: 'DEADLINE_INVALID',
          message: `「${next.title}」的 deadline「${rawDeadline}」${Number.isFinite(parsed) ? '已经过去' : '不是合法 ISO 时间'}。`,
        })
        capped.push({ tempId: next.tempId, reason: 'DEADLINE_INVALID' })
        questions.push(
          `「${next.title}」的 deadline「${rawDeadline}」${Number.isFinite(parsed) ? '已经过去' : '不是合法 ISO 时间'}；` +
            '请确认一个未来日期，或明确它已经完成。',
        )
        next = { ...next, deadline: '', confidence: Math.min(next.confidence, 0.5) }
      } else {
        next = { ...next, deadline: new Date(parsed).toISOString() }
      }
    }

    return next
  })

  // L1 ↔ task directory is a program decision: the scan already has the names,
  // and asking the model to copy them is how they came back empty.
  goals = bindL1Paths(goals, directories).goals

  // R3's contract is that "no evidence" is *stated*, not silently defaulted to
  // draft. One aggregate question keeps five task directories from producing
  // five near-identical ones.
  const silentDrafts = goals.filter(
    (goal) =>
      goal.depth === 1 &&
      goal.status === 'draft' &&
      goal.statusBasis === 'none' &&
      !/(?:无|没有|缺乏)完成证据|完成状态未知|无法判断是否完成/.test(goal.derivation),
  )
  if (silentDrafts.length > 0) {
    questions.push(
      `以下任务级目标没有完成状态证据，已按「未判定」处理而不是「未开始」：` +
        `${silentDrafts.map((goal) => `「${goal.title}」`).join('、')}。` +
        '请在 derivation 里写明「无完成证据」，或补充文件/会话依据。',
    )
  }

  const l1WithoutPaths = goals.filter((goal) => goal.depth === 1 && goal.paths.length === 0)
  if (l1WithoutPaths.length > 0) {
    questions.push(
      `以下 L1 没有绑定任务目录：${l1WithoutPaths.map((goal) => `「${goal.title}」`).join('、')}。` +
        '若它对应某个目录，请把相对路径补进 paths；否则路径归属判断对它是盲的。',
    )
  }
  const l1WithoutDeadline = goals.filter((goal) => goal.depth === 1 && goal.deadline.length === 0)
  if (l1WithoutDeadline.length > 0) {
    questions.push(
      `以下 L1 没有预期截止时间：${l1WithoutDeadline.map((goal) => `「${goal.title}」`).join('、')}。` +
        '请向用户确认每个 L1 的预期完成日期；没有基准就无法判断「是否按期」。',
    )
  }

  if (
    context !== undefined &&
    (context.role.trim().length === 0 || isPlaceholderContext(context.role))
  ) {
    questions.push(
      `项目背景尚未确认：role 是「${context.role.trim().length === 0 ? '（空）' : context.role}」。` +
        '请先向用户确认角色、意图与约束，再确认树；否则目标树只是从文件推测的。',
    )
  }

  const passed: DerivedContradiction[] = []
  for (const item of raw.contradictions) {
    const code = contradictionRejection(item)
    if (code === undefined) {
      passed.push(item)
      continue
    }
    rejections.push({
      kind: 'contradiction',
      tempId: item.tempId,
      code,
      message: `「${item.title}」未通过检验：${describeRejection(code)}`,
    })
    // Vague suspicion is still worth asking about, just not worth recording.
    questions.push(
      `我怀疑存在「${item.poleA}」与「${item.poleB}」之间的张力，但${describeRejection(code)}。` +
        '这条要不要保留？',
    )
  }

  // Hierarchy is checked after the per-item gates: a child of a rejected parent
  // has no parent to attach to, so it cannot be kept either.
  const hierarchy = pruneContradictionHierarchy(passed)
  for (const { item, code } of hierarchy.rejected) {
    rejections.push({
      kind: 'contradiction',
      tempId: item.tempId,
      code,
      message: `「${item.title}」未通过检验：${describeRejection(code)}`,
    })
    questions.push(
      `「${item.title}」的父矛盾引用无效：${describeRejection(code)}。` +
        '这条要不要保留为顶层矛盾？',
    )
  }
  const contradictions = hierarchy.kept

  return {
    output: {
      ...raw,
      goals,
      contradictions,
      noContradictionFound: contradictions.length === 0,
    },
    rejections,
    capped,
    questions,
  }
}

// ---------------------------------------------------------------- the prompt

/** Everything the prompt needs. */
export interface DerivationPromptInput {
  materials: MaterialScan
  context: ProjectContext
  /** Prior tree summary, when re-deriving an existing project. */
  priorSummary?: string
  /** Top-level structure read as tasks. Omitted on older callers. */
  directories?: TaskDirectoryView
  /** Session history collected by the plugin process. Omitted when none. */
  sessions?: SessionMaterial
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
export function buildDerivationPrompt(input: DerivationPromptInput): string {
  const { materials, context, priorSummary, directories, sessions } = input
  const titles = renderTitles(materials, 60)

  const directoryBlock =
    directories === undefined
      ? ''
      : `## 任务级目录（扫描得到的结构）\n\n${renderTaskDirectories(directories)}\n`
  const sessionBlock =
    sessions === undefined
      ? ''
      : `## 会话历史（插件进程预先收集，你看不到其它会话数据）\n\n${renderSessionEvidence(sessions)}\n`

  const contextBlock = [
    `角色：${context.role || '(未提供)'}`,
    `意图：${context.intent || '(未提供)'}`,
    context.constraints.length > 0 ? `约束：${context.constraints.join('；')}` : '约束：(未提供)',
    context.stakeholders.length > 0
      ? `相关方：${context.stakeholders.join('；')}`
      : '相关方：(未提供)',
  ].join('\n')

  const priorBlock =
    priorSummary === undefined
      ? ''
      : `## 已有结构\n\n${priorSummary}\n\n请在此基础上更新，而不是从零重来。\n`

  return `你在为一个项目推导它的目标层级与结构性矛盾。

## 先分清三个概念

**目标**：想达成的状态。判断方法——能否说出"达成时，世界哪里不一样了"。说不出就不是目标。
常见误判：「完成这个项目」是容器不是目的；「写一份报告」是手段不是目标。

**矛盾**：阻止目标达成的结构性张力。两个条件同时成立才算：
(a) 不会因为努力一点而消失——努力是沿着当前路径加速，而它卡在路径本身；
(b) 缓解它必须付出另一边的代价——没有免费解法，只有取舍。
判断方法——能否说出"如果不处理，哪个目标会先受阻，受阻的具体表现是什么"。

**活动**：正在做的事。既不是目标也不是矛盾。

注意：**约束不等于矛盾**。预算、截止、人手是环境事实；只有当它与某个目标具体冲突时才构成矛盾。

## 已知背景

${contextBlock}

这一层不能省。只看文件能知道"在做什么"，推不出"为什么重要"。如果下面的材料与背景信息冲突，以背景为准，并在 openQuestions 里说明。

${priorBlock}
${directoryBlock}
${sessionBlock}
## 材料清单（只有标题，没有内容）

${titles}

上面是**文件名清单**，不是内容。请自己判断哪些值得读，再用 read 打开。

选择依据：
- 项目说明、任务书、需求文档：优先，它们直接写明了目的。
- 结果类文件（检查报告、评估表、索引）：矛盾藏在里面，值得看。
- 代码：通常不必读，除非要确认某个流程是否真的存在。
- 原始数据一律不读，只用来判断规模。
- 自动命名的文件（未命名/新建/副本）默认跳过，除非你断定它重要。

读多少由你判断——需要的都读，不需要的别读。
准确性优先于节省，但也不要为了「看全」而漫游。

停下来的标准，看这个项目的矛盾藏在哪里：

- 若项目主要产出文档、方案、报告：矛盾往往藏在**重复与分叉**里——
  同名的几份并存、版本号混乱、内容高度重合却各自维护。
  这类问题单读一份看不出，必须横向比对同类文件。
  读完的标准是「能说出哪几份在互相重复、哪一份是当前的」。

- 若项目主要产出代码或数据：矛盾往往藏在**结果与约束**里——
  检查报告中的异常、指标与产能的失衡、规则与实际执行脱节。
  读完的标准是「能回答这个项目为什么存在、什么在阻碍它」。

两者都不需要读完所有文件。

## 任务

1. 判断哪些文件值得读，读它们。记录读了什么、为什么读。
2. 推导目标层级：
   - 根目标是这个项目**存在的理由**，不是项目名称。
   - 如果一个目标只是另一个的实现手段，它应该更深一层。
   - 深度由内容决定。不要为凑层数拆分，也不要为省事合并。
   - depth 0 只能有一个。相邻深度的粒度应当大致均匀。
   - 允许跨层（父子相差超过 1），但必须在 derivation 里说明中间那层为什么是
     隐含的——跨层是有依据的省略，不是图省事。
   - 没有子节点的目标，successCriteria 必须具体到可验证；做不到就说明它其实
     还不是一个可执行的目标，应当继续往下拆。
   - **每个目标都必须填 relevantActivities，至少一条。** 这是监控判断「某个活动
     是否服务于这个目标」的唯一依据：successCriteria 说明目标何时算完成，它不参与
     匹配。写的是活动摘要里会出现的短词，不是完整句子。
   - 拿不准时宁可写宽一点（「插件开发」而不是「实现 analysis/derive.ts 的 schema」），
     判据太窄会把正常工作判成偏离。allowedMethods 同理，写工具或技术栈名。
   - **如果上面列出了 N 个任务级目录，L1 目标数量原则上等于 N：每个目录一个目标。**
     目录名就是任务的常见命名，L1 标题可以沿用目录名。若你认为某些目录应当合并、或某个
     目录不应成为目标，**只能写进 openQuestions 说明理由，不得默默合并或丢弃**——
     用户看到的树必须能回答「这个工作区里到底有几件事」。
   - **每个 L1 若对应一个任务级目录，把该目录的相对路径写进 paths**；更深层可以继承或
     细化。paths 必须是相对路径且真实存在，不要写绝对路径、盘符或 ..。
   - **deadline 只在材料里有明确日期时填 ISO 时间**（例如换届会议 2026-11-07）；没有
     证据就留空，并把「该 L1 的预期截止时间」写进 openQuestions 问用户，不要编日期，
     也不要因为没问到就不提。
   - 每个目标的 derivation 必须引用具体事实。如果只能写"文档里这么写的"，说明你在
     转录标题，请重新考虑。**但从目录结构、文件计数得出的事实不算转录**——例如
     「系庆ppt/ 目录下有 38 个文件，其中 12 个是 pptx，最新改动 9 月」就是结构性依据，
     应当直接写进 derivation，并在 evidence 里给出路径或计数。
   - **每个任务级目标（L1）必须给出完成状态**，不许一律写 draft：
     status（draft/active/at_risk/blocked/done/deprecated）、statusBasis
     （deliverable/session/mtime/none）、statusEvidence（具体文件名/会话标题/日期）。
     判断顺序：目录里有定稿、final、已提交、交付、v12 这类版本收敛文件 → done；
     会话内容明确说已完成 → done；只有 mtime 超过 30 天没动 → 只能算弱证据，写 mtime；
     什么证据都没有 → status=draft、statusBasis=none，**并在 derivation 里写明
     「无完成证据」**，绝不能默认当成没开始。
3. 识别矛盾，来源必须是具体约束：规则失效、资源不足、时间压力、技术限制、
   人员冲突、信息缺失。
   - 每条要写明：阻碍哪个目标、不解决的具体后果。
   - 矛盾可以分层：一个根本张力下面可以挂它具体的表现形式（例如「规则与实际执行
     脱节」下面挂「两份清单各维护一套字段」），用 parentTempId 指向父矛盾的 tempId。
     顶层矛盾留空字符串。深度不限，也不要求与目标层级对应——按内容的从属关系组织，
     不要为凑层级拆分，也不要为了省事把从属关系压平。
   - 不要用"A vs B"式的字面对立充数。
   - **若确实没有结构性矛盾，返回 noContradictionFound: true。这是合法结果，
     强凑一条假张力会让后续所有判断都建立在错误前提上。**
4. 单独给出 projectProfile —— 项目背景，不是用户背景。它回答"这个工作区是什么"，
   而不是"用户想要什么"：
   - summary：这是什么项目、在做哪几件事，一两句话。
   - stage：现在处于哪个阶段，依据是什么（谁的节点先到、什么还没开始）。
   - deliverables：要交付什么、交给谁。
   这份背景只能从文档里读，读不出来就留空并在 openQuestions 里说明，
   不要用常识补。
5. 有多个合理解读时，写进 alternative 与 openQuestions，交给用户判断。

只返回符合 schema 的 JSON。`
}

// ---------------------------------------------------------------- invocation

/** What happened when derivation was attempted. */
export type DerivationOutcome =
  | { readonly status: 'ok'; readonly review: DerivationReview; readonly usage: DerivationUsage }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string }

/** Bookkeeping the caller can log and report. */
export interface DerivationUsage {
  readonly provider: string
  readonly childId: string
  readonly stopReason: string
  /** Wall-clock milliseconds for the whole activation. */
  readonly elapsedMs: number
  /** Total characters in the prompt, a proxy for input size. */
  readonly promptChars: number
  /** Characters in the model's textual output. */
  readonly outputChars: number
}

/** Everything derivation needs from the host. */
export interface DeriveOptions {
  readonly ctx: HostContext
  readonly prompt: string
  /** Working directory handed to the child so it can read project files. */
  readonly cwd: string
  /** User background; a placeholder role becomes an open question. */
  readonly context?: ProjectContext
  /** Task directories from the scan, used for programmatic L1 path binding. */
  readonly directories?: TaskDirectoryView
  readonly timeoutMs?: number
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
export async function deriveWithSubagent(
  options: DeriveOptions,
): Promise<DerivationOutcome> {
  try {
    return await runDerivation(options)
  } catch (error) {
    // The whole path is wrapped because a plugin reload can leave `lib/` in a
    // half-written state for a moment: a module imported mid-rebuild resolves
    // against a stale export map and throws ESM link errors rather than
    // returning anything. That is a transient environment condition, not a
    // logic bug, so it must degrade like any other unavailability instead of
    // taking the tool call down.
    return {
      status: 'failed',
      reason:
        'derivation aborted by an unexpected error ' +
        `(possibly a module reload in progress): ${String(error)}`,
    }
  }
}

/** The real body, separated so the outer wrapper can catch anything. */
async function runDerivation(options: DeriveOptions): Promise<DerivationOutcome> {
  const { ctx, prompt, cwd } = options
  const subagents = ctx.get('subagents')
  if (subagents === undefined) {
    return { status: 'unavailable', reason: 'host does not provide the subagents service' }
  }

  let providers: string[] = []
  try {
    providers = subagents.list()
  } catch (error) {
    return { status: 'unavailable', reason: `subagents.list() failed: ${String(error)}` }
  }
  const provider = providers[0]
  if (provider === undefined) {
    return { status: 'unavailable', reason: 'no subagent provider is registered' }
  }

  const maxDepth = subagents.resolveMaxDepth?.(undefined)
  if (maxDepth !== undefined && maxDepth <= 1) {
    return {
      status: 'unavailable',
      reason:
        `subagent nesting limit is ${maxDepth}; ` +
        'a plugin-initiated child would exceed it',
    }
  }

  const agents = ctx.get('agents')
  const parent: HostAgent | undefined = agents?.currentInitiator()
  if (parent === undefined) {
    return {
      status: 'unavailable',
      reason: 'no initiating agent in this call chain; derivation must run inside a tool call',
    }
  }

  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? 180_000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()

  try {
    const activation = await subagents.startActivation({
      provider,
      label: 'metacog-derivation',
      request: {
        prompt: [{ type: 'text', text: prompt }],
        parent,
        outputSchema: DERIVATION_JSON_SCHEMA as unknown as Record<string, unknown>,
        cwd,
      },
      signal: controller.signal,
      delivery: 'caller',
    })

    try {
      const result = await activation.result
      const elapsedMs = Date.now() - startedAt
      const outputText = (result.output ?? []).map((b) => b.text).join(' ')

      if (result.stopReason !== 'completed') {
        return {
          status: 'failed',
          reason:
            `subagent stopped with "${result.stopReason}" after ${elapsedMs}ms` +
            (result.diagnostic === undefined ? '' : `: ${result.diagnostic}`),
        }
      }
      if (result.structured === undefined) {
        return {
          status: 'failed',
          reason:
            'the provider returned no structured output; it may not support outputSchema. ' +
            'Falling back requires the two-step path.',
        }
      }

      const parsed = DerivationOutputSchema.safeParse(result.structured)
      if (!parsed.success) {
        return {
          status: 'failed',
          reason:
            'structured output did not match the schema: ' +
            parsed.error.message.slice(0, 300),
        }
      }

      return {
        status: 'ok',
        review: reviewDerivation(parsed.data, options.context, options.cwd, options.directories),
        usage: {
          provider,
          childId: activation.childId,
          stopReason: result.stopReason,
          elapsedMs,
          promptChars: prompt.length,
          outputChars: outputText.length,
        },
      }
    } finally {
      await activation.dispose().catch(() => {})
    }
  } catch (error) {
    return { status: 'failed', reason: `startActivation threw: ${String(error)}` }
  } finally {
    clearTimeout(timer)
  }
}
