import { type ToolEnvironment } from './shared.js';
import type { ToolDefinition } from '../host.js';
/** What `metacog_scan` returns. */
export interface ScanResult {
    projectId: string;
    projectRoot: string;
    /** Files per category. Always complete, independent of `limit`. */
    counts: Record<string, number>;
    totalFiles: number;
    listed: number;
    truncated: number;
    seen: number;
    /**
     * One row per file. `readable` is true only for text `read` can decode;
     * `reader` names the tool that can actually return the content, and is null
     * when nothing here can (PDF, images, archives).
     */
    files: {
        path: string;
        category: string;
        bytes: number;
        readable: boolean;
        reader: 'read' | 'metacog_read_document' | null;
    }[];
    skippedDirs: {
        path: string;
        reason: string;
    }[];
    warnings: string[];
    next: string;
}
/**
 * Register `metacog_scan`.
 *
 * @param env - shared tool environment.
 */
export declare function metacogScanTool(env: ToolEnvironment): ToolDefinition;
