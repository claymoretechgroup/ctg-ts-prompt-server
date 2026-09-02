// Dependencies:
import CTGTest, { CTGTestPredicates as P } from "ctg-js-test"; // Pipeline test API and predicates
import EventStreamClient from "./eventStreamClient.ts";        // Dedicated SSE frame reader with raw wire text
import {
    API_KEY,                                      // Shared route key for SSE requests
    cleanupTempDatabases,                         // Removes suite temp DB directories
    delay,                                        // Waits for keep-alive and client-disconnect assertions
    httpRequest,                                  // Exercises non-stream SSE error cases
    isErrorEnvelope,                              // Verifies JSON errors instead of SSE streams
    outputEvent,                                  // Creates real upstream output events
    startServerFixture,                           // Starts server fixtures with FakeRunner
    tempDatabasePath,                             // Creates hermetic database paths
    waitUntil                                     // Waits for active/done states before opening streams
} from "./helpers.ts";

export default CTGTest.init("sse")
    .assert("§7.3 boundary unknown id returns 404 JSON envelope and no SSE stream", async () => {
        const fixture = await startServerFixture([], {
            database: tempDatabasePath("sse-unknown")
        });
        const response = await httpRequest({
            method: "GET",
            path: "/prompt/999/events",
            port: fixture.port,
            apiKey: API_KEY
        });

        await fixture.server.close();

        return isErrorEnvelope(response, "PROMPT_NOT_FOUND", 404)
            && response.headers["content-type"] !== "text/event-stream";
    }, P.isTrue())
    .assert("§7.3 boundary non-integer id returns 400 INVALID_QUERY and no SSE stream", async () => {
        const fixture = await startServerFixture([], {
            database: tempDatabasePath("sse-bad-id")
        });
        const response = await httpRequest({
            method: "GET",
            path: "/prompt/abc/events",
            port: fixture.port,
            apiKey: API_KEY
        });

        await fixture.server.close();

        return isErrorEnvelope(response, "INVALID_QUERY", 400)
            && response.headers["content-type"] !== "text/event-stream";
    }, P.isTrue())
    .assert("§7.3 absent Last-Event-ID replays full finished history then ends with exact wire shape", async () => {
        const fixture = await startServerFixture([{
            behavior: "resolve",
            expectedPrompt: "finished stream",
            events: [outputEvent("stdout", "ok")],
            result: "ok"
        }], {
            database: tempDatabasePath("sse-full-history"),
            streamMode: "raw"
        });
        const prompt = fixture.server.queue.submit("finished stream");

        await fixture.server.queue.drain();

        const client = EventStreamClient.init({
            port: fixture.port,
            apiKey: API_KEY
        });

        await client.open(prompt.id);
        const frames = await client.waitForEnd();
        await fixture.server.close();

        return {
            names: frames.map((frame) => frame.name),
            ids: frames.map((frame) => frame.id),
            rawShape: frames.every((frame) => /^id: \d+\nevent: [a-z]+\ndata: .+\n\n$/.test(frame.raw))
        };
    }, P.equals({
        names: ["pending", "active", "output", "done"],
        ids: [1, 2, 3, 4],
        rawShape: true
    }))
    .assert("§7.3 Last-Event-ID at finished last sequence sends headers, no events, immediate end", async () => {
        const fixture = await startServerFixture([{
            behavior: "resolve",
            expectedPrompt: "last finished",
            events: [],
            result: "done"
        }], {
            database: tempDatabasePath("sse-finished-after-last")
        });
        const prompt = fixture.server.queue.submit("last finished");

        await fixture.server.queue.drain();

        const record = fixture.server.db.readPrompt(prompt.id);
        const client = EventStreamClient.init({
            port: fixture.port,
            apiKey: API_KEY
        });

        await client.open(prompt.id, record?.lastSequence ?? 0);
        const frames = await client.waitForEnd();
        await fixture.server.close();

        return frames.length;
    }, P.equals(0))
    .assert("§7.3 Last-Event-ID at unfinished last sequence stays open for live tail", async () => {
        const fixture = await startServerFixture([{
            behavior: "block",
            expectedPrompt: "tail"
        }], {
            database: tempDatabasePath("sse-live-tail")
        });
        const prompt = fixture.server.queue.submit("tail");

        await waitUntil(() => fixture.server.db.readPrompt(prompt.id)?.status === "active");

        const record = fixture.server.db.readPrompt(prompt.id);
        const client = EventStreamClient.init({
            port: fixture.port,
            apiKey: API_KEY
        });

        await client.open(prompt.id, record?.lastSequence ?? 0);
        await delay(50);
        const before = client.frames().length;

        fixture.runner.release(0, "tail done");
        const frames = await client.waitForEnd();
        await fixture.server.queue.drain();
        await fixture.server.close();

        return {
            before,
            names: frames.map((frame) => frame.name)
        };
    }, P.equals({
        before: 0,
        names: ["done"]
    }))
    .assert("§7.3 malformed Last-Event-ID is treated as 0 and replays full history", async () => {
        const fixture = await startServerFixture([{
            behavior: "resolve",
            expectedPrompt: "bad last event id",
            events: [],
            result: "done"
        }], {
            database: tempDatabasePath("sse-malformed-last")
        });
        const prompt = fixture.server.queue.submit("bad last event id");

        await fixture.server.queue.drain();

        const client = EventStreamClient.init({
            port: fixture.port,
            apiKey: API_KEY
        });

        await client.open(prompt.id, Number.NaN);
        const frames = await client.waitForEnd();
        await fixture.server.close();

        return frames.map((frame) => frame.name);
    }, P.equals(["pending", "active", "done"]))
    .assert("§7.3 prompt already finished replays full history then closes without keep-alive linger", async () => {
        const fixture = await startServerFixture([{
            behavior: "resolve",
            expectedPrompt: "already finished stream",
            events: [],
            result: "done"
        }], {
            database: tempDatabasePath("sse-already-finished"),
            keepAliveMs: 1000
        });
        const prompt = fixture.server.queue.submit("already finished stream");

        await fixture.server.queue.drain();

        const started = Date.now();
        const client = EventStreamClient.init({
            port: fixture.port,
            apiKey: API_KEY
        });

        await client.open(prompt.id);
        const frames = await client.waitForEnd();
        const elapsed = Date.now() - started;
        await fixture.server.close();

        return {
            elapsedUnderKeepAlive: elapsed < 1000,
            names: frames.map((frame) => frame.name)
        };
    }, P.equals({
        elapsedUnderKeepAlive: true,
        names: ["pending", "active", "done"]
    }))
    .assert("§7.3 keep-alive writes comment frames without id while stream remains open", async () => {
        const fixture = await startServerFixture([{
            behavior: "block",
            expectedPrompt: "keep alive"
        }], {
            database: tempDatabasePath("sse-keepalive"),
            keepAliveMs: 1000
        });
        const prompt = fixture.server.queue.submit("keep alive");

        await waitUntil(() => fixture.server.db.readPrompt(prompt.id)?.status === "active");

        const record = fixture.server.db.readPrompt(prompt.id);
        const client = EventStreamClient.init({
            port: fixture.port,
            apiKey: API_KEY
        });

        await client.open(prompt.id, record?.lastSequence ?? 0);
        await client.waitForFrames(1);
        const frame = client.frames()[0];

        client.close();
        fixture.runner.release(0, "done");
        await fixture.server.queue.drain();
        await fixture.server.close();

        return {
            id: frame?.id,
            name: frame?.name,
            data: frame?.data,
            comment: frame?.comment,
            raw: frame?.raw
        };
    }, P.equals({
        id: null,
        name: null,
        data: null,
        comment: "keep-alive",
        raw: ": keep-alive\n\n"
    }))
    .assert("§7.3 client disconnect deregisters stream without changing prompt outcome", async () => {
        const fixture = await startServerFixture([{
            behavior: "block",
            expectedPrompt: "disconnect"
        }], {
            database: tempDatabasePath("sse-disconnect")
        });
        const prompt = fixture.server.queue.submit("disconnect");

        await waitUntil(() => fixture.server.db.readPrompt(prompt.id)?.status === "active");

        const client = EventStreamClient.init({
            port: fixture.port,
            apiKey: API_KEY
        });

        await client.open(prompt.id);
        await client.waitForFrames(2);
        client.close();
        await delay(20);

        fixture.runner.release(0, "done");
        await fixture.server.queue.drain();
        const record = fixture.server.db.readPrompt(prompt.id);
        await fixture.server.close();

        return record?.status;
    }, P.equals("done"))
    .assert("§11 cleanup temp databases", () => {
        cleanupTempDatabases();
        return true;
    }, P.isTrue());

