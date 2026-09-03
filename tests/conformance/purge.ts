// Dependencies:
import CTGTest, { CTGTestPredicates as P } from "ctg-js-test"; // Pipeline test API and predicates
import { CTGPromptDB } from "../../src/index.ts";              // Public DB purge API under conformance
import {
    allEvents,                                  // Reads durable events before and after purge
    cleanupTempDatabases,                       // Removes suite temp DB directories
    tempDatabasePath                            // Creates hermetic file DB paths
} from "./helpers.ts";

export default CTGTest.init("purge")
    .assert("§6.6/R13 purgeFinished deletes done/error/cancelled rows and cascades their events", () => {
        const db = CTGPromptDB.init({
            path: tempDatabasePath("purge-finished")
        });
        const done = db.insertPrompt("done");
        const error = db.insertPrompt("error");
        const cancelled = db.insertPrompt("cancelled");

        db.claimNextPending("claude");
        db.finishPrompt(done.id, {
            status: "done",
            response: "done"
        });
        db.claimNextPending("claude");
        db.finishPrompt(error.id, {
            status: "error",
            errorType: "RUNNER",
            errorMessage: "runner failed"
        });
        db.cancelPending(cancelled.id);

        const removed = db.purgeFinished();

        const rows = [done, error, cancelled].map((prompt) => db.readPrompt(prompt.id));
        const eventCounts = [done, error, cancelled].map((prompt) => allEvents(db, prompt.id).length);

        db.close();

        return {
            removed,
            rows,
            eventCounts
        };
    }, P.equals({
        removed: 3,
        rows: [undefined, undefined, undefined],
        eventCounts: [0, 0, 0]
    }))
    .assert("§6.6 pending and active rows, and their events, are preserved by purge", () => {
        const db = CTGPromptDB.init({
            path: tempDatabasePath("purge-preserve")
        });
        const active = db.insertPrompt("active");
        const pending = db.insertPrompt("pending");

        db.claimNextPending("claude");

        const removed = db.purgeFinished();
        const activeRecord = db.readPrompt(active.id);
        const pendingRecord = db.readPrompt(pending.id);
        const activeEvents = allEvents(db, active.id).map((event) => event.name);
        const pendingEvents = allEvents(db, pending.id).map((event) => event.name);

        db.close();

        return {
            removed,
            activeStatus: activeRecord?.status,
            pendingStatus: pendingRecord?.status,
            activeEvents,
            pendingEvents
        };
    }, P.equals({
        removed: 0,
        activeStatus: "active",
        pendingStatus: "pending",
        activeEvents: ["pending", "active"],
        pendingEvents: ["pending"]
    }))
    .assert("§6.1/R12 AUTOINCREMENT ids are not reused after purge", () => {
        const db = CTGPromptDB.init({
            path: tempDatabasePath("purge-autoincrement")
        });
        const first = db.insertPrompt("first");

        db.cancelPending(first.id);
        db.purgeFinished();

        const second = db.insertPrompt("second");

        db.close();

        return second.id > first.id;
    }, P.isTrue())
    .assert("§6.6 purgeAll works through a second file connection like the purge-all script", () => {
        const path = tempDatabasePath("purge-all-script");
        const primary = CTGPromptDB.init({ path });
        const active = primary.insertPrompt("active");
        const pending = primary.insertPrompt("pending");

        primary.claimNextPending("claude");

        const scriptDB = CTGPromptDB.init({ path });
        const removed = scriptDB.purgeAll();

        scriptDB.close();

        const rows = [active, pending].map((prompt) => primary.readPrompt(prompt.id));
        const eventCounts = [active, pending].map((prompt) => allEvents(primary, prompt.id).length);

        primary.close();

        return {
            removed,
            rows,
            eventCounts
        };
    }, P.equals({
        removed: 2,
        rows: [undefined, undefined],
        eventCounts: [0, 0]
    }))
    .assert("§6.6 reset works through a second file connection like the reset-everything script", () => {
        const path = tempDatabasePath("reset-everything-script");
        const primary = CTGPromptDB.init({ path });

        primary.insertPrompt("before reset");

        const scriptDB = CTGPromptDB.init({ path });

        scriptDB.reset();
        scriptDB.close();

        const after = primary.insertPrompt("after reset");
        const prompts = primary.listPrompts({
            limit: 10
        }).prompts.map((prompt) => prompt.id);

        primary.close();

        return {
            afterId: after.id,
            prompts
        };
    }, P.equals({
        afterId: 1,
        prompts: [1]
    }))
    .assert("§11 cleanup temp databases", () => {
        cleanupTempDatabases();
        return true;
    }, P.isTrue());
