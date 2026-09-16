# CTGPromptServerValidation Types

### CTGPromptServerValidationLiterals

```ts
interface CTGPromptServerValidationLiterals {
    readonly runnerKind: readonly ["claude", "codex"];
    readonly streamMode: readonly ["raw", "events"];
}
```

`CTGPromptServerValidationLiterals` describes the frozen literal sets exposed
by `CTGPromptServerValidation.LITERALS`. These values mirror the supported
runner kind and stream mode contracts owned by the server and queue
specs.
