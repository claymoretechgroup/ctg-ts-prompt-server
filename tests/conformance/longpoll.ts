// Dependencies:
import CTGTest, { CTGTestPredicates as P } from "ctg-js-test"; // Pipeline test API and predicates
import {
    API_KEY,                                  // Shared route key for authenticated requests
    cleanupTempDatabases,                     // Removes suite temp DB directories
    delay,                                    // Controls deterministic long-poll timing
    httpRequest,                              // Exercises long-poll route over loopback
    isErrorEnvelope,                          // Verifies exact error envelope shape
    promptResult,                             // Extracts exact-key prompt record envelopes
    startServerFixture,                       // Starts server fixtures with FakeRunner
    tempDatabasePath,                         // Creates hermetic database paths
    waitUntil                                 // Waits for active state before long-poll assertions
} from "./helpers.ts";

export default CTGTest.init("longpoll")
    .assert("§5.5/R7 prompt already finished responds immediately with 200 finished status", async () => {
        const fixture = await startServerFixture([{
            behavior: "resolve",
            expectedPrompt: "already done",
            events: [],
            result: "done"
        }], {
            database: tempDatabasePath("longpoll-finished")
        });
        const prompt = fixture.server.queue.submit("already done");

        await fixture.server.queue.drain();

        const started = Date.now();
        const response = await httpRequest({
            method: "GET",
            path: `/prompt/${prompt.id}?wait=500`,
            port: fixture.port,
            apiKey: API_KEY
        });
        const elapsed = Date.now() - started;
        const record = promptResult(response);

        await fixture.server.close();

        return response.status === 200 && record?.status === "done" && elapsed < 100;
    }, P.isTrue())
    .assert("§5.5/R7 prompt finishes during wait responds when closePrompt publishes finish", async () => {
        const fixture = await startServerFixture([{
            behavior: "block",
            expectedPrompt: "finish during wait"
        }], {
            database: tempDatabasePath("longpoll-during")
        });
        const prompt = fixture.server.queue.submit("finish during wait");

        await waitUntil(() => fixture.server.db.readPrompt(prompt.id)?.status === "active");

        const started = Date.now();
        const pending = httpRequest({
            method: "GET",
            path: `/prompt/${prompt.id}?wait=1000`,
            port: fixture.port,
            apiKey: API_KEY
        });

        await delay(50);
        fixture.runner.release(0, "done");

        const response = await pending;
        const elapsed = Date.now() - started;
        const record = promptResult(response);

        await fixture.server.queue.drain();
        await fixture.server.close();

        return response.status === 200 && record?.status === "done" && elapsed < 400;
    }, P.isTrue())
    .assert("§5.5/R7 wait elapses first returns 200 with unfinished status", async () => {
        const fixture = await startServerFixture([{
            behavior: "block",
            expectedPrompt: "still running"
        }], {
            database: tempDatabasePath("longpoll-timeout")
        });
        const prompt = fixture.server.queue.submit("still running");

        await waitUntil(() => fixture.server.db.readPrompt(prompt.id)?.status === "active");

        const response = await httpRequest({
            method: "GET",
            path: `/prompt/${prompt.id}?wait=50`,
            port: fixture.port,
            apiKey: API_KEY
        });
        const record = promptResult(response);

        fixture.runner.release(0, "done");
        await fixture.server.queue.drain();
        await fixture.server.close();

        return response.status === 200 && record?.status === "active";
    }, P.isTrue())
    .assert("§5.5/R7 wait above maxWaitMs is clamped, not rejected", async () => {
        const fixture = await startServerFixture([{
            behavior: "block",
            expectedPrompt: "clamp"
        }], {
            database: tempDatabasePath("longpoll-clamp"),
            maxWaitMs: 60
        });
        const prompt = fixture.server.queue.submit("clamp");

        await waitUntil(() => fixture.server.db.readPrompt(prompt.id)?.status === "active");

        const started = Date.now();
        const response = await httpRequest({
            method: "GET",
            path: `/prompt/${prompt.id}?wait=1000`,
            port: fixture.port,
            apiKey: API_KEY
        });
        const elapsed = Date.now() - started;

        fixture.runner.release(0, "done");
        await fixture.server.queue.drain();
        await fixture.server.close();

        return response.status === 200 && elapsed >= 40 && elapsed < 300;
    }, P.isTrue())
    .assert("§8.1/§11 long-poll wait not an integer is 400 INVALID_QUERY", async () => {
        const fixture = await startServerFixture([], {
            database: tempDatabasePath("longpoll-invalid")
        });
        const response = await httpRequest({
            method: "GET",
            path: "/prompt/1?wait=abc",
            port: fixture.port,
            apiKey: API_KEY
        });

        await fixture.server.close();

        return isErrorEnvelope(response, "INVALID_QUERY", 400);
    }, P.isTrue())
    .assert("§11 cleanup temp databases", () => {
        cleanupTempDatabases();
        return true;
    }, P.isTrue());

