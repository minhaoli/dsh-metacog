/**
 * `metacog_archive`: move a live stream into a dated archive.
 *
 * Exists because the live streams are working sets, not histories. A rule that
 * fired on `read (tool call)` produced 1459 rows that no longer describe anything
 * the monitor believes; left in place they dominate every level count and repeat
 * tally, so the escalation statistics stop meaning what they claim.
 *
 * Archiving rather than deleting keeps the record of what the monitor once said,
 * which is exactly the evidence needed to argue that a rule got better.
 *
 * One tool, two streams, asymmetric defaults:
 *
 * - **Signals are archived by default.** They are the monitor's opinions, they go
 *   stale fastest, and reconciling them costs nothing.
 * - **Activities require an explicit opt-in.** They are the primary evidence — what
 *   actually happened. Archived activities mean every past judgement loses its
 *   record of what it was judging, so a report can no longer be re-derived. Saying
 *   that out loud once is worth the extra parameter.
 *
 * @module dsh-metacog/tools/archive
 */
import { type ToolEnvironment } from './shared.js';
import type { ToolDefinition } from '../host.js';
/** What the tool returns. */
export interface ArchiveResult {
    projectId: string;
    /** Signals moved, or 0 when that stream was not included. */
    signals: number;
    /** Activities moved, or 0 when that stream was not included. */
    activities: number;
    /** Where each archive landed; absent when its stream was empty or not included. */
    paths: string[];
    reason: string;
    next: string;
}
/** Register `metacog_archive`. */
export declare function metacogArchiveTool(env: ToolEnvironment): ToolDefinition;
