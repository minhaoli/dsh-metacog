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
/** Why a PDF could not be read. Each maps to a different user-facing advice. */
export type PdfFailureCode = 'PDF_NO_PYTHON' | 'PDF_NO_LIBRARY' | 'PDF_ENCRYPTED' | 'PDF_NO_TEXT' | 'PDF_FAILED';
/** Outcome of one extraction attempt. */
export type PdfExtraction = {
    readonly ok: true;
    readonly text: string;
    readonly pages: number;
    readonly note: string;
    /** Set when the text was cut to fit `maxChars`. */
    readonly truncated?: boolean;
    /** Length before truncation; the full length even when nothing was cut. */
    readonly totalChars?: number;
} | {
    readonly ok: false;
    readonly code: PdfFailureCode;
    readonly reason: string;
};
/**
 * Extract text from a PDF.
 *
 * @param absolutePath - file to read; the caller has already confined it to the project.
 * @param maxChars - character budget for the returned text.
 * @param commands - interpreters to try; overridable so tests can simulate absence.
 */
export declare function extractPdfText(absolutePath: string, maxChars: number, commands?: readonly string[]): Promise<PdfExtraction>;
