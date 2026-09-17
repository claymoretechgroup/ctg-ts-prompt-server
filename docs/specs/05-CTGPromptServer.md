# CTGPromptServer

`CTGPromptServer` is the HTTP and process-lifecycle boundary for the
prompt service. It owns the Express application, configuration, database,
queue, runner construction, route binding, live SSE sinks, long-poll
waiters, startup, and shutdown.

Route handlers are implemented outside this class. Each route group
module exports a default function that binds routes to an Express app,
and the aggregate `routes/index.ts` binder owns route binding order.
`CTGPromptServer` imports only the aggregate binder and passes it the
Express app plus the server instance; it does not name individual paths
in the class body.

```ts
class CTGPromptServer {
    private readonly _config: CTGPromptServerConfig;
    private readonly _app: Express;
    private readonly _db: CTGPromptServerDB;
    private readonly _sse: Map<number, Set<CTGPromptSSESink>>;
    private readonly _waiters: Map<number, Set<() => void>>;
    private _queue: CTGPromptServerQueue | null;
    private _listener: Server | null;
    private _started: boolean;
    private _closed: boolean;

    protected constructor(config: CTGPromptServerConfig);

    get app(): Express;
    get config(): CTGPromptServerConfig;
    get db(): CTGPromptServerDB;
    get queue(): CTGPromptServerQueue;

    start(port: number): Promise<{ host: string; port: number }>;
    close(): Promise<void>;

    openSSE(id: number, sink: CTGPromptSSESink): { close(): void };
    closeSSE(id: number): void;
    publishSSE(message: CTGPromptServerQueueStreamMessage): void;
    waitForPrompt(id: number, waitMs: number): Promise<CTGPromptServerQueueRecord>;
    notifyPromptFinished(id: number): void;

    protected createRunner(config: CTGPromptRunnerConfig): LLMRunner;

    static init(config: CTGPromptServerConfig): CTGPromptServer;
}
```

---

## Route Surface

Routes are Express routes. All routes require
`Authorization: Bearer <apiKey>`.

| Method | Path | Group | Success | Notes |
|---|---|---|---|---|
| `POST` | `/prompt` | prompt | `202` JSON response | Submit raw prompt text. |
| `GET` | `/prompt/:id` | prompt | `200` JSON response | Read prompt state; optional `?wait=<ms>` long poll. |
| `DELETE` | `/prompt/:id` | prompt | `200` JSON response | Cancel a pending prompt. |
| `GET` | `/sse/:id` | sse | `200` SSE stream | Open live SSE stream for one prompt. |
| `GET` | `/prompts` | prompts | `200` JSON response | List prompts newest first. |
| `GET` | `/prompts/:status` | prompts | `200` JSON response | List prompts by status. |

Route modules:

| Module | Owns |
|---|---|
| `routes/prompt.ts` | `POST /prompt`, `GET /prompt/:id`, `DELETE /prompt/:id` |
| `routes/prompts.ts` | `GET /prompts`, `GET /prompts/:status` |
| `routes/sse.ts` | `GET /sse/:id` |
| `routes/fallback.ts` | method-not-allowed, not-found, and error response handling |
| `routes/index.ts` | Binding order for every route group |

Each route group exports a default binder:

```ts
export default function promptRoutes(
    app: Express,
    server: CTGPromptServer
): void;
```

The aggregate binder has the same shape and is the only route binder
called by `CTGPromptServer`.

Route modules are part of the `CTGPromptServer` implementation boundary.
They receive the server instance and may use documented public methods
and getters. They must not access private fields.

---

## Route Behavior

### Authentication

Authentication is Express middleware installed before all route groups.
It accepts only `Authorization: Bearer <apiKey>`. The bearer scheme is
case-insensitive; the key comparison must not leak useful timing
differences. Missing, malformed, or mismatched credentials throw
`CTGPromptServerRequestError.unauthorized(...)`, which sends
`UNAUTHORIZED` / `6` with HTTP status `401`.

### POST /prompt

`POST /prompt` requires `Content-Type: application/json`. The JSON body
reader accepts up to `1 MiB` / `1,048,576` bytes. A body over that limit
throws `CTGPromptServerRequestError.invalidBody(...)`; the body limit is
fixed and is not a configuration field.

Request body:

```json
{ "prompt": "raw prompt text" }
```

The body must be a JSON object with a `prompt` property. Extra
properties are ignored. The route delegates prompt validation to
`CTGPromptServerQueue.submit(...)` and returns the created prompt as a
public `CTGPromptRecord` success response with status `202`.

Malformed JSON or invalid body shape throws
`CTGPromptServerRequestError.invalidBody(...)`, which sends
`INVALID_BODY` / `8` with HTTP status `400`. Non-JSON content type
throws `CTGPromptServerRequestError.invalidContentType(...)`, which
sends `INVALID_CONTENT_TYPE` / `7` with HTTP status `415`.
Invalid prompt text from `CTGPromptServerQueue.submit(...)` throws
`CTGPromptServerRequestError.invalidPrompt(...)`, which sends
`INVALID_PROMPT` / `9` with HTTP status `400`.

### GET /prompt/:id

`GET /prompt/:id` parses `:id` as a base-10 integer. A malformed ID
throws `CTGPromptServerRequestError.invalidQuery(...)` before any prompt
lookup.

Without `wait`, the route reads the current prompt record and returns it
immediately as a public `CTGPromptRecord`.

With `?wait=<ms>`, `wait` must be a base-10 integer greater than or
equal to zero. The server long-polls until the prompt becomes terminal or
the clamped wait duration elapses, then returns the current prompt
record as a public `CTGPromptRecord` either way. The route never returns
`202` for an elapsed wait; it returns `200` with the current record
state.

Unknown IDs throw `CTGPromptServerRequestError.promptNotFound(...)`,
which sends `PROMPT_NOT_FOUND` / `11` with HTTP status `404`.

### DELETE /prompt/:id

`DELETE /prompt/:id` parses `:id` as a base-10 integer and delegates to
`CTGPromptServerQueue.cancel(id)`. Successful cancellation returns the
cancelled prompt as a public `CTGPromptRecord`.

Unknown IDs throw `CTGPromptServerRequestError.promptNotFound(...)`.
Active or terminal prompts throw
`CTGPromptServerRequestError.cancelNotAllowed(...)`, which sends
`CANCEL_NOT_ALLOWED` / `12` with HTTP status `409`.

### GET /sse/:id

`GET /sse/:id` parses `:id` as a base-10 integer and confirms the prompt
exists before opening the SSE stream. Unknown IDs return a JSON
`PROMPT_NOT_FOUND` / `11` response with HTTP status `404`; no SSE
headers are written.

Once open, the response uses:

```text
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

SSE is live-only. The route does not replay durable event history,
and `Last-Event-ID` is not part of the spec. Clients that
reconnect must recover current state with `GET /prompt/:id`.

The server writes keep-alive comment frames every `keepAliveMs` while the
stream remains open:

```text
: keep-alive

```

The stream closes after a terminal `done`, `error`, or `cancelled`
message is delivered, when the client disconnects, or when
`CTGPromptServer.close()` closes live streams.

### GET /prompts

`GET /prompts` lists prompt records newest first. Supported query
parameters:

| Query | Meaning |
|---|---|
| `limit` | Optional page size, `1..maxLimit`. |
| `before` | Optional cursor ID; returns records with IDs lower than this value. |

Invalid `limit` or `before` values throw
`CTGPromptServerRequestError.invalidQuery(...)`.
Successful responses return `CTGPromptPageResponse`; each record in
`result.records` is a public `CTGPromptRecord`.

### GET /prompts/:status

`GET /prompts/:status` behaves like `GET /prompts` with a lifecycle
status filter. Supported status segments are `pending`, `active`,
`done`, `error`, and `cancelled`.

Unknown status values throw `CTGPromptServerRequestError.invalidQuery(...)`.

### Fallbacks

If a path matches a supported route with the wrong HTTP method, return
`CTGPromptServerRequestError.methodNotAllowed(...)`, which sends
`METHOD_NOT_ALLOWED` / `14` with HTTP status `405`. If no route path
matches, return `CTGPromptServerRequestError.notFound(...)`, which sends
`NOT_FOUND` / `13` with HTTP status `404`.

The fallback route group must be bound after prompt, prompts, and SSE
route groups.

---

## Properties

| Property | Type | Description |
|---|---|---|
| `_config` | `CTGPromptServerConfig` | Validated server configuration with defaults applied. |
| `_app` | `Express` | Express application created by the server. |
| `_db` | `CTGPromptServerDB` | Open prompt database. |
| `_sse` | `Map<number, Set<CTGPromptSSESink>>` | Live SSE sinks keyed by prompt ID. |
| `_waiters` | `Map<number, Set<() => void>>` | Long-poll waiter resolvers keyed by prompt ID. |
| `_queue` | `CTGPromptServerQueue \| null` | Queue instance created during startup. |
| `_listener` | `Server \| null` | Bound HTTP listener. |
| `_started` | `boolean` | Whether `start(...)` has run. |
| `_closed` | `boolean` | Whether `close()` has closed server resources. |

### GETTER :: ctgPromptServer.app

```ts
get app(): Express;
```

Returns the configured Express application. The app exists before
`start(...)` so tests may inspect or exercise the route stack without
binding a network listener.

### GETTER :: ctgPromptServer.config

```ts
get config(): CTGPromptServerConfig;
```

Returns the validated configuration with defaults applied. Route modules
use this getter for route-level limits such as `maxLimit`,
`maxWaitMs`, and `keepAliveMs`.

### GETTER :: ctgPromptServer.db

```ts
get db(): CTGPromptServerDB;
```

Returns the open database owned by the server.

### GETTER :: ctgPromptServer.queue

```ts
get queue(): CTGPromptServerQueue;
```

Returns the started queue. Before `start(...)` creates the queue, this
getter throws `INTERNAL_ERROR` / `2`.

---

## Constructor

```ts
protected constructor(config: CTGPromptServerConfig);
```

The constructor receives configuration that has already been validated
and had defaults applied by `init(...)`. It stores that configuration,
opens `CTGPromptServerDB`, creates live SSE and long-poll registries, creates
the Express app, and calls the aggregate route binder with the app and
server instance.

The constructor does not construct the runner, construct the queue, bind
the HTTP listener, recover active rows, or start queue processing.

---

## Instance Methods

### INSTANCE :: ctgPromptServer.start

```ts
start(port: number): Promise<{ host: string; port: number }>;
```

Validates `port`, constructs the configured runner, constructs
`CTGPromptServerQueue`, recovers active rows, starts the queue, and binds the
Express app to `_config.host`.

Startup order:

1. Reject invalid ports with `INVALID_CONFIG`. `port` must be an integer
   in `0..65535`; `0` asks the operating system for an ephemeral port.
2. Reject a second start with `INTERNAL_ERROR`.
3. Construct the configured runner through `createRunner(...)`.
4. Construct `CTGPromptServerQueue` with server callbacks for live stream
   messages and prompt-finished notifications.
5. Call `queue.recover()` before accepting new work.
6. Call `queue.start()`.
7. Bind the HTTP listener.
8. Resolve with the bound host and port.

If runner construction throws, wrap the failure in
`INVALID_CONFIG` / `1`.

### INSTANCE :: ctgPromptServer.close

```ts
close(): Promise<void>;
```

Stops accepting HTTP connections, closes live SSE streams, wakes
long-poll waiters, stops queue claims, and closes the database. It does
not wait for active runner results to settle.

Shutdown order:

1. Mark the server closed.
2. Stop the HTTP listener when it exists.
3. Close all live SSE sinks.
4. Resolve all long-poll waiters.
5. Stop the queue when it exists, disabling new claims without draining
   active runners.
6. Close the database.

`close()` is idempotent. Rows still `ACTIVE` after close are handled by
startup recovery on the next `start(...)`, which marks them interrupted.
Graceful drain shutdown is future scope, not part of the spec.

### INSTANCE :: ctgPromptServer.openSSE

```ts
openSSE(id: number, sink: CTGPromptSSESink): { close(): void };
```

Registers one live SSE sink for prompt ID `id` and returns an
idempotent deregistration handle. The `/sse/:id` route calls this after
it has validated the prompt ID and written SSE headers.

### INSTANCE :: ctgPromptServer.closeSSE

```ts
closeSSE(id: number): void;
```

Ends and deregisters every open SSE sink for prompt ID `id`. The server
calls this when a prompt reaches a terminal state.

### INSTANCE :: ctgPromptServer.publishSSE

```ts
publishSSE(message: CTGPromptServerQueueStreamMessage): void;
```

Writes one live stream message to every open SSE sink for
`message.id`. Write failures close and deregister only the failing sink.

### INSTANCE :: ctgPromptServer.waitForPrompt

```ts
waitForPrompt(id: number, waitMs: number): Promise<CTGPromptServerQueueRecord>;
```

Implements long polling for `GET /prompt/:id?wait=<ms>`. It reads the
prompt, returns immediately when the prompt is already terminal, or
waits until the prompt reaches a terminal state or the clamped wait
duration elapses.

### INSTANCE :: ctgPromptServer.notifyPromptFinished

```ts
notifyPromptFinished(id: number): void;
```

Wakes long-poll waiters and closes live SSE sinks for prompt ID `id`.
`CTGPromptServerQueue` calls this through its prompt-finished callback when a
record reaches a terminal state.

---

## Protected Methods

### PROTECTED :: ctgPromptServer.createRunner

```ts
protected createRunner(config: CTGPromptRunnerConfig): LLMRunner;
```

Constructs the configured `LLMRunner` implementation. `runner.env`, when
supplied, is a complete child environment replacement. If omitted, the
runner inherits the server process environment according to
`ctg-ai-agent-proc` behavior.

`createRunner(...)` passes `timeout` as the configured value or
`600000` milliseconds when omitted. It passes `maxBuffer` only when the
caller supplied it, so the selected runner implementation keeps its own
default otherwise.

---

## Private Methods

The implementation may define private helpers for auth middleware,
response serialization, query parsing, SSE sink management, waiter
management, and config resolution. Private helpers are not part of the
public class contract.

---

## Static Methods

### STATIC :: CTGPromptServer.init

```ts
static init(config: CTGPromptServerConfig): CTGPromptServer;
```

Validates and resolves `CTGPromptServerConfig`, then constructs a
`CTGPromptServer`. Invalid config throws `INVALID_CONFIG` / `1`.
Validation rules and defaults are defined in
[Types](#types).


---

## Types

### CTGPromptRunnerType

```ts
type CTGPromptRunnerType = "claude" | "codex";
```

| Value | Meaning |
|---|---|
| `claude` | Use the Claude `LLMRunner` implementation. |
| `codex` | Use the Codex `LLMRunner` implementation. |

`CTGPromptRunnerType` identifies the concrete `LLMRunner` implementation
selected by server configuration. The spec supports only `claude` and
`codex`.

Future runner types are an explicit extension point. For example,
`ollama` could be added later by extending `CTGPromptRunnerType`,
teaching `CTGPromptServer.createRunner(...)` how to construct the runner,
and adding any stream extraction rules required for
`streamMode = "events"`. No database schema change is required unless
runner type values are constrained in SQLite.

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

Validation:

| Property | Rule |
|---|---|
| `type` | Must be `"claude"` or `"codex"`. |
| `cwd` | When supplied, must be a non-empty string. |
| `args` | When supplied, must be an array of strings. |
| `env` | When supplied, must be an object and is a complete child-process environment replacement. |
| `timeout` | When supplied, must be an integer greater than or equal to `0`. |
| `maxBuffer` | When supplied, must be an integer greater than or equal to `1`. |

When `timeout` is omitted, `CTGPromptServer.createRunner(...)` passes
`600000` milliseconds. When `maxBuffer` is omitted, the server does not
pass `maxBuffer`, allowing the selected runner implementation to use its
own default.

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

Defaults:

| Property | Default |
|---|---|
| `host` | `"127.0.0.1"` |
| `database` | `"prompts.db"` |
| `initDB` | `true` |
| `concurrency` | `1` |
| `maxPromptBytes` | `131071` |
| `streamMode` | `"events"` |
| `keepAliveMs` | `15000` |
| `maxWaitMs` | `30000` |
| `defaultLimit` | `50` |
| `maxLimit` | `200` |

Validation:

| Property | Rule |
|---|---|
| `runner` | Must be a valid `CTGPromptRunnerConfig`. The runner is validated by `CTGPromptServer.init(...)` and constructed by `start(...)`. |
| `apiKey` | Must be a string with at least one non-whitespace character. Missing or empty keys throw `INVALID_CONFIG`; the server must not run open. |
| `host` | When supplied, must be a non-empty string. |
| `database` | When supplied, must be a non-empty string. |
| `initDB` | When supplied, must be a boolean. |
| `concurrency` | When supplied, must be an integer greater than or equal to `1`. |
| `maxPromptBytes` | When supplied, must be an integer in `1..131071`. Larger values are rejected, not clamped. |
| `streamMode` | When supplied, must be `"raw"` or `"events"`. |
| `keepAliveMs` | When supplied, must be an integer greater than or equal to `1000`. |
| `maxWaitMs` | When supplied, must be an integer greater than or equal to `0`. |
| `defaultLimit` | When supplied, must be an integer greater than or equal to `1`. |
| `maxLimit` | When supplied, must be an integer greater than or equal to `1`, and `defaultLimit <= maxLimit` after defaults are applied. |

Invalid configuration throws `INVALID_CONFIG` / `1` during
`CTGPromptServer.init(...)`, except invalid `port`, which is validated
by `start(...)` before the listener is bound.

`CTGPromptStreamMode` is owned by
[CTGPromptServerQueue](./04-CTGPromptServerQueue.md#types). The spec supports
`"raw"` and `"events"`. `"raw"` appends response text from stdout output
chunks; `"events"` appends response text by parsing supported structured
runner events.

### CTGPromptServerResponse

```ts
type CTGPromptServerResponse<TResult> =
    | CTGPromptServerSuccessResponse<TResult>
    | CTGPromptErrorResponse;
```

`CTGPromptServerResponse<TResult>` is the JSON response body shape for
all non-SSE HTTP routes. Successful responses carry a route-specific
payload in `result`; error responses carry only the public error code
and message.

### CTGPromptServerSuccessResponse

```ts
interface CTGPromptServerSuccessResponse<TResult> {
    readonly success: true;
    readonly result: TResult;
}
```

### CTGPromptErrorResponse

```ts
interface CTGPromptErrorResponse {
    readonly success: false;
    readonly result: {
        readonly code: number;
        readonly message: string;
    };
}
```

HTTP JSON routes respond with one of these response bodies. SSE routes
respond with `text/event-stream`, not a JSON response body after the
stream opens.

`CTGPromptErrorResponse` is returned by `CTGPromptServerError.toResponse()`
for every non-SSE route error when JSON can still be sent, including
request validation failures, `METHOD_NOT_ALLOWED`, `NOT_FOUND`, database
failures, and internal errors. Any `CTGPromptServerError` can send this
body through `sendResponse(response)`; base errors default to HTTP `500`,
while request errors use their constructor-assigned `status`. The SSE
route also returns this shape for errors detected before SSE headers are
written, such as an unknown prompt ID.

The response body intentionally excludes error `data`, labels, and HTTP
status. `data` remains available on the in-process error instance for
inspection or logging; HTTP status is sent through the Express response.

### CTGPromptRecord

```ts
interface CTGPromptRecord {
    readonly id: number;
    readonly statusCode: number;
    readonly prompt: string;
    readonly response: string;
    readonly errorCode: number | null;
    readonly errorMessage: string | null;
    readonly runner: CTGPromptRunnerType | null;
    readonly createdAt: number;
    readonly startedAt: number | null;
    readonly finishedAt: number | null;
}
```

`CTGPromptRecord` is the public HTTP projection of the DB-owned
`CTGPromptServerQueueRecord`.

### CTGPromptRecordResponse

```ts
interface CTGPromptRecordResponse
    extends CTGPromptServerSuccessResponse<CTGPromptRecord> {}
```

`CTGPromptRecordResponse` is returned by routes whose successful payload
is one prompt record, such as `POST /prompt`, `GET /prompt/:id`, and
`DELETE /prompt/:id`.

### CTGPromptPageResponse

```ts
interface CTGPromptPageResponse
    extends CTGPromptServerSuccessResponse<{
        readonly records: CTGPromptRecord[];
        readonly nextBefore: number | null;
    }> {}
```

`CTGPromptPageResponse` is returned by `GET /prompts` and
`GET /prompts/:status`. `result.records` is always an array. When no
records match the query, `result.records` is empty and
`result.nextBefore` is `null`.

### CTGPromptSSESink

```ts
type CTGPromptSSESink = {
    write(chunk: string): void;
    end(): void;
    readonly writableEnded?: boolean;
};
```

`CTGPromptSSESink` is the structural sink used by live SSE delivery.
Express responses satisfy this shape. `CTGPromptServer` stores these
sinks in its `_sse` registry, and server-owned SSE helpers accept this
shape when the `/sse/:id` route opens a stream.
