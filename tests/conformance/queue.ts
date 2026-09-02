// Dependencies:
import CTGTest, { CTGTestPredicates as P } from "ctg-js-test"; // Pipeline test API and predicates
import { ClaudeRunnerEvent, LLMRunnerError } from "ctg-ai-agent-proc"; // Real upstream stream and typed error classes
import { CTGPromptServerError } from "../../src/index.ts";     // Public typed errors thrown by queue operations
import {
    allEvents,                                          // Reads durable event histories through public DB
    captureThrown,                                      // Captures synchronous queue validation failures
    cleanupTempDatabases,                               // Removes suite temp DB directories
    isObject,                                           // Narrows predicate callback values
    outputEvent,                                        // Creates real upstream output events
    startServerFixture,                                 // Starts queue-bearing fixtures with FakeRunner
    tempDatabasePath,                                   // Creates hermetic database paths
    waitUntil                                           // Waits for async dispatch transitions deterministically
} from "./helpers.ts";

export default CTGTest.init("queue")
    .assert("§5.1 INVALID_PROMPT rejects non-string, empty, whitespace, and oversized text", async () => {
        const fixture = await startServerFixture([], {
            database: tempDatabasePath("queue-validation"),
            maxPromptBytes: 4
        });
        const cases = [
            fixture.server.queue.submit.bind(fixture.server.queue, 7 as unknown as string),
            fixture.server.queue.submit.bind(fixture.server.queue, ""),
            fixture.server.queue.submit.bind(fixture.server.queue, " \n\t "),
            fixture.server.queue.submit.bind(fixture.server.queue, "12345")
        ];
        const result = cases.every((fn) => {
            const caught = captureThrown(fn);

            return CTGPromptServerError.is(caught) && caught.type === "INVALID_PROMPT";
        });

        await fixture.server.close();

        return result;
    }, P.isTrue())
    .assert("§5.1/§5.4/D1/D4 submit stores and executes byte-identical untrimmed prompt text with exact run config", async () => {
        const text = "  keep\nbytes  ";
        const fixture = await startServerFixture([{
            behavior: "resolve",
            expectedPrompt: text,
            events: [outputEvent("stdout", "ok")],
            result: "ok"
        }], {
            database: tempDatabasePath("queue-prompt-contract"),
            streamMode: "raw"
        });
        const submitted = fixture.server.queue.submit(text);

        await fixture.server.queue.drain();
        const record = fixture.server.db.readPrompt(submitted.id);
        await fixture.server.close();

        return {
            stored: submitted.prompt,
            read: record?.prompt,
            called: fixture.runner.calls[0]?.prompt,
            violations: fixture.runner.violations
        };
    }, P.equals({
        stored: "  keep\nbytes  ",
        read: "  keep\nbytes  ",
        called: "  keep\nbytes  ",
        violations: []
    }))
    .assert("§5.3 step 2/D7 dispatch never exceeds concurrency and leaves later prompts pending", async () => {
        const fixture = await startServerFixture([
            { behavior: "block", expectedPrompt: "one" },
            { behavior: "block", expectedPrompt: "two" },
            { behavior: "block", expectedPrompt: "three" }
        ], {
            concurrency: 2,
            database: tempDatabasePath("queue-concurrency")
        });
        const one = fixture.server.queue.submit("one");
        const two = fixture.server.queue.submit("two");
        const three = fixture.server.queue.submit("three");

        await waitUntil(() => fixture.runner.calls.length === 2);

        const before = [one, two, three].map((prompt) => fixture.server.db.readPrompt(prompt.id)?.status);

        fixture.runner.release(0, "one done");
        await waitUntil(() => fixture.runner.calls.length === 3);

        const after = [one, two, three].map((prompt) => fixture.server.db.readPrompt(prompt.id)?.status);

        fixture.runner.release(1, "two done");
        fixture.runner.release(2, "three done");
        await fixture.server.queue.drain();
        await fixture.server.close();

        return {
            before,
            after,
            callPrompts: fixture.runner.calls.map((call) => call.prompt)
        };
    }, P.equals({
        before: ["active", "active", "pending"],
        after: ["done", "active", "active"],
        callPrompts: ["one", "two", "three"]
    }))
    .assert("§5.3 step 4/R18 repeated dispatch does not double-claim one prompt", async () => {
        const fixture = await startServerFixture([
            { behavior: "block", expectedPrompt: "single" }
        ], {
            database: tempDatabasePath("queue-no-double")
        });
        const prompt = fixture.server.queue.submit("single");

        fixture.server.queue.dispatch();
        fixture.server.queue.dispatch();
        await waitUntil(() => fixture.runner.calls.length === 1);

        const activeEvents = allEvents(fixture.server.db, prompt.id).filter((event) => event.name === "active");

        fixture.runner.release(0, "done");
        await fixture.server.queue.drain();
        await fixture.server.close();

        return {
            calls: fixture.runner.calls.length,
            activeEvents: activeEvents.length
        };
    }, P.equals({
        calls: 1,
        activeEvents: 1
    }))
    .assert("§5.3 synchronous runner throw does not wedge dispatcher", async () => {
        const fixture = await startServerFixture([
            { behavior: "throw", expectedPrompt: "throws", error: new Error("boom") },
            { behavior: "resolve", expectedPrompt: "next", events: [], result: "next done" }
        ], {
            database: tempDatabasePath("queue-sync-throw")
        });
        const first = fixture.server.queue.submit("throws");
        const second = fixture.server.queue.submit("next");

        await fixture.server.queue.drain();

        const statuses = [first, second].map((prompt) => fixture.server.db.readPrompt(prompt.id)?.status);

        await fixture.server.close();

        return {
            statuses,
            calls: fixture.runner.calls.map((call) => call.prompt)
        };
    }, P.equals({
        statuses: ["error", "done"],
        calls: ["throws", "next"]
    }))
    .assert("§9.2 RUNNER outcome records error_type and error event payload for LLMRunnerError rejection", async () => {
        const fixture = await startServerFixture([{
            behavior: "reject",
            expectedPrompt: "runner rejects",
            error: new LLMRunnerError("COMMAND_FAILED", "runner failed", {
                exitCode: 2,
                stderr: "partial stderr"
            })
        }], {
            database: tempDatabasePath("queue-runner-outcome")
        });
        const prompt = fixture.server.queue.submit("runner rejects");

        await fixture.server.queue.drain();

        const record = fixture.server.db.readPrompt(prompt.id);
        const error = allEvents(fixture.server.db, prompt.id).at(-1);

        await fixture.server.close();

        return {
            status: record?.status,
            errorType: record?.errorType,
            errorMessage: record?.errorMessage,
            eventName: error?.name,
            payload: error?.payload
        };
    }, P.satisfies((value) => {
        if (!isObject(value) || !("payload" in value)) {
            return false;
        }

        const row = value as {
            status?: unknown;
            errorType?: unknown;
            errorMessage?: unknown;
            eventName?: unknown;
            payload?: unknown;
        };
        const payload = row.payload;

        return row.status === "error"
            && row.errorType === "RUNNER"
            && row.errorMessage === "runner failed"
            && row.eventName === "error"
            && typeof payload === "object"
            && payload !== null
            && "errorType" in payload
            && payload.errorType === "RUNNER";
    }))
    .assert("§5.4 step 6 runner-error outcome write failure falls back to SERVER", async () => {
        const fixture = await startServerFixture([{
            behavior: "reject",
            expectedPrompt: "runner error then store fails",
            error: new LLMRunnerError("COMMAND_FAILED", "runner failed before outcome write", {
                exitCode: 3
            })
        }], {
            database: tempDatabasePath("queue-runner-outcome-write-fallback")
        });
        const db = fixture.server.db as unknown as {
            finishPrompt(id: number, outcome: unknown): unknown;
        };
        const finishPrompt = db.finishPrompt.bind(fixture.server.db);
        let thrown = false;

        db.finishPrompt = (id: number, outcome: unknown): unknown => {
            if (!thrown) {
                thrown = true;
                throw new CTGPromptServerError("STORE_FAILED", "runner outcome write failed");
            }

            return finishPrompt(id, outcome);
        };

        const prompt = fixture.server.queue.submit("runner error then store fails");

        await fixture.server.queue.drain();

        const record = fixture.server.db.readPrompt(prompt.id);
        const error = allEvents(fixture.server.db, prompt.id).at(-1);

        await fixture.server.close();

        return {
            threw: thrown,
            status: record?.status,
            errorType: record?.errorType,
            eventName: error?.name,
            payload: error?.payload
        };
    }, P.satisfies((value) => {
        if (!isObject(value) || !("payload" in value)) {
            return false;
        }

        const row = value as {
            threw?: unknown;
            status?: unknown;
            errorType?: unknown;
            eventName?: unknown;
            payload?: unknown;
        };
        const payload = row.payload;

        return row.threw === true
            && row.status === "error"
            && row.errorType === "SERVER"
            && row.eventName === "error"
            && typeof payload === "object"
            && payload !== null
            && "errorType" in payload
            && payload.errorType === "SERVER";
    }))
    .assert("§9.2 SERVER outcome records error_type and error event payload when DB outcome write throws once", async () => {
        const fixture = await startServerFixture([{
            behavior: "block",
            expectedPrompt: "server outcome"
        }], {
            database: tempDatabasePath("queue-server-outcome")
        });
        const prompt = fixture.server.queue.submit("server outcome");

        await waitUntil(() => fixture.server.db.readPrompt(prompt.id)?.status === "active");

        const db = fixture.server.db as unknown as {
            finishPrompt(id: number, outcome: unknown): unknown;
        };
        const finishPrompt = db.finishPrompt.bind(fixture.server.db);
        let thrown = false;

        db.finishPrompt = (id: number, outcome: unknown): unknown => {
            if (!thrown) {
                thrown = true;
                throw new CTGPromptServerError("STORE_FAILED", "store failed");
            }

            return finishPrompt(id, outcome);
        };

        fixture.runner.release(0, "done");
        await fixture.server.queue.drain();

        const record = fixture.server.db.readPrompt(prompt.id);
        const error = allEvents(fixture.server.db, prompt.id).at(-1);

        await fixture.server.close();

        return {
            status: record?.status,
            errorType: record?.errorType,
            eventName: error?.name,
            payload: error?.payload
        };
    }, P.satisfies((value) => {
        if (!isObject(value) || !("payload" in value)) {
            return false;
        }

        const row = value as {
            status?: unknown;
            errorType?: unknown;
            eventName?: unknown;
            payload?: unknown;
        };
        const payload = row.payload;

        return row.status === "error"
            && row.errorType === "SERVER"
            && row.eventName === "error"
            && typeof payload === "object"
            && payload !== null
            && "errorType" in payload
            && payload.errorType === "SERVER";
    }))
    .assert("§7.2/§5.4 step 6 appendEvent throws mid-run records SERVER outcome and run continues", async () => {
        const fixture = await startServerFixture([{
            behavior: "block",
            expectedPrompt: "stream store fails",
            events: [new ClaudeRunnerEvent("ClaudeRunner", {
                type: "assistant",
                message: {
                    content: [{ type: "text", text: "partial" }]
                }
            })]
        }], {
            database: tempDatabasePath("queue-server-stream-outcome")
        });
        const db = fixture.server.db as unknown as {
            appendEvent(id: number, name: string, payload: unknown, appendResponse?: string): unknown;
        };
        const appendEvent = db.appendEvent.bind(fixture.server.db);
        let thrown = false;

        db.appendEvent = (id: number, name: string, payload: unknown, appendResponse?: string): unknown => {
            if (!thrown && name === "stream") {
                thrown = true;
                throw new CTGPromptServerError("STORE_FAILED", "stream append failed");
            }

            return appendEvent(id, name, payload, appendResponse);
        };

        const prompt = fixture.server.queue.submit("stream store fails");

        await waitUntil(() => fixture.runner.calls.length === 1
            && fixture.server.db.readPrompt(prompt.id)?.status === "active");
        const activeBeforeRelease = fixture.server.db.readPrompt(prompt.id)?.status;

        fixture.runner.release(0, "partial");
        await fixture.server.queue.drain();

        const record = fixture.server.db.readPrompt(prompt.id);
        const error = allEvents(fixture.server.db, prompt.id).at(-1);

        await fixture.server.close();

        return {
            threw: thrown,
            activeBeforeRelease,
            calls: fixture.runner.calls.length,
            status: record?.status,
            errorType: record?.errorType,
            eventName: error?.name,
            payload: error?.payload
        };
    }, P.satisfies((value) => {
        if (!isObject(value) || !("payload" in value)) {
            return false;
        }

        const row = value as {
            threw?: unknown;
            activeBeforeRelease?: unknown;
            calls?: unknown;
            status?: unknown;
            errorType?: unknown;
            eventName?: unknown;
            payload?: unknown;
        };
        const payload = row.payload;

        return row.threw === true
            && row.activeBeforeRelease === "active"
            && row.calls === 1
            && row.status === "error"
            && row.errorType === "SERVER"
            && row.eventName === "error"
            && typeof payload === "object"
            && payload !== null
            && "errorType" in payload
            && payload.errorType === "SERVER"
            && "message" in payload
            && payload.message === "stream append failed";
    }))
    .assert("§5.2/D6 cancel only pending prompts and prevents later dispatch", async () => {
        const fixture = await startServerFixture([
            { behavior: "block", expectedPrompt: "active" }
        ], {
            database: tempDatabasePath("queue-cancel-pending")
        });
        const active = fixture.server.queue.submit("active");
        const pending = fixture.server.queue.submit("pending");

        const cancelled = fixture.server.queue.cancel(pending.id);

        fixture.runner.release(0, "done");
        await fixture.server.queue.drain();

        const statuses = [active, pending].map((prompt) => fixture.server.db.readPrompt(prompt.id)?.status);

        await fixture.server.close();

        return {
            cancelled: cancelled.status,
            statuses,
            calls: fixture.runner.calls.map((call) => call.prompt)
        };
    }, P.equals({
        cancelled: "cancelled",
        statuses: ["done", "cancelled"],
        calls: ["active"]
    }))
    .assert("§5.2/R27 cancel active and finished prompts returns CANCEL_NOT_ALLOWED", async () => {
        const fixture = await startServerFixture([
            { behavior: "block", expectedPrompt: "active" },
            { behavior: "resolve", expectedPrompt: "done", events: [], result: "done" }
        ], {
            database: tempDatabasePath("queue-cancel-denied"),
            concurrency: 2
        });
        const active = fixture.server.queue.submit("active");
        const done = fixture.server.queue.submit("done");

        await waitUntil(() => fixture.server.db.readPrompt(done.id)?.status === "done");

        const activeCaught = captureThrown(() => fixture.server.queue.cancel(active.id));
        const doneCaught = captureThrown(() => fixture.server.queue.cancel(done.id));

        fixture.runner.release(0, "active done");
        await fixture.server.queue.drain();
        await fixture.server.close();

        return CTGPromptServerError.is(activeCaught)
            && activeCaught.type === "CANCEL_NOT_ALLOWED"
            && CTGPromptServerError.is(doneCaught)
            && doneCaught.type === "CANCEL_NOT_ALLOWED";
    }, P.isTrue())
    .assert("§11 cleanup temp databases", () => {
        cleanupTempDatabases();
        return true;
    }, P.isTrue());
