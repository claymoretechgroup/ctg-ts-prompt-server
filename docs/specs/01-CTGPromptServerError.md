# CTGPromptServerError

`CTGPromptServerError` is the base error class for the prompt server. It
owns the registry of application error codes, stores a code, a message
and optional detail, derives a readable label from the code, renders
itself as the standard error response body, and can send that body
through an Express response.

It has no `status` property. Only
[CTGPromptServerRequestError](./02-CTGPromptServerRequestError.md), which
extends it, declares one; a base instance sends as `500`. It does not
own the shape of the response envelope: that is
[00-shared-types#TYPE-03](./00-shared-types.md). It does not normalize caught
values: the code that catches something builds the error it wants.

Every behavior attributed below to Express was probed against the
installed `express@5.2.1`: `response.status(n)` returns the same response
object, and `response.json(body)` sends `body` serialized with
`Content-Type: application/json`.

## Declarations

### Type Declarations

```ts
type CTGPromptServerErrorData = null | boolean | number | string | object;

interface CTGPromptServerErrorConfig {
    readonly code: number;
    readonly message: NonEmptyString;
    readonly data?: CTGPromptServerErrorData;
}

function isCTGPromptServerErrorData(value: unknown): value is CTGPromptServerErrorData;
function isCTGPromptServerErrorConfig(value: unknown): value is CTGPromptServerErrorConfig;
```

### Class Definition

```ts
class CTGPromptServerError extends Error {
    static readonly CODE: {
        readonly INVALID_CODE: -1;
        readonly INVALID_CONFIG: 1;
        readonly INTERNAL_ERROR: 2;
        readonly DATABASE_FAILED: 3;
        readonly RUNNER_FAILED: 4;
        readonly PROMPT_INTERRUPTED: 5;
        readonly UNAUTHORIZED: 6;
        readonly INVALID_CONTENT_TYPE: 7;
        readonly INVALID_BODY: 8;
        readonly INVALID_PROMPT: 9;
        readonly INVALID_QUERY: 10;
        readonly PROMPT_NOT_FOUND: 11;
        readonly CANCEL_NOT_ALLOWED: 12;
        readonly NOT_FOUND: 13;
        readonly METHOD_NOT_ALLOWED: 14;
        readonly UNKNOWN_ERROR: 15;
        readonly INVALID_MESSAGE: 16;
    };

    readonly code: number;
    readonly data: CTGPromptServerErrorData;

    constructor(config: CTGPromptServerErrorConfig);

    get label(): string;

    toResponse(): CTGPromptServerErrorResponse;
    sendResponse(response: Response): void;

    static init(config: CTGPromptServerErrorConfig): CTGPromptServerError;
    static is(value: unknown): value is CTGPromptServerError;
    static labelOf(code: number): string;
}
```

`Response` is Express's response type, imported from `express`;
`NonEmptyString` and `CTGPromptServerErrorResponse` are from
[00-shared-types](./00-shared-types.md). Imports are not shown in the
blocks.

## Types

| ID | Member | Requirement |
|---|---|---|
| TYPE-01 | `CTGPromptServerErrorData` | Detail attached to an error: `null`, a boolean, a number, a string, or an object, where an object may be a caught `Error`. It exists for the in-process instance, for logging and inspection, and is never part of a response body (MTHD-02). |
| TYPE-02 | `CTGPromptServerErrorConfig` | Construction config accepted by the constructor and `init`: a registry `code`, a `message` that is a [00-shared-types#TYPE-01](./00-shared-types.md) `NonEmptyString`, and optional `data`. |

TYPE-01 and TYPE-02 are not testable: they are compile-time
declarations visible to `tsc`, not to a test against the public surface.
They are covered by the Declarations section; their runtime meaning is
carried by PRED-01 through PRED-04.

## Type Predicates

| ID | Member | Requirement |
|---|---|---|
| PRED-01 | `isCTGPromptServerErrorData` | Returns `true` for `null`, and for any value whose `typeof` is `"boolean"`, `"number"`, `"string"` or `"object"`, including an `Error` instance, an array, and `NaN`. |
| PRED-02 | `isCTGPromptServerErrorData` | Returns `false` for `undefined`, a `symbol`, a `bigint`, and a function. |
| PRED-03 | `isCTGPromptServerErrorConfig` | Returns `true` when `typeof value` is `"object"`, `value` is not `null`, `Array.isArray(value)` is `false`, `typeof value.code` is `"number"`, [00-shared-types#PRED-01](./00-shared-types.md) `isNonEmptyString(value.message)` is `true`, and `value.data` is either absent, `undefined`, or a value for which PRED-01 is `true`. Accepted cases: `{ code: 1, message: "x" }`, `{ code: 0, message: "x" }` (a numeric code outside the registry is still a config), `{ code: 1, message: "x", data: undefined }`, `{ code: 1, message: "x", data: null }`, `{ code: 1, message: "x", data: new Error("e") }`. |
| PRED-04 | `isCTGPromptServerErrorConfig` | Returns `false` for `null`, `undefined`, a non-object, an array (even one carrying `code` and `message` properties), an object without a numeric `code`, an object whose `message` is not a non-empty string (absent, `""`, or a non-string), and an object whose `data` is present and fails PRED-01. |

## Static Fields

| ID | Member | Requirement |
|---|---|---|
| STFLD-01 | `CODE` | A readonly `as const` object holding exactly the seventeen entries in the Class Definition, with those values, and no others. |

Call sites use `CTGPromptServerError.CODE.<LABEL>`, never a literal;
that is guidance for other modules, not a requirement of this class.
`0` is not a code. The value `-1` is the sentinel described under
CNSTR-02 and STMTHD-06. Registry membership, not the numeric range, is
the rule: a requirement below that says "a value of `CODE` other than
`-1`" means exactly the sixteen positive entries, whatever their
numbers.

## Instance Fields

| ID | Member | Requirement |
|---|---|---|
| FLD-01 | `code` | The `code` from the construction config. |
| FLD-02 | `data` | The `data` from the construction config, or `null` when the config omitted it or passed `undefined`. |
| FLD-03 | `message` | The `message` from the construction config, unchanged, readable as `error.message`. |

`message` is not declared in the Class Definition because it is
inherited from `Error`; FLD-03 constrains the inherited member. `code`
and `data` are `readonly` in the Class Definition; that is a
compile-time property covered by the Declarations, not a testable
requirement.

## Constructor

| ID | Member | Requirement |
|---|---|---|
| CNSTR-01 | `constructor` | Given a value for which PRED-03 is `true` and whose `code` is a value of `CODE` other than `-1`, constructs an instance with `code`, `message` and `data` set per FLD-01, FLD-02 and FLD-03. |
| CNSTR-02 | `constructor` | Given a value for which PRED-03 is `true` but whose `code` is not a value of `CODE` other than `-1` — including `-1`, `0`, `17`, a non-integer, or `NaN` — throws an instance of `CTGPromptServerError` itself — never of a subclass, whatever class was being constructed — whose `code` is `-1`, whose `label` is `INVALID_CODE`, and whose `data` is the rejected `code` value itself: the number, not an object wrapping it. When the rejected `code` is `NaN`, `data` is `NaN`. |
| CNSTR-03 | `constructor` | Given an object whose `code` is a number and whose `message` fails `isNonEmptyString` — `""`, absent, `undefined`, or a non-string — throws an instance of `CTGPromptServerError` itself, never of a subclass, whose `code` is `16`, whose `label` is `INVALID_MESSAGE`, and whose `data` is the rejected `message` value when PRED-01 is `true` for it, and `null` when `message` was absent, `undefined`, or a value PRED-01 rejects (a `symbol`, a `bigint`, a function). |
| CNSTR-04 | `constructor` | Given a value for which PRED-04 is `true` for any reason other than the message — `null`, `undefined`, a non-object, an object without a numeric `code`, an array, or an object whose `data` is present and fails PRED-01 — throws an instance of `CTGPromptServerError` itself, never of a subclass, whose `code` is `-1`, whose `label` is `INVALID_CODE`, and whose `data` is `null`. |
| CNSTR-05 | `constructor` | Given a config whose `data` is any value for which PRED-01 is `true`, stores it as given; an `Error` instance passed as `data` is stored by reference, not copied or serialized. |

`-1` is a sentinel: it is the code of the error the constructor throws
to say "this is not a config the class can hold", and it is itself
rejected as input by CNSTR-02, so no caller can construct an instance
carrying it. That is why it sits in the registry at all. Precedence
when a value fails for more than one reason: a value that is not an
object, an array, or an object whose `code` is not a number, is
CNSTR-04 whatever its `message` is; among non-array objects with a
numeric `code`, the message check comes first, then the code check,
then the `data` check. So `{ code: 0, message: "" }` and
`{ code: 1, message: "", data: Symbol() }` both throw `INVALID_MESSAGE`
(CNSTR-03), and `{ code: 0, message: "x", data: Symbol() }` throws
`INVALID_CODE` with `data` `0` (CNSTR-02). Rejecting a bad `message`
at construction departs from the errors style guide, which rejects
only non-registry codes; the departure is deliberate, so that no
instance can carry an empty message into a response body (MTHD-01).
A subclass constructor passes
its config to this constructor, so a bad config given to a subclass
throws the same base-class instance. How the class builds the CNSTR-02,
CNSTR-03 and CNSTR-04 instances without re-entering its own check is
the implementation's concern.

## Properties

| ID | Member | Requirement |
|---|---|---|
| PROP-01 | `label` | Getter. Returns the label for `this.code` as STMTHD-05 and STMTHD-06 define it: an instance whose `code` is `1` has `label` `"INVALID_CONFIG"`. |

## Instance Methods

| ID | Member | Requirement |
|---|---|---|
| MTHD-01 | `toResponse` | Returns a new [00-shared-types#TYPE-03](./00-shared-types.md) `CTGPromptServerErrorResponse`: `{ success: false, result: { code: this.code, message: this.message } }`, with `success` the literal `false`. Each call returns a fresh object; mutating one does not affect the next. |
| MTHD-02 | `toResponse` | The returned object has no other properties: `data`, `label` and `status` are excluded, at the top level and inside `result`. |
| MTHD-03 | `sendResponse` | Calls `response.status(n)` where `n` is the value of the instance's `status` property when the instance has one for which `typeof` is `"number"`, passed as is, and `500` otherwise — including when the property is absent or holds a non-number. This class declares no `status` property, so an instance it constructs always sends `500`; a subclass that declares one sends that value without overriding this method, and that subclass is responsible for the value being a valid HTTP status. |
| MTHD-04 | `sendResponse` | Calls `json(body)` on the object `status` returned in MTHD-03 — `response.status(n).json(body)` — where `body` is the value `toResponse()` returns (MTHD-01). |
| MTHD-05 | `sendResponse` | Returns `undefined`. |

MTHD-03 is stated over a `status` property this class does not
declare, by design: it is the extension point a subclass uses by
declaring one, without overriding the method.

## Static Methods

| ID | Member | Requirement |
|---|---|---|
| STMTHD-01 | `init` | Given a config, returns a new instance constructed as by CNSTR-01, for which `is` returns `true`. It constructs with the receiving class, so a subclass that inherits `init` unchanged receives an instance of the subclass. |
| STMTHD-02 | `init` | Given a value CNSTR-02, CNSTR-03 or CNSTR-04 rejects, throws the same `CTGPromptServerError` that requirement describes; it does not return. |
| STMTHD-03 | `is` | Returns `true` for an instance of `CTGPromptServerError` and for an instance of any subclass of it. |
| STMTHD-04 | `is` | Returns `false` for `null`, `undefined`, a plain `Error`, and a plain object carrying `code` and `message` properties. |
| STMTHD-05 | `labelOf` | Given a value of `CODE` other than `-1`, returns the label whose registry value it is: `labelOf(1)` is `"INVALID_CONFIG"`, `labelOf(16)` is `"INVALID_MESSAGE"`, and so on for every entry. |
| STMTHD-06 | `labelOf` | Given `-1`, or any number that is not a value of `CODE` — including `0`, `17`, a non-integer and `NaN` — returns `"INVALID_CODE"`. |

## Errors

| ID | Code | Raised when |
|---|---|---|
| ERR-01 | `INVALID_CODE` / `-1` | The constructor or `init` receives a value that is not a config (CNSTR-04) or a config whose `code` is not a value of `CODE` other than `-1` (CNSTR-02). |
| ERR-02 | `INVALID_MESSAGE` / `16` | The constructor or `init` receives an object with a numeric `code` whose `message` is not a non-empty string (CNSTR-03). |

The other fifteen codes are raised by other classes; this document only
defines them (STFLD-01).

## Behavior

None

## Constraints

| ID | Does not |
|---|---|
| CONS-01 | Does not declare or set an HTTP status. Declaring one is a `CTGPromptServerRequestError` concern; an instance without one sends as `500` (MTHD-03). |
| CONS-02 | Does not render or send `data` (MTHD-02). |
| CONS-03 | Does not accept, wrap or normalize a caught value. A caller that catches something constructs the error it wants, choosing the code and passing the caught value as `data` if it wishes; the caught value is then stored by reference (CNSTR-05). |
| CONS-04 | Does not export a dedicated code type; `code` is `number` everywhere. |

CONS-01, CONS-02 and CONS-03 carry no case of their own: each is
folded into the requirement it cites (MTHD-03, MTHD-02 and CNSTR-05),
whose test covers it. CONS-04 is not testable: it is a compile-time
property visible to `tsc`, not to a test against the public surface. It
is covered by the Declarations section.

## Testing Considerations

| ID | IDs | Requirement |
|---|---|---|
| TEST-01 | CNSTR-02, CNSTR-03, CNSTR-04 | Observed by catching the thrown value and asserting `is(thrown)`, `thrown.code`, `thrown.label` and `thrown.data`. The `NaN` case of CNSTR-02 is observed with `Number.isNaN(thrown.data)`, not with equality. |
| TEST-02 | MTHD-03, MTHD-04, MTHD-05 | Observed against a fake response object that records the `status` argument and the `json` argument and returns itself from `status`, matching the probed Express behavior; no HTTP server is started. The fake is passed with an explicit cast to Express's `Response` type, since tests are type-checked and the fake does not satisfy that type structurally. |
| TEST-03 | MTHD-03 | The non-`500` branch is observed with a minimal subclass, declared in the test, whose constructor sets `status` to a number such as `404`; `CTGPromptServerRequestError` is not constructed, since it is specified and tested later. |
| TEST-04 | STFLD-01 | Observed by deep equality against the full seventeen-entry literal, so an added or removed entry fails. |
| TEST-05 | CNSTR-01, CNSTR-02, STMTHD-05, STMTHD-06 | The registry boundaries are cased on both sides: `0` and `17` rejected, `1` and `16` accepted. |
| TEST-06 | CNSTR-04, PRED-04 | Cased with `null`, `undefined`, a string, an array carrying `code` and `message`, an object with no `code`, an object whose `code` is a string and whose `message` is `""` (which throws `INVALID_CODE`, not `INVALID_MESSAGE`), and an object whose `data` is a `symbol`. Each invalid value is passed to the constructor with an explicit cast to `CTGPromptServerErrorConfig`, since tests are type-checked. |
| TEST-07 | CNSTR-03 | Cased with `message` `""`, `message` absent, `message` explicitly `undefined`, and `message` a number, each passed with an explicit cast; the thrown `data` is compared to the rejected value, or `null` for the absent and `undefined` cases. |
| TEST-08 | PRED-01, PRED-02, PRED-03, PRED-04 | The predicates are driven directly with the named accepted and rejected values; no instance is constructed. |
| TEST-09 | MTHD-01, MTHD-02 | Observed by deep equality of the returned object against the literal `{ success: false, result: { code, message } }`, and by asserting [00-shared-types#PRED-05](./00-shared-types.md) `isCTGPromptServerErrorResponse` returns `true` for it. |
