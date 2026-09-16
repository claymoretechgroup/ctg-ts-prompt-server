/**
 *
 * Type Declarations
 *
 */

// TYPE :: {name:"output"|"stream", payload:UNKNOWN}
// Normalized stream contribution before response accumulation.
export interface CTGPromptServerQueueStreamRecord {
    readonly name: "output" | "stream";
    readonly payload: unknown;
}
