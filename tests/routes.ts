// Dependencies:
import { mkdtempSync, rmSync } from "node:fs";                 // Creates and removes hermetic DB dirs
import { tmpdir } from "node:os";                              // System temp root
import { join } from "node:path";                              // Portable temp paths
import { LLMRunner } from "ctg-ai-agent-proc";                  // Runner base class for route fixtures
import CTGTest, { CTGTestPredicates as P } from "ctg-js-test"; // Pipeline test API and predicates
import {
    CTGPromptServer,
    CTGPromptServerError
} from "../src/index.ts";                                      // Public server classes under route test
import {
    httpRequest,
    isErrorEnvelope,
    isObject,
    successResult
} from "./helpers.ts";                                         // HTTP test helpers

// Type dependencies:
import type { LLMRunnerResult } from "ctg-ai-agent-proc";      // Runner result returned by the fixture runner

/**
 *
 * Constants
 *
 */

const API_KEY = "ctg-spec-route-key";
let activeRunner: LLMRunner = new LLMRunner({
    command: "node"
});

/**
 *
 * Class
 *
 */

// Server subclass that injects a deterministic runner.
class RouteTestServer extends CTGPromptServer {
    protected override createRunner(): LLMRunner {
        return activeRunner;
    }
}

// Runner that completes prompts without invoking an external process.
class RouteRunner extends LLMRunner {
    constructor() {
        super({
            command: "node"
        });
    }

    override async run(): Promise<LLMRunnerResult> {
        return {
            result: "route runner result",
            error: ""
        };
    }
}

/**
 *
 * Functions
 *
 */

// FUNCTION :: (ctgPromptServer, NUMBER, STRING -> PROMISE(T)) -> PROMISE(T)
// Starts a hermetic HTTP server fixture and always closes/removes it.
const withServer = async <Result>(fn: (server: CTGPromptServer, port: number) => Promise<Result>): Promise<Result> => {
    const dir = mkdtempSync(join(tmpdir(), "ctg-spec-routes-"));
    const database = join(dir, "prompts.db");

    activeRunner = new RouteRunner();

    const server = RouteTestServer.init({
        runner: {
            kind: "codex"
        },
        apiKey: API_KEY,
        database,
        host: "127.0.0.1"
    });

    try {
        const address = await server.start(0);

        return await fn(server, address.port);
    } finally {
        await server.close();
        rmSync(dir, {
            recursive: true,
            force: true
        });
    }
};

// FUNCTION :: UNKNOWN -> BOOLEAN
// Checks that a route result is a serialized prompt record.
const isPromptRecord = (value: unknown): boolean => {
    if (!isObject(value)) {
        return false;
    }

    return Object.keys(value).sort().join(",") === [
        "createdAt",
        "errorCode",
        "errorMessage",
        "finishedAt",
        "id",
        "prompt",
        "response",
        "runner",
        "startedAt",
        "statusCode"
    ].join(",")
        && typeof value.id === "number"
        && typeof value.statusCode === "number"
        && typeof value.prompt === "string";
};

export default CTGTest.init("routes")
    .assert("all routes require bearer authentication", async () => {
        return await withServer(async (_server, port) => {
            const response = await httpRequest({
                method: "GET",
                path: "/prompts",
                port
            });

            return isErrorEnvelope(response, CTGPromptServerError.CODE.UNAUTHORIZED, 401);
        });
    }, P.isTrue())
    .assert("POST /prompt returns 202 with a prompt record response", async () => {
        return await withServer(async (_server, port) => {
            const response = await httpRequest({
                method: "POST",
                path: "/prompt",
                port,
                apiKey: API_KEY,
                body: {
                    prompt: "route prompt",
                    ignored: true
                }
            });
            const result = successResult(response);

            return response.status === 202
                && isPromptRecord(result)
                && result?.prompt === "route prompt";
        });
    }, P.isTrue())
    .assert("GET /prompt/:id returns the current prompt record", async () => {
        return await withServer(async (server, port) => {
            const record = server.db.create("read route prompt");
            const response = await httpRequest({
                method: "GET",
                path: `/prompt/${record.id}`,
                port,
                apiKey: API_KEY
            });

            return response.status === 200
                && isPromptRecord(successResult(response))
                && successResult(response)?.id === record.id;
        });
    }, P.isTrue())
    .assert("DELETE /prompt/:id cancels a pending prompt", async () => {
        return await withServer(async (server, port) => {
            const record = server.db.create("cancel route prompt");
            const response = await httpRequest({
                method: "DELETE",
                path: `/prompt/${record.id}`,
                port,
                apiKey: API_KEY
            });
            const result = successResult(response);

            return response.status === 200
                && isPromptRecord(result)
                && result?.statusCode === 5;
        });
    }, P.isTrue())
    .assert("GET /prompts and /prompts/:status return paged record collections", async () => {
        return await withServer(async (server, port) => {
            server.db.create("first");
            server.db.create("second");

            const page = await httpRequest({
                method: "GET",
                path: "/prompts?limit=1",
                port,
                apiKey: API_KEY
            });
            const pending = await httpRequest({
                method: "GET",
                path: "/prompts/pending?limit=10",
                port,
                apiKey: API_KEY
            });
            const pageResult = successResult(page);
            const pendingResult = successResult(pending);

            return page.status === 200
                && pending.status === 200
                && Array.isArray(pageResult?.records)
                && pageResult.records.length === 1
                && typeof pageResult.nextBefore === "number"
                && Array.isArray(pendingResult?.records)
                && pendingResult.records.length === 2;
        });
    }, P.isTrue())
    .assert("invalid route inputs return request error envelopes", async () => {
        return await withServer(async (_server, port) => {
            const responses = await Promise.all([
                httpRequest({ method: "POST", path: "/prompt", port, apiKey: API_KEY, contentType: "text/plain", body: "hello" }),
                httpRequest({ method: "POST", path: "/prompt", port, apiKey: API_KEY, body: {} }),
                httpRequest({ method: "GET", path: "/prompt/not-an-id", port, apiKey: API_KEY }),
                httpRequest({ method: "GET", path: "/prompts/finished", port, apiKey: API_KEY }),
                httpRequest({ method: "GET", path: "/prompts?limit=0", port, apiKey: API_KEY })
            ]);
            const [contentType, body, id, status, limit] = responses;

            return isErrorEnvelope(contentType, CTGPromptServerError.CODE.INVALID_CONTENT_TYPE, 415)
                && isErrorEnvelope(body, CTGPromptServerError.CODE.INVALID_BODY, 400)
                && isErrorEnvelope(id, CTGPromptServerError.CODE.INVALID_QUERY, 400)
                && isErrorEnvelope(status, CTGPromptServerError.CODE.INVALID_QUERY, 400)
                && isErrorEnvelope(limit, CTGPromptServerError.CODE.INVALID_QUERY, 400);
        });
    }, P.isTrue())
    .assert("fallback routes return method-not-allowed or not-found envelopes", async () => {
        return await withServer(async (_server, port) => {
            const method = await httpRequest({
                method: "PUT",
                path: "/prompt",
                port,
                apiKey: API_KEY
            });
            const path = await httpRequest({
                method: "GET",
                path: "/health",
                port,
                apiKey: API_KEY
            });

            return isErrorEnvelope(method, CTGPromptServerError.CODE.METHOD_NOT_ALLOWED, 405)
                && isErrorEnvelope(path, CTGPromptServerError.CODE.NOT_FOUND, 404);
        });
    }, P.isTrue())
    .assert("GET /sse/:id is the SSE route and validates prompt IDs before opening a stream", async () => {
        return await withServer(async (_server, port) => {
            const response = await httpRequest({
                method: "GET",
                path: "/sse/999",
                port,
                apiKey: API_KEY
            });

            return isErrorEnvelope(response, CTGPromptServerError.CODE.PROMPT_NOT_FOUND, 404);
        });
    }, P.isTrue());
