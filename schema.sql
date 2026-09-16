CREATE TABLE IF NOT EXISTS prompts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    status_code   INTEGER NOT NULL CHECK (
        status_code IN (-1, 1, 2, 3, 5)
    ),
    prompt        TEXT    NOT NULL,
    response      TEXT    NOT NULL DEFAULT '',
    error_code    INTEGER CHECK (
        error_code IS NULL OR error_code IN (2, 3, 4, 5, 15)
    ),
    error_message TEXT,
    runner        TEXT,
    created_at    INTEGER NOT NULL,
    started_at    INTEGER,
    finished_at   INTEGER,
    CHECK (
        (status_code = -1 AND error_code IS NOT NULL AND error_message IS NOT NULL)
        OR
        (status_code <> -1 AND error_code IS NULL AND error_message IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS prompts_status_code_id
    ON prompts (status_code, id);
