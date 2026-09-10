# TODO

Current branch context:

- Base branch for spec work: `spec-v2`
- TODO branch: `todo-spec2-next-steps`
- Latest pushed spec branch commit at time of TODO creation:
  `82cbaa0 docs: document v2 prompt queue class`

## Next Spec Work

1. Continue `docs/spec2.classes.md` with `CTGPromptServer`.
2. Continue `docs/spec2.classes.md` with `CTGPromptServerError`.
3. Create `docs/spec2.conformance.md` as the single conformance criteria document.
4. Organize conformance by class where useful, plus cross-class workflows where behavior spans boundaries.
5. Keep conformance criteria out of `docs/spec2.classes.md`; class docs should define shape and behavior, not test requirements.
6. Decide whether the combined `docs/spec2.md` should be regenerated from:
   - `docs/spec2.db.md`
   - `docs/spec2.types.md`
   - `docs/spec2.classes.md`
   - `docs/spec2.conformance.md`
7. If `docs/spec2.md` remains checked in, add a short note that it is the assembled implementation spec.

## Open Design Checks

1. Confirm whether `CTGPromptDB.constructor` should be public, protected, or private.
2. Confirm whether `CTGPromptQueue.start()` should call `recover()` or whether `CTGPromptServer.start()` remains responsible for startup recovery.
3. Confirm whether `CTGPromptQueue.activeRunner(...)` should stay public static for testability.
4. Confirm whether `CTGPromptQueue` needs any private methods documented beyond the public/static surface.
5. Confirm whether `runner` should remain nullable metadata in the initial schema or be written on every claim.

## Operational Docs

1. Decide whether to create `docs/spec2.operations.md` or fold operational assumptions into the assembled `docs/spec2.md`.
2. Document that one server process owns one DB file; WAL allows concurrent readers but not multiple active service workers on the same database.
3. Document deployment assumptions: host process, Docker bridge access, Bearer auth as the protection boundary, and `runner.env` as a full child-environment replacement.
4. Document maintenance scripts for purge finished, purge all, and reset schema, including whether they run SQL directly or call a helper.
5. Document startup and shutdown order: recovery before new claims, queue start/stop behavior, active runner handling, SSE close behavior, and DB close behavior.
6. Document operational limits: fixed JSON body limit, `maxPromptBytes`, runner timeout/default `maxBuffer`, SSE keep-alive cadence, and long-poll wait clamping.
7. Confirm the observability stance: keep the original "no operational logging" decision or define explicit logging behavior.
8. Document the source-of-truth process for split docs versus assembled `docs/spec2.md`.

## Original Spec Parity

1. Compare the split v2 docs against `docs/spec.md` before implementation starts.
2. Carry forward server configuration details that still apply: host, port, auth token, Docker bridge defaults, runner config, and queue limits.
3. Carry forward HTTP API behavior that still applies: prompt creation, prompt lookup, prompt cancellation, pagination, streaming, long polling, health, and method/content-type errors.
4. Carry forward response envelope behavior and decide which envelopes belong to `CTGPromptServer` versus `CTGPromptServerError`.
5. Carry forward shutdown behavior around signals, server close, queue stop, active runners, and database close.
6. Explicitly mark any original v1 feature that is intentionally omitted from v2 initial scope.

## Implementation Order

1. Update exported types in `src/types.ts`.
2. Update `CTGPromptServerError` label/code behavior.
3. Replace `CTGPromptDB` schema and method API.
4. Refactor `CTGPromptQueue` around `CTGAgentProc` and `ActiveRunner`.
5. Move live SSE sinks and long-poll waiters into `CTGPromptServer`.
6. Remove `CTGPromptSubscribers` after the server owns live delivery.
7. Write `docs/spec2.conformance.md`.
8. Update conformance tests around DB transitions, queue lifecycle, SSE, long polling, and error envelopes.

## Notes

- `ActiveRunnerConfig` now carries an already-created runner result promise.
- `runPrompt` starts `runner.run(record.prompt, ...)`; `activeRunner(...)` only constructs the `ActiveRunner` value.
- `interruptActive()` is server-startup recovery and marks previously active records as interrupted terminal outcomes before new work is claimed.
- Initial spec2 intentionally does not persist stream-event history; reconnect reads the current prompt queue record.
- Public/exported support types use the `CTG` prefix; local helper types can remain unprefixed.
- Database fields store numeric codes for prompt status and terminal errors; labels are resolved in TypeScript.
