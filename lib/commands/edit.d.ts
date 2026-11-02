/** What one parsed command line asks for. */
export interface ParsedEdit {
    /** `set` assigns fields on an existing node; `add` creates a goal. */
    action: 'set' | 'add';
    /** Node id or exact title for `set`. */
    target?: string;
    fields: Record<string, string | number | string[]>;
    /** Required for every write; becomes the audit reason. */
    reason: string;
    /** `--force` marks a second confirmation for L0 / core changes. */
    confirmed: boolean;
}
/**
 * Split a command line into tokens, keeping `--key=value` and quoted values.
 *
 * The value may contain spaces when quoted; `--successCriteria="a, b"` becomes
 * one token with the quotes already stripped.
 *
 * @param raw - everything after the command name.
 * @returns tokens in order.
 */
export declare function tokenize(raw: string): string[];
/**
 * Parse one `/metacog-goal` line.
 *
 * @param raw - everything after the command name.
 * @returns the parsed request.
 * @throws {GateError} when a required part is missing or a value is invalid.
 */
export declare function parseGoalCommand(raw: string): ParsedEdit;
/**
 * Parse one `/metacog-contradiction` line.
 *
 * @param raw - everything after the command name.
 * @returns the parsed request.
 * @throws {GateError} when a required part is missing or a value is invalid.
 */
export declare function parseContradictionCommand(raw: string): ParsedEdit;
/** What the caller reports back after the write settled. */
export interface EditOutcome {
    readonly version: number;
    readonly auditEntryId: string;
    readonly auditAction?: string;
    readonly changed: readonly string[];
    readonly added?: readonly string[];
    readonly removed?: readonly string[];
}
/**
 * Format one successful edit for the user.
 *
 * @param outcome - what the governed write changed.
 * @returns a compact multi-line summary; the version and audit id are always
 *   shown because they are how a later question about this change is answered.
 */
export declare function describeOutcome(outcome: EditOutcome): string;
/** Usage text for `/metacog-goal`, shown when the line cannot be parsed. */
export declare const GOAL_USAGE: string;
/** Usage text for `/metacog-contradiction`. */
export declare const CONTRADICTION_USAGE: string;
