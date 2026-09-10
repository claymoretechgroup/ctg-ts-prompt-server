# TODO

Current branch context:

- Base branch for spec work: `spec-v2`
- TODO branch: `todo-spec2-next-steps`
- Latest pushed spec branch commit at time of TODO creation:
  `82cbaa0 docs: document v2 prompt queue class`

## Next Spec Work

1. Continue `docs/spec2.classes.md` with `CTGPromptServer`.
2. Continue `docs/spec2.classes.md` with `CTGPromptServerError`.
3. Decide whether the combined `docs/spec2.md` should be regenerated from:
   - `docs/spec2.db.md`
   - `docs/spec2.types.md`
   - `docs/spec2.classes.md`
4. If `docs/spec2.md` remains checked in, add a short note that it is the assembled implementation spec.

## Open Design Checks

1. Confirm whether `CTGPromptDB.constructor` should be public, protected, or private.
2. Confirm whether `CTGPromptQueue.start()` should call `recover()` or whether `CTGPromptServer.start()` remains responsible for startup recovery.
3. Confirm whether `CTGPromptQueue.activeRunner(...)` should stay public static for testability.
4. Confirm whether `CTGPromptQueue` needs any private methods documented beyond the public/static surface.
5. Confirm whether `runner` should remain nullable metadata in the initial schema or be written on every claim.

## Implementation Order

1. Update exported types in `src/types.ts`.
2. Update `CTGPromptServerError` label/code behavior.
3. Replace `CTGPromptDB` schema and method API.
4. Refactor `CTGPromptQueue` around `CTGAgentProc` and `ActiveRunner`.
5. Move live SSE sinks and long-poll waiters into `CTGPromptServer`.
6. Remove `CTGPromptSubscribers` after the server owns live delivery.
7. Update conformance tests around DB transitions, queue lifecycle, SSE, long polling, and error envelopes.

## Notes

- `ActiveRunnerConfig` now carries an already-created runner result promise.
- `runPrompt` starts `runner.run(record.prompt, ...)`; `activeRunner(...)` only constructs the `ActiveRunner` value.
- `interruptActive()` is server-startup recovery and marks previously active records as interrupted terminal outcomes before new work is claimed.
- Initial spec2 intentionally does not persist stream-event history; reconnect reads the current prompt queue record.

