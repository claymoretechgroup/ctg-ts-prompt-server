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

// TYPE :: "claude"|"codex"
// Supported runner kinds.
export type RunnerKind = "claude" | "codex";

// TYPE :: "raw"|"events"
// Runner stream modes exposed by config.
export type StreamMode = "raw" | "events";

// TYPE :: {id:NUMBER, name:STRING, payload:UNKNOWN, createdAt:NUMBER}
// Live queue message handed from CTGPromptServerQueue to CTGPromptServer.
export interface CTGPromptServerQueueStreamMessage {
    readonly id: number;                                           // Prompt queue record id
    readonly name: string;                                         // SSE event name
    readonly payload: unknown;                                     // Event-specific payload
    readonly createdAt: number;                                    // Event timestamp in epoch ms
}

// TYPE :: {status:promptStatus?, limit:NUMBER?, before:NUMBER?}
// Prompt list filters and cursor.
export interface PromptListQuery {
    readonly status?: PromptStatus;                                // Optional lifecycle filter
    readonly limit?: number;                                       // Page size
    readonly before?: number;                                      // Cursor id
}

// TYPE :: {id:NUMBER, statusCode:NUMBER, prompt:STRING, response:STRING, errorCode:NUMBER?, errorMessage:STRING?, runner:runnerKind?, createdAt:NUMBER, startedAt:NUMBER?, finishedAt:NUMBER?}
// Spec2 durable prompt queue record.
export interface CTGPromptServerQueueRecord {
    readonly id: number;                                           // SQLite prompt identity
    readonly statusCode: number;                                   // Numeric durable lifecycle state
    readonly prompt: string;                                       // Stored prompt text
    readonly response: string;                                     // Accumulated or final response text
    readonly errorCode: number | null;                             // Prompt failure code
    readonly errorMessage: string | null;                          // Prompt failure message
    readonly runner: RunnerKind | null;                            // Runner kind metadata
    readonly createdAt: number;                                    // Submit timestamp in epoch ms
    readonly startedAt: number | null;                             // Claim timestamp in epoch ms
    readonly finishedAt: number | null;                            // Finished timestamp in epoch ms
}

// TYPE :: {statusCode:NUMBER?, limit:NUMBER, before:NUMBER?}
// Spec2 DB pagination query.
export interface CTGPromptPagination {
    readonly statusCode?: number;                                  // Optional lifecycle status-code filter
    readonly limit: number;                                        // Page size
    readonly before?: number;                                      // Cursor id
}

// TYPE :: {records:[ctgPromptServerQueueRecord], nextBefore:NUMBER?}
// Spec2 DB pagination page.
export interface CTGPromptPaginationPage {
    readonly records: CTGPromptServerQueueRecord[];                // Newest-first records
    readonly nextBefore: number | null;                            // Next cursor
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

// TYPE :: {db:ctgPromptServerDB, runner:llmRunner, runnerKind:runnerKind, concurrency:NUMBER, maxPromptBytes:NUMBER, streamMode:streamMode, onStreamMessage:FUNCTION, onPromptFinished:FUNCTION, defaultLimit:NUMBER, maxLimit:NUMBER}
// Queue config with all defaults resolved.
export interface CTGPromptServerQueueConfig {
    db: {                                                          // Durable prompt database
        create(prompt: string): CTGPromptServerQueueRecord;
        read(id: number): CTGPromptServerQueueRecord | null;
        paginate(query: CTGPromptPagination): CTGPromptPaginationPage;
        update(record: CTGPromptServerQueueRecord): CTGPromptServerQueueRecord;
        delete(id: number): CTGPromptServerQueueRecord | null;
        append(id: number, text: string): CTGPromptServerQueueRecord;
        claimNext(): CTGPromptServerQueueRecord | null;
        finish(id: number, outcome: {
            readonly statusCode: number;
            readonly response?: string;
            readonly errorCode?: number;
            readonly errorMessage?: string;
        }): CTGPromptServerQueueRecord;
        cancel(id: number): CTGPromptServerQueueRecord;
        interruptActive(): number;
        close(): void;
    };
    runner: LLMRunner;                                             // Constructed runner
    runnerKind: RunnerKind;                                        // Kind recorded at claim
    concurrency: number;                                           // Run concurrency
    maxPromptBytes: number;                                        // Prompt byte ceiling
    streamMode: StreamMode;                                        // Per-run stream mode
    onStreamMessage(message: CTGPromptServerQueueStreamMessage): void; // Live stream callback
    onPromptFinished(id: number): void;                            // Terminal prompt callback
    defaultLimit: number;                                          // Default list size
    maxLimit: number;                                              // Maximum list size
}

// TYPE :: {path:STRING, initDB:BOOLEAN?}
// Database config accepted by CTGPromptServerDB.init().
export interface CTGPromptServerDBConfig {
    path: string;                                                  // SQLite file path or :memory:
    initDB?: boolean;                                               // Whether to create schema when absent
}
