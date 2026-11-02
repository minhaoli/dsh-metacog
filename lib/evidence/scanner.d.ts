/** One piece of traceable support, always tied to a real path or commit. */
export interface EvidenceItem {
    /** Project-relative path, or `git:<sha>` for a commit. */
    ref: string;
    /** Why this is evidence. */
    note: string;
}
/** A candidate node derived from evidence, before the user confirms it. */
export interface CandidateNode {
    /** Stable within one scan; suffixed when generated. */
    slug: string;
    title: string;
    description: string;
    /** The real evidence this candidate is grounded in. */
    evidence: string[];
}
/** Candidate tension derived from documented trade-offs or competing sections. */
export interface CandidateContradiction extends CandidateNode {
    poleA: string;
    poleB: string;
}
/** Everything one scan found, plus what it looked at. */
export interface ScanResult {
    projectRoot: string;
    /** Project-relative paths that were actually read. */
    inspectedPaths: string[];
    /** Paths that exist at the root but were not parsed for candidates. */
    ignoredPaths: string[];
    candidates: {
        l0: CandidateNode | undefined;
        l1: CandidateNode[];
        contradictions: CandidateContradiction[];
    };
    /** Recent commits, `git:<short-sha>` refs usable as evidence. */
    commits: EvidenceItem[];
    /** Non-fatal problems worth surfacing to the user. */
    warnings: string[];
}
/**
 * Render a scan result as a compact human summary.
 *
 * @param scan - the scan to describe.
 */
export declare function describeScan(scan: ScanResult): string;
