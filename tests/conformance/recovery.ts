// Dependencies:
import CTGTest, { CTGTestPredicates as P } from "ctg-js-test"; // Pipeline test API and predicates
import { CTGPromptDB } from "../../src/index.ts";              // Public DB used to seed pre-start active/pending rows
import {
    allEvents,                                  // Reads durable recovery events
    cleanupTempDatabases,                       // Removes suite temp DB directories
    isObject,                                   // Narrows predicate callback values
    startServerFixture,                         // Starts a server to trigger recovery
    tempDatabasePath,                           // Creates hermetic file DB paths
    waitUntil                                   // Waits for pending dispatch after recovery
} from "./helpers.ts";

export default CTGTest.init("recovery")
    .assert("§4.3/R21 active prompts are interrupted as error with INTERRUPTED event payload", async () => {
        const path = tempDatabasePath("recovery-active");
        const db = CTGPromptDB.init({ path });
        const inserted = db.insertPrompt("was active");
        const claimed = db.claimNextPending("claude");

        db.close();

        const fixture = await startServerFixture([], {
            database: path
        });

        const record = fixture.server.db.readPrompt(inserted.id);
        const error = allEvents(fixture.server.db, claimed?.prompt.id ?? inserted.id).find((event) => event.name === "error");

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
            && row.errorType === "INTERRUPTED"
            && row.errorMessage === "The prompt was active when the server stopped."
            && row.eventName === "error"
            && typeof payload === "object"
            && payload !== null
            && "errorType" in payload
            && payload.errorType === "INTERRUPTED";
    }))
    .assert("§4.3 step 3 pending prompts are untouched by recovery and then eligible for dispatch", async () => {
        const path = tempDatabasePath("recovery-pending");
        const db = CTGPromptDB.init({ path });
        const pending = db.insertPrompt("still pending");

        db.close();

        const fixture = await startServerFixture([{
            behavior: "block",
            expectedPrompt: "still pending"
        }], {
            database: path
        });

        await waitUntil(() => fixture.server.db.readPrompt(pending.id)?.status === "active");
        const during = fixture.server.db.readPrompt(pending.id);

        fixture.runner.release(0, "done");
        await fixture.server.queue.drain();
        const after = fixture.server.db.readPrompt(pending.id);
        await fixture.server.close();

        return {
            duringStatus: during?.status,
            duringErrorType: during?.errorType,
            afterStatus: after?.status
        };
    }, P.equals({
        duringStatus: "active",
        duringErrorType: null,
        afterStatus: "done"
    }))
    .assert("§11 cleanup temp databases", () => {
        cleanupTempDatabases();
        return true;
    }, P.isTrue());
