// Type dependencies:
import type { PromptServerErrorType } from "../types.js"; // Closed set of server error type strings

/**
 *
 * Type Declarations
 *
 */

// TYPE :: ARRAY<STRING, NUMBER>
// HTTP status values for request errors.
const STATUS_BY_TYPE: Readonly<Record<PromptServerErrorType, number | null>> = {
    INVALID_CONFIG: null,
    UNAUTHORIZED: 401,
    INVALID_CONTENT_TYPE: 415,
    INVALID_BODY: 400,
    INVALID_PROMPT: 400,
    INVALID_QUERY: 400,
    PROMPT_NOT_FOUND: 404,
    CANCEL_NOT_ALLOWED: 409,
    NOT_FOUND: 404,
    METHOD_NOT_ALLOWED: 405,
    STORE_FAILED: 500,
    INTERNAL_ERROR: 500,
    RUNNER: null,
    SERVER: null,
    INTERRUPTED: null
};

/**
 *
 * Class
 *
 */

// Typed server error with CTG bidirectional code map.
export default class CTGPromptServerError extends Error {

    /* Static Fields */
    static readonly TYPES: Readonly<Record<string, number>> = Object.freeze({
        INVALID_CONFIG: 1001,
        UNAUTHORIZED: 1002,
        INVALID_CONTENT_TYPE: 1003,
        INVALID_BODY: 1004,
        INVALID_PROMPT: 1005,
        INVALID_QUERY: 1006,
        PROMPT_NOT_FOUND: 1007,
        CANCEL_NOT_ALLOWED: 1008,
        NOT_FOUND: 1009,
        METHOD_NOT_ALLOWED: 1010,
        STORE_FAILED: 1011,
        INTERNAL_ERROR: 1012,
        RUNNER: 1013,
        SERVER: 1014,
        INTERRUPTED: 1015,
        1001: "INVALID_CONFIG",
        1002: "UNAUTHORIZED",
        1003: "INVALID_CONTENT_TYPE",
        1004: "INVALID_BODY",
        1005: "INVALID_PROMPT",
        1006: "INVALID_QUERY",
        1007: "PROMPT_NOT_FOUND",
        1008: "CANCEL_NOT_ALLOWED",
        1009: "NOT_FOUND",
        1010: "METHOD_NOT_ALLOWED",
        1011: "STORE_FAILED",
        1012: "INTERNAL_ERROR",
        1013: "RUNNER",
        1014: "SERVER",
        1015: "INTERRUPTED"
    } as unknown as Record<string, number>); // Numeric reverse keys intentionally carry string values by convention

    /* Instance Fields */
    readonly type: PromptServerErrorType;                  // Stable error type
    readonly msg: string;                                  // Public or recorded message
    readonly data: Readonly<Record<string, unknown>>;      // Server-side structured data
    readonly status: number | null;                        // HTTP status for request errors

    // CONSTRUCTOR :: promptServerErrorType, STRING, OBJECT? -> this
    // Creates a typed server error.
    constructor(type: PromptServerErrorType, msg: string, data: Record<string, unknown> = {}) {
        if (!CTGPromptServerError.isType(type)) {
            throw new Error(`Unknown CTGPromptServerError type: ${type}`);
        }

        super(msg);
        this.name = "CTGPromptServerError";
        this.type = type;
        this.msg = msg;
        this.data = Object.freeze({ ...data });
        this.status = CTGPromptServerError.statusOf(type);
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: VOID -> {type:STRING, code:NUMBER, message:STRING}
    // Returns the CTG api-server error result object.
    toResult(): { type: string; code: number; message: string } {
        return {
            type: this.type,
            code: CTGPromptServerError.codeOf(this.type),
            message: this.msg
        };
    }

    /**
     *
     * Static Methods
     *
     */

    // METHOD :: UNKNOWN -> BOOLEAN
    // Checks whether a value is this error class.
    static is(value: unknown): value is CTGPromptServerError {
        return value instanceof CTGPromptServerError;
    }

    // METHOD :: STRING -> BOOLEAN
    // Checks whether a string is a known error type.
    static isType(type: string): boolean {
        return typeof CTGPromptServerError.TYPES[type] === "number";
    }

    // METHOD :: promptServerErrorType -> NUMBER
    // Returns the numeric code for an error type.
    static codeOf(type: PromptServerErrorType): number {
        const code = CTGPromptServerError.TYPES[type];

        if (typeof code !== "number") {
            throw new Error(`Unknown CTGPromptServerError type: ${type}`);
        }

        return code;
    }

    // METHOD :: promptServerErrorType -> NUMBER?
    // Returns the HTTP status for a request error or null for an outcome error.
    static statusOf(type: PromptServerErrorType): number | null {
        if (!CTGPromptServerError.isType(type)) {
            throw new Error(`Unknown CTGPromptServerError type: ${type}`);
        }

        return STATUS_BY_TYPE[type];
    }
}
