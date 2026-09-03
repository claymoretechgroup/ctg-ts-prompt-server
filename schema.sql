CREATE TABLE IF NOT EXISTS prompts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    status        TEXT    NOT NULL,
    prompt        TEXT    NOT NULL,
    response      TEXT    NOT NULL DEFAULT '',
    error_type    TEXT,
    error_message TEXT,
    info          TEXT,
    runner        TEXT,
    next_sequence INTEGER NOT NULL DEFAULT 1,
    created_at    INTEGER NOT NULL,
    started_at    INTEGER,
    finished_at   INTEGER
);

CREATE TABLE IF NOT EXISTS events (
    prompt_id  INTEGER NOT NULL REFERENCES prompts (id) ON DELETE CASCADE,
    sequence   INTEGER NOT NULL,
    name       TEXT    NOT NULL,
    payload    TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (prompt_id, sequence)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS prompts_status_id
    ON prompts (status, id);
