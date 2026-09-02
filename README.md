# ctg-ts-prompt-server

A durable prompt service that exposes one configured `ctg-ai-agent-proc`
runner over HTTP, SQLite, and Server-Sent Events.

The behavioral contract is [docs/spec.md](./docs/spec.md).

## Install

```sh
npm install
```

Node.js 22.22 or newer is expected for `node:sqlite`.

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
`concurrency` is `1`, `maxPromptBytes` is `131071`, `streamMode` is
`events`, `keepAliveMs` is `15000`, `maxWaitMs` is `30000`,
`defaultLimit` is `50`, and `maxLimit` is `200`.

`runner.env` is a complete replacement for the child environment. Omit
it to let the runner inherit the server process environment.

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

## Purge

```sh
PROMPT_SERVER_DB=prompts.db npm run purge-finished
```

The purge command deletes finished prompts and their events, prints the
deleted prompt count, and leaves `pending` and `active` prompts intact.
