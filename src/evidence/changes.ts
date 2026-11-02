/**
 * File-change detection: what moved since the last look.
 *
 * Everything else in this plugin watches what the *agent* did — tool calls, turn
 * reports. This watches what happened to the *files*, which is the one signal that
 * survives an agent that talks without acting.
 *
 * The rule that matters is not "notice changes" but "do not invent them". A scanner
 * that reports every file every time is noise; one that misses a deletion is worse.
 * So the baseline is a content fingerprint per path, and a change is one of three
 * named things — added, modified, removed — with the paths attached.
 *
 * Cost is bounded by ignoring the directories that are never interesting: build
 * output, dependency trees, the monitor's own storage. Scanning `node_modules`
 * would take minutes and never produce a finding.
 *
 * @module dsh-metacog/evidence/changes
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'

/** One file's identity, as far as change detection is concerned. */
export interface FileFingerprint {
  /** Bytes on disk. */
  size: number
  /** sha256 of the contents. */
  hash: string
}

/** One detected change. */
export interface FileChange {
  kind: 'added' | 'modified' | 'removed'
  /** Path relative to the project root, with forward slashes. */
  path: string
  /** Size after the change; 0 for a removal. */
  size: number
}

/** A saved baseline plus what changed against it. */
export interface ChangeReport {
  changes: FileChange[]
  /** Files present after the scan. */
  scanned: number
  /** Paths skipped because they are noise. */
  skipped: number
  /** Whether a previous baseline existed. */
  hadBaseline: boolean
}

/**
 * Directory names never worth scanning.
 *
 * `node_modules` and build output would dominate the fingerprint with files no
 * judgement ever depends on, and `.metacog` holds the monitor's own record —
 * including the baseline file, which would make every scan see itself change.
 */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.metacog',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
])

/** File extensions skipped: binaries whose bytes say nothing about intent. */
const IGNORED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.7z',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp3',
  '.mp4',
  '.mov',
  '.so',
  '.dll',
  '.exe',
  '.node',
])

/** Largest file that still gets hashed; beyond this, size alone identifies it. */
const MAX_HASH_BYTES = 2 * 1024 * 1024

/** Cap on files scanned, so a stray huge tree cannot stall a tick. */
const MAX_FILES = 5000

/**
 * Walk a project and fingerprint its files.
 *
 * @param root - project root.
 * @returns a map from relative path to fingerprint, plus how many were skipped.
 */
export async function fingerprintTree(root: string): Promise<{ files: Map<string, FileFingerprint>; skipped: number }> {
  const files = new Map<string, FileFingerprint>()
  let skipped = 0

  /** Depth-first walk with the ignore rules applied at each directory. */
  async function walk(directory: string): Promise<void> {
    if (files.size >= MAX_FILES) return
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      // Unreadable directory: skip it rather than failing the whole scan. A
      // permission error on one subtree should not blind the monitor to the rest.
      skipped += 1
      return
    }

    for (const entry of entries) {
      if (files.size >= MAX_FILES) return
      const absolute = join(directory, entry.name)

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          skipped += 1
          continue
        }
        await walk(absolute)
        continue
      }
      if (!entry.isFile()) {
        skipped += 1
        continue
      }

      const dot = entry.name.lastIndexOf('.')
      if (dot >= 0 && IGNORED_EXTENSIONS.has(entry.name.slice(dot).toLowerCase())) {
        skipped += 1
        continue
      }

      let info
      try {
        info = await stat(absolute)
      } catch {
        skipped += 1
        continue
      }

      const relativePath = relative(root, absolute).split(sep).join('/')
      if (info.size > MAX_HASH_BYTES) {
        // Too large to hash cheaply: identify by size. A same-size edit inside a
        // 2 MB file is a miss, which is a stated limitation rather than a silent one.
        files.set(relativePath, { size: info.size, hash: `size:${info.size}` })
        continue
      }

      let hash: string
      try {
        hash = createHash('sha256').update(await readFile(absolute)).digest('hex')
      } catch {
        skipped += 1
        continue
      }
      files.set(relativePath, { size: info.size, hash })
    }
  }

  await walk(root)
  return { files, skipped }
}

/**
 * Compare two fingerprints.
 *
 * @param previous - baseline, or `undefined` on the first scan.
 * @param current - the tree as it is now.
 * @returns named changes, sorted by kind then path so the output is stable.
 */
export function diffFingerprints(
  previous: Map<string, FileFingerprint> | undefined,
  current: Map<string, FileFingerprint>,
): FileChange[] {
  if (previous === undefined) {
    // No baseline: everything present is "added" would be true and useless. Report
    // nothing, so the first scan establishes the baseline instead of announcing the
    // whole project as a change.
    return []
  }

  const changes: FileChange[] = []
  for (const [path, fingerprint] of current) {
    const before = previous.get(path)
    if (before === undefined) {
      changes.push({ kind: 'added', path, size: fingerprint.size })
      continue
    }
    if (before.hash !== fingerprint.hash) {
      changes.push({ kind: 'modified', path, size: fingerprint.size })
    }
  }
  for (const path of previous.keys()) {
    if (!current.has(path)) changes.push({ kind: 'removed', path, size: 0 })
  }

  const order = { added: 0, modified: 1, removed: 2 } as const
  return changes.sort((a, b) => order[a.kind] - order[b.kind] || a.path.localeCompare(b.path))
}

/**
 * Render changes as activity summaries.
 *
 * One activity per change would flood the stream after a refactor, so the caller
 * gets grouped summaries instead: one line naming how many of each kind, plus the
 * specific paths up to a limit. The limit matters — a summary that names 400 files
 * is not more informative than one that names 5 and says "and 395 more".
 *
 * @param report - the change report.
 * @param limit - how many paths to name per kind.
 * @returns one summary per kind that had changes.
 */
export function describeChanges(report: ChangeReport, limit = 5): string[] {
  const lines: string[] = []
  for (const kind of ['added', 'modified', 'removed'] as const) {
    const group = report.changes.filter((change) => change.kind === kind)
    if (group.length === 0) continue
    const named = group.slice(0, limit).map((change) => change.path)
    const rest = group.length - named.length
    const verb = kind === 'added' ? '新增' : kind === 'modified' ? '修改' : '删除'
    lines.push(`${verb} ${group.length} 个文件：${named.join('、')}${rest > 0 ? ` 等 ${rest} 个` : ''}`)
  }
  return lines
}
