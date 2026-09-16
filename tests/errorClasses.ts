// Dependencies:
import CTGTest, { CTGTestPredicates as P } from "ctg-js-test"; // Pipeline test API and predicates
import {
    asRequestErrorConstructor,
    asServerErrorConstructor,
    captureThrown,
    fakeResponse,
    loadPublicModule
} from "./helpers.ts";                                          // Dynamic public module helpers

const expectedCode = {
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
};

const requestFactories = [
    ["unauthorized", "UNAUTHORIZED", 401],
    ["invalidContentType", "INVALID_CONTENT_TYPE", 415],
    ["invalidBody", "INVALID_BODY", 400],
    ["invalidPrompt", "INVALID_PROMPT", 400],
    ["invalidQuery", "INVALID_QUERY", 400],
    ["promptNotFound", "PROMPT_NOT_FOUND", 404],
    ["cancelNotAllowed", "CANCEL_NOT_ALLOWED", 409],
    ["notFound", "NOT_FOUND", 404],
    ["methodNotAllowed", "METHOD_NOT_ALLOWED", 405]
] as const;

export default CTGTest.init("error classes")
    .assert("CTGPromptServerError.CODE exposes the label-to-code registry", async () => {
        const mod = await loadPublicModule();
        const ServerError = asServerErrorConstructor(mod.CTGPromptServerError);

        return ServerError === null ? null : ServerError.CODE;
    }, P.equals(expectedCode))
    .assert("label is derived from code and labelOf resolves invalid codes to INVALID_CODE", async () => {
        const mod = await loadPublicModule();
        const ServerError = asServerErrorConstructor(mod.CTGPromptServerError);

        if (ServerError === null) {
            return {
                available: false
            };
        }

        const error = new ServerError(ServerError.CODE.INVALID_CONFIG, "Bad config.");

        return {
            available: true,
            label: error.label,
            labelOfUnknown: ServerError.labelOf(999)
        };
    }, P.equals({
        available: true,
        label: "INVALID_CONFIG",
        labelOfUnknown: "INVALID_CODE"
    }))
    .assert("constructor stores code message and omitted data as null", async () => {
        const mod = await loadPublicModule();
        const ServerError = asServerErrorConstructor(mod.CTGPromptServerError);

        if (ServerError === null) {
            return {
                available: false
            };
        }

        const error = new ServerError(ServerError.CODE.UNKNOWN_ERROR, "Wrapped failure.");

        return {
            available: true,
            code: error.code,
            message: error.message,
            data: error.data
        };
    }, P.equals({
        available: true,
        code: expectedCode.UNKNOWN_ERROR,
        message: "Wrapped failure.",
        data: null
    }))
    .assert("invalid code throws INVALID_CODE server error", async () => {
        const mod = await loadPublicModule();
        const ServerError = asServerErrorConstructor(mod.CTGPromptServerError);

        if (ServerError === null) {
            return {
                available: false
            };
        }

        const thrown = captureThrown(() => {
            new ServerError(999, "Bad code.");
        });

        return {
            available: true,
            isServerError: ServerError.is(thrown),
            code: ServerError.is(thrown) ? (thrown as { code: number }).code : null,
            label: ServerError.is(thrown) ? (thrown as { label: string }).label : null
        };
    }, P.equals({
        available: true,
        isServerError: true,
        code: expectedCode.INVALID_CODE,
        label: "INVALID_CODE"
    }))
    .assert("toResponse returns only public success false code and message", async () => {
        const mod = await loadPublicModule();
        const ServerError = asServerErrorConstructor(mod.CTGPromptServerError);

        if (ServerError === null) {
            return {
                available: false
            };
        }

        const error = new ServerError(ServerError.CODE.RUNNER_FAILED, "Runner failed.", {
            secret: "not public"
        });

        return {
            available: true,
            response: error.toResponse()
        };
    }, P.equals({
        available: true,
        response: {
            success: false,
            result: {
                code: expectedCode.RUNNER_FAILED,
                message: "Runner failed."
            }
        }
    }))
    .assert("base sendResponse defaults to HTTP 500", async () => {
        const mod = await loadPublicModule();
        const ServerError = asServerErrorConstructor(mod.CTGPromptServerError);

        if (ServerError === null) {
            return {
                available: false
            };
        }

        const error = new ServerError(ServerError.CODE.INTERNAL_ERROR, "Internal failure.");
        const { response, capture } = fakeResponse();

        error.sendResponse(response);

        return {
            available: true,
            capture
        };
    }, P.equals({
        available: true,
        capture: {
            statusCode: 500,
            body: {
                success: false,
                result: {
                    code: expectedCode.INTERNAL_ERROR,
                    message: "Internal failure."
                }
            }
        }
    }))
    .assert("CTGPromptServerRequestError constructor assigns explicit status", async () => {
        const mod = await loadPublicModule();
        const RequestError = asRequestErrorConstructor(mod.CTGPromptServerRequestError);

        if (RequestError === null) {
            return {
                available: false
            };
        }

        const error = new RequestError(expectedCode.INVALID_BODY, 400, "Invalid body.");

        return {
            available: true,
            code: error.code,
            status: error.status,
            label: error.label
        };
    }, P.equals({
        available: true,
        code: expectedCode.INVALID_BODY,
        status: 400,
        label: "INVALID_BODY"
    }))
    .assert("request-error factories use fixed statuses and error codes", async () => {
        const mod = await loadPublicModule();
        const RequestError = asRequestErrorConstructor(mod.CTGPromptServerRequestError);

        if (RequestError === null) {
            return {
                available: false
            };
        }

        return Object.fromEntries(requestFactories.map(([factory, label, status]) => {
            const error = RequestError[factory](`${label} message`);

            return [factory, {
                code: error.code,
                status: error.status,
                label: error.label
            }];
        }));
    }, P.equals(Object.fromEntries(requestFactories.map(([factory, label, status]) => {
        return [factory, {
            code: expectedCode[label],
            status,
            label
        }];
    }))))
    .assert("request-error sendResponse uses subclass status", async () => {
        const mod = await loadPublicModule();
        const RequestError = asRequestErrorConstructor(mod.CTGPromptServerRequestError);

        if (RequestError === null) {
            return {
                available: false
            };
        }

        const error = RequestError.promptNotFound("Prompt not found.");
        const { response, capture } = fakeResponse();

        error.sendResponse(response);

        return {
            available: true,
            capture
        };
    }, P.equals({
        available: true,
        capture: {
            statusCode: 404,
            body: {
                success: false,
                result: {
                    code: expectedCode.PROMPT_NOT_FOUND,
                    message: "Prompt not found."
                }
            }
        }
    }));
