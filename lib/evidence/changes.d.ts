/**
 * File-change detection: what moved since the last look.
 *
 * Everything else in this plugin watches what the *agent* did — tool calls, turn
 * reports. This watches what happened to the *files*, which is the one signal that
 * survives an agent that talks without acting.
 *
 * The rule that matters is not "notice changes" but "do not invent them". A scanner
 * that reports every file every time is noise; one that misses a deletion is worse.
 * So the baseline is a content fingerprint per path, and a change is one of three
 * named things — added, modified, removed — with the paths attached.
 *
 * Cost is bounded by ignoring the directories that are never interesting: build
 * output, dependency trees, the monitor's own storage. Scanning `node_modules`
 * would take minutes and never produce a finding.
 *
 * @module dsh-metacog/evidence/changes
 */
/** One file's identity, as far as change detection is concerned. */
export interface FileFingerprint {
    /** Bytes on disk. */
    size: number;
    /** sha256 of the contents. */
    hash: string;
}
/** One detected change. */
export interface FileChange {
    kind: 'added' | 'modified' | 'removed';
    /** Path relative to the project root, with forward slashes. */
    path: string;
    /** Size after the change; 0 for a removal. */
    size: number;
}
/** A saved baseline plus what changed against it. */
export interface ChangeReport {
    changes: FileChange[];
    /** Files present after the scan. */
    scanned: number;
    /** Paths skipped because they are noise. */
    skipped: number;
    /** Whether a previous baseline existed. */
    hadBaseline: boolean;
}
/**
 * Walk a project and fingerprint its files.
 *
 * @param root - project root.
 * @returns a map from relative path to fingerprint, plus how many were skipped.
 */
export declare function fingerprintTree(root: string): Promise<{
    files: Map<string, FileFingerprint>;
    skipped: number;
}>;
/**
 * Compare two fingerprints.
 *
 * @param previous - baseline, or `undefined` on the first scan.
 * @param current - the tree as it is now.
 * @returns named changes, sorted by kind then path so the output is stable.
 */
export declare function diffFingerprints(previous: Map<string, FileFingerprint> | undefined, current: Map<string, FileFingerprint>): FileChange[];
/**
 * Render changes as activity summaries.
 *
 * One activity per change would flood the stream after a refactor, so the caller
 * gets grouped summaries instead: one line naming how many of each kind, plus the
 * specific paths up to a limit. The limit matters — a summary that names 400 files
 * is not more informative than one that names 5 and says "and 395 more".
 *
 * @param report - the change report.
 * @param limit - how many paths to name per kind.
 * @returns one summary per kind that had changes.
 */
export declare function describeChanges(report: ChangeReport, limit?: number): string[];
