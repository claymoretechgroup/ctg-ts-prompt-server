# ctg-ts-prompt-server spec2 types

**Status:** proposed standalone type specification.

This document defines spec2 type ownership and TypeScript-facing shapes.
Database schema and `CTGPromptDB` behavior are specified in
`docs/spec2.db.md`.

---

## 1. Type Ownership

`LLMRunner`, `LLMRunnerResult`, `LLMRunnerStreamHandler`, and runner
event classes come from `ctg-ai-agent-proc`.

Public exported types use the `CTG` prefix. Unprefixed types in this
spec are implementation details local to the owning class. Type
definitions are grouped with the class that owns the corresponding
behavior or data boundary. Shared types stay with their origin class; for
example, `CTGPromptQueueRecord` is consumed by the queue and server, but
it is defined with `CTGPromptDB` because it represents a durable
database row.

---

## 2. CTGPromptDB Types

### CTGPromptDBFinishStatusCode

```ts
type CTGPromptDBFinishStatusCode = 3 | 4;
```

| Value | Meaning |
|---:|---|
| `3` | `DONE`; successful terminal outcome accepted by `CTGPromptDB.finish(...)`. |
| `4` | `ERROR`; failed terminal outcome accepted by `CTGPromptDB.finish(...)`. |

`CTGPromptDBFinishStatusCode` is the subset of status codes accepted by
`CTGPromptDB.finish(...)`: `3` for `DONE` and `4` for `ERROR`.
`CANCELLED` is terminal queue state, but it is written by
`cancel(...)`, not `finish(...)`.

### CTGPromptDBConfig

```ts
interface CTGPromptDBConfig {
    readonly path: string;
    readonly initDB?: boolean;
}
```

| Property | Type | Required | Meaning |
|---|---|---:|---|
| `path` | `string` | yes | Filesystem path to the SQLite database. |
| `initDB` | `boolean` | no | Whether to create or migrate the schema during initialization. |

### CTGPromptDBPromptOutcome

```ts
interface CTGPromptDBPromptOutcome {
    readonly statusCode: CTGPromptDBFinishStatusCode;
    readonly response?: string;
    readonly errorCode?: CTGPromptOutcomeErrorCode;
    readonly errorMessage?: string;
    readonly info?: Record<string, unknown>;
}
```

| Property | Type | Required | Meaning |
|---|---|---:|---|
| `statusCode` | `CTGPromptDBFinishStatusCode` | yes | Finish status code: `3` for `DONE` or `4` for `ERROR`. |
| `response` | `string` | no | Final response text for successful completions. |
| `errorCode` | `CTGPromptOutcomeErrorCode` | no | Outcome error code for failed completions. |
| `errorMessage` | `string` | no | Human-readable failure message for failed completions. |
| `info` | `Record<string, unknown>` | no | Operator diagnostics serialized to the database. |

### CTGPromptQueueRecord

```ts
interface CTGPromptQueueRecord {
    readonly id: number;
    readonly statusCode: CTGPromptQueueStatusCode;
    readonly prompt: string;
    readonly response: string;
    readonly errorCode: CTGPromptOutcomeErrorCode | null;
    readonly errorMessage: string | null;
    readonly info: Readonly<Record<string, unknown>> | null;
    readonly runner: CTGPromptRunnerType | null;
    readonly createdAt: number;
    readonly startedAt: number | null;
    readonly finishedAt: number | null;
}
```

| Property | Type | Required | Meaning |
|---|---|---:|---|
| `id` | `number` | yes | Stable queue record ID. |
| `statusCode` | `CTGPromptQueueStatusCode` | yes | Durable lifecycle status code. |
| `prompt` | `string` | yes | Raw prompt text submitted by the client. |
| `response` | `string` | yes | Accumulated or final response text. |
| `errorCode` | `CTGPromptOutcomeErrorCode \| null` | yes | Stored outcome error code, or `null` when there is no error. |
| `errorMessage` | `string \| null` | yes | Stored outcome error message, or `null` when there is no error. |
| `info` | `Readonly<Record<string, unknown>> \| null` | yes | Operator diagnostics parsed from the stored JSON value. |
| `runner` | `CTGPromptRunnerType \| null` | yes | Optional runner type metadata for the record. |
| `createdAt` | `number` | yes | Epoch milliseconds when the record was submitted. |
| `startedAt` | `number \| null` | yes | Epoch milliseconds when the record was claimed. |
| `finishedAt` | `number \| null` | yes | Epoch milliseconds when the record reached terminal state. |

### CTGPromptPagination

```ts
interface CTGPromptPagination {
    readonly statusCode?: CTGPromptQueueStatusCode;
    readonly limit: number;
    readonly before?: number;
}
```

| Property | Type | Required | Meaning |
|---|---|---:|---|
| `statusCode` | `CTGPromptQueueStatusCode` | no | Optional durable status-code filter. |
| `limit` | `number` | yes | Maximum number of records to return. |
| `before` | `number` | no | Cursor ID; only records with an ID less than this value are returned. |

### CTGPromptPaginationPage

```ts
interface CTGPromptPaginationPage {
    readonly records: CTGPromptQueueRecord[];
    readonly nextBefore: number | null;
}
```

| Property | Type | Required | Meaning |
|---|---|---:|---|
| `records` | `CTGPromptQueueRecord[]` | yes | Current page of prompt queue records. |
| `nextBefore` | `number \| null` | yes | Cursor for the next page, or `null` when no next page exists. |

---

## 3. CTGPromptQueue Types

### CTGPromptQueueStatusLabel

```ts
type CTGPromptQueueStatusLabel =
    | "PENDING"
    | "ACTIVE"
    | "DONE"
    | "ERROR"
    | "CANCELLED";
```

| Value | Meaning |
|---|---|
| `PENDING` | Record is waiting to be claimed. |
| `ACTIVE` | Record has been claimed by the queue and has an active runner. |
| `DONE` | Record completed successfully. |
| `ERROR` | Record reached a failed terminal state. |
| `CANCELLED` | Record was cancelled before it was claimed. |

### CTGPromptQueueStatusCode

```ts
type CTGPromptQueueStatusCode = 1 | 2 | 3 | 4 | 5;
```

| Value | Meaning |
|---:|---|
| `1` | `PENDING` |
| `2` | `ACTIVE` |
| `3` | `DONE` |
| `4` | `ERROR` |
| `5` | `CANCELLED` |

### CTGPromptQueueStreamEventName

```ts
type CTGPromptQueueStreamEventName =
    | "pending"
    | "active"
    | "output"
    | "stream"
    | "done"
    | "error"
    | "cancelled";
```

| Value | Meaning |
|---|---|
| `pending` | Live event emitted when a record is submitted. |
| `active` | Live event emitted when a record is claimed. |
| `output` | Live event emitted for runner stdout/stderr chunks. |
| `stream` | Live event emitted for structured runner events. |
| `done` | Live event emitted when a record completes successfully. |
| `error` | Live event emitted when a record fails. |
| `cancelled` | Live event emitted when a pending record is cancelled. |

`CTGPromptQueueStreamEventName` is the queue's live stream event-name
vocabulary. These values are SSE event names and are not stored in the
database.

### CTGPromptStreamMode

```ts
type CTGPromptStreamMode = "raw" | "events";
```

| Value | Meaning |
|---|---|
| `raw` | Append response text from stdout output chunks. |
| `events` | Append response text by parsing structured runner events. |

### ActiveRunners

```ts
type ActiveRunners = Map<number, ActiveRunner>;
```

| Value | Meaning |
|---|---|
| `Map<number, ActiveRunner>` | Queue-internal active runner registry keyed by queue record ID. |

### CTGPromptQueueStreamMessage

```ts
interface CTGPromptQueueStreamMessage {
    readonly id: number;
    readonly name: CTGPromptQueueStreamEventName;
    readonly payload: unknown;
    readonly createdAt: number;
}
```

| Property | Type | Required | Meaning |
|---|---|---:|---|
| `id` | `number` | yes | Queue record ID for the stream event. |
| `name` | `CTGPromptQueueStreamEventName` | yes | SSE event name. |
| `payload` | `unknown` | yes | JSON-serializable event payload. |
| `createdAt` | `number` | yes | Epoch milliseconds when the event message was created. |

### CTGPromptQueueConfig

```ts
interface CTGPromptQueueConfig {
    db: CTGPromptDB;
    runner: LLMRunner;
    runnerType: CTGPromptRunnerType;
    concurrency: number;
    maxPromptBytes: number;
    streamMode: CTGPromptStreamMode;
    onStreamMessage: (message: CTGPromptQueueStreamMessage) => void;
    onPromptFinished: (id: number) => void;
}
```

| Property | Type | Required | Meaning |
|---|---|---:|---|
| `db` | `CTGPromptDB` | yes | Durable prompt database used by the queue. |
| `runner` | `LLMRunner` | yes | Configured runner instance used to execute prompts. |
| `runnerType` | `CTGPromptRunnerType` | yes | Configured runner type for the queue. |
| `concurrency` | `number` | yes | Maximum number of active runners. |
| `maxPromptBytes` | `number` | yes | Maximum accepted prompt size in UTF-8 bytes. |
| `streamMode` | `CTGPromptStreamMode` | yes | Stream format used to extract response text. |
| `onStreamMessage` | `(message: CTGPromptQueueStreamMessage) => void` | yes | Callback for live stream event messages. |
| `onPromptFinished` | `(id: number) => void` | yes | Callback invoked when a record reaches terminal state. |

### ActiveRunner

```ts
interface ActiveRunner {
    readonly record: CTGPromptQueueRecord;
    readonly runner: LLMRunner;
    readonly result: Promise<LLMRunnerResult>;
    error: Error | null;
}
```

| Property | Type | Required | Meaning |
|---|---|---:|---|
| `record` | `CTGPromptQueueRecord` | yes | Claimed prompt queue record being executed. |
| `runner` | `LLMRunner` | yes | Runner instance executing the record. |
| `result` | `Promise<LLMRunnerResult>` | yes | Runner result promise. |
| `error` | `Error \| null` | yes | Captured server-side error, or `null` when no error is captured. |

`ActiveRunner.error === null` means no server-side error has been
captured for that active runner. Project-owned code throws `Error`
instances. Any caught non-`Error` value is converted to `Error` before
being stored on `ActiveRunner.error`.

### ActiveRunnerConfig

```ts
interface ActiveRunnerConfig {
    readonly record: CTGPromptQueueRecord;
    readonly runner: LLMRunner;
    readonly result: Promise<LLMRunnerResult>;
}
```

| Property | Type | Required | Meaning |
|---|---|---:|---|
| `record` | `CTGPromptQueueRecord` | yes | Claimed prompt queue record being executed. |
| `runner` | `LLMRunner` | yes | Runner instance executing the record. |
| `result` | `Promise<LLMRunnerResult>` | yes | Promise returned by the runner after `runPrompt` starts execution. |

---

## 4. CTGPromptServer Types

### CTGPromptRunnerType

```ts
type CTGPromptRunnerType = "claude" | "codex";
```

| Value | Meaning |
|---|---|
| `claude` | Use the Claude `LLMRunner` implementation. |
| `codex` | Use the Codex `LLMRunner` implementation. |

`CTGPromptRunnerType` identifies the concrete `LLMRunner` subclass or
factory selected by server configuration. Spec2 supports `claude` and
`codex`.

Future runner types, such as `ollama`, can be added by extending
`CTGPromptRunnerType`, teaching `CTGPromptServer.createRunner(...)` how
to construct the runner, and adding any stream extraction rules required
for `streamMode = "events"`. No database schema change is required
unless runner type values are constrained in SQLite.

### CTGPromptRunnerConfig

```ts
interface CTGPromptRunnerConfig {
    type: CTGPromptRunnerType;
    cwd?: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    maxBuffer?: number;
}
```

| Property | Type | Required | Meaning |
|---|---|---:|---|
| `type` | `CTGPromptRunnerType` | yes | Runner implementation to construct. |
| `cwd` | `string` | no | Working directory for runner child processes. |
| `args` | `string[]` | no | Additional runner arguments. |
| `env` | `NodeJS.ProcessEnv` | no | Complete child process environment replacement. |
| `timeout` | `number` | no | Runner timeout in milliseconds. |
| `maxBuffer` | `number` | no | Maximum buffered runner output. |

### CTGPromptServerConfig

```ts
interface CTGPromptServerConfig {
    runner: CTGPromptRunnerConfig;
    apiKey: string;
    host?: string;
    database?: string;
    initDB?: boolean;
    concurrency?: number;
    maxPromptBytes?: number;
    streamMode?: CTGPromptStreamMode;
    keepAliveMs?: number;
    maxWaitMs?: number;
    defaultLimit?: number;
    maxLimit?: number;
}
```

| Property | Type | Required | Meaning |
|---|---|---:|---|
| `runner` | `CTGPromptRunnerConfig` | yes | Runner construction configuration. |
| `apiKey` | `string` | yes | Bearer token required by every route. |
| `host` | `string` | no | Host passed to server binding. |
| `database` | `string` | no | SQLite database path. |
| `initDB` | `boolean` | no | Whether to initialize the database schema. |
| `concurrency` | `number` | no | Maximum number of active runners. |
| `maxPromptBytes` | `number` | no | Maximum accepted prompt size in UTF-8 bytes. |
| `streamMode` | `CTGPromptStreamMode` | no | Stream format used to extract response text. |
| `keepAliveMs` | `number` | no | SSE keep-alive interval in milliseconds. |
| `maxWaitMs` | `number` | no | Maximum long-poll wait in milliseconds. |
| `defaultLimit` | `number` | no | Default pagination page size. |
| `maxLimit` | `number` | no | Maximum accepted pagination page size. |

---

## 5. CTGPromptServerError Types

### CTGPromptOutcomeErrorLabel

```ts
type CTGPromptOutcomeErrorLabel = "RUNNER" | "SERVER" | "INTERRUPTED";
```

| Value | Meaning |
|---|---|
| `RUNNER` | Runner failed or returned an upstream runner error. |
| `SERVER` | Server-side queue, stream, or database operation failed. |
| `INTERRUPTED` | Record was active when the server stopped. |

### CTGPromptOutcomeErrorCode

```ts
type CTGPromptOutcomeErrorCode = 1013 | 1014 | 1015;
```

| Value | Meaning |
|---:|---|
| `1013` | `RUNNER` |
| `1014` | `SERVER` |
| `1015` | `INTERRUPTED` |

### CTGPromptRequestErrorLabel

```ts
type CTGPromptRequestErrorLabel =
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
```

| Value | Meaning |
|---|---|
| `INVALID_CONFIG` | Server configuration is invalid. |
| `UNAUTHORIZED` | Request authorization failed. |
| `INVALID_CONTENT_TYPE` | Request content type is unsupported. |
| `INVALID_BODY` | Request body could not be parsed or validated. |
| `INVALID_PROMPT` | Submitted prompt is invalid. |
| `INVALID_QUERY` | Route or query parameter is invalid. |
| `PROMPT_NOT_FOUND` | Prompt record does not exist. |
| `CANCEL_NOT_ALLOWED` | Prompt record cannot be cancelled in its current state. |
| `NOT_FOUND` | Route does not exist. |
| `METHOD_NOT_ALLOWED` | HTTP method is not allowed for the route. |
| `STORE_FAILED` | Durable store operation failed. |
| `INTERNAL_ERROR` | Unexpected server error. |

### CTGPromptRequestErrorCode

```ts
type CTGPromptRequestErrorCode =
    | 1001
    | 1002
    | 1003
    | 1004
    | 1005
    | 1006
    | 1007
    | 1008
    | 1009
    | 1010
    | 1011
    | 1012;
```

| Value | Meaning |
|---:|---|
| `1001` | `INVALID_CONFIG` |
| `1002` | `UNAUTHORIZED` |
| `1003` | `INVALID_CONTENT_TYPE` |
| `1004` | `INVALID_BODY` |
| `1005` | `INVALID_PROMPT` |
| `1006` | `INVALID_QUERY` |
| `1007` | `PROMPT_NOT_FOUND` |
| `1008` | `CANCEL_NOT_ALLOWED` |
| `1009` | `NOT_FOUND` |
| `1010` | `METHOD_NOT_ALLOWED` |
| `1011` | `STORE_FAILED` |
| `1012` | `INTERNAL_ERROR` |

### CTGPromptServerErrorLabel

```ts
type CTGPromptServerErrorLabel =
    | CTGPromptRequestErrorLabel
    | CTGPromptOutcomeErrorLabel;
```

| Value | Meaning |
|---|---|
| `CTGPromptRequestErrorLabel` | HTTP request error labels. |
| `CTGPromptOutcomeErrorLabel` | Durable prompt outcome error labels. |

### CTGPromptServerErrorCode

```ts
type CTGPromptServerErrorCode =
    | CTGPromptRequestErrorCode
    | CTGPromptOutcomeErrorCode;
```

| Value | Meaning |
|---|---|
| `CTGPromptRequestErrorCode` | HTTP request error codes. |
| `CTGPromptOutcomeErrorCode` | Durable prompt outcome error codes. |

Request error label/code map:

| Label | Code | HTTP status |
|---|---:|---:|
| `INVALID_CONFIG` | 1001 | `null` |
| `UNAUTHORIZED` | 1002 | `401` |
| `INVALID_CONTENT_TYPE` | 1003 | `415` |
| `INVALID_BODY` | 1004 | `400` |
| `INVALID_PROMPT` | 1005 | `400` |
| `INVALID_QUERY` | 1006 | `400` |
| `PROMPT_NOT_FOUND` | 1007 | `404` |
| `CANCEL_NOT_ALLOWED` | 1008 | `409` |
| `NOT_FOUND` | 1009 | `404` |
| `METHOD_NOT_ALLOWED` | 1010 | `405` |
| `STORE_FAILED` | 1011 | `500` |
| `INTERNAL_ERROR` | 1012 | `500` |

Outcome error label/code map:

| Label | Code | Stored in DB |
|---|---:|---|
| `RUNNER` | 1013 | yes |
| `SERVER` | 1014 | yes |
| `INTERRUPTED` | 1015 | yes |

The database stores `error_code`, not error labels. Label resolution is
performed by `CTGPromptServerError.labelOf(code)`. Unknown numeric codes
must be treated as corrupted or unsupported stored state.
