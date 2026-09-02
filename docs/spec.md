# ctg-ts-prompt-server v1.0 — Specification

**Target:** TypeScript (ES modules, Node.js 22.22, `strict: true`)
**Code style:** `ctg-spec-ops/code-styles/typescript-code-style.md`
**Upstream artifact:** there is no design doc. The decision list D1–D10
and the behavioral model **M** (§1) are the upstream layer, and every
`realizes:` back-pointer in this document names one of them. See
`ctg-spec-ops/INCIDENTS.md`, Stage 2, 2026-09-02 — the design-doc layer
was deliberately skipped because every decision in this project is bound
to its host.

**Dependencies:** `express`, `ctg-ai-agent-proc`
(`github:claymoretechgroup/ctg-ai-agent-proc`), and Node built-ins.
Nothing else. `ctg-js-test` is a dev dependency.

This document is the authoritative description of what
`ctg-ts-prompt-server` is and how it behaves. If a method, field, route,
column, or behavior is not described here, it does not exist.

---

## 1. The Model

*realizes: M*

`ctg-ts-prompt-server` is a **durable job service that exposes one LLM
runner over HTTP.**

A **job** is a prompt waiting its turn on the server's runner. A client
submits a prompt; the server stores the job and answers immediately with
a job id. Nothing about the run happens on the submitting request.

A **run** happens when a concurrency slot is free. The server passes the
job's prompt to the configured `LLMRunner` and writes **every event the
runner emits** into an events table, each row carrying a per-job
sequence number that is monotonic and gap-free.

**The events table is the durable stream.** It is not a log kept
alongside a stream; it is the stream, and Server-Sent Events is one
projection of it. Three consequences, and they are the point of the
design:

| A subscriber arrives… | receives |
|---|---|
| before the job runs | nothing yet, then the whole run live, then the stream closes |
| mid-run | the history so far, then the live tail, then the stream closes |
| after the job finished | the full history, then the stream closes immediately |
| reconnecting with `Last-Event-ID: n` | every event after sequence `n`, then as above |

**The SQLite database is the queue.** It is not a mirror of an in-memory
queue that happens to be persisted. A queued job exists only as a row
with `status = 'queued'`; the dispatcher's only source of work is that
table. There is no in-memory list of pending jobs, and losing the
process loses nothing but the child processes that were mid-run.

**Job lifecycle:**

```
queued ──▶ running ──▶ succeeded
   │           └─────▶ failed
   └──────────────────▶ cancelled
```

Lifecycle transitions are themselves rows in the events table. The
stream therefore carries runner output and job state changes in **one
sequence**, so a subscriber never has to reconcile two orderings.

**Domain vocabulary used throughout, and nothing beyond it:** job,
event, sequence, queue, dispatcher, runner, store, subscriber, prompt,
result.

---

## 2. Component Map

| Responsibility | TypeScript realization | Owns |
|---|---|---|
| Durable jobs, events, sequence allocation, purge | `CTGJobStore` | the `node:sqlite` database |
| Dispatch, concurrency limit, running the runner, recording events | `CTGJobQueue` | the `LLMRunner` instance |
| Bridging committed events to open responses | `CTGJobSubscribers` | open SSE sinks |
| HTTP routes, auth check, envelopes | `CTGJobApp` | the Express application |
| Config validation, wiring, lifecycle | `CTGJobServer` | all of the above |
| Typed errors | `CTGJobError` | — |

Dependency direction is one way: `CTGJobServer` → `CTGJobApp` →
`CTGJobQueue` → (`CTGJobStore`, `CTGJobSubscribers`). `CTGJobStore` knows
nothing about subscribers, HTTP, or the runner; it is a database. This
is the decomposition D-nothing forced, so it is Judgment Call 1.

---

## 3. Public Surface

Every public class in full, before any prose about it.

```typescript
class CTGJobServer {
    static init(config: CTGJobServerConfig): CTGJobServer;

    readonly app: Express;
    readonly store: CTGJobStore;
    readonly queue: CTGJobQueue;

    listen(port: number, host?: string): Promise<void>;
    close(): Promise<void>;
    purgeDone(): number;
}

class CTGJobQueue {
    static init(config: CTGJobQueueConfig): CTGJobQueue;

    submit(prompt: string): JobRecord;
    cancel(id: string): JobRecord;
    read(id: string): JobRecord;
    list(query: JobListQuery): JobListPage;
    subscribe(id: string, sink: CTGJobEventSink, afterSequence: number): CTGJobSubscription;

    recover(): number;
    dispatch(): void;
    drain(): Promise<void>;
}

class CTGJobStore {
    static init(config: CTGJobStoreConfig): CTGJobStore;

    insertJob(id: string, prompt: string): JobRecord;
    readJob(id: string): JobRecord | undefined;
    listJobs(query: JobListQuery): JobListPage;

    claimNextQueued(): ClaimedJob | undefined;
    finishJob(id: string, outcome: JobOutcome): AppendedEvent;
    cancelQueued(id: string): AppendedEvent;
    failInterrupted(): AppendedEvent[];

    appendEvent(id: string, name: EventName, payload: unknown): AppendedEvent;
    readEvents(id: string, afterSequence: number): EventRecord[];
    lastSequence(id: string): number;

    purgeDone(): number;
    close(): void;
}

class CTGJobSubscribers {
    static init(): CTGJobSubscribers;

    add(id: string, sink: CTGJobEventSink): CTGJobSubscription;
    publish(id: string, event: EventRecord): void;
    closeJob(id: string): void;
    closeAll(): void;
    count(id: string): number;
}

class CTGJobApp {
    static init(config: CTGJobAppConfig): Express;
}

class CTGJobError extends Error {
    static readonly TYPES: Readonly<Record<string, number>>;

    readonly type: JobErrorType;
    readonly msg: string;
    readonly data: Readonly<Record<string, unknown>>;
    readonly status: number;

    constructor(type: JobErrorType, msg: string, data?: Record<string, unknown>);

    toResult(): { type: string; code: number; message: string };

    static is(value: unknown): value is CTGJobError;
    static isType(type: string): boolean;
    static codeOf(type: JobErrorType): number;
    static statusOf(type: JobErrorType): number;
}
```

### 3.1 Types

```typescript
type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

type EventName =
    | "queued" | "running" | "succeeded" | "failed" | "cancelled"
    | "output" | "stream";

type StreamMode = "raw" | "events";

interface JobRecord {
    readonly id: string;                 // crypto.randomUUID()
    readonly submission: number;         // FIFO ordinal; never reused
    readonly status: JobStatus;          // current lifecycle state
    readonly prompt: string;             // exactly what the client sent
    readonly result: string | null;      // LLMRunnerResult.result, on success only
    readonly error: string | null;       // stderr on success; failure message on failure
    readonly errorType: string | null;   // LLMRunnerError.type, or "INTERRUPTED"
    readonly lastSequence: number;       // highest event sequence written for this job
    readonly createdAt: number;          // epoch ms at submission
    readonly startedAt: number | null;   // epoch ms when claimed
    readonly finishedAt: number | null;  // epoch ms at terminal transition
}

interface EventRecord {
    readonly jobId: string;              // owning job
    readonly sequence: number;           // per-job, starts at 1, gap-free, monotonic
    readonly name: EventName;            // SSE event name
    readonly payload: unknown;           // parsed JSON payload (§7.2)
    readonly createdAt: number;          // epoch ms at append
}

interface AppendedEvent {
    readonly job: JobRecord;             // job as of the commit that wrote the event
    readonly event: EventRecord;         // the event written
}

interface ClaimedJob {
    readonly job: JobRecord;             // job now in "running"
    readonly event: EventRecord;         // the "running" lifecycle event
}

interface JobOutcome {
    readonly status: "succeeded" | "failed";  // terminal state to record
    readonly result?: string;                 // stdout, on success
    readonly error?: string;                  // stderr on success; message on failure
    readonly errorType?: string;              // failure classification
    readonly errorData?: unknown;             // LLMRunnerError.data, on failure
}

interface JobListQuery {
    readonly status?: JobStatus;         // optional filter; omitted means all
    readonly limit?: number;             // 1..maxLimit; default defaultLimit
    readonly before?: number;            // cursor: return submissions strictly below this
}

interface JobListPage {
    readonly jobs: JobRecord[];          // newest first, by submission descending
    readonly nextBefore: number | null;  // cursor for the next page, or null at the end
}

interface CTGJobEventSink {
    write(chunk: string): void;          // append bytes to the response
    end(): void;                         // close the response
}

interface CTGJobSubscription {
    close(): void;                       // deregister this subscriber; idempotent
}
```

`CTGJobEventSink` is structural. `node:http`'s `ServerResponse`
satisfies it, and so does a test double — no test needs a socket to
exercise `CTGJobSubscribers`.

### 3.2 Configuration

```typescript
interface CTGJobServerConfig {
    runner: LLMRunner;             // the one runner this server exposes — required
    apiKey: string;                // shared key; construction fails if missing or empty
    database?: string;             // SQLite path; default "jobs.db"; ":memory:" permitted
    concurrency?: number;          // max simultaneous runs; default 1
    maxPromptBytes?: number;       // UTF-8 byte cap on prompts; default 65536
    streamMode?: StreamMode;       // runner stream contract; default "events"
    keepAliveMs?: number;          // SSE keep-alive cadence; default 15000
    defaultLimit?: number;         // list page size when unspecified; default 50
    maxLimit?: number;             // largest accepted list limit; default 200
}

interface CTGJobQueueConfig {
    store: CTGJobStore;            // durable job and event storage
    subscribers: CTGJobSubscribers;// live delivery for committed events
    runner: LLMRunner;             // the one runner
    concurrency: number;           // resolved, validated
    maxPromptBytes: number;        // resolved, validated
    streamMode: StreamMode;        // resolved
    defaultLimit: number;          // resolved
    maxLimit: number;              // resolved
}

interface CTGJobStoreConfig {
    database: string;              // SQLite path or ":memory:"
}

interface CTGJobAppConfig {
    queue: CTGJobQueue;            // everything the routes act on
    apiKey: string;                // compared against the request header
    keepAliveMs: number;           // SSE keep-alive cadence
}
```

`CTGJobServer.init` is the only place defaults are applied. Every
downstream config is fully resolved — no `?` fields, no second defaulting
site, no way for two components to disagree about what the concurrency
limit is. *realizes: D7, D8, D10*

---

## 4. CTGJobServer

*realizes: D1, D2, D7, D8, D10*

The entry point. Validates config, opens the store, recovers interrupted
jobs, builds the queue and the Express app, and starts dispatching.

| Operation | Signature | Description | Mutates |
|---|---|---|---|
| `init` | `ctgJobServerConfig -> ctgJobServer` | Validate config, wire components, run recovery, dispatch once | Database: interrupted jobs failed (§4.2) |
| `app` | `GETTER :: VOID -> express` | The configured Express application | |
| `store` | `GETTER :: VOID -> ctgJobStore` | The store, exposed for tests and the purge script | |
| `queue` | `GETTER :: VOID -> ctgJobQueue` | The dispatcher | |
| `listen` | `NUMBER, STRING? -> PROMISE(VOID)` | Bind and start accepting requests | Binds a socket |
| `close` | `VOID -> PROMISE(VOID)` | Stop listening, close SSE responses, close the database | Closes socket, subscribers, database |
| `purgeDone` | `VOID -> NUMBER` | Delete terminal jobs and their events; returns jobs deleted | Database: rows deleted |

### 4.1 Construction

`init` performs these steps in order. Any failure throws
`CTGJobError("INVALID_CONFIG")` and nothing is opened.

1. `runner` must be an instance of `LLMRunner` (`ctg-ai-agent-proc`).
2. `apiKey` must be a string with at least one non-whitespace
   character. **A missing or empty key is a startup failure, not a
   warning** — the server must refuse to start rather than run open.
   *realizes: D10*
3. `concurrency`, when supplied, must be an integer `>= 1`.
4. `maxPromptBytes`, when supplied, must be an integer `>= 1`.
5. `keepAliveMs`, when supplied, must be an integer `>= 1000`.
6. `defaultLimit` and `maxLimit`, when supplied, must be integers
   `>= 1`, and `defaultLimit <= maxLimit`.
7. `streamMode`, when supplied, must be `"raw"` or `"events"`.
8. `database`, when supplied, must be a non-empty string.
9. Open `CTGJobStore` (creates the schema if absent, §6.1).
10. Build `CTGJobSubscribers` and `CTGJobQueue`.
11. Call `queue.recover()` (§4.2).
12. Build the Express app via `CTGJobApp.init`.
13. Call `queue.dispatch()`.

Note step 13: **jobs left `queued` by a previous process start running
as soon as the new process constructs the server, before it listens.**
That is what "the database is the queue" means operationally.

> **Judgment Call 2 — recovery and the first dispatch happen in `init`,
> not in `listen`.** A server that has been constructed is a server that
> is working through its queue. Deferring to `listen` would make an
> un-listened server a silent hold on queued work, and would make the
> purge script's construction subtly different from the service's.

> **Judgment Call 3 — `store` and `queue` are public getters.** The
> purge script needs `purgeDone`, and tests need to assert on stored rows
> without going through HTTP. D8 requires the purge operation to be a
> public method for exactly this reason; exposing the two components it
> sits on is the same argument.

### 4.2 Restart semantics

*realizes: D5*

`queue.recover()` runs once, in `init`, in a single transaction:

1. Select every job with `status = 'queued'`. **Do nothing to them.**
   They remain queued and are eligible for dispatch.
2. Select every job with `status = 'running'`. For each, in submission
   order:
   a. Set `status = 'failed'`, `error_type = 'INTERRUPTED'`,
      `error = 'Job was running when the server stopped.'`,
      `finished_at = <now>`.
   b. Append a `failed` event with payload
      `{ jobId, status: "failed", errorType: "INTERRUPTED", message, finishedAt }`.
3. Return the count of jobs failed.

Nothing is re-run. Resubmission is the client's decision, and the
client learns of the interruption through the job's terminal state and
its final event like any other failure.

> **Judgment Call 4 — `INTERRUPTED` is an `errorType` on the job row,
> not a sixth `JobStatus`.** The lifecycle in §1 has five states and a
> new one would change the model. An interrupted job *is* a failed job;
> `errorType` is already the field that says why a job failed, and
> `INTERRUPTED` sits there alongside `LLMRunnerError`'s
> `COMMAND_NOT_FOUND` and `COMMAND_FAILED` without inventing a state.

### 4.3 Shutdown

`close()`:

1. Stop the HTTP listener and wait for it to close.
2. `subscribers.closeAll()` — every open SSE response is ended.
3. `store.close()`.

`close()` does **not** wait for running jobs. Their child processes are
orphaned exactly as in an unexpected stop, and the next `init` fails
them as interrupted. `queue.drain()` exists for tests that want to wait
for in-flight runs to settle; the service itself never calls it.

---

## 5. CTGJobQueue

*realizes: M, D1, D4, D5, D6, D7*

Owns the runner, the concurrency limit, and the dispatch procedure. It
is the only component that calls `runner.run`, and the only component
that writes events during a run.

| Operation | Signature | Description | Mutates |
|---|---|---|---|
| `init` | `ctgJobQueueConfig -> ctgJobQueue` | Wire store, subscribers, runner | |
| `submit` | `STRING:prompt -> jobRecord` | Validate the prompt, insert a queued job, append `queued`, dispatch | Database: one job row, one event row; may start a run |
| `cancel` | `STRING:id -> jobRecord` | Cancel a **queued** job | Database: job row status, one event row |
| `read` | `STRING:id -> jobRecord` | Read one job | |
| `list` | `jobListQuery -> jobListPage` | Page of jobs, newest first | |
| `subscribe` | `STRING:id, ctgJobEventSink, NUMBER:afterSequence -> ctgJobSubscription` | Replay history then attach live (§7.3) | Registers a subscriber |
| `recover` | `VOID -> NUMBER` | Fail jobs left running by a previous process (§4.2) | Database: job rows, event rows |
| `dispatch` | `VOID -> VOID` | Start runs until the concurrency limit is reached (§5.3) | Database: claimed jobs; spawns child processes |
| `drain` | `VOID -> PROMISE(VOID)` | Resolve when no run is in flight | |

### 5.1 submit

*realizes: D1, D4, D8*

`submit :: STRING:prompt -> jobRecord`

1. If `prompt` is not a string, throw
   `CTGJobError("INVALID_PROMPT", "Prompt must be a string.")`.
2. If `prompt.trim() === ""`, throw
   `CTGJobError("INVALID_PROMPT", "Prompt must not be empty.")`. This
   covers both the empty string and whitespace-only input.
3. Compute `bytes = Buffer.byteLength(prompt, "utf8")`. If
   `bytes > maxPromptBytes`, throw
   `CTGJobError("INVALID_PROMPT", "Prompt exceeds the maximum of <maxPromptBytes> bytes.", { bytes, maxPromptBytes })`.
   The message names the limit.
4. Generate `id = crypto.randomUUID()`.
5. `store.insertJob(id, prompt)` — inserts the job with
   `status = 'queued'` and appends a `queued` event, in one transaction.
6. `subscribers.publish(id, event)`.
7. `dispatch()`.
8. Return the job record.

The prompt is stored **byte-for-byte as received** and passed to
`runner.run()` unchanged. There is no template, no wrapping, no
trimming of the stored value, and no client-supplied `LLMPrompt`
operation. *realizes: D4*

> **Judgment Call 5 — whitespace-only prompts are rejected.** D8 names
> the empty string. A prompt of `"   \n"` is the same submission mistake
> with a different byte count, and `LLMRunner` will happily hand it to a
> CLI as an argv element. Rejecting it costs a `trim()` and prevents a
> class of accidental jobs. Note that this is a *validation* trim only —
> the stored and executed prompt is the untrimmed original.

> **Judgment Call 6 — the byte limit is measured in UTF-8 bytes, not
> characters.** D8 states the limit in bytes and gives the reason: the
> Linux single-argv-element limit is 131072 bytes and `LLMRunner` passes
> the prompt as one argv element. A character count would not bound the
> thing that actually breaks.

### 5.2 cancel

*realizes: D6*

`cancel :: STRING:id -> jobRecord`

Detection order, and it matters:

1. `store.readJob(id)`. If undefined, throw
   `CTGJobError("JOB_NOT_FOUND")`.
2. If `status === "running"`, throw
   `CTGJobError("CANCEL_NOT_ALLOWED", "A running job cannot be cancelled.", { id, status })`.
3. If `status` is `succeeded`, `failed`, or `cancelled`, throw
   `CTGJobError("CANCEL_NOT_ALLOWED", "Job is already in a terminal state.", { id, status })`.
4. `store.cancelQueued(id)` — a conditional update
   (`WHERE id = ? AND status = 'queued'`) plus a `cancelled` event, in
   one transaction. If the update affected zero rows, the job changed
   state between step 1 and step 4; throw `CANCEL_NOT_ALLOWED` with the
   re-read status.
5. `subscribers.publish(id, event)`, then `subscribers.closeJob(id)` —
   `cancelled` is terminal, so every open stream for this job ends.
6. Return the job record.

Step 4's conditional update is not defensive noise: it is what makes
cancel and `claimNextQueued` mutually exclusive without a lock. A job is
either claimed or cancelled, never both, because both are
`WHERE status = 'queued'` updates and SQLite serializes them.

A running job runs to completion, or to the runner's `timeout`. There is
no abort path in v1 (§10).

### 5.3 The dispatch procedure

*realizes: D7, M*

This is the correctness core. `dispatch()` is **synchronous** and takes
no arguments. `_active` is a `Set<string>` of job ids currently running.

1. Repeat until step 2 or step 3 exits:
2. If `_active.size >= concurrency`, return.
3. Call `store.claimNextQueued()`. If it returns `undefined` — no queued
   job exists — return.
4. Add `claimed.job.id` to `_active`. **This happens synchronously,
   before any `await` or promise creation.**
5. `subscribers.publish(job.id, claimed.event)` — the `running`
   lifecycle event.
6. Call `this._execute(claimed.job)`. `_execute` is `async`, so calling
   it returns a promise; **the promise is not awaited here.** Attach:
   ```
   promise.finally(() => { this._active.delete(job.id); this.dispatch(); })
   ```
7. Continue the loop from step 2.

Three properties, each following from a specific step:

- **Never more than the limit.** `_active` grows in step 4 with no
  intervening suspension point, and step 2 tests it before every claim.
  Node's single thread cannot interleave another `dispatch()` between
  steps 2 and 4, because there is no `await` between them.
- **Never the same job twice.** `claimNextQueued` flips the row to
  `running` in the same transaction that reads it (§6.3). A second claim
  cannot see it as queued, whether that claim comes from the same loop
  iteration, a later `dispatch()`, or the recovery path.
- **A synchronously-throwing runner does not wedge the queue.**
  `_execute` is declared `async`, so a synchronous throw inside
  `runner.run` becomes a rejection of `_execute`'s promise, which
  `_execute`'s own `try`/`catch` (§5.4 step 3) handles as a job failure.
  Even if `_execute` itself threw, step 6's `.finally()` still removes
  the id and re-dispatches — the queue keeps moving.

`dispatch()` is called from exactly four places: `init` (step 13),
`submit` (step 7), the `.finally()` in step 6, and tests.

> **Judgment Call 7 — `_active` is a set of ids, not a counter.** A
> counter would prove the limit but not the no-double-dispatch property.
> The set makes `count`, `has`, and the drain condition all directly
> observable, and an id appearing twice is a detectable bug rather than
> an invisible increment.

### 5.4 Running a job

*realizes: M, D1, D4*

`_execute :: jobRecord -> PROMISE(VOID)`. Steps, in order:

1. Build the stream handler:
   ```
   onStream = (event: LLMRunnerStreamEvent) => this._recordStreamEvent(job.id, event)
   ```
2. Call:
   ```
   runner.run(job.prompt, {
       streamOutput: true,
       streamMode: this._streamMode,
       onStream
   })
   ```
   Nothing else is passed. No per-run `args`, no runner selection, no
   prompt transformation. *realizes: D1, D4*
3. `await` the call inside `try`/`catch`.
4. **On resolution** with `LLMRunnerResult { result, error }`:
   a. `store.finishJob(job.id, { status: "succeeded", result, error })`
      — sets the job row's `result`, `error`, `finished_at`, and
      `status`, and appends a `succeeded` event, in one transaction.
   b. `subscribers.publish`, then `subscribers.closeJob(job.id)`.
5. **On rejection** with `cause`:
   a. Classify, in this order:
      - `LLMRunnerError.is(cause)` → `errorType = cause.type` (one of
        `INVALID_OPTIONS`, `COMMAND_NOT_FOUND`, `COMMAND_FAILED`),
        `error = cause.msg`, `errorData = cause.data`.
      - `cause instanceof Error` → `errorType = "RUNNER_THREW"`,
        `error = cause.message`.
      - otherwise → `errorType = "RUNNER_THREW"`,
        `error = String(cause)`.
   b. `store.finishJob(job.id, { status: "failed", error, errorType, errorData })`.
   c. `subscribers.publish`, then `subscribers.closeJob(job.id)`.

Note what step 4 preserves: on success, `LLMRunnerResult.result` becomes
the job's `result` and `LLMRunnerResult.error` — the runner's stderr —
becomes the job's `error`. **A successful job can have a non-empty
`error`.** That is the upstream contract (`ctg-ai-agent-proc` §2.2,
RUN-06: the result has exactly the keys `result` and `error`, being
stdout and stderr), and this spec does not reinterpret it. The job's
`errorType` is what distinguishes success from failure, together with
`status`.

> **Judgment Call 8 — `streamOutput: true` always, on every run.**
> `LLMRunner` defaults to the buffered `execFile` path, which emits no
> events and settles only at exit. This service's entire value is the
> event stream, so the streaming `spawn` path is not an option, it is the
> only path. The cost, taken deliberately: the `spawn` path implements
> `timeout` and `maxBuffer` itself rather than delegating to `execFile`,
> which is a smaller amount of upstream code exercised.

> **Judgment Call 9 — `streamMode` defaults to `"events"`, with
> `"raw"` available at construction.** `"events"` makes `ClaudeRunner`
> and `CodexRunner` emit their runner-native event classes
> (`ClaudeRunnerEvent`, `CodexRunnerEvent`) parsed from the vendor's
> structured mode, which is strictly more information than raw stdout
> chunks and also gives the runner a reconstructed final result. `"raw"`
> remains selectable because a runner with no structured mode — a bare
> `LLMRunner`, or a future one — emits `LLMRunnerOutputEvent`s and
> nothing else under `"events"`, and an operator running such a runner
> should be able to say so.

> **Judgment Call 10 — the server sets no `timeout` or `maxBuffer` of
> its own.** Both are `LLMRunnerConfig` fields, so they belong to the
> runner instance the operator constructs
> (`ClaudeRunner.init({ timeout: 600000, maxBuffer: 8_000_000 })`).
> Restating them in this server's config would create two owners of one
> value. D8's "the event log size is bounded by the runner's `maxBuffer`;
> the server adds no second cap" is the same rule applied to storage.

---

## 6. CTGJobStore

*realizes: M, D3, D5, D6, D8*

A synchronous store over `node:sqlite`. It knows about jobs, events, and
sequence allocation. It does not know about HTTP, subscribers, or the
runner.

**`node:sqlite` is experimental in Node 22 and emits an
`ExperimentalWarning` on import.** This is accepted (D3). No flag is
set, and the warning is not suppressed — suppressing it would hide the
same warning class from anything else in the process.

| Operation | Signature | Description | Mutates |
|---|---|---|---|
| `init` | `ctgJobStoreConfig -> ctgJobStore` | Open the database, apply pragmas, create the schema | Creates tables and indexes if absent |
| `insertJob` | `STRING:id, STRING:prompt -> jobRecord` | Insert a queued job and its `queued` event | One job row, one event row |
| `readJob` | `STRING:id -> jobRecord?` | Read one job, or undefined | |
| `listJobs` | `jobListQuery -> jobListPage` | Page of jobs by submission descending | |
| `claimNextQueued` | `VOID -> claimedJob?` | Claim the oldest queued job (§6.3) | One job row to `running`, one event row |
| `finishJob` | `STRING:id, jobOutcome -> appendedEvent` | Record a terminal outcome and its event | One job row, one event row |
| `cancelQueued` | `STRING:id -> appendedEvent` | Move a queued job to `cancelled` | One job row, one event row |
| `failInterrupted` | `VOID -> [appendedEvent]` | Fail every `running` job as `INTERRUPTED` | N job rows, N event rows |
| `appendEvent` | `STRING:id, EVENT_NAME, UNKNOWN -> appendedEvent` | Append one event at the next sequence | One event row, job's `next_sequence` |
| `readEvents` | `STRING:id, NUMBER:afterSequence -> [eventRecord]` | Events with `sequence > afterSequence`, ascending | |
| `lastSequence` | `STRING:id -> NUMBER` | Highest sequence written for the job; 0 if none | |
| `purgeDone` | `VOID -> NUMBER` | Delete terminal jobs and their events (§6.6) | Rows deleted |
| `close` | `VOID -> VOID` | Close the database handle | Closes the handle |

### 6.1 Schema

```sql
CREATE TABLE IF NOT EXISTS jobs (
    submission    INTEGER PRIMARY KEY AUTOINCREMENT,
    id            TEXT    NOT NULL UNIQUE,
    status        TEXT    NOT NULL,
    prompt        TEXT    NOT NULL,
    result        TEXT,
    error         TEXT,
    error_type    TEXT,
    error_data    TEXT,
    next_sequence INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL,
    started_at    INTEGER,
    finished_at   INTEGER
);

CREATE TABLE IF NOT EXISTS events (
    job_id     TEXT    NOT NULL,
    sequence   INTEGER NOT NULL,
    name       TEXT    NOT NULL,
    payload    TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (job_id, sequence)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS jobs_status_submission
    ON jobs (status, submission);
```

Column notes, because each one is load-bearing:

| Column | Why it is shaped this way |
|---|---|
| `jobs.submission` | `INTEGER PRIMARY KEY AUTOINCREMENT`, so SQLite draws from `sqlite_sequence` and **never reuses an ordinal after a delete**. Plain `rowid` would reuse the highest value after `purge-done` removes it, and a new job could then sort ahead of an older queued one. FIFO correctness depends on this. |
| `jobs.id` | `TEXT NOT NULL UNIQUE` — the client-facing identifier, a `crypto.randomUUID()`. The UNIQUE constraint is also the lookup index. |
| `jobs.next_sequence` | The per-job sequence allocator. Reading and incrementing it inside the append transaction is what makes sequences gap-free and monotonic (§6.2). |
| `jobs.error_data` | JSON text, or NULL. Carries `LLMRunnerError.data` so a failure's diagnostics (`exitCode`, `signal`, partial `stdout`/`stderr`) survive. |
| `events` `WITHOUT ROWID` | The primary key `(job_id, sequence)` is the only access path — replay is always "this job, above this sequence". A rowid would be dead weight on the table this service writes most. |
| `jobs_status_submission` | Serves `claimNextQueued` (`status = 'queued' ORDER BY submission`), the status-filtered list, and `failInterrupted`. |

**Pragmas applied at open, in this order:**

1. `PRAGMA journal_mode = WAL;` — a subscriber replaying history reads
   while the dispatcher writes.
2. `PRAGMA foreign_keys = ON;` — no foreign keys are declared today, but
   the pragma is per-connection and free, so a later schema does not
   depend on remembering it.
3. `PRAGMA busy_timeout = 5000;` — the purge script is a second
   connection to the same file.

> **Judgment Call 11 — no foreign key from `events.job_id` to
> `jobs.id`.** `events` is `WITHOUT ROWID` and keyed on `job_id`, so
> cascade deletion is already a single indexed `DELETE`, and the purge
> (§6.6) does both deletes in one transaction. A declared FK would buy
> enforcement the store's own transactions already provide, at the cost
> of a constraint on `jobs.id` that must stay UNIQUE for reasons other
> than its own.

### 6.2 Sequence allocation

*realizes: M*

Every event insert runs this, inside a transaction:

1. `SELECT next_sequence FROM jobs WHERE id = ?`. If no row, throw
   `CTGJobError("JOB_NOT_FOUND")`.
2. `sequence = next_sequence`.
3. `INSERT INTO events (job_id, sequence, name, payload, created_at)
   VALUES (?, ?, ?, ?, ?)` with `payload = JSON.stringify(payload)`.
4. `UPDATE jobs SET next_sequence = next_sequence + 1 WHERE id = ?`.
5. Commit.

Sequences therefore start at **1**, increase by exactly 1, and have no
gaps: the allocation and the insert are the same transaction, so a
rolled-back insert also rolls back the increment. `MAX(sequence)` is
never used for allocation — it would reuse a number after a delete, and
`Last-Event-ID` resumption depends on numbers never being reused.

Every operation that changes a job's state does its `UPDATE` and its
`appendEvent` in **one** transaction. A job whose row says `succeeded`
always has a `succeeded` event, and the reverse.

### 6.3 claimNextQueued

*realizes: D7, M*

`claimNextQueued :: VOID -> claimedJob?`, in one transaction:

1. `SELECT * FROM jobs WHERE status = 'queued' ORDER BY submission ASC LIMIT 1`.
2. If no row, roll back and return `undefined`.
3. `UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`.
4. If the update reported 0 changes, roll back and **return to step 1**
   (the job was cancelled between the read and the update).
5. `appendEvent(id, "running", { jobId, status: "running", startedAt })`.
6. Commit and return `{ job, event }` with the job re-read post-update.

The `AND status = 'queued'` in step 3 is the guard that makes claim and
cancel mutually exclusive (§5.2).

### 6.4 listJobs

`listJobs :: jobListQuery -> jobListPage`

1. Base query: `SELECT * FROM jobs`.
2. If `status` is present, add `WHERE status = ?`.
3. If `before` is present, add `submission < ?`.
4. `ORDER BY submission DESC LIMIT ?`, with `limit + 1` rows requested.
5. If `limit + 1` rows came back, drop the extra and set `nextBefore` to
   the `submission` of the **last returned** job. Otherwise
   `nextBefore = null`.

> **Judgment Call 12 — cursor pagination on `submission`, not
> offset/limit.** `submission` is monotonic and never reused, so a
> cursor page is stable while jobs are being submitted; an `OFFSET` page
> shifts under the reader on every new submission. The cursor is also
> the same number FIFO order is defined on, so there is one ordering
> concept in the system rather than two.

### 6.5 Reading events

`readEvents :: STRING:id, NUMBER:afterSequence -> [eventRecord]` runs
`SELECT ... WHERE job_id = ? AND sequence > ? ORDER BY sequence ASC` and
parses each `payload` with `JSON.parse`. `afterSequence = 0` returns the
whole history.

### 6.6 purgeDone

*realizes: D8*

`purgeDone :: VOID -> NUMBER`, one transaction:

1. `DELETE FROM events WHERE job_id IN (SELECT id FROM jobs WHERE status IN ('succeeded','failed','cancelled'))`.
2. `DELETE FROM jobs WHERE status IN ('succeeded','failed','cancelled')`.
3. Commit. Return the number of rows the second statement deleted.

`queued` and `running` rows, and their events, are untouched. The order
matters: deleting jobs first would leave the events query with nothing to
match, orphaning every event row.

Jobs and events are otherwise **kept forever**. There is no TTL, no
row cap, and no background sweep. The purge is an operator command:

```json
"scripts": { "purge-done": "tsx scripts/purge-done.ts" }
```

The script constructs a `CTGJobServer` (config from the same environment
the service uses), calls `purgeDone()`, prints the count, and calls
`close()`. It is not an HTTP route — deleting history is not something a
client with an API key should be able to do.

> **Judgment Call 13 — the purge script goes through `CTGJobServer`
> rather than opening `CTGJobStore` directly.** Construction is where
> config validation lives, so the script gets the same "refuse to start
> without an API key" behavior and the same defaults. The cost is that
> the script also runs recovery (§4.2), which is arguably a side effect
> an operator did not ask for — but failing a job whose process is
> demonstrably gone is correct whenever it is observed.

---

## 7. Events and the stream

### 7.1 Event names

*realizes: M*

| Name | Kind | Written when |
|---|---|---|
| `queued` | lifecycle | A job is submitted |
| `running` | lifecycle | A job is claimed by the dispatcher |
| `output` | runner | A `LLMRunnerOutputEvent` is received |
| `stream` | runner | Any other `LLMRunnerStreamEvent` is received |
| `succeeded` | lifecycle | `runner.run` resolved |
| `failed` | lifecycle | `runner.run` rejected, or recovery found the job running |
| `cancelled` | lifecycle | A queued job was cancelled |

`succeeded`, `failed`, and `cancelled` are **terminal**. Exactly one
terminal event exists per job, and it is always the highest sequence.

### 7.2 Mapping runner events to rows

*realizes: M, D2*

`_recordStreamEvent :: STRING:jobId, llmRunnerStreamEvent -> VOID`.
`onStream` receives an `LLMRunnerStreamEvent`; which subclass it is
depends on `streamMode` and on the concrete runner. **Detection order:**

1. `event instanceof LLMRunnerOutputEvent` → name `output`, payload
   `{ source, stream, chunk }` from the event's `source`, `stream`
   (`"stdout"` or `"stderr"`), and `chunk` fields. Checked first because
   `LLMRunnerOutputEvent` extends `LLMRunnerStreamEvent` and would
   otherwise be caught by the fallback.
2. `event` has a `payload` property (`ClaudeRunnerEvent` and
   `CodexRunnerEvent` both do) → name `stream`, payload
   `{ source, type, payload }`, where `type` is the event's optional
   `type` string or `null`.
3. Otherwise — a bare `LLMRunnerStreamEvent` → name `stream`, payload
   `{ source, raw }`.

The check in step 2 is on the property, not on
`instanceof ClaudeRunnerEvent`. The server is configured with **one**
runner (D1) and must not enumerate the runner subclasses that exist;
`payload` is the shape the runner-native event classes share, and a
future runner's event class that carries a `payload` is relayed without
this server being edited.

Then: `store.appendEvent(jobId, name, payload)`, then
`subscribers.publish(jobId, event)`. **Store first, publish second,
always.** A subscriber must never see an event that is not yet
replayable, or a reconnect would lose it.

If `appendEvent` throws, the exception is caught and swallowed and the
run continues. `LLMRunner` already isolates `onStream` failures so an
observer cannot change child-process semantics; this server does not
rely on that, but it does not fight it either. The job's outcome is
still recorded by `finishJob`.

> **Judgment Call 14 — runner event payloads are stored as JSON text of
> whatever the runner emitted, not normalized.** `ctg-ai-agent-proc`
> deliberately keeps text, usage, reasoning, and tool activity inside the
> runner-native payload rather than normalizing them into base event
> classes (upstream spec G-7B). Normalizing here would re-introduce
> exactly the coupling upstream rejected, and would silently drop fields
> whenever a vendor added one.

### 7.3 The SSE projection

*realizes: M, D2*

`GET /jobs/:id/events`. Response headers:

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

Each event is written as three lines and a blank line:

```
id: <sequence>
event: <name>
data: <JSON payload on one line>

```

`id:` is the per-job sequence number, which is what makes
`Last-Event-ID` work. `data:` is always exactly one line — payloads are
`JSON.stringify`'d, which escapes newlines, so no multi-line `data:`
continuation is ever needed.

**Subscribe procedure**, in order, because the ordering is the whole
correctness argument:

1. Resolve `afterSequence`: the `Last-Event-ID` request header parsed as
   a base-10 integer; `0` if the header is absent, non-numeric, or
   negative.
2. `store.readJob(id)`. If undefined, respond `404` with the standard
   JSON error envelope and **no SSE stream** — the client asked about a
   job that does not exist, and an empty event stream would look like a
   job that has not started.
3. Write the SSE headers and flush them.
4. `subscribers.add(id, sink)` — register **before** reading history.
5. `store.readEvents(id, afterSequence)` and write each one.
6. If the last written event was terminal, `end()` the response and
   `close()` the subscription; done.
7. Otherwise start the keep-alive timer and leave the response open. The
   subscription writes each subsequently published event, and ends the
   response after writing a terminal one.

Steps 4 and 5 are **one synchronous block with no `await` between
them**. `node:sqlite` is synchronous and events are only appended from
the dispatcher's async continuations, so no event can be committed
between registration and replay. This is why no in-memory buffering
step is needed. As a second guard, each subscription records the highest
sequence it has written and drops any published event whose sequence is
not greater — so a live event that was also in the replay is written
once, not twice.

**Boundary behaviors:**

| Condition | Behavior |
|---|---|
| Unknown job id | `404` JSON envelope, no stream |
| `Last-Event-ID` absent | Full history from sequence 1 |
| `Last-Event-ID` ≥ last sequence, job terminal | Headers, no events, immediate `end()` |
| `Last-Event-ID` ≥ last sequence, job not terminal | Headers, no events, stream stays open for the live tail |
| `Last-Event-ID` malformed | Treated as `0` — full history |
| Job already terminal | Full history, then `end()` — the connection does not linger |
| Client disconnects | The response's `close` event fires `subscription.close()`, deregistering the sink and clearing the keep-alive timer |

**Keep-alive:** while a stream is open, a comment line `: keep-alive`
followed by a blank line is written every `keepAliveMs` (default
15000). Comment lines are ignored by every SSE client and carry no `id:`,
so they cannot disturb resumption. The timer is cleared when the stream
ends for any reason.

> **Judgment Call 15 — the stream closes after the terminal event
> rather than staying open.** A job has exactly one terminal event and
> can produce nothing after it, so an open connection past that point is
> a socket held for no reason. Closing also gives the client an
> unambiguous end-of-job signal. The consequence, stated because clients
> will hit it: browser `EventSource` auto-reconnects on close, and will
> reconnect with `Last-Event-ID` set to the terminal sequence, receive
> nothing, and be closed again — a loop. Server-side clients (`fetch` +
> a stream reader) should stop on the terminal event; see SQ-2.

> **Judgment Call 16 — subscribers are held per job id, keyed in a
> `Map<string, Set<subscription>>`.** Multiple subscribers per job are
> supported and needed (an operator watching a job a client is already
> streaming). Publishing is a fan-out over the set; a sink that throws
> on `write` is closed and dropped rather than aborting the fan-out to
> the others.

---

## 8. HTTP surface

*realizes: D1, D2, D6, D7, D10*

Express is the HTTP host. It supplies routing, the JSON body parser, and
response writing — and nothing else. Every behavior below is specified
here rather than inherited.

> **Judgment Call 17 — Express, overriding `ctg-ts-web-server` SQ-1.**
> That rule — "depend on things that solve a hard mechanical problem,
> not on things that define behavior" — was written for a **reusable
> library** whose observable behavior has to be reproducible in another
> host, and where CORS matching and header sets *were* the library's
> behavior. This project is a **service**, and its behavior is the job
> model in §1: the queue, the sequence, the durable stream. Express
> supplies path matching and `res.write` — the mechanical part — and
> touches none of it. Adopting the rule here would mean re-deriving a
> router to protect semantics the router never touches. The rule is not
> repealed; it is applied to a different kind of artifact and comes out
> the other way. The bound stays: `express` and `ctg-ai-agent-proc`,
> plus Node built-ins, and anything further is a surfaced question, not
> a decision.

### 8.1 Routes

| Method | Path | Success | Body / Query |
|---|---|---|---|
| `POST` | `/jobs` | `202` | `{ "prompt": string }` |
| `GET` | `/jobs` | `200` | `?status=`, `?limit=`, `?before=` |
| `GET` | `/jobs/:id` | `200` | — |
| `GET` | `/jobs/:id/events` | `200` (SSE) | `Last-Event-ID` header |
| `POST` | `/jobs/:id/cancel` | `200` | — |

There is no route that is not in this table. In particular there is no
health route, no metrics route, and no route that lists or names runners
— the server has one runner and the client cannot choose it (D1).

**`POST /jobs`** — *realizes: D1, D4, D8*

1. Reject if `Content-Type` is not `application/json`
   (`INVALID_CONTENT_TYPE`, 415).
2. Body must be a JSON object with a `prompt` property
   (`INVALID_BODY`, 400).
3. `queue.submit(body.prompt)` — which raises `INVALID_PROMPT` for
   non-strings, empty or whitespace-only prompts, and oversized prompts
   (§5.1).
4. Respond `202` with `{ success: true, result: { id, status: "queued", createdAt } }`.

`202 Accepted` and not `201 Created`: the client is told the prompt was
accepted for later processing, which is exactly what happened. Any
property of the body other than `prompt` is ignored — there is no runner
name, no per-run args, and no stream mode to accept (D1).

**`GET /jobs`** — `status` must be one of the five `JobStatus` values if
present; `limit` must be an integer in `1..maxLimit`; `before` must be a
positive integer. Any violation is `INVALID_QUERY` (400). Result is
`{ jobs, nextBefore }` with jobs in the shape of §8.3.

**`GET /jobs/:id`** — `404` `JOB_NOT_FOUND` for an unknown id.

**`POST /jobs/:id/cancel`** — `queue.cancel(id)`; `404` for unknown,
`409` `CANCEL_NOT_ALLOWED` for a running or terminal job (§5.2). Result
is the updated job.

### 8.2 Authentication

*realizes: D10*

**Every route requires the key, including the SSE route.** The check is
Express middleware mounted before the routes, so a route added without
thinking about auth is still covered.

Header: **`X-API-Key: <key>`**.

Comparison is `crypto.timingSafeEqual` over UTF-8 buffers, guarded by a
length check first (`timingSafeEqual` throws on length mismatch). A
missing header, an empty header, or a mismatch is `401`
`UNAUTHORIZED` with the message `Invalid or missing API key.` — the same
message for all three, so the response does not distinguish "no key"
from "wrong key".

> **Judgment Call 18 — `X-API-Key`, not `Authorization: Bearer`.**
> `Bearer` names a token format with expiry, issuer, and revocation
> semantics that this key does not have; a shared static key presented
> as a bearer token invites a client to treat it as one. `X-API-Key` is
> unambiguous about what it is. Neither choice helps a browser
> `EventSource`, which cannot set any request header — see SQ-2. The
> `WWW-Authenticate` response header is not sent, because there is no
> challenge a client can respond to.

### 8.3 Response envelope

One shape, stated once:

| Case | Status | Body |
|---|---|---|
| Success | 200 / 202 | `{ "success": true, "result": <data> }` |
| Any error | from the error | `{ "success": false, "result": { "type": <string>, "code": <int>, "message": <string> } }` |
| SSE stream | 200 | *not an envelope* — `text/event-stream` (§7.3) |

A job appears in `result` as the `JobRecord` fields of §3.1, with two
omissions: `submission` (an internal ordinal, exposed only as the
`nextBefore` cursor) and `errorData` (diagnostics that can contain
partial process output, kept server-side). `prompt` **is** returned —
the client sent it, and a job whose prompt cannot be read back is not
inspectable.

The error branch never includes a stack trace, and `CTGJobError.data` is
never serialized into the response. Both stay server-side.

### 8.4 Error handling

An Express error handler is the single place a thrown error becomes a
response:

1. `CTGJobError.is(err)` → status from `err.status`, body from
   `err.toResult()`.
2. Anything else → `500` with type `INTERNAL_ERROR`, code `1012`,
   message `Internal error.` The original error is not exposed.

An unmatched path is `404` `NOT_FOUND`; an unmatched method on a matched
path is `405` `METHOD_NOT_ALLOWED`.

Errors on an **already-open SSE stream** cannot be responses — headers
are sent. The stream is ended, the subscription is closed, and nothing
further is written. The client reconnects with `Last-Event-ID` and loses
nothing, because the durable events table is the stream.

---

## 9. CTGJobError

*realizes: D2, D8, D10*

Follows the CTG error convention: extends `Error`, bidirectional
`TYPES` map with integer codes, `type` / `msg` / `data`, and a `status`
for the HTTP layer.

```typescript
type JobErrorType =
    | "INVALID_CONFIG" | "UNAUTHORIZED" | "INVALID_CONTENT_TYPE"
    | "INVALID_BODY" | "INVALID_PROMPT" | "INVALID_QUERY"
    | "JOB_NOT_FOUND" | "CANCEL_NOT_ALLOWED" | "NOT_FOUND"
    | "METHOD_NOT_ALLOWED" | "STORE_FAILED" | "INTERNAL_ERROR";
```

**Every error this system raises.** Nothing is invented ad hoc in prose
anywhere else in this document.

| Type | Code | HTTP | Raised when |
|---|---|---|---|
| `INVALID_CONFIG` | 1001 | — | Any construction check in §4.1 fails. Never reaches HTTP: the server does not start. |
| `UNAUTHORIZED` | 1002 | 401 | `X-API-Key` is missing, empty, or does not match (§8.2) |
| `INVALID_CONTENT_TYPE` | 1003 | 415 | `POST /jobs` without `application/json` |
| `INVALID_BODY` | 1004 | 400 | Body is not a JSON object, or has no `prompt` property |
| `INVALID_PROMPT` | 1005 | 400 | Prompt is not a string, is empty or whitespace-only, or exceeds `maxPromptBytes` (§5.1) |
| `INVALID_QUERY` | 1006 | 400 | Bad `status`, `limit`, or `before` on `GET /jobs` |
| `JOB_NOT_FOUND` | 1007 | 404 | No job with that id, on read, cancel, subscribe, or event append |
| `CANCEL_NOT_ALLOWED` | 1008 | 409 | Cancelling a running or terminal job (§5.2) |
| `NOT_FOUND` | 1009 | 404 | No route matches the path |
| `METHOD_NOT_ALLOWED` | 1010 | 405 | Path matches, method does not |
| `STORE_FAILED` | 1011 | 500 | A `node:sqlite` operation threw; the underlying error is `data.cause` |
| `INTERNAL_ERROR` | 1012 | 500 | Anything unhandled reaching the error handler |

`TYPES` is bidirectional — `CTGJobError.TYPES.UNAUTHORIZED === 1002` and
`CTGJobError.TYPES[1002] === "UNAUTHORIZED"`. Constructing with an
unknown type string throws a plain `Error`. `data` is frozen shallowly,
matching `LLMRunnerError`.

`LLMRunnerError` is **never rethrown to a client.** A runner failure is
a job outcome, not a request outcome — the request that submitted the
job succeeded (202) long before the run failed. The runner error's
`type` and `msg` are recorded on the job row and in the `failed` event,
where the client reads them.

> **Judgment Call 19 — one error class, with `status` on the error.**
> `ctg-ts-web-server` split `CTGServerError` (public) from
> `CTGValidationError` (internal) because validation errors are
> collected per field into one envelope. This service has no per-field
> validation to collect: every error is one condition producing one
> response. Putting the status on the error means the type-to-status
> mapping lives in exactly one table — the one above — instead of being
> re-derived in the error handler.

---

## 10. Not Implemented

| Not provided | Reason |
|---|---|
| Cancelling a **running** job | *D6.* Requires an abort signal in `ctg-ai-agent-proc`'s `LLMRunner`, which does not exist. A running job runs to completion or to the runner's `timeout`. Deferred to a later version. |
| Retries | A failed job stays failed. Resubmission is the client's decision (D5's rule, applied generally). |
| Multiple runners / a runner registry | *D1.* One runner, configured at construction. The client cannot name one. |
| Prompt templates, client-supplied `LLMPrompt` operations | *D4.* The prompt string reaches `runner.run()` unchanged. `LLMPrompt` and `LLMPromptTemplate` exist upstream and are not used. |
| Operational logging | *D9.* v1 says nothing about logging. Fatal errors surface as ordinary process behavior. |
| Per-user auth, roles, ownership | *D10.* One shared key. Every holder can see and cancel every job. |
| Job priorities | Dispatch is FIFO by `submission` (D7). |
| Webhooks / push callbacks | The events table and its SSE projection are the notification mechanism. |
| Rate limiting | Not decided; see SQ-4. |
| Automatic retention / TTL | *D8.* Kept forever; `purge-done` is an operator command. |
| Multi-process / multi-host operation | The concurrency limit is per process (§5.3) and holds only because Node is single-threaded. See SQ-1. |
| Streaming the prompt in, or partial results out of `GET /jobs/:id` | The job row carries the final result only; partial output is read from the event stream. |

---

## 11. Conformance Verification

Tests use **`ctg-js-test`**, pinned to
`github:claymoretechgroup/ctg-js-test#v4.0.0` — the same pin
`ctg-ai-agent-proc` uses, so a developer moving between the two projects
meets one framework. Tests are `.ts`, run under `tsx`, and are pipelines
of `stage` and `assert` over a threaded subject.

**Every test is hermetic.** No CLI is invoked, no network is used, and
no test depends on a real `claude` or `codex` binary.

```
tests/
    test.ts                        entry point; chains every suite, formats, exits
    conformance/
        helpers.ts                 FakeRunner, temp databases, capture helpers
        errorClass.ts              CTGJobError: TYPES bidirectionality, codes, statuses
        config.ts                  CTGJobServer.init validation, defaults, apiKey refusal
        store.ts                   schema, sequence allocation, claim, finish, cancel, list
        queue.ts                   submit validation, dispatch limit, FIFO, no double dispatch
        events.ts                  runner event to row mapping, detection order, payloads
        subscribers.ts             fan-out, dedupe by sequence, terminal close, sink errors
        recovery.ts                interrupted jobs failed; queued jobs untouched
        purge.ts                   terminal rows deleted, queued and running preserved
        routes.ts                  every route, envelope shape, auth, error statuses
        sse.ts                     wire format, Last-Event-ID, history/live/terminal cases
```

**The fake runner.** `LLMRunner`'s constructor requires a non-empty
`command` string, so the fake passes one (`"node"`, never executed) and
overrides `run`:

```typescript
class FakeRunner extends LLMRunner {
    async run(prompt: string, config: LLMRunnerRunConfig): Promise<LLMRunnerResult>;
}
```

Each test's fake is scripted to do one of: emit a sequence of
`LLMRunnerOutputEvent` / `ClaudeRunnerEvent` instances through
`config.onStream` and resolve; reject with a real `LLMRunnerError`;
throw synchronously; or block on a promise the test resolves when it
wants the run to finish. The last of these is what makes the
concurrency-limit and FIFO assertions deterministic — the test holds
runs open and asserts on `_active` through observable behavior (which
jobs are `running` in the store) rather than on the field.

The fake also asserts the call contract: `run` is called with the
prompt **byte-identical** to what was submitted, and with exactly
`{ streamOutput: true, streamMode, onStream }` and nothing else (D1,
D4).

**Databases** are temp files from `mkdtempSync(join(tmpdir(), ...))`,
one per suite, deleted at the end. `":memory:"` is used where a suite
needs no second connection; the purge suite uses a file, because it
opens a second connection the way the script does.

**The SSE route** is exercised over real HTTP without a real network:
`node:http`'s `createServer(app)` on an **ephemeral port**
(`listen(0)`), then a `fetch` against `127.0.0.1:<assigned port>`,
reading `response.body` as a stream and parsing the raw event-stream
text. Asserting on the raw text is deliberate — the wire format in §7.3
is the contract, and an SSE client library would hide `id:` lines,
comment keep-alives, and stream termination, which are precisely the
things under test.

**Coverage rule:** every row of the error table (§9) has a test
asserting both the type string and the HTTP status; every row of the SSE
boundary table (§7.3) has a test; every decision D1–D10 has at least one
test that would fail if the decision were reversed.

---

## 12. Judgment Calls

1. **Five capability-shaped classes, not one service class** (§2). Store,
   queue, subscribers, app, server. The store knows nothing about HTTP,
   subscribers, or the runner; the queue knows nothing about HTTP. This
   is what makes the store and the dispatch procedure testable without a
   socket.
2. **Recovery and the first dispatch happen in `init`, not `listen`**
   (§4.1). A constructed server is a working server.
3. **`store` and `queue` are public getters** (§4.1). The purge script
   and the tests both need them; D8 already requires the purge to be a
   public method.
4. **`INTERRUPTED` is an `errorType`, not a sixth job status** (§4.2).
   The five-state lifecycle in M stays five states.
5. **Whitespace-only prompts are rejected alongside the empty string**
   (§5.1), with the validation trim not affecting the stored prompt.
6. **The prompt limit is UTF-8 bytes, not characters** (§5.1), because
   bytes are what the argv limit measures.
7. **`_active` is a set of job ids, not a counter** (§5.3), so
   double-dispatch is observable rather than invisible.
8. **`streamOutput: true` on every run** (§5.4). The buffered path emits
   no events, and events are the product.
9. **`streamMode` defaults to `"events"`, `"raw"` selectable at
   construction** (§5.4).
10. **No server-level `timeout` or `maxBuffer`** (§5.4). They are the
    runner instance's config; two owners of one value is a bug waiting.
11. **No foreign key from `events.job_id` to `jobs.id`** (§6.1). The
    store's own transactions already provide the guarantee.
12. **Cursor pagination on `submission`, not offset** (§6.4), so a page
    is stable under concurrent submission and there is one ordering
    concept.
13. **The purge script constructs a `CTGJobServer`** (§6.6), inheriting
    config validation, at the cost of also running recovery.
14. **Runner event payloads are stored unnormalized** (§7.2), matching
    the upstream decision to keep vendor semantics inside the payload.
15. **The SSE stream closes after the terminal event** (§7.3), with the
    browser-`EventSource` reconnect consequence stated.
16. **Subscribers are per-job sets; a throwing sink is dropped, not
    propagated** (§7.3).
17. **Express, deliberately overriding `ctg-ts-web-server` SQ-1** (§8).
    That rule governs a reusable library whose behavior must be
    reproducible; this is a service whose behavior is the job model, and
    Express supplies only the mechanical HTTP part. *realizes: D2*
18. **`X-API-Key`, not `Authorization: Bearer`** (§8.2). The key has no
    bearer-token semantics and should not claim them.
19. **One error class carrying its own HTTP status** (§9), so the
    type-to-status mapping exists in exactly one table.
20. **`202` for submit, not `201`** (§8.1). Nothing was created that the
    client can act on yet; a prompt was accepted for later processing.
21. **`prompt` is returned in job responses; `errorData` and
    `submission` are not** (§8.3). The client's own input is readable
    back; process diagnostics and internal ordinals are not.
22. **SSE tests assert raw event-stream text** (§11), because the wire
    format is the contract and a client library would hide it.

---

## 13. Surfaced Questions

Each has a **provisional answer**, marked as such, which the spec is
written against so it stays complete. Any of them may be overturned
without invalidating the rest of the document.

### SQ-1 — Is a second process ever going to open the same database?

The concurrency limit (§5.3) is correct **only within one Node
process**. Two service processes on one database file would each run up
to `concurrency` jobs, and `claimNextQueued`'s conditional update would
keep them from claiming the *same* job but would not keep the total
under the limit. The `purge-done` script already opens a second
connection, which is safe because it touches only terminal rows — but it
establishes the pattern.

**Provisional answer: single process, and the spec says so.** WAL mode
and `busy_timeout` are set (§6.1) so a concurrent reader is safe, and
multi-process operation is listed under Not Implemented (§10). If the
answer changes, the fix is a lease column on `jobs` (`claimed_by`,
`claim_expires_at`) and a global slot count enforced in SQL — a schema
change, so it should be decided before the schema is written rather
than after.

### SQ-2 — How does a browser subscribe to the event stream?

Browser `EventSource` **cannot set request headers**, so it cannot send
`X-API-Key` — nor `Authorization`, so the header choice (Judgment Call
18) is not what causes this. The candidates are a query-string key
(logged by every proxy), a cookie set by a login route this service does
not have, or a `fetch`-based stream reader instead of `EventSource`.
Judgment Call 15's terminal-close also interacts badly with
`EventSource`'s automatic reconnect.

**Provisional answer: clients are server-side.** The consumer of this
service is another process (`fetch` + a stream reader, or `curl`), which
can set headers and can stop on the terminal event. No query-string key
is accepted, and no cookie is issued. If a browser client is required,
that is a real feature with an auth design attached, not a header
tweak.

### SQ-3 — Should the job row carry the runner's stderr on success?

§5.4 records `LLMRunnerResult.error` — the child's stderr — into
`jobs.error` even when the job succeeded, because that is the upstream
contract's shape (`{ result, error }` = stdout, stderr). A column named
`error` holding text on a `succeeded` job reads badly, and a client
checking "is `error` non-empty" would misclassify successes.

**Provisional answer: keep one column, and let `status` be the
authority.** `status` and `errorType` together say whether the job
failed; `error` is diagnostic text whose presence means nothing on its
own. The alternative — separate `stderr` and `failure_message` columns
— is cleaner to read and is the change to make if this confuses a
consumer. It is a schema change, so it should be decided before the
schema is written.

### SQ-4 — Is a shared API key with no rate limit sufficient exposure control?

Every holder of the key can submit unlimited jobs. The queue bounds
concurrent *runs* (D7) but not queue depth, so a client in a loop can
enqueue without limit, and each queued row holds a prompt of up to
`maxPromptBytes`. D8 caps individual prompts and adds no other cap; the
decisions are silent on aggregate volume.

**Provisional answer: no limit in v1, and it is listed under Not
Implemented.** The deployment is trusted and single-tenant. The cheapest
mitigation if this changes is a maximum queue depth checked in
`submit` — one config field, one error type, no schema change — which is
why it is worth naming now even though it is not being built.

### SQ-5 — Should `GET /jobs/:id` include the last N events?

A client polling job state currently learns only the terminal fields; to
see anything about the run it must open the event stream. For a client
that does not want a stream — a status page, a CLI poll — a small tail
of recent events on the job read would be enough.

**Provisional answer: no, the job read returns the job only.** Two ways
to read events would mean two shapes of the same data and a second cap
to choose. `GET /jobs/:id/events` with `Last-Event-ID` already serves
polling: a client that closes the stream immediately after the replay
gets exactly the events it has not seen.

### SQ-6 — What happens to the `queued` event's ordering guarantee for a job that is claimed instantly?

With `concurrency: 1` and an idle queue, `submit` appends `queued`
(sequence 1) and then calls `dispatch()`, which appends `running`
(sequence 2) — both before `submit` returns, and both before the client
has the job id to subscribe with. The sequence is correct, but a client
can never observe a job in the `queued` state over HTTP.

**Provisional answer: this is correct and intended.** The events table
is the record, and a subscriber arriving later replays both events in
order (§7.3). The job's *state* being unobservable at a moment is not
the same as the *event* being lost, and M's guarantee is about the
event history, not about what a poll happens to catch.

### SQ-7 — Does `close()` need to wait for running jobs?

§4.3 does not wait: running jobs are orphaned and failed as
`INTERRUPTED` on the next start. A graceful variant would stop claiming
new jobs, wait for `drain()`, and then close — turning a restart from
"every in-flight job fails" into "the restart takes as long as the
longest run".

**Provisional answer: no graceful drain in v1.** D5 already specifies
what happens to interrupted jobs and makes it a recoverable, visible
outcome rather than data loss, so the drain buys convenience rather than
correctness. `queue.drain()` exists for tests, so adding a graceful
shutdown later is a change to `close()` alone.
