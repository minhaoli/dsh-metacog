/**
 * The model-behaviour track: what the assistant is doing to itself.
 *
 * The other five signals watch the *user's* work — does this tool call serve a
 * confirmed goal. This track watches the assistant: is it looping, retrying the
 * same failing command, alternating between two states, or narrating without
 * acting. Those are failure modes that produce no wrong goal judgement at all;
 * the activity is perfectly on-target and simply not going anywhere.
 *
 * Deliberately a separate dimension. Folding a self-loop into `scope` would mean a
 * stalled agent reads as "drifting from the goal", which is a different claim and
 * a wrong one — the work may be exactly on the goal, just stuck.
 *
 * Reference points, as the design doc records:
 *
 * - OpenHands `StuckDetector` for the action-observation loop, the error-retry
 *   loop and the alternating loop;
 * - its monologue rule for narration without an action.
 *
 * The thresholds below are engineering estimates, not calibrated values. Nothing
 * in the recorded stream can calibrate them yet: the feedback channels are dry, so
 * a fitted curve would be fitted to one class.
 *
 * @module dsh-metacog/analysis/signals/behaviour
 */
import type { StepAggregate } from '../../data/signals.js'

/** One tool call and what came back, in the order the host reported them. */
export interface BehaviourStep {
  readonly name: string
  /** A stable digest of the arguments, so "same call" does not need the payload. */
  readonly signature: string
  /** Whether the call failed. `null` when the host did not say. */
  readonly failed: boolean | null
}

/** How many identical calls in a row count as a loop. */
export const REPEAT_THRESHOLD = 3
/** How many identical failures in a row count as a retry loop. */
export const ERROR_STREAK_THRESHOLD = 3
/** How many alternations (A,B,A,B) count as an alternating loop. */
export const ALTERNATING_CYCLES = 3

/** A score in 0..1 with the evidence that produced it. */
export interface BehaviourFinding {
  readonly score: number
  readonly evidence: readonly string[]
}

/**
 * Identical consecutive calls with the same arguments.
 *
 * Three is the smallest count that is not plausibly a legitimate retry: two can be
 * a transient failure, three identical attempts almost never are.
 *
 * @param steps - the turn's calls in order.
 */
export function scoreRepeatRate(steps: readonly BehaviourStep[]): BehaviourFinding | undefined {
  if (steps.length < REPEAT_THRESHOLD) return undefined
  let best = 0
  let run = 1
  let bestName = ''
  for (let index = 1; index < steps.length; index += 1) {
    const previous = steps[index - 1] as BehaviourStep
    const current = steps[index] as BehaviourStep
    // An empty signature means the arguments were never captured. Two of those are
    // not "the same call", they are two calls nobody can compare — counting them as
    // equal reports a loop on data that does not exist, and it is indistinguishable
    // from a real finding once it reaches the report.
    const comparable = previous.signature.length > 0 && current.signature.length > 0
    if (comparable && previous.name === current.name && previous.signature === current.signature) {
      run += 1
      if (run > best) {
        best = run
        bestName = current.name
      }
    } else {
      run = 1
    }
  }
  if (best < REPEAT_THRESHOLD) return undefined
  return {
    // Saturating rather than unbounded: eight identical calls is not twice as bad
    // as four, it is "definitely looping" either way.
    score: Math.min(1, (best - REPEAT_THRESHOLD + 1) / REPEAT_THRESHOLD),
    evidence: [`${bestName} 连续调用 ${best} 次，参数完全相同`],
  }
}

/**
 * Consecutive failures of the same call.
 *
 * A single failure is normal and must never count: every agent retries a transient
 * error once. What this catches is retrying without changing anything.
 *
 * @param steps - the turn's calls in order.
 */
export function scoreErrorStreak(steps: readonly BehaviourStep[]): BehaviourFinding | undefined {
  let best = 0
  let run = 0
  let lastName = ''
  let bestName = ''
  for (const step of steps) {
    if (step.failed === true) {
      run += 1
      if (run > best) {
        best = run
        bestName = step.name
      }
      lastName = step.name
    } else if (step.failed === false) {
      run = 0
      lastName = ''
    }
    // `failed === null` neither continues nor breaks the streak: an unknown
    // outcome is not evidence of a failure, and treating it as one would report a
    // loop on hosts that do not report outcomes at all.
  }
  void lastName
  if (best < ERROR_STREAK_THRESHOLD) return undefined
  return {
    score: Math.min(1, (best - ERROR_STREAK_THRESHOLD + 1) / ERROR_STREAK_THRESHOLD),
    evidence: [`${bestName} 连续失败 ${best} 次，参数没有变化`],
  }
}

/**
 * Two calls alternating: A,B,A,B,A,B.
 *
 * Distinct from a repeat loop because the agent *is* changing something — it just
 * returns to the state it came from, which is the shape of "undo, redo, undo".
 *
 * @param steps - the turn's calls in order.
 */
export function scoreAlternatingLoop(steps: readonly BehaviourStep[]): BehaviourFinding | undefined {
  if (steps.length < ALTERNATING_CYCLES * 2) return undefined
  let best = 0
  for (let start = 0; start + 3 < steps.length; start += 1) {
    const a = steps[start] as BehaviourStep
    const b = steps[start + 1] as BehaviourStep
    // Both members need a signature for the comparison to mean anything; without
    // one, "A,B,A,B" could just be four different calls of two tools.
    if (a.signature.length === 0 || b.signature.length === 0) continue
    // A and B must differ, or this is the repeat case handled above.
    if (a.name === b.name && a.signature === b.signature) continue
    let cycles = 0
    let index = start
    while (index + 1 < steps.length) {
      const left = steps[index] as BehaviourStep
      const right = steps[index + 1] as BehaviourStep
      const leftMatches = left.name === a.name && left.signature === a.signature
      const rightMatches = right.name === b.name && right.signature === b.signature
      if (!leftMatches || !rightMatches) break
      cycles += 1
      index += 2
    }
    if (cycles > best) best = cycles
  }
  if (best < ALTERNATING_CYCLES) return undefined
  return {
    score: Math.min(1, (best - ALTERNATING_CYCLES + 1) / ALTERNATING_CYCLES),
    evidence: [`两组动作交替 ${best} 轮，没有推进`],
  }
}

/**
 * Narration without an action.
 *
 * The turn produced assistant text but no tool call at all. That is not always
 * bad — a final answer looks the same — so this only fires when the turn *also*
 * carried no completion marker, which the caller decides. The signal therefore
 * takes the turn's own verdict rather than guessing from text length.
 *
 * @param hadToolCall - whether any tool ran in this turn.
 * @param claimedCompletion - whether the turn looks like a finished answer.
 */
export function scoreMonologue(
  hadToolCall: boolean,
  claimedCompletion: boolean,
): BehaviourFinding | undefined {
  if (hadToolCall || claimedCompletion) return undefined
  return {
    score: 1,
    evidence: ['整轮只有自述，没有任何工具调用'],
  }
}

