// Dependencies:
import CTGTest, { CTGTestPredicates as P } from "ctg-js-test"; // Pipeline test API and predicates
import { CTGPromptDB, CTGPromptServerError } from "../../src/index.ts"; // Public DB and typed server errors under test
import {
    API_KEY,                                            // Shared route key for authenticated probe requests
    captureRejected,                                    // Captures start() failures
    captureThrown,                                      // Captures pre-start queue getter failure
    cleanupTempDatabases,                               // Removes suite temp DB directories
    httpRequest,                                        // Probes started and closed HTTP listeners
    outputEvent,                                        // Real upstream output event for scripted success
    startServerFixture,                                 // Starts a server with FakeRunner
    tempDatabasePath,                                   // Creates hermetic database files
    FakeRunner,                                         // Scripted runner used to prove init does not invoke run()
    TestPromptServer                                    // Server subclass that injects FakeRunner
} from "./helpers.ts";

export default CTGTest.init("lifecycle")
    .assert("§4.1 init opens database but does not construct runner, recover, dispatch, or bind", () => {
        const path = tempDatabasePath("lifecycle-init");
        const db = CTGPromptDB.init({ path });
        const inserted = db.insertPrompt("left pending before server init");

        db.close();

        const fake = new FakeRunner([{
            behavior: "throw",
            expectedPrompt: "must not run",
            error: new Error("init dispatched")
        }]);

        TestPromptServer.fake = fake;

        const server = TestPromptServer.init({
            runner: {
                kind: "claude"
            },
            apiKey: API_KEY,
            database: path
        });
        const pending = server.db.readPrompt(inserted.id);
        const queueCaught = captureThrown(() => server.queue);

        server.db.close();

        return pending?.status === "pending"
            && server instanceof TestPromptServer
            && fake.calls.length === 0
            && CTGPromptServerError.is(queueCaught)
            && queueCaught.type === "INTERNAL_ERROR";
    }, P.isTrue())
    .assert("§4.2 start constructs runner, recovers, dispatches pending work, and binds socket", async () => {
        const path = tempDatabasePath("lifecycle-start");
        const db = CTGPromptDB.init({ path });
        const prompt = db.insertPrompt("pending before start");

        db.close();

        const fixture = await startServerFixture([{
            behavior: "resolve",
            expectedPrompt: "pending before start",
            events: [outputEvent("stdout", "started")],
            result: "started"
        }], {
            database: path
        });
        await fixture.server.queue.drain();

        const response = await httpRequest({
            method: "GET",
            path: `/prompt/${prompt.id}`,
            port: fixture.port,
            apiKey: API_KEY
        });
        const record = fixture.server.db.readPrompt(prompt.id);

        await fixture.server.close();

        return {
            status: response.status,
            recordStatus: record?.status,
            callCount: fixture.runner.calls.length
        };
    }, P.equals({
        status: 200,
        recordStatus: "done",
        callCount: 1
    }))
    .assert("§4.2 step 1 start twice rejects with INTERNAL_ERROR", async () => {
        const fixture = await startServerFixture([], {
            database: tempDatabasePath("lifecycle-start-twice")
        });
        const caught = await captureRejected(async () => {
            await fixture.server.start(0);
        });

        await fixture.server.close();

        return CTGPromptServerError.is(caught)
            && caught.type === "INTERNAL_ERROR"
            && caught.msg === "Server has already been started.";
    }, P.isTrue())
    .assert("§4.2 step 2 runner constructor failures are wrapped as INVALID_CONFIG", async () => {
        TestPromptServer.fake = null;

        const server = TestPromptServer.init({
            runner: {
                kind: "claude"
            },
            apiKey: API_KEY,
            database: tempDatabasePath("lifecycle-runner-error")
        });
        const caught = await captureRejected(async () => {
            await server.start(0);
        });

        server.db.close();

        return CTGPromptServerError.is(caught) && caught.type === "INVALID_CONFIG";
    }, P.isTrue())
    .assert("§4.4 close stops listener and closes resources without waiting for active run", async () => {
        const fixture = await startServerFixture([{
            behavior: "block",
            expectedPrompt: "held open"
        }], {
            database: tempDatabasePath("lifecycle-close")
        });

        fixture.server.queue.submit("held open");
        await fixture.server.close();

        const caught = await captureRejected(async () => {
            await httpRequest({
                method: "GET",
                path: "/prompts",
                port: fixture.port,
                apiKey: API_KEY
            });
        });

        return caught instanceof Error;
    }, P.isTrue())
    .assert("§11 cleanup temp databases", () => {
        cleanupTempDatabases();
        return true;
    }, P.isTrue());
