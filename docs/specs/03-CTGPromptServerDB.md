# CTGPromptServerDB

`CTGPromptServerDB` owns SQLite access for durable prompt queue records. It
does not know about HTTP, SSE, agent workers, or live clients.

```ts
class CTGPromptServerDB {
    private readonly _db: DatabaseSync;

    constructor(config: CTGPromptServerDBConfig);

    create(prompt: string): CTGPromptServerQueueRecord;
    read(id: number): CTGPromptServerQueueRecord | null;
    paginate(pagination: CTGPromptPagination): CTGPromptPaginationPage;
    update(record: CTGPromptServerQueueRecord): CTGPromptServerQueueRecord;
    delete(id: number): CTGPromptServerQueueRecord | null;
    append(id: number, text: string): CTGPromptServerQueueRecord;

    claimNext(): CTGPromptServerQueueRecord | null;
    finish(id: number, outcome: {
        readonly statusCode: number;
        readonly response?: string;
        readonly errorCode?: number;
        readonly errorMessage?: string;
    }): CTGPromptServerQueueRecord;
    cancel(id: number): CTGPromptServerQueueRecord;
    interruptActive(): number;

    close(): void;

    static init(config: CTGPromptServerDBConfig): CTGPromptServerDB;
}
```

### Properties

| Property | Type | Description |
|---|---|---|
| `_db` | `DatabaseSync` | Internal SQLite connection used for all prompt queue record operations. |

### Constructor

```ts
constructor(config: CTGPromptServerDBConfig);
```

Opens the configured SQLite database, applies required pragmas, and
initializes the schema when `config.initDB !== false`. The constructor
throws `INVALID_CONFIG` / `1` when the database cannot be opened or
the schema is unavailable.

| Argument | Type | Description |
|---|---|---|
| `config` | `CTGPromptServerDBConfig` | Database path and schema-initialization options. |

### Instance Methods

#### INSTANCE :: ctgPromptServerDB.create

```ts
create(prompt: string): CTGPromptServerQueueRecord;
```

Inserts one pending prompt queue record with `status_code = 1`, the raw
prompt text, an empty response, and `created_at = Date.now()`. It returns
the created `CTGPromptServerQueueRecord` and throws a store/config error if the
insert fails.

| Argument | Type | Description |
|---|---|---|
| `prompt` | `string` | Raw prompt text to store exactly as submitted. |

---

#### INSTANCE :: ctgPromptServerDB.read

```ts
read(id: number): CTGPromptServerQueueRecord | null;
```

Reads one prompt queue record by ID. It returns the materialized
`CTGPromptServerQueueRecord` when found, or `null` when no row exists; it does
not mutate the database.

| Argument | Type | Description |
|---|---|---|
| `id` | `number` | Queue record ID to read. |

---

#### INSTANCE :: ctgPromptServerDB.paginate

```ts
paginate(pagination: CTGPromptPagination): CTGPromptPaginationPage;
```

Returns records ordered by newest ID first, optionally filtered by
`pagination.statusCode`. `pagination.before` is a cursor, so
`before: 120` returns rows where `id < 120`; the result includes
`nextBefore` when another page is available.

| Argument | Type | Description |
|---|---|---|
| `pagination` | `CTGPromptPagination` | Page size, optional status filter, and optional cursor ID. |

_Example_

```ts
const page = db.paginate({ statusCode: 1, limit: 50, before: 120 });
```

---

#### INSTANCE :: ctgPromptServerDB.update

```ts
update(record: CTGPromptServerQueueRecord): CTGPromptServerQueueRecord;
```

Persists mutable fields from an existing `CTGPromptServerQueueRecord` and
returns the updated materialized record. `record.id` selects the row;
`id`, `prompt`, and `createdAt` remain immutable, and unknown IDs throw
`PROMPT_NOT_FOUND` / `11`.

| Argument | Type | Description |
|---|---|---|
| `record` | `CTGPromptServerQueueRecord` | Existing queue record carrying the mutable values to persist. |

---

#### INSTANCE :: ctgPromptServerDB.delete

```ts
delete(id: number): CTGPromptServerQueueRecord | null;
```

Deletes one prompt queue record by ID. It returns the deleted
`CTGPromptServerQueueRecord`, or `null` when no row exists; deletion is a
durable database mutation.

| Argument | Type | Description |
|---|---|---|
| `id` | `number` | Queue record ID to delete. |

---

#### INSTANCE :: ctgPromptServerDB.append

```ts
append(id: number, text: string): CTGPromptServerQueueRecord;
```

Appends `text` to the record's `response` column without changing
`statusCode`, then returns the updated record. Unknown IDs throw
`PROMPT_NOT_FOUND` / `11`; implementations should use SQLite string
concatenation so concurrent appends remain atomic.

| Argument | Type | Description |
|---|---|---|
| `id` | `number` | Queue record ID whose response should be appended. |
| `text` | `string` | Response text fragment to append. |

---

#### INSTANCE :: ctgPromptServerDB.claimNext

```ts
claimNext(): CTGPromptServerQueueRecord | null;
```

Atomically claims the oldest pending record by changing `status_code`
from `1` to `2` and setting `started_at`. It returns the claimed record,
or `null` when no pending work exists; the update condition must include
`WHERE status_code = 1` so cancellation and claiming cannot both win.

| Argument | Type | Description |
|---|---|---|
| none | none | This method takes no arguments. |

---

#### INSTANCE :: ctgPromptServerDB.finish

```ts
finish(id: number, outcome: {
    readonly statusCode: number;
    readonly response?: string;
    readonly errorCode?: number;
    readonly errorMessage?: string;
}): CTGPromptServerQueueRecord;
```

Moves a record to terminal status code `3` or `-1`, writes response or
error fields, and sets `finishedAt = Date.now()`. Successful finishes
clear error fields; failed finishes default `errorCode` to `2` when not
supplied.

Valid finish status codes are `CTGPromptServerQueue.STATUS.DONE` and
`CTGPromptServerQueue.STATUS.ERROR`. `CANCELLED` is terminal queue state, but
it is written by `cancel(...)`, not `finish(...)`.

| Argument | Type | Description |
|---|---|---|
| `id` | `number` | Queue record ID to finish. |
| `outcome` | object | Terminal status, response or error values. |

_Examples_

```ts
const done = db.finish(record.id, {
    statusCode: 3,
    response: "Final response text."
});

const failed = db.finish(record.id, {
    statusCode: -1,
    errorCode: 4,
    errorMessage: "Runner failed."
});
```

---

#### INSTANCE :: ctgPromptServerDB.cancel

```ts
cancel(id: number): CTGPromptServerQueueRecord;
```

Cancels only pending records by setting `statusCode = 5` and
`finishedAt = Date.now()`. Unknown IDs throw `PROMPT_NOT_FOUND`, and
active or finished records throw `CANCEL_NOT_ALLOWED`.

| Argument | Type | Description |
|---|---|---|
| `id` | `number` | Pending queue record ID to cancel. |

---

#### INSTANCE :: ctgPromptServerDB.interruptActive

```ts
interruptActive(): number;
```

Moves every active record to error status with `error_code = 5`, an
interrupted message, and `finished_at = Date.now()`. It returns the
number of rows changed. `CTGPromptServer` calls this while starting up
so every record left active by a previous server stop is updated to the
interrupted terminal outcome before new work is claimed.

| Argument | Type | Description |
|---|---|---|
| none | none | This method takes no arguments. |

---

#### INSTANCE :: ctgPromptServerDB.close

```ts
close(): void;
```

Closes the underlying SQLite connection. It returns nothing; callers
should not use the `CTGPromptServerDB` instance after closing it.

| Argument | Type | Description |
|---|---|---|
| none | none | This method takes no arguments. |

### Protected Methods

No protected methods are specified for `CTGPromptServerDB`.

### Private Methods

No private methods are specified for `CTGPromptServerDB`.

### Static Methods

#### STATIC :: CTGPromptServerDB.init

```ts
static init(config: CTGPromptServerDBConfig): CTGPromptServerDB;
```

Constructs and returns a `CTGPromptServerDB` instance. This is the public
factory used by `CTGPromptServer` and tests; it has the same side
effects and exceptions as the constructor.

| Argument | Type | Description |
|---|---|---|
| `config` | `CTGPromptServerDBConfig` | Database path and schema-initialization options. |

---


---

## Types

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


