# ctg-ts-prompt-server spec2 database

**Status:** proposed standalone database specification.

This document specifies the SQLite schema for spec2. Type declarations
are defined in `docs/spec2.types.md`. Class behavior is defined in
`docs/spec2.classes.md`.

---

## 1. Database Schema

SQLite is the durable queue and prompt-state store. The schema contains
one table for prompt queue records and one index for claim/list access.

```sql
CREATE TABLE IF NOT EXISTS prompts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    status_code   INTEGER NOT NULL CHECK (
        status_code IN (1, 2, 3, 4, 5)
    ),
    prompt        TEXT    NOT NULL,
    response      TEXT    NOT NULL DEFAULT '',
    error_code    INTEGER CHECK (
        error_code IS NULL OR error_code IN (1013, 1014, 1015)
    ),
    error_message TEXT,
    info          TEXT,
    runner        TEXT,
    created_at    INTEGER NOT NULL,
    started_at    INTEGER,
    finished_at   INTEGER,
    CHECK (
        (status_code = 4 AND error_code IS NOT NULL AND error_message IS NOT NULL)
        OR
        (status_code <> 4 AND error_code IS NULL AND error_message IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS prompts_status_code_id
    ON prompts (status_code, id);
```

Column meanings:

| Column | Meaning |
|---|---|
| `id` | Stable queue record ID. It is the HTTP ID, pagination cursor, and active-run map key. |
| `status_code` | Stable lifecycle status code. Valid status codes are `1` pending, `2` active, `3` done, `4` error, and `5` cancelled. |
| `prompt` | Raw prompt text exactly as submitted by the client. |
| `response` | Accumulated response text while running, overwritten by the final runner result on success. |
| `error_code` | Outcome error code when `status_code = 4`; otherwise `NULL`. Valid outcome codes are `1013`, `1014`, and `1015`. |
| `error_message` | Outcome error message when `status_code = 4`; otherwise `NULL`. |
| `info` | JSON diagnostics for operators. It is not serialized on HTTP prompt responses. |
| `runner` | Runner type metadata. It may remain `NULL` for the initial single-runner service. |
| `created_at` | Epoch milliseconds when the record was submitted. |
| `started_at` | Epoch milliseconds when the record was claimed. `NULL` until active. |
| `finished_at` | Epoch milliseconds when the record entered a terminal state. `NULL` until finished. |

The database enforces the finite status-code set, the finite outcome
error-code set, and the rule that `error_code` / `error_message` are
present only for `status_code = 4`.

SQLite pragmas applied on open:

1. `PRAGMA journal_mode = WAL;`
2. `PRAGMA foreign_keys = ON;`
3. `PRAGMA busy_timeout = 5000;`

The initial spec2 schema does not store per-event stream history. SSE is
live-only. If a client disconnects, it recovers the current queue record
through `GET /prompt/:id`.

---

## 2. Maintenance SQL

Maintenance operations are script-level SQL tasks, not `CTGPromptDB`
runtime methods.

Purge finished records:

```sql
DELETE FROM prompts
WHERE status_code IN (3, 4, 5);
```

Purge all records:

```sql
DELETE FROM prompts;
```

Reset schema:

```sql
DROP TABLE IF EXISTS prompts;
```

After reset, recreate the schema from this specification.

---
