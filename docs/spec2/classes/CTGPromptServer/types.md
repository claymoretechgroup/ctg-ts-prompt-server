# CTGPromptServer Types

### CTGPromptRunnerType

```ts
type CTGPromptRunnerType = "claude" | "codex";
```

| Value | Meaning |
|---|---|
| `claude` | Use the Claude `LLMRunner` implementation. |
| `codex` | Use the Codex `LLMRunner` implementation. |

`CTGPromptRunnerType` identifies the concrete `LLMRunner` implementation
selected by server configuration. Spec2 supports only `claude` and
`codex`.

Future runner types are an explicit extension point. For example,
`ollama` could be added later by extending `CTGPromptRunnerType`,
teaching `CTGPromptServer.createRunner(...)` how to construct the runner,
and adding any stream extraction rules required for
`streamMode = "events"`. No database schema change is required unless
runner type values are constrained in SQLite.

### CTGPromptRunnerConfig

```ts
interface CTGPromptRunnerConfig {
    type: CTGPromptRunnerType;
    cwd?: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    maxBuffer?: number;
}
```

| Property | Type | Required | Meaning |
|---|---|---:|---|
| `type` | `CTGPromptRunnerType` | yes | Runner implementation to construct. |
| `cwd` | `string` | no | Working directory for runner child processes. |
| `args` | `string[]` | no | Additional runner arguments. |
| `env` | `NodeJS.ProcessEnv` | no | Complete child process environment replacement. |
| `timeout` | `number` | no | Runner timeout in milliseconds. |
| `maxBuffer` | `number` | no | Maximum buffered runner output. |

### CTGPromptServerConfig

```ts
interface CTGPromptServerConfig {
    runner: CTGPromptRunnerConfig;
    apiKey: string;
    host?: string;
    database?: string;
    initDB?: boolean;
    concurrency?: number;
    maxPromptBytes?: number;
    streamMode?: CTGPromptStreamMode;
    keepAliveMs?: number;
    maxWaitMs?: number;
    defaultLimit?: number;
    maxLimit?: number;
}
```

| Property | Type | Required | Meaning |
|---|---|---:|---|
| `runner` | `CTGPromptRunnerConfig` | yes | Runner construction configuration. |
| `apiKey` | `string` | yes | Bearer token required by every route. |
| `host` | `string` | no | Host passed to server binding. |
| `database` | `string` | no | SQLite database path. |
| `initDB` | `boolean` | no | Whether to initialize the database schema. |
| `concurrency` | `number` | no | Maximum number of active runners. |
| `maxPromptBytes` | `number` | no | Maximum accepted prompt size in UTF-8 bytes. |
| `streamMode` | `CTGPromptStreamMode` | no | Stream format used to extract response text. |
| `keepAliveMs` | `number` | no | SSE keep-alive interval in milliseconds. |
| `maxWaitMs` | `number` | no | Maximum long-poll wait in milliseconds. |
| `defaultLimit` | `number` | no | Default pagination page size. |
| `maxLimit` | `number` | no | Maximum accepted pagination page size. |

Defaults:

| Property | Default |
|---|---|
| `host` | `"127.0.0.1"` |
| `database` | `"prompts.db"` |
| `initDB` | `true` |
| `concurrency` | `1` |
| `maxPromptBytes` | `131071` |
| `streamMode` | `"events"` |
| `keepAliveMs` | `15000` |
| `maxWaitMs` | `30000` |
| `defaultLimit` | `50` |
| `maxLimit` | `200` |

`CTGPromptStreamMode` is owned by
[CTGPromptServerQueue types](../CTGPromptServerQueue/types.md). Spec2 supports
`"raw"` and `"events"`. `"raw"` appends response text from stdout output
chunks; `"events"` appends response text by parsing supported structured
runner events.

### CTGPromptServerResponse

```ts
type CTGPromptServerResponse<TResult> =
    | CTGPromptServerSuccessResponse<TResult>
    | CTGPromptErrorResponse;
```

`CTGPromptServerResponse<TResult>` is the JSON response body shape for
all non-SSE HTTP routes. Successful responses carry a route-specific
payload in `result`; error responses carry only the public error code
and message.

### CTGPromptServerSuccessResponse

```ts
interface CTGPromptServerSuccessResponse<TResult> {
    readonly success: true;
    readonly result: TResult;
}
```

### CTGPromptErrorResponse

```ts
interface CTGPromptErrorResponse {
    readonly success: false;
    readonly result: {
        readonly code: number;
        readonly message: string;
    };
}
```

HTTP JSON routes respond with one of these response bodies. SSE routes
respond with `text/event-stream`, not a JSON response body after the
stream opens.

`CTGPromptErrorResponse` is returned by `CTGPromptServerError.toResponse()`
for every non-SSE route error when JSON can still be sent, including
request validation failures, `METHOD_NOT_ALLOWED`, `NOT_FOUND`, database
failures, and internal errors. Any `CTGPromptServerError` can send this
body through `sendResponse(response)`; base errors default to HTTP `500`,
while request errors use their constructor-assigned `status`. The SSE
route also returns this shape for errors detected before SSE headers are
written, such as an unknown prompt ID.

The response body intentionally excludes error `data`, labels, and HTTP
status. `data` remains available on the in-process error instance for
inspection or logging; HTTP status is sent through the Express response.

### CTGPromptRecordResponse

```ts
interface CTGPromptRecordResponse
    extends CTGPromptServerSuccessResponse<CTGPromptServerQueueRecord> {}
```

`CTGPromptRecordResponse` is returned by routes whose successful payload
is one prompt record, such as `POST /prompt`, `GET /prompt/:id`, and
`DELETE /prompt/:id`. The prompt record shape is the DB-owned
`CTGPromptServerQueueRecord`; the server does not define a separate prompt
record projection in spec2.

### CTGPromptPageResponse

```ts
interface CTGPromptPageResponse
    extends CTGPromptServerSuccessResponse<{
        readonly records: CTGPromptServerQueueRecord[];
        readonly nextBefore: number | null;
    }> {}
```

`CTGPromptPageResponse` is returned by `GET /prompts` and
`GET /prompts/:status`. `result.records` is always an array. When no
records match the query, `result.records` is empty and
`result.nextBefore` is `null`.

### CTGPromptSSESink

```ts
type CTGPromptSSESink = {
    write(chunk: string): void;
    end(): void;
    readonly writableEnded?: boolean;
};
```

`CTGPromptSSESink` is the structural sink used by live SSE delivery.
Express responses satisfy this shape. `CTGPromptServer` stores these
sinks in its `_sse` registry, and server-owned SSE helpers accept this
shape when the `/sse/:id` route opens a stream.
