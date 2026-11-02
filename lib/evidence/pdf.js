/**
 * PDF text extraction for `metacog_read_document`.
 *
 * PDF is the one format this plugin cannot parse itself. A correct reader needs
 * FlateDecode, cross-reference streams and, for Chinese, embedded CMaps — that is
 * a library, not a helper function, and bundling one would dwarf the rest of the
 * plugin.
 *
 * So extraction delegates to `pypdf` through a short-lived Python process. The
 * cost is an optional dependency; the benefit is that a project whose evidence
 * lives in PDFs stops being unreadable. Everything degrades honestly: when Python
 * or pypdf is absent the caller is told the format is unavailable rather than
 * being handed an empty string that reads like "this document says nothing".
 *
 * @module dsh-metacog/evidence/pdf
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
/**
 * Runs inside the Python child. Kept as a string so the plugin needs no files on
 * disk at run time. Output is JSON on stdout, ASCII-escaped so a Windows console
 * code page cannot corrupt Chinese text on the way back.
 */
const EXTRACT_SCRIPT = `
import json, sys

def emit(payload):
    print(json.dumps(payload, ensure_ascii=True))
    sys.exit(0)

try:
    from pypdf import PdfReader
except Exception as error:                      # noqa: BLE001
    emit({"error": "no_library", "detail": str(error)})

try:
    reader = PdfReader(sys.argv[1])
except Exception as error:                      # noqa: BLE001
    emit({"error": "open_failed", "detail": str(error)})

if reader.is_encrypted:
    try:
        reader.decrypt("")
    except Exception:                           # noqa: BLE001
        emit({"error": "encrypted"})

pages = []
for page in reader.pages:
    try:
        pages.append(page.extract_text() or "")
    except Exception:                           # noqa: BLE001
        pages.append("")

body = "\\n\\n".join(
    "--- 第 %d 页 ---\\n%s" % (index + 1, text) for index, text in enumerate(pages)
)
emit({"pages": len(pages), "text": body})
`;
/** Interpreters to try, in order. */
const PYTHON_COMMANDS = ['python', 'python3'];
/** Ceiling on what the child may print, so one huge PDF cannot exhaust memory. */
const MAX_BUFFER = 64 * 1024 * 1024;
/** How long one extraction may take. */
const TIMEOUT_MS = 60_000;
/**
 * Extract text from a PDF.
 *
 * @param absolutePath - file to read; the caller has already confined it to the project.
 * @param maxChars - character budget for the returned text.
 * @param commands - interpreters to try; overridable so tests can simulate absence.
 */
export async function extractPdfText(absolutePath, maxChars, commands = PYTHON_COMMANDS) {
    let missing;
    for (const command of commands) {
        let stdout;
        try {
            const result = await run(command, ['-c', EXTRACT_SCRIPT, absolutePath], {
                maxBuffer: MAX_BUFFER,
                timeout: TIMEOUT_MS,
                windowsHide: true,
            });
            stdout = result.stdout;
        }
        catch (error) {
            const code = error.code;
            if (code === 'ENOENT') {
                missing = command;
                continue;
            }
            // A sandbox that forbids pipe-backed spawns reports EPERM/EACCES even
            // though the interpreter exists. Treating that as PDF_FAILED would blame
            // the document for a condition the process can never control, so the
            // whole environment is reported as unusable instead.
            if (code === 'EPERM' || code === 'EACCES') {
                missing = command;
                continue;
            }
            // The script exits 0 for every condition it understands, so a non-zero
            // exit means the interpreter itself failed.
            return {
                ok: false,
                code: 'PDF_FAILED',
                reason: `${command} 执行失败：${String(error).slice(0, 200)}`,
            };
        }
        let parsed;
        try {
            parsed = JSON.parse(stdout.trim());
        }
        catch {
            return {
                ok: false,
                code: 'PDF_FAILED',
                reason: `${command} 没有返回可解析的结果：${stdout.slice(0, 120)}`,
            };
        }
        if (parsed.error === 'no_library') {
            return {
                ok: false,
                code: 'PDF_NO_LIBRARY',
                reason: '解释器可用但缺少 pypdf，装一个即可：pip install pypdf',
            };
        }
        if (parsed.error === 'encrypted') {
            return { ok: false, code: 'PDF_ENCRYPTED', reason: 'PDF 已加密，需要密码才能读取' };
        }
        if (parsed.error !== undefined) {
            return {
                ok: false,
                code: 'PDF_FAILED',
                reason: `pypdf 打不开这个文件：${parsed.detail ?? parsed.error}`,
            };
        }
        const text = parsed.text ?? '';
        if (text.trim().length === 0) {
            return {
                ok: false,
                code: 'PDF_NO_TEXT',
                reason: `共 ${parsed.pages ?? 0} 页，但抽不出任何文本——很可能是扫描件（图片型 PDF）。` +
                    '不要假装读过，把它记为未核实的证据。',
            };
        }
        // The marker counts against the budget, not on top of it: a `maxChars`
        // parameter that returns more than `maxChars` is a promise the caller
        // cannot rely on.
        const truncated = text.length > maxChars;
        const marker = `…（已截断，共 ${text.length} 字符）`;
        const keep = maxChars - marker.length;
        const clipped = truncated ? (keep > 0 ? `${text.slice(0, keep)}${marker}` : '') : text;
        return {
            ok: true,
            text: clipped,
            pages: parsed.pages ?? 0,
            note: `PDF 文本层，${parsed.pages ?? 0} 页，由 pypdf 抽取`,
            truncated,
            totalChars: text.length,
        };
    }
    return {
        ok: false,
        code: 'PDF_NO_PYTHON',
        reason: `找不到可用的 Python 解释器（试过 ${commands.join(' / ')}` +
            `${missing === undefined ? '' : `，最后一次失败于 ${missing}`}），无法抽取 PDF 文本。` +
            '可以改用 python 已安装的机器，或先用其他工具把 PDF 转成文本。',
    };
}
