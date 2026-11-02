/**
 * Workspace material discovery.
 *
 * Derivation quality is bounded by what the model gets to read. A fixed list of
 * conventional filenames fails on any project that does not follow conventions,
 * and reading everything fails on any project with real data. So discovery has
 * two stages:
 *
 * 1. **Enumerate** — walk the tree once, collecting only metadata. No parsing.
 * 2. **Classify** — bucket each file as document / result / code / raw-data.
 *
 * The classification is what makes the walk useful: `result` files are the
 * product of someone's judgement (check reports, evaluation tables, exception
 * lists) and carry the most signal about what went wrong; `raw-data` only proves
 * that collection happened and would drown the model in noise.
 *
 * Rules are data, not code. A different project shape needs a rule row, not a
 * patch to this file.
 *
 * @module dsh-metacog/evidence/discover
 */
import { readdir, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'

/** What a file is, for the purpose of derivation. */
export type MaterialCategory = 'document' | 'result' | 'code' | 'raw-data'

/** One discovered file. */
export interface MaterialFile {
  /** Project-relative path, `/`-separated. */
  path: string
  category: MaterialCategory
  bytes: number
  /** Epoch millis of last modification. */
  modifiedAt: number
}

/** What the walk found, plus what it chose not to look at. */
export interface MaterialScan {
  files: MaterialFile[]
  /** Directories skipped wholesale, with the reason. */
  skippedDirs: { path: string; reason: string }[]
  /** Files beyond the cap, counted but not listed. */
  truncated: number
  /** Total files seen before any cap. */
  seen: number
  warnings: string[]
}

/** A classification rule. First match wins, so order matters. */
export interface ClassificationRule {
  category: MaterialCategory
  /** Lower-case extensions including the dot. */
  extensions?: string[]
  /** Directory names (any segment) that force this category. */
  dirNames?: string[]
  /** File-name fragments (case-insensitive). */
  nameContains?: string[]
  /** Size ceiling; files above this cannot be this category. */
  maxBytes?: number
  /** Size floor; files below this cannot be this category. */
  minBytes?: number
}

/** Directories never worth walking. */
export const DEFAULT_EXCLUDED_DIRS = [
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '__pycache__',
  '.ipynb_checkpoints',
  '.venv',
  'venv',
  '.tox',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'target',
  'bin',
  'obj',
  '.metacog',
  '.cache',
  '.idea',
  '.vscode',
  // macOS metadata that survives a zip round-trip. The directory holds
  // AppleDouble shadow files for every real file, so walking it doubles the
  // file count with entries that carry no content of their own.
  '__MACOSX',
  // Windows shell metadata.
  '$RECYCLE.BIN',
  'System Volume Information',
]

/**
 * Default rules, ordered most-specific first.
 *
 * The `result` checks come before `raw-data` so that an evaluation table inside
 * a data directory is still recognised as a result.
 */
export const DEFAULT_RULES: ClassificationRule[] = [
  // Generated logs: high volume, no intent. Must precede `document` because log
  // files are usually .txt and would otherwise flood the document bucket.
  {
    category: 'raw-data',
    nameContains: ['运行日志', 'run.log', 'debug', '.log', '_log_'],
    extensions: ['.txt', '.log', '.csv'],
  },
  // Produced by analysis: check reports, indexes, evaluations.
  {
    category: 'result',
    dirNames: ['输出', 'output', 'outputs', 'report', 'reports', '评估', '评估表', '分析结果'],
    // Directory name alone is not enough: a per-trial data slice living inside
    // an output tree is still data. Require a naming signal or a real size.
    minBytes: 2048,
  },
  {
    category: 'result',
    nameContains: ['索引', '评估', '检查', '明细', '报告', '汇总', 'summary', 'report', 'index', 'result'],
    extensions: ['.csv', '.json', '.html', '.xlsx', '.md', '.txt'],
    maxBytes: 20 * 1024 * 1024,
    // A few hundred bytes named "report" is a per-trial artifact, not a report.
    minBytes: 2048,
  },
  // Human-authored prose: the primary source of intent.
  {
    category: 'document',
    extensions: ['.md', '.markdown', '.txt', '.rst', '.org', '.docx', '.doc', '.pdf', '.pptx', '.ppt', '.xlsx', '.xls', '.odt', '.rtf', '.html', '.htm'],
    maxBytes: 50 * 1024 * 1024,
    minBytes: 256,
  },
  // Source code: shows what is actually being built.
  {
    category: 'code',
    extensions: ['.py', '.m', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.r', '.jl', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.sh', '.ps1', '.bat', '.cmd', '.lua', '.sql'],
    maxBytes: 2 * 1024 * 1024,
  },
  // Everything else that is data.
  { category: 'raw-data' },
]

/** Options for {@link discoverMaterials}. */
export interface DiscoverOptions {
  maxFiles?: number
  maxDepth?: number
  excludedDirs?: string[]
  rules?: ClassificationRule[]
  /** Files above this size are never `document`, regardless of extension. */
  hugeFileBytes?: number
}

/** Normalize an extension to lower case with a leading dot. */
function extOf(name: string): string {
  const at = name.lastIndexOf('.')
  return at < 0 ? '' : name.slice(at).toLowerCase()
}

/**
 * Classify one file against the rule list.
 *
 * @param path - project-relative path.
 * @param bytes - file size.
 * @param rules - ordered rules.
 * @param hugeFileBytes - size beyond which a document is treated as data.
 */
export function classify(
  path: string,
  bytes: number,
  rules: ClassificationRule[] = DEFAULT_RULES,
  hugeFileBytes = 50 * 1024 * 1024,
): MaterialCategory {
  const segments = path.split('/')
  const name = (segments.pop() ?? '').toLowerCase()
  const dirs = segments.map((s) => s.toLowerCase())
  const ext = extOf(name)

  for (const rule of rules) {
    if (rule.maxBytes !== undefined && bytes > rule.maxBytes) continue
    if (rule.minBytes !== undefined && bytes < rule.minBytes) continue
    if (rule.dirNames !== undefined) {
      const wanted = rule.dirNames.map((d) => d.toLowerCase())
      if (dirs.some((d) => wanted.includes(d))) {
        // dirNames alone is enough; extension filters are a narrowing optional.
        if (rule.extensions === undefined || rule.extensions.includes(ext)) {
          return rule.category
        }
        continue
      }
      // dirNames present but no match: this rule cannot apply.
      if (rule.extensions === undefined && rule.nameContains === undefined) continue
    }
    if (rule.nameContains !== undefined) {
      const hit = rule.nameContains.some((fragment) => name.includes(fragment.toLowerCase()))
      if (!hit) continue
      if (rule.extensions !== undefined && !rule.extensions.includes(ext)) continue
      return rule.category
    }
    if (rule.extensions !== undefined) {
      if (!rule.extensions.includes(ext)) continue
      // A huge file is data whatever its extension says.
      if (bytes > hugeFileBytes) return 'raw-data'
      return rule.category
    }
    // A catch-all rule (no filters) matches immediately.
    if (rule.dirNames === undefined && rule.nameContains === undefined && rule.extensions === undefined) {
      return rule.category
    }
  }
  return 'raw-data'
}

/** Whether a directory name should be skipped. */
function isExcluded(name: string, excluded: Set<string>): boolean {
  return excluded.has(name.toLowerCase())
}

/**
 * Walk a workspace and classify every file.
 *
 * Iterative rather than recursive: a deep tree with symlink loops must not blow
 * the stack, and the depth cap needs to apply uniformly.
 *
 * @param root - absolute workspace root.
 * @param options - caps, exclusions and rules.
 * @returns discovered files plus what was skipped.
 */
export async function discoverMaterials(
  root: string,
  options: DiscoverOptions = {},
): Promise<MaterialScan> {
  const maxFiles = options.maxFiles ?? 4000
  const maxDepth = options.maxDepth ?? 12
  const rules = options.rules ?? DEFAULT_RULES
  const hugeFileBytes = options.hugeFileBytes ?? 50 * 1024 * 1024
  const excluded = new Set(
    (options.excludedDirs ?? DEFAULT_EXCLUDED_DIRS).map((d) => d.toLowerCase()),
  )

  const files: MaterialFile[] = []
  const skippedDirs: { path: string; reason: string }[] = []
  const warnings: string[] = []
  let seen = 0
  let truncated = 0

  /** Breadth-first queue of directories still to visit. */
  const queue: { abs: string; rel: string; depth: number }[] = [
    { abs: root, rel: '', depth: 0 },
  ]

  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break

    let entries
    try {
      entries = await readdir(current.abs, { withFileTypes: true })
    } catch (error) {
      warnings.push(`could not list ${current.rel || '.'}: ${String(error).slice(0, 120)}`)
      continue
    }

    for (const entry of entries) {
      const rel = current.rel === '' ? entry.name : `${current.rel}/${entry.name}`

      if (entry.isSymbolicLink()) continue

      if (entry.isDirectory()) {
        if (isExcluded(entry.name, excluded)) {
          skippedDirs.push({ path: rel, reason: 'excluded by name' })
          continue
        }
        if (current.depth + 1 > maxDepth) {
          skippedDirs.push({ path: rel, reason: `deeper than ${maxDepth}` })
          continue
        }
        queue.push({ abs: join(current.abs, entry.name), rel, depth: current.depth + 1 })
        continue
      }

      if (!entry.isFile()) continue

      seen += 1
      if (files.length >= maxFiles) {
        truncated += 1
        continue
      }

      // `withFileTypes` does not carry size, so one stat per collected file is
      // unavoidable. It is bounded by maxFiles rather than by tree size, which
      // is what keeps a 114k-file project fast: the cap stops the stats, and
      // the rest of the walk only counts names.
      let info
      try {
        info = await stat(join(current.abs, entry.name))
      } catch {
        continue
      }
      const normalized = rel.split(sep).join('/')
      files.push({
        path: normalized,
        category: classify(normalized, info.size, rules, hugeFileBytes),
        bytes: info.size,
        modifiedAt: info.mtimeMs,
      })
    }
  }

  if (truncated > 0) {
    warnings.push(
      `file cap ${maxFiles} reached; ${truncated} further files were counted but not listed. ` +
        'Raise maxFiles or narrow the scope for a complete picture.',
    )
  }

  return { files, skippedDirs, truncated, seen, warnings }
}

/** Counts per category, for the derivation prompt header. */
export function summarize(scan: MaterialScan): Record<MaterialCategory, number> {
  const out: Record<MaterialCategory, number> = {
    document: 0,
    result: 0,
    code: 0,
    'raw-data': 0,
  }
  for (const file of scan.files) out[file.category] += 1
  return out
}

/**
 * File names that carry no information: default names from office suites and
 * operating systems. A file called "新建文档.docx" or "未命名.md" is either a
 * scratch buffer or an export artifact, and reading it wastes the one budget
 * that matters — attention. They are excluded from the candidate list but still
 * counted, so the number reported stays honest.
 */
const UNNAMED_PATTERNS: RegExp[] = [
  /^未命名/i,
  /^新建/i,
  /^untitled/i,
  /^new (document|file|text)/i,
  /^document\d*\.(docx?|pdf)$/i,
  /^文字文稿/i,
  /^演示文稿/i,
  /^工作簿/i,
  /^副本\s*[-–]?\s*/,
  /[-–]\s*副本$/,
  /^无标题/i,
  // A trailing "(1)" marks a download duplicate, but the *content* may be the
  // only surviving copy — "破冰游戏2.0(1).xlsx" is a real document. It is only a
  // placeholder when nothing else remains in the stem, so this pattern is
  // anchored to a stem that has no other words in it.
  /^\(\d+\)$/,
]

/**
 * Whether a path belongs to a scratch or temporary area.
 *
 * Test sandboxes, editor scratch pads and generated intermediates follow a
 * naming convention: a leading underscore, or a name that says it is temporary.
 * They are real files but carry no project intent, and letting them into the
 * shortlist spends the model's reading budget on artifacts of earlier debugging.
 *
 * Only directories are inspected — the file name itself is the caller's business.
 *
 * @param path - project-relative path.
 */
export function isScratchPath(path: string): boolean {
  const segments = path.split('/')
  for (const segment of segments.slice(0, -1)) {
    const lower = segment.toLowerCase()
    if (lower.startsWith('_')) return true
    if (lower === 'tmp' || lower === 'temp' || lower === 'scratch' || lower === '.cache') return true
    if (lower === 'test' || lower === 'tests' || lower === '__tests__') return true
  }
  return false
}

/**
 * Whether a filename is an autogenerated placeholder.
 *
 * Matched against the stem, not the full path, so a well-named file inside a
 * badly-named folder is unaffected.
 *
 * @param path - project-relative path.
 */
export function isUnnamedDocument(path: string): boolean {
  const name = path.split('/').pop() ?? path
  const stem = name.replace(/\.[^.]+$/, '')
  return UNNAMED_PATTERNS.some((re) => re.test(stem) || re.test(name))
}

/**
 * Render only the *titles* of candidate material.
 *
 * Intentionally carries no sizes, no full paths and no excerpts. The model is
 * expected to decide which few files are worth opening and then read them with
 * its own tools; handing it every path up front both spends the prompt budget on
 * material it will not use and nudges it toward reading too much. Titles are
 * enough to form a shortlist.
 *
 * @param scan - discovered materials.
 * @param limitPerCategory - cap per bucket.
 */
export function renderTitles(scan: MaterialScan, limitPerCategory = 60): string {
  const usable = scan.files.filter(
    (f) => f.category !== 'raw-data' && !isUnnamedDocument(f.path) && !isScratchPath(f.path),
  )
  const unnamed = scan.files.filter(
    (f) => f.category !== 'raw-data' && isUnnamedDocument(f.path) && !isScratchPath(f.path),
  )
  const scratch = scan.files.filter(
    (f) => f.category !== 'raw-data' && isScratchPath(f.path),
  )
  const counts = summarize(scan)
  const lines: string[] = []

  lines.push(
    `扫描到 ${scan.seen} 个文件：文档 ${counts.document}，结果 ${counts.result}，` +
      `代码 ${counts.code}，原始数据 ${counts['raw-data']}。`,
  )
  if (unnamed.length > 0 || scratch.length > 0) {
    const parts: string[] = []
    if (unnamed.length > 0) parts.push(`${unnamed.length} 个自动命名文件（未命名/新建/副本）`)
    if (scratch.length > 0) parts.push(`${scratch.length} 个临时或测试目录内的文件`)
    lines.push(`已忽略：${parts.join('、')}。若其中有重要的，请自行指定路径。`)
  }

  for (const category of ['document', 'result'] as const) {
    const group = usable.filter((f) => f.category === category)
    if (group.length === 0) continue
    lines.push('')
    lines.push(
      category === 'document'
        ? `文档（${group.length} 个，给人看的东西）`
        : `结果（${group.length} 个，别人判断的产物，矛盾多半藏在这里）`,
    )
    const shown = [...group].sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, limitPerCategory)
    // Say once per group how many are undecodable rather than tagging every
    // line: a document-heavy project would otherwise spend most of the prompt
    // on repeated warnings.
    const binaryCount = shown.filter((file) => readerFor(file.path) === null).length
    const officeCount = shown.filter((file) => readerFor(file.path) === 'metacog_read_document').length
    if (officeCount > 0) {
      lines.push(`  其中 ${officeCount} 个是文档（docx/xlsx/pptx/pdf），用 metacog_read_document 读正文。`)
    }
    if (binaryCount > 0) {
      lines.push(`  其中 ${binaryCount} 个（图片/压缩包）没有可用的读取工具，只能按标题与大小判断。`)
    }
    for (const file of shown) lines.push(`  ${file.path}`)
    if (group.length > shown.length) lines.push(`  …另有 ${group.length - shown.length} 个`)
  }

  const code = usable.filter((f) => f.category === 'code')
  if (code.length > 0) {
    const top = code.slice(0, 12).map((f) => f.path)
    lines.push('')
    lines.push(`代码（${code.length} 个，通常不必读，仅供判断在做什么）`)
    for (const path of top) lines.push(`  ${path}`)
  }

  const raw = scan.files.filter((f) => f.category === 'raw-data')
  if (raw.length > 0) {
    const dirs = new Map<string, number>()
    for (const file of raw) {
      const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '.'
      dirs.set(dir, (dirs.get(dir) ?? 0) + 1)
    }
    const top = [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    lines.push('')
    lines.push(`原始数据（${raw.length} 个，不要读，只列目录让你知道规模）`)
    for (const [dir, count] of top) lines.push(`  ${dir}/ — ${count} 个`)
  }

  return lines.join('\n')
}

/**
 * Extensions the host's `read` tool can decode as text.
 *
 * Everything else — Office archives (docx/xlsx/pptx), PDF, images — is a binary
 * container. `read` refuses those with "Path is a binary file", which a model
 * easily misreads as "this project is unreadable" and then abandons the material
 * altogether. Naming the unreadable files up front keeps that mistake from
 * happening: the model knows to judge them by title and size instead of spending
 * a call to discover the refusal.
 */
export const TEXT_READABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.rst',
  '.org',
  '.csv',
  '.tsv',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.log',
  '.html',
  '.htm',
  '.xml',
  '.tex',
  '.bib',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.m',
  '.r',
  '.jl',
  '.sh',
  '.ps1',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.java',
  '.go',
  '.rs',
  '.sql',
  '.css',
])

/**
 * Which tool can actually return this file's content.
 *
 * `read` handles text; Office containers need `metacog_read_document`; everything
 * else (PDF, images, archives) has no reader here and must be judged by metadata.
 * Naming the reader up front is the difference between a model that opens the
 * right document and one that probes with `read` until it gives up.
 *
 * @param path - normalized project-relative path.
 */
export function readerFor(path: string): 'read' | 'metacog_read_document' | null {
  if (isTextReadable(path)) return 'read'
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const extension = dot < 0 ? '' : lower.slice(dot)
  return OFFICE_READABLE_EXTENSIONS.has(extension) ? 'metacog_read_document' : null
}

/**
 * Document formats the in-plugin extractor can decode: OOXML containers plus PDF.
 *
 * PDF is included because `extractPdfText` delegates to pypdf when Python is
 * present. Without Python the tool refuses with an explicit reason, which is still
 * more useful to a caller than "unreadable".
 */
export const OFFICE_READABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf',
  '.docx',
  '.docm',
  '.xlsx',
  '.xlsm',
  '.pptx',
  '.pptm',
])

/**
 * Whether `read` can return this file's text.
 *
 * @param path - normalized project-relative path.
 */
export function isTextReadable(path: string): boolean {
  const lower = path.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return false
  return TEXT_READABLE_EXTENSIONS.has(lower.slice(dot))
}

// ---------------------------------------------------------------- task directories

/**
 * One directory treated as a candidate task.
 *
 * The flat file list answers "what is in the workspace"; this answers "how many
 * separate pieces of work are in it". A project whose files cluster into five
 * directories is five tasks, and a derivation that never hears that keeps
 * producing five goals from whichever documents happened to be opened — or, in
 * the case this was written for, four, silently dropping an entire 118-file
 * directory because no file from it was ever read.
 */
export interface TaskDirectory {
  /** Project-relative directory path, no trailing slash. */
  path: string
  /** Last path segment, the human-facing name. */
  name: string
  files: number
  bytes: number
  categories: Record<MaterialCategory, number>
  /** Epoch millis of the newest file, or 0 when the group is empty. */
  latestModifiedAt: number
  /** Basename of that newest file, so the date has a subject. */
  latestFileName: string
  /** Directory names in the first two levels below this task, `a/`, `a/b/`. */
  subdirectories: string[]
  /** Highest-weight files below this task, project-relative. */
  topFiles: string[]
}

/** The directory level that was read as "one directory = one task". */
export interface TaskDirectoryView {
  /** 1 = top-level directories are the tasks; 2 = descended one level. */
  level: number
  /** Why this level was chosen, stated as the counts that decided it. */
  reason: string
  roots: TaskDirectory[]
  /** Files sitting directly in the workspace root, counted separately. */
  rootFiles: number
  totalFiles: number
}

/** At least this many directories must exist to read a level as task-level. */
const MIN_TASK_DIRS = 2
/** Share of non-root files one directory must hold before it counts as a wrapper. */
const WRAPPER_SHARE = 0.8

function emptyCategories(): Record<MaterialCategory, number> {
  return { document: 0, result: 0, code: 0, 'raw-data': 0 }
}

/** A document or a result outranks code, and code outranks raw data. */
function categoryWeight(category: MaterialCategory): number {
  if (category === 'document' || category === 'result') return 3
  return category === 'code' ? 2 : 1
}

/** Whether a directory name can stand for a task. */
function isTaskLevelName(name: string, excluded: ReadonlySet<string>): boolean {
  const lower = name.toLowerCase()
  return !lower.startsWith('_') && !lower.startsWith('.') && !excluded.has(lower)
}

/** Group files by the first `level` path segments; files shallower than that are skipped. */
function groupByLevel(
  files: readonly MaterialFile[],
  level: number,
  excluded: ReadonlySet<string>,
): Map<string, MaterialFile[]> {
  const groups = new Map<string, MaterialFile[]>()
  for (const file of files) {
    const segments = file.path.split('/')
    if (segments.length <= level) continue
    const key = segments.slice(0, level).join('/')
    // Exclusions apply to every segment the key is made of, so `_work/x` and
    // `proj/.cache` never become tasks.
    if (segments.slice(0, level).some((segment) => !isTaskLevelName(segment, excluded))) continue
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [file])
    else bucket.push(file)
  }
  return groups
}

function buildTaskDirectory(
  path: string,
  files: readonly MaterialFile[],
  level: number,
): TaskDirectory {
  const categories = emptyCategories()
  let bytes = 0
  let latestModifiedAt = 0
  let latestFileName = ''
  const subdirectoryCounts = new Map<string, number>()
  for (const file of files) {
    categories[file.category] += 1
    bytes += file.bytes
    if (file.modifiedAt > latestModifiedAt) {
      latestModifiedAt = file.modifiedAt
      latestFileName = file.path.split('/').pop() ?? file.path
    }
    const relative = file.path.split('/').slice(level, -1)
    for (let depth = 0; depth < Math.min(2, relative.length); depth += 1) {
      const key = `${relative.slice(0, depth + 1).join('/')}/`
      subdirectoryCounts.set(key, (subdirectoryCounts.get(key) ?? 0) + 1)
    }
  }
  const subdirectories = [...subdirectoryCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([name]) => name)
  const topFiles = files
    .filter((file) => !isUnnamedDocument(file.path) && !isScratchPath(file.path))
    .slice()
    .sort(
      (left, right) =>
        categoryWeight(right.category) * 1e15 + right.bytes -
        (categoryWeight(left.category) * 1e15 + left.bytes),
    )
    .slice(0, 5)
    .map((file) => file.path)
  return {
    path,
    name: path.split('/').pop() ?? path,
    files: files.length,
    bytes,
    categories,
    latestModifiedAt,
    latestFileName,
    subdirectories,
    topFiles,
  }
}

/**
 * Read the workspace as "how many separate tasks are in here".
 *
 * The level is decided by the counts, not configured: top-level directories are
 * tasks when there are several of them. When there is exactly one and it holds
 * most of the files, that directory is a wrapper (a project checked out into a
 * single folder) and the level below it is read instead. A fixed depth would
 * have to be wrong for one of those two shapes.
 *
 * @param scan - material scan to aggregate.
 * @param options - override the infrastructure directory list.
 */
export function taskDirectoryView(
  scan: MaterialScan,
  options: { excludedDirs?: readonly string[] } = {},
): TaskDirectoryView {
  const excluded = new Set(
    (options.excludedDirs ?? DEFAULT_EXCLUDED_DIRS).map((name) => name.toLowerCase()),
  )
  const files = scan.files
  const firstLevel = groupByLevel(files, 1, excluded)
  const nonRoot = [...firstLevel.values()].reduce((sum, group) => sum + group.length, 0)
  // Files sitting directly in the workspace root. Files under an excluded
  // directory (`_work/`, `node_modules/`) are neither tasks nor root files.
  const rootFiles = files.filter((file) => !file.path.includes('/')).length

  let level = 1
  let groups = firstLevel
  let reason = `顶层有 ${firstLevel.size} 个目录，按顶层目录判定任务`

  const only = firstLevel.size === 1 ? [...firstLevel.entries()][0] : undefined
  if (only !== undefined && nonRoot > 0 && only[1].length / nonRoot >= WRAPPER_SHARE) {
    const secondLevel = groupByLevel(files, 2, excluded)
    if (secondLevel.size >= MIN_TASK_DIRS) {
      level = 2
      groups = secondLevel
      reason =
        `顶层只有「${only[0]}/」一个目录，却占了 ${Math.round((only[1].length / nonRoot) * 100)}% 的文件，` +
        `按占比下探一层后得到 ${secondLevel.size} 个目录`
    }
  }

  const roots = [...groups.entries()]
    .map(([path, group]) => buildTaskDirectory(path, group, level))
    .sort((left, right) => right.files - left.files)
  return { level, reason, roots, rootFiles, totalFiles: files.length }
}

/**
 * Render {@link TaskDirectoryView} for a model.
 *
 * Carries the numbers, not just the names: "38 files, 30 of them documents,
 * newest 2026-09-12" is what makes a directory a task the model can reason
 * about; a bare name invites it to treat the directory as a document title and
 * transcribe it.
 *
 * @param view - aggregated view.
 */
export function renderTaskDirectories(view: TaskDirectoryView): string {
  if (view.roots.length === 0) {
    return '任务级目录：0 个（文件都在工作区根目录下，没有按目录组织）。'
  }
  const lines: string[] = [
    `任务级目录：${view.roots.length} 个（判定层级：第 ${view.level} 层；${view.reason}）。`,
    `工作区根目录下另有 ${view.rootFiles} 个文件，不属于任何任务目录。`,
  ]
  for (const root of view.roots) {
    const counts =
      `文档 ${root.categories.document}、结果 ${root.categories.result}、` +
      `代码 ${root.categories.code}、数据 ${root.categories['raw-data']}`
    const latest =
      root.latestModifiedAt > 0
        ? `${new Date(root.latestModifiedAt).toISOString().slice(0, 10)}（${root.latestFileName}）`
        : '未知'
    lines.push(`- ${root.path}/ — ${root.files} 个文件（${counts}），最新改动 ${latest}`)
    if (root.subdirectories.length > 0) {
      lines.push(`    子目录：${root.subdirectories.join('、')}`)
    }
    if (root.topFiles.length > 0) {
      lines.push(`    代表文件：${root.topFiles.join('、')}`)
    }
  }
  return lines.join('\n')
}
