# ctg-ts-prompt-server spec2

**Status:** proposed standalone specification.

`ctg-ts-prompt-server` is a durable prompt queue service for one
configured `ctg-ai-agent-proc` runner. It exposes the queue over HTTP,
stores prompt state in SQLite, and streams live runner output to
connected SSE clients.

The durable unit is a `CTGPromptQueueRecord`. The upstream
`ctg-ai-agent-proc` `LLMPrompt` type is a prompt-construction object; it
is not stored by this service. This service stores raw prompt text and
the lifecycle state for one submitted queue record.

---

## 1. Database Schema

SQLite is the durable queue and prompt-state store. The schema contains
one table for prompt queue records and one index for claim/list access.

```sql
CREATE TABLE IF NOT EXISTS prompts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    status_code   INTEGER NOT NULL CHECK (
        status_code IN (1, 2, 3, 4, 5)
    ),
    prompt        TEXT    NOT NULL,
    response      TEXT    NOT NULL DEFAULT '',
    error_code    INTEGER CHECK (
        error_code IS NULL OR error_code IN (1013, 1014, 1015)
    ),
    error_message TEXT,
    info          TEXT,
    runner        TEXT,
    created_at    INTEGER NOT NULL,
    started_at    INTEGER,
    finished_at   INTEGER,
    CHECK (
        (status_code = 4 AND error_code IS NOT NULL AND error_message IS NOT NULL)
        OR
        (status_code <> 4 AND error_code IS NULL AND error_message IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS prompts_status_code_id
    ON prompts (status_code, id);
```

Column meanings:

| Column | Meaning |
|---|---|
| `id` | Stable queue record ID. It is the HTTP ID, pagination cursor, and active-run map key. |
| `status_code` | Stable lifecycle status code. Valid status codes are `1` pending, `2` active, `3` done, `4` error, and `5` cancelled. |
| `prompt` | Raw prompt text exactly as submitted by the client. |
| `response` | Accumulated response text while running, overwritten by the final runner result on success. |
| `error_code` | Outcome error code when `status_code = 4`; otherwise `NULL`. Valid outcome codes are `1013`, `1014`, and `1015`. |
| `error_message` | Outcome error message when `status_code = 4`; otherwise `NULL`. |
| `info` | JSON diagnostics for operators. It is not serialized on HTTP prompt responses. |
| `runner` | Runner type metadata. It may remain `NULL` for the initial single-runner service. |
| `created_at` | Epoch milliseconds when the record was submitted. |
| `started_at` | Epoch milliseconds when the record was claimed. `NULL` until active. |
| `finished_at` | Epoch milliseconds when the record entered a terminal state. `NULL` until finished. |

The database enforces the finite status-code set, the finite outcome
error-code set, and the rule that `error_code` / `error_message` are
present only for `status_code = 4`.

SQLite pragmas applied on open:

1. `PRAGMA journal_mode = WAL;`
2. `PRAGMA foreign_keys = ON;`
3. `PRAGMA busy_timeout = 5000;`

The initial spec2 schema does not store per-event stream history. SSE is
live-only. If a client disconnects, it recovers the current queue record
through `GET /prompt/:id`.

### 1.1 Maintenance SQL

Maintenance operations are script-level SQL tasks, not `CTGPromptDB`
runtime methods.

Purge finished records:

```sql
DELETE FROM prompts
WHERE status_code IN (3, 4, 5);
```

Purge all records:

```sql
DELETE FROM prompts;
```

Reset schema:

```sql
DROP TABLE IF EXISTS prompts;
```

After reset, recreate the schema from this specification.

---

## 2. Type Ownership

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

## 3. CTGPromptDB

`CTGPromptDB` owns SQLite access. It does not know about HTTP, SSE,
agent workers, or live clients.

Types:

**CTGPromptDBFinishStatusCode**

```ts
type CTGPromptDBFinishStatusCode = 3 | 4;
```

| Value | Meaning |
|---:|---|
| `3` | `DONE`; successful terminal outcome accepted by `CTGPromptDB.finish(...)`. |
| `4` | `ERROR`; failed terminal outcome accepted by `CTGPromptDB.finish(...)`. |

**CTGPromptDBConfig**

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

**CTGPromptDBPromptOutcome**

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

**CTGPromptQueueRecord**

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

**CTGPromptPagination**

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

**CTGPromptPaginationPage**

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

`CTGPromptDBFinishStatusCode` is the subset of status codes accepted by
`CTGPromptDB.finish(...)`: `3` for `DONE` and `4` for `ERROR`.
`CANCELLED` is terminal queue state, but it is written by
`cancel(...)`, not `finish(...)`.

Constructor:

```ts
class CTGPromptDB {
    constructor(config: CTGPromptDBConfig);
}
```

The constructor opens the configured SQLite database and initializes the
schema when `config.initDB !== false`.

Static fields:

```ts
class CTGPromptDB {
    // No static fields.
}
```

Static methods:

```ts
class CTGPromptDB {
    static init(config: CTGPromptDBConfig): CTGPromptDB;
}
```

`CTGPromptDB.init(config)` returns `new CTGPromptDB(config)`.

Instance fields:

```ts
class CTGPromptDB {
    private readonly _db: DatabaseSync;
}
```

| Field | Type | Visibility | Meaning |
|---|---|---|---|
| `_db` | `DatabaseSync` | private readonly | Underlying SQLite connection. |

Instance methods:

```ts
class CTGPromptDB {
    create(prompt: string): CTGPromptQueueRecord;
    read(id: number): CTGPromptQueueRecord | null;
    paginate(pagination: CTGPromptPagination): CTGPromptPaginationPage;
    update(record: CTGPromptQueueRecord): CTGPromptQueueRecord;
    delete(id: number): CTGPromptQueueRecord | null;
    append(id: number, text: string): CTGPromptQueueRecord;

    claimNext(): CTGPromptQueueRecord | null;
    finish(id: number, outcome: CTGPromptDBPromptOutcome): CTGPromptQueueRecord;
    cancel(id: number): CTGPromptQueueRecord;
    interruptActive(): number;

    close(): void;
}
```

### 3.1 constructor

`constructor(config)` opens SQLite, applies pragmas, and initializes the
schema when `config.initDB !== false`.

### 3.2 init

`init(config)` is a static factory method. It constructs and returns a
`CTGPromptDB` instance.

### 3.3 create

`create(prompt)` inserts one row:

- `status_code = 1`
- `prompt = prompt`
- `response = ''`
- `created_at = Date.now()`

It returns the created `CTGPromptQueueRecord`.

### 3.4 read

`read(id)` returns the record for ID `id`, or `null` when no row exists.
It is a database read operation used by `CTGPromptServer`.

### 3.5 paginate

`paginate(pagination)` returns records ordered by newest ID first.

`pagination.statusCode`, when supplied, filters records to one queue
status code.

`pagination.before` is a cursor, not a count. `before: 120` means:

```sql
WHERE id < 120
ORDER BY id DESC
LIMIT ?
```

`records` contains the current page of `CTGPromptQueueRecord` values.
`nextBefore` is the ID of the last returned record when another page is
available; otherwise it is `null`.

### 3.6 update

`update(record)` persists an existing `CTGPromptQueueRecord` and returns
the updated materialized record.

`update(...)` is the generic row write primitive. Higher-level DB
methods wrap it when they express named queue behavior, so callers do
not need to reconstruct common record changes.

Rules:

1. If `record.id` does not exist, throw `PROMPT_NOT_FOUND`.
2. The record ID identifies the row being updated.
3. The full `CTGPromptQueueRecord` gives `update(...)` access to every
   column value for that row.
4. Implementations may choose which record properties are actually
   written without violating the interface.
5. `id`, `prompt`, and `created_at` are immutable after `create(...)`;
   they are used for identity and integrity, not overwritten.
6. Mutable fields are `statusCode`, `response`, `errorCode`,
   `errorMessage`, `info`, `runner`, `startedAt`, and `finishedAt`.
7. If the provided record does not change any mutable field, return the
   existing record unchanged.
8. `statusCode` may be set by `update(...)`, but normal queue lifecycle
   transitions should use `claimNext()`, `finish(...)`, `cancel(...)`,
   or `interruptActive()`.
9. The resulting row must satisfy all database constraints.

### 3.7 delete

`delete(id)` deletes one row and returns the deleted
`CTGPromptQueueRecord`. It returns `null` when ID `id` does not exist.

### 3.8 append

`append(id, text)` appends text to the record's `response` column and
returns the updated `CTGPromptQueueRecord`.

It does not change `statusCode`.

It wraps:

```ts
const record = read(id);
if (record === null) throw CTGPromptServerError("PROMPT_NOT_FOUND");
update({ ...record, response: record.response + text });
```

If ID `id` does not exist, it throws `PROMPT_NOT_FOUND`. Implementations
should use SQLite string concatenation to preserve atomic append
behavior.

### 3.9 claimNext

`claimNext()` atomically claims the oldest pending record.

Steps, in one transaction:

1. Select the oldest row where `status_code = 1`.
2. If none exists, return `null`.
3. Update that row to `status_code = 2` and set `started_at`.
4. Return the updated `CTGPromptQueueRecord`.

The update condition must include `WHERE status_code = 1` so claim
and cancellation cannot both win for the same row.

### 3.10 finish

`finish(id, outcome)` moves a record to terminal status code `3` or
`4`. It wraps `update(...)` with the corresponding status, response or
error fields, optional diagnostics, and `finishedAt = Date.now()`.

For `statusCode = 3`:

- `status_code = 3`
- `response = outcome.response ?? ''`
- `error_code = NULL`
- `error_message = NULL`
- `info = JSON.stringify(outcome.info)` when supplied
- `finished_at = Date.now()`

For `statusCode = 4`:

- `status_code = 4`
- `error_code = outcome.errorCode ?? 1014`
- `error_message = outcome.errorMessage ?? ''`
- `info = JSON.stringify(outcome.info)` when supplied
- `finished_at = Date.now()`

### 3.11 cancel

`cancel(id)` cancels only pending records.

- Unknown ID throws `PROMPT_NOT_FOUND`.
- Active records throw `CANCEL_NOT_ALLOWED`.
- Finished records throw `CANCEL_NOT_ALLOWED`.
- A successful cancellation wraps `update(...)` with `statusCode = 5`
  and `finishedAt = Date.now()`.

### 3.12 interruptActive

`interruptActive()` moves every row with `status_code = 2` to
`status_code = 4` with:

- `status_code = 4`
- `error_code = 1015`
- `error_message = 'The prompt was active when the server stopped.'`
- `finished_at = Date.now()`

It returns the number of rows changed.

---

## 4. CTGPromptQueue

`CTGPromptQueue` owns durable queue operations, the configured
`LLMRunner`, `CTGAgentProc`, and currently active runner executions.

It does not own HTTP reads, list pagination, long-poll waits, or SSE
response sinks.

Types:

**CTGPromptQueueStatusLabel**

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

**CTGPromptQueueStatusCode**

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

**CTGPromptQueueStreamEventName**

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

**CTGPromptStreamMode**

```ts
type CTGPromptStreamMode = "raw" | "events";
```

| Value | Meaning |
|---|---|
| `raw` | Append response text from stdout output chunks. |
| `events` | Append response text by parsing structured runner events. |

**ActiveRunners**

```ts
type ActiveRunners = Map<number, ActiveRunner>;
```

| Value | Meaning |
|---|---|
| `Map<number, ActiveRunner>` | Queue-internal active runner registry keyed by queue record ID. |

**CTGPromptQueueStreamMessage**

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

**CTGPromptQueueConfig**

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

**ActiveRunner**

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

**ActiveRunnerConfig**

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

`ActiveRunner.error === null` means no server-side error has been
captured for that active runner. Project-owned code throws `Error`
instances. Any caught non-`Error` value is converted to `Error` before
being stored on `ActiveRunner.error`.

Constructor:

```ts
class CTGPromptQueue {
    constructor(config: CTGPromptQueueConfig);
}
```

The constructor configures the durable DB boundary, runner, internal
`CTGAgentProc`, callbacks, and active runner registry.

Static fields:

```ts
class CTGPromptQueue {
    private static readonly STATUS_CODE_BY_LABEL: Readonly<Record<CTGPromptQueueStatusLabel, CTGPromptQueueStatusCode>>;
    private static readonly STATUS_LABEL_BY_CODE: Readonly<Record<CTGPromptQueueStatusCode, CTGPromptQueueStatusLabel>>;
}
```

| Field | Type | Visibility | Meaning |
|---|---|---|---|
| `STATUS_CODE_BY_LABEL` | `Readonly<Record<CTGPromptQueueStatusLabel, CTGPromptQueueStatusCode>>` | private static readonly | Internal map used by `statusCodeOf(...)`. |
| `STATUS_LABEL_BY_CODE` | `Readonly<Record<CTGPromptQueueStatusCode, CTGPromptQueueStatusLabel>>` | private static readonly | Internal map used by `statusOf(...)`. |

Static methods:

```ts
class CTGPromptQueue {
    static init(config: CTGPromptQueueConfig): CTGPromptQueue;
    static statusCodeOf(status: CTGPromptQueueStatusLabel): CTGPromptQueueStatusCode;
    static statusOf(code: number): CTGPromptQueueStatusLabel;
    static isStatusCode(code: number): boolean;

    static activeRunner(config: ActiveRunnerConfig): ActiveRunner;
}
```

`CTGPromptQueue.init(config)` returns `new CTGPromptQueue(config)`.

Instance fields:

```ts
class CTGPromptQueue {
    private readonly _db: CTGPromptDB;
    private readonly _runner: LLMRunner;
    private readonly _runnerType: CTGPromptRunnerType;
    private readonly _concurrency: number;
    private readonly _maxPromptBytes: number;
    private readonly _streamMode: CTGPromptStreamMode;
    private readonly _onStreamMessage: (message: CTGPromptQueueStreamMessage) => void;
    private readonly _onPromptFinished: (id: number) => void;
    private readonly _proc: CTGAgentProc;
    private readonly _activeRunners: ActiveRunners;
    private _started: boolean;
    private _stopping: Promise<void> | null;
}
```

| Field | Type | Visibility | Meaning |
|---|---|---|---|
| `_db` | `CTGPromptDB` | private readonly | Durable prompt database boundary. |
| `_runner` | `LLMRunner` | private readonly | Configured runner instance. |
| `_runnerType` | `CTGPromptRunnerType` | private readonly | Configured runner type. |
| `_concurrency` | `number` | private readonly | Maximum active runner count. |
| `_maxPromptBytes` | `number` | private readonly | Maximum accepted prompt size. |
| `_streamMode` | `CTGPromptStreamMode` | private readonly | Stream extraction mode. |
| `_onStreamMessage` | `(message: CTGPromptQueueStreamMessage) => void` | private readonly | Callback used to hand live stream messages to the server. |
| `_onPromptFinished` | `(id: number) => void` | private readonly | Callback used to wake server-owned waiters and close terminal streams. |
| `_proc` | `CTGAgentProc` | private readonly | Internal agent workflow process. |
| `_activeRunners` | `ActiveRunners` | private readonly | Active runner registry keyed by queue record ID. |
| `_started` | `boolean` | private | Whether the queue may claim new pending records. |
| `_stopping` | `Promise<void> \| null` | private | Current stop operation, or `null` when no stop is in progress. |

Instance methods:

```ts
class CTGPromptQueue {
    submit(prompt: string): CTGPromptQueueRecord;
    cancel(id: number): CTGPromptQueueRecord;
    next(): CTGPromptQueueRecord | null;
    recover(): number;
    start(): void;
    stop(): Promise<void>;
}
```

Status code map:

| Status | Code | Terminal |
|---|---:|---|
| `PENDING` | 1 | no |
| `ACTIVE` | 2 | no |
| `DONE` | 3 | yes |
| `ERROR` | 4 | yes |
| `CANCELLED` | 5 | yes |

`CTGPromptQueueStreamEventName` is the queue's live stream event-name
vocabulary. These values are SSE event names and are not stored in the
database.

`CTGPromptQueueStatusCode` is the durable status value stored in SQLite
and returned on `CTGPromptQueueRecord`. `CTGPromptQueueStatusLabel`
values are boundary vocabulary for routes, tests, and readable
diagnostics; they are not stored in the database.

`CTGPromptQueue.statusCodeOf(status)` resolves a status label to the
durable code. `CTGPromptQueue.isStatusCode(code)` validates unknown
numeric input before it is accepted as stored state.
`CTGPromptQueue.statusOf(code)` resolves database status codes to
labels. Unknown numeric status codes must be treated as corrupted or
unsupported stored state.

### 4.1 constructor

`constructor(config)` initializes the queue's DB reference, runner,
runner type, concurrency limit, stream mode, callbacks, internal
`CTGAgentProc`, and active runner registry.

### 4.2 init

`init(config)` is a static factory method. It constructs and returns a
`CTGPromptQueue` instance.

### 4.3 statusCodeOf

`statusCodeOf(status)` resolves a `CTGPromptQueueStatusLabel` to a
`CTGPromptQueueStatusCode`.

### 4.4 statusOf

`statusOf(code)` resolves a `CTGPromptQueueStatusCode` to a
`CTGPromptQueueStatusLabel`.

### 4.5 isStatusCode

`isStatusCode(code)` returns whether `code` is a supported
`CTGPromptQueueStatusCode`.

### 4.6 submit

`submit(prompt)` validates and stores one pending queue record.

Validation:

1. `prompt` must be a string.
2. `prompt.trim()` must not be empty.
3. `Buffer.byteLength(prompt, "utf8")` must be less than or equal to
   `maxPromptBytes`.

On success:

1. Create the record with `db.create(prompt)`.
2. Emit a live `pending` stream event message through
   `onStreamMessage`.
3. If the queue is started, ensure `checkWork` is queued.
4. Return the inserted record.

The prompt text is stored and executed byte-for-byte as submitted.

### 4.7 cancel

`cancel(id)` cancels a pending record with `db.cancel(id)`.

On success:

1. Emit a live `cancelled` stream event message.
2. Call `onPromptFinished(id)`.
3. Return the cancelled record.

### 4.8 next

`next()` is the queue's durable scheduling primitive. It calls
`db.claimNext()` and returns the active `CTGPromptQueueRecord`, or
`null` when no pending record is available.

When a record is claimed, `CTGPromptQueue` may persist configured runner
metadata by calling `db.update({ ...record, runner: runnerType })`.
For the initial single-runner service, `runner` may remain `null`.

It is not a general read API.

### 4.9 start

`start()` enables queue processing and queues `checkWork`.

`start()` is idempotent. Calling it while already started must not cause
duplicate work claims beyond the configured concurrency limit.

### 4.10 stop

`stop()` disables new claims and waits for active runner results plus
queued terminal tasks to settle. A stopped queue may accept submitted
records, but it must not claim them until `start()` is called again.

### 4.11 recover

`recover()` calls `db.interruptActive()` and returns the number of
interrupted records. It is called during server startup before
`start()`.

### 4.12 activeRunner

`CTGPromptQueue` owns a public static
`activeRunner(config: ActiveRunnerConfig): ActiveRunner` helper. It
creates an `ActiveRunner` value from an already-started runner result
promise. It does not call `runner.run(...)`; `runPrompt` starts the
runner and normalizes synchronous throws into rejected result promises.

### 4.13 Agent Workflow

`CTGPromptQueue` uses `CTGAgentProc` as the internal workflow engine. It
registers one runner and these agents:

| Agent | Input | Responsibility |
|---|---|---|
| `checkWork` | `null` | Claim records while capacity remains. |
| `runPrompt` | `CTGPromptQueueRecord` | Create and track an `ActiveRunner`. |
| `finishPrompt` | `{ id, result }` | Persist a successful terminal outcome. |
| `failPrompt` | `{ id, errorCode, error }` | Persist a failed terminal outcome. |

`checkWork`:

1. Stops immediately when the queue is stopped.
2. Calls `next()` while `activeRunners.size < concurrency`.
3. Emits a live `active` stream event message for each claimed record.
4. Sends each claimed record to `runPrompt`.
5. Calls `done()`.

`runPrompt`:

1. Creates the active runner stream handler.
2. Starts `runner.run(record.prompt, ...)` and captures the result
   promise.
3. Normalizes a synchronous throw from `runner.run(...)` into a rejected
   result promise.
4. Creates an `ActiveRunner` through
   `CTGPromptQueue.activeRunner(...)`.
5. Stores it in `activeRunners` keyed by record ID.
6. Attaches result continuations.
7. Calls `done()` without awaiting `activeRunner.result`.

Runner result continuations are posted to the queue-owned
`CTGAgentProc` instance. They must not use a worker-scoped `send()` after
that worker has called `done()`.

`finishPrompt`:

1. If `activeRunner.error !== null`, route to `failPrompt` with
   `errorCode = 1014`.
2. Otherwise call `db.finish(id, { statusCode: 3, response:
   result.result, info: { stderr: result.error } })`.
3. Emit a live `done` stream event message.
4. Delete the active runner from `activeRunners`.
5. Call `onPromptFinished(id)`.
6. If the queue is started, queue `checkWork`.
7. Call `done()`.

`failPrompt`:

1. Convert runner failures into `errorCode = 1013`.
2. Convert server failures into `errorCode = 1014`.
3. Call `db.finish(id, { statusCode: 4, errorCode, errorMessage,
   info })`.
4. Emit a live `error` stream event message.
5. Delete the active runner from `activeRunners`.
6. Call `onPromptFinished(id)`.
7. If the queue is started, queue `checkWork`.
8. Call `done()`.

### 4.14 Stream Handling

The active runner stream handler maps upstream runner events into live
queue stream event messages.

Mapping:

1. `LLMRunnerOutputEvent` becomes `output` with payload
   `{ source, stream, chunk }`.
2. An event with a `payload` property becomes `stream` with payload
   `{ source, type, payload }`.
3. Any other stream event becomes `stream` with payload
   `{ source, raw }`.

Response contribution:

| `streamMode` | Appended to `response` |
|---|---|
| `raw` | `stdout` chunks from `output` messages |
| `events` + `claude` | assistant text from Claude message content payloads |
| `events` + `codex` | assistant text from Codex assistant message payloads |

If a stream event contributes response text, the handler calls
`db.append(id, text)` before emitting the live stream event
message.
If the append throws, the caught value is normalized to `Error` and
stored as `activeRunner.error`.

---

## 5. CTGPromptServer

`CTGPromptServer` owns HTTP, authentication, response envelopes, SSE,
long-poll waits, route query parsing, and process lifecycle.

Types:

**CTGPromptRunnerType**

```ts
type CTGPromptRunnerType = "claude" | "codex";
```

| Value | Meaning |
|---|---|
| `claude` | Use the Claude `LLMRunner` implementation. |
| `codex` | Use the Codex `LLMRunner` implementation. |

**CTGPromptRunnerConfig**

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

**CTGPromptServerConfig**

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

`CTGPromptRunnerType` identifies the concrete `LLMRunner` subclass or
factory selected by server configuration. Spec2 supports `claude` and
`codex`.

Future runner types, such as `ollama`, can be added by extending
`CTGPromptRunnerType`, teaching `CTGPromptServer.createRunner(...)` how
to construct the runner, and adding any stream extraction rules required
for `streamMode = "events"`. No database schema change is required
unless runner type values are constrained in SQLite.

Constructor:

```ts
class CTGPromptServer {
    constructor(config: CTGPromptServerConfig);
}
```

The constructor validates configuration, creates the Express app, and
initializes server-owned live stream and waiter registries. The DB and
queue are opened by `start(...)`.

Static fields:

```ts
class CTGPromptServer {
    static readonly BODY_LIMIT_BYTES = 1048576;
}
```

| Field | Type | Visibility | Meaning |
|---|---|---|---|
| `BODY_LIMIT_BYTES` | `1048576` | public static readonly | Maximum accepted JSON request body size in bytes. |

Static methods:

```ts
class CTGPromptServer {
    static init(config: CTGPromptServerConfig): CTGPromptServer;
}
```

`CTGPromptServer.init(config)` returns `new CTGPromptServer(config)`.

Instance fields and accessors:

```ts
class CTGPromptServer {
    private readonly _config: CTGPromptServerConfig;
    private readonly _app: Express;
    private _db: CTGPromptDB | null;
    private _queue: CTGPromptQueue | null;
    private _listener: Server | null;
    private readonly _liveSinks: Map<number, Set<Response>>;
    private readonly _waiters: Map<number, Set<() => void>>;
    private _started: boolean;

    get app(): Express;
    get db(): CTGPromptDB;
    get queue(): CTGPromptQueue;
}
```

| Field | Type | Visibility | Meaning |
|---|---|---|---|
| `_config` | `CTGPromptServerConfig` | private readonly | Validated server configuration. |
| `_app` | `Express` | private readonly | Express application instance. |
| `_db` | `CTGPromptDB \| null` | private | Durable prompt database after `start(...)`, otherwise `null`. |
| `_queue` | `CTGPromptQueue \| null` | private | Prompt queue workflow after `start(...)`, otherwise `null`. |
| `_listener` | `Server \| null` | private | HTTP listener after `start(...)`, otherwise `null`. |
| `_liveSinks` | `Map<number, Set<Response>>` | private readonly | Server-owned live SSE response sinks keyed by queue record ID. |
| `_waiters` | `Map<number, Set<() => void>>` | private readonly | Server-owned long-poll completion waiters keyed by queue record ID. |
| `_started` | `boolean` | private | Whether the HTTP server has been started. |
| `app` | `Express` | public getter | Express application instance. |
| `db` | `CTGPromptDB` | public getter | Started durable prompt database; unavailable before `start(...)`. |
| `queue` | `CTGPromptQueue` | public getter | Started prompt queue workflow; unavailable before `start(...)`. |

Instance methods and accessors:

```ts
class CTGPromptServer {
    get app(): Express;
    get db(): CTGPromptDB;
    get queue(): CTGPromptQueue;

    start(port: number): Promise<{ host: string; port: number }>;
    close(): Promise<void>;

    protected createRunner(config: CTGPromptRunnerConfig): LLMRunner;
}
```

### 5.1 constructor

`constructor(config)` validates server configuration, stores the
configuration required by `start(...)`, builds the Express app, and
initializes empty `_liveSinks` and `_waiters` maps.

### 5.2 init

`init(config)` is a static factory method. It constructs and returns a
`CTGPromptServer` instance.

### 5.3 Config

Defaults:

| Field | Default |
|---|---|
| `host` | `127.0.0.1` |
| `database` | `prompts.db` |
| `initDB` | `true` |
| `concurrency` | `1` |
| `maxPromptBytes` | `131071` |
| `streamMode` | `events` |
| `keepAliveMs` | `15000` |
| `maxWaitMs` | `30000` |
| `defaultLimit` | `50` |
| `maxLimit` | `200` |

`runner.env` is a complete replacement for the child environment. When
omitted, the child inherits the server process environment.

### 5.4 app

`app` returns the configured Express app.

### 5.5 db

`db` returns the started `CTGPromptDB` instance. If called before
`start(...)`, it throws `INTERNAL_ERROR`.

### 5.6 queue

`queue` returns the started `CTGPromptQueue` instance. If called before
`start(...)`, it throws `INTERNAL_ERROR`.

### 5.7 start

`start(port)`:

1. Validates config and port.
2. Constructs the configured runner.
3. Opens `CTGPromptDB`.
4. Builds `CTGPromptQueue` with callbacks into the server's live sink
   registry.
5. Calls `queue.recover()`.
6. Calls `queue.start()`.
7. Binds the Express app.

### 5.8 close

`close()`:

1. Stops accepting HTTP connections.
2. Ends all SSE streams and long-poll waiters.
3. Calls `queue.stop()`.
4. Closes the database.

### 5.9 createRunner

`createRunner(config)` constructs the configured `LLMRunner`
implementation. Subclasses may override it to provide custom runner
construction.

### 5.10 Authentication

Every route requires:

```http
Authorization: Bearer <apiKey>
```

The bearer scheme is case-insensitive. The key comparison uses a
timing-safe comparison.

### 5.11 Routes

| Method | Path | Behavior |
|---|---|---|
| `POST` | `/prompt` | Submit `{ "prompt": string }` through `queue.submit`. Returns `202`. |
| `GET` | `/prompt/:id` | Read one record through `db.read`. Optional `?wait=<ms>` uses long polling. |
| `GET` | `/prompt/:id/events` | Open a live-only SSE stream. |
| `DELETE` | `/prompt/:id` | Cancel a pending record through `queue.cancel`. |
| `GET` | `/prompts` | Return one pagination page through `db.paginate`. |
| `GET` | `/prompts/:status` | Resolve the status label to a status code and return one pagination page through `db.paginate`. |

Successful JSON responses use:

```json
{ "success": true, "result": {} }
```

Errors use:

```json
{
  "success": false,
  "result": {
    "label": "INVALID_QUERY",
    "code": 1006,
    "message": "Invalid query."
  }
}
```

The HTTP serialization of `CTGPromptQueueRecord` excludes `info`.

### 5.12 Long Poll

`GET /prompt/:id?wait=<ms>` waits up to `wait` milliseconds for the
record to finish.

Steps:

1. Clamp `wait` into `0..maxWaitMs`.
2. Read the record through `db.read(id)`.
3. If `statusCode` is `3`, `4`, or `5`, return it immediately.
4. Register a server-owned waiter for ID `id`.
5. Re-read the record to close the race with terminal completion.
6. Wait until the timer fires or the queue calls `onPromptFinished(id)`.
7. Deregister the waiter.
8. Re-read and return the current record.

The response status is `200` whether the prompt finished or the wait
elapsed.

### 5.13 SSE

`GET /prompt/:id/events` opens a live-only Server-Sent Events stream.

Headers:

```http
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

Frame format:

```text
event: <name>
data: <JSON payload>

```

SSE behavior:

1. Validate and read the record through `db.read(id)`.
2. Register the response as a live sink for ID `id`.
3. Write future `CTGPromptQueueStreamMessage` values received from the
   queue.
4. Write `: keep-alive` comments every `keepAliveMs` while open.
5. Close when the prompt reaches `statusCode` `3`, `4`, or `5`, or when
   the client disconnects.

No stream replay is guaranteed. A reconnecting client reads the current
record with `GET /prompt/:id`.

### 5.14 Pagination

`GET /prompts` and `GET /prompts/:status` parse these query fields:

| Query | Meaning |
|---|---|
| `limit` | Page size. Defaults to `defaultLimit`; must be `1..maxLimit`. |
| `before` | Cursor ID. Returns records with `id < before`. |
| `status` | Route parameter. Must resolve to one concrete `CTGPromptQueueStatusLabel`. The server uppercases the route value, validates it, and resolves it to `statusCode` with `CTGPromptQueue.statusCodeOf(status)`. |

The server builds a `CTGPromptPagination` object and calls
`db.paginate({ statusCode, limit, before })`. Successful responses
return the resulting `CTGPromptPaginationPage`.

---

## 6. CTGPromptServerError

`CTGPromptServerError` is the typed error class used for request errors
and prompt outcome error labels.

Types:

**CTGPromptOutcomeErrorLabel**

```ts
type CTGPromptOutcomeErrorLabel = "RUNNER" | "SERVER" | "INTERRUPTED";
```

| Value | Meaning |
|---|---|
| `RUNNER` | The configured runner failed. |
| `SERVER` | The server failed while handling queue state. |
| `INTERRUPTED` | The record was active during server startup recovery. |

**CTGPromptOutcomeErrorCode**

```ts
type CTGPromptOutcomeErrorCode = 1013 | 1014 | 1015;
```

| Value | Meaning |
|---:|---|
| `1013` | `RUNNER` |
| `1014` | `SERVER` |
| `1015` | `INTERRUPTED` |

**CTGPromptRequestErrorLabel**

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

**CTGPromptRequestErrorCode**

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

**CTGPromptServerErrorLabel**

```ts
type CTGPromptServerErrorLabel =
    | CTGPromptRequestErrorLabel
    | CTGPromptOutcomeErrorLabel;
```

| Value | Meaning |
|---|---|
| `CTGPromptRequestErrorLabel` | HTTP request error labels. |
| `CTGPromptOutcomeErrorLabel` | Durable prompt outcome error labels. |

**CTGPromptServerErrorCode**

```ts
type CTGPromptServerErrorCode =
    | CTGPromptRequestErrorCode
    | CTGPromptOutcomeErrorCode;
```

| Value | Meaning |
|---|---|
| `CTGPromptRequestErrorCode` | HTTP request error codes. |
| `CTGPromptOutcomeErrorCode` | Durable prompt outcome error codes. |

Constructor:

```ts
class CTGPromptServerError extends Error {
    constructor(label: CTGPromptServerErrorLabel, msg: string, data?: Record<string, unknown>);
}
```

Static fields:

```ts
class CTGPromptServerError extends Error {
    static readonly TYPES: Readonly<Record<string, number>>;
}
```

| Field | Type | Visibility | Meaning |
|---|---|---|---|
| `TYPES` | `Readonly<Record<string, number>>` | public static readonly | Label-to-code map for every supported error label. |

Static methods:

```ts
class CTGPromptServerError extends Error {
    static is(value: unknown): value is CTGPromptServerError;
    static isLabel(label: string): boolean;
    static isCode(code: number): boolean;
    static codeOf(label: CTGPromptServerErrorLabel): CTGPromptServerErrorCode;
    static labelOf(code: number): CTGPromptServerErrorLabel;
    static statusOf(label: CTGPromptServerErrorLabel): number | null;
}
```

Instance fields:

```ts
class CTGPromptServerError extends Error {
    readonly label: CTGPromptServerErrorLabel;
    readonly code: CTGPromptServerErrorCode;
    readonly msg: string;
    readonly data: Readonly<Record<string, unknown>>;
    readonly status: number | null;
}
```

| Field | Type | Visibility | Meaning |
|---|---|---|---|
| `label` | `CTGPromptServerErrorLabel` | public readonly | Stable human-readable error label. |
| `code` | `CTGPromptServerErrorCode` | public readonly | Stable numeric error code. |
| `msg` | `string` | public readonly | Human-readable error message. |
| `data` | `Readonly<Record<string, unknown>>` | public readonly | Structured diagnostic data. |
| `status` | `number \| null` | public readonly | HTTP status for request errors, or `null` for non-HTTP outcome errors. |

Instance methods:

```ts
class CTGPromptServerError extends Error {
    toResult(): { label: string; code: number; message: string };
}
```

### 6.1 constructor

`constructor(label, msg, data?)` creates a typed server error. It resolves
`code` and `status` from `label`.

### 6.2 TYPES

`TYPES` maps every supported error label to its stable numeric error
code.

### 6.3 is

`is(value)` returns whether `value` is a `CTGPromptServerError`.

### 6.4 isLabel

`isLabel(label)` returns whether `label` is a supported
`CTGPromptServerErrorLabel`.

### 6.5 isCode

`isCode(code)` returns whether `code` is a supported
`CTGPromptServerErrorCode`.

### 6.6 codeOf

`codeOf(label)` resolves a supported error label to its numeric error
code.

### 6.7 labelOf

`labelOf(code)` resolves a supported numeric error code to its label.

### 6.8 statusOf

`statusOf(label)` resolves a supported error label to its HTTP status, or
`null` when the label is not an HTTP request error.

### 6.9 toResult

`toResult()` returns the JSON-safe error envelope payload.

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

| Label | Code | HTTP status |
|---|---:|---:|
| `RUNNER` | 1013 | `null` |
| `SERVER` | 1014 | `null` |
| `INTERRUPTED` | 1015 | `null` |

`CTGPromptRequestErrorCode` is the finite set of request error codes in
the request table. `CTGPromptOutcomeErrorCode` is the finite set of
outcome error codes stored in SQLite.

Request errors serialize through `toResult()` in the HTTP error
envelope. Outcome error codes are stored on queue records and are not
directly used as HTTP response statuses. Code-to-label resolution is
performed by `CTGPromptServerError.labelOf(code)`. Unknown numeric codes
must be treated as corrupted or unsupported stored state, not displayed
as trusted labels.

---

## 7. Conformance Requirements

Required conformance coverage:

| Area | Required behavior |
|---|---|
| Schema | Created schema matches this spec. |
| Config | Invalid config throws `INVALID_CONFIG`; defaults are applied. |
| Queue records | Submit stores byte-identical prompt text and initial `status_code = 1`. |
| Claiming | `next()` claims oldest pending record, returns `null` when none exists, and never double-claims. |
| Lifecycle | `start()` enables processing; `stop()` prevents new claims and waits for active settlement. |
| Concurrency | Active runner count never exceeds `concurrency`. |
| Runner execution | `runPrompt` starts an `ActiveRunner` and does not block the agent queue. |
| Response | Stream text appends in order; final successful result overwrites accumulated response. |
| Errors | Runner failures store code `1013`; server persistence failures store code `1014`; startup recovery stores code `1015`. |
| Cancellation | Only pending records can be cancelled. |
| Server reads | `GET /prompt/:id` reads from `CTGPromptDB`. |
| Long poll | `wait` resolves on terminal state or timeout and returns current record. |
| SSE | Connected clients receive live stream event messages and terminal closure for `statusCode` 3, 4, or 5. |
| Reconnect | Reconnecting clients recover current state through `GET /prompt/:id`. |
| Pagination | Server parses pagination and calls `CTGPromptDB.paginate`. |
| Errors | HTTP error envelopes have exact `success` and `result` shapes, with `result.label`, `result.code`, and `result.message`. |

---

## 8. Not Supported

Spec2 does not include:

- durable per-event stream history,
- SSE `Last-Event-ID` replay,
- multiple runner selection per request,
- client-submitted `LLMPrompt` objects,
- prompt templates in the HTTP API,
- cancellation of active child processes,
- HTTP purge routes,
- cross-process active-run coordination,
- durable storage for `CTGAgentProc` or `HiveQueue` tasks.
