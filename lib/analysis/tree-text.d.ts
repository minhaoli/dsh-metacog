/**
 * Tree-shaped text for the two trees this plugin builds.
 *
 * A depth-flat listing is not a tree: showing every L2 after every L1 makes a
 * reader think each L2 hangs under all L1s. This module rebuilds the forest
 * from `parentId` and renders it with indentation, so the printed structure is
 * the structure that was actually stored.
 *
 * It is deliberately tolerant of bad data — a preview is exactly where broken
 * parent links surface, and the renderer must show them instead of hanging:
 *
 * - an orphan (`parentId` names no node) becomes a root, marked `[孤立]`;
 * - a cycle is broken at one node, marked `[环断]`, and never walked forever;
 * - siblings sort by `createdAt`, then title, so two renders of the same tree
 *   are identical.
 *
 * @module dsh-metacog/analysis/tree-text
 */
/** The minimum shape any renderable node must expose. */
export interface TreeNodeLike {
    readonly id: string;
    readonly parentId: string | null;
    readonly title: string;
    /** Creation timestamp used as the primary sibling order. */
    readonly createdAt?: string;
}
/** One node in the rebuilt forest. */
export interface ForestNode<T extends TreeNodeLike> {
    readonly node: T;
    readonly children: ForestNode<T>[];
    /** `parentId` named a node that is not present; attached at the root. */
    readonly orphaned: boolean;
    /** This node's parent link was cut to break a cycle. */
    readonly cycleBroken: boolean;
}
/** Result of rebuilding a flat node list into a forest. */
export interface BuildTreeResult<T extends TreeNodeLike> {
    readonly roots: ForestNode<T>[];
    /** Nodes whose parent was missing; also present in `roots`. */
    readonly orphans: T[];
    /** Ids whose parent chain formed a cycle; one of each was cut at the root. */
    readonly cycleIds: string[];
    readonly warnings: string[];
}
/**
 * Rebuild the forest from flat nodes.
 *
 * @param nodes - flat nodes with `id` / `parentId` / `title`.
 * @returns roots, orphans, cycle ids and human-readable warnings.
 */
export declare function buildTree<T extends TreeNodeLike>(nodes: readonly T[]): BuildTreeResult<T>;
/** Options for {@link renderTreeText}. */
export interface RenderTreeOptions {
    /** Prefix placed before a root line; defaults to an empty string. */
    readonly rootPrefix?: string;
}
/**
 * Render a forest as indented plain text.
 *
 * Children use `├─` / `└─` connectors; a parent's vertical bar continues only
 * while it has later siblings. Markers are appended to the title so a broken
 * parent link is visible in the text the user reads, not only in a warning
 * list they may not scroll to.
 *
 * @param forest - roots returned by {@link buildTree}.
 * @param options - rendering knobs.
 * @returns one line per node, depth represented by indentation.
 */
export declare function renderTreeText<T extends TreeNodeLike>(forest: readonly ForestNode<T>[], options?: RenderTreeOptions): string;
