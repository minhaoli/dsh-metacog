/**
 * The `metacog_revise` tool: the only way the tree changes after confirmation.
 *
 * Wraps {@link applyRevisions} with the persistence and audit obligations any
 * structural change carries. The tool exists as a separate entry point rather
 * than an option on `goal_tree_init` because the two acts are conceptually
 * different: init derives from evidence once, revise records what the user says
 * changed. Merging them would make it easy to re-derive by accident.
 *
 * @module dsh-metacog/tools/revise
 */
import type { ToolDefinition } from '../host.js'
import { GateError } from '../governance.js'
import { ContradictionTypeSchema } from '../data/types.js'
import { applyRevisions, auditActionFor, describeRevision, type RevisionKind, type RevisionRequest } from '../analysis/revise.js'
import { defineMetacogTool, loadProject, type ToolEnvironment } from './shared.js'

/** Kinds the tool accepts, kept in sync with `RevisionKind`. */
const KINDS: RevisionKind[] = [
  'goal_changed',
  'goal_achieved',
  'goal_shelved',
  'contradiction_resolved',
  'contradiction_added',
  'contradiction_intensified',
  'root_changed',
]

/**
 * Register `metacog_revise`.
 *
 * @param env - shared tool environment.
 */
export function metacogReviseTool(env: ToolEnvironment): ToolDefinition {
  return defineMetacogTool({
    name: 'metacog_revise',
    description:
      'Record a change to the confirmed goal or contradiction tree, because the PROJECT changed. ' +
      'Use this when a goal is dropped, achieved or reworded, when a tension is resolved, or when ' +
      'a new constraint appeared — things only the user knows. ' +
      'Do NOT use it because documents were edited: file changes are work progressing, not intent ' +
      'changing, and re-deriving on file changes would invalidate every past alignment judgement. ' +
      'Every revision is versioned and written to the audit log with the stated reason.',
    parameters: {
      type: 'object',
      properties: {
        expectedVersion: {
          type: 'integer',
          description: 'Version read from goal_tree_view.',
        },
        reason: {
          type: 'string',
          description: 'Why the tree is changing. Required and audited.',
        },
        revisions: {
          type: 'array',
          description: 'One or more changes to apply in a single version bump.',
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: KINDS,
                description:
                  'goal_changed / goal_achieved / goal_shelved / contradiction_resolved / ' +
                  'contradiction_added / contradiction_intensified / root_changed',
              },
              target: {
                type: 'string',
                description: 'Goal or contradiction id, or its exact title.',
              },
              newTitle: { type: 'string' },
              newDescription: { type: 'string' },
              paths: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Replacement path prefixes this goal owns, relative to the project root. An ' +
                  'empty array withdraws every claim. Longest prefix wins, so a goal that owns ' +
                  '"src" and another that owns "src/api" both stay meaningful.',
              },
              intensity: {
                type: 'integer',
                description: 'New 1-5 intensity for contradiction revisions.',
              },
              create: {
                type: 'object',
                description: 'Required for contradiction_added.',
                properties: {
                  title: { type: 'string' },
                  poleA: { type: 'string' },
                  poleB: { type: 'string' },
                  type: {
                    type: 'string',
                    enum: [...ContradictionTypeSchema.options],
                  },
                  primaryGoalRef: { type: 'string' },
                  relatedGoalRefs: { type: 'array', items: { type: 'string' } },
                  consequence: { type: 'string' },
                  rationale: {
                    type: 'string',
                    description:
                      'Why the tension is structural — it does not go away by working harder. ' +
                      'Different from consequence, which only states what goes wrong.',
                  },
                  evidence: { type: 'array', items: { type: 'string' } },
                },
                required: ['title', 'poleA', 'poleB', 'primaryGoalRef'],
                additionalProperties: false,
              },
            },
            required: ['kind'],
            additionalProperties: false,
          },
        },
      },
      required: ['expectedVersion', 'reason', 'revisions'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        version: { type: 'number' },
        auditEntryId: { type: 'string' },
        applied: { type: 'array', items: { type: 'string' } },
        changedGoalIds: { type: 'array', items: { type: 'string' } },
        changedContradictionIds: { type: 'array', items: { type: 'string' } },
        skipped: { type: 'array', items: { type: 'object' } },
      },
    },
    async run(args, exec) {
      const input = (args ?? {}) as {
        expectedVersion?: number
        reason?: string
        revisions?: RevisionRequest[]
      }
      if (typeof input.expectedVersion !== 'number') {
        throw new GateError('INVALID_ARGS', 'expectedVersion is required and must be an integer')
      }
      const reason = (input.reason ?? '').trim()
      if (reason.length === 0) {
        throw new GateError(
          'REASON_REQUIRED',
          'a revision must state why the tree is changing; the reason is written to the audit log ' +
            'and is what makes a later "why did the yardstick move" answerable.',
        )
      }
      const revisions = input.revisions ?? []
      if (revisions.length === 0) {
        throw new GateError('INVALID_ARGS', 'revisions must contain at least one change')
      }

      const { projectId, store } = await loadProject(env, exec)
      const state = await store.readState(projectId)
      if (state === undefined || state.confirmed !== true) {
        throw new GateError(
          'NOT_CONFIRMED',
          'there is no confirmed tree to revise. Run goal_tree_init and confirm it first.',
        )
      }

      const now = new Date().toISOString()
      const { goals, contradictions, outcome } = applyRevisions(state, revisions, now)
      if (outcome.changedGoalIds.length === 0 && outcome.changedContradictionIds.length === 0) {
        // Nothing matched, so nothing is committed: a version bump with no change
        // would make the audit log claim a revision that never happened.
        return {
          projectId,
          version: state.version,
          auditEntryId: '',
          applied: [],
          changedGoalIds: [],
          changedContradictionIds: [],
          skipped: outcome.skipped,
        }
      }

      const applied = revisions.map(describeRevision)
      // The audit action has to say what actually changed, otherwise the log
      // records a root-goal rewrite and a contradiction resolution identically
      // as "update_lower_goal" and a later reader cannot tell them apart.
      //
      // A batch may mix kinds, so the action is taken from the first revision
      // that actually took effect; `applied` and `targetIds` carry the detail
      // that one action label cannot.
      const effectiveKind =
        revisions.find((request) => {
          if (request.kind === 'contradiction_added') return outcome.changedContradictionIds.length > 0
          if (request.kind.startsWith('contradiction_')) {
            return (
              request.target !== undefined &&
              outcome.changedContradictionIds.length > 0 &&
              !outcome.skipped.some((skip) => skip.target === request.target)
            )
          }
          return (
            request.target !== undefined &&
            outcome.changedGoalIds.length > 0 &&
            !outcome.skipped.some((skip) => skip.target === request.target)
          )
        })?.kind ?? revisions[0]?.kind ?? 'goal_changed'
      const commit = await store.commit(projectId, {
        expectedVersion: input.expectedVersion,
        goals,
        contradictions,
        reason: `${reason} — ${applied.join('；')}`,
        action: auditActionFor(effectiveKind),
        actor: 'user_confirmed',
        targetIds: [...outcome.changedGoalIds, ...outcome.changedContradictionIds],
        evidence: [],
      })

      return {
        projectId,
        version: commit.state.version,
        auditEntryId: commit.audit.id,
        applied,
        changedGoalIds: outcome.changedGoalIds,
        changedContradictionIds: outcome.changedContradictionIds,
        skipped: outcome.skipped,
      }
    },
  })
}
