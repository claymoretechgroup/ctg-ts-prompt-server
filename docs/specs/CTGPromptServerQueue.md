# CTGPromptServerQueue

`CTGPromptServerQueue` owns durable queue operations, the configured
`LLMRunner`, the internal `CTGAgentProc` workflow, and currently active
runner executions. It does not own HTTP reads, list pagination,
long-poll waits, or SSE response sinks.

`CTGPromptServerQueue` registers one `CTGAgentProc` runner and these agents:

| Agent | Input | Responsibility |
|---|---|---|
| `checkWork` | `null` | Claim records while capacity remains. |
| `runPrompt` | `CTGPromptServerQueueRecord` | Create and track an `ActiveRunner`. |
| `finishPrompt` | `{ id, result }` | Persist a successful terminal outcome. |
| `failPrompt` | `{ id, error }` | Persist a failed terminal outcome. |

`checkWork` stops immediately when the queue is stopped, calls `next()`
while `activeRunners.size < concurrency`, emits a live `active` stream
event message for each claimed record, sends each claimed record to
`runPrompt`, and calls `done()`.

`runPrompt` creates the active runner stream handler, starts
`runner.run(record.prompt, ...)`, passes the resulting promise to
`CTGPromptServerQueue.activeRunner(...)`, stores the active runner in
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
to `failPrompt` with that error instead.

`failPrompt` persists the failed terminal outcome using the error code
provided by the `CTGPromptServerError` it receives. If it catches or is
given a non-`CTGPromptServerError` value, it wraps that value as
`UNKNOWN_ERROR` / `15` and stores the caught value in `data` when it can
be safely serialized. It emits a live `error` stream event message,
deletes the active runner, calls `_onPromptFinished(id)`, queues
`checkWork` when the queue is still started, and calls `done()`.

The active runner stream handler maps `LLMRunnerOutputEvent` values to
`output` messages with `{ source, stream, chunk }`, events with a
`payload` property to `stream` messages with `{ source, type, payload }`,
and all other stream events to `stream` messages with `{ source, raw }`.
For `streamMode = "raw"`, stdout chunks contribute to `response`. For
`streamMode = "events"`, Claude assistant text or Codex assistant text
contributes to `response`. Contributing text is written with
`db.append(id, text)` before the live stream event is emitted; append
failures are wrapped as `CTGPromptServerError` before being stored as
`activeRunner.error`.

```ts
class CTGPromptServerQueue {
    static readonly STATUS = {
        PENDING: 1,
        ACTIVE: 2,
        DONE: 3,
        ERROR: -1,
        CANCELLED: 5
    } as const;

    private readonly _db: CTGPromptServerDB;
    private readonly _runner: LLMRunner;
    private readonly _runnerType: CTGPromptRunnerType;
    private readonly _concurrency: number;
    private readonly _maxPromptBytes: number;
    private readonly _streamMode: CTGPromptStreamMode;
    private readonly _onStreamMessage: (message: CTGPromptServerQueueStreamMessage) => void;
    private readonly _onPromptFinished: (id: number) => void;
    private readonly _proc: CTGAgentProc;
    private readonly _activeRunners: ActiveRunners;
    private _started: boolean;
    private _stopping: Promise<void> | null;

    constructor(config: CTGPromptServerQueueConfig);

    submit(prompt: string): CTGPromptServerQueueRecord;
    cancel(id: number): CTGPromptServerQueueRecord;
    next(): CTGPromptServerQueueRecord | null;
    recover(): number;
    start(): void;
    stop(): Promise<void>;

    static activeRunner(config: ActiveRunnerConfig): ActiveRunner;

    static init(config: CTGPromptServerQueueConfig): CTGPromptServerQueue;
    static statusOf(code: number): string;
}
```

### Properties

| Property | Type | Description |
|---|---|---|
| `STATUS` | object | Static readonly label-to-code registry for durable queue states. |
| `_db` | `CTGPromptServerDB` | Durable prompt database boundary. |
| `_runner` | `LLMRunner` | Configured runner instance. |
| `_runnerType` | `CTGPromptRunnerType` | Configured runner type. |
| `_concurrency` | `number` | Maximum active runner count. |
| `_maxPromptBytes` | `number` | Maximum accepted prompt size in UTF-8 bytes. |
| `_streamMode` | `CTGPromptStreamMode` | Stream extraction mode. |
| `_onStreamMessage` | `(message: CTGPromptServerQueueStreamMessage) => void` | Callback used to hand live stream messages to the server. |
| `_onPromptFinished` | `(id: number) => void` | Callback used to wake server-owned waiters and close terminal streams. |
| `_proc` | `CTGAgentProc` | Internal agent workflow process. |
| `_activeRunners` | `ActiveRunners` | Active runner registry keyed by queue record ID. |
| `_started` | `boolean` | Whether the queue may claim new pending records. |
| `_stopping` | `Promise<void> \| null` | Current stop operation, or `null` when no stop is in progress. |

### Constructor

```ts
constructor(config: CTGPromptServerQueueConfig);
```

Initializes the queue's DB reference, runner, runner type, concurrency
limit, stream mode, callbacks, internal `CTGAgentProc`, and active
runner registry. The constructor does not claim work; processing begins
only after `start()`.

| Argument | Type | Description |
|---|---|---|
| `config` | `CTGPromptServerQueueConfig` | Durable DB, runner, limits, stream mode, and server callback configuration. |

### Instance Methods

#### INSTANCE :: ctgPromptServerQueue.submit

```ts
submit(prompt: string): CTGPromptServerQueueRecord;
```

Validates and stores one pending queue record with `db.create(prompt)`,
emits a live `pending` stream event message, queues `checkWork` when the
queue is started, and returns the inserted `CTGPromptServerQueueRecord`. The
prompt must be a non-empty string whose UTF-8 byte length is less than or
equal to `_maxPromptBytes`. Invalid prompt input throws
`CTGPromptServerRequestError.invalidPrompt(...)`, which sends
`INVALID_PROMPT` / `9` with HTTP status `400` when surfaced through a
route.

| Argument | Type | Description |
|---|---|---|
| `prompt` | `string` | Raw prompt text to store and execute byte-for-byte as submitted. |

---

#### INSTANCE :: ctgPromptServerQueue.cancel

```ts
cancel(id: number): CTGPromptServerQueueRecord;
```

Cancels a pending record with `db.cancel(id)`, emits a live `cancelled`
stream event message, calls `_onPromptFinished(id)`, and returns the
cancelled `CTGPromptServerQueueRecord`. Unknown IDs throw `PROMPT_NOT_FOUND`;
active or terminal records throw `CANCEL_NOT_ALLOWED`.

| Argument | Type | Description |
|---|---|---|
| `id` | `number` | Pending queue record ID to cancel. |

---

#### INSTANCE :: ctgPromptServerQueue.next

```ts
next(): CTGPromptServerQueueRecord | null;
```

Claims the next durable unit of work by calling `db.claimNext()`. It
returns the active `CTGPromptServerQueueRecord`, or `null` when no pending
record is available; it is a scheduling primitive, not a general read
API.

| Argument | Type | Description |
|---|---|---|
| none | none | This method takes no arguments. |

---

#### INSTANCE :: ctgPromptServerQueue.recover

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

#### INSTANCE :: ctgPromptServerQueue.start

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

#### INSTANCE :: ctgPromptServerQueue.stop

```ts
stop(): Promise<void>;
```

Disables new claims and resolves after the queue has stopped scheduling
new work. It does not wait for active runner results to settle and does
not turn active records into terminal records. A stopped queue may still
accept submitted records, but it must not claim them until `start()` is
called again.

| Argument | Type | Description |
|---|---|---|
| none | none | This method takes no arguments. |

### Protected Methods

No protected methods are specified for `CTGPromptServerQueue`.

### Private Methods

No private instance methods are specified for `CTGPromptServerQueue`.

### Static Methods

#### STATIC :: CTGPromptServerQueue.activeRunner

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

#### STATIC :: CTGPromptServerQueue.init

```ts
static init(config: CTGPromptServerQueueConfig): CTGPromptServerQueue;
```

Constructs and returns a `CTGPromptServerQueue` instance. This is the public
factory used by `CTGPromptServer` and tests; it has the same side
effects and exceptions as the constructor.

| Argument | Type | Description |
|---|---|---|
| `config` | `CTGPromptServerQueueConfig` | Durable DB, runner, limits, stream mode, and server callback configuration. |

---

#### STATIC :: CTGPromptServerQueue.statusOf

```ts
static statusOf(code: number): string;
```

Resolves a durable status code to its status label. Unknown numeric
codes are corrupted internal state: callers must treat the prompt as
`CTGPromptServerQueue.STATUS.ERROR` and throw
`CTGPromptServerError.init(CTGPromptServerError.CODE.INTERNAL_ERROR, ...)`.
The label is derived by reverse lookup from `CTGPromptServerQueue.STATUS`.

| Argument | Type | Description |
|---|---|---|
| `code` | `number` | Durable status code read from input or storage. |


---

## Types

### Queue Status Codes

Queue status codes are plain integers. The spec does not export dedicated
queue status-code or status-label types; constructor, database, and route
surfaces use `number`.

`CTGPromptServerQueue.STATUS` is the static readonly label-to-code registry:

```ts
static readonly STATUS = {
    PENDING: 1,
    ACTIVE: 2,
    DONE: 3,
    ERROR: -1,
    CANCELLED: 5
} as const;
```

Callers use the registry instead of hard-coding raw values, for example
`CTGPromptServerQueue.STATUS.PENDING`. Labels are derived response or display
values, not stored as separate durable values.

Invalid or unsupported status codes are not accepted through a separate
boolean validator. They represent corrupted internal state and must be
handled by setting the affected prompt status to
`CTGPromptServerQueue.STATUS.ERROR` and throwing
`CTGPromptServerError.CODE.INTERNAL_ERROR`.

### CTGPromptServerQueueStreamEventName

```ts
type CTGPromptServerQueueStreamEventName =
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

`CTGPromptServerQueueStreamEventName` is the queue's live stream event-name
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

### CTGPromptServerQueueStreamMessage

```ts
type CTGPromptServerQueueStreamMessage =
    | CTGPromptServerQueuePendingMessage
    | CTGPromptServerQueueActiveMessage
    | CTGPromptServerQueueOutputMessage
    | CTGPromptServerQueueRunnerStreamMessage
    | CTGPromptServerQueueDoneMessage
    | CTGPromptServerQueueErrorMessage
    | CTGPromptServerQueueCancelledMessage;
```

`CTGPromptServerQueueStreamMessage` is the queue's live-message union. Each
message has an `id` for the prompt queue record, a `name` used as the SSE
event name, an event-specific JSON-serializable `payload`, and
`createdAt` in epoch milliseconds.

```ts
interface CTGPromptServerQueueMessage<TName extends CTGPromptServerQueueStreamEventName, TPayload> {
    readonly id: number;
    readonly name: TName;
    readonly payload: TPayload;
    readonly createdAt: number;
}
```

`CTGPromptServerQueueMessage` is the shared structural shape extended by every
concrete live stream message. `TName` is the discriminant and SSE event
name; `TPayload` is the payload shape for that event name.

```ts
interface CTGPromptServerQueuePendingMessage
    extends CTGPromptServerQueueMessage<"pending", {
        readonly promptId: number;
        readonly statusCode: 1;
        readonly createdAt: number;
    }> {}
```

`CTGPromptServerQueuePendingMessage` is emitted after `submit(...)` stores a
new pending prompt record. It tells live clients that the prompt exists
and is waiting to be claimed.

```ts
interface CTGPromptServerQueueActiveMessage
    extends CTGPromptServerQueueMessage<"active", {
        readonly promptId: number;
        readonly statusCode: 2;
        readonly runner: CTGPromptRunnerType;
        readonly startedAt: number;
    }> {}
```

`CTGPromptServerQueueActiveMessage` is emitted after `next()` claims a pending
prompt for runner execution. It includes the configured runner type and
start timestamp.

```ts
interface CTGPromptServerQueueOutputMessage
    extends CTGPromptServerQueueMessage<"output", {
        readonly source: CTGPromptRunnerType;
        readonly stream: "stdout" | "stderr";
        readonly chunk: string;
    }> {}
```

`CTGPromptServerQueueOutputMessage` is emitted for runner stdout or stderr
output chunks. In `streamMode = "raw"`, stdout chunks also contribute to
the durable `response`; stderr chunks are live output only.

```ts
interface CTGPromptServerQueueRunnerStreamMessage
    extends CTGPromptServerQueueMessage<"stream", {
        readonly source: CTGPromptRunnerType;
        readonly type?: string;
        readonly payload?: unknown;
        readonly raw?: unknown;
    }> {}
```

`CTGPromptServerQueueRunnerStreamMessage` is emitted for structured upstream
runner stream events. Events with a `payload` property are exposed as
`{ source, type, payload }`; other stream events are exposed as
`{ source, raw }`.

```ts
interface CTGPromptServerQueueDoneMessage
    extends CTGPromptServerQueueMessage<"done", {
        readonly promptId: number;
        readonly statusCode: 3;
        readonly response: string;
        readonly finishedAt: number;
    }> {}
```

`CTGPromptServerQueueDoneMessage` is emitted after a runner succeeds and
`db.finish(...)` stores the terminal `DONE` record. It includes the final
response text.

```ts
interface CTGPromptServerQueueErrorMessage
    extends CTGPromptServerQueueMessage<"error", {
        readonly promptId: number;
        readonly statusCode: -1;
        readonly error: CTGPromptErrorResponse["result"];
        readonly finishedAt: number;
    }> {}
```

`CTGPromptServerQueueErrorMessage` is emitted after a runner, database,
internal, or interruption failure is stored as a terminal `ERROR`
record. It includes the public error payload derived from the persisted
error code and message; private error `data` is not included.

```ts
interface CTGPromptServerQueueCancelledMessage
    extends CTGPromptServerQueueMessage<"cancelled", {
        readonly promptId: number;
        readonly statusCode: 5;
        readonly finishedAt: number;
    }> {}
```

`CTGPromptServerQueueCancelledMessage` is emitted after `cancel(...)` stores a
terminal `CANCELLED` record for a pending prompt.

### CTGPromptServerQueueConfig

```ts
interface CTGPromptServerQueueConfig {
    db: CTGPromptServerDB;
    runner: LLMRunner;
    runnerType: CTGPromptRunnerType;
    concurrency: number;
    maxPromptBytes: number;
    streamMode: CTGPromptStreamMode;
    onStreamMessage: (message: CTGPromptServerQueueStreamMessage) => void;
    onPromptFinished: (id: number) => void;
}
```

| Property | Type | Required | Meaning |
|---|---|---:|---|
| `db` | `CTGPromptServerDB` | yes | Durable prompt database used by the queue. |
| `runner` | `LLMRunner` | yes | Configured runner instance used to execute prompts. |
| `runnerType` | `CTGPromptRunnerType` | yes | Configured runner type for the queue. |
| `concurrency` | `number` | yes | Maximum number of active runners. |
| `maxPromptBytes` | `number` | yes | Maximum accepted prompt size in UTF-8 bytes. |
| `streamMode` | `CTGPromptStreamMode` | yes | Stream format used to extract response text. |
| `onStreamMessage` | `(message: CTGPromptServerQueueStreamMessage) => void` | yes | Callback for live stream event messages. |
| `onPromptFinished` | `(id: number) => void` | yes | Callback invoked when a record reaches terminal state. |

### ActiveRunner

```ts
interface ActiveRunner {
    readonly record: CTGPromptServerQueueRecord;
    readonly runner: LLMRunner;
    readonly result: Promise<LLMRunnerResult>;
    error: Error | null;
}
```

| Property | Type | Required | Meaning |
|---|---|---:|---|
| `record` | `CTGPromptServerQueueRecord` | yes | Claimed prompt queue record being executed. |
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
    readonly record: CTGPromptServerQueueRecord;
    readonly runner: LLMRunner;
    readonly result: Promise<LLMRunnerResult>;
}
```

| Property | Type | Required | Meaning |
|---|---|---:|---|
| `record` | `CTGPromptServerQueueRecord` | yes | Claimed prompt queue record being executed. |
| `runner` | `LLMRunner` | yes | Runner instance executing the record. |
| `result` | `Promise<LLMRunnerResult>` | yes | Promise returned by the runner after `runPrompt` starts execution. |

---
