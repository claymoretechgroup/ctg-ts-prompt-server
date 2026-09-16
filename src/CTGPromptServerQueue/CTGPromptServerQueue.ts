// Dependencies:
import { LLMRunnerOutputEvent } from "ctg-ai-agent-proc";          // Upstream output event class
import CTGPromptServerError from "../CTGPromptServerError/CTGPromptServerError.js"; // Typed server errors
import CTGPromptServerRequestError from "../CTGPromptServerRequestError/CTGPromptServerRequestError.js"; // HTTP request errors

// Type dependencies:
import type {
    CTGPromptPaginationPage,                                       // Spec2 pagination page
    CTGPromptServerQueueConfig,                                    // Queue factory config
    CTGPromptServerQueueRecord,                                    // Spec2 durable prompt record
    CTGPromptServerQueueStreamMessage,                             // Live queue stream message
    PromptListQuery,                                               // Temporary route query shape
    RunnerKind,                                                    // Runner kind
    StreamMode                                                     // Runner stream mode
} from "../types.js";
import type { LLMRunner, LLMRunnerResult, LLMRunnerStreamEvent } from "ctg-ai-agent-proc"; // Runner instance and stream event types
import type { CTGPromptServerQueueStreamRecord } from "./types.js"; // Normalized stream contribution

/**
 *
 * Class
 *
 */

// Prompt dispatcher and runner coordinator.
export default class CTGPromptServerQueue {

    /* Static Fields */
    static readonly STATUS = Object.freeze({
        PENDING: 1,
        ACTIVE: 2,
        DONE: 3,
        ERROR: -1,
        CANCELLED: 5
    } as const);

    /* Instance Fields */
    private readonly _db: CTGPromptServerQueueConfig["db"];                   // Durable prompt store
    private readonly _onStreamMessage: CTGPromptServerQueueConfig["onStreamMessage"]; // Live stream callback
    private readonly _onPromptFinished: CTGPromptServerQueueConfig["onPromptFinished"]; // Terminal prompt callback
    private readonly _runner: LLMRunner;                                      // Upstream runner
    private readonly _runnerKind: RunnerKind;                                 // Runner metadata
    private readonly _concurrency: number;                                    // Maximum active runs
    private readonly _maxPromptBytes: number;                                 // Prompt byte cap
    private readonly _streamMode: StreamMode;                                 // Per-run stream mode
    private readonly _defaultLimit: number;                                   // Default list size
    private readonly _active: Set<number>;                                    // Prompt ids currently executing
    private readonly _running: Set<Promise<void>>;                            // Execution promises for drain()

    // CONSTRUCTOR :: ctgPromptServerQueueConfig -> this
    // Wires the queue to storage, callbacks, and a runner.
    private constructor(config: CTGPromptServerQueueConfig) {
        this._db = config.db;
        this._onStreamMessage = config.onStreamMessage;
        this._onPromptFinished = config.onPromptFinished;
        this._runner = config.runner;
        this._runnerKind = config.runnerKind;
        this._concurrency = config.concurrency;
        this._maxPromptBytes = config.maxPromptBytes;
        this._streamMode = config.streamMode;
        this._defaultLimit = config.defaultLimit;
        this._active = new Set<number>();
        this._running = new Set<Promise<void>>();
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: STRING -> ctgPromptServerQueueRecord
    // Validates, stores, and dispatches one prompt.
    submit(prompt: string): CTGPromptServerQueueRecord {
        if (typeof prompt !== "string") {
            throw CTGPromptServerRequestError.invalidPrompt("Prompt must be a string.");
        }
        if (prompt.trim() === "") {
            throw CTGPromptServerRequestError.invalidPrompt("Prompt must not be empty.");
        }

        const bytes = Buffer.byteLength(prompt, "utf8");

        if (bytes > this._maxPromptBytes) {
            throw CTGPromptServerRequestError.invalidPrompt(`Prompt exceeds the maximum of ${this._maxPromptBytes} bytes.`, {
                bytes,
                maxPromptBytes: this._maxPromptBytes
            });
        }

        const record = this._store(() => this._db.create(prompt));

        this._emit("pending", {
            promptId: record.id,
            statusCode: CTGPromptServerQueue.STATUS.PENDING,
            createdAt: record.createdAt
        }, record.id);
        this.dispatch();

        return record;
    }

    // METHOD :: NUMBER -> ctgPromptServerQueueRecord
    // Cancels a pending prompt.
    cancel(id: number): CTGPromptServerQueueRecord {
        const record = this._store(() => this._db.cancel(id));

        this._emit("cancelled", {
            promptId: record.id,
            statusCode: CTGPromptServerQueue.STATUS.CANCELLED,
            finishedAt: record.finishedAt
        }, record.id);
        this._onPromptFinished(id);

        return record;
    }

    // METHOD :: NUMBER -> ctgPromptServerQueueRecord
    // Reads a prompt by id.
    read(id: number): CTGPromptServerQueueRecord {
        const record = this._store(() => this._db.read(id));

        if (record === null) {
            throw CTGPromptServerRequestError.promptNotFound("Prompt not found.");
        }

        return record;
    }

    // METHOD :: promptListQuery -> ctgPromptPaginationPage
    // Lists prompts through the configured page defaults.
    list(query: PromptListQuery): CTGPromptPaginationPage {
        return this._store(() => this._db.paginate({
            statusCode: query.status === undefined ? undefined : CTGPromptServerQueue._statusCodeFor(query.status),
            before: query.before,
            limit: query.limit ?? this._defaultLimit
        }));
    }

    // METHOD :: VOID -> NUMBER
    // Recovers prompts left active by a previous process.
    recover(): number {
        return this._store(() => this._db.interruptActive());
    }

    // METHOD :: VOID -> VOID
    // Claims and starts runs until the concurrency limit is reached.
    dispatch(): void {
        while (true) {
            if (this._active.size >= this._concurrency) {
                return;
            }

            const claimed = this._store(() => this._db.claimNext());

            if (claimed === null) {
                return;
            }

            const record = this._store(() => this._db.update({
                ...claimed,
                runner: this._runnerKind
            }));
            const id = record.id;

            this._emit("active", {
                promptId: id,
                statusCode: CTGPromptServerQueue.STATUS.ACTIVE,
                runner: this._runnerKind,
                startedAt: record.startedAt
            }, id);
            this._active.add(id);

            const promise = this._execute(record);
            this._running.add(promise);
            promise.finally(() => {
                this._active.delete(id);
                this._running.delete(promise);
                this.dispatch();
            }).catch(() => undefined);
        }
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Resolves when no run is in flight.
    async drain(): Promise<void> {
        while (this._running.size > 0) {
            await Promise.allSettled([...this._running]);
        }
    }

    /**
     *
     * Private Methods
     *
     */

    // METHOD :: ctgPromptServerQueueRecord -> PROMISE(VOID)
    // Executes one active prompt and records its terminal outcome.
    private async _execute(prompt: CTGPromptServerQueueRecord): Promise<void> {
        let serverFailure: unknown = null;
        const onStream = (event: LLMRunnerStreamEvent): void => {
            try {
                this._recordStreamEvent(prompt.id, event);
            } catch (caught) {
                serverFailure ??= caught;
            }
        };

        let result: LLMRunnerResult;

        try {
            result = await this._runner.run(prompt.prompt, {
                streamOutput: true,
                streamMode: this._streamMode,
                onStream
            });
        } catch (caught) {
            this._finishError(prompt.id, CTGPromptServerError.CODE.RUNNER_FAILED, caught);
            return;
        }

        if (serverFailure !== null) {
            this._finishError(prompt.id, CTGPromptServerError.CODE.INTERNAL_ERROR, serverFailure);
            return;
        }

        try {
            const finished = this._db.finish(prompt.id, {
                statusCode: CTGPromptServerQueue.STATUS.DONE,
                response: result.result
            });
            this._emit("done", {
                promptId: finished.id,
                statusCode: CTGPromptServerQueue.STATUS.DONE,
                response: finished.response,
                finishedAt: finished.finishedAt
            }, finished.id);
            this._onPromptFinished(prompt.id);
        } catch (caught) {
            this._finishError(prompt.id, CTGPromptServerError.CODE.INTERNAL_ERROR, caught);
        }
    }

    // METHOD :: NUMBER, llmRunnerStreamEvent -> VOID
    // Maps and stores one upstream stream contribution.
    private _recordStreamEvent(promptId: number, event: LLMRunnerStreamEvent): void {
        const mapped = this._mapStreamEvent(event);
        const contribution = this._responseContribution(mapped.name, mapped.payload);

        if (contribution !== undefined) {
            this._db.append(promptId, contribution);
        }

        this._emit(mapped.name, mapped.payload, promptId);
    }

    // METHOD :: llmRunnerStreamEvent -> {name:STRING, payload:UNKNOWN}
    // Converts upstream stream event objects to internal stream payloads.
    private _mapStreamEvent(event: LLMRunnerStreamEvent): CTGPromptServerQueueStreamRecord {
        if (event instanceof LLMRunnerOutputEvent) {
            return {
                name: "output",
                payload: {
                    source: event.source,
                    stream: event.stream,
                    chunk: event.chunk
                }
            };
        }

        if (typeof event === "object" && event !== null && "payload" in event) {
            const typed = event as { source: string; type?: unknown; payload: unknown };

            return {
                name: "stream",
                payload: {
                    source: typed.source,
                    type: typeof typed.type === "string" ? typed.type : null,
                    payload: typed.payload
                }
            };
        }

        return {
            name: "stream",
            payload: {
                source: event.source,
                raw: event.raw
            }
        };
    }

    // METHOD :: STRING, UNKNOWN -> STRING?
    // Extracts response text contributed by one stream event.
    private _responseContribution(name: "output" | "stream", payload: unknown): string | undefined {
        if (this._streamMode === "raw") {
            if (name === "output" && CTGPromptServerQueue._isObject(payload) && payload.stream === "stdout" && typeof payload.chunk === "string") {
                return payload.chunk;
            }

            return undefined;
        }

        if (name !== "stream" || !CTGPromptServerQueue._isObject(payload) || !("payload" in payload)) {
            return undefined;
        }

        return this._runnerKind === "claude"
            ? CTGPromptServerQueue._extractClaudeText(payload.payload)
            : CTGPromptServerQueue._extractCodexText(payload.payload);
    }

    // METHOD :: NUMBER, NUMBER, UNKNOWN -> VOID
    // Records a failed terminal outcome if possible.
    private _finishError(id: number, code: number, cause: unknown): void {
        try {
            const message = cause instanceof Error ? cause.message : String(cause);

            const finished = this._db.finish(id, {
                statusCode: CTGPromptServerQueue.STATUS.ERROR,
                errorCode: code,
                errorMessage: message
            });
            this._emit("error", {
                promptId: finished.id,
                statusCode: CTGPromptServerQueue.STATUS.ERROR,
                error: {
                    code: finished.errorCode,
                    message: finished.errorMessage ?? message
                },
                finishedAt: finished.finishedAt
            }, finished.id);
            this._onPromptFinished(id);
        } catch {
            return;
        }
    }

    // METHOD :: (VOID -> T) -> T
    // Converts raw storage errors in request-facing queue methods to DATABASE_FAILED.
    private _store<T>(fn: () => T): T {
        try {
            return fn();
        } catch (caught) {
            if (CTGPromptServerError.is(caught)) {
                throw caught;
            }

            throw new CTGPromptServerError(CTGPromptServerError.CODE.DATABASE_FAILED, "Database failed.", {
                cause: caught
            });
        }
    }

    // METHOD :: STRING, UNKNOWN, NUMBER -> VOID
    // Emits one live stream message to the server callback.
    private _emit(name: string, payload: unknown, id: number): void {
        const message: CTGPromptServerQueueStreamMessage = {
            id,
            name,
            payload,
            createdAt: Date.now()
        };

        this._onStreamMessage(message);
    }

    /**
     *
     * Static Methods
     *
     */

    // Static Factory Method :: ctgPromptServerQueueConfig -> ctgPromptServerQueue
    // Creates a prompt queue.
    static init(config: CTGPromptServerQueueConfig): CTGPromptServerQueue {
        return new this(config);
    }

    // METHOD :: NUMBER -> STRING
    // Returns the spec2 label for a durable queue status code.
    static statusOf(code: number): string {
        for (const [label, value] of Object.entries(CTGPromptServerQueue.STATUS)) {
            if (value === code) {
                return label;
            }
        }

        return "ERROR";
    }

    /**
     *
     * Private Static Methods
     *
     */

    // METHOD :: NUMBER -> BOOLEAN
    // Returns whether a status is terminal.
    private static _isFinished(statusCode: number): boolean {
        return statusCode === CTGPromptServerQueue.STATUS.DONE
            || statusCode === CTGPromptServerQueue.STATUS.ERROR
            || statusCode === CTGPromptServerQueue.STATUS.CANCELLED;
    }

    // METHOD :: STRING -> NUMBER
    // Maps current route status strings to spec2 status codes.
    private static _statusCodeFor(status: string): number {
        switch (status) {
            case "pending": return CTGPromptServerQueue.STATUS.PENDING;
            case "active": return CTGPromptServerQueue.STATUS.ACTIVE;
            case "done": return CTGPromptServerQueue.STATUS.DONE;
            case "error": return CTGPromptServerQueue.STATUS.ERROR;
            case "cancelled": return CTGPromptServerQueue.STATUS.CANCELLED;
            default: return CTGPromptServerQueue.STATUS.ERROR;
        }
    }

    // METHOD :: UNKNOWN -> BOOLEAN
    // Narrows plain object-like values.
    private static _isObject(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null;
    }

    // METHOD :: UNKNOWN -> STRING?
    // Extracts Claude assistant text from a native payload.
    private static _extractClaudeText(payload: unknown): string | undefined {
        if (!CTGPromptServerQueue._isObject(payload) || !CTGPromptServerQueue._isObject(payload.message) || !Array.isArray(payload.message.content)) {
            return undefined;
        }

        const text = payload.message.content
            .map((item: unknown) => CTGPromptServerQueue._isObject(item) && typeof item.text === "string" ? item.text : "")
            .join("");

        return text === "" ? undefined : text;
    }

    // METHOD :: UNKNOWN -> STRING?
    // Extracts Codex assistant text from a native payload.
    private static _extractCodexText(payload: unknown): string | undefined {
        if (!CTGPromptServerQueue._isObject(payload) || !CTGPromptServerQueue._isObject(payload.item)) {
            return undefined;
        }

        if (payload.item.type === "agent_message" && typeof payload.item.text === "string") {
            return payload.item.text;
        }

        if (payload.item.type === "message" && payload.item.role === "assistant" && Array.isArray(payload.item.content)) {
            const text = payload.item.content
                .map((item: unknown) => CTGPromptServerQueue._isObject(item) && typeof item.text === "string" ? item.text : "")
                .join("");

            return text === "" ? undefined : text;
        }

        return undefined;
    }
}
