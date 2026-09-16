/**
 *
 * Type Declarations
 *
 */

// TYPE :: ARRAY<STRING, UNKNOWN>
// Raw prompt row returned by node:sqlite.
export interface PromptRow {
    readonly id: unknown;
    readonly status_code: unknown;
    readonly prompt: unknown;
    readonly response: unknown;
    readonly error_code: unknown;
    readonly error_message: unknown;
    readonly runner: unknown;
    readonly created_at: unknown;
    readonly started_at: unknown;
    readonly finished_at: unknown;
}

// TYPE :: ARRAY<STRING, UNKNOWN>
// Raw sqlite_master row used to check for an initialized database.
export interface SchemaRow {
    readonly name: unknown;
}

// TYPE :: ARRAY<STRING, UNKNOWN>
// Raw PRAGMA table_info row.
export interface TableInfoRow {
    readonly name: unknown;
}
