// Type dependencies:
import type { CTGPromptServerErrorData } from "../CTGPromptServerError/types.js";

/**
 *
 * Type Declarations
 *
 */

// TYPE :: [NUMBER, STRING, UNKNOWN?]|[NUMBER, NUMBER, STRING, UNKNOWN?]
// Supported CTGPromptServerRequestError.init argument forms.
export type CTGPromptServerRequestErrorInitArgs =
    | [number, string, CTGPromptServerErrorData?]
    | [number, number, string, CTGPromptServerErrorData?];
