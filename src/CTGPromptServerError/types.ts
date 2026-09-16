/**
 *
 * Type Declarations
 *
 */

// TYPE :: null|BOOLEAN|NUMBER|STRING|OBJECT
// Broad in-process error details retained for logging/inspection only.
export type CTGPromptServerErrorData = null | boolean | number | string | object;

// TYPE :: {success:FALSE,result:{code:NUMBER,message:STRING}}
// Public JSON error response body.
export interface CTGPromptServerErrorResponse {
    readonly success: false;
    readonly result: {
        readonly code: number;
        readonly message: string;
    };
}
