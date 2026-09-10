# ctg-ts-prompt-server spec2 classes

**Status:** proposed standalone class specification.

This document specifies class surfaces and method behavior for spec2.
Database schema is defined in `docs/spec2.db.md`. Type declarations are
defined in `docs/spec2.types.md`.

---

## 1. CTGPromptDB

`CTGPromptDB` owns SQLite access for durable prompt queue records. It
does not know about HTTP, SSE, agent workers, or live clients.

```ts
class CTGPromptDB {
    private readonly _db: DatabaseSync;

    constructor(config: CTGPromptDBConfig);

    create(prompt: string): CTGPromptQueueRecord;
    read(id: number): CTGPromptQueueRecord | null;
    paginate(pagination: CTGPromptPagination): CTGPromptPaginationPage;
    update(record: CTGPromptQueueRecord): CTGPromptQueueRecord;
    delete(id: number): CTGPromptQueueRecord | null;
    append(id: number, text: string): CTGPromptQueueRecord;

    claimNext(): CTGPromptQueueRecord | null;
    finish(id: number, outcome: CTGPromptDBPromptOutcome): CTGPromptQueueRecord;
    cancel(id: number): CTGPromptQueueRecord;
    interruptActive(): number;

    close(): void;

    static init(config: CTGPromptDBConfig): CTGPromptDB;
}
```

### Properties

| Property | Type | Description |
|---|---|---|
| `_db` | `DatabaseSync` | Internal SQLite connection used for all prompt queue record operations. |

### Constructor

```ts
constructor(config: CTGPromptDBConfig);
```

Opens the configured SQLite database, applies required pragmas, and
initializes the schema when `config.initDB !== false`. The constructor
throws `CTGPromptServerError("INVALID_CONFIG")` when the database cannot
be opened or the schema is unavailable.

| Argument | Type | Description |
|---|---|---|
| `config` | `CTGPromptDBConfig` | Database path and schema-initialization options. |

### Instance Methods

#### INSTANCE :: ctgPromptDB.create

```ts
create(prompt: string): CTGPromptQueueRecord;
```

Inserts one pending prompt queue record with `status_code = 1`, the raw
prompt text, an empty response, and `created_at = Date.now()`. It returns
the created `CTGPromptQueueRecord` and throws a store/config error if the
insert fails.

| Argument | Type | Description |
|---|---|---|
| `prompt` | `string` | Raw prompt text to store exactly as submitted. |

---

#### INSTANCE :: ctgPromptDB.read

```ts
read(id: number): CTGPromptQueueRecord | null;
```

Reads one prompt queue record by ID. It returns the materialized
`CTGPromptQueueRecord` when found, or `null` when no row exists; it does
not mutate the database.

| Argument | Type | Description |
|---|---|---|
| `id` | `number` | Queue record ID to read. |

---

#### INSTANCE :: ctgPromptDB.paginate

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

#### INSTANCE :: ctgPromptDB.update

```ts
update(record: CTGPromptQueueRecord): CTGPromptQueueRecord;
```

Persists mutable fields from an existing `CTGPromptQueueRecord` and
returns the updated materialized record. `record.id` selects the row;
`id`, `prompt`, and `createdAt` remain immutable, and unknown IDs throw
`CTGPromptServerError("PROMPT_NOT_FOUND")`.

| Argument | Type | Description |
|---|---|---|
| `record` | `CTGPromptQueueRecord` | Existing queue record carrying the mutable values to persist. |

---

#### INSTANCE :: ctgPromptDB.delete

```ts
delete(id: number): CTGPromptQueueRecord | null;
```

Deletes one prompt queue record by ID. It returns the deleted
`CTGPromptQueueRecord`, or `null` when no row exists; deletion is a
durable database mutation.

| Argument | Type | Description |
|---|---|---|
| `id` | `number` | Queue record ID to delete. |

---

#### INSTANCE :: ctgPromptDB.append

```ts
append(id: number, text: string): CTGPromptQueueRecord;
```

Appends `text` to the record's `response` column without changing
`statusCode`, then returns the updated record. Unknown IDs throw
`CTGPromptServerError("PROMPT_NOT_FOUND")`; implementations should use
SQLite string concatenation so concurrent appends remain atomic.

| Argument | Type | Description |
|---|---|---|
| `id` | `number` | Queue record ID whose response should be appended. |
| `text` | `string` | Response text fragment to append. |

---

#### INSTANCE :: ctgPromptDB.claimNext

```ts
claimNext(): CTGPromptQueueRecord | null;
```

Atomically claims the oldest pending record by changing `status_code`
from `1` to `2` and setting `started_at`. It returns the claimed record,
or `null` when no pending work exists; the update condition must include
`WHERE status_code = 1` so cancellation and claiming cannot both win.

| Argument | Type | Description |
|---|---|---|
| none | none | This method takes no arguments. |

---

#### INSTANCE :: ctgPromptDB.finish

```ts
finish(id: number, outcome: CTGPromptDBPromptOutcome): CTGPromptQueueRecord;
```

Moves a record to terminal status code `3` or `4`, writes response or
error fields, serializes optional diagnostics to `info`, and sets
`finishedAt = Date.now()`. Successful finishes clear error fields;
failed finishes default `errorCode` to `1014` when not supplied.

| Argument | Type | Description |
|---|---|---|
| `id` | `number` | Queue record ID to finish. |
| `outcome` | `CTGPromptDBPromptOutcome` | Terminal status, response or error values, and optional diagnostics. |

_Examples_

```ts
const done = db.finish(record.id, {
    statusCode: 3,
    response: "Final response text."
});

const failed = db.finish(record.id, {
    statusCode: 4,
    errorCode: 1013,
    errorMessage: "Runner failed."
});
```

---

#### INSTANCE :: ctgPromptDB.cancel

```ts
cancel(id: number): CTGPromptQueueRecord;
```

Cancels only pending records by setting `statusCode = 5` and
`finishedAt = Date.now()`. Unknown IDs throw `PROMPT_NOT_FOUND`, and
active or finished records throw `CANCEL_NOT_ALLOWED`.

| Argument | Type | Description |
|---|---|---|
| `id` | `number` | Pending queue record ID to cancel. |

---

#### INSTANCE :: ctgPromptDB.interruptActive

```ts
interruptActive(): number;
```

Moves every active record to error status with `error_code = 1015`, an
interrupted message, and `finished_at = Date.now()`. It returns the
number of rows changed and is intended for server startup recovery.

| Argument | Type | Description |
|---|---|---|
| none | none | This method takes no arguments. |

---

#### INSTANCE :: ctgPromptDB.close

```ts
close(): void;
```

Closes the underlying SQLite connection. It returns nothing; callers
should not use the `CTGPromptDB` instance after closing it.

| Argument | Type | Description |
|---|---|---|
| none | none | This method takes no arguments. |

### Protected Methods

No protected methods are specified for `CTGPromptDB`.

### Private Methods

No private methods are specified for `CTGPromptDB`.

### Static Methods

#### STATIC :: CTGPromptDB.init

```ts
static init(config: CTGPromptDBConfig): CTGPromptDB;
```

Constructs and returns a `CTGPromptDB` instance. This is the public
factory used by `CTGPromptServer` and tests; it has the same side
effects and exceptions as the constructor.

| Argument | Type | Description |
|---|---|---|
| `config` | `CTGPromptDBConfig` | Database path and schema-initialization options. |
