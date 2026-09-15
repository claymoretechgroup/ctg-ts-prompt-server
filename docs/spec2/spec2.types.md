# ctg-ts-prompt-server spec2 types

**Status:** proposed type ownership index.

This document defines the type ownership rules for spec2. Class-owned
types live beside their owning class under `classes/<ClassName>/types.md`.
General types that span multiple classes and do not have a clear class
owner remain in this document.

Database schema is defined in [spec2.db.md](./spec2.db.md). Class
surfaces are indexed in [spec2.classes.md](./spec2.classes.md).

---

## Type Ownership

`LLMRunner`, `LLMRunnerResult`, `LLMRunnerStreamHandler`, and runner
event classes come from `ctg-ai-agent-proc`.

Public exported types use the `CTG` prefix. Unprefixed types in this
spec are implementation details local to the owning class. Type
definitions are grouped with the class that owns the corresponding
behavior or data boundary. Shared types stay with their origin class; for
example, `CTGPromptServerQueueRecord` is consumed by the queue and server, but
it is defined with `CTGPromptServerDB` because it represents a durable
database row.

---

## Class-Owned Types

| Owner | Types |
|---|---|
| `CTGPromptServerDB` | [classes/CTGPromptServerDB/types.md](./classes/CTGPromptServerDB/types.md) |
| `CTGPromptServerQueue` | [classes/CTGPromptServerQueue/types.md](./classes/CTGPromptServerQueue/types.md) |
| `CTGPromptServer` | [classes/CTGPromptServer/types.md](./classes/CTGPromptServer/types.md) |
| `CTGPromptServerError` | [classes/CTGPromptServerError/types.md](./classes/CTGPromptServerError/types.md) |
| `CTGPromptServerRequestError` | [classes/CTGPromptServerRequestError/types.md](./classes/CTGPromptServerRequestError/types.md) |

## General Types

No general cross-class types are specified yet. Add them here only when a
type does not have a clear owning class.
