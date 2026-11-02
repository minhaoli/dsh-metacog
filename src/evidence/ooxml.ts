/**
 * Text extraction for Office documents, without a shell and without dependencies.
 *
 * The host's `read` tool decodes text only. An Office file is a ZIP container
 * holding XML, so `read` reports "Path is a binary file" and a metacognitive
 * session — which cannot spawn Python — is left blind on projects whose substance
 * lives entirely in .docx.
 *
 * A ZIP reader is small enough to own: the central directory gives every entry's
 * offset and compression method, and Node's `zlib` already provides `inflateRaw`.
 * That buys real document text with no new dependency and no shell, which matters
 * because the metacog session must stay read-only.
 *
 * PDF is deliberately not supported. It needs a layout-aware parser, and a
 * half-parser that returns scrambled text would be worse than an honest refusal.
 *
 * @module dsh-metacog/evidence/ooxml
 */

import { inflateRawSync } from 'node:zlib'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

/** Result of one extraction attempt. */
export type ExtractionResult =
  | {
      readonly ok: true
      readonly text: string
      readonly note: string
      /**
       * Set when the text was cut to fit `maxChars`. Callers that need to know
       * whether they saw the whole document read this instead of parsing the
       * marker out of the text.
       */
      readonly truncated?: boolean
      /** Length before truncation; absent when nothing was cut. */
      readonly totalChars?: number
    }
  | { readonly ok: false; readonly reason: string }

/** Office formats this module can decode. */
export const OFFICE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.docx',
  '.xlsx',
  '.pptx',
  '.xlsm',
  '.docm',
  '.pptm',
])

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

/** One entry recovered from a ZIP container. */
interface ZipEntry {
  readonly name: string
  readonly method: number
  readonly compressedSize: number
  readonly localOffset: number
}

/**
 * Read a ZIP archive's table of contents.
 *
 * Scans backwards for the end-of-central-directory record: it sits within the
 * last 66 KB by spec, and reading it is the only way to find the directory
 * without assuming the archive has no comment.
 *
 * @param buffer - whole archive.
 * @returns entries in stored order, or an empty list when this is not a ZIP.
 */
function readCentralDirectory(buffer: Buffer): ZipEntry[] {
  const scanFloor = Math.max(0, buffer.length - 66_000)
  let eocd = -1
  for (let offset = buffer.length - 22; offset >= scanFloor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) return []

  const count = buffer.readUInt16LE(eocd + 10)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  let cursor = directoryOffset

  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length) break
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) break
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    entries.push({ name, method, compressedSize, localOffset })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * Extract one entry's bytes.
 *
 * @param buffer - whole archive.
 * @param entry - entry from the central directory.
 * @returns decompressed bytes, or `undefined` when the entry cannot be read.
 */
function readEntry(buffer: Buffer, entry: ZipEntry): Buffer | undefined {
  const local = entry.localOffset
  if (local + 30 > buffer.length) return undefined
  if (buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) return undefined
  // The local header's name/extra lengths differ from the central directory's,
  // so the data offset must be computed from the local header itself.
  const nameLength = buffer.readUInt16LE(local + 26)
  const extraLength = buffer.readUInt16LE(local + 28)
  const start = local + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (end > buffer.length) return undefined
  const raw = buffer.subarray(start, end)
  if (entry.method === 0) return raw
  if (entry.method === 8) {
    try {
      return inflateRawSync(raw)
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Decode the entities that actually appear in OOXML text runs. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

/** Strip tags from one XML fragment, turning structure into whitespace. */
function toText(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<w:p[ >]/g, '\n<w:p ')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/a:p>/g, '\n')
      .replace(/<\/si>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
}

/** Normalize whitespace so a paragraph does not arrive as a column of blanks. */
function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1] !== ''))
    .join('\n')
    .trim()
}

/** Word: one document part holds the body text. */
function extractDocx(buffer: Buffer, entries: ZipEntry[]): ExtractionResult {
  const part = entries.find((entry) => entry.name === 'word/document.xml')
  if (part === undefined) return { ok: false, reason: 'docx 里找不到 word/document.xml' }
  const bytes = readEntry(buffer, part)
  if (bytes === undefined) return { ok: false, reason: 'word/document.xml 解压失败' }
  const text = tidy(toText(bytes.toString('utf8')))
  if (text.length === 0) return { ok: false, reason: 'docx 正文为空' }
  return { ok: true, text, note: 'word/document.xml' }
}

/** PowerPoint: slide parts, ordered numerically rather than lexically. */
function extractPptx(buffer: Buffer, entries: ZipEntry[]): ExtractionResult {
  const slides = entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
    .sort((left, right) => {
      const a = Number(left.name.match(/slide(\d+)\.xml/)?.[1] ?? 0)
      const b = Number(right.name.match(/slide(\d+)\.xml/)?.[1] ?? 0)
      return a - b
    })
  if (slides.length === 0) return { ok: false, reason: 'pptx 里没有幻灯片部件' }

  const chunks: string[] = []
  for (const slide of slides) {
    const bytes = readEntry(buffer, slide)
    if (bytes === undefined) continue
    const label = slide.name.match(/slide(\d+)\.xml/)?.[1] ?? '?'
    const text = tidy(toText(bytes.toString('utf8')))
    if (text.length > 0) chunks.push(`[第 ${label} 页]\n${text}`)
  }
  if (chunks.length === 0) return { ok: false, reason: 'pptx 各页都没有文本' }
  return { ok: true, text: chunks.join('\n\n'), note: `${slides.length} 页幻灯片` }
}

/** Spreadsheet: shared strings plus per-sheet cell values, row by row. */
function extractXlsx(buffer: Buffer, entries: ZipEntry[]): ExtractionResult {
  const sharedPart = entries.find((entry) => entry.name === 'xl/sharedStrings.xml')
  const shared: string[] = []
  if (sharedPart !== undefined) {
    const bytes = readEntry(buffer, sharedPart)
    if (bytes !== undefined) {
      const xml = bytes.toString('utf8')
      for (const match of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
        shared.push(decodeEntities(String(match[1]).replace(/<[^>]+>/g, '')))
      }
    }
  }

  const sheets = entries
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name))
    .sort((left, right) => {
      const a = Number(left.name.match(/sheet(\d+)\.xml/)?.[1] ?? 0)
      const b = Number(right.name.match(/sheet(\d+)\.xml/)?.[1] ?? 0)
      return a - b
    })
  if (sheets.length === 0) return { ok: false, reason: 'xlsx 里没有工作表部件' }

  const chunks: string[] = []
  for (const sheet of sheets) {
    const bytes = readEntry(buffer, sheet)
    if (bytes === undefined) continue
    const xml = bytes.toString('utf8')
    const rows: string[] = []
    for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = []
      for (const cellMatch of String(rowMatch[1]).matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = String(cellMatch[1])
        const body = String(cellMatch[2])
        const value = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
        const inline = body.match(/<is>([\s\S]*?)<\/is>/)?.[1]
        if (inline !== undefined) {
          cells.push(decodeEntities(inline.replace(/<[^>]+>/g, '')))
        } else if (value !== undefined) {
          const isShared = /t="s"/.test(attrs)
          cells.push(isShared ? (shared[Number(value)] ?? '') : decodeEntities(value))
        }
      }
      const line = cells.join('\t').trim()
      if (line.length > 0) rows.push(line)
    }
    const label = sheet.name.match(/sheet(\d+)\.xml/)?.[1] ?? '?'
    if (rows.length > 0) chunks.push(`[工作表 ${label}]\n${rows.join('\n')}`)
  }
  if (chunks.length === 0) return { ok: false, reason: 'xlsx 各工作表都没有数据' }
  return { ok: true, text: chunks.join('\n\n'), note: `${sheets.length} 个工作表` }
}

/**
 * Extract the plain text of an Office document.
 *
 * @param absolutePath - path on disk.
 * @param maxChars - hard cap on the returned text; the tail is cut, not the head.
 * @returns extracted text, or an honest reason why it could not be read.
 */
export async function extractOfficeText(
  absolutePath: string,
  maxChars = 20_000,
): Promise<ExtractionResult> {
  const extension = extname(absolutePath).toLowerCase()
  // Legacy binary formats first: they are not OOXML, so the generic branch below
  // would tell the user "not an Office format", which is untrue and unhelpful.
  if (extension === '.doc' || extension === '.xls' || extension === '.ppt') {
    return {
      ok: false,
      reason: `旧版二进制 Office 格式（${extension}）无法抽取，请另存为 .docx/.xlsx/.pptx 后再读`,
    }
  }
  if (!OFFICE_EXTENSIONS.has(extension)) {
    return {
      ok: false,
      reason:
        `${extension || '该文件'} 不是可抽取的 Office 格式。` +
        '文本文件用 read 直接读；PDF 需要专门的解析器，本插件不提供。',
    }
  }

  let buffer: Buffer
  try {
    buffer = await readFile(absolutePath)
  } catch (error) {
    return { ok: false, reason: `读取失败：${String(error)}` }
  }

  const entries = readCentralDirectory(buffer)
  if (entries.length === 0) {
    return { ok: false, reason: '不是有效的 ZIP 容器，可能已损坏或只是改了扩展名的文件' }
  }

  const result =
    extension === '.docx' || extension === '.docm'
      ? extractDocx(buffer, entries)
      : extension === '.pptx' || extension === '.pptm'
        ? extractPptx(buffer, entries)
        : extractXlsx(buffer, entries)

  if (!result.ok) return result
  if (result.text.length <= maxChars) return result
  // The marker counts against the cap, not on top of it. A parameter named
  // `maxChars` that returns more than `maxChars` characters is a contract the
  // caller cannot rely on — and this string is what every reader checks.
  const marker = `\n…（已截断，原文 ${result.text.length} 字）`
  const keep = maxChars - marker.length
  return {
    ok: true,
    // A budget too small to hold even the marker returns nothing rather than
    // overshooting: the caller asked for a hard cap, not for a hint.
    text: keep > 0 ? `${result.text.slice(0, keep)}${marker}` : '',
    note: result.note,
    truncated: true,
    totalChars: result.text.length,
  }
}
