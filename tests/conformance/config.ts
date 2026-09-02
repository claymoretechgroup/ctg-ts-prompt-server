// Dependencies:
import CTGTest, { CTGTestPredicates as P } from "ctg-js-test"; // Pipeline test API and predicates
import { CTGPromptServer, CTGPromptServerError } from "../../src/index.ts"; // Public server initializer and config error class
import {
    API_KEY,                                                     // Shared route key for valid configs
    allEvents,                                                   // Reads durable events from the public DB
    captureThrown,                                               // Captures validation failures without aborting the pipeline
    cleanupTempDatabases,                                        // Removes suite temp DB directories
    isObject,                                                    // Narrows predicate callback values
    outputEvent,                                                 // Creates a real upstream output event
    startServerFixture,                                          // Starts subclassed server fixtures with FakeRunner
    tempDatabasePath                                             // Creates hermetic file DB paths
} from "./helpers.ts";

// Type dependencies:
import type { CTGPromptServerConfig } from "../../src/index.ts"; // Public config shape declared by §3.2

const validConfig = (): CTGPromptServerConfig => ({
    runner: {
        kind: "claude"
    },
    apiKey: API_KEY,
    database: tempDatabasePath("config")
});

const invalidRows: ReadonlyArray<readonly [string, unknown]> = [
    ["§4.1 step 1 runner missing", { apiKey: API_KEY }],
    ["§4.1 step 1 runner kind invalid", { ...validConfig(), runner: { kind: "openai" } }],
    ["§4.1 step 1 runner cwd empty", { ...validConfig(), runner: { kind: "claude", cwd: "" } }],
    ["§4.1 step 1 runner args not strings", { ...validConfig(), runner: { kind: "claude", args: ["ok", 7] } }],
    ["§4.1 step 1 runner timeout negative", { ...validConfig(), runner: { kind: "claude", timeout: -1 } }],
    ["§4.1 step 1 runner maxBuffer zero", { ...validConfig(), runner: { kind: "claude", maxBuffer: 0 } }],
    ["§4.1 step 2 apiKey missing", { ...validConfig(), apiKey: "" }],
    ["§4.1 step 3 concurrency zero", { ...validConfig(), concurrency: 0 }],
    ["§4.1 step 4 maxPromptBytes above ceiling", { ...validConfig(), maxPromptBytes: 131072 }],
    ["§4.1 step 5 keepAliveMs below minimum", { ...validConfig(), keepAliveMs: 999 }],
    ["§4.1 step 7 defaultLimit greater than maxLimit", { ...validConfig(), defaultLimit: 20, maxLimit: 10 }],
    ["§4.1 step 8 streamMode invalid", { ...validConfig(), streamMode: "json" }],
    ["§4.1 step 9 host empty", { ...validConfig(), host: "" }],
    ["§4.1 step 10 database empty", { ...validConfig(), database: "" }]
] as const;

export default CTGTest.init("config")
    .assert("§4.1 every invalid config check throws INVALID_CONFIG", () => {
        return invalidRows.map(([label, config]) => {
            const caught = captureThrown(() => {
                CTGPromptServer.init(config as CTGPromptServerConfig);
            });

            return {
                label,
                ok: CTGPromptServerError.is(caught) && caught.type === "INVALID_CONFIG"
            };
        });
    }, P.satisfies((rows) => Array.isArray(rows) && rows.every((row) => isObject(row) && row.ok === true)))
    .assert("§4.1 init opens database and queue getter before start throws INTERNAL_ERROR", () => {
        const server = CTGPromptServer.init(validConfig());
        const caught = captureThrown(() => server.queue);

        server.db.close();

        return CTGPromptServerError.is(caught)
            && caught.type === "INTERNAL_ERROR"
            && caught.msg === "Server has not been started.";
    }, P.isTrue())
    .assert("§3.2/§5.4 streamMode defaults to events on runner.run without contract violations", async () => {
        const fixture = await startServerFixture([{
            behavior: "resolve",
            expectedPrompt: "default stream mode",
            events: [],
            result: ""
        }], {
            database: tempDatabasePath("config-defaults")
        });

        fixture.server.queue.submit("default stream mode");
        await fixture.server.queue.drain();
        await fixture.server.close();

        return {
            streamMode: fixture.runner.calls[0]?.streamMode,
            violations: fixture.runner.violations
        };
    }, P.equals({
        streamMode: "events",
        violations: []
    }))
    .assert("§4.2/R25 runner kind still records runner field and active event payload", async () => {
        const fixture = await startServerFixture([{
            behavior: "resolve",
            expectedPrompt: "kind recorded",
            events: [outputEvent("stdout", "ok")],
            result: "ok"
        }], {
            runner: {
                kind: "codex"
            },
            database: tempDatabasePath("config-kind")
        });

        const submitted = fixture.server.queue.submit("kind recorded");
        await fixture.server.queue.drain();
        const record = fixture.server.db.readPrompt(submitted.id);
        const active = allEvents(fixture.server.db, submitted.id).find((event) => event.name === "active");

        await fixture.server.close();

        return {
            recordRunner: record?.runner,
            activePayload: active?.payload
        };
    }, P.satisfies((value) => {
        if (typeof value !== "object" || value === null || !("recordRunner" in value) || !("activePayload" in value)) {
            return false;
        }

        const row = value as { recordRunner?: unknown; activePayload?: unknown };
        const payload = row.activePayload;

        return row.recordRunner === "codex"
            && typeof payload === "object"
            && payload !== null
            && "promptId" in payload
            && payload.promptId === 1
            && "status" in payload
            && payload.status === "active"
            && "runner" in payload
            && payload.runner === "codex"
            && "startedAt" in payload
            && typeof payload.startedAt === "number";
    }))
    .assert("§11 cleanup temp databases", () => {
        cleanupTempDatabases();
        return true;
    }, P.isTrue());
