// Type dependencies:
import type { Response } from "express"; // Express response accepted by sendResponse()
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

// TYPE :: null|BOOLEAN|NUMBER|STRING|OBJECT
// Broad in-process error details retained for logging/inspection only.
type CTGPromptServerErrorData = null | boolean | number | string | object;

/**
 *
 * Class
 *
 */

// Typed server error with CTG bidirectional code map.
export default class CTGPromptServerError extends Error {

    /* Static Fields */
    static readonly CODE = Object.freeze({
        INVALID_CODE: -1,
        INVALID_CONFIG: 1,
        INTERNAL_ERROR: 2,
        DATABASE_FAILED: 3,
        RUNNER_FAILED: 4,
        PROMPT_INTERRUPTED: 5,
        UNAUTHORIZED: 6,
        INVALID_CONTENT_TYPE: 7,
        INVALID_BODY: 8,
        INVALID_PROMPT: 9,
        INVALID_QUERY: 10,
        PROMPT_NOT_FOUND: 11,
        CANCEL_NOT_ALLOWED: 12,
        NOT_FOUND: 13,
        METHOD_NOT_ALLOWED: 14,
        UNKNOWN_ERROR: 15
    } as const);

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
    readonly code: number;                                 // Spec2 numeric application/domain code
    readonly data: CTGPromptServerErrorData;               // Server-side structured data
    readonly status: number | null;                        // HTTP status for request errors

    // CONSTRUCTOR :: promptServerErrorType|NUMBER, STRING, OBJECT? -> this
    // Creates a typed server error.
    constructor(type: PromptServerErrorType, msg: string, data?: Record<string, unknown>);
    constructor(code: number, msg: string, data?: CTGPromptServerErrorData);
    constructor(typeOrCode: PromptServerErrorType | number, msg: string, data?: CTGPromptServerErrorData) {
        if (typeof typeOrCode === "number") {
            if (!CTGPromptServerError.isCode(typeOrCode)) {
                throw new CTGPromptServerError(CTGPromptServerError.CODE.INVALID_CODE, "Invalid CTGPromptServerError code.", {
                    code: typeOrCode
                });
            }

            super(msg);
            this.name = "CTGPromptServerError";
            this.type = CTGPromptServerError._legacyTypeOf(typeOrCode);
            this.msg = msg;
            this.code = typeOrCode;
            this.data = CTGPromptServerError._freezeData(data ?? null);
            this.status = null;
            return;
        }

        if (!CTGPromptServerError.isType(typeOrCode)) {
            throw new Error(`Unknown CTGPromptServerError type: ${typeOrCode}`);
        }

        super(msg);
        this.name = "CTGPromptServerError";
        this.type = typeOrCode;
        this.msg = msg;
        this.code = CTGPromptServerError._spec2CodeOf(typeOrCode);
        this.data = CTGPromptServerError._freezeData(data ?? {});
        this.status = CTGPromptServerError.statusOf(typeOrCode);
    }

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> STRING
    // Returns the spec2 label derived from the stored code.
    get label(): string {
        return CTGPromptServerError.labelOf(this.code);
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

    // METHOD :: VOID -> {success:FALSE,result:{code:NUMBER,message:STRING}}
    // Returns the spec2 HTTP JSON error response body.
    toResponse(): { success: false; result: { code: number; message: string } } {
        return {
            success: false,
            result: {
                code: this.code,
                message: this.message
            }
        };
    }

    // METHOD :: expressResponse -> VOID
    // Sends the spec2 HTTP JSON error response body.
    sendResponse(response: Response): void {
        response
            .status(typeof this.status === "number" ? this.status : 500)
            .json(this.toResponse());
    }

    /**
     *
     * Static Methods
     *
     */

    // Static Factory Method :: NUMBER, STRING, UNKNOWN? -> ctgPromptServerError
    // Creates a spec2 numeric-code server error.
    static init(...args: [number, string, CTGPromptServerErrorData?] | [number, number, string, CTGPromptServerErrorData?]): CTGPromptServerError {
        if (typeof args[1] === "number") {
            const message = args[2] as string;

            return new CTGPromptServerError(args[0], message, args[3]);
        }

        const message = args[1];

        return new CTGPromptServerError(args[0], message, args[2]);
    }

    // METHOD :: UNKNOWN -> BOOLEAN
    // Checks whether a value is this error class.
    static is(value: unknown): value is CTGPromptServerError {
        return value instanceof CTGPromptServerError;
    }

    // METHOD :: NUMBER -> BOOLEAN
    // Checks whether a number is a known spec2 error code.
    static isCode(code: number): boolean {
        return Object.values(CTGPromptServerError.CODE).some((value) => value === code);
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

    // METHOD :: NUMBER -> STRING
    // Returns the spec2 label for a numeric code.
    static labelOf(code: number): string {
        for (const [label, value] of Object.entries(CTGPromptServerError.CODE)) {
            if (value === code) {
                return label;
            }
        }

        return "INVALID_CODE";
    }

    /**
     *
     * Private Static Methods
     *
     */

    // METHOD :: ctgPromptServerErrorData -> ctgPromptServerErrorData
    // Freezes object data without altering primitive details.
    private static _freezeData(data: CTGPromptServerErrorData): CTGPromptServerErrorData {
        if (typeof data === "object" && data !== null) {
            if (Array.isArray(data)) {
                return Object.freeze([...data]);
            }

            return Object.freeze({ ...data });
        }

        return data;
    }

    // METHOD :: promptServerErrorType -> NUMBER
    // Maps v1 type strings onto spec2 application/domain codes.
    private static _spec2CodeOf(type: PromptServerErrorType): number {
        switch (type) {
            case "INVALID_CONFIG": return CTGPromptServerError.CODE.INVALID_CONFIG;
            case "UNAUTHORIZED": return CTGPromptServerError.CODE.UNAUTHORIZED;
            case "INVALID_CONTENT_TYPE": return CTGPromptServerError.CODE.INVALID_CONTENT_TYPE;
            case "INVALID_BODY": return CTGPromptServerError.CODE.INVALID_BODY;
            case "INVALID_PROMPT": return CTGPromptServerError.CODE.INVALID_PROMPT;
            case "INVALID_QUERY": return CTGPromptServerError.CODE.INVALID_QUERY;
            case "PROMPT_NOT_FOUND": return CTGPromptServerError.CODE.PROMPT_NOT_FOUND;
            case "CANCEL_NOT_ALLOWED": return CTGPromptServerError.CODE.CANCEL_NOT_ALLOWED;
            case "NOT_FOUND": return CTGPromptServerError.CODE.NOT_FOUND;
            case "METHOD_NOT_ALLOWED": return CTGPromptServerError.CODE.METHOD_NOT_ALLOWED;
            case "STORE_FAILED": return CTGPromptServerError.CODE.DATABASE_FAILED;
            case "INTERNAL_ERROR": return CTGPromptServerError.CODE.INTERNAL_ERROR;
            case "RUNNER": return CTGPromptServerError.CODE.RUNNER_FAILED;
            case "SERVER": return CTGPromptServerError.CODE.INTERNAL_ERROR;
            case "INTERRUPTED": return CTGPromptServerError.CODE.PROMPT_INTERRUPTED;
        }
    }

    // METHOD :: NUMBER -> promptServerErrorType
    // Provides a legacy type value for numeric-code errors during transition.
    private static _legacyTypeOf(code: number): PromptServerErrorType {
        switch (code) {
            case CTGPromptServerError.CODE.INVALID_CONFIG: return "INVALID_CONFIG";
            case CTGPromptServerError.CODE.UNAUTHORIZED: return "UNAUTHORIZED";
            case CTGPromptServerError.CODE.INVALID_CONTENT_TYPE: return "INVALID_CONTENT_TYPE";
            case CTGPromptServerError.CODE.INVALID_BODY: return "INVALID_BODY";
            case CTGPromptServerError.CODE.INVALID_PROMPT: return "INVALID_PROMPT";
            case CTGPromptServerError.CODE.INVALID_QUERY: return "INVALID_QUERY";
            case CTGPromptServerError.CODE.PROMPT_NOT_FOUND: return "PROMPT_NOT_FOUND";
            case CTGPromptServerError.CODE.CANCEL_NOT_ALLOWED: return "CANCEL_NOT_ALLOWED";
            case CTGPromptServerError.CODE.NOT_FOUND: return "NOT_FOUND";
            case CTGPromptServerError.CODE.METHOD_NOT_ALLOWED: return "METHOD_NOT_ALLOWED";
            case CTGPromptServerError.CODE.DATABASE_FAILED: return "STORE_FAILED";
            case CTGPromptServerError.CODE.RUNNER_FAILED: return "RUNNER";
            case CTGPromptServerError.CODE.PROMPT_INTERRUPTED: return "INTERRUPTED";
            default: return "INTERNAL_ERROR";
        }
    }
}
