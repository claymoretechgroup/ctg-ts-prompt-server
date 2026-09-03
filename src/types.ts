// Type dependencies:
import type { LLMRunner } from "ctg-ai-agent-proc"; // Runner instance accepted by the queue

/**
 *
 * Type Declarations
 *
 */

// TYPE :: "pending"|"active"|"done"|"error"|"cancelled"
// Prompt lifecycle states.
export type PromptStatus = "pending" | "active" | "done" | "error" | "cancelled";

// TYPE :: "pending"|"active"|"done"|"error"|"cancelled"|"output"|"stream"
// Durable event names.
export type PromptEventName = PromptStatus | "output" | "stream";

// TYPE :: "claude"|"codex"
// Supported runner kinds.
export type RunnerKind = "claude" | "codex";

// TYPE :: "raw"|"events"
// Runner stream modes exposed by config.
export type StreamMode = "raw" | "events";

// TYPE :: "RUNNER"|"SERVER"|"INTERRUPTED"
// Prompt outcome failure classes.
export type PromptOutcomeErrorType = "RUNNER" | "SERVER" | "INTERRUPTED";

// TYPE :: request-error literals
// HTTP/startup error classes.
export type PromptRequestErrorType =
    | "INVALID_CONFIG"
    | "UNAUTHORIZED"
    | "INVALID_CONTENT_TYPE"
    | "INVALID_BODY"
    | "INVALID_PROMPT"
    | "INVALID_QUERY"
    | "PROMPT_NOT_FOUND"
    | "CANCEL_NOT_ALLOWED"
    | "NOT_FOUND"
    | "METHOD_NOT_ALLOWED"
    | "STORE_FAILED"
    | "INTERNAL_ERROR";

// TYPE :: promptRequestErrorType|promptOutcomeErrorType
// All server error types.
export type PromptServerErrorType = PromptRequestErrorType | PromptOutcomeErrorType;

// TYPE :: {id:NUMBER, status:promptStatus, prompt:STRING, response:STRING, errorType:promptOutcomeErrorType?, errorMessage:STRING?, info:OBJECT?, runner:runnerKind?, lastSequence:NUMBER, createdAt:NUMBER, startedAt:NUMBER?, finishedAt:NUMBER?}
// Complete durable prompt record.
export interface PromptRecord {
    readonly id: number;                                           // SQLite prompt identity
    readonly status: PromptStatus;                                 // Current lifecycle state
    readonly prompt: string;                                       // Stored prompt text
    readonly response: string;                                     // Accumulated or final response text
    readonly errorType: PromptOutcomeErrorType | null;             // Failure class for error status
    readonly errorMessage: string | null;                          // Failure message for error status
    readonly info: Readonly<Record<string, unknown>> | null;       // Operator-only diagnostics
    readonly runner: RunnerKind | null;                            // Runner kind bound at claim
    readonly lastSequence: number;                                 // Highest durable event sequence
    readonly createdAt: number;                                    // Submit timestamp in epoch ms
    readonly startedAt: number | null;                             // Claim timestamp in epoch ms
    readonly finishedAt: number | null;                            // Finished timestamp in epoch ms
}

// TYPE :: {promptId:NUMBER, sequence:NUMBER, name:promptEventName, payload:UNKNOWN, createdAt:NUMBER}
// One durable prompt event.
export interface EventRecord {
    readonly promptId: number;                                     // Owning prompt id
    readonly sequence: number;                                     // Per-prompt sequence
    readonly name: PromptEventName;                                // Event name
    readonly payload: unknown;                                     // Parsed payload object
    readonly createdAt: number;                                    // Event timestamp in epoch ms
}

// TYPE :: {prompt:promptRecord, event:eventRecord}
// Event append result with post-commit prompt state.
export interface AppendedEvent {
    readonly prompt: PromptRecord;                                 // Prompt after the append
    readonly event: EventRecord;                                   // Event that was appended
}

// TYPE :: {prompt:promptRecord, event:eventRecord}
// Claimed prompt plus its active event.
export interface ClaimedPrompt {
    readonly prompt: PromptRecord;                                 // Prompt after claim
    readonly event: EventRecord;                                   // Active event written by the claim
}

// TYPE :: {status:"done"|"error", response:STRING?, errorType:promptOutcomeErrorType?, errorMessage:STRING?, info:OBJECT?}
// Finished outcome supplied by the queue.
export interface PromptOutcome {
    readonly status: "done" | "error";                             // Finished status
    readonly response?: string;                                    // Successful final result
    readonly errorType?: PromptOutcomeErrorType;                   // Failure class
    readonly errorMessage?: string;                                // Failure message
    readonly info?: Record<string, unknown>;                       // Operator diagnostics
}

// TYPE :: {status:promptStatus?, limit:NUMBER?, before:NUMBER?}
// Prompt list filters and cursor.
export interface PromptListQuery {
    readonly status?: PromptStatus;                                // Optional lifecycle filter
    readonly limit?: number;                                       // Page size
    readonly before?: number;                                      // Cursor id
}

// TYPE :: {prompts:[promptRecord], nextBefore:NUMBER?}
// Prompt list page.
export interface PromptListPage {
    readonly prompts: PromptRecord[];                              // Newest-first prompts
    readonly nextBefore: number | null;                            // Next cursor
}

// TYPE :: {write:STRING -> VOID, end:VOID -> VOID}
// Structural sink for SSE and long-poll waits.
export interface CTGPromptEventSink {
    write(chunk: string): void;                                    // Writes one frame or chunk
    end(): void;                                                   // Ends the sink
}

// TYPE :: {close:VOID -> VOID}
// Registered subscriber handle.
export interface CTGPromptSubscription {
    close(): void;                                                 // Deregisters the sink
}

// TYPE :: {kind:runnerKind, cwd:STRING?, args:[STRING]?, env:OBJECT?, timeout:NUMBER?, maxBuffer:NUMBER?}
// Runner construction config.
export interface CTGPromptRunnerConfig {
    kind: RunnerKind;                                              // Runner kind to construct
    cwd?: string;                                                  // Child working directory
    args?: string[];                                               // Additional runner args
    env?: NodeJS.ProcessEnv;                                       // Complete child environment replacement
    timeout?: number;                                              // Child timeout in ms
    maxBuffer?: number;                                            // Child output cap
}

// TYPE :: {runner:ctgPromptRunnerConfig, apiKey:STRING, host:STRING?, database:STRING?, initDB:BOOLEAN?, concurrency:NUMBER?, maxPromptBytes:NUMBER?, streamMode:streamMode?, keepAliveMs:NUMBER?, maxWaitMs:NUMBER?, defaultLimit:NUMBER?, maxLimit:NUMBER?}
// Server config accepted by CTGPromptServer.init().
export interface CTGPromptServerConfig {
    runner: CTGPromptRunnerConfig;                                 // Runner config
    apiKey: string;                                                // Shared bearer key
    host?: string;                                                 // Bind address
    database?: string;                                             // SQLite path
    initDB?: boolean;                                               // Whether to create schema when absent
    concurrency?: number;                                          // Run concurrency
    maxPromptBytes?: number;                                       // Prompt byte ceiling
    streamMode?: StreamMode;                                       // Runner stream mode
    keepAliveMs?: number;                                          // SSE keep-alive cadence
    maxWaitMs?: number;                                            // Long-poll ceiling
    defaultLimit?: number;                                         // Default list size
    maxLimit?: number;                                             // Maximum list size
}

// TYPE :: {db:ctgPromptDB, subscribers:ctgPromptSubscribers, runner:llmRunner, runnerKind:runnerKind, concurrency:NUMBER, maxPromptBytes:NUMBER, streamMode:streamMode, maxWaitMs:NUMBER, defaultLimit:NUMBER, maxLimit:NUMBER}
// Queue config with all defaults resolved.
export interface CTGPromptQueueConfig {
    db: {                                                          // Durable prompt database
        insertPrompt(prompt: string): PromptRecord;
        readPrompt(id: number): PromptRecord | undefined;
        listPrompts(query: PromptListQuery): PromptListPage;
        claimNextPending(runner: RunnerKind): ClaimedPrompt | undefined;
        finishPrompt(id: number, outcome: PromptOutcome): AppendedEvent;
        cancelPending(id: number): AppendedEvent;
        interruptActive(): number;
        appendEvent(id: number, name: PromptEventName, payload: unknown, appendResponse?: string): AppendedEvent;
        readEvents(id: number, afterSequence: number): EventRecord[];
        lastSequence(id: number): number;
        purgeFinished(): number;
        purgeAll(): number;
        reset(): void;
        close(): void;
    };
    subscribers: {                                                 // Live subscriber registry
        add(id: number, sink: CTGPromptEventSink): CTGPromptSubscription;
        publish(id: number, event: EventRecord): void;
        closePrompt(id: number): void;
        closeAll(): void;
        count(id: number): number;
    };
    runner: LLMRunner;                                             // Constructed runner
    runnerKind: RunnerKind;                                        // Kind recorded at claim
    concurrency: number;                                           // Run concurrency
    maxPromptBytes: number;                                        // Prompt byte ceiling
    streamMode: StreamMode;                                        // Per-run stream mode
    maxWaitMs: number;                                             // Long-poll ceiling
    defaultLimit: number;                                          // Default list size
    maxLimit: number;                                              // Maximum list size
}

// TYPE :: {path:STRING, initDB:BOOLEAN?}
// Database config accepted by CTGPromptDB.init().
export interface CTGPromptDBConfig {
    path: string;                                                  // SQLite file path or :memory:
    initDB?: boolean;                                               // Whether to create schema when absent
}
