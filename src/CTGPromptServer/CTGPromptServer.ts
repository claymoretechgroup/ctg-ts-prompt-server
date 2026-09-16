// Dependencies:
import crypto from "node:crypto";                                  // Timing-safe bearer key comparison
import type { Server } from "node:http";                            // HTTP listener handle with connection close helpers
import type { AddressInfo } from "node:net";                        // Bound socket address returned by the listener
import express from "express";                                     // HTTP routing and response host
import { ClaudeRunner, CodexRunner } from "ctg-ai-agent-proc";      // Configured concrete runner classes
import CTGPromptServerDB from "../CTGPromptServerDB/CTGPromptServerDB.js"; // Durable prompt database
import CTGPromptServerQueue from "../CTGPromptServerQueue/CTGPromptServerQueue.js"; // Prompt dispatcher
import CTGPromptServerError from "../CTGPromptServerError/CTGPromptServerError.js"; // Typed server errors
import CTGPromptServerRequestError from "../CTGPromptServerRequestError/CTGPromptServerRequestError.js"; // HTTP request errors
import CTGPromptServerValidation from "../CTGPromptServerValidation/CTGPromptServerValidation.js"; // Shared validation helpers
import bindRoutes from "./routes/index.js";                         // Aggregate route binder

// Type dependencies:
import type { ErrorRequestHandler, Express, NextFunction, Request, Response } from "express"; // Express host types
import type { LLMRunner } from "ctg-ai-agent-proc";                    // Runner base type
import type {
    CTGPromptRunnerConfig,                                             // Runner construction config
    CTGPromptServerConfig,                                             // Server factory config
    CTGPromptServerQueueRecord,                                        // Durable prompt record
    CTGPromptServerQueueStreamMessage                                  // Live queue stream message
} from "../types.js";
import type {
    CTGPromptSSESink,                                                  // SSE sink
    CTGPromptSSESubscription,                                          // SSE subscription handle
    CTGPromptWaiter                                                    // Long-poll waiter
} from "./types.js";

/**
 *
 * Class
 *
 */

// HTTP entry point for the durable prompt service.
export default class CTGPromptServer {

    /* Static Fields */
    static readonly BODY_LIMIT_BYTES = 1048576;                      // Fixed JSON reader limit required by §8.1

    /* Instance Fields */
    private _config!: CTGPromptServerConfig;                           // Validated construction config
    private readonly _app: Express;                                    // Configured Express app
    private readonly _db: CTGPromptServerDB;                           // Durable prompt DB
    private readonly _sse: Map<number, Set<CTGPromptSSESink>>;         // Live SSE sinks by prompt id
    private readonly _waiters: Map<number, Set<CTGPromptWaiter>>;      // Long-poll waiters by prompt id
    private _queue: CTGPromptServerQueue | null;                       // Queue created at start()
    private _listener: Server | null;                                  // HTTP listener created at start()
    private _started: boolean;                                         // Whether start() has run

    // CONSTRUCTOR :: ctgPromptServerConfig -> this
    // Creates a server over an already-open database and app.
    protected constructor(config: CTGPromptServerConfig) {
        this.validatedConfig = config;
        this._db = CTGPromptServerDB.init({
            path: this._config.database ?? "prompts.db",
            initDB: this._config.initDB ?? true
        });
        this._sse = new Map<number, Set<CTGPromptSSESink>>();
        this._waiters = new Map<number, Set<CTGPromptWaiter>>();
        this._queue = null;
        this._listener = null;
        this._started = false;
        this._app = this._buildApp();
    }

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> express
    // Returns the configured Express app.
    get app(): Express {
        return this._app;
    }

    // GETTER :: VOID -> ctgPromptServerDB
    // Returns the open prompt database.
    get db(): CTGPromptServerDB {
        return this._db;
    }

    // GETTER :: VOID -> ctgPromptServerConfig
    // Returns the validated server configuration.
    get config(): CTGPromptServerConfig {
        return this._config;
    }

    // SETTER :: ctgPromptServerConfig -> VOID
    // Validates and stores server configuration with defaults applied.
    private set validatedConfig(config: CTGPromptServerConfig) {
        try {
            if (!CTGPromptServerValidation.isObject(config)) {
                throw new Error("Config must be an object.");
            }
            const runner = this.validatedRunnerConfig(config.runner);
            const apiKey = CTGPromptServerValidation.nonEmptyString(config.apiKey, "apiKey");
            const maxLimit = CTGPromptServerValidation.optionalInteger(config.maxLimit, "maxLimit", 1, undefined) ?? 200;
            const defaultLimit = CTGPromptServerValidation.optionalInteger(config.defaultLimit, "defaultLimit", 1, undefined) ?? 50;

            if (defaultLimit > maxLimit) {
                throw new Error("defaultLimit must be <= maxLimit.");
            }

            this._config = {
                runner,
                apiKey,
                host: config.host === undefined ? "127.0.0.1" : CTGPromptServerValidation.nonEmptyString(config.host, "host"),
                database: config.database === undefined ? "prompts.db" : CTGPromptServerValidation.nonEmptyString(config.database, "database"),
                initDB: CTGPromptServerValidation.optionalBoolean(config.initDB, "initDB") ?? true,
                concurrency: CTGPromptServerValidation.optionalInteger(config.concurrency, "concurrency", 1, undefined) ?? 1,
                maxPromptBytes: CTGPromptServerValidation.optionalInteger(config.maxPromptBytes, "maxPromptBytes", 1, 131071) ?? 131071,
                streamMode: CTGPromptServerValidation.optionalStreamMode(config.streamMode, "streamMode") ?? "events",
                keepAliveMs: CTGPromptServerValidation.optionalInteger(config.keepAliveMs, "keepAliveMs", 1000, undefined) ?? 15000,
                maxWaitMs: CTGPromptServerValidation.optionalInteger(config.maxWaitMs, "maxWaitMs", 0, undefined) ?? 30000,
                defaultLimit,
                maxLimit
            };
        } catch (caught) {
            if (CTGPromptServerError.is(caught)) {
                throw caught;
            }

            throw new CTGPromptServerError(CTGPromptServerError.CODE.INVALID_CONFIG, caught instanceof Error ? caught.message : String(caught), {
                cause: caught
            });
        }
    }

    // GETTER :: VOID -> ctgPromptServerQueue
    // Returns the started queue.
    get queue(): CTGPromptServerQueue {
        if (this._queue === null) {
            throw new CTGPromptServerError(CTGPromptServerError.CODE.INTERNAL_ERROR, "Server has not been started.");
        }

        return this._queue;
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: NUMBER -> PROMISE({host:STRING, port:NUMBER})
    // Starts the queue and binds the HTTP listener.
    async start(port: number): Promise<{ host: string; port: number }> {
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
            throw new CTGPromptServerError(CTGPromptServerError.CODE.INVALID_CONFIG, "Port must be an integer in 0..65535.");
        }
        if (this._started) {
            throw new CTGPromptServerError(CTGPromptServerError.CODE.INTERNAL_ERROR, "Server has already been started.");
        }

        this._started = true;

        let runner: LLMRunner;

        try {
            runner = this.createRunner(this._config.runner);
        } catch (caught) {
            throw new CTGPromptServerError(CTGPromptServerError.CODE.INVALID_CONFIG, caught instanceof Error ? caught.message : String(caught), {
                cause: caught
            });
        }

        this._queue = CTGPromptServerQueue.init({
            db: this._db,
            runner,
            runnerKind: this._config.runner.kind,
            concurrency: this._config.concurrency ?? 1,
            maxPromptBytes: this._config.maxPromptBytes ?? 131071,
            streamMode: this._config.streamMode ?? "events",
            onStreamMessage: (message: CTGPromptServerQueueStreamMessage) => {
                this.publishSSE(message);
            },
            onPromptFinished: (id: number) => {
                this.notifyPromptFinished(id);
            },
            defaultLimit: this._config.defaultLimit ?? 50,
            maxLimit: this._config.maxLimit ?? 200
        });
        this._queue.recover();
        this._queue.dispatch();

        return await new Promise<{ host: string; port: number }>((resolve, reject) => {
            const listener = this._app.listen(port, this._config.host ?? "127.0.0.1", () => {
                this._listener = listener;
                const address = listener.address();

                if (typeof address === "object" && address !== null) {
                    resolve({
                        host: address.address,
                        port: address.port
                    });
                    return;
                }

                reject(new CTGPromptServerError(CTGPromptServerError.CODE.INTERNAL_ERROR, "Could not read bound address."));
            });

            listener.once("error", reject);
        });
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Stops the listener, ends live streams, and closes the database.
    async close(): Promise<void> {
        const listener = this._listener;

        if (listener !== null && listener.listening) {
            const closed = new Promise<void>((resolve, reject) => {
                listener.close((error?: Error) => {
                    if (error !== undefined) {
                        reject(error);
                        return;
                    }

                    resolve();
                });
            });

            this.closeSSE();
            listener.closeAllConnections();
            await closed;
        } else {
            this.closeSSE();
        }

        this._db.close();
        this._listener = null;
    }

    // METHOD :: NUMBER, ctgPromptSSESink -> ctgPromptSSESubscription
    // Registers one live SSE sink for a prompt.
    openSSE(id: number, sink: CTGPromptSSESink): CTGPromptSSESubscription {
        const record = this.queue.read(id);
        const set = this._sse.get(id) ?? new Set<CTGPromptSSESink>();
        let closed = false;

        set.add(sink);
        this._sse.set(id, set);

        if (CTGPromptServer._isTerminal(record.statusCode)) {
            sink.end();
        }

        return {
            close: (): void => {
                if (closed) {
                    return;
                }

                closed = true;
                this._removeSSE(id, sink);
            }
        };
    }

    // METHOD :: NUMBER? -> VOID
    // Closes live SSE sinks for one prompt or every prompt.
    closeSSE(id?: number): void {
        const ids = id === undefined ? [...this._sse.keys()] : [id];

        for (const promptId of ids) {
            const set = this._sse.get(promptId);

            if (set === undefined) {
                continue;
            }

            for (const sink of [...set]) {
                try {
                    sink.end();
                } catch {
                    continue;
                }
            }

            this._sse.delete(promptId);
        }
    }

    // METHOD :: ctgPromptServerQueueStreamMessage -> VOID
    // Writes a live queue message to every open SSE sink for its prompt id.
    publishSSE(message: CTGPromptServerQueueStreamMessage): void {
        const set = this._sse.get(message.id);

        if (set === undefined) {
            return;
        }

        const frame = `event: ${message.name}\ndata: ${JSON.stringify(message.payload)}\n\n`;

        for (const sink of [...set]) {
            try {
                sink.write(frame);
            } catch {
                this._removeSSE(message.id, sink);
            }
        }
    }

    // METHOD :: NUMBER, NUMBER -> PROMISE(ctgPromptServerQueueRecord)
    // Long-polls until a prompt finishes or the wait elapses.
    async waitForPrompt(id: number, waitMs: number): Promise<CTGPromptServerQueueRecord> {
        const clampedWaitMs = Math.min(Math.max(waitMs, 0), this._config.maxWaitMs ?? 30000);
        const first = this.queue.read(id);

        if (CTGPromptServer._isTerminal(first.statusCode)) {
            return first;
        }

        let resolveWait: (() => void) | undefined;
        const wait = new Promise<void>((resolve) => {
            resolveWait = resolve;
        });
        const waiter = (): void => {
            resolveWait?.();
        };
        const set = this._waiters.get(id) ?? new Set<CTGPromptWaiter>();

        set.add(waiter);
        this._waiters.set(id, set);

        const second = this.queue.read(id);

        if (CTGPromptServer._isTerminal(second.statusCode)) {
            this._removeWaiter(id, waiter);
            return second;
        }

        const timer = setTimeout(waiter, clampedWaitMs);

        try {
            await wait;
        } finally {
            clearTimeout(timer);
            this._removeWaiter(id, waiter);
        }

        return this.queue.read(id);
    }

    // METHOD :: NUMBER -> VOID
    // Wakes long-poll waiters and closes live SSE sinks for a terminal prompt.
    notifyPromptFinished(id: number): void {
        const waiters = this._waiters.get(id);

        if (waiters !== undefined) {
            for (const waiter of [...waiters]) {
                waiter();
            }
            this._waiters.delete(id);
        }

        this.closeSSE(id);
    }

    /**
     *
     * Protected Methods
     *
     */

    // METHOD :: ctgPromptRunnerConfig -> llmRunner
    // Constructs the configured concrete runner.
    protected createRunner(config: CTGPromptRunnerConfig): LLMRunner {
        const runnerConfig = {
            ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
            ...(config.args === undefined ? {} : { args: config.args }),
            ...(config.env === undefined ? {} : { env: config.env }),
            timeout: config.timeout ?? 600000,
            ...(config.maxBuffer === undefined ? {} : { maxBuffer: config.maxBuffer })
        };

        return config.kind === "claude"
            ? ClaudeRunner.init(runnerConfig)
            : CodexRunner.init(runnerConfig);
    }

    /**
     *
     * Private Methods
     *
     */

    // METHOD :: VOID -> express
    // Builds the Express application and route stack.
    private _buildApp(): Express {
        const app = express();

        app.use((req, _res, next) => {
            try {
                this._authenticate(req);
                next();
            } catch (caught) {
                next(caught);
            }
        });

        bindRoutes(app, this);
        app.use(this._errorHandler());

        return app;
    }

    // METHOD :: request -> VOID
    // Validates the bearer Authorization header.
    private _authenticate(req: Request): void {
        const header = req.header("authorization") ?? "";
        const match = /^(\S+)\s+(.+)$/.exec(header);

        if (match === null || match[1]?.toLowerCase() !== "bearer" || match[2] === "") {
            throw CTGPromptServerRequestError.unauthorized("Invalid or missing credentials.");
        }

        const supplied = Buffer.from(match[2] ?? "", "utf8");
        const expected = Buffer.from(this._config.apiKey, "utf8");

        if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
            throw CTGPromptServerRequestError.unauthorized("Invalid or missing credentials.");
        }
    }

    // METHOD :: VOID -> errorRequestHandler
    // Creates the single Express error handler.
    private _errorHandler(): ErrorRequestHandler {
        return (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
            if (res.headersSent) {
                res.end();
                return;
            }

            if (CTGPromptServerError.is(err)) {
                err.sendResponse(res);
                return;
            }

            const bodyError = CTGPromptServer._bodyReaderError(err);

            if (bodyError !== null) {
                bodyError.sendResponse(res);
                return;
            }

            const error = new CTGPromptServerError(CTGPromptServerError.CODE.INTERNAL_ERROR, "Internal error.");

            error.sendResponse(res);
        };
    }

    // METHOD :: UNKNOWN -> ctgPromptRunnerConfig
    // Validates runner config.
    private validatedRunnerConfig(value: unknown): CTGPromptRunnerConfig {
        if (!CTGPromptServerValidation.isObject(value)) {
            throw new Error("runner.kind must be claude or codex.");
        }

        return {
            kind: CTGPromptServerValidation.runnerKind(value.kind, "runner.kind"),
            ...(value.cwd === undefined ? {} : { cwd: CTGPromptServerValidation.nonEmptyString(value.cwd, "runner.cwd") }),
            ...(value.args === undefined ? {} : { args: CTGPromptServerValidation.stringArray(value.args, "runner.args") }),
            ...(value.env === undefined ? {} : { env: CTGPromptServerValidation.objectEnv(value.env, "runner.env") }),
            ...(value.timeout === undefined ? {} : { timeout: CTGPromptServerValidation.integer(value.timeout, "runner.timeout", 0, undefined) }),
            ...(value.maxBuffer === undefined ? {} : { maxBuffer: CTGPromptServerValidation.integer(value.maxBuffer, "runner.maxBuffer", 1, undefined) })
        };
    }

    // METHOD :: NUMBER, ctgPromptSSESink -> VOID
    // Removes one SSE sink without ending every sink for the prompt.
    private _removeSSE(id: number, sink: CTGPromptSSESink): void {
        const set = this._sse.get(id);

        if (set === undefined) {
            return;
        }

        set.delete(sink);
        if (set.size === 0) {
            this._sse.delete(id);
        }
    }

    // METHOD :: NUMBER, ctgPromptWaiter -> VOID
    // Removes one long-poll waiter.
    private _removeWaiter(id: number, waiter: CTGPromptWaiter): void {
        const set = this._waiters.get(id);

        if (set === undefined) {
            return;
        }

        set.delete(waiter);
        if (set.size === 0) {
            this._waiters.delete(id);
        }
    }

    /**
     *
     * Static Methods
     *
     */

    // Static Factory Method :: ctgPromptServerConfig -> ctgPromptServer
    // Validates config and constructs a server instance.
    static init(config: CTGPromptServerConfig): CTGPromptServer {
        return new this(config);
    }

    /**
     *
     * Private Static Methods
     *
     */

    // METHOD :: UNKNOWN -> ctgPromptServerError?
    // Maps Express JSON reader failures to INVALID_BODY.
    private static _bodyReaderError(value: unknown): CTGPromptServerError | null {
        if (!CTGPromptServerValidation.isObject(value) || typeof value.type !== "string") {
            return null;
        }

        if (value.type === "entity.parse.failed") {
            return CTGPromptServerRequestError.invalidBody("Body must parse as JSON.");
        }
        if (value.type === "entity.too.large") {
            return CTGPromptServerRequestError.invalidBody(`Body exceeds the maximum of ${CTGPromptServer.BODY_LIMIT_BYTES.toLocaleString("en-US")} bytes.`);
        }

        return null;
    }

    // METHOD :: NUMBER -> BOOLEAN
    // Returns whether a queue status is terminal.
    private static _isTerminal(statusCode: number): boolean {
        return statusCode === CTGPromptServerQueue.STATUS.DONE
            || statusCode === CTGPromptServerQueue.STATUS.ERROR
            || statusCode === CTGPromptServerQueue.STATUS.CANCELLED;
    }
}
