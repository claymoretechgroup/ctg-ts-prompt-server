# CTGPromptServerRequestError

`CTGPromptServerRequestError` is the HTTP-facing subclass of
`CTGPromptServerError`. It represents HTTP request validation and routing
errors.

```ts
class CTGPromptServerRequestError extends CTGPromptServerError {
    readonly status: number;

    constructor(
        code: number,
        status: number,
        message: string,
        data?: null | boolean | number | string | object
    );

    static init(
        code: number,
        status: number,
        message: string,
        data?: null | boolean | number | string | object
    ): CTGPromptServerRequestError;
    static unauthorized(
        message: string,
        data?: null | boolean | number | string | object
    ): CTGPromptServerRequestError;
    static invalidContentType(
        message: string,
        data?: null | boolean | number | string | object
    ): CTGPromptServerRequestError;
    static invalidBody(
        message: string,
        data?: null | boolean | number | string | object
    ): CTGPromptServerRequestError;
    static invalidPrompt(
        message: string,
        data?: null | boolean | number | string | object
    ): CTGPromptServerRequestError;
    static invalidQuery(
        message: string,
        data?: null | boolean | number | string | object
    ): CTGPromptServerRequestError;
    static promptNotFound(
        message: string,
        data?: null | boolean | number | string | object
    ): CTGPromptServerRequestError;
    static cancelNotAllowed(
        message: string,
        data?: null | boolean | number | string | object
    ): CTGPromptServerRequestError;
    static notFound(
        message: string,
        data?: null | boolean | number | string | object
    ): CTGPromptServerRequestError;
    static methodNotAllowed(
        message: string,
        data?: null | boolean | number | string | object
    ): CTGPromptServerRequestError;
}
```

---

## Properties

| Property | Type | Description |
|---|---|---|
| `status` | `number` | HTTP status assigned by the constructor and used by inherited `sendResponse(...)`. |

`label`, `code`, `message`, `data`, `toResponse()`, and
`sendResponse(...)` are inherited from `CTGPromptServerError`. `label`
is derived from `code`.

---

## Constructor

```ts
constructor(
    code: number,
    status: number,
    message: string,
    data?: null | boolean | number | string | object
);
```

Creates an HTTP-facing request error. The constructor calls
`super(code, message, data)` and assigns the supplied `status` argument
to `this.status`.

`code` must be the application/domain error code for the response, and
`status` must be the HTTP response status that the route error handler
will send with the inherited `toResponse()` body. The constructor does
not infer or override `status` from the code.

`toResponse()` and `sendResponse(...)` are inherited from
`CTGPromptServerError`. Route error handlers can call
`ctgPromptServerRequestError.sendResponse(response)` to send the
standard error body with the request error's explicit status.

---

## Static Methods

### STATIC :: CTGPromptServerRequestError.init

```ts
static init(
    code: number,
    status: number,
    message: string,
    data?: null | boolean | number | string | object
): CTGPromptServerRequestError;
```

Creates a `CTGPromptServerRequestError` with the same arguments as the
constructor. It exists as a low-level factory for cases where the caller
must pass an explicit status. Route handlers should prefer the named
request-error factories below so supported request error codes always
receive the correct HTTP status.

### STATIC :: CTGPromptServerRequestError.unauthorized

```ts
static unauthorized(
    message: string,
    data?: null | boolean | number | string | object
): CTGPromptServerRequestError;
```

Creates `UNAUTHORIZED` / `6` with HTTP status `401`.

### STATIC :: CTGPromptServerRequestError.invalidContentType

```ts
static invalidContentType(
    message: string,
    data?: null | boolean | number | string | object
): CTGPromptServerRequestError;
```

Creates `INVALID_CONTENT_TYPE` / `7` with HTTP status `415`.

### STATIC :: CTGPromptServerRequestError.invalidBody

```ts
static invalidBody(
    message: string,
    data?: null | boolean | number | string | object
): CTGPromptServerRequestError;
```

Creates `INVALID_BODY` / `8` with HTTP status `400`.

### STATIC :: CTGPromptServerRequestError.invalidPrompt

```ts
static invalidPrompt(
    message: string,
    data?: null | boolean | number | string | object
): CTGPromptServerRequestError;
```

Creates `INVALID_PROMPT` / `9` with HTTP status `400`.

### STATIC :: CTGPromptServerRequestError.invalidQuery

```ts
static invalidQuery(
    message: string,
    data?: null | boolean | number | string | object
): CTGPromptServerRequestError;
```

Creates `INVALID_QUERY` / `10` with HTTP status `400`.

### STATIC :: CTGPromptServerRequestError.promptNotFound

```ts
static promptNotFound(
    message: string,
    data?: null | boolean | number | string | object
): CTGPromptServerRequestError;
```

Creates `PROMPT_NOT_FOUND` / `11` with HTTP status `404`.

### STATIC :: CTGPromptServerRequestError.cancelNotAllowed

```ts
static cancelNotAllowed(
    message: string,
    data?: null | boolean | number | string | object
): CTGPromptServerRequestError;
```

Creates `CANCEL_NOT_ALLOWED` / `12` with HTTP status `409`.

### STATIC :: CTGPromptServerRequestError.notFound

```ts
static notFound(
    message: string,
    data?: null | boolean | number | string | object
): CTGPromptServerRequestError;
```

Creates `NOT_FOUND` / `13` with HTTP status `404`.

### STATIC :: CTGPromptServerRequestError.methodNotAllowed

```ts
static methodNotAllowed(
    message: string,
    data?: null | boolean | number | string | object
): CTGPromptServerRequestError;
```

Creates `METHOD_NOT_ALLOWED` / `14` with HTTP status `405`.


---

## Types

`CTGPromptServerRequestError` uses the shared error code and result
types owned by
[CTGPromptServerError](./01-CTGPromptServerError.md#types).

The inherited `code` field and request-specific `status` field are
assigned from constructor arguments. The inherited `label` getter is
derived from `code`. The response body produced by inherited
`toResponse()` is defined with [CTGPromptServer](./05-CTGPromptServer.md#types)
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
