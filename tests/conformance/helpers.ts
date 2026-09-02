// Dependencies:
import { mkdtempSync, rmSync } from "node:fs";                         // Creates and removes hermetic suite database directories
import { tmpdir } from "node:os";                                      // Supplies the system temp root for suite databases
import { join } from "node:path";                                      // Builds portable temp database paths
import { request } from "node:http";                                   // Exercises the public HTTP surface over loopback
import { LLMRunner, LLMRunnerError, LLMRunnerOutputEvent } from "ctg-ai-agent-proc"; // Real upstream runner base, error, and output event classes

// Type dependencies:
import type { IncomingHttpHeaders } from "node:http";                  // Captured response headers from route assertions
import type {
    LLMRunnerResult,                                                    // Upstream result shape returned by FakeRunner
    LLMRunnerRunConfig,                                                 // Per-run config whose exact key set is asserted
    LLMRunnerStreamEvent                                                // Upstream event type accepted by onStream
} from "ctg-ai-agent-proc";
import {
    CTGPromptServer,                                                    // Public server subclassed to inject FakeRunner through createRunner
    type CTGPromptDB,                                                   // Public DB surface used for observable row assertions
    type CTGPromptRunnerConfig,                                         // Protected createRunner argument declared by the spec
    type CTGPromptServerConfig,                                         // Server config shape used by test construction helpers
    type EventRecord,                                                   // Durable event record shape asserted in DB/SSE cases
    type PromptListPage,                                                // List response shape asserted by route and DB cases
    type PromptRecord,                                                  // Prompt record shape asserted throughout conformance
    type PromptStatus,                                                  // Lifecycle state literals used by table-driven cases
    type StreamMode                                                     // Per-run stream mode asserted by FakeRunner
} from "../../src/index.ts";

/**
 *
 * Type Declarations
 *
 */

// TYPE :: {behavior:"resolve", events:[llmRunnerStreamEvent], result:STRING, error:STRING?, expectedPrompt:STRING?}
// FakeRunner script for a successful run after emitting all configured events.
export interface ResolveScript {
    readonly behavior: "resolve";                       // Discriminant for successful scripted execution
    readonly events: readonly LLMRunnerStreamEvent[];    // Real upstream stream events emitted through onStream
    readonly result: string;                             // Final stdout/result returned to the queue
    readonly error?: string;                             // Final stderr diagnostic returned to the queue
    readonly expectedPrompt?: string;                    // Optional byte-identical prompt contract override
}

// TYPE :: {behavior:"reject", error:llmRunnerError, expectedPrompt:STRING?}
// FakeRunner script for a rejected runner promise with a real LLMRunnerError.
export interface RejectScript {
    readonly behavior: "reject";                        // Discriminant for promise rejection
    readonly error: LLMRunnerError;                      // Real upstream typed runner failure
    readonly expectedPrompt?: string;                    // Optional byte-identical prompt contract override
}

// TYPE :: {behavior:"throw", error:UNKNOWN, expectedPrompt:STRING?}
// FakeRunner script for a synchronous throw from run().
export interface ThrowScript {
    readonly behavior: "throw";                         // Discriminant for synchronous throw behavior
    readonly error: unknown;                             // Value thrown directly from run()
    readonly expectedPrompt?: string;                    // Optional byte-identical prompt contract override
}

// TYPE :: {behavior:"block", events:[llmRunnerStreamEvent], expectedPrompt:STRING?}
// FakeRunner script for a run held open until the test releases it.
export interface BlockScript {
    readonly behavior: "block";                         // Discriminant for deterministic in-flight assertions
    readonly events?: readonly LLMRunnerStreamEvent[];   // Events emitted before the run blocks
    readonly expectedPrompt?: string;                    // Optional byte-identical prompt contract override
}

// TYPE :: resolveScript|rejectScript|throwScript|blockScript
// Closed set of FakeRunner behaviors required by §11.
export type FakeRunnerScript = ResolveScript | RejectScript | ThrowScript | BlockScript;

// TYPE :: {prompt:STRING, configKeys:[STRING], streamMode:streamMode?}
// Observable invocation record retained by FakeRunner.
export interface FakeRunnerCall {
    readonly prompt: string;                             // Prompt text as run() received it
    readonly configKeys: readonly string[];              // Own config keys supplied to run()
    readonly streamMode: StreamMode | undefined;         // streamMode value supplied to run()
}

// TYPE :: {status:NUMBER, headers:incomingHttpHeaders, raw:STRING, body:UNKNOWN}
// HTTP response captured by route tests.
export interface HTTPTestResponse {
    readonly status: number;                             // HTTP status code returned by the server
    readonly headers: IncomingHttpHeaders;               // Response headers observed on the wire
    readonly raw: string;                                // Raw body text decoded as UTF-8
    readonly body: unknown;                              // JSON parsed body, or null for an empty body
}

// TYPE :: {method:STRING, path:STRING, port:NUMBER, apiKey:STRING?, body:UNKNOWN?, contentType:STRING?, headers:ARRAY<STRING, STRING>?}
// HTTP request options accepted by the loopback test client.
export interface HTTPTestRequest {
    readonly method: string;                             // HTTP method under test
    readonly path: string;                               // Request path and query string
    readonly port: number;                               // Loopback port assigned to the server
    readonly apiKey?: string;                            // Bearer key to attach unless omitted
    readonly body?: unknown;                             // JSON-serializable body, string body, or undefined
    readonly contentType?: string;                       // Explicit Content-Type header
    readonly headers?: Readonly<Record<string, string>>; // Extra headers for route-specific assertions
}

// TYPE :: {port:NUMBER, server:ctgPromptServer, runner:fakeRunner}
// Started server fixture returned by HTTP/SSE helpers.
export interface StartedServerFixture {
    readonly port: number;                               // Actual loopback port bound by start(0)
    readonly server: CTGPromptServer;                    // Started server instance under test
    readonly runner: FakeRunner;                         // Scripted runner injected into the server
}

/**
 *
 * Constants
 *
 */

export const API_KEY = "ctg-test-key";                   // Shared key used by authenticated route cases
export const PROMPT_RECORD_KEYS = [                       // §8.3 exact serialized prompt key set
    "createdAt",
    "errorMessage",
    "errorType",
    "finishedAt",
    "id",
    "lastSequence",
    "prompt",
    "response",
    "runner",
    "startedAt",
    "status"
] as const;
export const PROMPT_LIST_KEYS = [                         // §8.3 exact list envelope result key set
    "nextBefore",
    "prompts"
] as const;
export const ERROR_RESULT_KEYS = [                         // §8.3 exact error result key set
    "code",
    "message",
    "type"
] as const;
export const SUCCESS_ENVELOPE_KEYS = [                     // §8.3 exact success envelope key set
    "result",
    "success"
] as const;

const TEMP_PATHS: string[] = [];                           // Suite temp directories removed by cleanupTempDatabases()

/**
 *
 * Class
 *
 */

// Scripted LLMRunner that uses real upstream event and error classes without invoking a CLI
export class FakeRunner extends LLMRunner {

    /* Instance Fields */
    readonly violations: readonly string[];                           // Public non-fatal §11 contract failures observed by run()
    private readonly _scripts: FakeRunnerScript[];                  // Pending scripts consumed one per run() call
    private readonly _expectedStreamMode: StreamMode;               // Expected per-run streamMode from queue config
    private readonly _calls: FakeRunnerCall[];                      // Recorded invocation contracts for assertions
    private readonly _violations: string[];                         // Non-fatal §11 contract failures observed by run()
    private readonly _blockedResolvers: Array<(value: LLMRunnerResult) => void>; // Release hooks for blocked runs

    // CONSTRUCTOR :: [fakeRunnerScript], streamMode -> this
    // Creates a scripted runner over the real upstream LLMRunner base class.
    constructor(scripts: readonly FakeRunnerScript[], expectedStreamMode: StreamMode = "events") {
        super({
            command: "node"
        });
        this._scripts = [...scripts];
        this._expectedStreamMode = expectedStreamMode;
        this._calls = [];
        this._violations = [];
        this.violations = this._violations;
        this._blockedResolvers = [];
    }

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> [fakeRunnerCall]
    // Returns every run() invocation observed so far.
    get calls(): readonly FakeRunnerCall[] {
        return this._calls;
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: STRING, llmRunnerRunConfig -> PROMISE(llmRunnerResult)
    // Executes the next scripted behavior after asserting the §5.4 call contract.
    override run(prompt: string, config: LLMRunnerRunConfig = {}): Promise<LLMRunnerResult> {
        const script = this._scripts.shift();

        if (script === undefined) {
            throw new Error("FakeRunner was called without a script.");
        }

        this._recordCallContractViolations(prompt, config, script.expectedPrompt);
        this._calls.push({
            prompt,
            configKeys: Object.keys(config).sort(),
            streamMode: config.streamMode
        });

        if (script.behavior === "throw") {
            throw script.error;
        }

        if (script.behavior === "reject") {
            return Promise.reject(script.error);
        }

        this._emit(script.events ?? [], config);

        if (script.behavior === "block") {
            return new Promise<LLMRunnerResult>((resolve) => {
                this._blockedResolvers.push(resolve);
            });
        }

        return Promise.resolve({
            result: script.result,
            error: script.error ?? ""
        });
    }

    // METHOD :: NUMBER, STRING?, STRING? -> VOID
    // Releases a blocked run with the supplied final result.
    release(callIndex: number, result = "released", error = ""): void {
        const resolve = this._blockedResolvers[callIndex];

        if (resolve === undefined) {
            throw new Error(`No blocked FakeRunner call at index ${callIndex}.`);
        }

        resolve({
            result,
            error
        });
    }

    /**
     *
     * Private Methods
     *
     */

    // METHOD :: STRING, llmRunnerRunConfig, STRING? -> VOID
    // Records byte-identical prompt and exact per-run streaming option violations.
    private _recordCallContractViolations(prompt: string, config: LLMRunnerRunConfig, expectedPrompt?: string): void {
        const expected = expectedPrompt ?? prompt;

        if (Buffer.compare(Buffer.from(prompt, "utf8"), Buffer.from(expected, "utf8")) !== 0) {
            this._violations.push("FakeRunner received transformed prompt text.");
        }

        const keys = Object.keys(config).sort();

        if (JSON.stringify(keys) !== JSON.stringify(["onStream", "streamMode", "streamOutput"])) {
            this._violations.push(`FakeRunner received config keys ${keys.join(",")}.`);
        }

        if (config.streamOutput !== true) {
            this._violations.push("FakeRunner expected streamOutput: true.");
        }
        if (config.streamMode !== this._expectedStreamMode) {
            this._violations.push("FakeRunner received the wrong streamMode.");
        }
        if (typeof config.onStream !== "function") {
            this._violations.push("FakeRunner expected an onStream function.");
        }
    }

    // METHOD :: [llmRunnerStreamEvent], llmRunnerRunConfig -> VOID
    // Sends scripted upstream events through the supplied stream callback.
    private _emit(events: readonly LLMRunnerStreamEvent[], config: LLMRunnerRunConfig): void {
        for (const event of events) {
            config.onStream?.(event);
        }
    }
}

// Server subclass that injects the current FakeRunner through the protected seam required by §4.2
export class TestPromptServer extends CTGPromptServer {

    /* Static Fields */
    static fake: FakeRunner | null = null;      // Runner returned by createRunner for the next started fixture

    /**
     *
     * Protected Methods
     *
     */

    // METHOD :: ctgPromptRunnerConfig -> llmRunner
    // Returns the scripted runner while preserving ordinary config construction.
    protected override createRunner(_config: CTGPromptRunnerConfig): LLMRunner {
        if (TestPromptServer.fake === null) {
            throw new Error("TestPromptServer.fake was not set.");
        }

        return TestPromptServer.fake;
    }
}

/**
 *
 * Functions
 *
 */

// METHOD :: STRING -> STRING
// Creates a temp database path for a hermetic suite or case.
export const tempDatabasePath = (label: string): string => {
    const directory = mkdtempSync(join(tmpdir(), `ctg-ts-prompt-server-${label}-`));
    const path = join(directory, "prompts.db");

    TEMP_PATHS.push(directory);

    return path;
};

// METHOD :: VOID -> VOID
// Removes every temp database directory created by this process.
export const cleanupTempDatabases = (): void => {
    for (const path of TEMP_PATHS.splice(0)) {
        rmSync(path, {
            recursive: true,
            force: true
        });
    }
};

// METHOD :: [fakeRunnerScript], PARTIAL(ctgPromptServerConfig)? -> PROMISE(startedServerFixture)
// Starts a CTGPromptServer fixture with a FakeRunner and a temp database.
export const startServerFixture = async (
    scripts: readonly FakeRunnerScript[],
    config: Partial<CTGPromptServerConfig> = {}
): Promise<StartedServerFixture> => {
    const streamMode = config.streamMode ?? "events";
    const runner = new FakeRunner(scripts, streamMode);

    TestPromptServer.fake = runner;

    const server = TestPromptServer.init({
        runner: {
            kind: config.runner?.kind ?? "claude",
            ...(config.runner?.cwd === undefined ? {} : { cwd: config.runner.cwd }),
            ...(config.runner?.args === undefined ? {} : { args: config.runner.args }),
            ...(config.runner?.env === undefined ? {} : { env: config.runner.env }),
            ...(config.runner?.timeout === undefined ? {} : { timeout: config.runner.timeout }),
            ...(config.runner?.maxBuffer === undefined ? {} : { maxBuffer: config.runner.maxBuffer })
        },
        apiKey: config.apiKey ?? API_KEY,
        host: "127.0.0.1",
        database: config.database ?? tempDatabasePath("server"),
        concurrency: config.concurrency ?? 1,
        maxPromptBytes: config.maxPromptBytes ?? 131071,
        streamMode,
        keepAliveMs: config.keepAliveMs ?? 1000,
        maxWaitMs: config.maxWaitMs ?? 30000,
        defaultLimit: config.defaultLimit ?? 50,
        maxLimit: config.maxLimit ?? 200
    });

    const bound = await server.start(0);

    return {
        port: bound.port,
        server,
        runner
    };
};

// METHOD :: httpTestRequest -> PROMISE(httpTestResponse)
// Sends one HTTP request to a started fixture over loopback.
export const httpRequest = async (config: HTTPTestRequest): Promise<HTTPTestResponse> => {
    const bodyText = config.body === undefined
        ? ""
        : typeof config.body === "string"
            ? config.body
            : JSON.stringify(config.body);
    const headers: Record<string, string | number> = {
        ...(config.headers ?? {})
    };

    if (config.apiKey !== undefined) {
        headers.Authorization = `Bearer ${config.apiKey}`;
    }
    if (config.contentType !== undefined) {
        headers["Content-Type"] = config.contentType;
    }
    if (bodyText !== "") {
        headers["Content-Length"] = Buffer.byteLength(bodyText, "utf8");
    }

    return await new Promise<HTTPTestResponse>((resolve, reject) => {
        const req = request({
            host: "127.0.0.1",
            port: config.port,
            method: config.method,
            path: config.path,
            headers
        }, (res) => {
            let raw = "";

            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
                raw += chunk;
            });
            res.on("end", () => {
                let body: unknown = null;

                if (raw !== "") {
                    body = JSON.parse(raw) as unknown;
                }

                resolve({
                    status: res.statusCode ?? 0,
                    headers: res.headers,
                    raw,
                    body
                });
            });
        });

        req.once("error", reject);
        if (bodyText !== "") {
            req.write(bodyText);
        }
        req.end();
    });
};

// METHOD :: (VOID -> UNKNOWN) -> UNKNOWN
// Captures a thrown value without letting a CTGTest operation error.
export const captureThrown = (fn: () => unknown): unknown => {
    try {
        fn();
        return null;
    } catch (caught) {
        return caught;
    }
};

// METHOD :: (VOID -> PROMISE(UNKNOWN)) -> PROMISE(UNKNOWN)
// Captures a rejected value without letting a CTGTest operation error.
export const captureRejected = async (fn: () => Promise<unknown>): Promise<unknown> => {
    try {
        await fn();
        return null;
    } catch (caught) {
        return caught;
    }
};

// METHOD :: UNKNOWN -> BOOLEAN
// Checks for plain object values before key assertions.
export const isObject = (value: unknown): value is Record<string, unknown> => {
    return typeof value === "object" && value !== null;
};

// METHOD :: UNKNOWN, [STRING] -> BOOLEAN
// Asserts the exact own enumerable key set of an object.
export const hasExactKeys = (value: unknown, keys: readonly string[]): boolean => {
    if (!isObject(value)) {
        return false;
    }

    return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
};

// METHOD :: UNKNOWN, [STRING] -> VOID
// Throws when an object does not have the exact required key set.
export const assertExactKeys = (value: unknown, keys: readonly string[]): void => {
    if (!hasExactKeys(value, keys)) {
        throw new Error(`Expected exact keys ${keys.join(", ")}.`);
    }
};

// METHOD :: UNKNOWN, UNKNOWN -> VOID
// Throws when JSON-stable deep equality fails.
export const assertDeepEqual = (actual: unknown, expected: unknown): void => {
    const actualText = JSON.stringify(actual);
    const expectedText = JSON.stringify(expected);

    if (actualText !== expectedText) {
        throw new Error(`Expected ${expectedText}, received ${actualText}.`);
    }
};

// METHOD :: httpTestResponse, STRING, NUMBER -> BOOLEAN
// Verifies §8.3 error envelope shape, type string, and HTTP status.
export const isErrorEnvelope = (response: HTTPTestResponse, type: string, status: number): boolean => {
    if (response.status !== status || !hasExactKeys(response.body, SUCCESS_ENVELOPE_KEYS)) {
        return false;
    }
    if (!isObject(response.body) || response.body.success !== false || !hasExactKeys(response.body.result, ERROR_RESULT_KEYS)) {
        return false;
    }

    const result = response.body.result;

    return isObject(result) && result.type === type;
};

// METHOD :: httpTestResponse -> promptRecord?
// Extracts and key-checks one prompt record from a success envelope.
export const promptResult = (response: HTTPTestResponse): PromptRecord | null => {
    if (!isObject(response.body) || response.body.success !== true || !hasExactKeys(response.body, SUCCESS_ENVELOPE_KEYS)) {
        return null;
    }
    if (!hasExactKeys(response.body.result, PROMPT_RECORD_KEYS)) {
        return null;
    }

    return response.body.result as PromptRecord;
};

// METHOD :: httpTestResponse -> promptListPage?
// Extracts and key-checks one prompt list page from a success envelope.
export const promptListResult = (response: HTTPTestResponse): PromptListPage | null => {
    if (!isObject(response.body) || response.body.success !== true || !hasExactKeys(response.body, SUCCESS_ENVELOPE_KEYS)) {
        return null;
    }
    if (!hasExactKeys(response.body.result, PROMPT_LIST_KEYS)) {
        return null;
    }

    const page = response.body.result;

    if (!isObject(page) || !Array.isArray(page.prompts)) {
        return null;
    }
    for (const prompt of page.prompts) {
        if (!hasExactKeys(prompt, PROMPT_RECORD_KEYS)) {
            return null;
        }
    }

    return page as PromptListPage;
};

// METHOD :: STRING, STRING, STRING? -> llmRunnerOutputEvent
// Creates a real upstream raw output event.
export const outputEvent = (stream: "stdout" | "stderr", chunk: string, source = "FakeRunner"): LLMRunnerOutputEvent => {
    return new LLMRunnerOutputEvent(source, stream, chunk, Buffer.from(chunk, "utf8"));
};

// METHOD :: NUMBER -> PROMISE(VOID)
// Waits for async continuations and timers in deterministic queue tests.
export const delay = async (ms: number): Promise<void> => {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
};

// METHOD :: (VOID -> BOOLEAN), NUMBER? -> PROMISE(BOOLEAN)
// Polls until a condition is true or the timeout expires.
export const waitUntil = async (predicate: () => boolean, timeoutMs = 500): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (predicate()) {
            return true;
        }
        await delay(10);
    }

    return predicate();
};

// METHOD :: ctgPromptDB, NUMBER -> [eventRecord]
// Reads all durable events for a prompt.
export const allEvents = (db: CTGPromptDB, id: number): EventRecord[] => {
    return db.readEvents(id, 0);
};

// METHOD :: promptStatus -> BOOLEAN
// Returns whether a status is one of the three finished states.
export const isFinishedStatus = (status: PromptStatus): boolean => {
    return status === "done" || status === "error" || status === "cancelled";
};
