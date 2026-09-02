# ctg-ts-prompt-server v1.0 — Specification

**Target:** TypeScript (ES modules, Node.js 22.22, `strict: true`)
**Code style:** `ctg-spec-ops/code-styles/typescript-code-style.md`
**Upstream artifact:** there is no design doc. The decision list D1–D10,
the behavioral model **M** (§1), and the owner's review resolutions
R1–R28 are the upstream layer, and every `realizes:` back-pointer in
this document names one of them. Where a resolution supersedes a
decision, both are cited. See `ctg-spec-ops/INCIDENTS.md`, Stage 2,
2026-09-02 — the design-doc layer was deliberately skipped because
every decision in this project is bound to its host.

**Dependencies:** `express`, `ctg-ai-agent-proc`
(`github:claymoretechgroup/ctg-ai-agent-proc`), and Node built-ins.
Nothing else. `ctg-js-test` is a dev dependency.

This document is the authoritative description of what
`ctg-ts-prompt-server` is and how it behaves. If a method, field, route,
column, or behavior is not described here, it does not exist.

---

## 1. The Model

*realizes: M, R2, R12*

`ctg-ts-prompt-server` is a **durable prompt service that exposes one
LLM runner over HTTP.**

**A prompt is the record.** There is one noun in this system. The
client's text, its status, the response accumulated for it, its outcome,
and its event history are all fields and children of a single row with a
single integer id. There is no wrapper entity around the prompt, no
second lifecycle, and no second identifier: the id a client receives
from submit is the id it reads, cancels, streams, and pages on.

A prompt is submitted; the server stores it as `pending` and answers
immediately with its record. Nothing about the run happens on the
submitting request.

A **run** happens when a concurrency slot is free. The server passes the
prompt's text to the configured `LLMRunner` and writes **every event the
runner emits** into an events table, each row carrying a per-prompt
sequence number that is monotonic and gap-free.

**The events table is the durable stream.** It is not a log kept
alongside a stream; it is the stream, and Server-Sent Events is one
projection of it. Four consequences, and they are the point of the
design:

| A subscriber arrives… | receives |
|---|---|
| before the prompt runs | nothing yet, then the whole run live, then the stream closes |
| mid-run | the history so far, then the live tail, then the stream closes |
| after the prompt is finished | the full history, then the stream closes immediately |
| reconnecting with `Last-Event-ID: n` | every event after sequence `n`, then as above |

**The SQLite database is the work list.** It is not a mirror of an
in-memory list that happens to be persisted. A waiting prompt exists
only as a row with `status = 'pending'`; the dispatcher's only source of
work is that table. There is no in-memory list of waiting prompts, and
losing the process loses nothing but the child processes that were
mid-run.

**Prompt lifecycle:**

```
pending ──▶ active ──▶ done
   │           └─────▶ error
   └──────────────────▶ cancelled
```

*realizes: R4.* **"Finished"** is the word for the set
`{ done, error, cancelled }` — a prompt in one of those three states
will never change again. `pending` and `active` are the unfinished
states. There is no status beyond these five and no filter that names a
set of them (R4).

Lifecycle transitions are themselves rows in the events table. The
stream therefore carries runner output and prompt state changes in **one
sequence**, so a subscriber never has to reconcile two orderings.

**Domain vocabulary used throughout, and nothing beyond it:** prompt,
event, sequence, dispatcher, runner, subscriber, response, outcome,
finished.

### 1.1 Where this runs, and why that shapes it

*realizes: R29, R30, R31*

The deployment this service is built for is the reason several of its
decisions look the way they do, so it is stated here rather than left
implicit.

The first consumer is a PHP retrieval-augmented-generation system that
runs **inside a Docker staging environment with no LLM credentials of
its own**. Putting credentials into that container is what the shape
avoids. This server runs on the **host**, under the operator's
OAuth-authenticated CLI session — the same session the operator uses
interactively — and the CLI child process finds those credentials by
inheriting the server process's environment (§3.2, R31). The container
reaches the server over the **Docker bridge**, sending prompts and
reading answers over HTTP.

Three consequences run through the rest of this document:

| Consequence | Where it shows up |
|---|---|
| The listener is not always loopback — the bridge address or `0.0.0.0` is a normal setting | `host` config, default `127.0.0.1` (§3.2); the Bearer key is what makes a non-loopback listener acceptable (§8.2) |
| The child process must inherit the host session's environment | `runner.env` is omitted by default and is a **complete replacement** when set (§3.2) |
| The consumer's request handlers are short-lived and synchronous | long polling on `GET /prompt/:id?wait=` (§5.5), and the CTG api-server envelope so its api-client decodes responses unchanged (§8.3) |

---

## 2. Component Map

*realizes: R3*

| Responsibility | TypeScript realization | Owns |
|---|---|---|
| Durable prompts, events, sequence allocation, response accumulation, purge | `CTGPromptDB` | the `node:sqlite` database |
| Dispatch, concurrency limit, invoking the runner, recording events, long-poll waits | `CTGPromptQueue` | the `LLMRunner` instance |
| Bridging committed events to open responses | `CTGPromptSubscribers` | open SSE sinks and long-poll waiters |
| Config validation, runner construction, HTTP routes, envelopes, lifecycle | `CTGPromptServer` | the Express application |
| Typed errors | `CTGPromptServerError` | — |

Four classes plus the error class. Dependency direction is one way:
`CTGPromptServer` → `CTGPromptQueue` → (`CTGPromptDB`,
`CTGPromptSubscribers`). `CTGPromptDB` knows nothing about subscribers,
HTTP, or the runner; it is a database. `CTGPromptQueue` knows nothing
about HTTP. This is the decomposition D-nothing forced, so it is
Judgment Call 1.

`CTGPromptServer` is both the entry point and the HTTP surface: it
validates config, owns the lifecycle, and defines the Express routes
(R3). There is no separate application-builder class — the routes are
the thinnest layer in the system, and splitting them out would put the
config that authorizes them one indirection away from the middleware
that enforces it.

---

## 3. Public Surface

Every public class in full, before any prose about it.

```typescript
class CTGPromptServer {
    static init(config: CTGPromptServerConfig): CTGPromptServer;

    readonly app: Express;
    readonly db: CTGPromptDB;
    readonly queue: CTGPromptQueue;

    start(port: number): Promise<void>;
    close(): Promise<void>;
}

class CTGPromptQueue {
    static init(config: CTGPromptQueueConfig): CTGPromptQueue;

    submit(prompt: string): PromptRecord;
    cancel(id: number): PromptRecord;
    read(id: number): PromptRecord;
    readWait(id: number, waitMs: number): Promise<PromptRecord>;
    list(query: PromptListQuery): PromptListPage;
    subscribe(id: number, sink: CTGPromptEventSink, afterSequence: number): CTGPromptSubscription;

    recover(): number;
    dispatch(): void;
    drain(): Promise<void>;
}

class CTGPromptDB {
    static init(config: CTGPromptDBConfig): CTGPromptDB;

    insertPrompt(prompt: string): PromptRecord;
    readPrompt(id: number): PromptRecord | undefined;
    listPrompts(query: PromptListQuery): PromptListPage;

    claimNextPending(runner: RunnerKind): ClaimedPrompt | undefined;
    finishPrompt(id: number, outcome: PromptOutcome): AppendedEvent;
    cancelPending(id: number): AppendedEvent;
    interruptActive(): number;

    appendEvent(id: number, name: PromptEventName, payload: unknown, appendResponse?: string): AppendedEvent;
    readEvents(id: number, afterSequence: number): EventRecord[];
    lastSequence(id: number): number;

    purgeFinished(): number;
    close(): void;
}

class CTGPromptSubscribers {
    static init(): CTGPromptSubscribers;

    add(id: number, sink: CTGPromptEventSink): CTGPromptSubscription;
    publish(id: number, event: EventRecord): void;
    closePrompt(id: number): void;
    closeAll(): void;
    count(id: number): number;
}

class CTGPromptServerError extends Error {
    static readonly TYPES: Readonly<Record<string, number>>;

    readonly type: PromptServerErrorType;
    readonly msg: string;
    readonly data: Readonly<Record<string, unknown>>;
    readonly status: number | null;

    constructor(type: PromptServerErrorType, msg: string, data?: Record<string, unknown>);

    toResult(): { type: string; code: number; message: string };

    static is(value: unknown): value is CTGPromptServerError;
    static isType(type: string): boolean;
    static codeOf(type: PromptServerErrorType): number;
    static statusOf(type: PromptServerErrorType): number | null;
}
```

### 3.1 Types

```typescript
type PromptStatus = "pending" | "active" | "done" | "error" | "cancelled";

type PromptEventName =
    | "pending" | "active" | "done" | "error" | "cancelled"
    | "output" | "stream";

type RunnerKind = "claude" | "codex";

type StreamMode = "raw" | "events";

type PromptOutcomeErrorType = "RUNNER" | "SERVER" | "INTERRUPTED";

interface PromptRecord {
    readonly id: number;                          // SQLite AUTOINCREMENT; identity, FIFO order, cursor
    readonly status: PromptStatus;                // current lifecycle state
    readonly prompt: string;                      // exactly what the client sent
    readonly response: string;                    // text accumulated so far; the runner's result once done
    readonly errorType: PromptOutcomeErrorType | null;  // set only when status is "error"
    readonly errorMessage: string | null;         // set only when status is "error"
    readonly info: Readonly<Record<string, unknown>> | null;  // operator-only diagnostics; never serialized (R11)
    readonly runner: RunnerKind | null;           // the runner kind bound at claim; null while pending
    readonly lastSequence: number;                // highest event sequence written for this prompt
    readonly createdAt: number;                   // epoch ms at submit
    readonly startedAt: number | null;            // epoch ms when claimed
    readonly finishedAt: number | null;           // epoch ms at the transition into a finished state
}

interface EventRecord {
    readonly promptId: number;           // owning prompt
    readonly sequence: number;           // per-prompt, starts at 1, gap-free, monotonic
    readonly name: PromptEventName;      // SSE event name
    readonly payload: unknown;           // parsed JSON payload (§7.2)
    readonly createdAt: number;          // epoch ms at append
}

interface AppendedEvent {
    readonly prompt: PromptRecord;       // record as of the commit that wrote the event
    readonly event: EventRecord;         // the event written
}

interface ClaimedPrompt {
    readonly prompt: PromptRecord;       // record now in "active"
    readonly event: EventRecord;         // the "active" lifecycle event
}

interface PromptOutcome {
    readonly status: "done" | "error";              // finished state to record
    readonly response?: string;                     // the runner's final result, on success
    readonly errorType?: PromptOutcomeErrorType;    // failure classification (§9.2)
    readonly errorMessage?: string;                 // failure message
    readonly info?: Record<string, unknown>;        // operator-only diagnostics
}

interface PromptListQuery {
    readonly status?: PromptStatus;      // optional filter; omitted means all
    readonly limit?: number;             // 1..maxLimit; default defaultLimit
    readonly before?: number;            // cursor: return ids strictly below this
}

interface PromptListPage {
    readonly prompts: PromptRecord[];    // newest first, by id descending
    readonly nextBefore: number | null;  // cursor for the next page, or null at the end
}

interface CTGPromptEventSink {
    write(chunk: string): void;          // append bytes to the response
    end(): void;                         // close the response
}

interface CTGPromptSubscription {
    close(): void;                       // deregister this subscriber; idempotent
}
```

`CTGPromptEventSink` is structural. `node:http`'s `ServerResponse`
satisfies it, so does the long-poll waiter of §5.5, and so does a test
double — no test needs a socket to exercise `CTGPromptSubscribers`.

### 3.2 Configuration

*realizes: D7, D8, D10, R24, R26*

```typescript
interface CTGPromptRunnerConfig {
    kind: RunnerKind;              // "claude" -> ClaudeRunner, "codex" -> CodexRunner — required
    cwd?: string;                  // child working directory
    args?: string[];               // arguments placed after the runner's own defaults
    env?: NodeJS.ProcessEnv;       // COMPLETE replacement of the child environment; omit to inherit (§3.3)
    timeout?: number;              // ms before the child is terminated; default 600000
    maxBuffer?: number;            // stdout/stderr cap in bytes; the runner's own default when omitted
}

interface CTGPromptServerConfig {
    runner: CTGPromptRunnerConfig; // the one runner this server constructs and exposes — required
    apiKey: string;                // shared key; construction fails if missing or empty
    host?: string;                 // bind address; default "127.0.0.1" (§3.3)
    database?: string;             // SQLite path; default "prompts.db"; ":memory:" permitted
    concurrency?: number;          // max simultaneous runs; default 1
    maxPromptBytes?: number;       // UTF-8 byte cap on prompts; default 131071; never above 131071
    streamMode?: StreamMode;       // runner stream contract; default "events"
    keepAliveMs?: number;          // SSE keep-alive cadence; default 15000
    maxWaitMs?: number;            // long-poll ceiling; default 30000
    defaultLimit?: number;         // list page size when unspecified; default 50
    maxLimit?: number;             // largest accepted list limit; default 200
}

interface CTGPromptQueueConfig {
    db: CTGPromptDB;               // durable prompt and event storage
    subscribers: CTGPromptSubscribers;  // live delivery for committed events
    runner: LLMRunner;             // the constructed runner instance
    runnerKind: RunnerKind;        // the kind recorded on records and "active" events (R25)
    concurrency: number;           // resolved, validated
    maxPromptBytes: number;        // resolved, validated
    streamMode: StreamMode;        // resolved
    maxWaitMs: number;             // resolved
    defaultLimit: number;          // resolved
    maxLimit: number;              // resolved
}

interface CTGPromptDBConfig {
    path: string;                  // SQLite path or ":memory:"
}
```

`CTGPromptServer.init` is the only place defaults are applied. Every
downstream config is fully resolved — no `?` fields, no second
defaulting site, no way for two components to disagree about what the
concurrency limit is.

`CTGPromptDB` takes `path`, not `database`, because the purge script
constructs it directly as `CTGPromptDB.init({ path })` (R19) and a
database object's own vocabulary for a file location is its path.

### 3.3 The bind address and the child environment

*realizes: R30, R31*

Two config values carry more consequence than their types suggest, so
each is stated in full.

**`host` — the bind address.** Default `"127.0.0.1"`: a server that is
started without being told otherwise is reachable only from its own
machine. For the deployment of §1.1 the operator sets it to the Docker
bridge address, or to `"0.0.0.0"` to accept from every interface. It
must be a non-empty string when supplied. `port` is not config — it is
the argument to `start` (§4.2), because a port is what an operator
chooses per launch while the bind address is part of how the deployment
is wired.

**`runner.env` — a complete replacement, not a merge.** This is
`LLMRunner`'s contract: the value given is the child's entire
environment, and nothing from the server process is added to it.
**Omitted is the default and the intended setting**, and it is what
makes §1.1 work — with `env` unset the CLI child inherits the server
process's environment and therefore the operator's OAuth session.

> **Setting `runner.env` drops the operator's credentials unless the
> value being set includes them.** An operator who wants to add one
> variable must pass the full environment plus that variable
> (`{ ...process.env, MY_VAR: "x" }`), not the variable alone. A runner
> given a bare `env` will start and then fail every prompt with the
> `RUNNER` outcome type, because the CLI it invokes has no session to
> find.

---

## 4. CTGPromptServer

*realizes: D1, D2, D7, D8, D10, R3, R23, R24*

The entry point and the HTTP surface. `init` validates config and opens
the database. `start` constructs the runner, recovers prompts left
active by a dead process, begins dispatching, and binds the port.

| Operation | Signature | Description | Mutates |
|---|---|---|---|
| `init` | `ctgPromptServerConfig -> ctgPromptServer` | Validate config, open the database, create the schema if absent, build subscribers and the Express app | Creates the database file, tables, and indexes if absent |
| `app` | `GETTER :: VOID -> express` | The configured Express application | |
| `db` | `GETTER :: VOID -> ctgPromptDB` | The database, exposed for tests | |
| `queue` | `GETTER :: VOID -> ctgPromptQueue` | The dispatcher; throws `INTERNAL_ERROR` before `start` (§4.2) | |
| `start` | `NUMBER:port -> PROMISE(VOID)` | Construct the runner, recover, dispatch, bind the socket on `port` and the configured `host` (§4.2) | Database: active rows moved to `error`; spawns child processes; binds a socket |
| `close` | `VOID -> PROMISE(VOID)` | Stop listening, end every open sink, close the database (§4.4) | Closes socket, subscribers, database |

`CTGPromptServer` exposes no purge operation. Purging is
`CTGPromptDB.purgeFinished` and the script reaches it directly (§6.6,
R19).

### 4.1 init

*realizes: D10, R23, R24, R26*

`init :: ctgPromptServerConfig -> ctgPromptServer`

Performs these steps in order. Any failure throws
`CTGPromptServerError("INVALID_CONFIG")` and nothing is opened.

1. `runner` must be an object with a `kind` of `"claude"` or
   `"codex"`. `cwd`, when supplied, must be a non-empty string; `args`,
   when supplied, must be an array of strings; `env`, when supplied,
   must be an object; `timeout`, when supplied, must be an integer
   `>= 0`; `maxBuffer`, when supplied, must be an integer `>= 1`. **The
   runner is validated here and instantiated in `start`** (R24).
2. `apiKey` must be a string with at least one non-whitespace
   character. **A missing or empty key is a startup failure, not a
   warning** — the server must refuse to start rather than run open.
   *realizes: D10*
3. `concurrency`, when supplied, must be an integer `>= 1`.
4. `maxPromptBytes`, when supplied, must be an integer in `1..131071`.
   A larger value is rejected, not clamped, because it would promise a
   prompt size the runner cannot deliver (§5.1, R26).
5. `keepAliveMs`, when supplied, must be an integer `>= 1000`.
6. `maxWaitMs`, when supplied, must be an integer `>= 0`.
7. `defaultLimit` and `maxLimit`, when supplied, must be integers
   `>= 1`, and `defaultLimit <= maxLimit`.
8. `streamMode`, when supplied, must be `"raw"` or `"events"`.
9. `host`, when supplied, must be a non-empty string.
10. `database`, when supplied, must be a non-empty string.
11. Open `CTGPromptDB` with `{ path: database }` — creating the schema
    if absent (§6.1).
12. Build `CTGPromptSubscribers`.
13. Build the Express application: the auth middleware, the routes of
    §8.1, and the error handler of §8.4.

**Mutation:** creates the database file and its schema if they do not
exist. Nothing else. No runner is constructed, no recovery is run, no
prompt is dispatched, and no socket is bound.

> **Judgment Call 2 — `init` opens the database and nothing else;
> `start` is where the server becomes live.** *(Supersedes the draft's
> "recovery and first dispatch happen in `init`"; reversed in review by
> R23.)* Construction that also runs recovery and spawns child processes
> gives a test or a script no way to inspect a database without changing
> it, and makes an accidental second construction destructive. Splitting
> at `start` makes exactly one operation live-making, and it is the one
> named for it.

> **Judgment Call 3 — `db` is a public getter available after `init`;
> `queue` is a public getter that exists only after `start`.** Tests
> need to assert on stored rows without going through HTTP, and that is
> true before the server is live. The queue owns a runner, which does
> not exist until `start`, so reading it earlier is a programming error
> and throws `INTERNAL_ERROR` with the message
> `Server has not been started.` No request can reach it earlier,
> because the socket is bound in `start`.

### 4.2 start

*realizes: R21, R23, R24*

`start :: NUMBER:port -> PROMISE(VOID)`

1. If `start` has already been called on this instance, throw
   `CTGPromptServerError("INTERNAL_ERROR", "Server has already been started.")`.
   A server is started once; a second call would construct a second
   runner and a second dispatch loop over the same database.
2. Construct the runner from `config.runner`:
   - `kind: "claude"` → `ClaudeRunner.init({ ... })`
   - `kind: "codex"` → `CodexRunner.init({ ... })`

   with `cwd`, `args`, and `env` passed through when present — and
   `env` **omitted when it is absent, so the child inherits this
   process's environment and the operator's credentials** (§3.3) —
   `timeout` passed as the configured value or `600000`, and
   `maxBuffer` passed only when present so the runner keeps its own
   default. Nothing else is passed at construction: `streamOutput`,
   `streamMode`, and `onStream` are per-run values supplied by §5.4.
   If the runner constructor throws, wrap it:
   `CTGPromptServerError("INVALID_CONFIG", <the runner error's message>, { cause })`.
3. Build `CTGPromptQueue` with the resolved config of §3.2.
4. Call `queue.recover()` (§4.3).
5. Call `queue.dispatch()`.
6. Bind the socket on `port` and the configured `host` (§3.3, default
   `"127.0.0.1"`) and resolve when it is listening.

Note steps 4 and 5: **prompts left `pending` by a previous process start
are claimed as soon as this process starts, before it accepts a request.**
That is what "the database is the work list" means operationally.

**Mutation:** constructs the runner, moves every previously-active row
to `error`, may spawn child processes, binds a socket.

> **Judgment Call 10 — the server constructs the runner from config.**
> *(Reversed in review by R24; the draft took an already-constructed
> `LLMRunner` and deliberately set no `timeout` or `maxBuffer` of its
> own, to avoid two owners of one value.)* Taking an instance meant an
> operator had to write TypeScript to start the service — it could not
> be launched from a config file or an environment — and it left the
> runner's *kind* unknown to the server, which §5.5's response
> extraction and R25's `runner` field both need. Config names the kind
> and the child-process settings; `timeout` defaults to 600000 ms and
> `maxBuffer` falls through to the runner's own default when omitted, so
> there is still exactly one owner of each value: this config.

### 4.3 Recovery

*realizes: D5, R21*

`queue.recover()` runs once, from `start`, in a single transaction, and
delegates to `db.interruptActive()`:

1. Every row with `status = 'active'` is moved to `status = 'error'`,
   `error_type = 'INTERRUPTED'`,
   `error_message = 'The prompt was active when the server stopped.'`,
   `finished_at = <now>` — one `UPDATE` statement.
2. For each row the update touched, in id order, append an `error`
   event with payload
   `{ promptId, status: "error", errorType: "INTERRUPTED", message, finishedAt }`.
3. Rows with `status = 'pending'` are **untouched**. They stay pending
   and are eligible for dispatch.
4. Return the count of rows moved.

**Why that set is exactly the interrupted prompts.** A row becomes
`active` only through the dispatch loop of a started server (§5.3), and
only in the same transaction that claims it. Recovery runs in `start`
**before** this process dispatches anything, so no row this process owns
can be active yet. A single process owns a database at a time (R14).
Therefore every row that is `active` when recovery reads the table
belongs to a process that is gone, and the count is bounded by that
process's concurrency limit — at most a handful of rows, one statement.

Nothing is re-run. Submitting again is the client's decision, and the client
learns of the interruption through the prompt's finished state and its
final event like any other failure.

> **Judgment Call 4 — `INTERRUPTED` is an outcome error type, not a
> sixth `PromptStatus`.** The lifecycle in §1 has five states and a new
> one would change the model. An interrupted prompt *is* a prompt in
> `error`; `error_type` is already the field that says why, and
> `INTERRUPTED` sits there alongside `RUNNER` and `SERVER` without
> inventing a state (§9.2).

### 4.4 close

*realizes: R23*

`close :: VOID -> PROMISE(VOID)`

1. Stop the HTTP listener and wait for it to close.
2. `subscribers.closeAll()` — every open SSE response and every waiting
   long-poll response is ended.
3. `db.close()`.

**Mutation:** closes the socket, ends every open sink, closes the
database handle. No row is written.

`close()` does **not** wait for active runs. Their child processes are
orphaned exactly as in an unexpected stop, and the next `start` moves
them to `error` as `INTERRUPTED`. Both callers of `close()` are real and
the method serves both:

- **A test** must release the port and the SQLite handle between cases;
  without `close()` a suite leaks file descriptors and a temporary
  database cannot be deleted on Windows or asserted on cleanly anywhere.
- **An operator's `SIGTERM` handler** may call it so that open SSE and
  long-poll responses end cleanly rather than being cut mid-frame; the
  client then reconnects with `Last-Event-ID` and loses nothing.

`queue.drain()` exists for tests that want to wait for in-flight runs to
settle; the service itself never calls it, and there is no graceful
drain in v1 (SQ-7).

---

## 5. CTGPromptQueue

*realizes: M, D1, D4, D5, D6, D7, R15, R18, R25*

Owns the runner, the concurrency limit, the dispatch procedure, and the
long-poll wait. It is the only component that calls `runner.run`, and
the only component that writes events during a run.

| Operation | Signature | Description | Mutates |
|---|---|---|---|
| `init` | `ctgPromptQueueConfig -> ctgPromptQueue` | Wire database, subscribers, runner | |
| `submit` | `STRING:prompt -> promptRecord` | Validate the text, insert a pending prompt, append `pending`, dispatch (§5.1) | Database: one prompt row, one event row; may start a run |
| `cancel` | `NUMBER:id -> promptRecord` | Cancel a **pending** prompt (§5.2) | Database: prompt row status, one event row |
| `read` | `NUMBER:id -> promptRecord` | Read one prompt | |
| `readWait` | `NUMBER:id, NUMBER:waitMs -> PROMISE(promptRecord)` | Long poll: resolve when finished or when `waitMs` elapses (§5.5) | Registers and deregisters one waiter |
| `list` | `promptListQuery -> promptListPage` | Page of prompts, newest first | |
| `subscribe` | `NUMBER:id, ctgPromptEventSink, NUMBER:afterSequence -> ctgPromptSubscription` | Replay history then attach live (§7.3) | Registers a subscriber |
| `recover` | `VOID -> NUMBER` | Move every active prompt to `error` as `INTERRUPTED` (§4.3) | Database: prompt rows, event rows |
| `dispatch` | `VOID -> VOID` | Start runs until the concurrency limit is reached (§5.3) | Database: claimed prompts; spawns child processes |
| `drain` | `VOID -> PROMISE(VOID)` | Resolve when no run is in flight | |

### 5.1 submit

*realizes: D1, D4, D8, R11, R26*

`submit :: STRING:prompt -> promptRecord`

1. If `prompt` is not a string, throw
   `CTGPromptServerError("INVALID_PROMPT", "Prompt must be a string.")`.
2. If `prompt.trim() === ""`, throw
   `CTGPromptServerError("INVALID_PROMPT", "Prompt must not be empty.")`.
   This covers both the empty string and whitespace-only input.
3. Compute `bytes = Buffer.byteLength(prompt, "utf8")`. If
   `bytes > maxPromptBytes`, throw
   `CTGPromptServerError("INVALID_PROMPT", "Prompt exceeds the maximum of <maxPromptBytes> bytes.", { bytes, maxPromptBytes })`.
   The message names the limit.
4. `db.insertPrompt(prompt)` — inserts the row with
   `status = 'pending'`, lets SQLite assign the id, and appends a
   `pending` event, in one transaction.
5. `subscribers.publish(id, event)`.
6. `dispatch()`.
7. Return the record.

**Mutation:** one prompt row, one event row, and possibly the start of a
run.

The text is stored **byte-for-byte as received** and passed to
`runner.run()` unchanged. There is no template, no wrapping, no trimming
of the stored value, and no client-supplied `LLMPrompt` operation.
*realizes: D4*

> **Judgment Call 5 — whitespace-only prompts are rejected.** D8 names
> the empty string. A prompt of `"   \n"` is the same client mistake with
> a different byte count, and `LLMRunner` will happily hand it to a CLI
> as an argv element. Rejecting it costs a `trim()` and prevents a class
> of accidental runs. Note that this is a *validation* trim only — the
> stored and executed text is the untrimmed original.

> **Judgment Call 6 — the limit is 131071 UTF-8 bytes, and a larger
> configured limit is refused.** *realizes: D8, R26.* `LLMRunner` passes
> the prompt as a single argv element, and Linux caps one argv element
> at 131072 bytes **including the terminating NUL** — so 131071 bytes of
> text is the true ceiling. A character count would not bound the thing
> that actually breaks, and accepting a configured limit above the
> ceiling would let the server promise a size the runner cannot pass.
> Lifting the ceiling means delivering the prompt on the child's stdin,
> which is an upstream change in `ctg-ai-agent-proc` and is listed under
> Not Implemented (§10).

### 5.2 cancel

*realizes: D6, R27*

`cancel :: NUMBER:id -> promptRecord`

Detection order, and it matters:

1. `db.readPrompt(id)`. If undefined, throw
   `CTGPromptServerError("PROMPT_NOT_FOUND")`.
2. If `status === "active"`, throw
   `CTGPromptServerError("CANCEL_NOT_ALLOWED", "An active prompt cannot be cancelled.", { id, status })`.
3. If `status` is `done`, `error`, or `cancelled`, throw
   `CTGPromptServerError("CANCEL_NOT_ALLOWED", "The prompt is already finished.", { id, status })`.
4. `db.cancelPending(id)` — a conditional update
   (`WHERE id = ? AND status = 'pending'`) plus a `cancelled` event, in
   one transaction. If the update affected zero rows, the prompt changed
   state between step 1 and step 4; throw `CANCEL_NOT_ALLOWED` with the
   re-read status.
5. `subscribers.publish(id, event)`, then `subscribers.closePrompt(id)`
   — `cancelled` is finished, so every open stream and every waiter for
   this prompt ends.
6. Return the record.

**Mutation:** one prompt row updated, one event row written, every
subscriber for this id closed.

Step 4's conditional update is not defensive noise: it is what makes
cancel and `claimNextPending` mutually exclusive without a lock. A
prompt is either claimed or cancelled, never both, because both are
`WHERE status = 'pending'` updates and SQLite serializes them.

An active prompt runs to completion, or to the runner's `timeout`. There
is no abort path in v1 (§10).

### 5.3 The dispatch procedure

*realizes: D7, M, R18*

This is the correctness core. `dispatch()` is **synchronous** and takes
no arguments. `_active` is a `Set<number>` of prompt ids currently in
flight, keyed by the integer id (R18).

1. Repeat until step 2 or step 3 exits:
2. If `_active.size >= concurrency`, return.
3. Call `db.claimNextPending(runnerKind)`. If it returns `undefined` —
   no pending prompt exists — return.
4. Add `claimed.prompt.id` to `_active`. **This happens synchronously,
   before any `await` or promise creation.**
5. `subscribers.publish(id, claimed.event)` — the `active` lifecycle
   event.
6. Call `this._execute(claimed.prompt)`. `_execute` is `async`, so
   calling it returns a promise; **the promise is not awaited here.**
   Attach:
   ```
   promise.finally(() => { this._active.delete(id); this.dispatch(); })
   ```
7. Continue the loop from step 2.

**Mutation:** each iteration moves one row from `pending` to `active`,
writes one event row, and spawns one child process.

Three properties, each following from a specific step:

- **Never more than the limit.** `_active` grows in step 4 with no
  intervening suspension point, and step 2 tests it before every claim.
  Node's single thread cannot interleave another `dispatch()` between
  steps 2 and 4, because there is no `await` between them.
- **Never the same prompt twice.** `claimNextPending` flips the row to
  `active` in the same transaction that reads it (§6.3). A second claim
  cannot see it as pending, whether that claim comes from the same loop
  iteration, a later `dispatch()`, or recovery.
- **A synchronously-throwing runner does not wedge the dispatcher.**
  `_execute` is declared `async`, so a synchronous throw inside
  `runner.run` becomes a rejection of `_execute`'s promise, which
  `_execute`'s own `try`/`catch` (§5.4) records as an outcome. Even if
  `_execute` itself threw, step 6's `.finally()` still removes the id
  and re-dispatches — the dispatcher keeps moving.

`dispatch()` is called from exactly four places: `start` (§4.2 step 5),
`submit` (§5.1 step 6), the `.finally()` in step 6, and tests.

> **Judgment Call 7 — `_active` is a set of ids, not a counter.** A
> counter would prove the limit but not the no-double-dispatch property.
> The set makes `count`, `has`, and the drain condition all directly
> observable, and an id appearing twice is a detectable bug rather than
> an invisible increment. The ids are the integer primary keys (R18), so
> the set is the same identity the database, the routes, and the cursor
> use.

### 5.4 Executing a prompt

*realizes: M, D1, D4, R15, R21, R24*

`_execute :: promptRecord -> PROMISE(VOID)`. Steps, in order:

1. Build the stream handler:
   ```
   onStream = (event: LLMRunnerStreamEvent) => this._recordStreamEvent(prompt.id, event)
   ```
2. Call:
   ```
   runner.run(prompt.prompt, {
       streamOutput: true,
       streamMode: this._streamMode,
       onStream
   })
   ```
   Nothing else is passed. No per-run `args`, no runner selection, no
   text transformation. *realizes: D1, D4*
3. `await` the call inside `try`/`catch`.
4. **On resolution** with `LLMRunnerResult { result, error }`:
   a. `db.finishPrompt(id, { status: "done", response: result, info: { stderr: error } })`
      — writes `response`, `finished_at`, `status`, and `info`, and
      appends a `done` event, in one transaction.
   b. `subscribers.publish`, then `subscribers.closePrompt(id)`.
5. **On rejection or throw** with `cause`, the outcome error type is
   always `RUNNER` (§9.2):
   a. If `LLMRunnerError.is(cause)`, then `errorMessage = cause.msg` and
      `info = { runnerErrorType: cause.type, runnerErrorData: cause.data }`.
      This spec does not enumerate `LLMRunnerError`'s types; whatever
      `ctg-ai-agent-proc` defines is recorded as given.
   b. Otherwise `errorMessage` is `cause.message` when `cause` is an
      `Error` and `String(cause)` when it is not, and `info` is
      `{ thrown: <the constructor name or typeof> }`.
   c. `db.finishPrompt(id, { status: "error", errorType: "RUNNER", errorMessage, info })`.
   d. `subscribers.publish`, then `subscribers.closePrompt(id)`.
6. **If the server's own code fails** while the prompt is active — the
   concrete case is `CTGPromptDB` throwing while appending an event or
   writing the outcome — the outcome error type is `SERVER`:
   `db.finishPrompt(id, { status: "error", errorType: "SERVER", errorMessage: <the server error's message>, info: { type: <the server error's type> } })`.
   If that write also fails, nothing more can be recorded; the id is
   still removed from `_active` by §5.3 step 6 and the row is left
   `active`, where the next `start`'s recovery moves it to `error` as
   `INTERRUPTED`.

**Mutation:** one prompt row moved to a finished state, one event row
written, every subscriber for this id closed.

**The runner's stderr is not an error.** `LLMRunnerResult` has exactly
the keys `result` and `error`, being stdout and stderr
(`ctg-ai-agent-proc` §2.2, RUN-06), and a successful run can produce
plenty of stderr. It is recorded in `info` — operator-only, never
serialized (R11) — and never in `error_message`, which is set only when
`status` is `error` (R17). `status` is the authority on whether a prompt
ended in error.

> **Judgment Call 8 — `streamOutput: true` on every run.** `LLMRunner`
> defaults to the buffered `execFile` path, which emits no events and
> settles only at exit. This service's entire value is the event stream
> and the `response` text built from it as the run proceeds (§5.5, R15),
> so the streaming `spawn` path is not an option, it is the only path.
> The cost, taken deliberately: the `spawn` path implements `timeout`
> and `maxBuffer` itself rather than delegating to `execFile`, which is
> a smaller amount of upstream code exercised.

> **Judgment Call 9 — `streamMode` defaults to `"events"`, with `"raw"`
> selectable in server config.** `"events"` makes `ClaudeRunner` and
> `CodexRunner` emit their runner-native event classes
> (`ClaudeRunnerEvent`, `CodexRunnerEvent`) parsed from the vendor's
> structured mode, which is strictly more information than raw stdout
> chunks and is what lets `response` accumulate assistant text rather
> than protocol noise (§5.5). `"raw"` remains selectable for an operator
> who wants the unparsed stdout stream, and for a runner with no
> structured mode, which under `"events"` emits `LLMRunnerOutputEvent`s
> and nothing else.

### 5.5 The response column and long polling

*realizes: R7, R15, R16*

**Accumulating `response`.** The `response` column is built as the run
proceeds, so a client polling `GET /prompt/:id` sees text before the run
is over. Every append happens **in the same transaction that stores the
event that produced it** — `db.appendEvent(id, name, payload, appendResponse)`
— so `response` and the events table can never disagree.

Which events contribute depends on `streamMode`:

| `streamMode` | Contributes to `response` | Stored as events only |
|---|---|---|
| `"raw"` | Every `output` event whose `stream` is `"stdout"`; its `chunk` is appended | `output` events on `stderr` |
| `"events"` | Only assistant-text `stream` events (see below); the extracted text is appended | every other `stream` event — tool activity, usage, reasoning, session metadata — and `output` events on `stderr` |

Assistant text in `"events"` mode is identified from the event payload
by the runner kind, which the server knows because it constructed the
runner (R24):

| `runner` | Assistant text is | Extraction |
|---|---|---|
| `claude` | a payload with a `message.content` array | concatenate the `text` of every array entry that has a string `text`; skip when the concatenation is empty |
| `claude` | a payload with a string `result` | nothing during the run — this is the run's reconstructed final text, and §5.4 step 4 writes it over `response` when the run resolves |
| `codex` | a payload whose `item` has `type: "agent_message"` and a string `text` | that string |
| `codex` | a payload whose `item` has `type: "message"`, `role: "assistant"`, and a `content` array | concatenate the `text` of every array entry that has a string `text` |

This mirrors the extraction `ClaudeRunner` and `CodexRunner` perform to
reconstruct their own final result, so the accumulated text and the
runner's result converge on the same string.

**The final write wins.** When the run resolves, §5.4 step 4 writes
`LLMRunnerResult.result` over `response`. The accumulated text and the
runner's result should be identical; if they are not, **the runner's
result is authoritative** — it is the value the runner itself vouches
for. A mismatch is not silently trusted: it means either this spec's
extraction table or the runner's reconstruction has drifted from the
vendor's output shape, and it is worth surfacing to an operator. The
conformance suite asserts the two agree for every scripted run (§11).

**Long polling.** `readWait :: NUMBER:id, NUMBER:waitMs -> PROMISE(promptRecord)`

1. Clamp: `waitMs = Math.min(Math.max(waitMs, 0), maxWaitMs)`. A larger
   value is **clamped, not rejected** (R7) — a client that asks for more
   patience than the server offers gets what the server offers.
2. `db.readPrompt(id)`. If undefined, throw `PROMPT_NOT_FOUND`.
3. If the status is finished, return the record now.
4. Register a waiter: `subscribers.add(id, sink)` where `sink.write` is
   a no-op and `sink.end()` resolves the wait. **This is the same
   subscriber mechanism the SSE route uses** — the finish path already
   calls `closePrompt(id)`, which ends every sink for the prompt, so a
   waiter needs no separate notification channel.
5. Re-read the record. If it is now finished, close the subscription and
   return it — this closes the window between steps 2 and 4.
6. Start a timer for `waitMs` that resolves the wait.
7. Await the wait. In a `finally`, clear the timer and close the
   subscription.
8. Re-read the record and return it, **finished or not**.

**Mutation:** registers and then deregisters one subscriber. No row is
written.

Steps 4 and 5 are one synchronous block; `node:sqlite` is synchronous
and events are only appended from the dispatcher's async continuations,
so nothing can finish between the registration and the re-read.

The response is `200` in both cases — finished and timed out — and the
client inspects `status` (R7). A timeout is not an error: the prompt is
still active and the client may poll again.

> **Judgment Call 20 — long polling exists because the first consumer
> cannot hold a stream.** *realizes: R7.* The first consumer is a PHP
> retrieval-augmented-generation system whose request handlers are
> short-lived and synchronous: they submit a prompt and need the answer
> inside the same request, and they have no event loop in which to hold
> an SSE connection open. `GET /prompt/:id?wait=<ms>` gives them a
> single blocking call with a bounded cost. The server itself is not
> blocked — a waiter is a registered sink and a timer, not a held
> thread. SSE remains the interface for clients that can stream, and
> both are projections of the same events table.

---

## 6. CTGPromptDB

*realizes: M, D3, D5, D6, D8, R12, R13, R15, R17, R19*

A synchronous database over `node:sqlite`. It knows about prompts,
events, sequence allocation, and response accumulation. It does not know
about HTTP, subscribers, or the runner.

**`node:sqlite` is experimental in Node 22 and emits an
`ExperimentalWarning` on import.** This is accepted (D3). No flag is
set, and the warning is not suppressed — suppressing it would hide the
same warning class from anything else in the process.

| Operation | Signature | Description | Mutates |
|---|---|---|---|
| `init` | `ctgPromptDBConfig -> ctgPromptDB` | Open the database, apply pragmas, create the schema | Creates tables and indexes if absent |
| `insertPrompt` | `STRING:prompt -> promptRecord` | Insert a pending prompt and its `pending` event | One prompt row, one event row |
| `readPrompt` | `NUMBER:id -> promptRecord?` | Read one prompt, or undefined | |
| `listPrompts` | `promptListQuery -> promptListPage` | Page of prompts by id descending (§6.4) | |
| `claimNextPending` | `RUNNER_KIND -> claimedPrompt?` | Claim the oldest pending prompt (§6.3) | One prompt row to `active`, one event row |
| `finishPrompt` | `NUMBER:id, promptOutcome -> appendedEvent` | Record a finished outcome and its event | One prompt row, one event row |
| `cancelPending` | `NUMBER:id -> appendedEvent` | Move a pending prompt to `cancelled` | One prompt row, one event row |
| `interruptActive` | `VOID -> NUMBER` | Move every active prompt to `error` as `INTERRUPTED` (§4.3) | N prompt rows, N event rows |
| `appendEvent` | `NUMBER:id, PROMPT_EVENT_NAME, UNKNOWN, STRING? -> appendedEvent` | Append one event at the next sequence, optionally appending text to `response` in the same transaction | One event row, the prompt's `next_sequence`, possibly `response` |
| `readEvents` | `NUMBER:id, NUMBER:afterSequence -> [eventRecord]` | Events with `sequence > afterSequence`, ascending | |
| `lastSequence` | `NUMBER:id -> NUMBER` | Highest sequence written for the prompt; 0 if none | |
| `purgeFinished` | `VOID -> NUMBER` | Delete finished prompts and, by cascade, their events (§6.6) | Rows deleted |
| `close` | `VOID -> VOID` | Close the database handle | Closes the handle |

### 6.1 Schema

*realizes: R12, R13, R17*

```sql
CREATE TABLE IF NOT EXISTS prompts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    status        TEXT    NOT NULL,
    prompt        TEXT    NOT NULL,
    response      TEXT    NOT NULL DEFAULT '',
    error_type    TEXT,
    error_message TEXT,
    info          TEXT,
    runner        TEXT,
    next_sequence INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL,
    started_at    INTEGER,
    finished_at   INTEGER
);

CREATE TABLE IF NOT EXISTS events (
    prompt_id  INTEGER NOT NULL REFERENCES prompts (id) ON DELETE CASCADE,
    sequence   INTEGER NOT NULL,
    name       TEXT    NOT NULL,
    payload    TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (prompt_id, sequence)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS prompts_status_id
    ON prompts (status, id);
```

Column notes, because each one is load-bearing:

| Column | Why it is shaped this way |
|---|---|
| `prompts.id` | `INTEGER PRIMARY KEY AUTOINCREMENT` — the single identity of a prompt. It is what the client receives, what every route takes, the FIFO order the dispatcher claims in, and the pagination cursor (R12). `AUTOINCREMENT` makes SQLite draw from `sqlite_sequence` and **never reuse an ordinal after a delete**; plain `rowid` would reuse the highest value after a purge, and a new prompt could then sort ahead of an older pending one. |
| `prompts.response` | The text accumulated during the run (§5.5), overwritten by the runner's final result when the run resolves. `NOT NULL DEFAULT ''` so a client never has to distinguish "no response yet" from `NULL`. |
| `prompts.error_type` | One of the three outcome error types (§9.2). Set only when `status` is `error`, `NULL` otherwise. |
| `prompts.error_message` | The failure message. Set only when `status` is `error`, `NULL` otherwise. It is never used for a successful run's stderr — that goes to `info` (R17). |
| `prompts.info` | JSON text, or NULL. Operator-only diagnostics: the runner's stderr from **any** run including a successful one, an `LLMRunnerError`'s `type` and `data` (`exitCode`, `signal`, partial `stdout`/`stderr`), and the like. **Never serialized over HTTP on any route** (R11). |
| `prompts.runner` | The runner kind (`"claude"` or `"codex"`) bound when the prompt was claimed, so a client reading the record or the `active` event knows which vendor shape the payloads have (R25). `NULL` while pending. |
| `prompts.next_sequence` | The per-prompt sequence allocator. Reading and incrementing it inside the append transaction is what makes sequences gap-free and monotonic (§6.2). |
| `events` `WITHOUT ROWID` | The primary key `(prompt_id, sequence)` is the only access path — replay is always "this prompt, above this sequence". A rowid would be dead weight on the table this service writes most. |
| `events.prompt_id` FK | Declared with `ON DELETE CASCADE` (R13). See the judgment call below. |
| `prompts_status_id` | Serves `claimNextPending` (`status = 'pending' ORDER BY id`), the status-filtered list, and `interruptActive`. |

**Pragmas applied at open, in this order:**

1. `PRAGMA journal_mode = WAL;` — a subscriber replaying history reads
   while the dispatcher writes.
2. `PRAGMA foreign_keys = ON;` — required, not decorative: the
   `events.prompt_id` foreign key is only enforced when it is on, and
   `node:sqlite` leaves it off by default (R13).
3. `PRAGMA busy_timeout = 5000;` — the purge script is a second
   connection to the same file.

> **Judgment Call 11 — the `events.prompt_id` foreign key is declared,
> with `ON DELETE CASCADE`, and `foreign_keys` is on.** *(Reversed in
> review by R13; the draft declared no foreign key on the grounds that
> the database's own transactions already guaranteed it.)* The reason
> for the reversal is failure mode, not enforcement in the happy path: a
> bad write — an event appended for an id that is not there, a purge
> that deletes prompts without their events — surfaces immediately as a
> constraint violation, which becomes `STORE_FAILED` on a request or the
> `SERVER` outcome type on a run, instead of leaving the database
> silently inconsistent for a later reader to discover. The cascade also
> makes the purge one statement (§6.6).

### 6.2 Sequence allocation

*realizes: M, R15*

Every event insert runs this, inside a transaction:

1. `SELECT next_sequence FROM prompts WHERE id = ?`. If no row, throw
   `CTGPromptServerError("PROMPT_NOT_FOUND")`.
2. `sequence = next_sequence`.
3. `INSERT INTO events (prompt_id, sequence, name, payload, created_at)
   VALUES (?, ?, ?, ?, ?)` with `payload = JSON.stringify(payload)`.
4. `UPDATE prompts SET next_sequence = next_sequence + 1` — and, when
   `appendResponse` was supplied, `response = response || ?` in the same
   statement — `WHERE id = ?`.
5. Commit.

Sequences therefore start at **1**, increase by exactly 1, and have no
gaps: the allocation and the insert are the same transaction, so a
rolled-back insert also rolls back the increment. `MAX(sequence)` is
never used for allocation — it would reuse a number after a delete, and
`Last-Event-ID` resumption depends on numbers never being reused.

Step 4 is also why `response` can never get ahead of or behind the
events table: the text an event contributed and the event itself are one
commit (R15).

Every operation that changes a prompt's state does its `UPDATE` and its
event append in **one** transaction. A row that says `done` always has a
`done` event, and the reverse.

### 6.3 claimNextPending

*realizes: D7, M, R25*

`claimNextPending :: RUNNER_KIND -> claimedPrompt?`, in one transaction:

1. `SELECT * FROM prompts WHERE status = 'pending' ORDER BY id ASC LIMIT 1`.
2. If no row, roll back and return `undefined`.
3. `UPDATE prompts SET status = 'active', started_at = ?, runner = ? WHERE id = ? AND status = 'pending'`.
4. If the update reported 0 changes, roll back and **return to step 1**
   (the prompt was cancelled between the read and the update).
5. `appendEvent(id, "active", { promptId, status: "active", runner, startedAt })`.
6. Commit and return `{ prompt, event }` with the record re-read
   post-update.

The `AND status = 'pending'` in step 3 is the guard that makes claim and
cancel mutually exclusive (§5.2). The `runner` written in step 3 and
carried in step 5's payload is what tells a client which vendor shape
the following event payloads have (R25).

### 6.4 listPrompts

*realizes: R12*

`listPrompts :: promptListQuery -> promptListPage`

1. Base query: `SELECT * FROM prompts`.
2. If `status` is present, add `WHERE status = ?`.
3. If `before` is present, add `id < ?`.
4. `ORDER BY id DESC LIMIT ?`, with `limit + 1` rows requested.
5. If `limit + 1` rows came back, drop the extra and set `nextBefore` to
   the `id` of the **last returned** prompt. Otherwise
   `nextBefore = null`.

> **Judgment Call 12 — cursor pagination on `id`, not offset/limit.**
> `id` is monotonic and never reused, so a cursor page is stable while
> prompts are being submitted; an `OFFSET` page shifts under the reader
> on every new submit. The cursor is also the same number FIFO order and
> client identity are defined on, so there is one ordering concept in
> the system rather than two (R12).

### 6.5 Reading events

`readEvents :: NUMBER:id, NUMBER:afterSequence -> [eventRecord]` runs
`SELECT ... WHERE prompt_id = ? AND sequence > ? ORDER BY sequence ASC`
and parses each `payload` with `JSON.parse`. `afterSequence = 0` returns
the whole history.

### 6.6 purgeFinished

*realizes: D8, R5, R13, R19*

`purgeFinished :: VOID -> NUMBER`, one transaction:

1. `DELETE FROM prompts WHERE status IN ('done','error','cancelled')`.
2. The declared foreign key's `ON DELETE CASCADE` removes every event
   row belonging to a deleted prompt, inside the same transaction
   (R13).
3. Commit. Return the number of prompt rows deleted.

`pending` and `active` rows, and their events, are untouched.

Prompts and events are otherwise **kept forever**. There is no TTL, no
row cap, and no background sweep. The purge is an operator command:

```json
"scripts": { "purge-finished": "tsx scripts/purge-finished.ts" }
```

The script opens the database directly —
`CTGPromptDB.init({ path }).purgeFinished()` — prints the count, and
calls `close()`. It is not an HTTP route: deleting history is not
something a client holding the API key should be able to do.

> **Judgment Call 13 — the purge script uses `CTGPromptDB` directly, not
> a server.** *(Reversed in review by R19; the draft constructed a server
> so the script would inherit config validation.)* A purge is a database
> operation, and going through a server made the script construct a
> runner, run recovery, and require an API key it never uses — side
> effects an operator asking to delete finished rows did not ask for.
> The script needs one config value, the database path, and
> `CTGPromptDB` is what owns it.

---

## 7. Events and the stream

### 7.1 Event names

*realizes: M, R4*

| Name | Kind | Written when |
|---|---|---|
| `pending` | lifecycle | A prompt is submitted |
| `active` | lifecycle | A prompt is claimed by the dispatcher; payload carries the runner kind (R25) |
| `output` | runner | An `LLMRunnerOutputEvent` is received |
| `stream` | runner | Any other `LLMRunnerStreamEvent` is received |
| `done` | lifecycle | `runner.run` resolved |
| `error` | lifecycle | `runner.run` rejected, the server's own code threw, or recovery found the prompt active |
| `cancelled` | lifecycle | A pending prompt was cancelled |

Lifecycle event names are exactly the five statuses (R4). `done`,
`error`, and `cancelled` are the **finished** events. Exactly one
finished event exists per prompt, and it is always the highest sequence.
The `error` event's payload carries the outcome error type of §9.2.

### 7.2 Mapping runner events to rows

*realizes: M, D2, R15*

`_recordStreamEvent :: NUMBER:promptId, llmRunnerStreamEvent -> VOID`.
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

Then, in this order: compute the response contribution from §5.5, call
`db.appendEvent(promptId, name, payload, contribution)`, then
`subscribers.publish(promptId, event)`. **Store first, publish second,
always.** A subscriber must never see an event that is not yet
replayable, or a reconnect would lose it.

If `appendEvent` throws, the exception is caught and the run continues;
the failure is recorded as the `SERVER` outcome type when the run
settles (§5.4 step 6). `LLMRunner` already isolates `onStream` failures
so an observer cannot change child-process semantics; this server does
not rely on that, but it does not fight it either.

> **Judgment Call 14 — runner event payloads are stored as JSON text of
> whatever the runner emitted, not normalized.** `ctg-ai-agent-proc`
> deliberately keeps text, usage, reasoning, and tool activity inside the
> runner-native payload rather than normalizing them into base event
> classes (upstream spec G-7B). Normalizing here would re-introduce
> exactly the coupling upstream rejected, and would silently drop fields
> whenever a vendor added one. The record and the `active` event carry
> the runner kind (R25) so a client can interpret the payloads without
> the server having to flatten them.

### 7.3 The SSE projection

*realizes: M, D2, R6, R10*

`GET /prompt/:id/events`. Response headers:

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

`id:` is the per-prompt sequence number, which is what makes
`Last-Event-ID` work. `data:` is always exactly one line — payloads are
`JSON.stringify`'d, which escapes newlines, so no multi-line `data:`
continuation is ever needed.

**Subscribe procedure**, in order, because the ordering is the whole
correctness argument:

1. Resolve `afterSequence`: the `Last-Event-ID` request header parsed as
   a base-10 integer; `0` if the header is absent, non-numeric, or
   negative.
2. `db.readPrompt(id)`. If undefined, respond `404` with the standard
   JSON error envelope and **no SSE stream** — the client asked about a
   prompt that does not exist, and an empty event stream would look like
   a prompt that has not started.
3. Write the SSE headers and flush them.
4. `subscribers.add(id, sink)` — register **before** reading history.
5. `db.readEvents(id, afterSequence)` and write each one.
6. If the last written event was a finished event, `end()` the response
   and `close()` the subscription; done.
7. Otherwise start the keep-alive timer and leave the response open. The
   subscription writes each subsequently published event, and ends the
   response after writing a finished one.

**Mutation:** registers a subscriber and, on close, deregisters it. No
row is written.

Steps 4 and 5 are **one synchronous block with no `await` between
them**. `node:sqlite` is synchronous and events are only appended from
the dispatcher's async continuations, so no event can be committed
between registration and replay. This is why no in-memory buffering step
is needed. As a second guard, each subscription records the highest
sequence it has written and drops any published event whose sequence is
not greater — so a live event that was also in the replay is written
once, not twice.

**Boundary behaviors:**

| Condition | Behavior |
|---|---|
| Unknown id | `404` JSON envelope, no stream |
| Non-integer `:id` segment | `400` `INVALID_QUERY`, no stream (§8.1) |
| `Last-Event-ID` absent | Full history from sequence 1 |
| `Last-Event-ID` ≥ last sequence, prompt finished | Headers, no events, immediate `end()` |
| `Last-Event-ID` ≥ last sequence, prompt not finished | Headers, no events, stream stays open for the live tail |
| `Last-Event-ID` malformed | Treated as `0` — full history |
| Prompt already finished | Full history, then `end()` — the connection does not linger |
| Client disconnects | The response's `close` event fires `subscription.close()`, deregistering the sink and clearing the keep-alive timer |

**Keep-alive:** while a stream is open, a comment line `: keep-alive`
followed by a blank line is written every `keepAliveMs` (default
15000). Comment lines are ignored by every SSE client and carry no `id:`,
so they cannot disturb resumption. The timer is cleared when the stream
ends for any reason.

> **Judgment Call 15 — the stream closes after the finished event rather
> than staying open.** A prompt has exactly one finished event and can
> produce nothing after it, so an open connection past that point is a
> socket held for no reason. Closing also gives the client an
> unambiguous end signal. Clients are server-side (R10), so the
> auto-reconnect behavior of a browser `EventSource` is not a
> consideration here; a `fetch` stream reader stops on the finished
> event.

> **Judgment Call 16 — subscribers are held per prompt id, keyed in a
> `Map<number, Set<subscription>>`.** Multiple subscribers per prompt are
> supported and needed (an operator watching a prompt a client is
> already streaming, or a long-poll waiter alongside a stream).
> Publishing is a fan-out over the set; a sink that throws on `write` is
> closed and dropped rather than aborting the fan-out to the others.

---

## 8. HTTP surface

*realizes: D1, D2, D6, D7, D10, R6, R7, R8, R9, R11*

Express is the HTTP host. It supplies routing, the JSON body parser, and
response writing — and nothing else. Every behavior below is specified
here rather than inherited.

> **Judgment Call 17 — Express, overriding `ctg-ts-web-server` SQ-1.**
> That rule — "depend on things that solve a hard mechanical problem,
> not on things that define behavior" — was written for a **reusable
> library** whose observable behavior has to be reproducible in another
> host, and where CORS matching and header sets *were* the library's
> behavior. This project is a **service**, and its behavior is the model
> in §1: the dispatch order, the sequence, the durable stream. Express
> supplies path matching and `res.write` — the mechanical part — and
> touches none of it. Adopting the rule here would mean re-deriving a
> router to protect semantics the router never touches. The rule is not
> repealed; it is applied to a different kind of artifact and comes out
> the other way. The bound stays: `express` and `ctg-ai-agent-proc`,
> plus Node built-ins, and anything further is a surfaced question, not
> a decision.

### 8.1 Routes

*realizes: R6, R7*

| Method | Path | Success | Query / Body |
|---|---|---|---|
| `POST` | `/prompt` | `202` | `{ "prompt": string }` |
| `GET` | `/prompt/:id` | `200` | `?wait=<ms>` |
| `GET` | `/prompt/:id/events` | `200` (SSE) | `Last-Event-ID` header |
| `DELETE` | `/prompt/:id` | `200` | — |
| `GET` | `/prompts` | `200` | `?limit=`, `?before=` |
| `GET` | `/prompts/:status` | `200` | `?limit=`, `?before=` |

There is no route that is not in this table. In particular there is no
health route, no metrics route, no purge route (§6.6), and no route that
lists or names runners — the server has one runner and the client cannot
choose it (D1).

`:id` must be a base-10 integer of one or more digits. Anything else is
`INVALID_QUERY` (400) — the segment did not parse, which is a
malformed request, not a missing prompt.

**`POST /prompt`** — *realizes: D1, D4, D8, R11, R26*

1. Reject if `Content-Type` is not `application/json`
   (`INVALID_CONTENT_TYPE`, 415).
2. Body must be a JSON object with a `prompt` property
   (`INVALID_BODY`, 400).
3. `queue.submit(body.prompt)` — which raises `INVALID_PROMPT` for
   non-strings, empty or whitespace-only text, and oversized text
   (§5.1).
4. Respond `202` with the record, serialized as in §8.3.

`202 Accepted` and not `201 Created`: the client is told the prompt was
accepted for later processing, which is exactly what happened. Any
property of the body other than `prompt` is ignored — there is no runner
name, no per-run args, and no stream mode to accept (D1).

**`GET /prompt/:id`** — *realizes: R7, R16*

1. `404` `PROMPT_NOT_FOUND` for an unknown id.
2. Without `wait`, respond immediately with the record.
3. With `wait`, it must be a base-10 integer `>= 0`; anything else is
   `INVALID_QUERY` (400). A value above `maxWaitMs` is **clamped, not
   rejected** (R7). The response is held until the prompt is finished or
   the clamped `wait` elapses, then the record is returned either way —
   `200` in both cases, and the client inspects `status` (§5.5).

The record carries `response` **as it stands** and `lastSequence`, the
highest event sequence written so far, so a polling client sees the text
grow and knows how far the event history has advanced (R16). Events
themselves are not included on this route (SQ-5).

**`DELETE /prompt/:id`** — `queue.cancel(id)`; `404` for unknown, `409`
`CANCEL_NOT_ALLOWED` for an active or finished prompt (§5.2). Result is
the updated record. `DELETE` is the method because cancelling is the
client withdrawing the prompt it created, and the route is the prompt's
own path.

**`GET /prompts`** and **`GET /prompts/:status`** — a page of records,
newest first. `limit` must be an integer in `1..maxLimit`; `before` must
be a positive integer. On the second route, `:status` must be exactly
one of the five `PromptStatus` values; **any other segment, including a
name for a set of statuses, is `INVALID_QUERY` (400)** (R4). Any
violation is `INVALID_QUERY` (400). Result is
`{ prompts, nextBefore }` with each record in the shape of §8.3.

### 8.2 Authentication

*realizes: D10, R8*

**Every route requires the key, including the SSE route.** The check is
Express middleware mounted before the routes, so a route added without
thinking about auth is still covered.

Header: **`Authorization: Bearer <key>`**.

The scheme token is compared case-insensitively; the key is compared
with `crypto.timingSafeEqual` over UTF-8 buffers, guarded by a length
check first (`timingSafeEqual` throws on length mismatch). A missing
header, a header with a different scheme, an empty key, and a
non-matching key all produce the same `401` `UNAUTHORIZED` with the
message `Invalid or missing credentials.` — the response never reveals
which of the four it was. The `WWW-Authenticate` response header is not
sent, because there is no challenge a client can respond to.

**The key is what makes a non-loopback listener acceptable.** The
deployment of §1.1 binds to the Docker bridge or to `0.0.0.0` so a
container can reach the service, which means the port is exposed to
every process that can route to that address. Every route requires the
key, including the SSE route and the long poll, so exposure of the port
is not exposure of the runner. An operator who widens `host` without
setting a strong `apiKey` has no protection — and `init` refuses to
start without a key at all (§4.1).

> **Judgment Call 18 — `Authorization: Bearer`, not a custom header.**
> *(Reversed in review by R8; the draft used a custom header on the
> grounds that a static key has none of a bearer token's expiry, issuer,
> or revocation semantics.)* The reversal is about the consumer: clients
> are server-side HTTP libraries, and every one of them has
> first-class support for an `Authorization` header — retained across
> redirects, redacted in logs, settable once on a client object — while
> a custom header is a per-request string each caller has to remember.
> The header is the standard place credentials go, and `Bearer` is the
> standard scheme for an opaque one. That this particular bearer token
> never expires is a property of the deployment, not a reason to invent
> a header.

### 8.3 Response envelope

*realizes: R9, R11*

One shape, stated once. **This is the CTG api-server envelope**, so the
CTG PHP api-client decodes a response from this service unchanged — no
adapter, no second decoder. The first consumer is a PHP system using
that client (R7, R9).

| Case | Status | Body |
|---|---|---|
| Success | 200 / 202 | `{ "success": true, "result": <data> }` |
| Any error | from the error | `{ "success": false, "result": { "type": <string>, "code": <int>, "message": <string> } }` |
| SSE stream | 200 | *not an envelope* — `text/event-stream` (§7.3) |

A prompt appears in `result` with exactly these fields, and no others:

```
id, status, prompt, response, errorType, errorMessage,
runner, lastSequence, createdAt, startedAt, finishedAt
```

`prompt` **is** returned — the client sent it, and a prompt whose text
cannot be read back is not inspectable (R11). `info` is **never**
serialized on any route (R11): it holds process diagnostics, including
stderr and partial output, and it is for the operator reading the
database, not for the client.

The error branch never includes a stack trace, and
`CTGPromptServerError.data` is never serialized into the response. Both
stay server-side.

> **Judgment Call 21 — `prompt` and `response` are returned; `info` is
> not.** The client's own input and the answer it asked for are the
> point of the service. Diagnostics that can contain fragments of
> process output belong to whoever runs the process.

### 8.4 Error handling

*realizes: R20*

An Express error handler is the single place a thrown error becomes a
response:

1. `CTGPromptServerError.is(err)` **and** `err.status` is a number →
   that status, body from `err.toResult()`.
2. Anything else — including a `CTGPromptServerError` carrying an
   outcome error type, which has no HTTP status and should never reach a
   request — → `500` with type `INTERNAL_ERROR`, code `1012`, message
   `Internal error.` The original error is not exposed.

An unmatched path is `404` `NOT_FOUND`; an unmatched method on a matched
path is `405` `METHOD_NOT_ALLOWED`.

Errors on an **already-open SSE stream** cannot be responses — headers
are sent. The stream is ended, the subscription is closed, and nothing
further is written. The client reconnects with `Last-Event-ID` and loses
nothing, because the durable events table is the stream.

---

## 9. CTGPromptServerError

*realizes: D2, D8, D10, R20, R21, R22*

Follows the CTG error convention: extends `Error`, bidirectional `TYPES`
map with integer codes, `type` / `msg` / `data`, and a `status` for the
HTTP layer.

```typescript
type PromptRequestErrorType =
    | "INVALID_CONFIG" | "UNAUTHORIZED" | "INVALID_CONTENT_TYPE"
    | "INVALID_BODY" | "INVALID_PROMPT" | "INVALID_QUERY"
    | "PROMPT_NOT_FOUND" | "CANCEL_NOT_ALLOWED" | "NOT_FOUND"
    | "METHOD_NOT_ALLOWED" | "STORE_FAILED" | "INTERNAL_ERROR";

type PromptServerErrorType = PromptRequestErrorType | PromptOutcomeErrorType;
```

One `TYPES` map holds both groups, and codes are contiguous across them
(R22). Request types carry an HTTP status; outcome types do not.

### 9.1 Request errors

**Every error this system raises in response to a request.** Nothing is
invented ad hoc in prose anywhere else in this document.

| Type | Code | HTTP | Raised when |
|---|---|---|---|
| `INVALID_CONFIG` | 1001 | — | Any check in §4.1 fails, or the runner constructor throws in §4.2. Never reaches HTTP: the server does not start. |
| `UNAUTHORIZED` | 1002 | 401 | `Authorization: Bearer` is missing, uses another scheme, is empty, or does not match (§8.2) |
| `INVALID_CONTENT_TYPE` | 1003 | 415 | `POST /prompt` without `application/json` |
| `INVALID_BODY` | 1004 | 400 | Body is not a JSON object, or has no `prompt` property |
| `INVALID_PROMPT` | 1005 | 400 | Text is not a string, is empty or whitespace-only, or exceeds `maxPromptBytes` (§5.1) |
| `INVALID_QUERY` | 1006 | 400 | Non-integer `:id`, unrecognized `:status` segment, or bad `limit`, `before`, or `wait` |
| `PROMPT_NOT_FOUND` | 1007 | 404 | No prompt with that id, on read, cancel, subscribe, or event append |
| `CANCEL_NOT_ALLOWED` | 1008 | 409 | Cancelling an active or finished prompt (§5.2) |
| `NOT_FOUND` | 1009 | 404 | No route matches the path |
| `METHOD_NOT_ALLOWED` | 1010 | 405 | Path matches, method does not |
| `STORE_FAILED` | 1011 | 500 | A `node:sqlite` operation threw while serving a request; the underlying error is `data.cause` |
| `INTERNAL_ERROR` | 1012 | 500 | Anything unhandled reaching the error handler, and `start` called twice (§4.2) |

### 9.2 Outcome errors

*realizes: R21*

**Every way a prompt itself can fail.** These are recorded on the record
in `error_type` when `status` becomes `error`, and carried in the
`error` event's payload. They are **never** an HTTP error: they have no
status, and a request that produced one does not exist — the request
that submitted the prompt was answered `202` long before the run
settled.

| Type | Code | HTTP | Recorded when |
|---|---|---|---|
| `RUNNER` | 1013 | — | `runner.run()` rejected or threw, whether or not with an `LLMRunnerError`. When it is one, `error_message` is its `msg` and `info` carries its `type` and `data`; otherwise `error_message` is the thrown value's message (§5.4 step 5) |
| `SERVER` | 1014 | — | The server's own code threw while the prompt was active — concretely, `CTGPromptDB` threw while appending an event or writing the outcome. `error_message` is the server error's message; `info` carries its type (§5.4 step 6) |
| `INTERRUPTED` | 1015 | — | The next `start`'s recovery found the row still `active`, which means the process that owned it is gone (§4.3) |

Three types, and the classification is by **who broke**: the runner,
the server, or neither-because-the-server-died. This spec does not
enumerate `LLMRunnerError`'s own types — they are `ctg-ai-agent-proc`'s
to define, and they are recorded verbatim in `info` rather than mirrored
into a table here that would drift.

### 9.3 Conventions

`TYPES` is bidirectional — `CTGPromptServerError.TYPES.UNAUTHORIZED === 1002`
and `CTGPromptServerError.TYPES[1002] === "UNAUTHORIZED"` — and it
covers both tables. Constructing with an unknown type string throws a
plain `Error`. `data` is frozen shallowly, matching `LLMRunnerError`.
`statusOf` returns the HTTP status for a request type and `null` for an
outcome type; `status` on an instance is the same value.

`LLMRunnerError` is **never rethrown to a client.** A runner failure is
a prompt outcome, not a request outcome. Its `type`, `msg`, and `data`
are recorded on the row and in the `error` event, where the client and
the operator respectively read them.

> **Judgment Call 19 — one error class, with `status` on the error, and
> both request and outcome types in one `TYPES` map.** `ctg-ts-web-server`
> split a public error class from an internal one because validation
> errors are collected per field into one envelope. This service has no
> per-field validation to collect: every request error is one condition
> producing one response. Putting the status on the error means the
> type-to-status mapping lives in exactly one table — §9.1 — instead of
> being re-derived in the error handler, and a `null` status is what
> marks the outcome types as not being request errors at all (R20, R21).

---

## 10. Not Implemented

| Not provided | Reason |
|---|---|
| Cancelling an **active** prompt | *D6, R27.* Requires an abort signal in `ctg-ai-agent-proc`'s `LLMRunner`, which does not exist. An active prompt runs to completion or to the runner's `timeout`. Deferred to a later version. |
| Retries | A prompt in `error` stays in `error`. Submitting again is the client's decision (D5's rule, applied generally). |
| Multiple runners, a runner registry, per-request runner choice | *D1, R24.* One runner kind, named in config and constructed at `start`. The client cannot name one. |
| Prompt templates, client-supplied `LLMPrompt` operations | *D4.* The text reaches `runner.run()` unchanged. `LLMPrompt` and `LLMPromptTemplate` exist upstream and are not used. |
| Prompts larger than 131071 UTF-8 bytes | *D8, R26.* The ceiling is the Linux single-argv-element limit, because `LLMRunner` passes the prompt as one argv element. Lifting it means delivering the prompt on the child's stdin, which is an upstream change in `ctg-ai-agent-proc`, not a change here. |
| Operational logging | *D9.* v1 says nothing about logging. Fatal errors surface as ordinary process behavior. |
| Per-user auth, roles, ownership | *D10.* One shared key. Every holder can see and cancel every prompt. |
| Priorities | Dispatch is FIFO by `id` (D7, R12). |
| Webhooks / push callbacks | The events table, its SSE projection, and the long poll are the notification mechanisms. |
| Rate limiting, a cap on how many prompts may be pending | Not decided; see SQ-4. |
| Automatic retention / TTL | *D8.* Kept forever; `purge-finished` is an operator command (§6.6). |
| Multi-process or multi-host operation on one database | *R14.* One process owns a database. The concurrency limit is per process (§5.3) and holds only because Node is single-threaded, and recovery's correctness argument (§4.3) depends on the same rule. Supporting more would need lease and owner columns on `prompts` — a schema change. See SQ-1. |
| Graceful drain on shutdown | *R23, SQ-7.* `close()` does not wait for active runs; they are interrupted exactly as on process exit. `queue.drain()` is a test aid. |
| A browser client | *R10.* Clients are server-side. Browser `EventSource` cannot set an `Authorization` header, so it cannot reach any route; a browser that needed the stream would use `fetch` with a stream reader, which can. |
| Events on the record route | *SQ-5.* `GET /prompt/:id` returns `response` and `lastSequence`; the event history is read from `GET /prompt/:id/events`. |

---

## 11. Conformance Verification

*realizes: R28*

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
        eventStreamClient.ts       EventStreamClient — the SSE frame reader (below)
        errorClass.ts              CTGPromptServerError: TYPES bidirectionality across both tables, codes, statuses, null status on outcome types
        config.ts                  CTGPromptServer.init validation, defaults, apiKey refusal, maxPromptBytes ceiling
        lifecycle.ts               init opens without dispatching; start constructs the runner, recovers, dispatches, binds; start twice; close
        db.ts                      schema, foreign key cascade, sequence allocation, claim, finish, cancel, list
        queue.ts                   submit validation, dispatch limit, FIFO, no double dispatch
        events.ts                  runner event to row mapping, detection order, payloads
        response.ts                response accumulation per stream mode, runner result overwrite, accumulated-equals-final
        subscribers.ts             fan-out, dedupe by sequence, close on finish, sink errors
        recovery.ts                active prompts interrupted; pending prompts untouched
        purge.ts                   finished rows deleted, cascade removes events, pending and active preserved
        routes.ts                  every route, envelope shape, Bearer auth, error statuses
        longpoll.ts                wait cases (below)
        sse.ts                     wire format, Last-Event-ID, history/live/finished cases
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
`LLMRunnerOutputEvent` / `ClaudeRunnerEvent` / `CodexRunnerEvent`
instances through `config.onStream` and resolve; reject with a real
`LLMRunnerError`; throw synchronously; or block on a promise the test
resolves when it wants the run to finish. The last of these is what
makes the concurrency-limit, FIFO, and long-poll assertions
deterministic — the test holds runs open and asserts through observable
behavior (which prompts are `active` in the database) rather than on the
`_active` field.

The fake also asserts the call contract: `run` is called with the text
**byte-identical** to what was submitted, and with exactly
`{ streamOutput: true, streamMode, onStream }` and nothing else (D1,
D4). A `CTGPromptServer` under test is constructed with
`runner: { kind }` as any other, and the suite substitutes the fake for
the instance `start` built.

**The SSE client.** `EventStreamClient` is a dedicated test helper
class, not an ad-hoc block inside a case:

```typescript
class EventStreamClient {
    static init(config: { port: number; apiKey: string }): EventStreamClient;

    open(id: number, lastEventId?: number): Promise<void>;   // GET /prompt/:id/events over node:http
    frames(): SSEFrame[];                                    // everything received so far, split into frames
    waitForFrames(count: number): Promise<SSEFrame[]>;       // resolve once that many frames have arrived
    waitForEnd(): Promise<SSEFrame[]>;                       // resolve when the server ends the stream
    close(): void;                                           // abort the request
}

interface SSEFrame {
    readonly id: number | null;      // the id: line, parsed, or null on a comment frame
    readonly name: string | null;    // the event: line
    readonly data: unknown | null;   // the data: line, JSON-parsed
    readonly comment: string | null; // a keep-alive or other comment line
    readonly raw: string;            // the frame exactly as received
}
```

It opens the route with `node:http` against `127.0.0.1` on an ephemeral
port (`listen(0)`), accumulates the raw response body, and splits it on
blank lines into frames. Cases assert on **frames** — `id`, `name`,
`data`, and the presence of comment frames — while `raw` keeps the exact
bytes available for the wire-format cases. Splitting in the helper and
asserting on frames is what keeps each case readable; keeping `raw`
is what keeps §7.3 testable, since a general-purpose SSE client library
would hide `id:` lines, comment keep-alives, and stream termination,
which are precisely the things under test.

> **Judgment Call 22 — SSE cases assert on frames from a dedicated
> helper class, with the raw text retained.** The wire format of §7.3 is
> the contract, and a general-purpose SSE client library would hide
> `id:` lines, comment keep-alives, and stream termination — precisely
> the things under test. Splitting frames in one helper rather than in
> each case is what keeps the cases readable; keeping `raw` on every
> frame is what keeps the byte-level assertions possible.

**Long-poll cases**, one each (R7):

| Case | Expectation |
|---|---|
| Prompt already finished before the request | Responds immediately, `200`, finished status |
| Prompt finishes during the wait | Responds when the finish event is published, well before `wait` elapses |
| `wait` elapses first | Responds at the deadline, `200`, status still `pending` or `active` |
| `wait` above `maxWaitMs` | Clamped: responds at `maxWaitMs`, not at the requested value, and not with an error |
| `wait` not an integer | `400` `INVALID_QUERY` |

**Databases** are temp files from `mkdtempSync(join(tmpdir(), ...))`,
one per suite, deleted at the end. `":memory:"` is used where a suite
needs no second connection; the purge suite uses a file, because it
opens a second connection the way the script does.

**Coverage rule:** every row of the request error table (§9.1) has a
test asserting both the type string and the HTTP status; every row of
the outcome error table (§9.2) has a test asserting the recorded
`error_type` and the `error` event's payload; every row of the SSE
boundary table (§7.3) has a test; every decision D1–D10 has at least one
test that would fail if the decision were reversed.

---

## 12. Judgment Calls

Each entry states the **final** decision. Entries reversed in review say
so and give the reason.

1. **Four capability-shaped classes, not one service class** (§2).
   Database, queue, subscribers, server. The database knows nothing
   about HTTP, subscribers, or the runner; the queue knows nothing about
   HTTP. This is what makes the database and the dispatch procedure
   testable without a socket. The routes live on the server because they
   are the thinnest layer in the system (R3).
2. **`init` opens the database and nothing else; `start` makes the
   server live** (§4.1). *Reversed in review (R23): the draft ran
   recovery and the first dispatch in `init`.* Construction that spawns
   child processes leaves no way to inspect a database without changing
   it.
3. **`db` is public after `init`; `queue` is public after `start`**
   (§4.1). Tests need stored rows without HTTP; the queue owns a runner
   that does not exist until `start`.
4. **`INTERRUPTED` is an outcome error type, not a sixth status**
   (§4.3). The five-state lifecycle in M stays five states.
5. **Whitespace-only prompts are rejected alongside the empty string**
   (§5.1), with the validation trim not affecting the stored text.
6. **The limit is 131071 UTF-8 bytes, and a larger configured limit is
   refused** (§5.1). Bytes are what the argv limit measures, and 131071
   is 131072 minus the terminating NUL (R26).
7. **`_active` is a set of integer ids, not a counter** (§5.3), so
   double-dispatch is observable rather than invisible, and the set uses
   the same identity as the database and the routes (R18).
8. **`streamOutput: true` on every run** (§5.4). `LLMRunner` defaults to
   the buffered `execFile` path, which emits no events and settles only
   at exit; this service's entire value is the event stream and the
   incrementally-built `response` (R15), so the streaming `spawn` path
   is not an option, it is the only path. The cost, taken deliberately:
   the `spawn` path implements `timeout` and `maxBuffer` itself rather
   than delegating to `execFile`, which is a smaller amount of upstream
   code exercised.
9. **`streamMode` defaults to `"events"`, `"raw"` selectable in server
   config** (§5.4, §5.5). `"events"` makes `ClaudeRunner` and
   `CodexRunner` emit their runner-native event classes parsed from the
   vendor's structured mode, which is strictly more information than raw
   stdout chunks and is what lets `response` accumulate assistant text
   rather than protocol noise. `"raw"` remains selectable for an
   operator who wants the unparsed stdout stream.
10. **The server constructs the runner from config** (§3.2, §4.2).
    *Reversed in review (R24): the draft took a constructed `LLMRunner`
    and set no `timeout` or `maxBuffer` of its own, to avoid two owners
    of one value.* Taking an instance made the server unusable from a
    config file or an environment — the operator had to write TypeScript
    to start it — and left `kind` unknown to the server, which §5.5 and
    R25 both need. Config names the kind and the child-process settings;
    `timeout` defaults to 600000 ms and `maxBuffer` falls through to the
    runner's own default, so there is still exactly one owner of each
    value: this config.
11. **The `events.prompt_id` foreign key is declared with
    `ON DELETE CASCADE`, and `foreign_keys` is on** (§6.1). *Reversed in
    review (R13): the draft declared no foreign key.* A bad write
    surfaces immediately as `STORE_FAILED` or the `SERVER` outcome type
    instead of leaving the database silently inconsistent.
12. **Cursor pagination on `id`, not offset** (§6.4), so a page is
    stable under concurrent submits and there is one ordering concept.
13. **The purge script uses `CTGPromptDB` directly** (§6.6). *Reversed
    in review (R19): the draft went through a server to inherit config
    validation.* A purge is a database operation and should not
    construct a runner, run recovery, or require an API key.
14. **Runner event payloads are stored unnormalized** (§7.2), matching
    the upstream decision to keep vendor semantics inside the payload;
    the record and the `active` event carry the runner kind so a client
    can interpret them (R25).
15. **The SSE stream closes after the finished event** (§7.3). Clients
    are server-side (R10), so there is no `EventSource` reconnect loop
    to worry about.
16. **Subscribers are per-prompt sets; a throwing sink is dropped, not
    propagated** (§7.3). Long-poll waiters are registered through the
    same mechanism.
17. **Express, deliberately overriding `ctg-ts-web-server` SQ-1** (§8).
    That rule governs a reusable library whose behavior must be
    reproducible; this is a service whose behavior is the model in §1,
    and Express supplies only the mechanical HTTP part. *realizes: D2*
18. **`Authorization: Bearer`, not a custom header** (§8.2). *Reversed
    in review (R8).* Server-side HTTP clients all support the standard
    header first-class; a custom one is a string every caller has to
    remember.
19. **One error class carrying its own HTTP status, with request and
    outcome types in one `TYPES` map** (§9), so the type-to-status
    mapping exists in exactly one table and a `null` status is what
    marks a type as not being a request error.
20. **Long polling on `GET /prompt/:id?wait=`, implemented with the
    subscriber mechanism** (§5.5). The first consumer is a PHP system
    whose request handlers are short-lived and synchronous and cannot
    hold a stream open (R7).
21. **`prompt` and `response` are returned; `info` is not** (§8.3). The
    client's input and its answer are the product; process diagnostics
    belong to the operator (R11).
22. **SSE tests assert on frames parsed by a dedicated helper class,
    with the raw text retained** (§11), because the wire format is the
    contract and a general-purpose client library would hide it (R28).

---

## 13. Surfaced Questions

Every question raised in review has been **resolved**. Each is recorded
with its decision and the reasoning, because the decision constrains
later work.

### SQ-1 — Is a second process ever going to open the same database?

**Resolved: no. One process owns a database.** *(R14.)* The concurrency
limit (§5.3) is correct only within one Node process, and recovery's
argument that every `active` row belongs to a dead process (§4.3)
depends on the same rule. Two service processes on one file would each
run up to `concurrency` prompts, and each would interrupt the other's
active rows on start. WAL mode and `busy_timeout` are set (§6.1) so a
concurrent *reader* — the purge script, which touches only finished rows
— is safe. Multi-process operation is listed under Not Implemented
(§10). If this ever changes, the fix is lease columns on `prompts`
(`claimed_by`, `claim_expires_at`) plus a global slot count enforced in
SQL; that is a schema change and belongs before the schema is written,
not after.

### SQ-2 — How does a browser subscribe to the event stream?

**Resolved: it does not. Clients are server-side.** *(R10.)* The
consumer of this service is another process — a PHP request handler, a
`fetch` stream reader, `curl` — which can set an `Authorization` header
and can stop on the finished event. Browser `EventSource` cannot set any
request header, so it cannot authenticate against any route here; that
is a property of `EventSource`, not of the header choice. If a browser
ever needs the stream, `fetch` with a stream reader works today and
needs nothing from this spec. A browser client with its own auth design
would be a real feature, not a header tweak.

### SQ-3 — Should the record carry the runner's stderr in the same column as a failure message?

**Resolved: no. They are separate fields, and stderr is not on the
record at all.** *(R17.)* The draft had one `error` column holding the
child's stderr on success and the failure message on failure, which
would make a client checking "is `error` non-empty" misclassify every
successful run that logged to stderr. The columns are now
`error_message` — set only when `status` is `error` — and `info`, which
holds stderr from any run, an `LLMRunnerError`'s `data`, and similar
diagnostics, and is never serialized over HTTP (R11). `status` remains
the authority on whether a prompt ended in error.

### SQ-4 — Is a shared key with no rate limit sufficient exposure control?

**Resolved: yes for v1, and it is listed under Not Implemented.**
*(R27.)* Every holder of the key can submit without limit. The
dispatcher bounds concurrent *runs* (D7) but not how many prompts may be
pending, so a client in a loop can accumulate rows, each holding text of
up to `maxPromptBytes`. The deployment is trusted and single-tenant.
The cheapest mitigation if that changes is a maximum pending count
checked in `submit` — one config field, one error type, no schema
change — which is why it is worth naming now even though it is not being
built.

### SQ-5 — Should `GET /prompt/:id` include the last N events?

**Resolved: no. The record route returns the record.** *(R16.)* What a
polling client actually needed was progress, and it now has it without a
second shape of the same data: `response` carries the text as it stands
(§5.5) and `lastSequence` says how far the history has advanced. A
client that wants the events themselves opens
`GET /prompt/:id/events` with `Last-Event-ID` and closes it after the
replay, which returns exactly the events it has not seen.

### SQ-6 — Can a client ever observe a prompt in the `pending` state?

**Resolved: not necessarily, and that is correct and intended.**
*(R27.)* With `concurrency: 1` and nothing else in flight, `submit`
appends `pending` (sequence 1) and then calls `dispatch()`, which
appends `active` (sequence 2) — both before `submit` returns, and both
before the client has the id to poll with. The sequence is right; a poll
simply may never catch that state. The events table is the record, and a
subscriber arriving later replays both events in order (§7.3). A
prompt's *state* being unobservable at a moment is not the same as the
*event* being lost, and M's guarantee is about the event history, not
about what a poll happens to catch.

### SQ-7 — Does `close()` need to wait for active prompts?

**Resolved: no graceful drain in v1.** *(R23.)* §4.4 does not wait:
child processes are orphaned and their rows are moved to `error` as
`INTERRUPTED` on the next `start`. D5 already specifies that outcome and
makes it a recoverable, visible result rather than data loss, so a drain
would buy convenience rather than correctness — at the cost of a restart
taking as long as the longest run. `queue.drain()` exists for tests, so
adding a graceful shutdown later is a change to `close()` alone.
