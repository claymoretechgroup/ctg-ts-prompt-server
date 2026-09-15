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
constructor. It exists as a named factory for call sites that prefer
factory construction over `new`.
