// Dependencies:
import type { Response } from "express"; // Express response shape used by error sendResponse tests

/**
 *
 * Type Declarations
 *
 */

// TYPE :: OBJECT
// Runtime view of the package public module used by spec2 surface tests.
export type PublicModule = Record<string, unknown>;

// TYPE :: {statusCode:NUMBER|null, body:UNKNOWN}
// Captured response side effects from sendResponse().
export interface CapturedResponse {
    readonly statusCode: number | null;
    readonly body: unknown;
}

// TYPE :: new(NUMBER, STRING, UNKNOWN?) -> serverError
// Constructor/static shape expected from CTGPromptServerError.
export interface CTGPromptServerErrorConstructor {
    readonly CODE: Readonly<Record<string, number>>;
    new (code: number, message: string, data?: null | boolean | number | string | object): CTGPromptServerErrorInstance;
    init(
        code: number,
        message: string,
        data?: null | boolean | number | string | object
    ): CTGPromptServerErrorInstance;
    is(value: unknown): boolean;
    labelOf(code: number): string;
}

// TYPE :: serverError instance shape
// Instance shape expected from CTGPromptServerError.
export interface CTGPromptServerErrorInstance {
    readonly code: number;
    readonly data: null | boolean | number | string | object;
    readonly label: string;
    readonly message: string;
    toResponse(): unknown;
    sendResponse(response: Response): void;
}

// TYPE :: new(NUMBER, NUMBER, STRING, UNKNOWN?) -> requestError
// Constructor/static shape expected from CTGPromptServerRequestError.
export interface CTGPromptServerRequestErrorConstructor extends CTGPromptServerErrorConstructor {
    new (
        code: number,
        status: number,
        message: string,
        data?: null | boolean | number | string | object
    ): CTGPromptServerRequestErrorInstance;
    init(
        code: number,
        status: number,
        message: string,
        data?: null | boolean | number | string | object
    ): CTGPromptServerRequestErrorInstance;
    unauthorized(message: string, data?: null | boolean | number | string | object): CTGPromptServerRequestErrorInstance;
    invalidContentType(message: string, data?: null | boolean | number | string | object): CTGPromptServerRequestErrorInstance;
    invalidBody(message: string, data?: null | boolean | number | string | object): CTGPromptServerRequestErrorInstance;
    invalidPrompt(message: string, data?: null | boolean | number | string | object): CTGPromptServerRequestErrorInstance;
    invalidQuery(message: string, data?: null | boolean | number | string | object): CTGPromptServerRequestErrorInstance;
    promptNotFound(message: string, data?: null | boolean | number | string | object): CTGPromptServerRequestErrorInstance;
    cancelNotAllowed(message: string, data?: null | boolean | number | string | object): CTGPromptServerRequestErrorInstance;
    notFound(message: string, data?: null | boolean | number | string | object): CTGPromptServerRequestErrorInstance;
    methodNotAllowed(message: string, data?: null | boolean | number | string | object): CTGPromptServerRequestErrorInstance;
}

// TYPE :: serverError & {status:NUMBER}
// Instance shape expected from CTGPromptServerRequestError.
export interface CTGPromptServerRequestErrorInstance extends CTGPromptServerErrorInstance {
    readonly status: number;
}

// TYPE :: {STATUS:OBJECT}
// Static shape expected from CTGPromptServerQueue.
export interface CTGPromptServerQueueConstructor {
    readonly STATUS: Readonly<Record<string, number>>;
    statusOf(code: number): string;
}

/**
 *
 * Functions
 *
 */

// FUNCTION :: VOID -> PROMISE(publicModule)
// Loads the package source entry point without statically depending on spec2 exports.
export const loadPublicModule = async (): Promise<PublicModule> => {
    return await import("../../src/index.ts") as PublicModule;
};

// FUNCTION :: UNKNOWN -> ctgPromptServerErrorConstructor|null
// Returns the expected error constructor shape when a value looks constructable.
export const asServerErrorConstructor = (value: unknown): CTGPromptServerErrorConstructor | null => {
    return typeof value === "function"
        && typeof (value as { CODE?: unknown }).CODE === "object"
        && (value as { CODE?: unknown }).CODE !== null
        ? value as CTGPromptServerErrorConstructor
        : null;
};

// FUNCTION :: UNKNOWN -> ctgPromptServerRequestErrorConstructor|null
// Returns the expected request error constructor shape when a value looks constructable.
export const asRequestErrorConstructor = (value: unknown): CTGPromptServerRequestErrorConstructor | null => {
    return typeof value === "function"
        && typeof (value as { CODE?: unknown }).CODE === "object"
        && (value as { CODE?: unknown }).CODE !== null
        ? value as CTGPromptServerRequestErrorConstructor
        : null;
};

// FUNCTION :: UNKNOWN -> ctgPromptServerQueueConstructor|null
// Returns the expected queue constructor shape when a value looks constructable.
export const asQueueConstructor = (value: unknown): CTGPromptServerQueueConstructor | null => {
    return typeof value === "function"
        && typeof (value as { STATUS?: unknown }).STATUS === "object"
        && (value as { STATUS?: unknown }).STATUS !== null
        ? value as CTGPromptServerQueueConstructor
        : null;
};

// FUNCTION :: FUNCTION -> UNKNOWN
// Captures a thrown value so constructor failures can be asserted as values.
export const captureThrown = (fn: () => void): unknown => {
    try {
        fn();
        return undefined;
    } catch (error) {
        return error;
    }
};

// FUNCTION :: VOID -> {response:Response, capture:capturedResponse}
// Builds a minimal chainable Express-like response for sendResponse tests.
export const fakeResponse = (): { response: Response; capture: CapturedResponse } => {
    const capture: {
        statusCode: number | null;
        body: unknown;
    } = {
        statusCode: null,
        body: undefined
    };

    const response = {
        status(statusCode: number) {
            capture.statusCode = statusCode;
            return this;
        },
        json(body: unknown) {
            capture.body = body;
            return this;
        }
    };

    return {
        response: response as Response,
        capture
    };
};
