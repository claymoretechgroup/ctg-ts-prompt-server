// Type dependencies:
import type {
    RunnerKind,        // Supported runner kind literal
    StreamMode         // Supported stream mode literal
} from "../types.js";

/**
 *
 * Type Declarations
 *
 */

// TYPE :: {runnerKind:[runnerKind], streamMode:[streamMode]}
// Literal sets accepted by CTGPromptServerValidation.
export interface CTGPromptServerValidationLiterals {
    readonly runnerKind: readonly ["claude", "codex"];
    readonly streamMode: readonly ["raw", "events"];
}
