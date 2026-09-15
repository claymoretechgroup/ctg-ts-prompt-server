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

Spec2 routes are Express routes. All routes require
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
`UNAUTHORIZED` / `6`.

### POST /prompt

`POST /prompt` requires `Content-Type: application/json`.

Request body:

```json
{ "prompt": "raw prompt text" }
```

The body must be a JSON object with a `prompt` property. Extra
properties are ignored. The route delegates prompt validation to
`CTGPromptServerQueue.submit(...)` and returns the created
`CTGPromptServerQueueRecord` in a success response with status `202`.

Malformed JSON or invalid body shape throws `INVALID_BODY`.
Non-JSON content type throws `INVALID_CONTENT_TYPE`.

### GET /prompt/:id

`GET /prompt/:id` parses `:id` as a base-10 integer. A malformed ID
throws `INVALID_QUERY` before any prompt lookup.

Without `wait`, the route reads the current prompt record and returns it
immediately.

With `?wait=<ms>`, `wait` must be a base-10 integer greater than or
equal to zero. The server long-polls until the prompt becomes terminal or
the clamped wait duration elapses, then returns the current prompt
record either way. The route never returns `202` for an elapsed wait; it
returns `200` with the current record state.

Unknown IDs throw `PROMPT_NOT_FOUND`.

### DELETE /prompt/:id

`DELETE /prompt/:id` parses `:id` as a base-10 integer and delegates to
`CTGPromptServerQueue.cancel(id)`.

Unknown IDs throw `PROMPT_NOT_FOUND`. Active or terminal prompts throw
`CANCEL_NOT_ALLOWED`.

### GET /sse/:id

`GET /sse/:id` parses `:id` as a base-10 integer and confirms the prompt
exists before opening the SSE stream. Unknown IDs return a JSON
`PROMPT_NOT_FOUND` response; no SSE headers are written.

Once open, the response uses:

```text
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

Spec2 SSE is live-only. The route does not replay durable event history,
and `Last-Event-ID` is not part of the spec2 contract. Clients that
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

Invalid `limit` or `before` values throw `INVALID_QUERY`.

### GET /prompts/:status

`GET /prompts/:status` behaves like `GET /prompts` with a lifecycle
status filter. Supported status segments are `pending`, `active`,
`done`, `error`, and `cancelled`.

Unknown status values throw `INVALID_QUERY`.

### Fallbacks

If a path matches a supported route with the wrong HTTP method, return
`METHOD_NOT_ALLOWED`. If no route path matches, return `NOT_FOUND`.

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

1. Reject invalid ports with `INVALID_CONFIG`.
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
long-poll waiters, stops the queue, and closes the database.

Shutdown order:

1. Mark the server closed.
2. Stop the HTTP listener when it exists.
3. Close all live SSE sinks.
4. Resolve all long-poll waiters.
5. Stop the queue when it exists.
6. Close the database.

`close()` is idempotent.

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
