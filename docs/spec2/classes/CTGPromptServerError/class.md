# CTGPromptServerError

`CTGPromptServerError` is the base normalized error class for the prompt
server. It stores a stable application/domain `code`, human `message`,
and optional JSON-safe `data`. Its readable `label` is derived from
`code`. It can serialize itself into the standard HTTP JSON error
response body and send that body through an Express response.

[`CTGPromptServerRequestError`](../CTGPromptServerRequestError/class.md)
extends `CTGPromptServerError` for HTTP request validation and routing
errors.

```ts
class CTGPromptServerError extends Error {
    static readonly CODE = {
        INVALID_CODE: -1,
        INVALID_CONFIG: 1,
        INTERNAL_ERROR: 2,
        DATABASE_FAILED: 3,
        RUNNER_FAILED: 4,
        PROMPT_INTERRUPTED: 5,
        UNAUTHORIZED: 6,
        INVALID_CONTENT_TYPE: 7,
        INVALID_BODY: 8,
        INVALID_PROMPT: 9,
        INVALID_QUERY: 10,
        PROMPT_NOT_FOUND: 11,
        CANCEL_NOT_ALLOWED: 12,
        NOT_FOUND: 13,
        METHOD_NOT_ALLOWED: 14,
        UNKNOWN_ERROR: 15
    } as const;

    readonly code: number;
    readonly data: null | boolean | number | string | object;

    get label(): string;

    constructor(
        code: number,
        message: string,
        data?: null | boolean | number | string | object
    );

    toResponse(): CTGPromptErrorResponse;
    sendResponse(response: Response): void;

    static init(
        code: number,
        message: string,
        data?: null | boolean | number | string | object
    ): CTGPromptServerError;
    static is(value: unknown): value is CTGPromptServerError;
    static labelOf(code: number): string;
}
```

---

## Properties

| Property | Type | Description |
|---|---|---|
| `code` | `number` | Stable application/domain error code. |
| `message` | `string` | Human-readable error message inherited from `Error`. |
| `data` | `null \| boolean \| number \| string \| object` | Optional JSON-safe error details. |

`label` is exposed as a getter derived from `code`; it is not stored as a
separate constructor value.

`code` is not an HTTP status. `CTGPromptServerError` does not define a
base `status` field; base errors send with HTTP `500` unless a subclass
defines its own `status`.

`CODE` is the static readonly label-to-code registry. Callers use it to
set codes without hard-coding raw values, for example
`CTGPromptServerError.CODE.INVALID_CONFIG`. Labels remain readable
response values derived from stored codes; callers do not pass labels to
constructors.

---

## Constructors

### CONSTRUCTOR :: CTGPromptServerError

```ts
constructor(
    code: number,
    message: string,
    data?: null | boolean | number | string | object
);
```

Creates a normalized server error. The constructor validates that `code`
is a supported value in `CTGPromptServerError.CODE`, then assigns the
supplied `code` and `data` arguments to the instance. If `code` is
missing or unsupported, the constructor throws an `INVALID_CODE` / `-1`
error.

`UNKNOWN_ERROR` / `15` is reserved for wrapping caught values that are
not already `CTGPromptServerError` instances.

When `data` is omitted, the constructor stores `null`. Spec2 keeps the
type intentionally broad for now: strings, numbers, booleans, objects,
arrays, and `null` are valid. `data` is retained only on the in-process
error instance for inspection or logging and is never serialized by
`toResponse()`.

---

## Instance Methods

### GETTER :: ctgPromptServerError.label

```ts
get label(): string;
```

Returns the readable error label for `this.code` from
`CTGPromptServerError.labelOf(this.code)`.

### INSTANCE :: ctgPromptServerError.toResponse

```ts
toResponse(): CTGPromptErrorResponse;
```

Returns the standard HTTP JSON error response body:

```ts
{
    success: false,
    result: {
        code: this.code,
        message: this.message
    }
}
```

The HTTP status is intentionally not embedded in the response body.
`data` is also intentionally excluded because it may contain private
diagnostic context or unserializable caught objects. `toResponse()` does
not send through Express; it only returns the JSON body. Use
`sendResponse(...)` when the error should write to an Express response.

### INSTANCE :: ctgPromptServerError.sendResponse

```ts
sendResponse(response: Response): void;
```

Sends the error through an Express `Response` object:

```ts
response
    .status("status" in this ? this.status : 500)
    .json(this.toResponse());
```

`sendResponse(...)` uses a subclass-provided `status` when the instance
defines one, such as `CTGPromptServerRequestError.status`; otherwise it
defaults to `500`.

---

## Static Methods

### STATIC :: CTGPromptServerError.init

```ts
static init(
    code: number,
    message: string,
    data?: null | boolean | number | string | object
): CTGPromptServerError;
```

Creates a `CTGPromptServerError` with the same arguments as the
constructor. It exists as a named factory for call sites that prefer
factory construction over `new`.

### STATIC :: CTGPromptServerError.is

```ts
static is(value: unknown): value is CTGPromptServerError;
```

Returns whether `value` is a `CTGPromptServerError` instance.

### STATIC :: CTGPromptServerError.labelOf

```ts
static labelOf(code: number): string;
```

Resolves an application/domain code to its error label using
the reverse lookup of `CTGPromptServerError.CODE`. Unknown codes resolve
to `INVALID_CODE`.
