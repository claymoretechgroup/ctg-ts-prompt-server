# ctg-ts-prompt-server

A durable prompt service that exposes one configured `ctg-ai-agent-proc`
runner over HTTP, SQLite, and Server-Sent Events.

The behavioral contract is [docs/spec.md](./docs/spec.md).

## Install

This is a service you run from a checkout:

```sh
git clone git@github.com:claymoretechgroup/ctg-ts-prompt-server.git
cd ctg-ts-prompt-server
npm install
```

`npm install` pulls `ctg-ai-agent-proc` and `ctg-js-test` from GitHub by
tag and builds `dist/`. Node.js 22.22 or newer is expected for
`node:sqlite`.

To use the classes (`CTGPromptServer`, `CTGPromptDB`, and the rest) from
another project instead, install it as a dependency from GitHub:

```sh
npm install github:claymoretechgroup/ctg-ts-prompt-server
```

Pin a tag once one is published, e.g.
`github:claymoretechgroup/ctg-ts-prompt-server#v1.0.0`.

## Config

```ts
interface CTGPromptRunnerConfig {
    kind: "claude" | "codex";
    cwd?: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    maxBuffer?: number;
}

interface CTGPromptServerConfig {
    runner: CTGPromptRunnerConfig;
    apiKey: string;
    host?: string;
    database?: string;
    initDB?: boolean;
    concurrency?: number;
    maxPromptBytes?: number;
    streamMode?: "raw" | "events";
    keepAliveMs?: number;
    maxWaitMs?: number;
    defaultLimit?: number;
    maxLimit?: number;
}
```

Defaults: `host` is `127.0.0.1`, `database` is `prompts.db`,
`initDB` is `true`, `concurrency` is `1`, `maxPromptBytes` is `131071`,
`streamMode` is `events`, `keepAliveMs` is `15000`, `maxWaitMs` is
`30000`, `defaultLimit` is `50`, and `maxLimit` is `200`.

`runner.env` is a complete replacement for the child environment. Omit
it to let the runner inherit the server process environment.

The SQLite schema lives in [`schema.sql`](./schema.sql) at the project
root.

## Run

```sh
npm start <config.json> [port]
```

The port defaults to `8080`. If the config omits `apiKey`,
`PROMPT_SERVER_API_KEY` is used by `scripts/start.ts`.

For Docker bridge deployments, set `host` to the bridge address or
`0.0.0.0`; every route requires `Authorization: Bearer <apiKey>`.

## Routes

| Method | Path | Success | Input |
|---|---|---|---|
| `POST` | `/prompt` | `202` | JSON body `{ "prompt": string }` |
| `GET` | `/prompt/:id` | `200` | optional `?wait=<ms>` |
| `GET` | `/prompt/:id/events` | `200` SSE | optional `Last-Event-ID` header |
| `DELETE` | `/prompt/:id` | `200` | none |
| `GET` | `/prompts` | `200` | optional `?limit=&before=` |
| `GET` | `/prompts/:status` | `200` | `status` is one of `pending`, `active`, `done`, `error`, `cancelled` |

JSON responses use:

```json
{ "success": true, "result": {} }
```

Errors use:

```json
{ "success": false, "result": { "type": "INVALID_QUERY", "code": 1006, "message": "Invalid query." } }
```

## SSE

```sh
curl -N \
  -H "Authorization: Bearer $PROMPT_SERVER_API_KEY" \
  -H "Last-Event-ID: 2" \
  http://127.0.0.1:8080/prompt/1/events
```

Each event frame is:

```text
id: <sequence>
event: <name>
data: <JSON payload>

```

The stream replays durable history after `Last-Event-ID`, sends live
events, writes `: keep-alive` comments while open, and ends after
`done`, `error`, or `cancelled`.

## Long Poll

```sh
curl \
  -H "Authorization: Bearer $PROMPT_SERVER_API_KEY" \
  "http://127.0.0.1:8080/prompt/1?wait=30000"
```

The response is `200` whether the prompt finished or the wait elapsed.
Read `result.status` and `result.response`.

## Operations

```sh
PROMPT_SERVER_DB=prompts.db npm run purge-finished
```

| Script | Method | Deletes | Touches `pending` / `active` |
|---|---|---|---|
| `purge-finished` | `purgeFinished()` | `done`, `error`, `cancelled` rows and their events | no |
| `purge-all` | `purgeAll()` | every prompt and every event | **yes** — empties the queue |
| `reset-everything` | `reset()` | drops `events`, `prompts`, and the index, then applies `schema.sql` | **yes** — and the id sequence restarts at 1 |

Each command uses `PROMPT_SERVER_DB`, defaulting to `prompts.db`, prints
the deleted prompt count or `reset`, and closes the database.

**`purge-all` and `reset-everything` are for a stopped server.** They
cannot tell whether a server holds the file. Run against a live one, an
active prompt's next event append finds no row and the run ends as a
`SERVER` outcome (§5.4 step 6), and recovery on the next `start` has
nothing to recover.
