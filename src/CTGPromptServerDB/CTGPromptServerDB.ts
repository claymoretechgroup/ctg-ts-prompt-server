// Dependencies:
import { readFileSync } from "node:fs";                          // Loads schema.sql at database open
import { DatabaseSync } from "node:sqlite";                       // Synchronous SQLite database required by spec2
import CTGPromptServerError from "../CTGPromptServerError/CTGPromptServerError.js"; // Normalized server errors

// Type dependencies:
import type {
    CTGPromptPagination,                                          // Spec2 pagination query
    CTGPromptPaginationPage,                                      // Spec2 pagination page
    CTGPromptServerDBConfig,                                      // DB factory config
    CTGPromptServerQueueRecord,                                   // Spec2 durable queue record
    RunnerKind                                                    // Runner kind literals
} from "../types.js";
import type {
    PromptRow,                                                    // Raw prompt table row
    SchemaRow,                                                    // Raw sqlite_master row
    TableInfoRow                                                  // Raw PRAGMA table_info row
} from "./types.js";

/**
 *
 * Constants
 *
 */

const STATUS = {
    PENDING: 1,
    ACTIVE: 2,
    DONE: 3,
    ERROR: -1,
    CANCELLED: 5
} as const;

/**
 *
 * Class
 *
 */

// Synchronous SQLite prompt queue record store.
export default class CTGPromptServerDB {

    /* Instance Fields */
    private readonly _db: DatabaseSync;                           // Underlying SQLite connection

    // CONSTRUCTOR :: ctgPromptServerDBConfig -> this
    // Opens the SQLite database and creates or verifies the required schema.
    private constructor(config: CTGPromptServerDBConfig) {
        this._db = new DatabaseSync(config.path);
        this._db.exec("PRAGMA journal_mode = WAL;");
        this._db.exec("PRAGMA foreign_keys = ON;");
        this._db.exec("PRAGMA busy_timeout = 5000;");
        openSchema(this._db, config.initDB ?? true);
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: STRING -> ctgPromptServerQueueRecord
    // Inserts one pending prompt queue record.
    create(prompt: string): CTGPromptServerQueueRecord {
        return transaction(this._db, () => {
            const now = Date.now();
            const result = this._db.prepare(`
                INSERT INTO prompts (status_code, prompt, response, created_at)
                VALUES (?, ?, '', ?)
            `).run(STATUS.PENDING, prompt, now);

            return readRequired(this._db, Number(result.lastInsertRowid));
        });
    }

    // METHOD :: NUMBER -> ctgPromptServerQueueRecord?
    // Reads one prompt queue record by id.
    read(id: number): CTGPromptServerQueueRecord | null {
        const row = this._db.prepare("SELECT * FROM prompts WHERE id = ?").get(id) as PromptRow | undefined;

        return row === undefined ? null : recordFromRow(row);
    }

    // METHOD :: ctgPromptPagination -> ctgPromptPaginationPage
    // Lists records newest first with cursor pagination.
    paginate(pagination: CTGPromptPagination): CTGPromptPaginationPage {
        const filters: string[] = [];
        const params: Array<number | string> = [];

        if (pagination.statusCode !== undefined) {
            filters.push("status_code = ?");
            params.push(pagination.statusCode);
        }
        if (pagination.before !== undefined) {
            filters.push("id < ?");
            params.push(pagination.before);
        }

        const where = filters.length === 0 ? "" : ` WHERE ${filters.join(" AND ")}`;
        const rows = this._db.prepare(`
            SELECT * FROM prompts${where}
            ORDER BY id DESC
            LIMIT ?
        `).all(...params, pagination.limit + 1) as unknown as PromptRow[];
        const hasNext = rows.length > pagination.limit;
        const pageRows = hasNext ? rows.slice(0, pagination.limit) : rows;
        const records = pageRows.map((row) => recordFromRow(row));
        const last = records.at(-1);

        return {
            records,
            nextBefore: hasNext && last !== undefined ? last.id : null
        };
    }

    // METHOD :: ctgPromptServerQueueRecord -> ctgPromptServerQueueRecord
    // Persists mutable record fields.
    update(record: CTGPromptServerQueueRecord): CTGPromptServerQueueRecord {
        return transaction(this._db, () => {
            const result = this._db.prepare(`
                UPDATE prompts
                SET status_code = ?,
                    response = ?,
                    error_code = ?,
                    error_message = ?,
                    runner = ?,
                    started_at = ?,
                    finished_at = ?
                WHERE id = ?
            `).run(
                record.statusCode,
                record.response,
                record.errorCode,
                record.errorMessage,
                record.runner,
                record.startedAt,
                record.finishedAt,
                record.id
            );

            if (Number(result.changes) === 0) {
                throw new CTGPromptServerError(CTGPromptServerError.CODE.PROMPT_NOT_FOUND, "Prompt not found.");
            }

            return readRequired(this._db, record.id);
        });
    }

    // METHOD :: NUMBER -> ctgPromptServerQueueRecord?
    // Deletes one prompt queue record by id.
    delete(id: number): CTGPromptServerQueueRecord | null {
        return transaction(this._db, () => {
            const record = this.read(id);

            if (record === null) {
                return null;
            }

            this._db.prepare("DELETE FROM prompts WHERE id = ?").run(id);

            return record;
        });
    }

    // METHOD :: NUMBER, STRING -> ctgPromptServerQueueRecord
    // Atomically appends response text.
    append(id: number, text: string): CTGPromptServerQueueRecord {
        return transaction(this._db, () => {
            const result = this._db.prepare(`
                UPDATE prompts
                SET response = response || ?
                WHERE id = ?
            `).run(text, id);

            if (Number(result.changes) === 0) {
                throw new CTGPromptServerError(CTGPromptServerError.CODE.PROMPT_NOT_FOUND, "Prompt not found.");
            }

            return readRequired(this._db, id);
        });
    }

    // METHOD :: VOID -> ctgPromptServerQueueRecord?
    // Claims the oldest pending prompt.
    claimNext(): CTGPromptServerQueueRecord | null {
        return transaction(this._db, () => {
            while (true) {
                const row = this._db.prepare(`
                    SELECT * FROM prompts
                    WHERE status_code = ?
                    ORDER BY id ASC
                    LIMIT 1
                `).get(STATUS.PENDING) as PromptRow | undefined;

                if (row === undefined) {
                    return null;
                }

                const id = numberFrom(row.id);
                const startedAt = Date.now();
                const update = this._db.prepare(`
                    UPDATE prompts
                    SET status_code = ?, started_at = ?
                    WHERE id = ? AND status_code = ?
                `).run(STATUS.ACTIVE, startedAt, id, STATUS.PENDING);

                if (Number(update.changes) === 0) {
                    continue;
                }

                return readRequired(this._db, id);
            }
        });
    }

    // METHOD :: NUMBER, OBJECT -> ctgPromptServerQueueRecord
    // Moves a record to a terminal done or error status.
    finish(id: number, outcome: {
        readonly statusCode: number;
        readonly response?: string;
        readonly errorCode?: number;
        readonly errorMessage?: string;
    }): CTGPromptServerQueueRecord {
        return transaction(this._db, () => {
            const existing = this.read(id);

            if (existing === null) {
                throw new CTGPromptServerError(CTGPromptServerError.CODE.PROMPT_NOT_FOUND, "Prompt not found.");
            }

            const finishedAt = Date.now();

            if (outcome.statusCode === STATUS.DONE) {
                this._db.prepare(`
                    UPDATE prompts
                    SET status_code = ?, response = ?, error_code = NULL, error_message = NULL, finished_at = ?
                    WHERE id = ?
                `).run(STATUS.DONE, outcome.response ?? existing.response, finishedAt, id);

                return readRequired(this._db, id);
            }

            if (outcome.statusCode === STATUS.ERROR) {
                this._db.prepare(`
                    UPDATE prompts
                    SET status_code = ?, error_code = ?, error_message = ?, finished_at = ?
                    WHERE id = ?
                `).run(
                    STATUS.ERROR,
                    outcome.errorCode ?? CTGPromptServerError.CODE.INTERNAL_ERROR,
                    outcome.errorMessage ?? "Internal error.",
                    finishedAt,
                    id
                );

                return readRequired(this._db, id);
            }

            throw new CTGPromptServerError(CTGPromptServerError.CODE.INTERNAL_ERROR, "Invalid finish status code.", {
                statusCode: outcome.statusCode
            });
        });
    }

    // METHOD :: NUMBER -> ctgPromptServerQueueRecord
    // Cancels only pending records.
    cancel(id: number): CTGPromptServerQueueRecord {
        return transaction(this._db, () => {
            const existing = this.read(id);

            if (existing === null) {
                throw new CTGPromptServerError(CTGPromptServerError.CODE.PROMPT_NOT_FOUND, "Prompt not found.");
            }
            if (existing.statusCode !== STATUS.PENDING) {
                throw new CTGPromptServerError(CTGPromptServerError.CODE.CANCEL_NOT_ALLOWED, "The prompt cannot be cancelled.", {
                    id,
                    statusCode: existing.statusCode
                });
            }

            const finishedAt = Date.now();

            this._db.prepare(`
                UPDATE prompts
                SET status_code = ?, finished_at = ?
                WHERE id = ? AND status_code = ?
            `).run(STATUS.CANCELLED, finishedAt, id, STATUS.PENDING);

            return readRequired(this._db, id);
        });
    }

    // METHOD :: VOID -> NUMBER
    // Interrupts active prompts from a previous process.
    interruptActive(): number {
        return transaction(this._db, () => {
            const now = Date.now();
            const message = "The prompt was active when the server stopped.";
            const result = this._db.prepare(`
                UPDATE prompts
                SET status_code = ?, error_code = ?, error_message = ?, finished_at = ?
                WHERE status_code = ?
            `).run(
                STATUS.ERROR,
                CTGPromptServerError.CODE.PROMPT_INTERRUPTED,
                message,
                now,
                STATUS.ACTIVE
            );

            return Number(result.changes);
        });
    }

    // METHOD :: VOID -> NUMBER
    // Deletes terminal prompt records.
    purgeFinished(): number {
        return transaction(this._db, () => {
            const result = this._db.prepare(`
                DELETE FROM prompts
                WHERE status_code IN (?, ?, ?)
            `).run(STATUS.DONE, STATUS.ERROR, STATUS.CANCELLED);

            return Number(result.changes);
        });
    }

    // METHOD :: VOID -> NUMBER
    // Deletes every prompt record.
    purgeAll(): number {
        return transaction(this._db, () => {
            const result = this._db.prepare("DELETE FROM prompts").run();

            return Number(result.changes);
        });
    }

    // METHOD :: VOID -> VOID
    // Drops and recreates the spec2 schema.
    reset(): void {
        transaction(this._db, () => {
            this._db.exec("DROP TABLE IF EXISTS prompts;");
            this._db.exec(schemaSQL());
        });
    }

    // METHOD :: VOID -> VOID
    // Closes the SQLite handle.
    close(): void {
        if (this._db.isOpen) {
            this._db.close();
        }
    }

    /**
     *
     * Static Methods
     *
     */

    // Static Factory Method :: ctgPromptServerDBConfig -> ctgPromptServerDB
    // Opens a prompt database.
    static init(config: CTGPromptServerDBConfig): CTGPromptServerDB {
        return new this(config);
    }
}

/**
 *
 * Module Helpers
 *
 */

// FUNCTION :: databaseSync, BOOLEAN -> VOID
// Creates or verifies the prompt schema after pragmas are applied.
const openSchema = (db: DatabaseSync, initDB: boolean): void => {
    if (hasPromptsTable(db)) {
        if (hasSpec2Columns(db)) {
            return;
        }

        db.close();
        throw new CTGPromptServerError(CTGPromptServerError.CODE.INVALID_CONFIG, "Database prompts table is not spec2-compatible.");
    }
    if (initDB) {
        db.exec(schemaSQL());
        return;
    }

    db.close();
    throw new CTGPromptServerError(CTGPromptServerError.CODE.INVALID_CONFIG, "Database has no prompts table; enable initDB.");
};

// FUNCTION :: databaseSync -> BOOLEAN
// Checks whether the prompts table exists.
const hasPromptsTable = (db: DatabaseSync): boolean => {
    const row = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'prompts'
    `).get() as SchemaRow | undefined;

    return row !== undefined;
};

// FUNCTION :: databaseSync -> BOOLEAN
// Checks whether the existing prompts table has the spec2 shape.
const hasSpec2Columns = (db: DatabaseSync): boolean => {
    const rows = db.prepare("PRAGMA table_info(prompts)").all() as unknown as TableInfoRow[];
    const names = new Set(rows.map((row) => String(row.name)));

    return names.has("status_code")
        && names.has("error_code")
        && !names.has("status")
        && !names.has("error_type")
        && !names.has("info")
        && !names.has("next_sequence");
};

// FUNCTION :: databaseSync, NUMBER -> ctgPromptServerQueueRecord
// Reads an existing record or throws PROMPT_NOT_FOUND.
const readRequired = (db: DatabaseSync, id: number): CTGPromptServerQueueRecord => {
    const row = db.prepare("SELECT * FROM prompts WHERE id = ?").get(id) as PromptRow | undefined;

    if (row === undefined) {
        throw new CTGPromptServerError(CTGPromptServerError.CODE.PROMPT_NOT_FOUND, "Prompt not found.");
    }

    return recordFromRow(row);
};

// FUNCTION :: databaseSync, FUNCTION -> UNKNOWN
// Runs a synchronous operation in one SQLite transaction.
const transaction = <Result>(db: DatabaseSync, fn: () => Result): Result => {
    db.exec("BEGIN IMMEDIATE;");
    try {
        const result = fn();

        db.exec("COMMIT;");
        return result;
    } catch (caught) {
        if (db.isOpen && db.isTransaction) {
            db.exec("ROLLBACK;");
        }
        throw caught;
    }
};

// FUNCTION :: VOID -> STRING
// Reads the package root schema SQL.
const schemaSQL = (): string => {
    return readFileSync(new URL("../../schema.sql", import.meta.url), "utf8");
};

// FUNCTION :: UNKNOWN -> NUMBER
// Narrows a SQLite number field.
const numberFrom = (value: unknown): number => {
    return typeof value === "bigint" ? Number(value) : Number(value);
};

// FUNCTION :: UNKNOWN -> STRING?
// Converts a nullable SQLite text field.
const nullableString = (value: unknown): string | null => {
    return typeof value === "string" ? value : null;
};

// FUNCTION :: UNKNOWN -> NUMBER?
// Converts a nullable SQLite integer field.
const nullableNumber = (value: unknown): number | null => {
    return value === null || value === undefined ? null : numberFrom(value);
};

// FUNCTION :: promptRow -> ctgPromptServerQueueRecord
// Maps a database prompt row to the spec2 queue record shape.
const recordFromRow = (row: PromptRow): CTGPromptServerQueueRecord => {
    return {
        id: numberFrom(row.id),
        statusCode: numberFrom(row.status_code),
        prompt: String(row.prompt),
        response: String(row.response),
        errorCode: nullableNumber(row.error_code),
        errorMessage: nullableString(row.error_message),
        runner: nullableString(row.runner) as RunnerKind | null,
        createdAt: numberFrom(row.created_at),
        startedAt: nullableNumber(row.started_at),
        finishedAt: nullableNumber(row.finished_at)
    };
};
