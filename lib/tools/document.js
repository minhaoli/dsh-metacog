/**
 * `metacog_read_document`: read an Office document's text.
 *
 * Exists because the metacognitive session deliberately has no shell. Its `read`
 * tool decodes text only, so on a project whose substance lives in .docx it would
 * either give up or start guessing from filenames. This gives it the content
 * without giving it the ability to write anything.
 *
 * Scope is enforced here rather than trusted from the caller: a path outside the
 * project root is refused, because a read-only guarantee that only holds for
 * relative paths is not a guarantee.
 *
 * @module dsh-metacog/tools/document
 */
import { resolve, sep } from 'node:path';
import { stat } from 'node:fs/promises';
import { extractOfficeText, OFFICE_EXTENSIONS } from '../evidence/ooxml.js';
import { extractPdfText } from '../evidence/pdf.js';
import { GateError } from '../governance.js';
import { defineMetacogTool } from './shared.js';
/** Default character budget for one document. */
const DEFAULT_MAX_CHARS = 8000;
/** Ceiling, so one call cannot flood the context. */
const MAX_CHARS_CEILING = 30_000;
/** PDF is not an OOXML container; it takes a different extraction path. */
const PDF_EXTENSION = '.pdf';
/**
 * Resolve a caller-supplied path inside the project root.
 *
 * @param projectRoot - absolute project root.
 * @param requested - path as the model supplied it.
 * @returns absolute path, guaranteed inside the project.
 * @throws {GateError} `PATH_OUTSIDE_PROJECT` when it escapes.
 */
function resolveInsideProject(projectRoot, requested) {
    const absolute = resolve(projectRoot, requested);
    const root = resolve(projectRoot);
    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
        throw new GateError('PATH_OUTSIDE_PROJECT', `"${requested}" 解析到项目目录之外（${absolute}）。这个工具只能读当前项目里的文件。`, { requested, resolved: absolute, projectRoot: root });
    }
    return absolute;
}
/** Register `metacog_read_document`. */
export function metacogReadDocumentTool(env) {
    return defineMetacogTool({
        name: 'metacog_read_document',
        description: 'Read the text of a document whose bytes the host tool `read` cannot decode: ' +
            '.docx/.xlsx/.pptx are ZIP containers, and .pdf is a different format entirely. ' +
            'Use this instead of retrying `read` on them. Plain text files still go through ' +
            '`read`. PDF extraction needs Python with pypdf on this machine; when it is ' +
            'missing the call is refused with that reason rather than returning empty text. ' +
            'Returns the extracted text plus where it came from, so the caller can cite it.',
        parameters: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '项目内相对路径，或项目内的绝对路径。',
                },
                maxChars: {
                    type: 'integer',
                    description: `最多返回多少字符，默认 ${DEFAULT_MAX_CHARS}，上限 ${MAX_CHARS_CEILING}。`,
                },
            },
            required: ['path'],
            additionalProperties: false,
        },
        outputSchema: { type: 'object' },
        async run(args, exec) {
            const input = (args ?? {});
            const requested = input.path?.trim();
            if (requested === undefined || requested.length === 0) {
                throw new GateError('INVALID_ARGS', 'path is required');
            }
            const projectRoot = await env.resolveProjectRoot(exec);
            const absolute = resolveInsideProject(projectRoot, requested);
            let size;
            try {
                const info = await stat(absolute);
                if (!info.isFile()) {
                    throw new GateError('NOT_A_FILE', `"${requested}" 不是文件。列出目录请用 glob。`);
                }
                size = info.size;
            }
            catch (error) {
                if (error instanceof GateError)
                    throw error;
                throw new GateError('FILE_NOT_FOUND', `读不到 "${requested}"：${String(error)}`);
            }
            if (size === 0)
                throw new GateError('EMPTY_FILE', `"${requested}" 是空文件。`);
            const extension = requested.slice(requested.lastIndexOf('.')).toLowerCase();
            const isPdf = extension === PDF_EXTENSION;
            if (!isPdf && !OFFICE_EXTENSIONS.has(extension)) {
                throw new GateError('NOT_OFFICE', `"${requested}" 不是本工具能读的格式，请直接用 read。` +
                    '本工具只处理 .docx/.xlsx/.pptx 与 .pdf。', { path: requested, extension });
            }
            const budget = typeof input.maxChars === 'number' && Number.isFinite(input.maxChars) && input.maxChars > 0
                ? Math.min(Math.floor(input.maxChars), MAX_CHARS_CEILING)
                : DEFAULT_MAX_CHARS;
            if (isPdf) {
                const extracted = await extractPdfText(absolute, budget);
                if (!extracted.ok) {
                    throw new GateError(extracted.code, `"${requested}" 读不了：${extracted.reason}`, {
                        path: requested,
                        format: 'pdf',
                    });
                }
                return {
                    path: requested,
                    format: 'pdf',
                    note: extracted.note,
                    chars: extracted.text.length,
                    truncated: extracted.text.includes('…（已截断'),
                    text: extracted.text,
                };
            }
            const extracted = await extractOfficeText(absolute, budget);
            if (!extracted.ok) {
                throw new GateError('EXTRACTION_FAILED', `"${requested}" 抽取失败：${extracted.reason}`, {
                    path: requested,
                });
            }
            return {
                path: requested,
                format: extension.replace('.', ''),
                note: extracted.note,
                chars: extracted.text.length,
                truncated: extracted.text.includes('…（已截断'),
                text: extracted.text,
            };
        },
    });
}
