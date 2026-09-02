# ctg-ts-prompt-server

A durable prompt service that exposes one LLM runner over HTTP. A client
submits a prompt; the server stores it in SQLite, runs it through the
configured `ctg-ai-agent-proc` runner when a slot is free, records every
runner event with a per-prompt sequence number, and serves that log as
Server-Sent Events or as a long-polled record.

The behavioral contract is [docs/spec.md](./docs/spec.md).

## Status

Specification complete and reviewed. Tests and implementation pending.
