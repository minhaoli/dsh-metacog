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
/** Result of one extraction attempt. */
export type ExtractionResult = {
    readonly ok: true;
    readonly text: string;
    readonly note: string;
    /**
     * Set when the text was cut to fit `maxChars`. Callers that need to know
     * whether they saw the whole document read this instead of parsing the
     * marker out of the text.
     */
    readonly truncated?: boolean;
    /** Length before truncation; absent when nothing was cut. */
    readonly totalChars?: number;
} | {
    readonly ok: false;
    readonly reason: string;
};
/** Office formats this module can decode. */
export declare const OFFICE_EXTENSIONS: ReadonlySet<string>;
/**
 * Extract the plain text of an Office document.
 *
 * @param absolutePath - path on disk.
 * @param maxChars - hard cap on the returned text; the tail is cut, not the head.
 * @returns extracted text, or an honest reason why it could not be read.
 */
export declare function extractOfficeText(absolutePath: string, maxChars?: number): Promise<ExtractionResult>;
