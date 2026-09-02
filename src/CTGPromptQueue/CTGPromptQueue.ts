// Dependencies:
import { LLMRunnerError, LLMRunnerOutputEvent } from "ctg-ai-agent-proc"; // Upstream runner error and output event classes
import CTGPromptServerError from "../CTGPromptServerError/CTGPromptServerError.js"; // Typed server and request errors

// Type dependencies:
import type {
    AppendedEvent,                                           // Event append result
    ClaimedPrompt,                                           // Claim result
    CTGPromptEventSink,                                      // Event sink for subscriptions
    CTGPromptQueueConfig,                                    // Queue factory config
    CTGPromptSubscription,                                   // Subscription handle
    EventRecord,                                             // Durable event record
    PromptEventName,                                         // Durable event names
    PromptListPage,                                          // List page
    PromptListQuery,                                         // List query
    PromptOutcomeErrorType,                                  // Outcome error class
    PromptRecord,                                            // Durable prompt record
    RunnerKind,                                              // Runner kind
    StreamMode                                               // Runner stream mode
} from "../types.js";
import type { LLMRunner, LLMRunnerResult, LLMRunnerStreamEvent } from "ctg-ai-agent-proc"; // Runner instance and stream event types

/**
 *
 * Type Declarations
 *
 */

// TYPE :: ctgPromptSubscription & {writeEvent:eventRecord -> VOID}
// Internal replay-capable subscription shape.
interface ReplaySubscription extends CTGPromptSubscription {
    writeEvent(event: EventRecord): void;                    // Writes a replay frame through the subscription
}

/**
 *
 * Class
 *
 */

// Prompt dispatcher and runner coordinator.
export default class CTGPromptQueue {

    /* Instance Fields */
    private readonly _db: CTGPromptQueueConfig["db"];                     // Durable prompt store
    private readonly _subscribers: CTGPromptQueueConfig["subscribers"];   // Live event fan-out
    private readonly _runner: LLMRunner;                                  // Upstream runner
    private readonly _runnerKind: RunnerKind;                             // Kind recorded in claims
    private readonly _concurrency: number;                                // Maximum active runs
    private readonly _maxPromptBytes: number;                             // Prompt byte cap
    private readonly _streamMode: StreamMode;                             // Per-run stream mode
    private readonly _maxWaitMs: number;                                  // Long-poll ceiling
    private readonly _defaultLimit: number;                               // Default list size
    private readonly _maxLimit: number;                                   // Maximum list size
    private readonly _active: Set<number>;                                // Prompt ids currently executing
    private readonly _running: Set<Promise<void>>;                        // Execution promises for drain()

    // CONSTRUCTOR :: ctgPromptQueueConfig -> this
    // Wires the queue to storage, subscribers, and a runner.
    private constructor(config: CTGPromptQueueConfig) {
        this._db = config.db;
        this._subscribers = config.subscribers;
        this._runner = config.runner;
        this._runnerKind = config.runnerKind;
        this._concurrency = config.concurrency;
        this._maxPromptBytes = config.maxPromptBytes;
        this._streamMode = config.streamMode;
        this._maxWaitMs = config.maxWaitMs;
        this._defaultLimit = config.defaultLimit;
        this._maxLimit = config.maxLimit;
        this._active = new Set<number>();
        this._running = new Set<Promise<void>>();
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: STRING -> promptRecord
    // Validates, stores, publishes, and dispatches one prompt.
    submit(prompt: string): PromptRecord {
        if (typeof prompt !== "string") {
            throw new CTGPromptServerError("INVALID_PROMPT", "Prompt must be a string.");
        }
        if (prompt.trim() === "") {
            throw new CTGPromptServerError("INVALID_PROMPT", "Prompt must not be empty.");
        }

        const bytes = Buffer.byteLength(prompt, "utf8");

        if (bytes > this._maxPromptBytes) {
            throw new CTGPromptServerError("INVALID_PROMPT", `Prompt exceeds the maximum of ${this._maxPromptBytes} bytes.`, {
                bytes,
                maxPromptBytes: this._maxPromptBytes
            });
        }

        const record = this._store(() => this._db.insertPrompt(prompt));
        const event = this._store(() => this._db.readEvents(record.id, record.lastSequence - 1)[0]);

        if (event === undefined) {
            throw new CTGPromptServerError("STORE_FAILED", "Store failed.");
        }

        this._subscribers.publish(record.id, event);
        this.dispatch();

        return record;
    }

    // METHOD :: NUMBER -> promptRecord
    // Cancels a pending prompt.
    cancel(id: number): PromptRecord {
        const record = this._store(() => this._db.readPrompt(id));

        if (record === undefined) {
            throw new CTGPromptServerError("PROMPT_NOT_FOUND", "Prompt not found.");
        }
        if (record.status === "active") {
            throw new CTGPromptServerError("CANCEL_NOT_ALLOWED", "An active prompt cannot be cancelled.", {
                id,
                status: record.status
            });
        }
        if (CTGPromptQueue._isFinished(record.status)) {
            throw new CTGPromptServerError("CANCEL_NOT_ALLOWED", "The prompt is already finished.", {
                id,
                status: record.status
            });
        }

        const appended = this._store(() => this._db.cancelPending(id));

        this._subscribers.publish(id, appended.event);
        this._subscribers.closePrompt(id);

        return appended.prompt;
    }

    // METHOD :: NUMBER -> promptRecord
    // Reads a prompt by id.
    read(id: number): PromptRecord {
        const record = this._store(() => this._db.readPrompt(id));

        if (record === undefined) {
            throw new CTGPromptServerError("PROMPT_NOT_FOUND", "Prompt not found.");
        }

        return record;
    }

    // METHOD :: NUMBER, NUMBER -> PROMISE(promptRecord)
    // Long-polls until a prompt finishes or the wait elapses.
    async readWait(id: number, waitMs: number): Promise<PromptRecord> {
        const clampedWaitMs = Math.min(Math.max(waitMs, 0), this._maxWaitMs);
        const first = this.read(id);

        if (CTGPromptQueue._isFinished(first.status)) {
            return first;
        }

        let resolveWait: (() => void) | undefined;
        const wait = new Promise<void>((resolve) => {
            resolveWait = resolve;
        });
        const subscription = this._subscribers.add(id, {
            write: () => undefined,
            end: () => {
                resolveWait?.();
            }
        });
        const second = this.read(id);

        if (CTGPromptQueue._isFinished(second.status)) {
            subscription.close();
            return second;
        }

        const timer = setTimeout(() => {
            resolveWait?.();
        }, clampedWaitMs);

        try {
            await wait;
        } finally {
            clearTimeout(timer);
            subscription.close();
        }

        return this.read(id);
    }

    // METHOD :: promptListQuery -> promptListPage
    // Lists prompts through the configured page defaults.
    list(query: PromptListQuery): PromptListPage {
        return this._store(() => this._db.listPrompts({
            status: query.status,
            before: query.before,
            limit: query.limit ?? this._defaultLimit
        }));
    }

    // METHOD :: NUMBER, ctgPromptEventSink, NUMBER -> ctgPromptSubscription
    // Replays history and attaches a live subscriber.
    subscribe(id: number, sink: CTGPromptEventSink, afterSequence: number): CTGPromptSubscription {
        const record = this.read(id);
        const subscription = this._subscribers.add(id, sink) as ReplaySubscription;
        const events = this._store(() => this._db.readEvents(id, afterSequence));

        for (const event of events) {
            subscription.writeEvent(event);
        }

        const last = events.at(-1);
        if (last === undefined && CTGPromptQueue._isFinished(record.status)) {
            sink.end();
        }

        return subscription;
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

            const claimed = this._store(() => this._db.claimNextPending(this._runnerKind));

            if (claimed === undefined) {
                return;
            }

            const id = claimed.prompt.id;

            this._active.add(id);
            this._subscribers.publish(id, claimed.event);

            const promise = this._execute(claimed.prompt);
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

    // METHOD :: promptRecord -> PROMISE(VOID)
    // Executes one active prompt and records its terminal outcome.
    private async _execute(prompt: PromptRecord): Promise<void> {
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
            try {
                this._finishRunnerError(prompt.id, caught);
            } catch (finishCaught) {
                this._finishServerError(prompt.id, finishCaught);
            }
            return;
        }

        if (serverFailure !== null) {
            this._finishServerError(prompt.id, serverFailure);
            return;
        }

        try {
            const appended = this._db.finishPrompt(prompt.id, {
                status: "done",
                response: result.result,
                info: {
                    stderr: result.error
                }
            });

            this._subscribers.publish(prompt.id, appended.event);
            this._subscribers.closePrompt(prompt.id);
        } catch (caught) {
            this._finishServerError(prompt.id, caught);
        }
    }

    // METHOD :: NUMBER, llmRunnerStreamEvent -> VOID
    // Maps and stores one upstream stream event.
    private _recordStreamEvent(promptId: number, event: LLMRunnerStreamEvent): void {
        const mapped = this._mapStreamEvent(event);
        const contribution = this._responseContribution(mapped.name, mapped.payload);
        const appended = contribution === undefined
            ? this._db.appendEvent(promptId, mapped.name, mapped.payload)
            : this._db.appendEvent(promptId, mapped.name, mapped.payload, contribution);

        this._subscribers.publish(promptId, appended.event);
    }

    // METHOD :: llmRunnerStreamEvent -> {name:promptEventName, payload:UNKNOWN}
    // Converts upstream stream event objects to durable event rows.
    private _mapStreamEvent(event: LLMRunnerStreamEvent): { name: PromptEventName; payload: unknown } {
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

    // METHOD :: promptEventName, UNKNOWN -> STRING?
    // Extracts response text contributed by one stream event.
    private _responseContribution(name: PromptEventName, payload: unknown): string | undefined {
        if (this._streamMode === "raw") {
            if (name === "output" && CTGPromptQueue._isObject(payload) && payload.stream === "stdout" && typeof payload.chunk === "string") {
                return payload.chunk;
            }

            return undefined;
        }

        if (name !== "stream" || !CTGPromptQueue._isObject(payload) || !("payload" in payload)) {
            return undefined;
        }

        return this._runnerKind === "claude"
            ? CTGPromptQueue._extractClaudeText(payload.payload)
            : CTGPromptQueue._extractCodexText(payload.payload);
    }

    // METHOD :: NUMBER, UNKNOWN -> VOID
    // Records a runner failure outcome.
    private _finishRunnerError(id: number, cause: unknown): void {
        const outcome = CTGPromptQueue._runnerOutcome(cause);
        const appended = this._db.finishPrompt(id, {
            status: "error",
            errorType: "RUNNER",
            errorMessage: outcome.message,
            info: outcome.info
        });

        this._subscribers.publish(id, appended.event);
        this._subscribers.closePrompt(id);
    }

    // METHOD :: NUMBER, UNKNOWN -> VOID
    // Records a server failure outcome if possible.
    private _finishServerError(id: number, cause: unknown): void {
        try {
            const message = cause instanceof Error ? cause.message : String(cause);
            const type = CTGPromptServerError.is(cause) ? cause.type : cause instanceof Error ? cause.name : typeof cause;
            const appended = this._db.finishPrompt(id, {
                status: "error",
                errorType: "SERVER",
                errorMessage: message,
                info: {
                    type
                }
            });

            this._subscribers.publish(id, appended.event);
            this._subscribers.closePrompt(id);
        } catch {
            return;
        }
    }

    // METHOD :: (VOID -> T) -> T
    // Converts raw storage errors in request-facing queue methods to STORE_FAILED.
    private _store<T>(fn: () => T): T {
        try {
            return fn();
        } catch (caught) {
            if (CTGPromptServerError.is(caught)) {
                throw caught;
            }

            throw new CTGPromptServerError("STORE_FAILED", "Store failed.", {
                cause: caught
            });
        }
    }

    /**
     *
     * Static Methods
     *
     */

    // Static Factory Method :: ctgPromptQueueConfig -> ctgPromptQueue
    // Creates a prompt queue.
    static init(config: CTGPromptQueueConfig): CTGPromptQueue {
        return new this(config);
    }

    /**
     *
     * Private Static Methods
     *
     */

    // METHOD :: STRING -> BOOLEAN
    // Returns whether a status is terminal.
    private static _isFinished(status: string): boolean {
        return status === "done" || status === "error" || status === "cancelled";
    }

    // METHOD :: STRING -> BOOLEAN
    // Returns whether an event name is terminal.
    private static _isFinishedEvent(name: string): boolean {
        return name === "done" || name === "error" || name === "cancelled";
    }

    // METHOD :: UNKNOWN -> BOOLEAN
    // Narrows plain object-like values.
    private static _isObject(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null;
    }

    // METHOD :: UNKNOWN -> {message:STRING, info:OBJECT}
    // Builds RUNNER outcome data from a thrown value.
    private static _runnerOutcome(cause: unknown): { message: string; info: Record<string, unknown> } {
        if (LLMRunnerError.is(cause)) {
            return {
                message: cause.msg,
                info: {
                    runnerErrorType: cause.type,
                    runnerErrorData: cause.data
                }
            };
        }

        return {
            message: cause instanceof Error ? cause.message : String(cause),
            info: {
                thrown: cause instanceof Error ? cause.constructor.name : typeof cause
            }
        };
    }

    // METHOD :: UNKNOWN -> STRING?
    // Extracts Claude assistant text from a native payload.
    private static _extractClaudeText(payload: unknown): string | undefined {
        if (!CTGPromptQueue._isObject(payload) || !CTGPromptQueue._isObject(payload.message) || !Array.isArray(payload.message.content)) {
            return undefined;
        }

        const text = payload.message.content
            .map((item: unknown) => CTGPromptQueue._isObject(item) && typeof item.text === "string" ? item.text : "")
            .join("");

        return text === "" ? undefined : text;
    }

    // METHOD :: UNKNOWN -> STRING?
    // Extracts Codex assistant text from a native payload.
    private static _extractCodexText(payload: unknown): string | undefined {
        if (!CTGPromptQueue._isObject(payload) || !CTGPromptQueue._isObject(payload.item)) {
            return undefined;
        }

        if (payload.item.type === "agent_message" && typeof payload.item.text === "string") {
            return payload.item.text;
        }

        if (payload.item.type === "message" && payload.item.role === "assistant" && Array.isArray(payload.item.content)) {
            const text = payload.item.content
                .map((item: unknown) => CTGPromptQueue._isObject(item) && typeof item.text === "string" ? item.text : "")
                .join("");

            return text === "" ? undefined : text;
        }

        return undefined;
    }
}
