/**
 * Stage G: periodic reports over the recorded stream.
 *
 * A report answers one question: what did this period actually consist of. Not
 * the shape of the goal tree, and not a page of verdicts, but the work itself —
 * which directories were touched, with which actions, producing which files —
 * preceded by the monitor's own numbers. Every line is derived from a stored
 * `ActivityRecord`, `ContradictionObservation`, `DriftSignal`,
 * `InterventionRecord` or `JudgmentRecord`; a file name only appears when an
 * activity's `evidence` entry carried its path.
 *
 * Four rules shape the implementation:
 *
 * - **Facts, not advice.** The body states counts, versions, paths and
 *   decisions. It never tells the reader what to do about them: a report that
 *   recommends is a report whose recommendations rot.
 * - **Monitoring first, activity last.** A reader opens a report to check
 *   whether the monitor is alive and honest, then to see what happened.
 * - **A budget, enforced.** 400 / 600 / 800 prose characters by cadence. A
 *   period holding more than fits loses its least significant activity groups
 *   first and ends with 已截断; an overflow is never silent.
 * - **A date, on disk.** Each report is also written as
 *   `reports/markdown/<type>-<YYYY-MM-DD>.md`, dated by the period end, so the
 *   report is readable without the JSONL store.
 *
 * @module dsh-metacog/report
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname as pathDirname, join } from 'node:path'

import type {
  ActivityRecord,
  AuditLogEntry,
  ContradictionNode,
  ContradictionObservation,
  DriftSignal,
  GeneratedReport,
  GoalNode,
  InterventionRecord,
  JudgmentRecord,
  TreeSnapshot,
  TreeState,
} from './data/types.js'
import type { DeclaredPlan } from './data/signals.js'
import {
  collectAchievements,
  detectDetailTraps,
  easingContradictions,
  summarizeAchievements,
  urgencyOf,
  type Achievement,
  type DetailTrap,
  type ProgressSummary,
} from './analysis/achievements.js'
import type { MetacogStore } from './data/store.js'
import type { MetacogConfig } from './config.js'
import { computeTrend, trendArrow } from './analysis/trend.js'
import { assessRuleCoverage, assessRules } from './analysis/selfaudit.js'
import {
  describeCalibration,
  extractCalibrationSamples,
  fitCalibration,
} from './analysis/calibrate.js'
import { auditCoverage, thresholdProvenance, undecidableReasons } from './analysis/sections.js'
import { collapseCompleted } from './analysis/collapse.js'
import { pendingInterventionHint } from './analysis/escalation.js'

/** Report cadence and the period each covers. */
export type ReportType = 'daily' | 'weekly' | 'monthly'

/** Everything a report generation reads. */
export interface ReportInput {
  readonly store: MetacogStore
  readonly state: TreeState
  readonly projectId: string
  readonly config: MetacogConfig
  readonly type: ReportType
  /** End of the period; defaults to now. */
  readonly now?: Date
  /**
   * Fold completed subtrees in the goal section. Defaults to false.
   *
   * A report is a later look rather than the first one, so folding is allowed
   * here — but it is never the default: a section that shows only one line per
   * finished branch hides how much work it stood for, and the user asked to see
   * every goal before any folding happens.
   */
  readonly collapseDone?: boolean
}

/**
 * Prose budget per cadence, in characters.
 *
 * "Prose" counts every non-whitespace character outside a heading line: the
 * `#` structure and the blank lines between blocks are navigation, not content.
 * Bullets and punctuation do count, which errs on the strict side — the right
 * direction for a cap.
 */
export const REPORT_CHAR_LIMITS: Readonly<Record<ReportType, number>> = {
  daily: 400,
  weekly: 600,
  monthly: 800,
}

/** Appended when the period did not fit. The cap applies to it as well. */
const TRUNCATION_MARKER = '（已截断）'

/** Below this many activities a period cannot support a "repeated pattern" claim. */
const MIN_DRIFT_SAMPLE = 30

/** Width of one activity bucket, per cadence: a day gets six-hour slices, a month weekly ones. */
const WINDOW_HOURS: Readonly<Record<ReportType, number>> = { daily: 6, weekly: 24, monthly: 168 }

/** Human labels for the four activity sources, in the order a report lists them. */
const SOURCE_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['tool_event', '工具'],
  ['user_input', '提问'],
  ['turn', '汇报'],
  ['manual', '手动'],
]

/** Evidence labels that write a file, as opposed to reading one. */
const WRITE_ACTIONS: ReadonlySet<string> = new Set(['write', 'edit', 'multi_edit'])


/** A computed period with its bounds. */
interface Period {
  readonly start: Date
  readonly end: Date
}

/**
 * Resolve the period a report of this cadence covers.
 *
 * The three cadences are *nested calendars*, not three independent rolling
 * windows:
 *
 * - daily covers the day containing `now`;
 * - weekly covers Monday 00:00 through Sunday 23:59 of the week containing
 *   `now`;
 * - monthly covers the first through the last day of the month containing `now`.
 *
 * Calendar boundaries, not "since the last run", because a weekly report is
 * named after its Monday and a monthly after the first: a name that identified a
 * sliding window would stop matching its own contents the moment the next run
 * moved an endpoint. Re-running a report for a period replaces nothing — it
 * re-renders the same period, which is what makes the output reproducible from
 * its own name.
 *
 * A period still in progress ends at `now` rather than at its calendar end, so a
 * report generated on Wednesday does not claim to describe a week that has not
 * happened.
 *
 * @param type - report cadence.
 * @param now - reference instant.
 */
function resolvePeriod(type: ReportType, now: Date): Period {
  if (type === 'monthly') {
    const start = firstOfMonth(now)
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59, 999)
    return { start, end: end.getTime() > now.getTime() ? now : end }
  }
  if (type === 'weekly') {
    const start = mondayOf(now)
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6, 23, 59, 59, 999)
    return { start, end: end.getTime() > now.getTime() ? now : end }
  }
  const start = startOfDay(now)
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 23, 59, 59, 999)
  return { start, end: end.getTime() > now.getTime() ? now : end }
}

/** Filter a stream to the period, by its own timestamp field. */
function inPeriod<T>(items: readonly T[], period: Period, stamp: (item: T) => string): T[] {
  const from = period.start.getTime()
  const to = period.end.getTime()
  return items.filter((item) => {
    const at = Date.parse(stamp(item))
    return !Number.isNaN(at) && at >= from && at <= to
  })
}

/**
 * Count the prose characters in a report.
 *
 * Heading lines are excluded because they are the fixed skeleton, and the
 * marker the truncation path appends does count, so the published number is
 * never larger than the budget.
 *
 * @param markdown - full report body.
 * @returns non-whitespace characters outside heading lines.
 */
export function countReportChars(markdown: string): number {
  let total = 0
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    total += trimmed.replace(/\s+/gu, '').length
  }
  return total
}

/** Two-digit zero padding for local clock and date fragments. */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** `YYYY-MM-DD` in local time: a report is dated by the operator's calendar, not UTC. */
function localDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** `MM-DD` in local time. */
function localMonthDay(date: Date): string {
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** `HH:MM` in local time. */
function localClock(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/**
 * One body line and how bad it is to lose it.
 *
 * `dropRank` orders the budget cuts: the highest rank goes first. A line that
 * carries a section's only fact is `Infinity`; a per-directory detail carries
 * the rank that matches how little it adds to the picture.
 */
interface ReportLine {
  readonly text: string
  readonly dropRank: number
}

/** A heading plus the lines under it. A block whose lines are all cut vanishes whole. */
interface ReportBlock {
  readonly heading: string
  readonly lines: readonly ReportLine[]
}

/** Build one line; most lines are never dropped. */
function line(text: string, dropRank = Number.POSITIVE_INFINITY): ReportLine {
  return { text, dropRank }
}

/**
 * Assemble the document and cut it down to the budget.
 *
 * Dropping is ordered by `dropRank`, so the activity groups with the least work
 * in them go first and the monitor's own numbers survive to the end. When
 * nothing droppable is left — a period whose very first screen is over budget —
 * the tail is cut, because a cap that is sometimes exceeded is not a cap.
 *
 * @param title - `#` heading of the report.
 * @param blocks - body blocks in reading order.
 * @param limit - prose budget.
 * @returns Markdown whose prose never exceeds `limit`.
 */
function composeDocument(title: string, blocks: readonly ReportBlock[], limit: number): string {
  const survivors = blocks.map((block) => block.lines.slice())
  let trimmed = false

  const assemble = (): string => {
    const parts: string[] = [title]
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]
      const kept = survivors[index] ?? []
      if (block === undefined || kept.length === 0) continue
      parts.push('', block.heading, ...kept.map((item) => item.text))
    }
    if (trimmed) parts.push('', TRUNCATION_MARKER)
    return parts.join('\n')
  }

  while (countReportChars(assemble()) > limit) {
    let target: { block: number; index: number; rank: number } | undefined
    for (let blockIndex = 0; blockIndex < survivors.length; blockIndex += 1) {
      const kept = survivors[blockIndex] ?? []
      for (let lineIndex = 0; lineIndex < kept.length; lineIndex += 1) {
        const rank = kept[lineIndex]?.dropRank ?? Number.POSITIVE_INFINITY
        if (rank === Number.POSITIVE_INFINITY) continue
        if (target === undefined || rank > target.rank) {
          target = { block: blockIndex, index: lineIndex, rank }
        }
      }
    }
    if (target === undefined) {
      const body = assemble()
      const excess = countReportChars(body) - limit + TRUNCATION_MARKER.length
      let cut = body.slice(0, Math.max(0, body.length - excess))
      while (cut.length > 0 && countReportChars(`${cut}\n\n${TRUNCATION_MARKER}`) > limit) {
        cut = cut.slice(0, -1)
      }
      return `${cut.trimEnd()}\n\n${TRUNCATION_MARKER}`
    }
    survivors[target.block]?.splice(target.index, 1)
    trimmed = true
  }

  return assemble()
}

/** Split an `evidence` entry into the tool label and the value it recorded. */
function evidenceParts(entry: string): { label: string; value: string } {
  const separator = entry.indexOf(': ')
  if (separator <= 0) return { label: '', value: entry }
  return { label: entry.slice(0, separator), value: entry.slice(separator + 2) }
}

/** An absolute path, with no spaces and no shell punctuation in it. */
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u

/** A slash-separated path that is already relative to the project root. */
const RELATIVE_PATH = /^[\w.\-\u4e00-\u9fff]+(?:[\\/][\w.\-\u4e00-\u9fff]+)+$/u

/** A single file name with an extension, taken as relative to the project root. */
const RELATIVE_FILE = /^[\w.\-\u4e00-\u9fff]+\.[A-Za-z0-9]{1,8}$/u

/**
 * Read a path out of an evidence value, or nothing.
 *
 * The stream stores paths, patterns and prose in the same field, so this is
 * deliberately strict: a path carries no whitespace, which alone rejects
 * `pwsh: node -e '...'` and every `user message:` entry, and a bare word only
 * counts when it looks like a file name. Paths that do contain a space are
 * lost — a report line that quotes half a command as a file name would be
 * worse.
 *
 * @param value - text after the `label: ` prefix.
 */
function pathFromEvidence(value: string): string | undefined {
  const text = value.trim()
  if (text === '' || text.length > 320) return undefined
  if (/\s/u.test(text)) return undefined
  if (ABSOLUTE_PATH.test(text)) return text
  if (RELATIVE_PATH.test(text) || RELATIVE_FILE.test(text)) return text
  return undefined
}

/** Make a recorded path project-relative, or label it as outside the project. */
function relativePath(projectRoot: string, recorded: string): string {
  if (!ABSOLUTE_PATH.test(recorded)) return recorded.replace(/\\/gu, '/')
  const root = projectRoot.replace(/[\\/]+$/u, '')
  for (const separator of ['\\', '/']) {
    const prefix = `${root}${separator}`
    if (recorded.startsWith(prefix)) return recorded.slice(prefix.length).replace(/\\/gu, '/')
  }
  const parts = recorded.split(/[\\/]+/u).filter((part) => part !== '')
  return `外部/${parts.slice(-2).join('/')}`
}

/** The directory of a project-relative path, shortened to its last two segments. */
function shortDirectory(relative: string): string {
  const parts = relative.split('/')
  if (parts.length <= 1) return '根目录'
  const directory = parts.slice(0, -1)
  return directory.length <= 2 ? directory.join('/') : `…/${directory.slice(-2).join('/')}`
}

/** The last segment of a project-relative path. */
function baseNameOf(relative: string): string {
  const parts = relative.split('/')
  return parts[parts.length - 1] ?? relative
}

/** The first absolute Windows path inside a shell command, if there is one. */
const COMMAND_PATH = /[A-Za-z]:[\\/][^\s'";|)]*/u

/**
 * Locate a shell call by the first path its command mentions.
 *
 * A `pwsh` record stores the command, not a file, so without this the busiest
 * bucket in a real period is "no path recorded". The match is deliberately
 * narrow — one absolute path, up to the first quote, space or shell separator —
 * and it only ever names a directory, never a file: a command that reads a path
 * has not produced it.
 *
 * @param value - the command text after `pwsh: `.
 */
function pathInCommand(value: string): string | undefined {
  const match = COMMAND_PATH.exec(value)
  return match?.[0]
}

/** The directory a path denotes, whether the path names a file or a directory. */
function directoryOf(relative: string): string {
  const parts = relative.split('/').filter((part) => part !== '')
  const last = parts[parts.length - 1] ?? ''
  const owner = /\.[A-Za-z0-9]{1,8}$/u.test(last) ? parts.slice(0, -1) : parts
  if (owner.length === 0) return '根目录'
  return owner.length <= 2 ? owner.join('/') : `…/${owner.slice(-2).join('/')}`
}

/** What one activity was, in the vocabulary a report line needs. */
interface ParsedActivity {
  readonly directory: string
  readonly action: string
  readonly files: readonly { readonly name: string; readonly produced: boolean }[]
}

/** The action verb of one activity: its tool, or what kind of turn it was. */
function actionOf(record: ActivityRecord): string {
  if (record.source === 'user_input') return '提问'
  if (record.source === 'turn') return '汇报'
  if (record.source === 'manual') return '手动'
  const head = record.summary.split(' (')[0]?.trim() ?? ''
  return head === '' || head.length > 24 || head.includes(':') ? '工具' : head
}

/**
 * Describe one activity as directory, action and files touched.
 *
 * The directory comes from the first path the evidence carries, so a record is
 * counted once, in one place. `produced` separates a file that was written from
 * one that was only read: both are worth listing, but only the first is output.
 *
 * @param record - stored activity.
 * @param projectRoot - absolute project root, for relativisation.
 */
function parseActivity(record: ActivityRecord, projectRoot: string): ParsedActivity {
  let directory: string | undefined
  let hinted: string | undefined
  const files: { name: string; produced: boolean }[] = []
  for (const entry of record.evidence) {
    const { label, value } = evidenceParts(entry)
    const absolute = pathFromEvidence(value)
    if (absolute === undefined) {
      // A shell command names a place to run, not a file to list.
      if (record.source === 'tool_event') hinted = hinted ?? pathInCommand(value)
      continue
    }
    const relative = relativePath(projectRoot, absolute)
    directory = directory ?? shortDirectory(relative)
    files.push({ name: baseNameOf(relative), produced: WRITE_ACTIONS.has(label) })
  }
  if (directory === undefined && hinted !== undefined) {
    directory = directoryOf(relativePath(projectRoot, hinted))
  }
  const fallback = record.source === 'tool_event' ? '未标路径' : '对话'
  return { directory: directory ?? fallback, action: actionOf(record), files }
}

/** One (time window, directory) pair's worth of work. */
interface ActivityBucket {
  readonly start: number
  readonly directory: string
  count: number
  readonly actions: Map<string, number>
  readonly produced: Set<string>
  readonly touched: Set<string>
}

/** Group activities into (window, directory) buckets. */
function bucketize(
  activities: readonly ActivityRecord[],
  projectRoot: string,
  type: ReportType,
): ActivityBucket[] {
  const width = WINDOW_HOURS[type] * 3_600_000
  const buckets = new Map<string, ActivityBucket>()
  for (const activity of activities) {
    const at = Date.parse(activity.timestamp)
    if (Number.isNaN(at)) continue
    const start = Math.floor(at / width) * width
    const parsed = parseActivity(activity, projectRoot)
    const key = `${start}\u0000${parsed.directory}`
    const bucket = buckets.get(key) ?? {
      start,
      directory: parsed.directory,
      count: 0,
      actions: new Map<string, number>(),
      produced: new Set<string>(),
      touched: new Set<string>(),
    }
    bucket.count += 1
    bucket.actions.set(parsed.action, (bucket.actions.get(parsed.action) ?? 0) + 1)
    for (const file of parsed.files) {
      bucket.touched.add(file.name)
      if (file.produced) bucket.produced.add(file.name)
    }
    buckets.set(key, bucket)
  }
  return [...buckets.values()]
}

/** The time span covered by one bucket. */
function windowLabel(type: ReportType, start: number): string {
  const width = WINDOW_HOURS[type] * 3_600_000
  const from = new Date(start)
  if (type === 'daily') return `${localClock(from)}–${localClock(new Date(start + width))}`
  if (type === 'weekly') return localMonthDay(from)
  return `${localMonthDay(from)}–${localMonthDay(new Date(start + width - 1))}`
}

/** One bucket as a single line: time span, directory, actions, files. */
function describeBucket(type: ReportType, bucket: ActivityBucket): string {
  const actions = [...bucket.actions.entries()].sort((left, right) => right[1] - left[1])
  const shown = actions
    .slice(0, 2)
    .map(([action, count]) => `${action} ${count}`)
    .join('/')
  const extra = actions.length > 2 ? `+${actions.length - 2}` : ''
  // Written files are the output; when nothing was written, the files read are
  // the only path the record carries and still answer "what was touched".
  const files = bucket.produced.size > 0 ? [...bucket.produced] : [...bucket.touched]
  const listing = files.slice(0, 3).join('、')
  const more = files.length > 3 ? ` 等 ${files.length} 个` : ''
  const filesPart = listing === '' ? '' : `：${listing}${more}`
  return `- ${windowLabel(type, bucket.start)} ${bucket.directory}（${bucket.count} 次：${shown}${extra}）${filesPart}`
}

/**
 * Name the tensions pressing on one goal, strongest first.
 *
 * The contradiction section already lists every tension; repeating them here is
 * the point — a goal row that says "12 activities" without saying "and one core
 * tension is holding it back" describes effort, not pressure. Only unresolved
 * tensions count, and membership is the same relation the weighting uses:
 * primary goal or a related link.
 *
 * @param goalId - goal whose tensions are wanted.
 * @param facts - the period's facts.
 * @returns one `标题（强度 N）` note, or `undefined` when nothing presses.
 */
function goalContradictionNote(goalId: string, facts: ReportFacts): string | undefined {
  const nodes = facts.state.contradictions.filter(
    (node) =>
      node.resolvedAt === undefined &&
      (node.primaryGoalId === goalId || node.relatedGoalIds.includes(goalId)),
  )
  if (nodes.length === 0) return undefined
  const sorted = [...nodes].sort((left, right) => (right.intensity ?? 0) - (left.intensity ?? 0))
  return sorted
    .map(
      (node) =>
        `${node.title}（${node.intensity === null ? '强度未测量' : `强度 ${node.intensity}`}）`,
    )
    .join('；')
}

/**
 * Group the period's activity by goal, rather than by directory.
 *
 * The directory view answers "where did the work happen"; this one answers "which
 * goal did it serve", which is the question a person actually asks of a period.
 * A goal tree whose entries never accumulate effort is a tree nobody is using.
 *
 * Attribution comes from `candidateGoalIds` and nothing else. There is no heuristic
 * that re-derives it here: an activity the aligner did not attribute is reported as
 * unattributed, because guessing would make the totals look tidier than the
 * evidence supports. The unattributed line is printed rather than omitted — a
 * report that silently drops part of the work is worse than one that admits it does
 * not know where that work went.
 *
 * @param facts - the period's facts.
 * @param collapseDone - fold subtrees whose goals are all done into one summary
 *   line. Defaults to false: the section lists every goal with activity until a
 *   caller asks otherwise, and a done goal is merely marked.
 * @returns a block; empty lines when there was no activity at all.
 */
function goalActivityBlock(facts: ReportFacts, collapseDone = false): ReportBlock | undefined {
  const total = facts.activities.length
  if (total === 0) return undefined

  const goals = new Map(facts.state.goals.map((goal) => [goal.id, goal]))
  const counts = new Map<string, number>()
  let unattributed = 0

  for (const activity of facts.activities) {
    const known = activity.candidateGoalIds.filter((id) => goals.has(id))
    if (known.length === 0) {
      unattributed += 1
      continue
    }
    // An activity naming several goals counts once for each: the question is "how
    // much of the work touched this goal", not "which goal owns it".
    for (const id of known) counts.set(id, (counts.get(id) ?? 0) + 1)
  }

  if (counts.size === 0 && unattributed === 0) return undefined

  // A folded group replaces its descendants with one row, and that row carries
  // their activity: the section is about how much work a branch absorbed, so
  // dropping the children's counts along with their lines would understate it.
  const view = collapseCompleted(facts.state.goals, { collapseDone })
  const collapsedByParent = new Map(
    view.groups.filter((group) => group.collapsed).map((group) => [group.id, group] as const),
  )
  const foldedUnder = new Map<string, (typeof view.groups)[number]>()
  for (const group of view.groups) {
    if (!group.collapsed) continue
    for (const node of group.descendants) foldedUnder.set(node.id, group)
  }
  const foldedTotals = new Map<string, number>()
  if (foldedUnder.size > 0) {
    for (const [id, count] of counts) {
      const group = foldedUnder.get(id)
      if (group === undefined) continue
      foldedTotals.set(group.id, (foldedTotals.get(group.id) ?? 0) + count)
    }
  }

  const rows: { goal: GoalNode; count: number; folded: number }[] = []
  for (const [id, count] of counts) {
    if (collapsedByParent.has(id)) continue
    const group = foldedUnder.get(id)
    if (group !== undefined) continue
    const goal = goals.get(id)
    if (goal === undefined) continue
    rows.push({ goal, count, folded: 0 })
  }
  for (const group of collapsedByParent.values()) {
    const own = counts.get(group.parent.id) ?? 0
    const aggregated = (foldedTotals.get(group.id) ?? 0) + own
    if (aggregated === 0) continue
    rows.push({
      goal: group.parent as GoalNode,
      count: aggregated,
      folded: group.descendants.length,
    })
  }
  rows.sort((left, right) => right.count - left.count)

  const lines: ReportLine[] = []
  const pushGoalNote = (goal: GoalNode): void => {
    const note = goalContradictionNote(goal.id, facts)
    // Rank 9: the note is context under the row, so it goes before the row and
    // before the unattributed summary when the prose budget has to cut.
    if (note !== undefined) lines.push(line(`  - 相关矛盾：${note}`, 9))
  }
  for (const { goal, count, folded } of rows.slice(0, 6)) {
    const share = ((count / total) * 100).toFixed(0)
    if (folded > 0) {
      lines.push(
        line(`- ${goal.title}（depth-${goal.depth}）：已完成 ${folded} 个子目标，合计 ${count} 条，占 ${share}%`),
      )
      pushGoalNote(goal)
      continue
    }
    const status = goal.status === 'done' ? '（已完成）' : ''
    lines.push(line(`- ${goal.title}（depth-${goal.depth}）：${count} 条，占 ${share}%${status}`))
    pushGoalNote(goal)
  }

  if (unattributed > 0) {
    const share = ((unattributed / total) * 100).toFixed(0)
    lines.push(
      line(`- 未归属到任何目标：${unattributed} 条，占 ${share}%`, 8),
    )
  }

  return { heading: '## 按目标看活动', lines }
}

/**
 * The activity section: what the period was made of.
 *
 * The summary line is never dropped — it is the one line that stays true no
 * matter how much detail the budget allows. Buckets are ranked by volume for
 * dropping but displayed in chronological order, so cutting the tail never
 * scrambles the story the surviving lines tell.
 */
function activityLines(facts: ReportFacts, type: ReportType, projectRoot: string): ReportLine[] {
  const total = facts.activities.length
  if (total === 0) return [line('- 本期没有记录到活动')]

  const sources = new Map<string, number>()
  for (const activity of facts.activities) {
    sources.set(activity.source, (sources.get(activity.source) ?? 0) + 1)
  }
  const sourceParts: string[] = []
  for (const [source, label] of SOURCE_LABELS) {
    const count = sources.get(source) ?? 0
    if (count > 0) sourceParts.push(`${label} ${count}`)
  }

  const buckets = bucketize(facts.activities, projectRoot, type)
  const directories = new Set(buckets.map((bucket) => bucket.directory))
  const files = new Set(buckets.flatMap((bucket) => [...bucket.touched]))
  const summary =
    `- 本期 ${total} 条活动（${sourceParts.join('、')}），` +
    `涉及 ${directories.size} 个目录、${files.size} 个文件`

  const byVolume = [...buckets].sort((left, right) => right.count - left.count || left.start - right.start)
  const rank = new Map<ActivityBucket, number>()
  byVolume.forEach((bucket, index) => {
    rank.set(bucket, index + 1)
  })

  const chronological = [...buckets].sort(
    (left, right) =>
      left.start - right.start ||
      right.count - left.count ||
      left.directory.localeCompare(right.directory),
  )
  return [
    line(summary),
    ...chronological.map((bucket) => line(describeBucket(type, bucket), rank.get(bucket) ?? 1)),
  ]
}

/**
 * Is the period's opening a tree that already existed?
 *
 * A month that starts at the moment the tree was built has nothing to compare
 * against, and a report that says "the root goal did not change" without saying
 * so is technically true and practically useless.
 */
function computeMovement(snapshotStart: TreeSnapshot | undefined, state: TreeState): Movement {
  if (snapshotStart === undefined) {
    return { hasBaseline: false, versionBefore: state.version, added: 0, removed: 0, completed: 0, deprecated: 0 }
  }
  const before = new Map(snapshotStart.goals.map((goal) => [goal.id, goal]))
  const after = new Map(state.goals.map((goal) => [goal.id, goal]))
  return {
    hasBaseline: true,
    versionBefore: snapshotStart.version,
    added: [...after.keys()].filter((id) => !before.has(id)).length,
    removed: [...before.keys()].filter((id) => !after.has(id)).length,
    completed: [...after.values()].filter(
      (goal) => goal.status === 'done' && before.get(goal.id)?.status !== 'done',
    ).length,
    deprecated: [...after.values()].filter(
      (goal) => goal.status === 'deprecated' && before.get(goal.id)?.status !== 'deprecated',
    ).length,
  }
}

/** Alignment decision counts, every key present. */
interface DecisionCounts {
  aligned: number
  exploratory: number
  scope_drift: number
  uncertain: number
  /**
   * Activities no goal claimed by path.
   *
   * Counted apart from `uncertain` because the two answer different questions:
   * `uncertain` is "there was not enough to judge", `unbound` is "the tree has
   * no claim on this". Folding them would hide the one number a reader needs to
   * decide whether the tree should register more `paths`.
   */
  unbound: number
}

/** Count activities by alignment decision. */
function decisionCounts(activities: readonly ActivityRecord[]): DecisionCounts {
  const counts: DecisionCounts = { aligned: 0, exploratory: 0, scope_drift: 0, uncertain: 0, unbound: 0 }
  for (const activity of activities) {
    counts[activity.decision] = (counts[activity.decision] ?? 0) + 1
  }
  return counts
}

/**
 * What the monitor itself did this period.
 *
 * Two counters and a decision breakdown, because a reader's first question is
 * whether the thing is watching and whether its opinion survived review. The
 * four v3 sections follow as their own one-line blocks.
 */
function monitorLines(facts: ReportFacts): ReportLine[] {
  const total = facts.activities.length
  const lines: ReportLine[] = []
  if (total === 0) {
    lines.push(line('- 本期没有记录到活动，监控处于空闲'))
  } else {
    const counts = decisionCounts(facts.activities)
    lines.push(
      line(
        `- 判定 ${total} 条：偏离 ${counts.scope_drift}、探索 ${counts.exploratory}、` +
          `待定 ${counts.uncertain}、对齐 ${counts.aligned}、未归属 ${counts.unbound}`,
      ),
    )
  }

  const candidates = facts.candidates
  if (candidates.length === 0) {
    lines.push(line('- 本期没有新的漂移候选'))
  } else {
    const settled = candidates.filter((item) => item.status !== 'pending')
    const dismissed = settled.filter((item) => item.status === 'dismissed').length
    const confirmed = settled.length - dismissed
    lines.push(
      line(
        `- 本期候选 ${candidates.length} 条：已复核 ${settled.length}（确认 ${confirmed}、驳回 ${dismissed}），` +
          `待复核 ${candidates.length - settled.length}`,
      ),
    )
  }
  return lines
}

/**
 * The calibration section: measured, not a placeholder.
 *
 * It used to sit in {@link PENDING_SECTIONS} as "本期未启用". Once
 * `analysis/calibrate.ts` could actually measure the realised rate, that string
 * became a false statement — the measurement existed and simply was not being
 * reported. The section now says one of two true things: a fitted curve with its
 * reliability table, or an explicit refusal naming which class is missing.
 *
 * It is kept separate from the pending list because the pending list means "this
 * plugin cannot compute this at all", and that stops being true here.
 *
 * @param facts - the period's facts, for the judgement log.
 */
function calibrationBlock(facts: ReportFacts): ReportBlock {
  const samples = extractCalibrationSamples(facts.judgments)
  const outcome = fitCalibration(samples)
  return {
    heading: '### 校准状态',
    lines: [line(`- ${describeCalibration(outcome, samples)}`)],
  }
}

/**
 * The three sections that used to print "not enabled".
 *
 * Two are now computed from data already in the store; the third keeps an honest
 * refusal because the number genuinely cannot be derived yet. The distinction the
 * text must preserve: "not enough data" and "nothing happened" are different
 * facts, and only the first is a gap in the monitor.
 *
 * @param facts - the period's facts.
 */
function evidenceBlocks(facts: ReportFacts): ReportBlock[] {
  const coverage = auditCoverage(facts.activities, facts.candidates)
  const reasons = undecidableReasons(facts.judgments)
  const samples = extractCalibrationSamples(facts.judgments)
  const provenance = thresholdProvenance(false, samples.length)

  const coverageLines =
    coverage.recorded === 0
      ? [line('- 本期没有记录到活动，没有可审计的对象')]
      : [
          line(
            `- 记录 ${coverage.recorded} 条活动，其中 ${coverage.reviewed} 条进入过判定（${Math.round(coverage.share * 100)}%）`,
          ),
          line(`- 另有 ${coverage.undecided} 条判定仍在等待复核`),
          // The stratified sample is the only route to a positive training sample:
          // the model rejects nearly everything, so "wait for confirmations" never
          // produces one. Printing the count is what makes the mechanism visible
          // rather than theoretical.
          line(`- 分层抽样：${coverage.sampleNote}`),
        ]

  const reasonLines =
    reasons.rows.length === 0
      ? [
          line(
            reasons.settled === 0
              ? '- 本期没有已结算的判定，还统计不出驳回原因'
              : `- ${reasons.settled} 条已结算，但都没有记录原因（字段 modelWhy 缺失）`,
          ),
        ]
      : reasons.rows
          .slice(0, 6)
          .map((row) => line(`- ${row.why}：${row.count} 条（${Math.round(row.share * 100)}%）`))
          .concat(
            reasons.unlabelled > 0 ? [line(`- 另有 ${reasons.unlabelled} 条已结算但未记录原因`)] : [],
          )

  return [
    { heading: '### 审计覆盖率', lines: coverageLines },
    { heading: '### undecidable 四因占比', lines: reasonLines },
    { heading: '### 阈值验证方式', lines: [line(`- ${provenance.note}`)] },
  ]
}

/**
 * State which lower-cadence reports this one is built on.
 *
 * A weekly or monthly report that silently invents its own conclusions is
 * indistinguishable from one that read the days underneath it, and the two can
 * disagree. Naming the sources makes that checkable by eye: if the week lists
 * three days and you worked five, the days are missing and you can see it.
 *
 * Returns nothing for a daily report, which has no sources by definition.
 *
 * @param facts - the period's facts, carrying the source records.
 */
function sourcesBlock(facts: ReportFacts): ReportBlock | undefined {
  if (facts.sources.length === 0) {
    // A weekly or monthly report with no siblings is not an error — nobody has
    // generated the days yet — but saying so prevents it reading as complete.
    return undefined
  }
  const dates = facts.sources
    .map((record) => localDate(new Date(record.periodStart)))
    .sort()
  const shown = dates.slice(0, 8).join('、')
  const rest = dates.length > 8 ? ` 等 ${dates.length} 份` : ''
  return {
    heading: '### 汇总来源',
    lines: [line(`- 基于 ${dates.length} 份下级报告：${shown}${rest}`)],
  }
}

/** Structural movement since the period's opening snapshot. */
function structureLines(facts: ReportFacts): ReportLine[] {
  const movement = facts.movement
  if (!movement.hasBaseline) {
    // The L0 line carries the reason (a first period, or a pruned history);
    // repeating it here would say the same absence twice.
    return [line(`- 本期无更早的树快照可对比（当前版本 ${facts.state.version}）`)]
  }
  const version = `树版本 ${movement.versionBefore} → ${facts.state.version}`
  const moved = movement.added + movement.removed + movement.completed + movement.deprecated
  if (moved === 0) return [line(`- ${version}：无节点新增、移除或完成`)]
  const parts: string[] = []
  if (movement.added > 0) parts.push(`新增 ${movement.added}`)
  if (movement.removed > 0) parts.push(`移除 ${movement.removed}`)
  if (movement.completed > 0) parts.push(`完成 ${movement.completed}`)
  if (movement.deprecated > 0) parts.push(`废弃 ${movement.deprecated}`)
  return [line(`- ${version}：${parts.join('、')}`)]
}

/**
 * Why this period has no structural baseline, or `undefined` when it has one.
 *
 * Missing snapshots alone do not prove the tree was built during the period —
 * they can just mean the history was pruned — so the tree's own creation stamp
 * decides which sentence is honest.
 */
function baselineNote(facts: ReportFacts, period: Period): string | undefined {
  if (facts.movement.hasBaseline) return undefined
  const created = Date.parse(facts.state.createdAt)
  return !Number.isNaN(created) && created >= period.start.getTime()
    ? '本期起点即建树时刻，无对比基线'
    : '本期无更早快照，无对比基线'
}

/** Root-goal change, with the caveat that a first month has no baseline. */
function rootGoalLines(facts: ReportFacts, period: Period): ReportLine[] {
  const changes = facts.audits.filter(
    (entry) =>
      entry.action === 'update_l0' &&
      inPeriod([entry], period, (item) => item.timestamp).length > 0,
  )
  if (changes.length > 0) {
    const reasons = [...new Set(changes.map((entry) => entry.reason).filter((reason) => reason !== ''))]
    const tail = reasons.length === 0 ? '' : `：${reasons.slice(0, 2).join('；')}`
    return [line(`- 根目标本期变更 ${changes.length} 次${tail}`)]
  }
  const note = baselineNote(facts, period)
  return [line(note === undefined ? '- 根目标本期未变更' : `- 根目标本期未变更；${note}`)]
}

/** How many of the period's top-level goals are still in the tree. */
function survivalLines(facts: ReportFacts): ReportLine[] {
  const strategic = facts.initialStrategic
  if (strategic.length === 0) return [line('- 期初没有已确认的第 1 层目标')]
  const alive = strategic.filter((goal) => facts.state.goals.some((now) => now.id === goal.id)).length
  const done = strategic.filter(
    (goal) => facts.state.goals.find((now) => now.id === goal.id)?.status === 'done',
  ).length
  return [line(`- 第 1 层（期初 ${strategic.length} 个）：${alive} 个仍在树中，${done} 个已完成`)]
}

/**
 * Core-contradiction management, one line per tension.
 *
 * An empty month is stated once: "no observation" and "no related intervention"
 * are the same absence counted twice, so a core node with neither gets a single
 * phrase. A `core_bypass` count of zero is not a finding and does not get a line
 * of its own — the absence already appears in the observation count.
 */
function coreLines(facts: ReportFacts): ReportLine[] {
  const nodes = facts.state.contradictions.filter(
    (node) => node.type === 'core' && node.confirmedByUser,
  )
  const lines: ReportLine[] = []
  if (nodes.length === 0) {
    lines.push(line('- 尚未确认核心矛盾'))
  } else {
    for (const node of nodes) {
      const observations = facts.observations.filter((item) => item.contradictionId === node.id)
      const related = facts.interventions.filter((record) =>
        facts.signals.some(
          (signal) =>
            signal.id === record.signalId && signal.relatedContradictionIds.includes(node.id),
        ),
      )
      if (observations.length === 0 && related.length === 0) {
        lines.push(line(`- core「${node.title}」：本期无观察与干预记录`))
        continue
      }
      const parts: string[] = []
      const intensities = observations
        .map((item) => item.intensity)
        .filter((value): value is number => value !== null)
      if (observations.length === 0) {
        parts.push('本期无观察')
      } else if (intensities.length === 0) {
        parts.push(`${observations.length} 次观察（强度未记录）`)
      } else {
        parts.push(
          `${observations.length} 次观察，强度 ${intensities[0]}→${intensities[intensities.length - 1]}`,
        )
      }
      parts.push(related.length === 0 ? '无关联干预' : `关联干预 ${related.length} 次`)
      lines.push(line(`- core「${node.title}」：${parts.join('；')}`))
    }
  }

  const bypasses = facts.signals.filter((signal) => signal.signalType === 'core_bypass').length
  if (bypasses > 0) lines.push(line(`- core_bypass 信号 ${bypasses} 次`))
  return lines
}

/**
 * Repeated drift, only where the sample can carry the claim.
 *
 * Twelve activities and five of them off scope is not a pattern; it is a small
 * dataset. Below {@link MIN_DRIFT_SAMPLE} the report says so instead of
 * printing a ratio that reads like a finding.
 */
function repeatedDriftLines(facts: ReportFacts, projectRoot: string): ReportLine[] {
  const total = facts.activities.length
  const drifted = facts.activities.filter((activity) => activity.decision === 'scope_drift').length
  if (total < MIN_DRIFT_SAMPLE) {
    return [
      line(
        `- 本期 ${total} 条活动（偏离 ${drifted} 条），样本不足 ${MIN_DRIFT_SAMPLE} 条，不给重复模式结论`,
      ),
    ]
  }
  if (drifted === 0) return [line(`- 本期 ${total} 条活动，无偏离记录`)]

  const share = Math.round((drifted / total) * 100)
  const byDirectory = new Map<string, number>()
  for (const activity of facts.activities) {
    if (activity.decision !== 'scope_drift') continue
    const parsed = parseActivity(activity, projectRoot)
    byDirectory.set(parsed.directory, (byDirectory.get(parsed.directory) ?? 0) + 1)
  }
  const top = [...byDirectory.entries()].sort((left, right) => right[1] - left[1])[0]
  if (top === undefined || top[1] / drifted < 0.4) {
    return [line(`- 偏离 ${drifted}/${total} 条（${share}%），分散在不同目录`)]
  }
  return [line(`- 偏离 ${drifted}/${total} 条（${share}%），主要集中在 ${top[0]}（${top[1]} 条）`)]
}

/**
 * Rule health from the judgement log.
 *
 * Counts and a rejection rate, no verdict adjectives: whether a rule is "noisy"
 * is a judgement, and a report that makes it invites the reader to skip the
 * numbers that support it.
 */
function ruleHealthLines(facts: ReportFacts): ReportLine[] {
  const rows = assessRules(facts.judgments)
  // A rule can be healthy on paper and still be unmeasured: bypassed signals
  // never produce a judgement record, so the rate above may rest on nothing.
  const coverage = assessRuleCoverage(facts.signals, facts.judgments).filter(
    (row) => row.bypassed > 0,
  )
  if (rows.length === 0 && coverage.length === 0) return [line('- 还没有候选记录')]
  const shown = rows.slice(0, 3)
  const lines = shown.map((row, index) => {
    const settled = row.confirmed + row.dismissed
    const rate =
      row.falsePositiveRate === null ? '' : `，驳回率 ${Math.round(row.falsePositiveRate * 100)}%`
    const text =
      settled === 0
        ? `- ${row.signalType}：候选 ${row.candidates} 条，尚无已复核样本`
        : `- ${row.signalType}：候选 ${row.candidates} 条，已复核 ${settled} 条` +
          `（确认 ${row.confirmed}、驳回 ${row.dismissed}）${rate}`
    return line(text, index + 1)
  })
  if (rows.length > shown.length) {
    lines.push(line(`- 其余 ${rows.length - shown.length} 类规则从略`, shown.length + 1))
  }
  for (const row of coverage.slice(0, 3)) {
    const warning = row.underrepresented ? '；直通多于已复核，统计不可代表' : ''
    lines.push(
      line(
        `- ${row.signalType}：直通 ${row.bypassed} 条，其中 ${row.unreviewedBypass} 条从未复核` +
          `（已复核 ${row.reviewed} 条）${warning}`,
        shown.length + 1,
      ),
    )
  }
  return lines
}

/** Contradiction intensity movement, stated as numbers rather than as an opinion. */
function contradictionLines(input: ReportInput, facts: ReportFacts): ReportLine[] {
  const nodes = facts.state.contradictions.filter(
    (node): node is ContradictionNode =>
      node.confirmedByUser && (node.type === 'core' || node.type === 'main'),
  )
  if (nodes.length === 0) return [line('- 本期没有已确认的核心或主要矛盾')]
  return nodes.map((node) => {
    const trend = computeTrend(facts.observations, node.id, input.config.thresholds.windowMinutes)
    const detail =
      trend.sampleSize === 0
        ? '本期无观察'
        : `${trend.sampleSize} 次观察，强度 ${trend.firstIntensity ?? '?'}→${trend.lastIntensity ?? '?'}`
    // An `unknown` trend is the honest answer for a single reading, and printing
    // its `?` glyph beside the count reads like a parse error rather than a fact.
    const arrow = trend.trend === 'unknown' ? '' : `${trendArrow(trend.trend)} `
    return line(`- ${node.type}「${node.title}」${arrow}${detail}`)
  })
}

/** Structural facts gathered once and shared by every report shape. */
interface Movement {
  readonly hasBaseline: boolean
  readonly versionBefore: number
  readonly added: number
  readonly removed: number
  readonly completed: number
  readonly deprecated: number
}

/** Facts gathered once and shared by every report shape. */
interface ReportFacts {
  readonly state: TreeState
  readonly activities: readonly ActivityRecord[]
  readonly observations: readonly ContradictionObservation[]
  readonly signals: readonly DriftSignal[]
  readonly interventions: readonly InterventionRecord[]
  /** Every judgement, for the rule audit. */
  readonly judgments: readonly JudgmentRecord[]
  /** Judgements created inside the period. */
  readonly candidates: readonly JudgmentRecord[]
  readonly audits: readonly AuditLogEntry[]
  /** Top-level goals as they stood at period start. */
  readonly initialStrategic: readonly GoalNode[]
  readonly movement: Movement
  /** What finished inside the period. */
  readonly achievements: readonly Achievement[]
  /** Goals absorbing effort while a more pressing one waits. */
  readonly traps: readonly DetailTrap[]
  /** Overall completion, for the header line. */
  readonly progress: ProgressSummary
  /**
   * The lower-cadence reports this one summarises.
   *
   * Empty for a daily report. Kept as records rather than as text so a block can
   * state exact dates and so a later reader can tell "no daily reports existed"
   * from "the daily reports said nothing".
   */
  readonly sources: readonly GeneratedReport[]
}

/**
 * Keep only the blocks that produced lines.
 *
 * A heading with nothing under it reads as a section that is broken, which is
 * worse than the section not being there.
 *
 * @param block - a possibly-absent block.
 * @returns an array with the block, or an empty array.
 */
function optionalBlocks(block: ReportBlock | undefined): ReportBlock[] {
  return block === undefined ? [] : [block]
}

/**
 * Build the achievement block: what finished, and how much of the tree is done.
 *
 * It goes first in every report on purpose. A report that opens with drift is
 * read as an accusation, and the user stops opening it — at which point the
 * monitor has failed at its actual job, which is to keep the user oriented, not
 * to be correct about every deviation.
 *
 * @param facts - the period's facts.
 * @returns a block, possibly saying plainly that nothing finished.
 */
function achievementBlock(facts: ReportFacts): ReportBlock {
  const lines: ReportLine[] = [line(facts.progress.line, 0)]

  const goals = facts.achievements.filter((a) => a.kind === 'goal')
  const contradictions = facts.achievements.filter((a) => a.kind === 'contradiction')

  for (const item of goals) {
    lines.push(line(`完成目标：${item.title}${item.depth === undefined ? '' : `（depth-${item.depth}）`}`))
  }
  for (const item of contradictions) {
    const before = item.intensityBefore
    lines.push(line(`解决矛盾：${item.title}${before === null || before === undefined ? '' : `（强度 ${before} → 已解除）`}`))
  }

  if (goals.length === 0 && contradictions.length === 0) {
    // Said plainly rather than omitted: a missing section reads as "the report
    // does not measure this", and the user then does not know whether the week
    // was empty or the monitor was blind.
    lines.push(line('本期没有目标完成或矛盾解除。', 5))
  }

  const easing = easingContradictions([], facts.state.contradictions)
  if (easing.length > 0) {
    for (const item of easing.slice(0, 3)) {
      lines.push(line(`矛盾强度下降：${item.title} ${item.from} → ${item.to}`))
    }
  }

  return { heading: '## 本期完成', lines }
}

/**
 * Build the detail-trap block.
 *
 * @param facts - the period's facts.
 * @returns a block, or `undefined` when nothing is trapped.
 */
function trapBlock(facts: ReportFacts): ReportBlock | undefined {
  if (facts.traps.length === 0) return undefined
  return {
    heading: '## 陷在细节里',
    lines: facts.traps.slice(0, 3).map((trap) => line(trap.summary)),
  }
}

/**
 * Build the next-period suggestion block.
 *
 * Suggests, never orders. Every line names the fact it came from, so a reader can
 * disagree with the suggestion without having to distrust the whole report.
 *
 * @param facts - the period's facts.
 * @param now - reference time.
 * @returns a block, or `undefined` when there is nothing worth suggesting.
 */
function suggestionBlock(facts: ReportFacts, now: Date): ReportBlock | undefined {
  const lines: ReportLine[] = []

  // The most pressing goal that is not done.
  const candidates = facts.state.goals
    .filter((g) => g.confirmedByUser && g.status !== 'done' && g.status !== 'deprecated')
    .map((g) => ({ goal: g, urgency: urgencyOf(g, now) }))
    .sort((a, b) => b.urgency - a.urgency)

  const top = candidates[0]
  if (top !== undefined && top.goal.deadline !== undefined) {
    const days = Math.ceil((Date.parse(top.goal.deadline) - now.getTime()) / 86_400_000)
    lines.push(
      line(
        days < 0
          ? `「${top.goal.title}」已超期 ${Math.abs(days)} 天。`
          : `「${top.goal.title}」还剩 ${days} 天，是当前最紧迫的目标。`,
      ),
    )
  }

  // A main contradiction nobody has looked at.
  const main = facts.state.contradictions.find((c) => c.type === 'main' && c.resolvedAt === undefined)
  if (main !== undefined) {
    const lastSeen = facts.observations
      .filter((o) => o.contradictionId === main.id)
      .map((o) => Date.parse(o.observedAt))
      .sort((a, b) => b - a)[0]
    if (lastSeen !== undefined) {
      const days = Math.floor((now.getTime() - lastSeen) / 86_400_000)
      if (days >= 5) lines.push(line(`主要矛盾「${main.title}」已 ${days} 天没有观察记录。`))
    }
  }

  if (lines.length === 0) return undefined
  return { heading: '## 下期建议', lines }
}

/**
 * Build the daily report: what today consisted of, in at most 400 characters.
 */
function buildDaily(input: ReportInput, period: Period, facts: ReportFacts): string {
  const blocks: ReportBlock[] = [
    // Achievement first, always. A report that opens with drift reads as an
    // accusation and stops being opened; the monitor's job is to keep the user
    // oriented, not to be right about every deviation.
    achievementBlock(facts),
    { heading: '## 监控状态', lines: monitorLines(facts) },
    calibrationBlock(facts),
    ...evidenceBlocks(facts),
    ...optionalBlocks(trapBlock(facts)),
    ...optionalBlocks(goalActivityBlock(facts, input.collapseDone === true)),
    {
      heading: '## 本期活动',
      lines: activityLines(facts, input.type, input.store.projectRoot),
    },
    ...optionalBlocks(suggestionBlock(facts, input.now ?? new Date())),
  ]
  return composeDocument(`# 日报 ${localDate(period.end)}`, blocks, REPORT_CHAR_LIMITS.daily)
}

/**
 * Build the weekly report: the same facts over seven days, plus structural
 * movement, contradiction intensity and rule health.
 */
function buildWeekly(input: ReportInput, period: Period, facts: ReportFacts): string {
  const blocks: ReportBlock[] = [
    achievementBlock(facts),
    ...optionalBlocks(sourcesBlock(facts)),
    ...optionalBlocks(trapBlock(facts)),
    { heading: '## 监控状态', lines: monitorLines(facts) },
    calibrationBlock(facts),
    ...evidenceBlocks(facts),
    { heading: '## 目标树结构变更', lines: structureLines(facts) },
    { heading: '## 矛盾强度变化', lines: contradictionLines(input, facts) },
    { heading: '## 规则健康度', lines: ruleHealthLines(facts) },
    ...optionalBlocks(goalActivityBlock(facts, input.collapseDone === true)),
    {
      heading: '## 本期活动',
      lines: activityLines(facts, input.type, input.store.projectRoot),
    },
  ]
  const withSuggestions = [...blocks, ...optionalBlocks(suggestionBlock(facts, input.now ?? new Date()))]
  return composeDocument(
    `# 周报 ${localDate(period.start)} → ${localDate(period.end)}`,
    withSuggestions,
    REPORT_CHAR_LIMITS.weekly,
  )
}

/**
 * Build the monthly report: a month is long enough to ask whether the tree
 * survived, whether the core tension moved, and whether drift repeated — each
 * only where the sample actually supports the question.
 */
function buildMonthly(input: ReportInput, period: Period, facts: ReportFacts): string {
  const blocks: ReportBlock[] = [
    achievementBlock(facts),
    ...optionalBlocks(sourcesBlock(facts)),
    ...optionalBlocks(trapBlock(facts)),
    { heading: '## 监控状态', lines: monitorLines(facts) },
    calibrationBlock(facts),
    ...evidenceBlocks(facts),
    {
      heading: '## 目标树结构稳定性',
      lines: [
        ...structureLines(facts),
        ...rootGoalLines(facts, period),
        ...survivalLines(facts),
      ],
    },
    { heading: '## 核心矛盾管理记录', lines: coreLines(facts) },
    {
      heading: '## 重复漂移模式识别',
      lines: repeatedDriftLines(facts, input.store.projectRoot),
    },
    { heading: '## 规则健康度', lines: ruleHealthLines(facts) },
    ...optionalBlocks(goalActivityBlock(facts, input.collapseDone === true)),
    {
      heading: '## 本期活动',
      lines: activityLines(facts, input.type, input.store.projectRoot),
    },
  ]
  return composeDocument(
    `# 月报 ${localDate(period.start)} → ${localDate(period.end)}`,
    blocks,
    REPORT_CHAR_LIMITS.monthly,
  )
}

/**
 * Where a report's Markdown copy lives.
 *
 * Layout, one directory per cadence and one file per period inside it:
 *
 * ```
 * reports/markdown/
 *   日报/2026_10/2026-10-30.md
 *   周报/2026_Q4/2026-10-30.md
 *   月报/2026/2026-10.md
 * ```
 *
 * The bucket directories are what make the tree navigable a year in: a flat
 * directory of one file per period becomes unusable long before it becomes
 * interesting, and "which month was that?" is the only question anyone asks of
 * it. Quarters rather than months for the weekly cadence, because a week can
 * straddle a month boundary and a bucket named after neither month is worse than
 * one named after both.
 *
 * @param storageRoot - the project's `.metacog` directory.
 * @param type - report cadence.
 * @param at - the instant the period ends; decides the bucket and the filename.
 */
export function reportMarkdownPath(storageRoot: string, type: ReportType, at: Date): string {
  return join(storageRoot, 'reports', 'markdown', ...reportRelativeParts(type, at))
}

/** The directory of one cadence, for the "open folder" action. */
export function reportCadenceDir(storageRoot: string, type: ReportType): string {
  return join(storageRoot, 'reports', 'markdown', CADENCE_DIRS[type])
}

/** Directory name per cadence. Chinese, because the user reads these in Explorer. */
const CADENCE_DIRS: Readonly<Record<ReportType, string>> = {
  daily: '日报',
  weekly: '周报',
  monthly: '月报',
}

/** Local midnight of the day containing `at`. */
function startOfDay(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate())
}

/** The Monday of the week containing `at`, at local midnight. */
function mondayOf(at: Date): Date {
  const day = startOfDay(at)
  // getDay(): Sunday is 0. Shift so Monday is 0, then step back that many days.
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7))
  return day
}

/** The first of the month containing `at`, at local midnight. */
function firstOfMonth(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), 1)
}

/**
 * Bucket and filename for one period.
 *
 * Each report is named by the date its period *starts*: a day by its date, a
 * week by its Monday, a month by its first. That makes the name stable no matter
 * when the report is generated — a weekly report run on Thursday and one run on
 * Sunday land on the same filename, which is what "one report per week" means.
 */
function reportRelativeParts(type: ReportType, at: Date): string[] {
  if (type === 'monthly') {
    const first = firstOfMonth(at)
    const year = first.getFullYear()
    return [CADENCE_DIRS.monthly, String(year), `${localDate(first)}.md`]
  }
  if (type === 'weekly') {
    const monday = mondayOf(at)
    const quarter = Math.floor(monday.getMonth() / 3) + 1
    return [CADENCE_DIRS.weekly, `${monday.getFullYear()}_Q${quarter}`, `${localDate(monday)}.md`]
  }
  const day = startOfDay(at)
  return [CADENCE_DIRS.daily, `${day.getFullYear()}_${pad2(day.getMonth() + 1)}`, `${localDate(day)}.md`]
}

/** Appended between two periods in the same file, so the seam is explicit. */
const SECTION_SEPARATOR = '\n---\n\n'

/**
 * Append one period to the Markdown file for the day it ends on.
 *
 * Append, not replace, within the day: running a report twice in one afternoon
 * must not erase the first run's section. Across days it is a different file,
 * because the bucket already says which day it is and one file per day is what
 * makes the directory browsable.
 *
 * Two details make a multi-section file readable rather than a blob:
 *
 * - The new section is wrapped in `## <period>`, and its own headings are
 *   demoted one level, so one period's `##` does not compete with the next
 *   period's `##` in the outline. `###` inside a block would otherwise look like
 *   a child of the neighbouring block.
 * - A `---` separates sections, so the seam is visible when scrolling.
 *
 * A failed write must never cost the user their report: the JSONL record is
 * already durable, so this reports a warning and returns.
 *
 * @param storageRoot - the project's `.metacog` directory.
 * @param report - the stored report.
 */
async function appendMarkdownCopy(storageRoot: string, report: GeneratedReport): Promise<void> {
  const at = new Date(report.periodEnd)
  const path = reportMarkdownPath(storageRoot, report.type, at)
  try {
    await mkdir(pathDirname(path), { recursive: true })
    const existing = await readFile(path, 'utf8').catch(() => '')
    // Strip the single-period title first, then demote: demoting first turns
    // `# 日报 <date>` into `## 日报 <date>`, which `stripDocumentTitle` no longer
    // recognises, and the leftover title then competes with the period heading.
    const body = demoteHeadings(stripDocumentTitle(report.markdown)).trimEnd()
    const title = `${localDate(new Date(report.periodStart))} → ${localDate(new Date(report.periodEnd))}`
    const section = `## ${title}\n\n${body}\n`
    const next = existing.trimEnd() === '' ? `# ${CADENCE_TITLES[report.type]}\n\n${section}` : `${existing.trimEnd()}${SECTION_SEPARATOR}${section}`
    // Temp + rename for the same reason the store uses it: a crash mid-write
    // must not leave the accumulated history half-overwritten.
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, next, 'utf8')
    await rename(temporary, path)
  } catch (error) {
    process.emitWarning(
      `report markdown copy was not written to ${path}: ${String(error)}`,
      'MetacogReportWarning',
    )
  }
}

/** File-level title per cadence: the file is one document, the sections are periods. */
const CADENCE_TITLES: Readonly<Record<ReportType, string>> = {
  daily: '日报记录',
  weekly: '周报记录',
  monthly: '月报记录',
}

/** Drop the `# 日报 2026-10-30` line a single-period document opens with. */
function stripDocumentTitle(markdown: string): string {
  const lines = markdown.split('\n')
  if (lines.length > 0 && lines[0]?.startsWith('# ')) return lines.slice(1).join('\n').trimStart()
  return markdown
}

/**
 * Push every heading down one level, so a period's blocks nest under its own
 * `## <period>` heading instead of colliding with the next period's.
 */
function demoteHeadings(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => (line.startsWith('#') ? `#${line}` : line))
    .join('\n')
}

/**
 * Which cadence feeds which.
 *
 * A weekly report is built from that week's daily reports, and a monthly report
 * from that month's weekly reports. The point is not to save work — the raw
 * activity is still read — but to make the higher cadence a *summary of what was
 * already concluded*, so a week cannot describe itself differently from the
 * days it is made of. Without this the monthly and the daily could disagree
 * about the same Tuesday, and neither would be obviously wrong.
 */
const SOURCE_CADENCE: Readonly<Record<ReportType, ReportType | undefined>> = {
  daily: undefined,
  weekly: 'daily',
  monthly: 'weekly',
}

/**
 * The reports of the feeding cadence whose periods fall inside this one.
 *
 * Only settled sources count: a weekly report generated on Wednesday must not
 * claim to summarise a daily report for that same Wednesday it has not seen
 * finish. Overlap rather than containment, because a monthly report written on
 * the 15th should include the week it is halfway through.
 *
 * @param reports - every stored report for the project.
 * @param type - cadence being generated.
 * @param period - the period being covered.
 * @param now - reference instant, used to exclude sources from the future.
 */
function sourceReports(
  reports: readonly GeneratedReport[],
  type: ReportType,
  period: Period,
  now: Date,
): GeneratedReport[] {
  const source = SOURCE_CADENCE[type]
  if (source === undefined) return []
  return reports.filter((record) => {
    if (record.type !== source) return false
    const start = Date.parse(record.periodStart)
    const end = Date.parse(record.periodEnd)
    if (Number.isNaN(start) || Number.isNaN(end)) return false
    if (start > now.getTime()) return false
    return end >= period.start.getTime() && start <= period.end.getTime()
  })
}

/**
 * Every workspace that should appear in a cross-workspace report.
 *
 * A monitor that only sees the conversation you happen to have open is blind to
 * the other half of your week. The user asked for one report covering everything
 * that has a tree, so the period's facts are gathered from all of them and merged
 * into a single synthetic view.
 */
export interface WorkspaceSource {
  readonly store: MetacogStore
  readonly state: TreeState
  readonly projectId: string
}

/**
 * Generate one report covering every workspace at once.
 *
 * The merge is deliberately shallow: goals and contradictions are concatenated,
 * and every stream is concatenated before the period filter runs. That is enough
 * because the renderers only ever look up a goal by id, count nodes by status,
 * and iterate activities — none of them assume a single root. Inventing a deeper
 * merge (deduplicating same-titled goals across workspaces, say) would be a
 * judgement call the user never asked for, and would silently drop a goal that
 * legitimately exists twice.
 *
 * Ids are unique per workspace already: a goal id embeds a hash of its project
 * root, so two workspaces cannot collide.
 *
 * @param input - the workspaces to merge, plus cadence and configuration.
 * @returns the stored report, bound to the merged tree version.
 */
export async function generateWorkspaceReport(input: {
  readonly workspaces: readonly WorkspaceSource[]
  readonly config: MetacogConfig
  readonly type: ReportType
  readonly now?: Date
  /** Where the JSONL record and the Markdown copy are written. */
  readonly targetStore: MetacogStore
  /** Id the record is filed under; the global sink uses a fixed one. */
  readonly targetProjectId: string
}): Promise<GeneratedReport> {
  const now = input.now ?? new Date()
  const period = resolvePeriod(input.type, now)
  const active = input.workspaces

  const perWorkspace = await Promise.all(
    active.map(async (workspace) => ({
      workspace,
      streams: await Promise.all([
        workspace.store.readActivities(workspace.projectId),
        workspace.store.readObservations(workspace.projectId),
        workspace.store.readSignals(workspace.projectId),
        workspace.store.readInterventions(workspace.projectId),
        workspace.store.readAuditLog(workspace.projectId),
        workspace.store.listSnapshots(workspace.projectId),
        workspace.store.readJudgments(workspace.projectId),
      ]),
    })),
  )

  const allActivities = perWorkspace.flatMap((entry) => entry.streams[0])
  const allObservations = perWorkspace.flatMap((entry) => entry.streams[1])
  const allSignals = perWorkspace.flatMap((entry) => entry.streams[2])
  const allInterventions = perWorkspace.flatMap((entry) => entry.streams[3])
  const audits = perWorkspace.flatMap((entry) => entry.streams[4])
  const snapshots = perWorkspace.flatMap((entry) => entry.streams[5])
  const allJudgments = perWorkspace.flatMap((entry) => entry.streams[6])

  const activities = inPeriod(allActivities, period, (item) => item.timestamp)
  const observations = inPeriod(allObservations, period, (item) => item.observedAt)
  const signals = inPeriod(allSignals, period, (item) => item.observedAt)
  const interventions = inPeriod(allInterventions, period, (item) => item.createdAt)
  const candidates = inPeriod(allJudgments, period, (item) => item.createdAt)

  // One synthetic tree: it carries the union of every workspace's nodes and the
  // newest version among them, which is what "how far has this moved" means when
  // three workspaces move independently.
  const merged: TreeState = {
    projectId: input.targetProjectId,
    version: active.reduce((max, workspace) => Math.max(max, workspace.state.version), 0),
    confirmed: active.length > 0,
    goals: active.flatMap((workspace) => workspace.state.goals),
    contradictions: active.flatMap((workspace) => workspace.state.contradictions),
    createdAt:
      active
        .map((workspace) => workspace.state.createdAt)
        .sort()[0] ?? now.toISOString(),
    updatedAt:
      active
        .map((workspace) => workspace.state.updatedAt)
        .sort()
        .at(-1) ?? now.toISOString(),
  }

  const facts: ReportFacts = {
    state: merged,
    activities,
    observations,
    signals,
    interventions,
    judgments: allJudgments,
    candidates,
    audits,
    initialStrategic: merged.goals.filter((goal) => goal.depth === 1 && goal.confirmedByUser),
    movement: computeMovement(undefined, merged),
    achievements: collectAchievements(merged, period.start, period.end),
    traps: detectDetailTraps(merged, activities, now),
    progress: summarizeAchievements(merged),
    sources: [],
  }

  // The renderers take a `ReportInput`; only `store`/`state` are read from it, so
  // the target store stands in and the merged tree is what they see.
  const asInput: ReportInput = {
    store: input.targetStore,
    state: merged,
    projectId: input.targetProjectId,
    config: input.config,
    type: input.type,
    now,
  }

  const markdown =
    input.type === 'daily'
      ? buildDaily(asInput, period, facts)
      : input.type === 'weekly'
        ? buildWeekly(asInput, period, facts)
        : buildMonthly(asInput, period, facts)

  const report: GeneratedReport = {
    id: `rep_${randomUUID()}`,
    projectId: input.targetProjectId,
    type: input.type,
    generatedAt: now.toISOString(),
    periodStart: period.start.toISOString(),
    periodEnd: period.end.toISOString(),
    goalTreeVersion: merged.version,
    observationIds: observations.map((item) => item.id),
    signalIds: signals.map((item) => item.id),
    interventionIds: interventions.map((item) => item.id),
    markdown,
  }

  const stored = await input.targetStore.appendReport(input.targetProjectId, report)
  await appendMarkdownCopy(input.targetStore.root, stored)
  return stored
}

/**
 * Generate and persist one report.
 *
 * The stored record is the source of truth; the Markdown copy is a convenience
 * beside it.
 *
 * @param input - store, tree, cadence and configuration.
 * @returns the stored report, bound to the tree version it read.
 */
export async function generateReport(input: ReportInput): Promise<GeneratedReport> {
  const now = input.now ?? new Date()
  const { store, projectId, state } = input
  const period = resolvePeriod(input.type, now)
  // The stored records serve two purposes now: they are the append target, and
  // for weekly/monthly they are the source this report summarises.
  const priorReports = await store.readReports(projectId)
  const sources = sourceReports(priorReports, input.type, period, now)

  const [allActivities, allObservations, allSignals, allInterventions, audits, snapshots, judgments] =
    await Promise.all([
      store.readActivities(projectId),
      store.readObservations(projectId),
      store.readSignals(projectId),
      store.readInterventions(projectId),
      store.readAuditLog(projectId),
      store.listSnapshots(projectId),
      store.readJudgments(projectId),
    ])

  const activities = inPeriod(allActivities, period, (item) => item.timestamp)
  const observations = inPeriod(allObservations, period, (item) => item.observedAt)
  const signals = inPeriod(allSignals, period, (item) => item.observedAt)
  const interventions = inPeriod(allInterventions, period, (item) => item.createdAt)
  const candidates = inPeriod(judgments, period, (item) => item.createdAt)

  // The snapshot in force at the start of the period is what "version moved
  // from" means; the newest snapshot at or before period.start.
  const snapshotStart = [...snapshots]
    .filter((snapshot) => Date.parse(snapshot.createdAt) <= period.start.getTime())
    .sort((left, right) => right.version - left.version)[0]

  const initialStrategic = (snapshotStart?.goals ?? state.goals).filter(
    (goal) => goal.depth === 1 && goal.confirmedByUser,
  )

  const facts: ReportFacts = {
    state,
    activities,
    observations,
    signals,
    interventions,
    judgments,
    candidates,
    audits,
    initialStrategic,
    movement: computeMovement(snapshotStart, state),
    // Achievements come from the tree's own timestamps, not the audit log: a goal
    // marked done is a claim the user made, and the moment they made it is what
    // the report should show.
    achievements: collectAchievements(state, period.start, period.end),
    // Traps are computed over the period's activities rather than the whole
    // history, so the share means "of this week's work", not "of all time".
    traps: detectDetailTraps(state, activities, now),
    progress: summarizeAchievements(state),
    sources,
  }

  const markdown =
    input.type === 'daily'
      ? buildDaily(input, period, facts)
      : input.type === 'weekly'
        ? buildWeekly(input, period, facts)
        : buildMonthly(input, period, facts)

  const report: GeneratedReport = {
    id: `rep_${randomUUID()}`,
    projectId,
    type: input.type,
    generatedAt: now.toISOString(),
    periodStart: period.start.toISOString(),
    periodEnd: period.end.toISOString(),
    goalTreeVersion: state.version,
    observationIds: observations.map((item) => item.id),
    signalIds: signals.map((item) => item.id),
    interventionIds: interventions.map((item) => item.id),
    markdown,
  }

  const stored = await store.appendReport(projectId, report)
  await appendMarkdownCopy(store.root, stored)
  return stored
}

/**
 * A goal the model could plausibly work on next: a confirmed, unfinished leaf.
 *
 * Leaves only, because a goal with children is advanced by advancing them, and
 * the root is excluded for the same reason — it is the yardstick, not a task.
 * Returning one rather than listing them all is the point: the block invites a
 * declaration, it is not a menu to read.
 *
 * @param state - current tree, when there is one.
 * @returns the first such goal in tree order, or `undefined`.
 */
function actionableLeaf(state: TreeState | undefined): GoalNode | undefined {
  if (state === undefined) return undefined
  const parents = new Set(
    state.goals.map((goal) => goal.parentId).filter((id): id is string => id !== undefined),
  )
  return state.goals.find(
    (goal) =>
      goal.confirmedByUser &&
      goal.depth > 0 &&
      goal.status !== 'done' &&
      goal.status !== 'deprecated' &&
      !parents.has(goal.id),
  )
}

/**
 * Render the compact prompt block (spec 6 Stage G item 2).
 *
 * Deliberately small: the decision rule for core-versus-main, the active top
 * level of the tree, and whatever is currently pending. The full tree never
 * appears here — a monitor that costs a thousand tokens per turn is one the
 * user turns off.
 *
 * @param state - current tree, or `undefined` when the project has none.
 * @param pending - pending interventions.
 * @param hints - Level 1 hints from the latest check.
 * @param config - configuration, for the thresholds quoted in the rule line.
 * @param plan - the session's declared plan, when one is in force.
 */
export function renderPromptBlock(
  state: TreeState | undefined,
  pending: readonly InterventionRecord[],
  hints: readonly string[],
  config: MetacogConfig,
  plan?: DeclaredPlan,
): string {
  const lines: string[] = [
    'Metacognitive monitor for this project. Distinguish the two contradiction roles before acting:',
    '- core: implied by the root goal, long-lived and structural; it does not go away by working harder.',
    '- main: the one tension currently limiting progress; if unrelieved, name which deeper goal stalls first.',
    `Treat an activity as out of scope only with grade A evidence; below confidence ${config.thresholds.minConfidence} record it as uncertain instead.`,
  ]
  // Config literals assembled by tests (and profiles predating this section)
  // may not carry `judgment`; the safe default is the conservative mode.
  const judgment = config.judgment ?? {
    allowUnreviewedEscalation: false,
    backlogLimit: 200,
    maxLatencyMinutes: 10,
  }
  lines.push(
    judgment.allowUnreviewedEscalation
      ? `复核模式：直通（未复核候选也可开卡）；高置信偏离目标 ≤ ${judgment.maxLatencyMinutes} 分钟可见。`
      : `复核模式：保守（未复核候选不开卡）；高置信偏离目标 ≤ ${judgment.maxLatencyMinutes} 分钟可见。`,
  )

  if (state !== undefined) {
    const root = state.goals.find((goal) => goal.depth === 0 && goal.confirmedByUser)
    const strategic = state.goals.filter((goal) => goal.depth === 1 && goal.confirmedByUser)
    if (root !== undefined) lines.push(`根目标: ${root.title}`)
    if (strategic.length > 0) {
      lines.push(
        `第 1 层 (${strategic.length}): ${strategic.map((goal) => `${goal.title} [${goal.status}]`).join('; ')}`,
      )
    }
    const main = state.contradictions.find(
      (node) => node.type === 'main' && node.confirmedByUser,
    )
    const core = state.contradictions.find(
      (node) => node.type === 'core' && node.confirmedByUser,
    )
    if (core !== undefined) lines.push(`core contradiction: ${core.title}`)
    if (main !== undefined) lines.push(`main contradiction: ${main.title}`)
  }

  // A session that declares no plan is monitored by S5 alone at 0.25 coverage,
  // which is below the escalation floor: the monitor runs and cannot act. One
  // line saying so, naming the call that fixes it, is cheaper than letting the
  // model discover it from a report — and it disappears the moment a plan
  // exists, so it cannot become a repeated nag.
  //
  // Quiet mode suppresses it. The block keeps its rules under quiet mode (unless
  // the whole block is suppressed); an unprompted suggestion is precisely the
  // interruption quiet mode exists to remove.
  if (plan === undefined && !config.quiet.enabled) {
    lines.push(
      '未声明本次计划：先调用 metacog_declare_plan 写明 goal 与 steps；每步的 expects.tool 会被自动汇总成工具集，不必另填 allowedTools。',
    )
    const leaf = actionableLeaf(state)
    if (leaf !== undefined) {
      lines.push(`候选 linkedGoalId "${leaf.id}"（${leaf.title}）；goal 可写「推进 ${leaf.title}」。`)
    }
  }

  for (const hint of hints.slice(0, 2)) lines.push(hint)
  // Pending decisions normally arrive through `hints` (the mount builds one
  // Chinese line per card), so rendering them again here would print the same
  // card twice. Keep a fallback only for callers that pass no hints at all.
  if (pending.length > 0 && hints.length === 0) {
    for (const record of pending.slice(0, 2)) lines.push(pendingInterventionHint(record))
  }

  return lines.join('\n')
}
