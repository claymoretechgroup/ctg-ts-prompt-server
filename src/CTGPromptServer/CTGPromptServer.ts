// Dependencies:
import crypto from "node:crypto";                                  // Timing-safe bearer key comparison
import type { Server } from "node:http";                            // HTTP listener handle with connection close helpers
import type { AddressInfo } from "node:net";                        // Bound socket address returned by the listener
import express from "express";                                     // HTTP routing and response host
import { ClaudeRunner, CodexRunner } from "ctg-ai-agent-proc";      // Configured concrete runner classes
import CTGPromptDB from "../CTGPromptDB/CTGPromptDB.js";            // Durable prompt database
import CTGPromptQueue from "../CTGPromptQueue/CTGPromptQueue.js";   // Prompt dispatcher
import CTGPromptServerError from "../CTGPromptServerError/CTGPromptServerError.js"; // Typed server errors
import CTGPromptSubscribers from "../CTGPromptSubscribers/CTGPromptSubscribers.js"; // Live event subscribers

// Type dependencies:
import type { ErrorRequestHandler, Express, NextFunction, Request, Response } from "express"; // Express host types
import type { LLMRunner } from "ctg-ai-agent-proc";                    // Runner base type
import type {
    CTGPromptRunnerConfig,                                             // Runner construction config
    CTGPromptServerConfig,                                             // Server factory config
    PromptListPage,                                                    // Serialized prompt list
    PromptListQuery,                                                   // Route list query
    PromptRecord,                                                      // Serialized prompt record
    PromptStatus,                                                      // Status route literal
    RunnerKind,                                                        // Runner kind literal
    StreamMode                                                         // Stream mode literal
} from "../types.js";

/**
 *
 * Type Declarations
 *
 */

// TYPE :: {runner:ctgPromptRunnerConfig, apiKey:STRING, host:STRING, database:STRING, concurrency:NUMBER, maxPromptBytes:NUMBER, streamMode:streamMode, keepAliveMs:NUMBER, maxWaitMs:NUMBER, defaultLimit:NUMBER, maxLimit:NUMBER}
// Fully resolved server config.
interface ResolvedServerConfig {
    readonly runner: CTGPromptRunnerConfig;                            // Validated runner config
    readonly apiKey: string;                                           // Shared bearer key
    readonly host: string;                                             // Bind address
    readonly database: string;                                         // SQLite path
    readonly concurrency: number;                                      // Run concurrency
    readonly maxPromptBytes: number;                                  // Prompt byte ceiling
    readonly streamMode: StreamMode;                                  // Runner stream mode
    readonly keepAliveMs: number;                                     // SSE keep-alive cadence
    readonly maxWaitMs: number;                                       // Long-poll ceiling
    readonly defaultLimit: number;                                    // Default list size
    readonly maxLimit: number;                                        // Maximum list size
}

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
    private readonly _config: ResolvedServerConfig;                    // Resolved construction config
    private readonly _app: Express;                                    // Configured Express app
    private readonly _db: CTGPromptDB;                                 // Durable prompt DB
    private readonly _subscribers: CTGPromptSubscribers;               // Subscriber registry
    private _queue: CTGPromptQueue | null;                             // Queue created at start()
    private _listener: Server | null;                                  // HTTP listener created at start()
    private _started: boolean;                                         // Whether start() has run

    // CONSTRUCTOR :: resolvedServerConfig -> this
    // Creates a server over an already-open database and app.
    protected constructor(config: ResolvedServerConfig) {
        this._config = config;
        this._db = CTGPromptDB.init({
            path: config.database
        });
        this._subscribers = CTGPromptSubscribers.init();
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

    // GETTER :: VOID -> ctgPromptDB
    // Returns the open prompt database.
    get db(): CTGPromptDB {
        return this._db;
    }

    // GETTER :: VOID -> ctgPromptQueue
    // Returns the started queue.
    get queue(): CTGPromptQueue {
        if (this._queue === null) {
            throw new CTGPromptServerError("INTERNAL_ERROR", "Server has not been started.");
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
            throw new CTGPromptServerError("INVALID_CONFIG", "Port must be an integer in 0..65535.");
        }
        if (this._started) {
            throw new CTGPromptServerError("INTERNAL_ERROR", "Server has already been started.");
        }

        this._started = true;

        let runner: LLMRunner;

        try {
            runner = this.createRunner(this._config.runner);
        } catch (caught) {
            throw new CTGPromptServerError("INVALID_CONFIG", caught instanceof Error ? caught.message : String(caught), {
                cause: caught
            });
        }

        this._queue = CTGPromptQueue.init({
            db: this._db,
            subscribers: this._subscribers,
            runner,
            runnerKind: this._config.runner.kind,
            concurrency: this._config.concurrency,
            maxPromptBytes: this._config.maxPromptBytes,
            streamMode: this._config.streamMode,
            maxWaitMs: this._config.maxWaitMs,
            defaultLimit: this._config.defaultLimit,
            maxLimit: this._config.maxLimit
        });
        this._queue.recover();
        this._queue.dispatch();

        return await new Promise<{ host: string; port: number }>((resolve, reject) => {
            const listener = this._app.listen(port, this._config.host, () => {
                this._listener = listener;
                const address = listener.address();

                if (typeof address === "object" && address !== null) {
                    resolve({
                        host: address.address,
                        port: address.port
                    });
                    return;
                }

                reject(new CTGPromptServerError("INTERNAL_ERROR", "Could not read bound address."));
            });

            listener.once("error", reject);
        });
    }

    // METHOD :: VOID -> PROMISE(VOID)
    // Stops the listener, ends subscribers, and closes the database.
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

            this._subscribers.closeAll();
            listener.closeAllConnections();
            await closed;
        } else {
            this._subscribers.closeAll();
        }

        this._db.close();
        this._listener = null;
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

        app.post("/prompt", this._requireJson.bind(this), express.json({
            limit: CTGPromptServer.BODY_LIMIT_BYTES
        }), this._asyncRoute(async (req, res) => {
            if (!CTGPromptServer._isObject(req.body) || Array.isArray(req.body) || !("prompt" in req.body)) {
                throw new CTGPromptServerError("INVALID_BODY", "Body must be a JSON object with a prompt property.");
            }

            this._success(res, this.queue.submit(req.body.prompt as string), 202);
        }));
        app.get("/prompt/:id", this._asyncRoute(async (req, res) => {
            const id = this._parseId(CTGPromptServer._single(req.params.id));
            const wait = this._parseWait(req.query.wait);
            const record = wait === null
                ? this.queue.read(id)
                : await this.queue.readWait(id, wait);

            this._success(res, record, 200);
        }));
        app.get("/prompt/:id/events", this._asyncRoute(async (req, res) => {
            const id = this._parseId(CTGPromptServer._single(req.params.id));

            this._openEventStream(req, res, id);
        }));
        app.delete("/prompt/:id", this._asyncRoute(async (req, res) => {
            const id = this._parseId(CTGPromptServer._single(req.params.id));

            this._success(res, this.queue.cancel(id), 200);
        }));
        app.get("/prompts", this._asyncRoute(async (req, res) => {
            this._success(res, this.queue.list(this._parseListQuery(req, null)), 200);
        }));
        app.get("/prompts/:status", this._asyncRoute(async (req, res) => {
            const status = this._parseStatus(CTGPromptServer._single(req.params.status));

            this._success(res, this.queue.list(this._parseListQuery(req, status)), 200);
        }));

        app.all(["/prompt", "/prompt/:id", "/prompt/:id/events", "/prompts", "/prompts/:status"], (_req, _res, next) => {
            next(new CTGPromptServerError("METHOD_NOT_ALLOWED", "Method not allowed."));
        });
        app.use((_req, _res, next) => {
            next(new CTGPromptServerError("NOT_FOUND", "Not found."));
        });
        app.use(this._errorHandler());

        return app;
    }

    // METHOD :: request -> VOID
    // Validates the bearer Authorization header.
    private _authenticate(req: Request): void {
        const header = req.header("authorization") ?? "";
        const match = /^(\S+)\s+(.+)$/.exec(header);

        if (match === null || match[1]?.toLowerCase() !== "bearer" || match[2] === "") {
            throw new CTGPromptServerError("UNAUTHORIZED", "Invalid or missing credentials.");
        }

        const supplied = Buffer.from(match[2] ?? "", "utf8");
        const expected = Buffer.from(this._config.apiKey, "utf8");

        if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
            throw new CTGPromptServerError("UNAUTHORIZED", "Invalid or missing credentials.");
        }
    }

    // METHOD :: request, response, nextFunction -> VOID
    // Rejects non-JSON prompt submissions before body parsing.
    private _requireJson(req: Request, _res: Response, next: NextFunction): void {
        if (!req.is("application/json")) {
            next(new CTGPromptServerError("INVALID_CONTENT_TYPE", "Content-Type must be application/json."));
            return;
        }

        next();
    }

    // METHOD :: request, response, NUMBER -> VOID
    // Opens and manages an SSE stream for one prompt.
    private _openEventStream(req: Request, res: Response, id: number): void {
        this.queue.read(id);
        res.status(200);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        const afterSequence = this._parseLastEventId(req.header("last-event-id"));
        const subscription = this.queue.subscribe(id, res, afterSequence);
        let timer: NodeJS.Timeout | null = null;

        const close = (): void => {
            if (timer !== null) {
                clearInterval(timer);
                timer = null;
            }
            subscription.close();
        };

        res.on("close", close);
        if (!res.writableEnded) {
            timer = setInterval(() => {
                if (res.writableEnded) {
                    close();
                    return;
                }
                res.write(": keep-alive\n\n");
            }, this._config.keepAliveMs);
        }
    }

    // METHOD :: response, UNKNOWN, NUMBER -> VOID
    // Writes a success envelope.
    private _success(res: Response, result: PromptRecord | PromptListPage, status: number): void {
        res.status(status).json({
            success: true,
            result: Array.isArray((result as PromptListPage).prompts)
                ? {
                    prompts: (result as PromptListPage).prompts.map((prompt) => CTGPromptServer._serializePrompt(prompt)),
                    nextBefore: (result as PromptListPage).nextBefore
                }
                : CTGPromptServer._serializePrompt(result as PromptRecord)
        });
    }

    // METHOD :: STRING? -> NUMBER
    // Parses an id route segment.
    private _parseId(value: string | undefined): number {
        if (value === undefined || !/^[0-9]+$/.test(value)) {
            throw new CTGPromptServerError("INVALID_QUERY", "Invalid query.");
        }

        return Number(value);
    }

    // METHOD :: UNKNOWN -> NUMBER?
    // Parses the optional wait query parameter.
    private _parseWait(value: unknown): number | null {
        if (value === undefined) {
            return null;
        }
        if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
            throw new CTGPromptServerError("INVALID_QUERY", "Invalid query.");
        }

        return Number(value);
    }

    // METHOD :: request, promptStatus? -> promptListQuery
    // Parses list route query parameters.
    private _parseListQuery(req: Request, status: PromptStatus | null): PromptListQuery {
        const limit = this._parseOptionalPositiveInteger(req.query.limit, true);
        const before = this._parseOptionalPositiveInteger(req.query.before, false);

        return {
            ...(status === null ? {} : { status }),
            ...(limit === undefined ? {} : { limit }),
            ...(before === undefined ? {} : { before })
        };
    }

    // METHOD :: UNKNOWN, BOOLEAN -> NUMBER?
    // Parses limit or before query values.
    private _parseOptionalPositiveInteger(value: unknown, isLimit: boolean): number | undefined {
        if (value === undefined) {
            return undefined;
        }
        if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
            throw new CTGPromptServerError("INVALID_QUERY", "Invalid query.");
        }

        const parsed = Number(value);

        if (parsed < 1 || (isLimit && parsed > this._config.maxLimit)) {
            throw new CTGPromptServerError("INVALID_QUERY", "Invalid query.");
        }

        return parsed;
    }

    // METHOD :: STRING? -> promptStatus
    // Parses a status route segment.
    private _parseStatus(value: string | undefined): PromptStatus {
        if (value === "pending" || value === "active" || value === "done" || value === "error" || value === "cancelled") {
            return value;
        }

        throw new CTGPromptServerError("INVALID_QUERY", "Invalid query.");
    }

    // METHOD :: STRING? -> NUMBER
    // Parses Last-Event-ID for SSE replay.
    private _parseLastEventId(value: string | undefined): number {
        if (value === undefined || !/^[0-9]+$/.test(value)) {
            return 0;
        }

        return Number(value);
    }

    // METHOD :: VOID -> errorRequestHandler
    // Creates the single Express error handler.
    private _errorHandler(): ErrorRequestHandler {
        return (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
            if (res.headersSent) {
                res.end();
                return;
            }

            if (CTGPromptServerError.is(err) && typeof err.status === "number") {
                res.status(err.status).json({
                    success: false,
                    result: err.toResult()
                });
                return;
            }

            const bodyError = CTGPromptServer._bodyReaderError(err);

            if (bodyError !== null) {
                res.status(bodyError.status ?? 400).json({
                    success: false,
                    result: bodyError.toResult()
                });
                return;
            }

            const error = new CTGPromptServerError("INTERNAL_ERROR", "Internal error.");

            res.status(500).json({
                success: false,
                result: error.toResult()
            });
        };
    }

    // METHOD :: ((request, response) -> PROMISE(VOID)) -> (request, response, nextFunction -> VOID)
    // Wraps async route handlers for Express.
    private _asyncRoute(fn: (req: Request, res: Response) => Promise<void>): (req: Request, res: Response, next: NextFunction) => void {
        return (req: Request, res: Response, next: NextFunction): void => {
            fn(req, res).catch(next);
        };
    }

    /**
     *
     * Static Methods
     *
     */

    // Static Factory Method :: ctgPromptServerConfig -> ctgPromptServer
    // Validates config and constructs a server instance.
    static init(config: CTGPromptServerConfig): CTGPromptServer {
        return new this(CTGPromptServer._resolveConfig(config));
    }

    /**
     *
     * Private Static Methods
     *
     */

    // METHOD :: ctgPromptServerConfig -> resolvedServerConfig
    // Validates and resolves server config defaults.
    private static _resolveConfig(config: CTGPromptServerConfig): ResolvedServerConfig {
        try {
            if (!CTGPromptServer._isObject(config)) {
                throw new Error("Config must be an object.");
            }
            const runner = CTGPromptServer._resolveRunnerConfig(config.runner);
            const apiKey = CTGPromptServer._nonEmptyString(config.apiKey, "apiKey");
            const maxLimit = CTGPromptServer._optionalInteger(config.maxLimit, "maxLimit", 1, undefined) ?? 200;
            const defaultLimit = CTGPromptServer._optionalInteger(config.defaultLimit, "defaultLimit", 1, undefined) ?? 50;

            if (defaultLimit > maxLimit) {
                throw new Error("defaultLimit must be <= maxLimit.");
            }

            return {
                runner,
                apiKey,
                host: config.host === undefined ? "127.0.0.1" : CTGPromptServer._nonEmptyString(config.host, "host"),
                database: config.database === undefined ? "prompts.db" : CTGPromptServer._nonEmptyString(config.database, "database"),
                concurrency: CTGPromptServer._optionalInteger(config.concurrency, "concurrency", 1, undefined) ?? 1,
                maxPromptBytes: CTGPromptServer._optionalInteger(config.maxPromptBytes, "maxPromptBytes", 1, 131071) ?? 131071,
                streamMode: CTGPromptServer._resolveStreamMode(config.streamMode),
                keepAliveMs: CTGPromptServer._optionalInteger(config.keepAliveMs, "keepAliveMs", 1000, undefined) ?? 15000,
                maxWaitMs: CTGPromptServer._optionalInteger(config.maxWaitMs, "maxWaitMs", 0, undefined) ?? 30000,
                defaultLimit,
                maxLimit
            };
        } catch (caught) {
            if (CTGPromptServerError.is(caught)) {
                throw caught;
            }

            throw new CTGPromptServerError("INVALID_CONFIG", caught instanceof Error ? caught.message : String(caught), {
                cause: caught
            });
        }
    }

    // METHOD :: UNKNOWN -> ctgPromptRunnerConfig
    // Validates runner config.
    private static _resolveRunnerConfig(value: unknown): CTGPromptRunnerConfig {
        if (!CTGPromptServer._isObject(value) || (value.kind !== "claude" && value.kind !== "codex")) {
            throw new Error("runner.kind must be claude or codex.");
        }

        return {
            kind: value.kind as RunnerKind,
            ...(value.cwd === undefined ? {} : { cwd: CTGPromptServer._nonEmptyString(value.cwd, "runner.cwd") }),
            ...(value.args === undefined ? {} : { args: CTGPromptServer._stringArray(value.args, "runner.args") }),
            ...(value.env === undefined ? {} : { env: CTGPromptServer._objectEnv(value.env, "runner.env") }),
            ...(value.timeout === undefined ? {} : { timeout: CTGPromptServer._integer(value.timeout, "runner.timeout", 0, undefined) }),
            ...(value.maxBuffer === undefined ? {} : { maxBuffer: CTGPromptServer._integer(value.maxBuffer, "runner.maxBuffer", 1, undefined) })
        };
    }

    // METHOD :: streamMode? -> streamMode
    // Resolves the stream mode default.
    private static _resolveStreamMode(value: unknown): StreamMode {
        if (value === undefined) {
            return "events";
        }
        if (value === "raw" || value === "events") {
            return value;
        }

        throw new Error("streamMode must be raw or events.");
    }

    // METHOD :: promptRecord -> OBJECT
    // Removes operator-only fields from a prompt record.
    private static _serializePrompt(prompt: PromptRecord): Omit<PromptRecord, "info"> {
        return {
            id: prompt.id,
            status: prompt.status,
            prompt: prompt.prompt,
            response: prompt.response,
            errorType: prompt.errorType,
            errorMessage: prompt.errorMessage,
            runner: prompt.runner,
            lastSequence: prompt.lastSequence,
            createdAt: prompt.createdAt,
            startedAt: prompt.startedAt,
            finishedAt: prompt.finishedAt
        };
    }

    // METHOD :: UNKNOWN -> BOOLEAN
    // Narrows object values.
    private static _isObject(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null;
    }

    // METHOD :: UNKNOWN -> ctgPromptServerError?
    // Maps Express JSON reader failures to INVALID_BODY.
    private static _bodyReaderError(value: unknown): CTGPromptServerError | null {
        if (!CTGPromptServer._isObject(value) || typeof value.type !== "string") {
            return null;
        }

        if (value.type === "entity.parse.failed") {
            return new CTGPromptServerError("INVALID_BODY", "Body must parse as JSON.");
        }
        if (value.type === "entity.too.large") {
            return new CTGPromptServerError("INVALID_BODY", `Body exceeds the maximum of ${CTGPromptServer.BODY_LIMIT_BYTES.toLocaleString("en-US")} bytes.`);
        }

        return null;
    }

    // METHOD :: STRING|[STRING]? -> STRING?
    // Returns the first string from an Express param shape.
    private static _single(value: string | string[] | undefined): string | undefined {
        return Array.isArray(value) ? value[0] : value;
    }

    // METHOD :: UNKNOWN, STRING -> STRING
    // Validates non-empty strings.
    private static _nonEmptyString(value: unknown, label: string): string {
        if (typeof value !== "string" || value.trim() === "") {
            throw new Error(`${label} must be a non-empty string.`);
        }

        return value;
    }

    // METHOD :: UNKNOWN, STRING -> [STRING]
    // Validates an array of strings.
    private static _stringArray(value: unknown, label: string): string[] {
        if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
            throw new Error(`${label} must be an array of strings.`);
        }

        return [...value] as string[];
    }

    // METHOD :: UNKNOWN, STRING -> nodeProcessEnv
    // Validates a plain object for child env replacement.
    private static _objectEnv(value: unknown, label: string): NodeJS.ProcessEnv {
        if (!CTGPromptServer._isObject(value) || Array.isArray(value)) {
            throw new Error(`${label} must be an object.`);
        }

        return value as NodeJS.ProcessEnv;
    }

    // METHOD :: UNKNOWN, STRING, NUMBER, NUMBER? -> NUMBER?
    // Validates an optional integer range.
    private static _optionalInteger(value: unknown, label: string, min: number, max: number | undefined): number | undefined {
        if (value === undefined) {
            return undefined;
        }

        return CTGPromptServer._integer(value, label, min, max);
    }

    // METHOD :: UNKNOWN, STRING, NUMBER, NUMBER? -> NUMBER
    // Validates an integer range.
    private static _integer(value: unknown, label: string, min: number, max: number | undefined): number {
        if (!Number.isInteger(value) || typeof value !== "number" || value < min || (max !== undefined && value > max)) {
            throw new Error(`${label} is outside its valid range.`);
        }

        return value;
    }
}
