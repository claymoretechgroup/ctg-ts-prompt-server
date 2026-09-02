// Dependencies:
import CTGTest, { CTGTestPredicates as P } from "ctg-js-test"; // Pipeline test API and predicates
import {
    API_KEY,                                        // Shared route key for authenticated requests
    captureRejected,                                // Captures cleanup errors after intentional DB close
    cleanupTempDatabases,                           // Removes suite temp DB directories
    httpRequest,                                    // Exercises the public HTTP surface over loopback
    isErrorEnvelope,                                // Verifies exact §8.3 error envelope and status
    promptListResult,                               // Extracts and exact-key-checks prompt list envelopes
    promptResult,                                   // Extracts and exact-key-checks prompt record envelopes
    startServerFixture,                             // Starts server fixtures with FakeRunner
    tempDatabasePath,                               // Creates hermetic database paths
    waitUntil                                       // Waits for active/done states before route assertions
} from "./helpers.ts";

export default CTGTest.init("routes")
    .assert("§8.2/§9.1 UNAUTHORIZED missing bearer key returns 401", async () => {
        const fixture = await startServerFixture([], {
            database: tempDatabasePath("routes-unauthorized")
        });
        const response = await httpRequest({
            method: "GET",
            path: "/prompts",
            port: fixture.port
        });

        await fixture.server.close();

        return isErrorEnvelope(response, "UNAUTHORIZED", 401);
    }, P.isTrue())
    .assert("§8.2 Bearer scheme is case-insensitive and key comparison still gates access", async () => {
        const fixture = await startServerFixture([], {
            database: tempDatabasePath("routes-bearer-case")
        });
        const response = await httpRequest({
            method: "GET",
            path: "/prompts",
            port: fixture.port,
            headers: {
                Authorization: `bearer ${API_KEY}`
            }
        });

        await fixture.server.close();

        return response.status === 200 && promptListResult(response) !== null;
    }, P.isTrue())
    .assert("§8.1/§9.1 INVALID_CONTENT_TYPE POST /prompt without JSON returns 415", async () => {
        const fixture = await startServerFixture([], {
            database: tempDatabasePath("routes-content-type")
        });
        const response = await httpRequest({
            method: "POST",
            path: "/prompt",
            port: fixture.port,
            apiKey: API_KEY,
            contentType: "text/plain",
            body: "hello"
        });

        await fixture.server.close();

        return isErrorEnvelope(response, "INVALID_CONTENT_TYPE", 415);
    }, P.isTrue())
    .assert("§8.1/§9.1 INVALID_BODY non-object or missing prompt returns 400", async () => {
        const fixture = await startServerFixture([], {
            database: tempDatabasePath("routes-body")
        });
        const response = await httpRequest({
            method: "POST",
            path: "/prompt",
            port: fixture.port,
            apiKey: API_KEY,
            contentType: "application/json",
            body: {}
        });

        await fixture.server.close();

        return isErrorEnvelope(response, "INVALID_BODY", 400);
    }, P.isTrue())
    .assert("§5.1/§9.1 INVALID_PROMPT whitespace body prompt returns 400", async () => {
        const fixture = await startServerFixture([], {
            database: tempDatabasePath("routes-invalid-prompt")
        });
        const response = await httpRequest({
            method: "POST",
            path: "/prompt",
            port: fixture.port,
            apiKey: API_KEY,
            contentType: "application/json",
            body: {
                prompt: "   "
            }
        });

        await fixture.server.close();

        return isErrorEnvelope(response, "INVALID_PROMPT", 400);
    }, P.isTrue())
    .assert("§8.1 detection order/§9.1 INVALID_QUERY covers bad id, status, limit, before, and wait before lookup", async () => {
        const fixture = await startServerFixture([], {
            database: tempDatabasePath("routes-invalid-query")
        });
        const cases = await Promise.all([
            httpRequest({ method: "GET", path: "/prompt/not-an-id", port: fixture.port, apiKey: API_KEY }),
            httpRequest({ method: "GET", path: "/prompts/finished", port: fixture.port, apiKey: API_KEY }),
            httpRequest({ method: "GET", path: "/prompts?limit=0", port: fixture.port, apiKey: API_KEY }),
            httpRequest({ method: "GET", path: "/prompts?before=0", port: fixture.port, apiKey: API_KEY }),
            httpRequest({ method: "GET", path: "/prompt/1?wait=abc", port: fixture.port, apiKey: API_KEY })
        ]);

        await fixture.server.close();

        return cases.every((response) => isErrorEnvelope(response, "INVALID_QUERY", 400));
    }, P.isTrue())
    .assert("§8.1/§9.1 PROMPT_NOT_FOUND read returns 404", async () => {
        const fixture = await startServerFixture([], {
            database: tempDatabasePath("routes-not-found-prompt")
        });
        const response = await httpRequest({
            method: "GET",
            path: "/prompt/999",
            port: fixture.port,
            apiKey: API_KEY
        });

        await fixture.server.close();

        return isErrorEnvelope(response, "PROMPT_NOT_FOUND", 404);
    }, P.isTrue())
    .assert("§5.2/§9.1 CANCEL_NOT_ALLOWED active prompt DELETE returns 409", async () => {
        const fixture = await startServerFixture([{
            behavior: "block",
            expectedPrompt: "cannot cancel active"
        }], {
            database: tempDatabasePath("routes-cancel-active")
        });
        const prompt = fixture.server.queue.submit("cannot cancel active");

        await waitUntil(() => fixture.server.db.readPrompt(prompt.id)?.status === "active");

        const response = await httpRequest({
            method: "DELETE",
            path: `/prompt/${prompt.id}`,
            port: fixture.port,
            apiKey: API_KEY
        });

        fixture.runner.release(0, "done");
        await fixture.server.queue.drain();
        await fixture.server.close();

        return isErrorEnvelope(response, "CANCEL_NOT_ALLOWED", 409);
    }, P.isTrue())
    .assert("§8.4/§9.1 NOT_FOUND unmatched path returns 404", async () => {
        const fixture = await startServerFixture([], {
            database: tempDatabasePath("routes-path-not-found")
        });
        const response = await httpRequest({
            method: "GET",
            path: "/health",
            port: fixture.port,
            apiKey: API_KEY
        });

        await fixture.server.close();

        return isErrorEnvelope(response, "NOT_FOUND", 404);
    }, P.isTrue())
    .assert("§8.4/§9.1 METHOD_NOT_ALLOWED matched path wrong method returns 405", async () => {
        const fixture = await startServerFixture([], {
            database: tempDatabasePath("routes-method-not-allowed")
        });
        const response = await httpRequest({
            method: "PUT",
            path: "/prompt",
            port: fixture.port,
            apiKey: API_KEY
        });

        await fixture.server.close();

        return isErrorEnvelope(response, "METHOD_NOT_ALLOWED", 405);
    }, P.isTrue())
    .assert("§9.1 STORE_FAILED sqlite failure during request returns 500", async () => {
        const fixture = await startServerFixture([], {
            database: tempDatabasePath("routes-store-failed")
        });

        fixture.server.db.close();

        const response = await httpRequest({
            method: "GET",
            path: "/prompts",
            port: fixture.port,
            apiKey: API_KEY
        });

        await captureRejected(async () => {
            await fixture.server.close();
        });

        return isErrorEnvelope(response, "STORE_FAILED", 500);
    }, P.isTrue())
    .assert("§8.4/§9.1 INTERNAL_ERROR unhandled route error returns 500 without original details", async () => {
        const fixture = await startServerFixture([], {
            database: tempDatabasePath("routes-internal-error")
        });
        const queue = fixture.server.queue as unknown as { read(id: number): unknown };

        queue.read = () => {
            throw new Error("private detail");
        };

        const inserted = fixture.server.db.insertPrompt("read me");
        const response = await httpRequest({
            method: "GET",
            path: `/prompt/${inserted.id}`,
            port: fixture.port,
            apiKey: API_KEY
        });

        await fixture.server.close();

        return isErrorEnvelope(response, "INTERNAL_ERROR", 500)
            && !response.raw.includes("private detail");
    }, P.isTrue())
    .assert("§8.1/§8.3 POST /prompt returns 202 success envelope with exact prompt key set and ignores extra body fields (D1)", async () => {
        const fixture = await startServerFixture([{
            behavior: "resolve",
            expectedPrompt: "route prompt",
            events: [],
            result: "done"
        }], {
            database: tempDatabasePath("routes-post-success")
        });
        const response = await httpRequest({
            method: "POST",
            path: "/prompt",
            port: fixture.port,
            apiKey: API_KEY,
            contentType: "application/json",
            body: {
                prompt: "route prompt",
                runner: "ignored",
                streamMode: "raw"
            }
        });
        const record = promptResult(response);

        await fixture.server.queue.drain();
        await fixture.server.close();

        return response.status === 202
            && record !== null
            && record.prompt === "route prompt";
    }, P.isTrue())
    .assert("§8.1/§8.3 GET /prompt/:id returns record only, not event history or info", async () => {
        const fixture = await startServerFixture([{
            behavior: "resolve",
            expectedPrompt: "read route",
            events: [],
            result: "read done",
            error: "stderr diagnostic"
        }], {
            database: tempDatabasePath("routes-get-success")
        });
        const submitted = fixture.server.queue.submit("read route");

        await fixture.server.queue.drain();

        const response = await httpRequest({
            method: "GET",
            path: `/prompt/${submitted.id}`,
            port: fixture.port,
            apiKey: API_KEY
        });
        const record = promptResult(response);

        await fixture.server.close();

        return response.status === 200
            && record?.response === "read done"
            && !response.raw.includes("stderr diagnostic")
            && !response.raw.includes("\"events\"")
            && !response.raw.includes("\"info\"");
    }, P.isTrue())
    .assert("§8.1 DELETE /prompt/:id cancels a pending prompt and returns exact record envelope", async () => {
        const fixture = await startServerFixture([{
            behavior: "block",
            expectedPrompt: "active first"
        }], {
            database: tempDatabasePath("routes-delete-success")
        });
        fixture.server.queue.submit("active first");
        const pending = fixture.server.queue.submit("delete pending");

        const response = await httpRequest({
            method: "DELETE",
            path: `/prompt/${pending.id}`,
            port: fixture.port,
            apiKey: API_KEY
        });
        const record = promptResult(response);

        fixture.runner.release(0, "done");
        await fixture.server.queue.drain();
        await fixture.server.close();

        return response.status === 200 && record?.status === "cancelled";
    }, P.isTrue())
    .assert("§8.1/§8.3 GET /prompts and /prompts/:status return exact list envelope shape", async () => {
        const fixture = await startServerFixture([], {
            database: tempDatabasePath("routes-list-success")
        });

        fixture.server.db.insertPrompt("pending one");

        const all = await httpRequest({
            method: "GET",
            path: "/prompts?limit=1",
            port: fixture.port,
            apiKey: API_KEY
        });
        const pending = await httpRequest({
            method: "GET",
            path: "/prompts/pending?limit=1",
            port: fixture.port,
            apiKey: API_KEY
        });

        await fixture.server.close();

        return all.status === 200
            && pending.status === 200
            && promptListResult(all)?.prompts.length === 1
            && promptListResult(pending)?.prompts[0]?.status === "pending";
    }, P.isTrue())
    .assert("§8.1/D1 no runner registry, health, metrics, or purge routes exist", async () => {
        const fixture = await startServerFixture([], {
            database: tempDatabasePath("routes-absent")
        });
        const cases = await Promise.all([
            httpRequest({ method: "GET", path: "/runners", port: fixture.port, apiKey: API_KEY }),
            httpRequest({ method: "GET", path: "/metrics", port: fixture.port, apiKey: API_KEY }),
            httpRequest({ method: "POST", path: "/purge-finished", port: fixture.port, apiKey: API_KEY })
        ]);

        await fixture.server.close();

        return cases.every((response) => isErrorEnvelope(response, "NOT_FOUND", 404));
    }, P.isTrue())
    .assert("§11 cleanup temp databases", () => {
        cleanupTempDatabases();
        return true;
    }, P.isTrue());
