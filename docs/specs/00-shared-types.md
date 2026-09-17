# Shared Types

The types and type predicates every class in `ctg-ts-prompt-server` may
use. They are implemented in `src/shared.types.ts` before any class, and class
documents cite them by qualified ID rather than redefining them.

This document owns two things: the HTTP response envelope, which the
server sends and the error class writes, and the constrained scalar
vocabulary the classes validate against. It owns no class, raises no
error, and depends on nothing in the project.

## Declarations

### Type Declarations

```ts
type NonEmptyString = string;

interface CTGPromptServerResponse<TResult = unknown> {
    readonly success: boolean;
    readonly result: TResult;
}

interface CTGPromptServerErrorResponse extends CTGPromptServerResponse<{
    readonly code: number;
    readonly message: string;
}> {
    readonly success: false;
}

function isNonEmptyString(value: unknown): value is NonEmptyString;
function isCTGPromptServerResponse(value: unknown): value is CTGPromptServerResponse;
function isCTGPromptServerErrorResponse(value: unknown): value is CTGPromptServerErrorResponse;
```

## Types

| ID | Member | Requirement |
|---|---|---|
| TYPE-01 | `NonEmptyString` | A `string` with at least one character. The alias carries no compile-time distinction from `string`; `isNonEmptyString` is its meaning. |
| TYPE-02 | `CTGPromptServerResponse<TResult>` | The envelope of every non-SSE HTTP response body: a boolean `success` and a `result` of the route's payload type. A successful response is this shape with `success` `true`. |
| TYPE-03 | `CTGPromptServerErrorResponse` | Extends TYPE-02 with `result` fixed to a numeric `code` and a string `message`, and `success` fixed to the literal `false`. The body of every error HTTP response. |

TYPE-01 through TYPE-03 are not testable: they are compile-time
declarations visible to `tsc`, not to a test against the public surface.
They are covered by the Declarations section. Their runtime meaning is
carried by the predicates below.

## Type Predicates

| ID | Member | Requirement |
|---|---|---|
| PRED-01 | `isNonEmptyString` | Returns `true` when `typeof value` is `"string"` and `value.length` is at least `1`; a string of only whitespace such as `" "` qualifies. |
| PRED-02 | `isNonEmptyString` | Returns `false` for any value that does not meet every condition of PRED-01. |
| PRED-03 | `isCTGPromptServerResponse` | Returns `true` when `typeof value` is `"object"`, `value` is not `null`, `typeof value.success` is `"boolean"`, and `"result" in value` is `true` — so a `result` holding `undefined` counts, and `success` and `result` inherited from the prototype chain both count. |
| PRED-04 | `isCTGPromptServerResponse` | Returns `false` for any value that does not meet every condition of PRED-03. |
| PRED-05 | `isCTGPromptServerErrorResponse` | Returns `true` when PRED-03 is `true`, `value.success` is the literal `false`, `typeof value.result` is `"object"` and not `null`, `typeof value.result.code` is `"number"`, and `typeof value.result.message` is `"string"`. |
| PRED-06 | `isCTGPromptServerErrorResponse` | Returns `false` for any value that does not meet every condition of PRED-05. |

Whitespace-only strings are deliberately non-empty (PRED-01): the
predicate answers "is there a string here", not "is it meaningful".
A class that needs trimmed input says so in its own requirements.

## Constraints

| ID | Does not |
|---|---|
| CONS-01 | Does not define a separate success response type: a successful body is `CTGPromptServerResponse<TResult>` with `success` `true`, and no class narrows to it at runtime. |
| CONS-02 | Does not brand `NonEmptyString`; it is a plain alias and `isNonEmptyString` is the only enforcement. |

CONS-01 and CONS-02 are not testable: they describe what is absent from
a compile-time surface. They are covered by the Declarations section.

## Testing Considerations

| ID | IDs | Requirement |
|---|---|---|
| TEST-01 | PRED-01, PRED-02 | The boundary is cased on both sides: `""` rejected and `" "` accepted, alongside `"a"`; a `String` object is the input that isolates the string-primitive condition. |
| TEST-02 | PRED-03, PRED-04, PRED-05, PRED-06 | The predicates are driven with hand-built plain objects; no error instance and no HTTP call is involved. Each accept requirement is exercised by an input meeting every condition and, for each of its conditions, by one input violating only that condition; the spec does not enumerate rejected values. Accepted forms worth naming: a body with `success` `false`, a `result` holding `undefined`, and values whose `success` and `result` are inherited through the prototype chain, all accepted by PRED-03; an array carrying the required properties is an object and is accepted wherever an object is. A function carrying the required properties has `typeof` `"function"` and is the input that isolates the object condition. |
