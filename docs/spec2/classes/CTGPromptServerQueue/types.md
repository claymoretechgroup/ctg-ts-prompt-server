# CTGPromptServerQueue Types

### Queue Status Codes

Queue status codes are plain integers. Spec2 does not export dedicated
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
