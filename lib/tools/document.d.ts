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
import { type ToolEnvironment } from './shared.js';
import type { ToolDefinition } from '../host.js';
/** What the tool returns. */
export interface ReadDocumentResult {
    path: string;
    format: string;
    /** Which part of the container the text came from, for citation. */
    note: string;
    chars: number;
    truncated: boolean;
    text: string;
}
/** Register `metacog_read_document`. */
export declare function metacogReadDocumentTool(env: ToolEnvironment): ToolDefinition;
