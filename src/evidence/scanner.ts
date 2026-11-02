/**
 * Deterministic evidence scanner.
 *
 * Reads what is actually on disk — README, docs, manifests, entry points and
 * recent git history — and derives *candidate* goal and contradiction nodes
 * from it. Nothing here is inferred beyond what a file literally states: a
 * section heading becomes a candidate goal, a stated trade-off becomes a
 * candidate tension, and every node carries the real path it came from.
 *
 * This is why the scanner cannot manufacture an L1 just to reach the
 * "2–5 suggested" range: a project with one documented objective
 * yields one L1, and the candidate tree stays small.
 *
 * @module dsh-metacog/evidence/scanner
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** One piece of traceable support, always tied to a real path or commit. */
export interface EvidenceItem {
  /** Project-relative path, or `git:<sha>` for a commit. */
  ref: string
  /** Why this is evidence. */
  note: string
}

/** A candidate node derived from evidence, before the user confirms it. */
export interface CandidateNode {
  /** Stable within one scan; suffixed when generated. */
  slug: string
  title: string
  description: string
  /** The real evidence this candidate is grounded in. */
  evidence: string[]
}

/** Candidate tension derived from documented trade-offs or competing sections. */
export interface CandidateContradiction extends CandidateNode {
  poleA: string
  poleB: string
}

/** Everything one scan found, plus what it looked at. */
export interface ScanResult {
  projectRoot: string
  /** Project-relative paths that were actually read. */
  inspectedPaths: string[]
  /** Paths that exist at the root but were not parsed for candidates. */
  ignoredPaths: string[]
  candidates: {
    l0: CandidateNode | undefined
    l1: CandidateNode[]
    contradictions: CandidateContradiction[]
  }
  /** Recent commits, `git:<short-sha>` refs usable as evidence. */
  commits: EvidenceItem[]
  /** Non-fatal problems worth surfacing to the user. */
  warnings: string[]
}

/** Files at the project root inspected for candidate extraction. */
const README_NAMES = ['README.md', 'README.en.md', 'readme.md', 'README.MD']

/** Doc directories scanned one level deep, in priority order. */
const DOC_DIRS = ['docs', 'doc', 'design', 'spec']

/** Manifests whose description/scripts hint at the project objective. */
const MANIFEST_NAMES = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']

/** Cap on how many doc files one scan parses, keeping the scan cheap. */
const MAX_DOC_FILES = 24

/** Cap on how many recent commits are offered as evidence. */
const MAX_COMMITS = 8

/**
 * Test whether a path exists.
 *
 * @param path - absolute path.
 */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Read a file as UTF-8, returning `undefined` when unreadable.
 *
 * @param path - absolute path.
 */
async function readTextOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** One markdown heading with its level and line index. */
interface Heading {
  level: number
  text: string
  line: number
}

/**
 * Extract markdown headings, skipping fenced code blocks.
 *
 * Fenced blocks are skipped because a `# comment` inside a shell snippet is not
 * a document heading, and treating it as one would invent a goal.
 *
 * @param text - markdown source.
 */
function extractHeadings(text: string): Heading[] {
  const headings: Heading[] = []
  let fence: string | undefined
  const lines = text.split(/\r?\n/)
  for (const [index, raw] of lines.entries()) {
    const line = raw.trimEnd()
    const fenceMatch = /^(```|~~~)/.exec(line.trimStart())
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] ?? '```'
      if (fence === undefined) fence = marker
      else if (line.trimStart().startsWith(fence)) fence = undefined
      continue
    }
    if (fence !== undefined) continue
    const match = /^(#{1,3})\s+(.+?)\s*$/.exec(line)
    if (match === null) continue
    const marker = match[1]
    const captured = match[2]
    if (marker === undefined || captured === undefined) continue
    const text_ = captured.replace(/[#\s]+$/, '')
    if (text_.length === 0) continue
    headings.push({ level: marker.length, text: text_, line: index })
  }
  return headings
}

/**
 * First non-empty paragraph after a heading, used as the description.
 *
 * @param lines - document lines.
 * @param fromLine - heading line index.
 */
function paragraphAfter(lines: string[], fromLine: number): string {
  for (let index = fromLine + 1; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim()
    if (line.length === 0) continue
    if (line.startsWith('#')) return ''
    // Collect the paragraph, stopping at a blank line.
    const parts: string[] = []
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      const current = (lines[cursor] ?? '').trim()
      if (current.length === 0 || current.startsWith('#')) break
      parts.push(current)
    }
    return parts.join(' ').slice(0, 240)
  }
  return ''
}

/**
 * Turn a heading into a filename-safe slug.
 *
 * @param text - heading text.
 * @param fallbackIndex - index used when the text yields nothing usable.
 */
function slugify(text: string, fallbackIndex: number): string {
  const ascii = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (ascii.length >= 3) return ascii.slice(0, 40)
  // Non-Latin headings (e.g. Chinese) carry no ASCII slug; fall back to a
  // positional id rather than mangling the title.
  return `node-${fallbackIndex}`
}

/**
 * Extract tension pairs from prose that explicitly states a trade-off.
 *
 * Only sentences containing a contrastive marker are considered, and both
 * poles must be non-trivial. This is intentionally conservative: an
 * `unclassified` contradiction the user fills in later is far better than a
 * fabricated `core` one.
 *
 * @param text - markdown source.
 * @param pathRef - project-relative path for evidence attribution.
 */
function extractContradictionCandidates(
  text: string,
  pathRef: string,
): CandidateContradiction[] {
  const found: CandidateContradiction[] = []
  const lines = text.split(/\r?\n/)
  let inFence = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || line.length === 0) continue
    // English "X vs Y" / "X versus Y" and Chinese "X 与 Y 的张力" style markers.
    const vs = /\b([A-Za-z0-9][\w\- ]{2,40})\s+(?:vs\.?|versus)\s+([A-Za-z0-9][\w\- ]{2,40})\b/i.exec(
      line,
    )
    const tension = /([\u4e00-\u9fa5\w\- ]{2,20})\s*(?:与|和|vs\.?)\s*([\u4e00-\u9fa5\w\- ]{2,20})\s*(?:之间)?的?张力/.exec(
      line,
    )
    const match = tension ?? vs
    if (match === null) continue
    const capturedA = match[1]
    const capturedB = match[2]
    if (capturedA === undefined || capturedB === undefined) continue
    const poleA = capturedA.trim()
    const poleB = capturedB.trim()
    if (poleA.length < 2 || poleB.length < 2) continue
    found.push({
      slug: slugify(`${poleA}-${poleB}`, found.length),
      title: `${poleA} vs ${poleB}`,
      description: line.slice(0, 240),
      evidence: [pathRef],
      poleA,
      poleB,
    })
  }
  return found
}

/**
 * Read recent commits, tolerating a missing git binary or non-repo directory.
 *
 * @param root - absolute project root.
 * @returns commits usable as evidence, plus a warning when git is unusable.
 */
async function scanCommits(root: string): Promise<{ commits: EvidenceItem[]; warning?: string }> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', `-${MAX_COMMITS}`, '--pretty=format:%h\t%s', '--no-merges'],
      { cwd: root, timeout: 5_000, windowsHide: true },
    )
    const commits = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [sha, ...subject] = line.split('\t')
        return { ref: `git:${sha}`, note: subject.join('\t').slice(0, 200) }
      })
    return { commits }
  } catch (error) {
    return {
      commits: [],
      warning: `git history unavailable (${String((error as Error).message).slice(0, 120)}); tree evidence relies on files only`,
    }
  }
}

/**
 * Drop later candidates that repeat an earlier title.
 *
 * @param nodes - candidates in discovery order.
 */
function dedupeByTitle(nodes: CandidateNode[]): CandidateNode[] {
  const seen = new Set<string>()
  const kept: CandidateNode[] = []
  for (const node of nodes) {
    const key = node.title.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(node)
  }
  return kept
}

/**
 * Render a scan result as a compact human summary.
 *
 * @param scan - the scan to describe.
 */
export function describeScan(scan: ScanResult): string {
  const lines: string[] = []
  lines.push(`project root: ${basename(scan.projectRoot)}`)
  lines.push(`inspected: ${scan.inspectedPaths.join(', ') || '(none)'}`)
  if (scan.candidates.l0 !== undefined) {
    lines.push(`L0 candidate: ${scan.candidates.l0.title}  [${scan.candidates.l0.evidence.join(', ')}]`)
  } else {
    lines.push('L0 candidate: (none — supply one during confirmation)')
  }
  lines.push(`L1 candidates: ${scan.candidates.l1.length}`)
  for (const node of scan.candidates.l1) {
    lines.push(`  - ${node.title}  [${node.evidence.join(', ')}]`)
  }
  lines.push(`contradiction candidates: ${scan.candidates.contradictions.length}`)
  for (const node of scan.candidates.contradictions) {
    lines.push(`  - ${node.title} (${node.poleA} / ${node.poleB})  [${node.evidence.join(', ')}]`)
  }
  if (scan.commits.length > 0) lines.push(`recent commits: ${scan.commits.length}`)
  for (const warning of scan.warnings) lines.push(`warning: ${warning}`)
  return lines.join('\n')
}
