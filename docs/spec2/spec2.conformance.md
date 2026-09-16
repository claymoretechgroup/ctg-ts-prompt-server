# ctg-ts-prompt-server spec2 conformance

**Status:** proposed cross-class conformance criteria.

This document owns conformance criteria for behavior that spans multiple
classes. Class-local tests should be derived directly from the class
specs. Criteria here prove the general architecture works as intended.

---

## Startup Recovery

**XCONF-1** `CTGPromptServer.start(port)` constructs the configured
runner and `CTGPromptServerQueue`, calls `queue.recover()`, starts the
queue, and binds the HTTP listener in that order.

**XCONF-2** Records left `ACTIVE` by a previous process are moved to
`ERROR` with `PROMPT_INTERRUPTED` / `5` before new pending records can
be claimed.

**XCONF-3** Pending records left by a previous process remain pending
through recovery and become eligible for normal queue dispatch after the
queue starts.

## Submit To Durable Record

**XCONF-4** `POST /prompt` validates authentication, content type, body
shape, and prompt size before creating durable work.

**XCONF-5** A valid `POST /prompt` stores exactly one pending prompt
record through `CTGPromptServerQueue.submit(...)` and
`CTGPromptServerDB.create(...)`.

**XCONF-6** A valid `POST /prompt` returns HTTP `202` with
`CTGPromptRecordResponse`, excluding any fields not present in the
public prompt projection.

**XCONF-7** If the queue is started, submitting a prompt eventually
queues work without requiring another HTTP request.

## Dispatch And Successful Run

**XCONF-8** Dispatch claims pending records from SQLite, not from an
in-memory waiting list.

**XCONF-9** Claiming a prompt moves it from `PENDING` / `1` to
`ACTIVE` / `2` atomically before runner execution starts.

**XCONF-10** Active stream output that contributes to `response` is
persisted before the corresponding live SSE message is emitted.

**XCONF-11** A successful runner result moves the prompt to `DONE` /
`3`, stores the final response, emits a terminal `done` message, wakes
long-poll waiters, and closes live SSE streams for the prompt.

## Failure Paths

**XCONF-12** Runner failures move the prompt to `ERROR` / `-1` with
`RUNNER_FAILED` / `4`.

**XCONF-13** Database failures encountered during queue processing move
the affected prompt to `ERROR` / `-1` with `DATABASE_FAILED` / `3` when
a terminal record can be stored.

**XCONF-14** Internal service failures move the prompt to `ERROR` / `-1`
with `INTERNAL_ERROR` / `2` when a terminal record can be stored.

**XCONF-15** Unknown caught failures are wrapped as `UNKNOWN_ERROR` /
`15` before being persisted or emitted.

**XCONF-16** Terminal error responses and terminal error stream messages
include only public error code/message data.

## Cancellation

**XCONF-17** `DELETE /prompt/:id` can cancel only pending prompts.

**XCONF-18** Successful cancellation moves the prompt to `CANCELLED` /
`5`, returns HTTP `200` with `CTGPromptRecordResponse`, emits a terminal
`cancelled` message, wakes long-poll waiters, and closes live SSE
streams for the prompt.

**XCONF-19** Cancelling unknown prompts returns `PROMPT_NOT_FOUND` /
`11` with HTTP `404`.

**XCONF-20** Cancelling active or terminal prompts returns
`CANCEL_NOT_ALLOWED` / `12` with HTTP `409`.

## Reads And Pagination

**XCONF-21** `GET /prompt/:id` reads the current durable prompt record
from the database and returns the public prompt projection.

**XCONF-22** `GET /prompt/:id?wait=<ms>` waits until the prompt is
terminal or the clamped wait duration elapses, then returns the current
durable state either way.

**XCONF-23** `GET /prompts` returns records newest first with cursor
pagination.

**XCONF-24** `GET /prompts/:status` applies the lifecycle status filter
and uses the same pagination behavior as `GET /prompts`.

## SSE

**XCONF-25** `GET /sse/:id` validates the prompt exists before writing
SSE headers.

**XCONF-26** Unknown prompt IDs on `GET /sse/:id` return a JSON
`PROMPT_NOT_FOUND` response and do not open an SSE stream.

**XCONF-27** SSE streams are live-only; reconnecting clients recover
current durable state with `GET /prompt/:id`.

**XCONF-28** SSE streams receive keep-alive comments at the configured
cadence while open.

**XCONF-29** Terminal `done`, `error`, and `cancelled` messages close
the SSE stream for that prompt.

## Request Error Envelopes

**XCONF-30** All non-SSE HTTP success responses use
`{ success: true, result }`.

**XCONF-31** All HTTP error responses sent before SSE headers use
`{ success: false, result: { code, message } }`.

**XCONF-32** Request errors use the fixed HTTP statuses defined by
`CTGPromptServerRequestError` named factories.

**XCONF-33** Base `CTGPromptServerError` responses default to HTTP
`500`.

## Shutdown And Restart

**XCONF-34** `server.close()` stops accepting HTTP work, closes SSE
sinks, wakes long-poll waiters, stops new queue claims, and closes the
database.

**XCONF-35** `server.close()` does not wait for active runner results to
settle.

**XCONF-36** Active rows left after shutdown are marked interrupted by
the next startup recovery pass.

---
