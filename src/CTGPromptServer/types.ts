/**
 *
 * Type Declarations
 *
 */

// TYPE :: {write:STRING -> VOID, end:VOID -> VOID, writableEnded:BOOLEAN?}
// Structural sink used by CTGPromptServer-owned SSE streams.
export interface CTGPromptSSESink {
    write(chunk: string): void;
    end(): void;
    readonly writableEnded?: boolean;
}

// TYPE :: {close:VOID -> VOID}
// Registered SSE subscription handle.
export interface CTGPromptSSESubscription {
    close(): void;
}

// TYPE :: VOID -> VOID
// Long-poll waiter resolver.
export type CTGPromptWaiter = () => void;
