# CTGPromptServerDB Types

### CTGPromptServerDBConfig

```ts
interface CTGPromptServerDBConfig {
    readonly path: string;
    readonly initDB?: boolean;
}
```

| Property | Type | Required | Meaning |
|---|---|---:|---|
| `path` | `string` | yes | Filesystem path to the SQLite database. |
| `initDB` | `boolean` | no | Whether to create or migrate the schema during initialization. |

### CTGPromptServerQueueRecord

```ts
interface CTGPromptServerQueueRecord {
    readonly id: number;
    readonly statusCode: number;
    readonly prompt: string;
    readonly response: string;
    readonly errorCode: number | null;
    readonly errorMessage: string | null;
    readonly runner: CTGPromptRunnerType | null;
    readonly createdAt: number;
    readonly startedAt: number | null;
    readonly finishedAt: number | null;
}
```

| Property | Type | Required | Meaning |
|---|---|---:|---|
| `id` | `number` | yes | Stable queue record ID. |
| `statusCode` | `number` | yes | Durable lifecycle status code. |
| `prompt` | `string` | yes | Raw prompt text submitted by the client. |
| `response` | `string` | yes | Accumulated or final response text. |
| `errorCode` | `number \| null` | yes | Stored prompt failure application code, or `null` when there is no error. |
| `errorMessage` | `string \| null` | yes | Stored prompt failure message, or `null` when there is no error. |
| `runner` | `CTGPromptRunnerType \| null` | yes | Optional runner type metadata for the record. |
| `createdAt` | `number` | yes | Epoch milliseconds when the record was submitted. |
| `startedAt` | `number \| null` | yes | Epoch milliseconds when the record was claimed. |
| `finishedAt` | `number \| null` | yes | Epoch milliseconds when the record reached terminal state. |

### CTGPromptPagination

```ts
interface CTGPromptPagination {
    readonly statusCode?: number;
    readonly limit: number;
    readonly before?: number;
}
```

| Property | Type | Required | Meaning |
|---|---|---:|---|
| `statusCode` | `number` | no | Optional durable status-code filter. |
| `limit` | `number` | yes | Maximum number of records to return. |
| `before` | `number` | no | Cursor ID; only records with an ID less than this value are returned. |

### CTGPromptPaginationPage

```ts
interface CTGPromptPaginationPage {
    readonly records: CTGPromptServerQueueRecord[];
    readonly nextBefore: number | null;
}
```

| Property | Type | Required | Meaning |
|---|---|---:|---|
| `records` | `CTGPromptServerQueueRecord[]` | yes | Current page of prompt queue records. |
| `nextBefore` | `number \| null` | yes | Cursor for the next page, or `null` when no next page exists. |

---
