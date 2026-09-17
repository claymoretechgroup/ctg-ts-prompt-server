# ctg-ts-prompt-server

**Status:** proposed architecture specification.

`ctg-ts-prompt-server` is a durable prompt queue service for one
configured `ctg-ai-agent-proc` runner. It exposes prompt submission and
status over HTTP, stores prompt lifecycle state in SQLite, dispatches
work through a queue, and streams live runner output to connected SSE
clients.

This document explains the general architecture and operational flow.
Exact contracts live in the focused spec files:

| Document | Covers |
|---|---|
| [00-shared-types.md](./00-shared-types.md) | Shared types and predicates: the response envelope, `NonEmptyString` |
| [01-CTGPromptServerError.md](./01-CTGPromptServerError.md) | Base error class, code registry, error response body |
| [02-CTGPromptServerRequestError.md](./02-CTGPromptServerRequestError.md) | HTTP request errors with status |
| [03-CTGPromptServerDB.md](./03-CTGPromptServerDB.md) | SQLite access, record shape, pagination |
| [04-CTGPromptServerQueue.md](./04-CTGPromptServerQueue.md) | Prompt lifecycle, dispatch, concurrency, live stream messages |
| [05-CTGPromptServer.md](./05-CTGPromptServer.md) | HTTP, authentication, routes, SSE, long-poll, startup and shutdown |
| [db.md](./db.md) | SQLite schema and maintenance SQL |

Each class document is self-contained: its types follow its class
surface under a `Types` heading. Behavior that spans classes is
specified on the class that owns the observable outcome.

---

## Architecture

The service has five primary runtime boundaries:

| Boundary | Responsibility |
|---|---|
| `CTGPromptServer` | Owns HTTP, authentication, request validation, SSE clients, long-poll waiters, startup, and shutdown. |
| `CTGPromptServerQueue` | Owns prompt validation, durable lifecycle transitions, runner dispatch, concurrency, active runners, and live stream messages. |
| `CTGPromptServerDB` | Owns SQLite access for prompt queue records. It does not know about HTTP, SSE, runners, or live clients. |
| `CTGPromptServerError` | Owns normalized error labels, application error codes, and JSON-safe error results. |
| `CTGPromptServerRequestError` | Owns HTTP status values for request errors. |

The durable unit is a `CTGPromptServerQueueRecord`. The upstream
`ctg-ai-agent-proc` `LLMPrompt` type is a prompt-construction object; it
is not stored by this service. This service stores raw prompt text and
the lifecycle state for one submitted queue record.

Each class document owns the types it declares. Types shared across
classes, and the response envelope, are owned by
[00-shared-types.md](./00-shared-types.md).

---

## Data Model

SQLite is the durable source of truth for submitted prompts. The
schema contains one `prompts` table and one claim/list index; the exact
DDL is defined in [db.md](./db.md).

Prompt records move through five lifecycle states:

| State | Code | Terminal | Meaning |
|---|---:|---|---|
| `PENDING` | `1` | no | The prompt has been accepted and is waiting to be claimed. |
| `ACTIVE` | `2` | no | The queue claimed the prompt and has an active runner. |
| `DONE` | `3` | yes | The runner completed successfully. |
| `ERROR` | `-1` | yes | The prompt failed with a stored prompt failure code. |
| `CANCELLED` | `5` | yes | The prompt was cancelled before being claimed. |

The database stores numeric prompt status codes and integer application
error codes. Queue status codes are defined by `CTGPromptServerQueue.STATUS`;
all supported error labels and error codes are defined by
`CTGPromptServerError.CODE`.

The schema does not store per-event stream history. Live
SSE messages are delivered by `CTGPromptServer`; reconnecting clients
recover current prompt state through `GET /prompt/:id`.

---

## Runtime Flow

### Startup

`CTGPromptServer.init(config)` validates configuration enough to build
the server object and open the database. It does not bind the listener or
start queue processing.

`server.start(port)` performs runtime startup:

1. Construct the configured runner.
2. Construct `CTGPromptServerQueue`.
3. Recover records left `ACTIVE` by a previous process by marking them
   interrupted.
4. Start queue processing.
5. Bind the HTTP listener.

Recovery runs before new claims so stale active records cannot be
silently rerun.

### Submission

`POST /prompt` submits raw prompt text. The server validates the request
envelope and delegates prompt validation to `CTGPromptServerQueue.submit(...)`.

The queue:

1. Validates that the prompt is a non-empty string within
   `maxPromptBytes`.
2. Persists a pending record with `CTGPromptServerDB.create(...)`.
3. Emits a live `pending` stream message.
4. Queues work if processing is started.
5. Returns the created `CTGPromptServerQueueRecord`.

Prompt text is stored and executed byte-for-byte as submitted.

### Dispatch

`CTGPromptServerQueue` owns scheduling and concurrency. While active runner
count is below `concurrency`, it claims pending records with
`CTGPromptServerDB.claimNext()` and starts runner execution through its
queue-owned agent workflow.

Claiming is atomic and FIFO by prompt ID. Cancellation and claiming must
not both win for the same row.

### Running

For each claimed record, the queue starts `runner.run(record.prompt,
...)`, creates an `ActiveRunner`, and stores it by prompt ID. A
synchronous throw from `runner.run(...)` is normalized into a rejected
runner result promise.

Runner stream events are converted into live stream messages:

| Source event | Live message |
|---|---|
| `LLMRunnerOutputEvent` | `output` |
| structured event with `payload` | `stream` |
| other stream event | `stream` with raw payload |

For `streamMode = "raw"`, stdout chunks contribute to the stored
response. For `streamMode = "events"`, supported Claude or Codex
assistant text contributes to the stored response. Response fragments are
persisted with `CTGPromptServerDB.append(...)` before the corresponding live
message is emitted.

### Finish

When the runner settles, `CTGPromptServerQueue` writes one terminal outcome:

| Outcome | Stored status | Error code |
|---|---|---|
| Success | `DONE` / `3` | none |
| Runner failure | `ERROR` / `-1` | `RUNNER_FAILED` / `4` |
| Database failure | `ERROR` / `-1` | `DATABASE_FAILED` / `3` |
| Internal service failure | `ERROR` / `-1` | `INTERNAL_ERROR` / `2` |
| Startup recovery interruption | `ERROR` / `-1` | `PROMPT_INTERRUPTED` / `5` |
| Unknown caught failure | `ERROR` / `-1` | `UNKNOWN_ERROR` / `15` |

After a terminal outcome, the queue emits the terminal live message,
removes the active runner, notifies the server that the prompt finished,
and attempts to claim more work if processing is still started.

### Cancellation

`DELETE /prompt/:id` cancels only pending records. Unknown records return
`PROMPT_NOT_FOUND`; active or terminal records return
`CANCEL_NOT_ALLOWED`.

Successful cancellation is durable, emits a `cancelled` live message, and
wakes any server-owned waiters for that prompt.

### Reads And Pagination

`GET /prompt/:id` reads the current durable prompt record. With
`?wait=<ms>`, the server long-polls until the prompt reaches a terminal
state or the clamped wait duration elapses.

`GET /prompts` and `GET /prompts/:status` list records newest first with
cursor pagination. Pagination details and record shape are owned by
`CTGPromptServerDB` and its types.

### SSE

`GET /sse/:id` opens an SSE stream for live prompt messages.
`CTGPromptServer` owns response sinks, keep-alive comments, client
disconnect handling, and terminal stream closure.

Because the spec does not persist event history, SSE is live-only.
Clients that reconnect should read the durable prompt record to recover
current state.

### Shutdown

`server.close()` stops accepting HTTP work, closes open SSE streams,
stops queue processing, and closes the database. Queue shutdown disables
new claims and does not wait for active runner results to settle. Active
child processes may continue or be terminated by their runner/process
environment; rows left `ACTIVE` are marked interrupted by the next
`server.start(...)` recovery pass.

---

## Error Model

The spec separates five error domains:

1. Request errors reject an HTTP request.
2. Database errors originate from durable storage operations.
3. Runner errors originate from the configured upstream `LLMRunner`.
4. Prompt errors are terminal prompt states stored on durable prompt
   records.
5. Internal errors report invalid configuration or unexpected service
   failures.

`CTGPromptServerError` is the normalized error class. It sends the
standard error response body through `sendResponse(response)`. HTTP-facing request
errors are represented by `CTGPromptServerRequestError`, which adds the
`status` instance field. Runner, database, prompt, and internal errors
derive labels from `CTGPromptServerError.CODE`; prompt error codes are
stored on prompt records when `statusCode = -1`.

Every HTTP JSON response uses the standard envelope:

```json
{ "success": true, "result": {} }
```

Errors use:

```json
{ "success": false, "result": { "code": 10, "message": "Invalid query." } }
```

The exact HTTP-facing error and prompt failure tables belong to
[CTGPromptServerError](./01-CTGPromptServerError.md#types).

---

## Operational Model

One server process owns one database file. SQLite WAL supports concurrent
readers, but the spec does not define multiple active service workers
claiming from the same database.

Bearer authentication is the HTTP protection boundary. Every route
requires `Authorization: Bearer <apiKey>`.

Runner configuration describes one configured runner for the server. The
service does not expose per-request runner choice, a runner registry, or
prompt templating.

Operational limits are fixed or configured as follows:

| Limit | Value |
|---|---|
| JSON request body limit | Fixed `1 MiB` / `1,048,576` bytes. |
| Prompt text limit | `maxPromptBytes`, default `131071`, configurable only within `1..131071`. |
| Runner timeout | `runner.timeout`, default `600000` milliseconds. |
| Runner max buffer | `runner.maxBuffer` when supplied; otherwise the selected runner's own default. |
| SSE keep-alive cadence | `keepAliveMs`, default `15000` milliseconds, minimum `1000`. |
| Long-poll wait ceiling | `maxWaitMs`, default `30000` milliseconds. Route `wait` values above this are clamped. |
| Pagination default page size | `defaultLimit`, default `50`. |
| Pagination maximum page size | `maxLimit`, default `200`. |

Configuration validation and defaults are specified in
[CTGPromptServer](./05-CTGPromptServer.md#types).

Maintenance operations are script-level operations over the SQLite
database:

| Operation | Behavior |
|---|---|
| purge finished | Delete terminal records. |
| purge all | Delete every prompt record. |
| reset schema | Drop and recreate the schema. |

Maintenance SQL is specified in [db.md](./db.md). Destructive
maintenance is intended for a stopped server.

---

## Not Supported

The spec intentionally does not define:

1. Multiple runner registry.
2. Per-request runner choice.
3. Prompt templates.
4. Metrics routes.
5. Health routes.
6. Durable per-event stream history.
7. Multiple active service workers sharing one queue database.
8. Graceful drain shutdown that waits for active runners to finish.

---

## Conformance

Tests are derived directly from the class documents. Every requirement
row in a class document carries an ID and has at least one test.
