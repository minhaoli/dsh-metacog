/**
 * `metacog_scan`: report what the project contains, without deriving anything.
 *
 * The derivation prompt shows titles first and lets the model decide which files
 * to open, but until this tool existed the only way to obtain that list was to
 * run `goal_tree_init`, which spends a model call on derivation. A model that
 * merely wants to show the user "here is what I found" had no cheap first step,
 * and the obvious substitute does not exist: `read` refuses a directory, so
 * probing one returns a binary-file error rather than a listing.
 *
 * Nothing here reaches a model, and nothing is written.
 *
 * @module dsh-metacog/tools/scan
 */
import { discoverMaterials, readerFor, summarize, taskDirectoryView } from '../evidence/discover.js'
import { defineMetacogTool, deriveProjectId, type ToolEnvironment } from './shared.js'
import type { ToolDefinition } from '../host.js'

/** What `metacog_scan` returns. */
export interface ScanResult {
  projectId: string
  projectRoot: string
  /** Files per category. Always complete, independent of `limit`. */
  counts: Record<string, number>
  totalFiles: number
  listed: number
  truncated: number
  seen: number
  /**
   * One row per file. `readable` is true only for text `read` can decode;
   * `reader` names the tool that can actually return the content, and is null
   * when nothing here can (PDF, images, archives).
   */
  files: {
    path: string
    category: string
    bytes: number
    readable: boolean
    reader: 'read' | 'metacog_read_document' | null
  }[]
  skippedDirs: { path: string; reason: string }[]
  warnings: string[]
  next: string
}

/** Default number of paths returned. */
const DEFAULT_LIMIT = 200

/**
 * Display order for the flat list.
 *
 * Walk order is useless to a caller here: a project with thousands of scratch
 * scripts at its root filled an entire page with `code` and showed no document at
 * all, which defeats the point of asking what the project contains. Documents and
 * results carry the intent; code and data support it.
 */
const CATEGORY_RANK: Readonly<Record<string, number>> = {
  document: 0,
  result: 1,
  code: 2,
  'raw-data': 3,
}

/** Hard ceiling, so one call cannot flood the context. */
const MAX_LIMIT = 2000

/**
 * Register `metacog_scan`.
 *
 * @param env - shared tool environment.
 */
export function metacogScanTool(env: ToolEnvironment): ToolDefinition {
  return defineMetacogTool<ScanResult>({
    name: 'metacog_scan',
    description:
      'List the files a derivation would consider, without running any model call and without ' +
      'writing anything. Returns counts per category, the paths, the directories that were ' +
      'skipped and why. Use this first when you need to show the user what the project actually ' +
      'contains: `read` rejects a directory, so probing one returns a binary-file error instead ' +
      'of a listing. Cached derivation results are not consulted; this always reflects disk.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: `How many paths to return, ordered by category (documents and results first, then newest first within each). Defaults to ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}. The per-category counts are always complete.`,
        },
      },
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    async run(args, exec) {
      const input = (args ?? {}) as { limit?: number }
      const projectRoot = await env.resolveProjectRoot(exec)
      const projectId = deriveProjectId(projectRoot)
      const scan = await discoverMaterials(projectRoot)
      const counts = summarize(scan)
      // The flat file list hides the most useful fact about a workspace: how
      // many separate tasks it holds. The directory view states that as counts
      // (files, categories, newest change) rather than as names only, so the
      // caller can tell five task directories from five folders of scratch data.
      const directories = taskDirectoryView(scan)

      const requested =
        typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0
          ? Math.min(Math.floor(input.limit), MAX_LIMIT)
          : DEFAULT_LIMIT
      // Ordered, not merely truncated: within a category the newest file is the
      // most likely to explain what the project is doing now.
      const ordered = [...scan.files].sort((left, right) => {
        const byCategory =
          (CATEGORY_RANK[left.category] ?? 4) - (CATEGORY_RANK[right.category] ?? 4)
        return byCategory !== 0 ? byCategory : right.modifiedAt - left.modifiedAt
      })
      const listed = ordered.slice(0, requested).map((file) => ({
        path: file.path,
        category: file.category,
        bytes: file.bytes,
        readable: readerFor(file.path) === 'read',
        reader: readerFor(file.path),
      }))

      return {
        projectId,
        projectRoot,
        counts,
        totalFiles: scan.files.length,
        listed: listed.length,
        // Both sources of omission are reported as one number: files beyond the
        // discovery cap, plus files the caller's own limit excluded.
        truncated: scan.truncated + Math.max(0, scan.files.length - listed.length),
        seen: scan.seen,
        files: listed,
        // "How many separate tasks are here", decided by the file counts rather
        // than by a fixed directory depth.
        directories,
        skippedDirs: scan.skippedDirs.slice(0, 20),
        warnings: scan.warnings,
        next:
          '把清单摊给用户看，再调用 goal_tree_init 推导（先给结果，不必先问）。' +
          '要看某个子目录里有什么用 glob；reader=read 的用 read，' +
          'reader=metacog_read_document 的用该工具取正文（Office 与 PDF），' +
          'reader=null 的（图片/压缩包）按标题与大小判断，别去试读。',
      }
    },
  })
}
