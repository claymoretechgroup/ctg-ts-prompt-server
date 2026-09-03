// Dependencies:
import { readFileSync } from "node:fs";                      // Loads the package root schema.sql at database open/reset
import { DatabaseSync } from "node:sqlite";                 // Synchronous SQLite database required by the spec
import CTGPromptServerError from "../CTGPromptServerError/CTGPromptServerError.js"; // Typed storage errors

// Type dependencies:
import type {
    AppendedEvent,                                           // Append result shape
    ClaimedPrompt,                                           // Claim result shape
    CTGPromptDBConfig,                                       // DB factory config
    EventRecord,                                             // Durable event record
    PromptEventName,                                         // Event name literals
    PromptListPage,                                          // Prompt list page
    PromptListQuery,                                         // Prompt list query
    PromptOutcome,                                           // Finished outcome data
    PromptOutcomeErrorType,                                  // Outcome error class
    PromptRecord,                                            // Durable prompt record
    PromptStatus,                                            // Prompt status literals
    RunnerKind                                               // Runner kind literals
} from "../types.js";

/**
 *
 * Type Declarations
 *
 */

// TYPE :: ARRAY<STRING, UNKNOWN>
// Raw prompt row returned by node:sqlite.
interface PromptRow {
    readonly id: unknown;                                    // Prompt identity
    readonly status: unknown;                                // Stored lifecycle state
    readonly prompt: unknown;                                // Stored prompt text
    readonly response: unknown;                              // Stored response text
    readonly error_type: unknown;                            // Stored outcome error class
    readonly error_message: unknown;                         // Stored failure message
    readonly info: unknown;                                  // JSON diagnostics text
    readonly runner: unknown;                                // Stored runner kind
    readonly next_sequence: unknown;                         // Next event sequence
    readonly created_at: unknown;                            // Submit timestamp
    readonly started_at: unknown;                            // Claim timestamp
    readonly finished_at: unknown;                           // Finished timestamp
}

// TYPE :: ARRAY<STRING, UNKNOWN>
// Raw event row returned by node:sqlite.
interface EventRow {
    readonly prompt_id: unknown;                             // Owning prompt id
    readonly sequence: unknown;                              // Event sequence
    readonly name: unknown;                                  // Event name
    readonly payload: unknown;                               // JSON payload text
    readonly created_at: unknown;                            // Event timestamp
}

// TYPE :: ARRAY<STRING, UNKNOWN>
// Raw sqlite_master row used to check for an initialized database.
interface SchemaRow {
    readonly name: unknown;                                  // Schema object name
}

/**
 *
 * Class
 *
 */

// Synchronous SQLite prompt and event store.
export default class CTGPromptDB {

    /* Instance Fields */
    private readonly _db: DatabaseSync;                       // Underlying SQLite connection

    // CONSTRUCTOR :: ctgPromptDBConfig -> this
    // Opens the SQLite database and creates or verifies the required schema.
    private constructor(config: CTGPromptDBConfig) {
        this._db = new DatabaseSync(config.path);
        this._db.exec("PRAGMA journal_mode = WAL;");
        this._db.exec("PRAGMA foreign_keys = ON;");
        this._db.exec("PRAGMA busy_timeout = 5000;");
        this._openSchema(config.initDB ?? true);
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: STRING -> promptRecord
    // Inserts a pending prompt and its first lifecycle event.
    insertPrompt(prompt: string): PromptRecord {
        return this._transaction(() => {
            const now = Date.now();
            const result = this._db.prepare(`
                INSERT INTO prompts (status, prompt, response, created_at)
                VALUES ('pending', ?, '', ?)
            `).run(prompt, now);
            const id = Number(result.lastInsertRowid);
            const event = this._appendEventInTransaction(id, "pending", {
                promptId: id,
                status: "pending",
                createdAt: now
            });

            return event.prompt;
        });
    }

    // METHOD :: NUMBER -> promptRecord?
    // Reads one prompt by id.
    readPrompt(id: number): PromptRecord | undefined {
        const row = this._db.prepare("SELECT * FROM prompts WHERE id = ?").get(id) as PromptRow | undefined;

        return row === undefined ? undefined : CTGPromptDB._promptFromRow(row);
    }

    // METHOD :: promptListQuery -> promptListPage
    // Lists prompts newest first with cursor pagination.
    listPrompts(query: PromptListQuery): PromptListPage {
        const limit = query.limit ?? 50;
        const filters: string[] = [];
        const params: Array<string | number> = [];

        if (query.status !== undefined) {
            filters.push("status = ?");
            params.push(query.status);
        }
        if (query.before !== undefined) {
            filters.push("id < ?");
            params.push(query.before);
        }

        const where = filters.length === 0 ? "" : ` WHERE ${filters.join(" AND ")}`;
        const rows = this._db.prepare(`
            SELECT * FROM prompts${where}
            ORDER BY id DESC
            LIMIT ?
        `).all(...params, limit + 1) as unknown as PromptRow[];
        const hasNext = rows.length > limit;
        const pageRows = hasNext ? rows.slice(0, limit) : rows;
        const prompts = pageRows.map((row) => CTGPromptDB._promptFromRow(row));
        const last = prompts.at(-1);

        return {
            prompts,
            nextBefore: hasNext && last !== undefined ? last.id : null
        };
    }

    // METHOD :: runnerKind -> claimedPrompt?
    // Claims the oldest pending prompt and writes the active event.
    claimNextPending(runner: RunnerKind): ClaimedPrompt | undefined {
        return this._transaction(() => {
            while (true) {
                const row = this._db.prepare(`
                    SELECT * FROM prompts
                    WHERE status = 'pending'
                    ORDER BY id ASC
                    LIMIT 1
                `).get() as PromptRow | undefined;

                if (row === undefined) {
                    return undefined;
                }

                const id = CTGPromptDB._number(row.id);
                const startedAt = Date.now();
                const update = this._db.prepare(`
                    UPDATE prompts
                    SET status = 'active', started_at = ?, runner = ?
                    WHERE id = ? AND status = 'pending'
                `).run(startedAt, runner, id);

                if (Number(update.changes) === 0) {
                    continue;
                }

                const appended = this._appendEventInTransaction(id, "active", {
                    promptId: id,
                    status: "active",
                    runner,
                    startedAt
                });

                return {
                    prompt: appended.prompt,
                    event: appended.event
                };
            }
        });
    }

    // METHOD :: NUMBER, promptOutcome -> appendedEvent
    // Records a finished prompt outcome and terminal event.
    finishPrompt(id: number, outcome: PromptOutcome): AppendedEvent {
        return this._transaction(() => {
            const existing = this.readPrompt(id);

            if (existing === undefined) {
                throw new CTGPromptServerError("PROMPT_NOT_FOUND", "Prompt not found.");
            }

            const finishedAt = Date.now();
            const response = outcome.status === "done" ? outcome.response ?? "" : existing.response;
            const errorType = outcome.status === "error" ? outcome.errorType ?? "SERVER" : null;
            const errorMessage = outcome.status === "error" ? outcome.errorMessage ?? "" : null;
            const info = outcome.info === undefined ? null : JSON.stringify(outcome.info);

            this._db.prepare(`
                UPDATE prompts
                SET status = ?, response = ?, error_type = ?, error_message = ?, info = ?, finished_at = ?
                WHERE id = ?
            `).run(outcome.status, response, errorType, errorMessage, info, finishedAt, id);

            if (outcome.status === "done") {
                return this._appendEventInTransaction(id, "done", {
                    promptId: id,
                    status: "done",
                    response,
                    finishedAt
                });
            }

            return this._appendEventInTransaction(id, "error", {
                promptId: id,
                status: "error",
                errorType,
                message: errorMessage,
                finishedAt
            });
        });
    }

    // METHOD :: NUMBER -> appendedEvent
    // Cancels a pending prompt and writes the cancelled event.
    cancelPending(id: number): AppendedEvent {
        return this._transaction(() => {
            const existing = this.readPrompt(id);

            if (existing === undefined) {
                throw new CTGPromptServerError("PROMPT_NOT_FOUND", "Prompt not found.");
            }

            const finishedAt = Date.now();
            const update = this._db.prepare(`
                UPDATE prompts
                SET status = 'cancelled', finished_at = ?
                WHERE id = ? AND status = 'pending'
            `).run(finishedAt, id);

            if (Number(update.changes) === 0) {
                const reread = this.readPrompt(id);

                throw new CTGPromptServerError("CANCEL_NOT_ALLOWED", "The prompt is already finished.", {
                    id,
                    status: reread?.status
                });
            }

            return this._appendEventInTransaction(id, "cancelled", {
                promptId: id,
                status: "cancelled",
                finishedAt
            });
        });
    }

    // METHOD :: VOID -> NUMBER
    // Interrupts active prompts from a previous process.
    interruptActive(): number {
        return this._transaction(() => {
            const rows = this._db.prepare(`
                SELECT * FROM prompts
                WHERE status = 'active'
                ORDER BY id ASC
            `).all() as unknown as PromptRow[];
            const now = Date.now();
            const message = "The prompt was active when the server stopped.";

            this._db.prepare(`
                UPDATE prompts
                SET status = 'error', error_type = 'INTERRUPTED', error_message = ?, finished_at = ?
                WHERE status = 'active'
            `).run(message, now);

            for (const row of rows) {
                const id = CTGPromptDB._number(row.id);

                this._appendEventInTransaction(id, "error", {
                    promptId: id,
                    status: "error",
                    errorType: "INTERRUPTED",
                    message,
                    finishedAt: now
                });
            }

            return rows.length;
        });
    }

    // METHOD :: NUMBER, promptEventName, UNKNOWN, STRING? -> appendedEvent
    // Appends an event and optionally appends response text in the same transaction.
    appendEvent(id: number, name: PromptEventName, payload: unknown, appendResponse?: string): AppendedEvent {
        return this._transaction(() => this._appendEventInTransaction(id, name, payload, appendResponse));
    }

    // METHOD :: NUMBER, NUMBER -> [eventRecord]
    // Reads events after a sequence number.
    readEvents(id: number, afterSequence: number): EventRecord[] {
        const rows = this._db.prepare(`
            SELECT * FROM events
            WHERE prompt_id = ? AND sequence > ?
            ORDER BY sequence ASC
        `).all(id, afterSequence) as unknown as EventRow[];

        return rows.map((row) => CTGPromptDB._eventFromRow(row));
    }

    // METHOD :: NUMBER -> NUMBER
    // Returns the latest event sequence for a prompt.
    lastSequence(id: number): number {
        const record = this.readPrompt(id);

        return record?.lastSequence ?? 0;
    }

    // METHOD :: VOID -> NUMBER
    // Deletes finished prompts and cascaded events.
    purgeFinished(): number {
        return this._transaction(() => {
            const result = this._db.prepare(`
                DELETE FROM prompts
                WHERE status IN ('done', 'error', 'cancelled')
            `).run();

            return Number(result.changes);
        });
    }

    // METHOD :: VOID -> NUMBER
    // Deletes every prompt and cascaded event.
    // WARNING: This empties pending and active work.
    purgeAll(): number {
        return this._transaction(() => {
            const result = this._db.prepare("DELETE FROM prompts").run();

            return Number(result.changes);
        });
    }

    // METHOD :: VOID -> VOID
    // Drops and recreates the prompt schema.
    // WARNING: This deletes all prompt history and restarts ids.
    reset(): void {
        this._transaction(() => {
            this._db.exec("DROP TABLE IF EXISTS events;");
            this._db.exec("DROP TABLE IF EXISTS prompts;");
            this._db.exec(CTGPromptDB._schemaSQL());
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
     * Private Methods
     *
     */

    // METHOD :: BOOLEAN -> VOID
    // Creates or verifies the prompt schema after pragmas are applied.
    private _openSchema(initDB: boolean): void {
        if (this._hasPromptsTable()) {
            return;
        }
        if (initDB) {
            this._db.exec(CTGPromptDB._schemaSQL());
            return;
        }

        this.close();
        throw new CTGPromptServerError("INVALID_CONFIG", "Database has no prompts table; run reset-everything or enable initDB.");
    }

    // METHOD :: VOID -> BOOLEAN
    // Checks whether the prompts table exists.
    private _hasPromptsTable(): boolean {
        const row = this._db.prepare(`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name = 'prompts'
        `).get() as SchemaRow | undefined;

        return row !== undefined;
    }

    // METHOD :: NUMBER, promptEventName, UNKNOWN, STRING? -> appendedEvent
    // Appends an event inside an existing transaction.
    private _appendEventInTransaction(id: number, name: PromptEventName, payload: unknown, appendResponse?: string): AppendedEvent {
        const row = this._db.prepare("SELECT next_sequence FROM prompts WHERE id = ?").get(id) as { next_sequence: unknown } | undefined;

        if (row === undefined) {
            throw new CTGPromptServerError("PROMPT_NOT_FOUND", "Prompt not found.");
        }

        const sequence = CTGPromptDB._number(row.next_sequence);
        const createdAt = Date.now();

        this._db.prepare(`
            INSERT INTO events (prompt_id, sequence, name, payload, created_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(id, sequence, name, JSON.stringify(payload), createdAt);

        if (appendResponse === undefined) {
            this._db.prepare("UPDATE prompts SET next_sequence = next_sequence + 1 WHERE id = ?").run(id);
        } else {
            this._db.prepare("UPDATE prompts SET next_sequence = next_sequence + 1, response = response || ? WHERE id = ?").run(appendResponse, id);
        }

        const prompt = this.readPrompt(id);

        if (prompt === undefined) {
            throw new CTGPromptServerError("PROMPT_NOT_FOUND", "Prompt not found.");
        }

        return {
            prompt,
            event: {
                promptId: id,
                sequence,
                name,
                payload,
                createdAt
            }
        };
    }

    // METHOD :: (VOID -> T) -> T
    // Runs a synchronous operation in one SQLite transaction.
    private _transaction<T>(fn: () => T): T {
        this._db.exec("BEGIN IMMEDIATE;");
        try {
            const result = fn();

            this._db.exec("COMMIT;");
            return result;
        } catch (caught) {
            if (this._db.isOpen && this._db.isTransaction) {
                this._db.exec("ROLLBACK;");
            }
            throw caught;
        }
    }

    /**
     *
     * Static Methods
     *
     */

    // Static Factory Method :: ctgPromptDBConfig -> ctgPromptDB
    // Opens a prompt database.
    static init(config: CTGPromptDBConfig): CTGPromptDB {
        return new this(config);
    }

    /**
     *
     * Private Static Methods
     *
     */

    // METHOD :: VOID -> STRING
    // Reads the package root schema SQL.
    private static _schemaSQL(): string {
        return readFileSync(new URL("../../schema.sql", import.meta.url), "utf8");
    }

    // METHOD :: UNKNOWN -> NUMBER
    // Narrows a SQLite number field.
    private static _number(value: unknown): number {
        return typeof value === "bigint" ? Number(value) : Number(value);
    }

    // METHOD :: UNKNOWN -> STRING?
    // Converts a nullable SQLite text field.
    private static _nullableString(value: unknown): string | null {
        return typeof value === "string" ? value : null;
    }

    // METHOD :: UNKNOWN -> NUMBER?
    // Converts a nullable SQLite integer field.
    private static _nullableNumber(value: unknown): number | null {
        return value === null || value === undefined ? null : CTGPromptDB._number(value);
    }

    // METHOD :: promptRow -> promptRecord
    // Maps a database prompt row to the public record shape.
    private static _promptFromRow(row: PromptRow): PromptRecord {
        const info = typeof row.info === "string" ? JSON.parse(row.info) as Record<string, unknown> : null;

        return {
            id: CTGPromptDB._number(row.id),
            status: row.status as PromptStatus,
            prompt: String(row.prompt),
            response: String(row.response),
            errorType: CTGPromptDB._nullableString(row.error_type) as PromptOutcomeErrorType | null,
            errorMessage: CTGPromptDB._nullableString(row.error_message),
            info: info === null ? null : Object.freeze(info),
            runner: CTGPromptDB._nullableString(row.runner) as RunnerKind | null,
            lastSequence: CTGPromptDB._number(row.next_sequence) - 1,
            createdAt: CTGPromptDB._number(row.created_at),
            startedAt: CTGPromptDB._nullableNumber(row.started_at),
            finishedAt: CTGPromptDB._nullableNumber(row.finished_at)
        };
    }

    // METHOD :: eventRow -> eventRecord
    // Maps a database event row to the public event shape.
    private static _eventFromRow(row: EventRow): EventRecord {
        return {
            promptId: CTGPromptDB._number(row.prompt_id),
            sequence: CTGPromptDB._number(row.sequence),
            name: row.name as PromptEventName,
            payload: JSON.parse(String(row.payload)) as unknown,
            createdAt: CTGPromptDB._number(row.created_at)
        };
    }
}
