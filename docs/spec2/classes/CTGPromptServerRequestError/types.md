# CTGPromptServerRequestError Types

`CTGPromptServerRequestError` uses the shared error code and result
types owned by
[CTGPromptServerError types](../CTGPromptServerError/types.md).

The inherited `code` field and request-specific `status` field are
assigned from constructor arguments. The inherited `label` getter is
derived from `code`. The response body produced by inherited
`toResponse()` is defined with [CTGPromptServer types](../CTGPromptServer/types.md)
as `CTGPromptErrorResponse` and contains only public `code` and
`message`.

`sendResponse(response)` is inherited from `CTGPromptServerError` and
uses `CTGPromptServerRequestError.status`.

## Request Error Statuses

Supported request errors have fixed HTTP statuses. Route handlers should
construct them through the named `CTGPromptServerRequestError` static
factories so the status is not repeated at call sites.

| Factory | Error label | Error code | HTTP status |
|---|---|---:|---:|
| `unauthorized(...)` | `UNAUTHORIZED` | `6` | `401` |
| `invalidContentType(...)` | `INVALID_CONTENT_TYPE` | `7` | `415` |
| `invalidBody(...)` | `INVALID_BODY` | `8` | `400` |
| `invalidPrompt(...)` | `INVALID_PROMPT` | `9` | `400` |
| `invalidQuery(...)` | `INVALID_QUERY` | `10` | `400` |
| `promptNotFound(...)` | `PROMPT_NOT_FOUND` | `11` | `404` |
| `cancelNotAllowed(...)` | `CANCEL_NOT_ALLOWED` | `12` | `409` |
| `notFound(...)` | `NOT_FOUND` | `13` | `404` |
| `methodNotAllowed(...)` | `METHOD_NOT_ALLOWED` | `14` | `405` |

`INVALID_CONFIG`, `DATABASE_FAILED`, `RUNNER_FAILED`,
`PROMPT_INTERRUPTED`, `INTERNAL_ERROR`, and `UNKNOWN_ERROR` are not
request-validation factories. If one is sent through the base
`CTGPromptServerError.sendResponse(response)` path, it uses HTTP status
`500` unless a subclass explicitly provides another status.
