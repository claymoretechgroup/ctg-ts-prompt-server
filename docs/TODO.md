# TODO

Current branch context:

- Base branch for spec work: `spec-v2`
- TODO branch: `todo-spec2-next-steps`
- Latest local spec branch checkpoint:
  `70d1ffd Implement spec-v2 server route structure`

## Current Spec-V2 Checkpoint

Completed on `spec-v2`:

1. Split class specs into `docs/spec2/classes/<ClassName>/class.md` and `types.md`.
2. Refactored `docs/spec2/spec2.md` into a general architecture document that references class, type, schema, and conformance docs.
3. Added `docs/spec2/spec2.conformance.md` for cross-class architecture and workflow criteria.
4. Renamed implementation classes to `CTGPromptServerDB` and `CTGPromptServerQueue`.
5. Refactored error classes around integer `CODE` registries, derived labels, `toResponse()`, and `sendResponse(...)`.
6. Removed `info` from the prompt schema/spec.
7. Extracted `CTGPromptServer` routes into `src/CTGPromptServer/routes/*`.
8. Switched SSE route to `GET /sse/:id`.
9. Moved SSE sinks and long-poll waiters into `CTGPromptServer`.
10. Removed `CTGPromptSubscribers`.
11. Added static-only `CTGPromptServerValidation` and spec docs for server validation helpers.
12. Moved tests out of `tests/spec2` / `tests/conformance`; `npm test` now runs the root spec test suite.
13. Verified the checkpoint with:
    - `npm run check`
    - `npm test`
    - `npm run compile:package`

## Next Implementation Work

1. Reconcile `CTGPromptServerQueue` implementation with its spec.
   - The spec describes the `CTGAgentProc` workflow with `checkWork`, `runPrompt`, `finishPrompt`, and `failPrompt`.
   - The current implementation still uses a direct `dispatch()` / `drain()` execution shape.
   - Decide whether to implement the spec as written or revise the spec before changing code.
2. Implement or remove spec drift around queue lifecycle methods.
   - Spec surface: `next()`, `start()`, `stop()`, `activeRunner(...)`.
   - Current surface includes direct read/list/dispatch/drain behavior that may belong on `CTGPromptServer` or route helpers instead.
3. Add tests that enforce server-owned live delivery.
   - Long-poll waiters wake when prompts finish.
   - `server.close()` wakes waiters and closes SSE sinks.
   - SSE sinks close after `done`, `error`, and `cancelled`.
   - Write failures drop only the failing SSE sink.
4. Add tests for the extracted route modules.
   - Ensure `CTGPromptServer` imports only the aggregate route binder.
   - Ensure route groups bind the documented paths.
   - Ensure fallback behavior remains last in binding order.
5. Review `CTGPromptServerValidation` before building more behavior around it.
   - Decide which helpers are actually needed by the spec-backed implementation.
   - Separate type predicates from throwing validation/assertion methods.
   - Consider whether runner kind and stream mode checks should be type predicates defined near the owning types.
   - Remove one-off wrappers that do not earn shared helper status.
   - Add tests only for the validation helpers that remain part of the spec-backed surface.
6. Review `CTGPromptServer` close behavior against spec.
   - Stop listener.
   - Close all SSE sinks.
   - Wake all long-poll waiters.
   - Stop queue.
   - Close DB.
7. Review `openSSE(...)` terminal-record behavior.
   - If a sink is opened for an already-terminal record, make sure it is not left registered after ending.
8. Review package exports.
   - Confirm which class-local `types.ts` files should remain internal.
   - Export only the public surface required by the spec.

## Spec Follow-Ups

1. Confirm whether `CTGPromptServerQueue` should extend `CTGAgentProc` or own a `CTGAgentProc` instance.
2. Confirm whether `CTGPromptServerQueue` should expose `read(...)` and `list(...)`, or whether reads should be DB/server concerns.
3. Confirm the final queue start/stop vocabulary before implementing queue lifecycle tests.
4. Confirm whether the older `docs/spec.md` should remain maintained or be treated as historical once spec2 is authoritative.
5. Review all spec2 docs for class names after the latest rename:
   - `CTGPromptServerDB`
   - `CTGPromptServerQueue`
   - `CTGPromptServer`
   - `CTGPromptServerError`
   - `CTGPromptServerRequestError`
   - `CTGPromptServerValidation`
6. Confirm whether `CTGPromptServerValidation` should remain a class, become module-level predicate/assertion functions, or move predicates beside the owning type definitions.
7. Review `docs/spec2.conformance.md` after queue implementation catches up with the class docs.

## Recommended Next Session Order

1. Read `docs/spec2/classes/CTGPromptServerQueue/class.md`.
2. Compare the queue spec directly against `src/CTGPromptServerQueue/CTGPromptServerQueue.ts`.
3. Decide whether to implement the `CTGAgentProc` queue model exactly as specified.
4. Implement `CTGPromptServerQueue` relative to the spec.
5. Add or update tests as conformance checks against the implementation, then refactor only the behavior that fails the spec-backed tests.
6. Add live-delivery tests around `CTGPromptServer`.
7. Run `npm run check`, `npm test`, and `npm run compile:package`.

## Notes

- Spec-first remains the rule: implementation changes should trace to `docs/spec2`.
- `TODO.md` is maintained on `todo-spec2-next-steps`, not intended as a long-term versioned artifact on `spec-v2`.
- Initial spec2 intentionally does not persist stream-event history; reconnect reads current prompt state with `GET /prompt/:id`.
- Request errors use `CTGPromptServerRequestError`; base server errors default to HTTP 500 when sent through `sendResponse(...)`.
- Queue status and server error codes both use integer registries with labels derived from the registry.
