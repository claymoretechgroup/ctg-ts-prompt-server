// Dependencies:
import { DatabaseSync } from "node:sqlite";                       // Verifies persisted schema, pragmas, and cascades as database observables
import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";    // Pipeline test API and predicates
import { CTGPromptDB, CTGPromptServerError } from "../../src/index.ts"; // Public DB and typed errors under conformance
import {
    allEvents,                                           // Reads complete durable event histories
    captureThrown,                                       // Captures expected typed DB errors
    cleanupTempDatabases,                                // Removes suite temp DB directories
    isObject,                                            // Narrows predicate callback values
    tempDatabasePath                                     // Creates hermetic file DB paths
} from "./helpers.ts";

interface SqliteNameRow {
    readonly name: string;
}

interface SqliteCountRow {
    readonly count: number;
}

interface SqliteForeignKeyRow {
    readonly table: string;
    readonly on_delete: string;
}

const openDB = (label: string): CTGPromptDB => CTGPromptDB.init({
    path: tempDatabasePath(label)
});

export default CTGTest.init("db")
    .assert("§6.1 schema has prompt/event tables, status index, and foreign key cascade", () => {
        const path = tempDatabasePath("db-schema");
        const db = CTGPromptDB.init({ path });
        const prompt = db.insertPrompt("cascade me");

        db.cancelPending(prompt.id);
        db.purgeFinished();
        db.close();

        const raw = new DatabaseSync(path);
        const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as SqliteNameRow[];
        const events = raw.prepare("SELECT COUNT(*) AS count FROM events WHERE prompt_id = ?").get(prompt.id) as SqliteCountRow;
        const index = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'prompts_status_id'").get();
        const foreignKeys = raw.prepare("PRAGMA foreign_key_list(events)").all() as SqliteForeignKeyRow[];

        raw.close();

        return {
            hasPrompts: tables.some((row) => row.name === "prompts"),
            hasEvents: tables.some((row) => row.name === "events"),
            hasStatusIndex: index !== undefined,
            cascadeRemovedEvents: events.count === 0,
            hasForeignKey: foreignKeys.some((row) => row.table === "prompts" && row.on_delete === "CASCADE")
        };
    }, P.equals({
        hasPrompts: true,
        hasEvents: true,
        hasStatusIndex: true,
        cascadeRemovedEvents: true,
        hasForeignKey: true
    }))
    .assert("§6.2 insertPrompt writes pending row and sequence 1 pending event", () => {
        const db = openDB("db-insert");
        const record = db.insertPrompt("  stored untrimmed  ");
        const events = allEvents(db, record.id);

        db.close();

        return {
            status: record.status,
            prompt: record.prompt,
            response: record.response,
            lastSequence: record.lastSequence,
            eventCount: events.length,
            event: events[0]?.name,
            sequence: events[0]?.sequence
        };
    }, P.equals({
        status: "pending",
        prompt: "  stored untrimmed  ",
        response: "",
        lastSequence: 1,
        eventCount: 1,
        event: "pending",
        sequence: 1
    }))
    .assert("§6.2 appendEvent allocates gap-free sequences and appends response atomically", () => {
        const db = openDB("db-sequence");
        const record = db.insertPrompt("sequence");

        db.appendEvent(record.id, "output", { stream: "stdout", chunk: "a" }, "a");
        db.appendEvent(record.id, "output", { stream: "stdout", chunk: "b" }, "b");

        const reread = db.readPrompt(record.id);
        const events = allEvents(db, record.id);

        db.close();

        return {
            response: reread?.response,
            lastSequence: reread?.lastSequence,
            sequences: events.map((event) => event.sequence)
        };
    }, P.equals({
        response: "ab",
        lastSequence: 3,
        sequences: [1, 2, 3]
    }))
    .assert("§6.3 claimNextPending claims oldest id FIFO and records runner in active payload (D7/R25)", () => {
        const db = openDB("db-claim");
        const first = db.insertPrompt("first");
        const second = db.insertPrompt("second");
        const claimed = db.claimNextPending("codex");
        const active = claimed === undefined ? undefined : allEvents(db, claimed.prompt.id).at(-1);
        const secondRecord = db.readPrompt(second.id);

        db.close();

        return {
            claimedId: claimed?.prompt.id,
            firstStatus: claimed?.prompt.status,
            secondStatus: secondRecord?.status,
            activeName: active?.name,
            activePayload: active?.payload,
            firstId: first.id
        };
    }, P.satisfies((value) => {
        if (!isObject(value) || !("claimedId" in value) || !("firstId" in value) || !("activePayload" in value)) {
            return false;
        }

        const row = value as {
            claimedId?: unknown;
            firstId?: unknown;
            firstStatus?: unknown;
            secondStatus?: unknown;
            activeName?: unknown;
            activePayload?: unknown;
        };
        const payload = row.activePayload;

        return row.claimedId === row.firstId
            && row.firstStatus === "active"
            && row.secondStatus === "pending"
            && row.activeName === "active"
            && typeof payload === "object"
            && payload !== null
            && "runner" in payload
            && payload.runner === "codex";
    }))
    .assert("§6.3 claimNextPending returns undefined when no pending prompt exists", () => {
        const db = openDB("db-claim-empty");
        const claimed = db.claimNextPending("claude");

        db.close();

        return claimed;
    }, P.isVoid())
    .assert("§6.2/§6.5 readEvents honors afterSequence", () => {
        const db = openDB("db-read-events");
        const prompt = db.insertPrompt("events");

        db.appendEvent(prompt.id, "stream", { n: 2 });
        db.appendEvent(prompt.id, "stream", { n: 3 });

        const events = db.readEvents(prompt.id, 1);

        db.close();

        return events.map((event) => [event.sequence, event.name]);
    }, P.equals([[2, "stream"], [3, "stream"]]))
    .assert("§6.2 appendEvent on unknown id throws PROMPT_NOT_FOUND", () => {
        const db = openDB("db-missing-event");
        const caught = captureThrown(() => {
            db.appendEvent(999, "stream", {});
        });

        db.close();

        return CTGPromptServerError.is(caught) && caught.type === "PROMPT_NOT_FOUND";
    }, P.isTrue())
    .assert("§6 table/§5.4 finishPrompt records done outcome, info, and terminal event", () => {
        const db = openDB("db-finish");
        const prompt = db.insertPrompt("finish");

        db.claimNextPending("claude");
        const appended = db.finishPrompt(prompt.id, {
            status: "done",
            response: "final",
            info: {
                stderr: "diagnostic"
            }
        });
        const record = db.readPrompt(prompt.id);

        db.close();

        return {
            appendedName: appended.event.name,
            status: record?.status,
            response: record?.response,
            errorType: record?.errorType,
            errorMessage: record?.errorMessage,
            finishedAtIsNumber: typeof record?.finishedAt === "number"
        };
    }, P.equals({
        appendedName: "done",
        status: "done",
        response: "final",
        errorType: null,
        errorMessage: null,
        finishedAtIsNumber: true
    }))
    .assert("§5.2/§6 cancelPending changes only pending prompt and writes cancelled event", () => {
        const db = openDB("db-cancel");
        const prompt = db.insertPrompt("cancel");
        const appended = db.cancelPending(prompt.id);
        const record = db.readPrompt(prompt.id);
        const events = allEvents(db, prompt.id);

        db.close();

        return {
            returnedStatus: appended.prompt.status,
            status: record?.status,
            eventNames: events.map((event) => event.name),
            lastSequence: record?.lastSequence
        };
    }, P.equals({
        returnedStatus: "cancelled",
        status: "cancelled",
        eventNames: ["pending", "cancelled"],
        lastSequence: 2
    }))
    .assert("§6.4 listPrompts returns newest first with stable before cursor and status filter", () => {
        const db = openDB("db-list");
        const one = db.insertPrompt("one");
        const two = db.insertPrompt("two");
        const three = db.insertPrompt("three");

        db.cancelPending(two.id);

        const firstPage = db.listPrompts({
            limit: 2
        });
        const nextPage = db.listPrompts({
            before: firstPage.nextBefore ?? 0,
            limit: 2
        });
        const cancelled = db.listPrompts({
            status: "cancelled",
            limit: 10
        });

        db.close();

        return {
            firstIds: firstPage.prompts.map((prompt) => prompt.id),
            nextBefore: firstPage.nextBefore,
            nextIds: nextPage.prompts.map((prompt) => prompt.id),
            cancelledIds: cancelled.prompts.map((prompt) => prompt.id),
            expectedNewest: [three.id, two.id],
            expectedNext: [one.id]
        };
    }, P.satisfies((value) => {
        if (!isObject(value)) {
            return false;
        }

        const row = value as {
            firstIds?: unknown;
            nextBefore?: unknown;
            nextIds?: unknown;
            cancelledIds?: unknown;
            expectedNewest?: unknown;
            expectedNext?: unknown;
        };

        if (!Array.isArray(row.expectedNewest) || !Array.isArray(row.expectedNext)) {
            return false;
        }

        return JSON.stringify(row.firstIds) === JSON.stringify(row.expectedNewest)
            && row.nextBefore === row.expectedNewest[1]
            && JSON.stringify(row.nextIds) === JSON.stringify(row.expectedNext)
            && JSON.stringify(row.cancelledIds) === JSON.stringify([row.expectedNewest[1]]);
    }))
    .assert("§11 cleanup temp databases", () => {
        cleanupTempDatabases();
        return true;
    }, P.isTrue());
