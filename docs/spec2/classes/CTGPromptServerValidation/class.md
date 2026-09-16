# CTGPromptServerValidation

`CTGPromptServerValidation` is a static-only validation utility used by
class implementations for shared primitive checks. It is not a runtime
service, does not own application behavior, and must not store mutable
state.

`CTGPromptServer` uses this class while validating
`CTGPromptServerConfig` in `CTGPromptServer.init(...)`. Other class
implementations may use it when they need the same primitive validation
rules, such as non-empty strings, integer ranges, supported runner
kinds, or supported stream modes.

```ts
class CTGPromptServerValidation {
    private constructor();

    static readonly LITERALS: CTGPromptServerValidationLiterals;

    static isObject(value: unknown): value is Record<string, unknown>;
    static nonEmptyString(value: unknown, label: string): string;
    static stringArray(value: unknown, label: string): string[];
    static objectEnv(value: unknown, label: string): NodeJS.ProcessEnv;
    static optionalBoolean(value: unknown, label: string): boolean | undefined;
    static integer(value: unknown, label: string, min: number, max?: number): number;
    static optionalInteger(value: unknown, label: string, min: number, max?: number): number | undefined;
    static runnerKind(value: unknown, label: string): CTGPromptRunnerType;
    static optionalStreamMode(value: unknown, label: string): CTGPromptStreamMode | undefined;
}
```

---

## Properties

| Property | Type | Description |
|---|---|---|
| `LITERALS` | `CTGPromptServerValidationLiterals` | Frozen literal sets accepted by validation helpers. |

`LITERALS` is used to document and centralize primitive literal sets. It
does not replace the class-specific behavior described in the owning
class specs.

---

## Constructor

```ts
private constructor();
```

`CTGPromptServerValidation` is static-only. Callers must not instantiate it.

---

## Static Methods

### STATIC :: CTGPromptServerValidation.isObject

```ts
static isObject(value: unknown): value is Record<string, unknown>;
```

Returns whether `value` is a non-null object. Arrays are still objects
for this primitive check; callers that require a plain object must reject
arrays separately.

### STATIC :: CTGPromptServerValidation.nonEmptyString

```ts
static nonEmptyString(value: unknown, label: string): string;
```

Returns `value` when it is a string whose trimmed value is not empty.
Invalid values throw `Error` with a message that includes `label`.

### STATIC :: CTGPromptServerValidation.stringArray

```ts
static stringArray(value: unknown, label: string): string[];
```

Returns a shallow copy of `value` when it is an array of strings.
Invalid values throw `Error` with a message that includes `label`.

### STATIC :: CTGPromptServerValidation.objectEnv

```ts
static objectEnv(value: unknown, label: string): NodeJS.ProcessEnv;
```

Returns `value` as a child-process environment object when it is a
non-array object. Invalid values throw `Error` with a message that
includes `label`.

### STATIC :: CTGPromptServerValidation.optionalBoolean

```ts
static optionalBoolean(value: unknown, label: string): boolean | undefined;
```

Returns `undefined` when `value` is `undefined`; otherwise returns
`value` when it is a boolean. Invalid values throw `Error` with a
message that includes `label`.

### STATIC :: CTGPromptServerValidation.integer

```ts
static integer(value: unknown, label: string, min: number, max?: number): number;
```

Returns `value` when it is an integer within the inclusive `min` and
optional `max` bounds. Invalid values throw `Error` with a message that
includes `label`.

### STATIC :: CTGPromptServerValidation.optionalInteger

```ts
static optionalInteger(value: unknown, label: string, min: number, max?: number): number | undefined;
```

Returns `undefined` when `value` is `undefined`; otherwise applies the
same rules as `integer(...)`.

### STATIC :: CTGPromptServerValidation.runnerKind

```ts
static runnerKind(value: unknown, label: string): CTGPromptRunnerType;
```

Returns `value` when it is a supported runner kind. Spec2 supports only
`claude` and `codex`; future runner kinds, such as Ollama, require a
spec update before implementation.

### STATIC :: CTGPromptServerValidation.optionalStreamMode

```ts
static optionalStreamMode(value: unknown, label: string): CTGPromptStreamMode | undefined;
```

Returns `undefined` when `value` is `undefined`; otherwise returns
`value` when it is a supported stream mode. Spec2 supports `raw` and
`events`.
