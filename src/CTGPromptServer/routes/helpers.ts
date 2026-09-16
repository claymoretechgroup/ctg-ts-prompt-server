// Dependencies:
import CTGPromptServerRequestError from "../../CTGPromptServerRequestError/CTGPromptServerRequestError.js"; // HTTP request errors

// Type dependencies:
import type { NextFunction, Request, Response } from "express"; // Express route types
import type {
    CTGPromptPaginationPage,                                  // Serialized prompt page
    CTGPromptServerQueueRecord,                               // Serialized prompt record
    PromptListQuery,                                          // Route list query
    PromptStatus                                              // Status route literal
} from "../../types.js";
import type CTGPromptServer from "../CTGPromptServer.js";      // Server instance passed to route binders

/**
 *
 * Functions
 *
 */

// FUNCTION :: ((request, response) -> PROMISE(VOID)) -> expressHandler
// Wraps async route handlers for Express.
export const asyncRoute = (fn: (req: Request, res: Response) => Promise<void>): (req: Request, res: Response, next: NextFunction) => void => {
    return (req: Request, res: Response, next: NextFunction): void => {
        fn(req, res).catch(next);
    };
};

// FUNCTION :: request, response, nextFunction -> VOID
// Rejects non-JSON prompt submissions before body parsing.
export const requireJson = (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.is("application/json")) {
        next(CTGPromptServerRequestError.invalidContentType("Content-Type must be application/json."));
        return;
    }

    next();
};

// FUNCTION :: response, UNKNOWN, NUMBER -> VOID
// Writes a success envelope.
export const success = (res: Response, result: CTGPromptServerQueueRecord | CTGPromptPaginationPage, status: number): void => {
    res.status(status).json({
        success: true,
        result: Array.isArray((result as CTGPromptPaginationPage).records)
            ? {
                records: (result as CTGPromptPaginationPage).records.map((prompt) => serializePrompt(prompt)),
                nextBefore: (result as CTGPromptPaginationPage).nextBefore
            }
            : serializePrompt(result as CTGPromptServerQueueRecord)
    });
};

// FUNCTION :: ctgPromptServerQueueRecord -> ctgPromptServerQueueRecord
// Returns the public prompt record projection.
export const serializePrompt = (prompt: CTGPromptServerQueueRecord): CTGPromptServerQueueRecord => {
    return {
        id: prompt.id,
        statusCode: prompt.statusCode,
        prompt: prompt.prompt,
        response: prompt.response,
        errorCode: prompt.errorCode,
        errorMessage: prompt.errorMessage,
        runner: prompt.runner,
        createdAt: prompt.createdAt,
        startedAt: prompt.startedAt,
        finishedAt: prompt.finishedAt
    };
};

// FUNCTION :: STRING? -> NUMBER
// Parses an id route segment.
export const parseId = (value: string | undefined): number => {
    if (value === undefined || !/^[0-9]+$/.test(value)) {
        throw CTGPromptServerRequestError.invalidQuery("Invalid query.");
    }

    return Number(value);
};

// FUNCTION :: UNKNOWN -> NUMBER?
// Parses the optional wait query parameter.
export const parseWait = (value: unknown): number | null => {
    if (value === undefined) {
        return null;
    }
    if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
        throw CTGPromptServerRequestError.invalidQuery("Invalid query.");
    }

    return Number(value);
};

// FUNCTION :: request, promptStatus?, ctgPromptServer -> promptListQuery
// Parses list route query parameters.
export const parseListQuery = (req: Request, status: PromptStatus | null, server: CTGPromptServer): PromptListQuery => {
    const limit = parseOptionalPositiveInteger(req.query.limit, server.config.maxLimit ?? 200);
    const before = parseOptionalPositiveInteger(req.query.before);

    return {
        ...(status === null ? {} : { status }),
        ...(limit === undefined ? {} : { limit }),
        ...(before === undefined ? {} : { before })
    };
};

// FUNCTION :: STRING? -> promptStatus
// Parses a status route segment.
export const parseStatus = (value: string | undefined): PromptStatus => {
    if (value === "pending" || value === "active" || value === "done" || value === "error" || value === "cancelled") {
        return value;
    }

    throw CTGPromptServerRequestError.invalidQuery("Invalid query.");
};

// FUNCTION :: STRING|[STRING]? -> STRING?
// Returns the first string from an Express param shape.
export const single = (value: string | string[] | undefined): string | undefined => {
    return Array.isArray(value) ? value[0] : value;
};

// FUNCTION :: UNKNOWN -> BOOLEAN
// Narrows object values.
export const isObject = (value: unknown): value is Record<string, unknown> => {
    return typeof value === "object" && value !== null;
};

// FUNCTION :: UNKNOWN, NUMBER? -> NUMBER?
// Parses optional positive integer query values.
const parseOptionalPositiveInteger = (value: unknown, max?: number): number | undefined => {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
        throw CTGPromptServerRequestError.invalidQuery("Invalid query.");
    }

    const parsed = Number(value);

    if (parsed < 1 || (max !== undefined && parsed > max)) {
        throw CTGPromptServerRequestError.invalidQuery("Invalid query.");
    }

    return parsed;
};
