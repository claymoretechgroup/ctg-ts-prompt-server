// Dependencies:
import CTGTest, { CTGTestPredicates as P } from "ctg-js-test"; // Pipeline test API and predicates
import { ClaudeRunnerEvent, CodexRunnerEvent, LLMRunnerStreamEvent } from "ctg-ai-agent-proc"; // Real upstream native and fallback stream events
import {
    allEvents,                                  // Reads durable events through public DB
    cleanupTempDatabases,                       // Removes suite temp DB directories
    outputEvent,                                // Creates real upstream output events
    startServerFixture,                         // Starts queue fixtures with FakeRunner
    tempDatabasePath                            // Creates hermetic database paths
} from "./helpers.ts";

export default CTGTest.init("events")
    .assert("§7.2 step 1 LLMRunnerOutputEvent maps to output payload and wins detection order", async () => {
        const fixture = await startServerFixture([{
            behavior: "resolve",
            expectedPrompt: "raw event",
            events: [outputEvent("stdout", "chunk", "OutputSource")],
            result: "chunk"
        }], {
            database: tempDatabasePath("events-output"),
            streamMode: "raw"
        });
        const prompt = fixture.server.queue.submit("raw event");

        await fixture.server.queue.drain();
        const event = allEvents(fixture.server.db, prompt.id).find((item) => item.name === "output");

        await fixture.server.close();

        return {
            name: event?.name,
            payload: event?.payload
        };
    }, P.equals({
        name: "output",
        payload: {
            source: "OutputSource",
            stream: "stdout",
            chunk: "chunk"
        }
    }))
    .assert("§7.2 step 2 ClaudeRunnerEvent maps to stream with source type payload", async () => {
        const payload = {
            type: "assistant",
            message: {
                content: [{ type: "text", text: "hello" }]
            }
        };
        const fixture = await startServerFixture([{
            behavior: "resolve",
            expectedPrompt: "claude event",
            events: [new ClaudeRunnerEvent("ClaudeRunner", payload)],
            result: "hello"
        }], {
            runner: {
                kind: "claude"
            },
            database: tempDatabasePath("events-claude")
        });
        const prompt = fixture.server.queue.submit("claude event");

        await fixture.server.queue.drain();
        const event = allEvents(fixture.server.db, prompt.id).find((item) => item.name === "stream");

        await fixture.server.close();

        return event?.payload;
    }, P.equals({
        source: "ClaudeRunner",
        type: "assistant",
        payload: {
            type: "assistant",
            message: {
                content: [{ type: "text", text: "hello" }]
            }
        }
    }))
    .assert("§7.2 step 2 CodexRunnerEvent maps payload property without subclass enumeration", async () => {
        const payload = {
            type: "item.completed",
            item: {
                type: "agent_message",
                text: "hello"
            }
        };
        const fixture = await startServerFixture([{
            behavior: "resolve",
            expectedPrompt: "codex event",
            events: [new CodexRunnerEvent("CodexRunner", payload)],
            result: "hello"
        }], {
            runner: {
                kind: "codex"
            },
            database: tempDatabasePath("events-codex")
        });
        const prompt = fixture.server.queue.submit("codex event");

        await fixture.server.queue.drain();
        const event = allEvents(fixture.server.db, prompt.id).find((item) => item.name === "stream");

        await fixture.server.close();

        return event?.payload;
    }, P.equals({
        source: "CodexRunner",
        type: "item.completed",
        payload: {
            type: "item.completed",
            item: {
                type: "agent_message",
                text: "hello"
            }
        }
    }))
    .assert("§7.2 step 3 bare LLMRunnerStreamEvent maps to stream raw payload", async () => {
        const fixture = await startServerFixture([{
            behavior: "resolve",
            expectedPrompt: "bare event",
            events: [new LLMRunnerStreamEvent("BareRunner", { raw: true })],
            result: ""
        }], {
            database: tempDatabasePath("events-bare")
        });
        const prompt = fixture.server.queue.submit("bare event");

        await fixture.server.queue.drain();
        const event = allEvents(fixture.server.db, prompt.id).find((item) => item.name === "stream");

        await fixture.server.close();

        return event?.payload;
    }, P.equals({
        source: "BareRunner",
        raw: {
            raw: true
        }
    }))
    .assert("§7.2 store-before-publish makes every received stream event replayable", async () => {
        const fixture = await startServerFixture([{
            behavior: "block",
            expectedPrompt: "replayable",
            events: [outputEvent("stdout", "live", "OutputSource")]
        }], {
            database: tempDatabasePath("events-store-first"),
            streamMode: "raw"
        });
        const prompt = fixture.server.queue.submit("replayable");

        await new Promise<void>((resolve) => {
            setTimeout(resolve, 20);
        });

        const eventsBeforeFinish = allEvents(fixture.server.db, prompt.id).map((event) => event.name);

        fixture.runner.release(0, "live");
        await fixture.server.queue.drain();
        await fixture.server.close();

        return eventsBeforeFinish;
    }, P.equals(["pending", "active", "output"]))
    .assert("§11 cleanup temp databases", () => {
        cleanupTempDatabases();
        return true;
    }, P.isTrue());

