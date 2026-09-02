# Conformance Coverage

This checklist maps the spec's mandatory coverage rows to suite files and case labels.

| Spec row | Covered by |
|---|---|
| §9.1 `INVALID_CONFIG`, status `null` | `conformance/errorClass.ts` — `§9.1/§9.2 statusOf matches HTTP status and null outcome status`; `conformance/config.ts` — `§4.1 every invalid config check throws INVALID_CONFIG` |
| §9.1 `UNAUTHORIZED`, HTTP 401 | `conformance/routes.ts` — `§8.2/§9.1 UNAUTHORIZED missing bearer key returns 401` |
| §9.1 `INVALID_CONTENT_TYPE`, HTTP 415 | `conformance/routes.ts` — `§8.1/§9.1 INVALID_CONTENT_TYPE POST /prompt without JSON returns 415` |
| §9.1 `INVALID_BODY`, HTTP 400 | `conformance/routes.ts` — `§8.1/§9.1 INVALID_BODY non-object or missing prompt returns 400` |
| §9.1 `INVALID_PROMPT`, HTTP 400 | `conformance/routes.ts` — `§5.1/§9.1 INVALID_PROMPT whitespace body prompt returns 400` |
| §9.1 `INVALID_QUERY`, HTTP 400 | `conformance/routes.ts` — `§8.1/§9.1 INVALID_QUERY covers bad id, status, limit, before, and wait` |
| §9.1 `PROMPT_NOT_FOUND`, HTTP 404 | `conformance/routes.ts` — `§8.1/§9.1 PROMPT_NOT_FOUND read returns 404`; `conformance/sse.ts` — `§7.3 boundary unknown id returns 404 JSON envelope and no SSE stream` |
| §9.1 `CANCEL_NOT_ALLOWED`, HTTP 409 | `conformance/routes.ts` — `§5.2/§9.1 CANCEL_NOT_ALLOWED active prompt DELETE returns 409` |
| §9.1 `NOT_FOUND`, HTTP 404 | `conformance/routes.ts` — `§8.4/§9.1 NOT_FOUND unmatched path returns 404` |
| §9.1 `METHOD_NOT_ALLOWED`, HTTP 405 | `conformance/routes.ts` — `§8.4/§9.1 METHOD_NOT_ALLOWED matched path wrong method returns 405` |
| §9.1 `STORE_FAILED`, HTTP 500 | `conformance/routes.ts` — `§9.1 STORE_FAILED sqlite failure during request returns 500` |
| §9.1 `INTERNAL_ERROR`, HTTP 500 | `conformance/routes.ts` — `§8.4/§9.1 INTERNAL_ERROR unhandled route error returns 500 without original details`; `conformance/lifecycle.ts` — `§4.2 step 1 start twice rejects with INTERNAL_ERROR` |
| §9.2 `RUNNER` outcome | `conformance/queue.ts` — `§9.2 RUNNER outcome records error_type and error event payload for LLMRunnerError rejection` |
| §9.2 `SERVER` outcome | `conformance/queue.ts` — `§9.2 SERVER outcome records error_type and error event payload when DB outcome write throws once` |
| §9.2 `INTERRUPTED` outcome | `conformance/recovery.ts` — `§4.3/R21 active prompts are interrupted as error with INTERRUPTED event payload` |
| §7.3 SSE unknown id | `conformance/sse.ts` — `§7.3 boundary unknown id returns 404 JSON envelope and no SSE stream` |
| §7.3 SSE non-integer id | `conformance/sse.ts` — `§7.3 boundary non-integer id returns 400 INVALID_QUERY and no SSE stream` |
| §7.3 SSE Last-Event-ID absent | `conformance/sse.ts` — `§7.3 absent Last-Event-ID replays full finished history then ends with exact wire shape` |
| §7.3 SSE Last-Event-ID >= last sequence, finished | `conformance/sse.ts` — `§7.3 Last-Event-ID at finished last sequence sends headers, no events, immediate end` |
| §7.3 SSE Last-Event-ID >= last sequence, unfinished | `conformance/sse.ts` — `§7.3 Last-Event-ID at unfinished last sequence stays open for live tail` |
| §7.3 SSE malformed Last-Event-ID | `conformance/sse.ts` — `§7.3 malformed Last-Event-ID is treated as 0 and replays full history` |
| §7.3 SSE prompt already finished | `conformance/sse.ts` — `§7.3 prompt already finished replays full history then closes without keep-alive linger` |
| §7.3 SSE client disconnect | `conformance/sse.ts` — `§7.3 client disconnect deregisters stream without changing prompt outcome` |
| §11 long-poll already finished | `conformance/longpoll.ts` — `§5.5/R7 prompt already finished responds immediately with 200 finished status` |
| §11 long-poll finishes during wait | `conformance/longpoll.ts` — `§5.5/R7 prompt finishes during wait responds when closePrompt publishes finish` |
| §11 long-poll wait elapses first | `conformance/longpoll.ts` — `§5.5/R7 wait elapses first returns 200 with unfinished status` |
| §11 long-poll wait above maxWaitMs | `conformance/longpoll.ts` — `§5.5/R7 wait above maxWaitMs is clamped, not rejected` |
| §11 long-poll wait not integer | `conformance/longpoll.ts` — `§8.1/§11 long-poll wait not an integer is 400 INVALID_QUERY` |
| D1 one runner, no per-request runner choice | `conformance/routes.ts` — `§8.1/§8.3 POST /prompt returns 202 success envelope with exact prompt key set and ignores extra body fields (D1)`; `conformance/routes.ts` — `§8.1/D1 no runner registry, health, metrics, or purge routes exist` |
| D2 durable HTTP/SSE event projection | `conformance/events.ts` — `§7.2 store-before-publish makes every received stream event replayable`; `conformance/subscribers.ts` — `§7.3/D2 subscribers fan out one committed event to every sink for a prompt` |
| D3 SQLite/node:sqlite persistence | `conformance/db.ts` — `§6.1 schema has prompt/event tables, status index, and foreign key cascade` |
| D4 raw prompt text, no templates | `conformance/queue.ts` — `§5.1/D4 submit stores and executes byte-identical untrimmed prompt text` |
| D5 recovery, no automatic rerun | `conformance/recovery.ts` — `§4.3/R21 active prompts are interrupted as error with INTERRUPTED event payload` |
| D6 cancel pending only | `conformance/queue.ts` — `§5.2/D6 cancel only pending prompts and prevents later dispatch` |
| D7 concurrency and FIFO | `conformance/queue.ts` — `§5.3 step 2/D7 dispatch never exceeds concurrency and leaves later prompts pending`; `conformance/db.ts` — `§6.3 claimNextPending claims oldest id FIFO and records runner in active payload (D7/R25)` |
| D8 prompt size validation and retention/purge | `conformance/config.ts` — `§4.1 every invalid config check throws INVALID_CONFIG`; `conformance/purge.ts` — `§6.6/R13 purgeFinished deletes done/error/cancelled rows and cascades their events` |
| D9 no operational logging contract | `conformance/routes.ts` — `§8.4/§9.1 INTERNAL_ERROR unhandled route error returns 500 without original details` |
| D10 required API key and config-built runner | `conformance/config.ts` — `§4.2 runner kind still records runner field and active event payload (R25/D10)`; `conformance/routes.ts` — `§8.2/§9.1 UNAUTHORIZED missing bearer key returns 401` |

Additional exact wire/body shape checks:

| Spec row | Covered by |
|---|---|
| §8.3 success envelope exact key set | `conformance/routes.ts` — POST/GET/DELETE/list success cases via `promptResult` and `promptListResult` |
| §8.3 error envelope exact key set | `conformance/routes.ts`, `conformance/longpoll.ts`, `conformance/sse.ts` via `isErrorEnvelope` |
| §7.3 SSE raw frame shape | `conformance/sse.ts` — `§7.3 absent Last-Event-ID replays full finished history then ends with exact wire shape`; `§7.3 keep-alive writes comment frames without id while stream remains open` |

