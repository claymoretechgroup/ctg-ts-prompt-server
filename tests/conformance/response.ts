// Dependencies:
import CTGTest, { CTGTestPredicates as P } from "ctg-js-test"; // Pipeline test API and predicates
import { ClaudeRunnerEvent, CodexRunnerEvent } from "ctg-ai-agent-proc"; // Real upstream structured runner events
import {
    cleanupTempDatabases,                       // Removes suite temp DB directories
    outputEvent,                                // Creates real upstream raw output events
    startServerFixture,                         // Starts queue fixtures with FakeRunner
    tempDatabasePath,                           // Creates hermetic database paths
    waitUntil                                   // Waits for streamed accumulation before release
} from "./helpers.ts";

export default CTGTest.init("response")
    .assert("§5.5 raw mode appends stdout output and stores stderr output without response text", async () => {
        const fixture = await startServerFixture([{
            behavior: "block",
            expectedPrompt: "raw accumulate",
            events: [
                outputEvent("stdout", "A"),
                outputEvent("stderr", "ignored"),
                outputEvent("stdout", "B")
            ]
        }], {
            database: tempDatabasePath("response-raw"),
            streamMode: "raw"
        });
        const prompt = fixture.server.queue.submit("raw accumulate");

        await waitUntil(() => fixture.server.db.readPrompt(prompt.id)?.response === "AB");
        const during = fixture.server.db.readPrompt(prompt.id);

        fixture.runner.release(0, "AB", "stderr ok");
        await fixture.server.queue.drain();
        const done = fixture.server.db.readPrompt(prompt.id);
        await fixture.server.close();

        return {
            duringResponse: during?.response,
            finalResponse: done?.response,
            errorMessage: done?.errorMessage
        };
    }, P.equals({
        duringResponse: "AB",
        finalResponse: "AB",
        errorMessage: null
    }))
    .assert("§5.5 events mode appends Claude message.content text and skips result payload during run", async () => {
        const fixture = await startServerFixture([{
            behavior: "block",
            expectedPrompt: "claude accumulate",
            events: [
                new ClaudeRunnerEvent("ClaudeRunner", {
                    type: "assistant",
                    message: {
                        content: [
                            { type: "text", text: "Hel" },
                            { type: "tool_use", id: "ignored" },
                            { type: "text", text: "lo" }
                        ]
                    }
                }),
                new ClaudeRunnerEvent("ClaudeRunner", {
                    type: "result",
                    result: "Hello final"
                })
            ]
        }], {
            runner: {
                kind: "claude"
            },
            database: tempDatabasePath("response-claude")
        });
        const prompt = fixture.server.queue.submit("claude accumulate");

        await waitUntil(() => fixture.server.db.readPrompt(prompt.id)?.response === "Hello");
        const during = fixture.server.db.readPrompt(prompt.id);

        fixture.runner.release(0, "Hello final");
        await fixture.server.queue.drain();
        const done = fixture.server.db.readPrompt(prompt.id);
        await fixture.server.close();

        return {
            during: during?.response,
            done: done?.response
        };
    }, P.equals({
        during: "Hello",
        done: "Hello final"
    }))
    .assert("§5.5 events mode appends Codex agent_message text", async () => {
        const fixture = await startServerFixture([{
            behavior: "resolve",
            expectedPrompt: "codex agent",
            events: [new CodexRunnerEvent("CodexRunner", {
                type: "item.completed",
                item: {
                    type: "agent_message",
                    text: "agent text"
                }
            })],
            result: "agent text"
        }], {
            runner: {
                kind: "codex"
            },
            database: tempDatabasePath("response-codex-agent")
        });
        const prompt = fixture.server.queue.submit("codex agent");

        await fixture.server.queue.drain();
        const record = fixture.server.db.readPrompt(prompt.id);
        await fixture.server.close();

        return record?.response;
    }, P.equals("agent text"))
    .assert("§5.5 events mode appends Codex assistant message content text", async () => {
        const fixture = await startServerFixture([{
            behavior: "resolve",
            expectedPrompt: "codex message",
            events: [new CodexRunnerEvent("CodexRunner", {
                type: "item.completed",
                item: {
                    type: "message",
                    role: "assistant",
                    content: [
                        { type: "output_text", text: "content " },
                        { type: "ignored" },
                        { type: "output_text", text: "text" }
                    ]
                }
            })],
            result: "content text"
        }], {
            runner: {
                kind: "codex"
            },
            database: tempDatabasePath("response-codex-message")
        });
        const prompt = fixture.server.queue.submit("codex message");

        await fixture.server.queue.drain();
        const record = fixture.server.db.readPrompt(prompt.id);
        await fixture.server.close();

        return record?.response;
    }, P.equals("content text"))
    .assert("§5.5 final runner result overwrites accumulated mismatch", async () => {
        const fixture = await startServerFixture([{
            behavior: "resolve",
            expectedPrompt: "overwrite",
            events: [outputEvent("stdout", "partial")],
            result: "authoritative"
        }], {
            database: tempDatabasePath("response-overwrite"),
            streamMode: "raw"
        });
        const prompt = fixture.server.queue.submit("overwrite");

        await fixture.server.queue.drain();
        const record = fixture.server.db.readPrompt(prompt.id);
        await fixture.server.close();

        return record?.response;
    }, P.equals("authoritative"))
    .assert("§5.5 accumulated text equals final result for a normal scripted run", async () => {
        const fixture = await startServerFixture([{
            behavior: "block",
            expectedPrompt: "converge",
            events: [outputEvent("stdout", "same")]
        }], {
            database: tempDatabasePath("response-converge"),
            streamMode: "raw"
        });
        const prompt = fixture.server.queue.submit("converge");

        await waitUntil(() => fixture.server.db.readPrompt(prompt.id)?.response === "same");
        const accumulated = fixture.server.db.readPrompt(prompt.id)?.response;

        fixture.runner.release(0, "same");
        await fixture.server.queue.drain();
        const final = fixture.server.db.readPrompt(prompt.id)?.response;
        await fixture.server.close();

        return {
            accumulated,
            final
        };
    }, P.equals({
        accumulated: "same",
        final: "same"
    }))
    .assert("§11 cleanup temp databases", () => {
        cleanupTempDatabases();
        return true;
    }, P.isTrue());

