# CTGPromptServerError Types

Spec2 treats errors as five related sources or states:

1. **Request errors** reject an HTTP request because the request is not
   authorized, cannot be parsed, targets an invalid route, or asks for an
   invalid operation.
2. **Database errors** originate from SQLite or durable storage
   operations.
3. **Runner errors** originate from the configured upstream
   `LLMRunner`.
4. **Prompt errors** are durable terminal prompt states stored on
   `CTGPromptServerQueueRecord` when a prompt run cannot complete
   successfully.
5. **Internal errors** are unexpected service failures that are not
   request, database, runner, or prompt-domain failures.

All supported error codes live in one registry so the readable response
label can be derived from the canonical code. `code` is a stable
application/domain code, not an HTTP status. HTTP status belongs to
request errors, not base server errors.

---

### Error Codes

Error codes are plain integers. Spec2 does not export a dedicated error
code type; constructor, response, and database surfaces use `number`.
`CTGPromptServerError` validates codes against `CTGPromptServerError.CODE`.
Missing or unsupported codes throw `INVALID_CODE` / `-1`.
Caught failures that are not already `CTGPromptServerError` instances
are wrapped as `UNKNOWN_ERROR` / `15` with the caught value captured in
`data` when it can be safely serialized.

`CTGPromptServerError` receives `code` as a constructor argument. The map
below defines the label for each code. HTTP statuses are not defined in
this registry; request errors receive their status explicitly through
`CTGPromptServerRequestError`.

The code mapping is implemented by the object literal
`CTGPromptServerError.CODE`. Labels are derived response values, not
constructor inputs. `CTGPromptServerError.labelOf(code)` resolves labels
by reverse lookup from the stored code.

Error label/code map:

| Label | Code |
|---|---:|
| `INVALID_CODE` | `-1` |
| `INVALID_CONFIG` | `1` |
| `INTERNAL_ERROR` | `2` |
| `DATABASE_FAILED` | `3` |
| `RUNNER_FAILED` | `4` |
| `PROMPT_INTERRUPTED` | `5` |
| `UNAUTHORIZED` | `6` |
| `INVALID_CONTENT_TYPE` | `7` |
| `INVALID_BODY` | `8` |
| `INVALID_PROMPT` | `9` |
| `INVALID_QUERY` | `10` |
| `PROMPT_NOT_FOUND` | `11` |
| `CANCEL_NOT_ALLOWED` | `12` |
| `NOT_FOUND` | `13` |
| `METHOD_NOT_ALLOWED` | `14` |
| `UNKNOWN_ERROR` | `15` |

`CTGPromptServerError` does not define standalone public types. The
HTTP-facing response body is defined by `CTGPromptServerError.toResponse()`
and `CTGPromptErrorResponse`.
