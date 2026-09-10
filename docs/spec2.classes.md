# ctg-ts-prompt-server spec2 classes

**Status:** proposed standalone class specification.

This document specifies class surfaces and method behavior for spec2.
Database schema is defined in `docs/spec2.db.md`. Type declarations are
defined in `docs/spec2.types.md`.

---

## 1. CTGPromptDB

`CTGPromptDB` owns SQLite access for durable prompt queue records. It
does not know about HTTP, SSE, agent workers, or live clients.

```ts
class CTGPromptDB {
    private readonly _db: DatabaseSync;

    constructor(config: CTGPromptDBConfig);

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

    static init(config: CTGPromptDBConfig): CTGPromptDB;
}
```

### Properties

| Property | Type | Description |
|---|---|---|
| `_db` | `DatabaseSync` | Internal SQLite connection used for all prompt queue record operations. |

### Constructor

```ts
constructor(config: CTGPromptDBConfig);
```

Opens the configured SQLite database, applies required pragmas, and
initializes the schema when `config.initDB !== false`. The constructor
throws `CTGPromptServerError("INVALID_CONFIG")` when the database cannot
be opened or the schema is unavailable.

| Argument | Type | Description |
|---|---|---|
| `config` | `CTGPromptDBConfig` | Database path and schema-initialization options. |

### Instance Methods

#### INSTANCE :: ctgPromptDB.create

```ts
create(prompt: string): CTGPromptQueueRecord;
```

Inserts one pending prompt queue record with `status_code = 1`, the raw
prompt text, an empty response, and `created_at = Date.now()`. It returns
the created `CTGPromptQueueRecord` and throws a store/config error if the
insert fails.

| Argument | Type | Description |
|---|---|---|
| `prompt` | `string` | Raw prompt text to store exactly as submitted. |

---

#### INSTANCE :: ctgPromptDB.read

```ts
read(id: number): CTGPromptQueueRecord | null;
```

Reads one prompt queue record by ID. It returns the materialized
`CTGPromptQueueRecord` when found, or `null` when no row exists; it does
not mutate the database.

| Argument | Type | Description |
|---|---|---|
| `id` | `number` | Queue record ID to read. |

---

#### INSTANCE :: ctgPromptDB.paginate

```ts
paginate(pagination: CTGPromptPagination): CTGPromptPaginationPage;
```

Returns records ordered by newest ID first, optionally filtered by
`pagination.statusCode`. `pagination.before` is a cursor, so
`before: 120` returns rows where `id < 120`; the result includes
`nextBefore` when another page is available.

| Argument | Type | Description |
|---|---|---|
| `pagination` | `CTGPromptPagination` | Page size, optional status filter, and optional cursor ID. |

_Example_

```ts
const page = db.paginate({ statusCode: 1, limit: 50, before: 120 });
```

---

#### INSTANCE :: ctgPromptDB.update

```ts
update(record: CTGPromptQueueRecord): CTGPromptQueueRecord;
```

Persists mutable fields from an existing `CTGPromptQueueRecord` and
returns the updated materialized record. `record.id` selects the row;
`id`, `prompt`, and `createdAt` remain immutable, and unknown IDs throw
`CTGPromptServerError("PROMPT_NOT_FOUND")`.

| Argument | Type | Description |
|---|---|---|
| `record` | `CTGPromptQueueRecord` | Existing queue record carrying the mutable values to persist. |

---

#### INSTANCE :: ctgPromptDB.delete

```ts
delete(id: number): CTGPromptQueueRecord | null;
```

Deletes one prompt queue record by ID. It returns the deleted
`CTGPromptQueueRecord`, or `null` when no row exists; deletion is a
durable database mutation.

| Argument | Type | Description |
|---|---|---|
| `id` | `number` | Queue record ID to delete. |

---

#### INSTANCE :: ctgPromptDB.append

```ts
append(id: number, text: string): CTGPromptQueueRecord;
```

Appends `text` to the record's `response` column without changing
`statusCode`, then returns the updated record. Unknown IDs throw
`CTGPromptServerError("PROMPT_NOT_FOUND")`; implementations should use
SQLite string concatenation so concurrent appends remain atomic.

| Argument | Type | Description |
|---|---|---|
| `id` | `number` | Queue record ID whose response should be appended. |
| `text` | `string` | Response text fragment to append. |

---

#### INSTANCE :: ctgPromptDB.claimNext

```ts
claimNext(): CTGPromptQueueRecord | null;
```

Atomically claims the oldest pending record by changing `status_code`
from `1` to `2` and setting `started_at`. It returns the claimed record,
or `null` when no pending work exists; the update condition must include
`WHERE status_code = 1` so cancellation and claiming cannot both win.

| Argument | Type | Description |
|---|---|---|
| none | none | This method takes no arguments. |

---

#### INSTANCE :: ctgPromptDB.finish

```ts
finish(id: number, outcome: CTGPromptDBPromptOutcome): CTGPromptQueueRecord;
```

Moves a record to terminal status code `3` or `4`, writes response or
error fields, serializes optional diagnostics to `info`, and sets
`finishedAt = Date.now()`. Successful finishes clear error fields;
failed finishes default `errorCode` to `1014` when not supplied.

| Argument | Type | Description |
|---|---|---|
| `id` | `number` | Queue record ID to finish. |
| `outcome` | `CTGPromptDBPromptOutcome` | Terminal status, response or error values, and optional diagnostics. |

_Examples_

```ts
const done = db.finish(record.id, {
    statusCode: 3,
    response: "Final response text."
});

const failed = db.finish(record.id, {
    statusCode: 4,
    errorCode: 1013,
    errorMessage: "Runner failed."
});
```

---

#### INSTANCE :: ctgPromptDB.cancel

```ts
cancel(id: number): CTGPromptQueueRecord;
```

Cancels only pending records by setting `statusCode = 5` and
`finishedAt = Date.now()`. Unknown IDs throw `PROMPT_NOT_FOUND`, and
active or finished records throw `CANCEL_NOT_ALLOWED`.

| Argument | Type | Description |
|---|---|---|
| `id` | `number` | Pending queue record ID to cancel. |

---

#### INSTANCE :: ctgPromptDB.interruptActive

```ts
interruptActive(): number;
```

Moves every active record to error status with `error_code = 1015`, an
interrupted message, and `finished_at = Date.now()`. It returns the
number of rows changed. `CTGPromptServer` calls this while starting up
so every record left active by a previous server stop is updated to the
interrupted terminal outcome before new work is claimed.

| Argument | Type | Description |
|---|---|---|
| none | none | This method takes no arguments. |

---

#### INSTANCE :: ctgPromptDB.close

```ts
close(): void;
```

Closes the underlying SQLite connection. It returns nothing; callers
should not use the `CTGPromptDB` instance after closing it.

| Argument | Type | Description |
|---|---|---|
| none | none | This method takes no arguments. |

### Protected Methods

No protected methods are specified for `CTGPromptDB`.

### Private Methods

No private methods are specified for `CTGPromptDB`.

### Static Methods

#### STATIC :: CTGPromptDB.init

```ts
static init(config: CTGPromptDBConfig): CTGPromptDB;
```

Constructs and returns a `CTGPromptDB` instance. This is the public
factory used by `CTGPromptServer` and tests; it has the same side
effects and exceptions as the constructor.

| Argument | Type | Description |
|---|---|---|
| `config` | `CTGPromptDBConfig` | Database path and schema-initialization options. |

---

## 2. CTGPromptQueue

`CTGPromptQueue` owns durable queue operations, the configured
`LLMRunner`, the internal `CTGAgentProc` workflow, and currently active
runner executions. It does not own HTTP reads, list pagination,
long-poll waits, or SSE response sinks.

`CTGPromptQueue` registers one `CTGAgentProc` runner and these agents:

| Agent | Input | Responsibility |
|---|---|---|
| `checkWork` | `null` | Claim records while capacity remains. |
| `runPrompt` | `CTGPromptQueueRecord` | Create and track an `ActiveRunner`. |
| `finishPrompt` | `{ id, result }` | Persist a successful terminal outcome. |
| `failPrompt` | `{ id, errorCode, error }` | Persist a failed terminal outcome. |

`checkWork` stops immediately when the queue is stopped, calls `next()`
while `activeRunners.size < concurrency`, emits a live `active` stream
event message for each claimed record, sends each claimed record to
`runPrompt`, and calls `done()`.

`runPrompt` creates the active runner stream handler, starts
`runner.run(record.prompt, ...)`, passes the resulting promise to
`CTGPromptQueue.activeRunner(...)`, stores the active runner in
`activeRunners` keyed by record ID, attaches result continuations, and
calls `done()` without awaiting `activeRunner.result`. A synchronous
throw from `runner.run(...)` is normalized into a rejected result promise
inside `runPrompt`. Runner result continuations are posted to the
queue-owned `CTGAgentProc` instance; they must not use a worker-scoped
`send()` after that worker has called `done()`.

`finishPrompt` persists successful terminal outcomes, emits a live
`done` stream event message, deletes the active runner, calls
`_onPromptFinished(id)`, queues `checkWork` when the queue is still
started, and calls `done()`. If `activeRunner.error !== null`, it routes
to `failPrompt` with `errorCode = 1014` instead.

`failPrompt` converts runner failures into `errorCode = 1013`, converts
server failures into `errorCode = 1014`, persists the failed terminal
outcome, emits a live `error` stream event message, deletes the active
runner, calls `_onPromptFinished(id)`, queues `checkWork` when the queue
is still started, and calls `done()`.

The active runner stream handler maps `LLMRunnerOutputEvent` values to
`output` messages with `{ source, stream, chunk }`, events with a
`payload` property to `stream` messages with `{ source, type, payload }`,
and all other stream events to `stream` messages with `{ source, raw }`.
For `streamMode = "raw"`, stdout chunks contribute to `response`. For
`streamMode = "events"`, Claude assistant text or Codex assistant text
contributes to `response`. Contributing text is written with
`db.append(id, text)` before the live stream event is emitted; append
failures are normalized to `Error` and stored as `activeRunner.error`.

```ts
class CTGPromptQueue {
    private static readonly STATUS_CODE_BY_LABEL: Readonly<Record<CTGPromptQueueStatusLabel, CTGPromptQueueStatusCode>>;
    private static readonly STATUS_LABEL_BY_CODE: Readonly<Record<CTGPromptQueueStatusCode, CTGPromptQueueStatusLabel>>;

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

    constructor(config: CTGPromptQueueConfig);

    submit(prompt: string): CTGPromptQueueRecord;
    cancel(id: number): CTGPromptQueueRecord;
    next(): CTGPromptQueueRecord | null;
    recover(): number;
    start(): void;
    stop(): Promise<void>;

    static activeRunner(config: ActiveRunnerConfig): ActiveRunner;

    static init(config: CTGPromptQueueConfig): CTGPromptQueue;
    static statusCodeOf(status: CTGPromptQueueStatusLabel): CTGPromptQueueStatusCode;
    static statusOf(code: number): CTGPromptQueueStatusLabel;
    static isStatusCode(code: number): boolean;
}
```

### Properties

| Property | Type | Description |
|---|---|---|
| `STATUS_CODE_BY_LABEL` | `Readonly<Record<CTGPromptQueueStatusLabel, CTGPromptQueueStatusCode>>` | Internal static map used by `statusCodeOf(...)`. |
| `STATUS_LABEL_BY_CODE` | `Readonly<Record<CTGPromptQueueStatusCode, CTGPromptQueueStatusLabel>>` | Internal static map used by `statusOf(...)`. |
| `_db` | `CTGPromptDB` | Durable prompt database boundary. |
| `_runner` | `LLMRunner` | Configured runner instance. |
| `_runnerType` | `CTGPromptRunnerType` | Configured runner type. |
| `_concurrency` | `number` | Maximum active runner count. |
| `_maxPromptBytes` | `number` | Maximum accepted prompt size in UTF-8 bytes. |
| `_streamMode` | `CTGPromptStreamMode` | Stream extraction mode. |
| `_onStreamMessage` | `(message: CTGPromptQueueStreamMessage) => void` | Callback used to hand live stream messages to the server. |
| `_onPromptFinished` | `(id: number) => void` | Callback used to wake server-owned waiters and close terminal streams. |
| `_proc` | `CTGAgentProc` | Internal agent workflow process. |
| `_activeRunners` | `ActiveRunners` | Active runner registry keyed by queue record ID. |
| `_started` | `boolean` | Whether the queue may claim new pending records. |
| `_stopping` | `Promise<void> \| null` | Current stop operation, or `null` when no stop is in progress. |

### Constructor

```ts
constructor(config: CTGPromptQueueConfig);
```

Initializes the queue's DB reference, runner, runner type, concurrency
limit, stream mode, callbacks, internal `CTGAgentProc`, and active
runner registry. The constructor does not claim work; processing begins
only after `start()`.

| Argument | Type | Description |
|---|---|---|
| `config` | `CTGPromptQueueConfig` | Durable DB, runner, limits, stream mode, and server callback configuration. |

### Instance Methods

#### INSTANCE :: ctgPromptQueue.submit

```ts
submit(prompt: string): CTGPromptQueueRecord;
```

Validates and stores one pending queue record with `db.create(prompt)`,
emits a live `pending` stream event message, queues `checkWork` when the
queue is started, and returns the inserted `CTGPromptQueueRecord`. The
prompt must be a non-empty string whose UTF-8 byte length is less than or
equal to `_maxPromptBytes`.

| Argument | Type | Description |
|---|---|---|
| `prompt` | `string` | Raw prompt text to store and execute byte-for-byte as submitted. |

---

#### INSTANCE :: ctgPromptQueue.cancel

```ts
cancel(id: number): CTGPromptQueueRecord;
```

Cancels a pending record with `db.cancel(id)`, emits a live `cancelled`
stream event message, calls `_onPromptFinished(id)`, and returns the
cancelled `CTGPromptQueueRecord`. Unknown IDs throw `PROMPT_NOT_FOUND`;
active or terminal records throw `CANCEL_NOT_ALLOWED`.

| Argument | Type | Description |
|---|---|---|
| `id` | `number` | Pending queue record ID to cancel. |

---

#### INSTANCE :: ctgPromptQueue.next

```ts
next(): CTGPromptQueueRecord | null;
```

Claims the next durable unit of work by calling `db.claimNext()`. It
returns the active `CTGPromptQueueRecord`, or `null` when no pending
record is available; it is a scheduling primitive, not a general read
API.

| Argument | Type | Description |
|---|---|---|
| none | none | This method takes no arguments. |

---

#### INSTANCE :: ctgPromptQueue.recover

```ts
recover(): number;
```

Calls `db.interruptActive()` and returns the number of interrupted
records. `CTGPromptServer` calls this during startup before `start()` so
records that were active during a previous server stop become terminal
error records.

| Argument | Type | Description |
|---|---|---|
| none | none | This method takes no arguments. |

---

#### INSTANCE :: ctgPromptQueue.start

```ts
start(): void;
```

Enables queue processing and queues `checkWork`. The method is
idempotent; calling it while already started must not cause duplicate
claims beyond the configured concurrency limit.

| Argument | Type | Description |
|---|---|---|
| none | none | This method takes no arguments. |

---

#### INSTANCE :: ctgPromptQueue.stop

```ts
stop(): Promise<void>;
```

Disables new claims and resolves after active runner results plus queued
terminal tasks settle. A stopped queue may still accept submitted
records, but it must not claim them until `start()` is called again.

| Argument | Type | Description |
|---|---|---|
| none | none | This method takes no arguments. |

### Protected Methods

No protected methods are specified for `CTGPromptQueue`.

### Private Methods

No private instance methods are specified for `CTGPromptQueue`.

### Static Methods

#### STATIC :: CTGPromptQueue.activeRunner

```ts
static activeRunner(config: ActiveRunnerConfig): ActiveRunner;
```

Creates and returns an `ActiveRunner` value from an already-started
runner result promise. It does not call `runner.run(...)`; `runPrompt`
starts the runner, normalizes synchronous throws into rejected result
promises, and then calls this factory. This is static because
construction only depends on the supplied `ActiveRunnerConfig`; keeping
it public makes the active runner value construction path directly
testable.

| Argument | Type | Description |
|---|---|---|
| `config` | `ActiveRunnerConfig` | Claimed record, runner, and already-created runner result promise. |

---

#### STATIC :: CTGPromptQueue.init

```ts
static init(config: CTGPromptQueueConfig): CTGPromptQueue;
```

Constructs and returns a `CTGPromptQueue` instance. This is the public
factory used by `CTGPromptServer` and tests; it has the same side
effects and exceptions as the constructor.

| Argument | Type | Description |
|---|---|---|
| `config` | `CTGPromptQueueConfig` | Durable DB, runner, limits, stream mode, and server callback configuration. |

---

#### STATIC :: CTGPromptQueue.statusCodeOf

```ts
static statusCodeOf(status: CTGPromptQueueStatusLabel): CTGPromptQueueStatusCode;
```

Resolves a supported status label to the durable status code stored in
SQLite. Unknown labels must be treated as unsupported boundary input.

| Argument | Type | Description |
|---|---|---|
| `status` | `CTGPromptQueueStatusLabel` | Queue status label to resolve. |

---

#### STATIC :: CTGPromptQueue.statusOf

```ts
static statusOf(code: number): CTGPromptQueueStatusLabel;
```

Resolves a durable status code to its status label. Unknown numeric
codes must be treated as corrupted or unsupported stored state.

| Argument | Type | Description |
|---|---|---|
| `code` | `number` | Durable status code read from input or storage. |

---

#### STATIC :: CTGPromptQueue.isStatusCode

```ts
static isStatusCode(code: number): boolean;
```

Returns whether `code` is one of the supported durable queue status
codes. It is used to validate unknown numeric input before accepting it
as stored state.

| Argument | Type | Description |
|---|---|---|
| `code` | `number` | Numeric value to test as a durable queue status code. |
