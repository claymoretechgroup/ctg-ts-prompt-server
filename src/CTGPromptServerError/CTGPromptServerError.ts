// Type dependencies:
import type { Response } from "express"; // Express response accepted by sendResponse()
import type {
    CTGPromptServerErrorData,       // In-process error details
    CTGPromptServerErrorResponse    // Public error response body
} from "./types.js";

/**
 *
 * Class
 *
 */

// Numeric-code server error with public response formatting.
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

    /* Instance Fields */
    readonly code: number;                           // Stable application/domain code
    readonly data: CTGPromptServerErrorData;         // Server-side detail retained for inspection

    // CONSTRUCTOR :: NUMBER, STRING, UNKNOWN? -> this
    // Creates a numeric-code server error.
    constructor(code: number, message: string, data?: CTGPromptServerErrorData) {
        if (!CTGPromptServerError.isCode(code)) {
            throw new CTGPromptServerError(CTGPromptServerError.CODE.INVALID_CODE, "Invalid CTGPromptServerError code.", {
                code
            });
        }

        super(message);
        this.name = "CTGPromptServerError";
        this.code = code;
        this.data = CTGPromptServerError._freezeData(data ?? null);
    }

    /**
     *
     * Properties
     *
     */

    // GETTER :: VOID -> STRING
    // Returns the label derived from the stored code.
    get label(): string {
        return CTGPromptServerError.labelOf(this.code);
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: VOID -> {success:FALSE,result:{code:NUMBER,message:STRING}}
    // Returns the public HTTP JSON error response body.
    toResponse(): CTGPromptServerErrorResponse {
        return {
            success: false,
            result: {
                code: this.code,
                message: this.message
            }
        };
    }

    // METHOD :: expressResponse -> VOID
    // Sends the public HTTP JSON error response body.
    sendResponse(response: Response): void {
        const status = (this as { readonly status?: unknown }).status;

        response
            .status(typeof status === "number" ? status : 500)
            .json(this.toResponse());
    }

    /**
     *
     * Static Methods
     *
     */

    // Static Factory Method :: NUMBER, STRING, UNKNOWN? -> ctgPromptServerError
    // Creates a numeric-code server error.
    static init(code: number, message: string, data?: CTGPromptServerErrorData): CTGPromptServerError {
        return new this(code, message, data);
    }

    // METHOD :: UNKNOWN -> BOOLEAN
    // Checks whether a value is this error class.
    static is(value: unknown): value is CTGPromptServerError {
        return value instanceof CTGPromptServerError;
    }

    // METHOD :: NUMBER -> BOOLEAN
    // Checks whether a number is a known error code.
    static isCode(code: number): boolean {
        return Object.values(CTGPromptServerError.CODE).some((value) => value === code);
    }

    // METHOD :: NUMBER -> STRING
    // Returns the label for a numeric code.
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
}
