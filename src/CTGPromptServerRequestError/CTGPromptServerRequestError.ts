// Dependencies:
import CTGPromptServerError from "../CTGPromptServerError/CTGPromptServerError.js"; // Base normalized server error

/**
 *
 * Type Declarations
 *
 */

// TYPE :: null|BOOLEAN|NUMBER|STRING|OBJECT
// Broad in-process error details retained for logging/inspection only.
type CTGPromptServerErrorData = null | boolean | number | string | object;

/**
 *
 * Class
 *
 */

// HTTP-facing request validation/routing error.
export default class CTGPromptServerRequestError extends CTGPromptServerError {

    /* Instance Fields */
    override readonly status: number;                             // HTTP response status

    // CONSTRUCTOR :: NUMBER, NUMBER, STRING, UNKNOWN? -> this
    // Creates a request error with explicit application code and HTTP status.
    constructor(code: number, status: number, message: string, data?: CTGPromptServerErrorData) {
        super(code, message, data);
        this.name = "CTGPromptServerRequestError";
        this.status = status;
    }

    /**
     *
     * Static Methods
     *
     */

    // Static Factory Method :: NUMBER, NUMBER, STRING, UNKNOWN? -> ctgPromptServerRequestError
    // Creates a request error with an explicit status.
    static override init(...args: [number, string, CTGPromptServerErrorData?] | [number, number, string, CTGPromptServerErrorData?]): CTGPromptServerRequestError {
        if (typeof args[1] === "string") {
            return new this(args[0], 500, args[1], args[2]);
        }

        const code = args[0];
        const status = args[1];
        const message = args[2] as string;

        return new this(code, status, message, args[3]);
    }

    // Static Factory Method :: STRING, UNKNOWN? -> ctgPromptServerRequestError
    // Creates UNAUTHORIZED / 6 with HTTP 401.
    static unauthorized(message: string, data?: CTGPromptServerErrorData): CTGPromptServerRequestError {
        return new this(CTGPromptServerError.CODE.UNAUTHORIZED, 401, message, data);
    }

    // Static Factory Method :: STRING, UNKNOWN? -> ctgPromptServerRequestError
    // Creates INVALID_CONTENT_TYPE / 7 with HTTP 415.
    static invalidContentType(message: string, data?: CTGPromptServerErrorData): CTGPromptServerRequestError {
        return new this(CTGPromptServerError.CODE.INVALID_CONTENT_TYPE, 415, message, data);
    }

    // Static Factory Method :: STRING, UNKNOWN? -> ctgPromptServerRequestError
    // Creates INVALID_BODY / 8 with HTTP 400.
    static invalidBody(message: string, data?: CTGPromptServerErrorData): CTGPromptServerRequestError {
        return new this(CTGPromptServerError.CODE.INVALID_BODY, 400, message, data);
    }

    // Static Factory Method :: STRING, UNKNOWN? -> ctgPromptServerRequestError
    // Creates INVALID_PROMPT / 9 with HTTP 400.
    static invalidPrompt(message: string, data?: CTGPromptServerErrorData): CTGPromptServerRequestError {
        return new this(CTGPromptServerError.CODE.INVALID_PROMPT, 400, message, data);
    }

    // Static Factory Method :: STRING, UNKNOWN? -> ctgPromptServerRequestError
    // Creates INVALID_QUERY / 10 with HTTP 400.
    static invalidQuery(message: string, data?: CTGPromptServerErrorData): CTGPromptServerRequestError {
        return new this(CTGPromptServerError.CODE.INVALID_QUERY, 400, message, data);
    }

    // Static Factory Method :: STRING, UNKNOWN? -> ctgPromptServerRequestError
    // Creates PROMPT_NOT_FOUND / 11 with HTTP 404.
    static promptNotFound(message: string, data?: CTGPromptServerErrorData): CTGPromptServerRequestError {
        return new this(CTGPromptServerError.CODE.PROMPT_NOT_FOUND, 404, message, data);
    }

    // Static Factory Method :: STRING, UNKNOWN? -> ctgPromptServerRequestError
    // Creates CANCEL_NOT_ALLOWED / 12 with HTTP 409.
    static cancelNotAllowed(message: string, data?: CTGPromptServerErrorData): CTGPromptServerRequestError {
        return new this(CTGPromptServerError.CODE.CANCEL_NOT_ALLOWED, 409, message, data);
    }

    // Static Factory Method :: STRING, UNKNOWN? -> ctgPromptServerRequestError
    // Creates NOT_FOUND / 13 with HTTP 404.
    static notFound(message: string, data?: CTGPromptServerErrorData): CTGPromptServerRequestError {
        return new this(CTGPromptServerError.CODE.NOT_FOUND, 404, message, data);
    }

    // Static Factory Method :: STRING, UNKNOWN? -> ctgPromptServerRequestError
    // Creates METHOD_NOT_ALLOWED / 14 with HTTP 405.
    static methodNotAllowed(message: string, data?: CTGPromptServerErrorData): CTGPromptServerRequestError {
        return new this(CTGPromptServerError.CODE.METHOD_NOT_ALLOWED, 405, message, data);
    }
}
