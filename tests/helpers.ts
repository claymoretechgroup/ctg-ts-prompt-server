// Dependencies:
import type { Response } from "express"; // Express response shape used by error sendResponse tests

// Dependencies:
import { request } from "node:http"; // Exercises the public HTTP surface over loopback

// Type dependencies:
import type { IncomingHttpHeaders } from "node:http"; // Captured response headers from route assertions

/**
 *
 * Type Declarations
 *
 */

// TYPE :: OBJECT
// Runtime view of the package public module used by surface tests.
export type PublicModule = Record<string, unknown>;

// TYPE :: {status:NUMBER, headers:incomingHttpHeaders, raw:STRING, body:UNKNOWN}
// HTTP response captured by route tests.
export interface HTTPTestResponse {
    readonly status: number;
    readonly headers: IncomingHttpHeaders;
    readonly raw: string;
    readonly body: unknown;
}

// TYPE :: {method:STRING, path:STRING, port:NUMBER, apiKey:STRING?, body:UNKNOWN?, contentType:STRING?, headers:OBJECT?}
// HTTP request options accepted by the loopback test client.
export interface HTTPTestRequest {
    readonly method: string;
    readonly path: string;
    readonly port: number;
    readonly apiKey?: string;
    readonly body?: unknown;
    readonly contentType?: string;
    readonly headers?: Readonly<Record<string, string>>;
}

// TYPE :: {statusCode:NUMBER|null, body:UNKNOWN}
// Captured response side effects from sendResponse().
export interface CapturedResponse {
    readonly statusCode: number | null;
    readonly body: unknown;
}

// TYPE :: new(NUMBER, STRING, UNKNOWN?) -> serverError
// Constructor/static shape expected from CTGPromptServerError.
export interface CTGPromptServerErrorConstructor {
    readonly CODE: Readonly<Record<string, number>>;
    new (code: number, message: string, data?: null | boolean | number | string | object): CTGPromptServerErrorInstance;
    init(
        code: number,
        message: string,
        data?: null | boolean | number | string | object
    ): CTGPromptServerErrorInstance;
    is(value: unknown): boolean;
    labelOf(code: number): string;
}

// TYPE :: serverError instance shape
// Instance shape expected from CTGPromptServerError.
export interface CTGPromptServerErrorInstance {
    readonly code: number;
    readonly data: null | boolean | number | string | object;
    readonly label: string;
    readonly message: string;
    toResponse(): unknown;
    sendResponse(response: Response): void;
}

// TYPE :: new(NUMBER, NUMBER, STRING, UNKNOWN?) -> requestError
// Constructor/static shape expected from CTGPromptServerRequestError.
export interface CTGPromptServerRequestErrorConstructor extends CTGPromptServerErrorConstructor {
    new (
        code: number,
        status: number,
        message: string,
        data?: null | boolean | number | string | object
    ): CTGPromptServerRequestErrorInstance;
    init(
        code: number,
        status: number,
        message: string,
        data?: null | boolean | number | string | object
    ): CTGPromptServerRequestErrorInstance;
    unauthorized(message: string, data?: null | boolean | number | string | object): CTGPromptServerRequestErrorInstance;
    invalidContentType(message: string, data?: null | boolean | number | string | object): CTGPromptServerRequestErrorInstance;
    invalidBody(message: string, data?: null | boolean | number | string | object): CTGPromptServerRequestErrorInstance;
    invalidPrompt(message: string, data?: null | boolean | number | string | object): CTGPromptServerRequestErrorInstance;
    invalidQuery(message: string, data?: null | boolean | number | string | object): CTGPromptServerRequestErrorInstance;
    promptNotFound(message: string, data?: null | boolean | number | string | object): CTGPromptServerRequestErrorInstance;
    cancelNotAllowed(message: string, data?: null | boolean | number | string | object): CTGPromptServerRequestErrorInstance;
    notFound(message: string, data?: null | boolean | number | string | object): CTGPromptServerRequestErrorInstance;
    methodNotAllowed(message: string, data?: null | boolean | number | string | object): CTGPromptServerRequestErrorInstance;
}

// TYPE :: serverError & {status:NUMBER}
// Instance shape expected from CTGPromptServerRequestError.
export interface CTGPromptServerRequestErrorInstance extends CTGPromptServerErrorInstance {
    readonly status: number;
}

// TYPE :: {STATUS:OBJECT}
// Static shape expected from CTGPromptServerQueue.
export interface CTGPromptServerQueueConstructor {
    readonly STATUS: Readonly<Record<string, number>>;
    statusOf(code: number): string;
}

// TYPE :: DB record shape
// Runtime shape returned by CTGPromptServerDB.
export interface CTGPromptServerQueueRecord {
    readonly id: number;
    readonly statusCode: number;
    readonly prompt: string;
    readonly response: string;
    readonly errorCode: number | null;
    readonly errorMessage: string | null;
    readonly runner: string | null;
    readonly createdAt: number;
    readonly startedAt: number | null;
    readonly finishedAt: number | null;
}

// TYPE :: DB instance shape
// Runtime shape expected from CTGPromptServerDB.
export interface CTGPromptServerDBInstance {
    create(prompt: string): CTGPromptServerQueueRecord;
    read(id: number): CTGPromptServerQueueRecord | null;
    paginate(query: { statusCode?: number; limit: number; before?: number }): {
        records: CTGPromptServerQueueRecord[];
        nextBefore: number | null;
    };
    update(record: CTGPromptServerQueueRecord): CTGPromptServerQueueRecord;
    delete(id: number): CTGPromptServerQueueRecord | null;
    append(id: number, text: string): CTGPromptServerQueueRecord;
    claimNext(): CTGPromptServerQueueRecord | null;
    finish(id: number, outcome: {
        statusCode: number;
        response?: string;
        errorCode?: number;
        errorMessage?: string;
    }): CTGPromptServerQueueRecord;
    cancel(id: number): CTGPromptServerQueueRecord;
    interruptActive(): number;
    purgeFinished(): number;
    purgeAll(): number;
    reset(): void;
    close(): void;
}

// TYPE :: server instance shape used by route tests
// Runtime shape expected from CTGPromptServer.
export interface CTGPromptServerInstance {
    readonly db: CTGPromptServerDBInstance;
    readonly queue: unknown;
    start(port: number): Promise<{ host: string; port: number }>;
    close(): Promise<void>;
}

// TYPE :: {init:FUNCTION}
// Static shape expected from CTGPromptServer.
export interface CTGPromptServerConstructor {
    init(config: {
        runner: {
            kind: "claude" | "codex";
        };
        apiKey: string;
        database: string;
        host?: string;
        initDB?: boolean;
        concurrency?: number;
        maxPromptBytes?: number;
        streamMode?: "raw" | "events";
        keepAliveMs?: number;
        maxWaitMs?: number;
        defaultLimit?: number;
        maxLimit?: number;
    }): CTGPromptServerInstance;
}

// TYPE :: {init:FUNCTION}
// Static shape expected from CTGPromptServerDB.
export interface CTGPromptServerDBConstructor {
    init(config: { path: string; initDB?: boolean }): CTGPromptServerDBInstance;
}

/**
 *
 * Functions
 *
 */

// FUNCTION :: VOID -> PROMISE(publicModule)
// Loads the package source entry point without statically depending on exports.
export const loadPublicModule = async (): Promise<PublicModule> => {
    return await import("../src/index.ts") as PublicModule;
};

// FUNCTION :: UNKNOWN -> ctgPromptServerErrorConstructor|null
// Returns the expected error constructor shape when a value looks constructable.
export const asServerErrorConstructor = (value: unknown): CTGPromptServerErrorConstructor | null => {
    return typeof value === "function"
        && typeof (value as { CODE?: unknown }).CODE === "object"
        && (value as { CODE?: unknown }).CODE !== null
        ? value as CTGPromptServerErrorConstructor
        : null;
};

// FUNCTION :: UNKNOWN -> ctgPromptServerRequestErrorConstructor|null
// Returns the expected request error constructor shape when a value looks constructable.
export const asRequestErrorConstructor = (value: unknown): CTGPromptServerRequestErrorConstructor | null => {
    return typeof value === "function"
        && typeof (value as { CODE?: unknown }).CODE === "object"
        && (value as { CODE?: unknown }).CODE !== null
        ? value as CTGPromptServerRequestErrorConstructor
        : null;
};

// FUNCTION :: UNKNOWN -> ctgPromptServerQueueConstructor|null
// Returns the expected queue constructor shape when a value looks constructable.
export const asQueueConstructor = (value: unknown): CTGPromptServerQueueConstructor | null => {
    return typeof value === "function"
        && typeof (value as { STATUS?: unknown }).STATUS === "object"
        && (value as { STATUS?: unknown }).STATUS !== null
        ? value as CTGPromptServerQueueConstructor
        : null;
};

// FUNCTION :: UNKNOWN -> ctgPromptServerDBConstructor|null
// Returns the expected DB constructor shape when a value looks constructable.
export const asDBConstructor = (value: unknown): CTGPromptServerDBConstructor | null => {
    return typeof value === "function"
        && typeof (value as { init?: unknown }).init === "function"
        ? value as CTGPromptServerDBConstructor
        : null;
};

// FUNCTION :: UNKNOWN -> ctgPromptServerConstructor|null
// Returns the expected server constructor shape when a value looks constructable.
export const asServerConstructor = (value: unknown): CTGPromptServerConstructor | null => {
    return typeof value === "function"
        && typeof (value as { init?: unknown }).init === "function"
        ? value as CTGPromptServerConstructor
        : null;
};

// FUNCTION :: FUNCTION -> UNKNOWN
// Captures a thrown value so constructor failures can be asserted as values.
export const captureThrown = (fn: () => void): unknown => {
    try {
        fn();
        return undefined;
    } catch (error) {
        return error;
    }
};

// FUNCTION :: VOID -> {response:Response, capture:capturedResponse}
// Builds a minimal chainable Express-like response for sendResponse tests.
export const fakeResponse = (): { response: Response; capture: CapturedResponse } => {
    const capture: {
        statusCode: number | null;
        body: unknown;
    } = {
        statusCode: null,
        body: undefined
    };

    const response = {
        status(statusCode: number) {
            capture.statusCode = statusCode;
            return this;
        },
        json(body: unknown) {
            capture.body = body;
            return this;
        }
    };

    return {
        response: response as Response,
        capture
    };
};

// FUNCTION :: httpTestRequest -> PROMISE(httpTestResponse)
// Sends one loopback HTTP request and parses JSON responses when possible.
export const httpRequest = async (options: HTTPTestRequest): Promise<HTTPTestResponse> => {
    const body = options.body === undefined
        ? undefined
        : typeof options.body === "string"
            ? options.body
            : JSON.stringify(options.body);
    const headers: Record<string, string | number> = {
        ...(options.headers ?? {})
    };

    if (options.apiKey !== undefined) {
        headers.Authorization = `Bearer ${options.apiKey}`;
    }
    if (body !== undefined) {
        headers["Content-Length"] = Buffer.byteLength(body);
        headers["Content-Type"] = options.contentType ?? "application/json";
    } else if (options.contentType !== undefined) {
        headers["Content-Type"] = options.contentType;
    }

    return await new Promise<HTTPTestResponse>((resolve, reject) => {
        const req = request({
            host: "127.0.0.1",
            port: options.port,
            method: options.method,
            path: options.path,
            headers
        }, (res) => {
            const chunks: Buffer[] = [];

            res.on("data", (chunk: Buffer) => {
                chunks.push(chunk);
            });
            res.on("end", () => {
                const raw = Buffer.concat(chunks).toString("utf8");
                let parsed: unknown = null;

                if (raw !== "") {
                    try {
                        parsed = JSON.parse(raw);
                    } catch {
                        parsed = null;
                    }
                }

                resolve({
                    status: res.statusCode ?? 0,
                    headers: res.headers,
                    raw,
                    body: parsed
                });
            });
        });

        req.on("error", reject);
        if (body !== undefined) {
            req.write(body);
        }
        req.end();
    });
};

// FUNCTION :: UNKNOWN -> BOOLEAN
// Narrows non-null object values.
export const isObject = (value: unknown): value is Record<string, unknown> => {
    return typeof value === "object" && value !== null;
};

// FUNCTION :: httpTestResponse, NUMBER, NUMBER -> BOOLEAN
// Checks the exact public error response envelope.
export const isErrorEnvelope = (response: HTTPTestResponse, code: number, status: number): boolean => {
    if (response.status !== status || !isObject(response.body) || response.body.success !== false || !isObject(response.body.result)) {
        return false;
    }

    return Object.keys(response.body).sort().join(",") === "result,success"
        && Object.keys(response.body.result).sort().join(",") === "code,message"
        && response.body.result.code === code
        && typeof response.body.result.message === "string";
};

// FUNCTION :: httpTestResponse -> OBJECT?
// Extracts a successful response result.
export const successResult = (response: HTTPTestResponse): Record<string, unknown> | null => {
    if (response.status < 200 || response.status > 299 || !isObject(response.body) || response.body.success !== true || !isObject(response.body.result)) {
        return null;
    }

    return response.body.result;
};
