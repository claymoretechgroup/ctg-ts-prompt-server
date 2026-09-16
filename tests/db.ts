// Dependencies:
import { mkdtempSync, rmSync } from "node:fs";                 // Creates and removes hermetic DB dirs
import { tmpdir } from "node:os";                              // System temp root
import { join } from "node:path";                              // Portable temp paths
import { DatabaseSync } from "node:sqlite";                    // Direct schema inspection
import CTGTest, { CTGTestPredicates as P } from "ctg-js-test"; // Pipeline test API and predicates
import {
    asDBConstructor,
    asServerErrorConstructor,
    loadPublicModule
} from "./helpers.ts";                                         // Dynamic public module helpers

const withTempDB = async <Result>(fn: (path: string) => Result | Promise<Result>): Promise<Result> => {
    const dir = mkdtempSync(join(tmpdir(), "ctg-spec-db-"));
    const path = join(dir, "prompts.db");

    try {
        return await fn(path);
    } finally {
        rmSync(dir, {
            recursive: true,
            force: true
        });
    }
};

export default CTGTest.init("CTGPromptServerDB")
    .assert("schema is prompts-only shape", async () => {
        return await withTempDB(async (path) => {
            const mod = await loadPublicModule();
            const DB = asDBConstructor(mod.CTGPromptServerDB);

            if (DB === null) {
                return {
                    available: false
                };
            }

            const db = DB.init({ path });
            db.close();

            const sqlite = new DatabaseSync(path);

            try {
                const tables = sqlite.prepare(`
                    SELECT name FROM sqlite_master
                    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                    ORDER BY name
                `).all().map((row) => (row as { name: unknown }).name);
                const indexes = sqlite.prepare(`
                    SELECT name FROM sqlite_master
                    WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
                    ORDER BY name
                `).all().map((row) => (row as { name: unknown }).name);
                const columns = sqlite.prepare("PRAGMA table_info(prompts)")
                    .all()
                    .map((row) => (row as { name: unknown }).name);

                return {
                    available: true,
                    tables,
                    indexes,
                    columns
                };
            } finally {
                sqlite.close();
            }
        });
    }, P.equals({
        available: true,
        tables: ["prompts"],
        indexes: ["prompts_status_code_id"],
        columns: [
            "id",
            "status_code",
            "prompt",
            "response",
            "error_code",
            "error_message",
            "runner",
            "created_at",
            "started_at",
            "finished_at"
        ]
    }))
    .assert("create and read materialize pending queue records", async () => {
        return await withTempDB(async (path) => {
            const mod = await loadPublicModule();
            const DB = asDBConstructor(mod.CTGPromptServerDB);

            if (DB === null) {
                return {
                    available: false
                };
            }

            const db = DB.init({ path });
            const record = db.create("  keep exact prompt  ");
            const read = db.read(record.id);
            db.close();

            return {
                available: true,
                record: {
                    id: record.id,
                    statusCode: record.statusCode,
                    prompt: record.prompt,
                    response: record.response,
                    errorCode: record.errorCode,
                    errorMessage: record.errorMessage,
                    runner: record.runner,
                    createdAtType: typeof record.createdAt,
                    startedAt: record.startedAt,
                    finishedAt: record.finishedAt
                },
                readMatches: read !== null && read.id === record.id && read.prompt === record.prompt
            };
        });
    }, P.equals({
        available: true,
        record: {
            id: 1,
            statusCode: 1,
            prompt: "  keep exact prompt  ",
            response: "",
            errorCode: null,
            errorMessage: null,
            runner: null,
            createdAtType: "number",
            startedAt: null,
            finishedAt: null
        },
        readMatches: true
    }))
    .assert("paginate returns records newest first with cursor and status filter", async () => {
        return await withTempDB(async (path) => {
            const mod = await loadPublicModule();
            const DB = asDBConstructor(mod.CTGPromptServerDB);

            if (DB === null) {
                return {
                    available: false
                };
            }

            const db = DB.init({ path });
            const first = db.create("one");
            const second = db.create("two");
            const third = db.create("three");

            db.finish(second.id, {
                statusCode: 3,
                response: "done"
            });

            const page = db.paginate({
                limit: 2
            });
            const next = db.paginate({
                limit: 2,
                before: page.nextBefore ?? undefined
            });
            const pending = db.paginate({
                statusCode: 1,
                limit: 10
            });

            db.close();

            return {
                available: true,
                pageIds: page.records.map((record) => record.id),
                nextBefore: page.nextBefore,
                nextIds: next.records.map((record) => record.id),
                pendingIds: pending.records.map((record) => record.id),
                ids: [first.id, second.id, third.id]
            };
        });
    }, P.equals({
        available: true,
        pageIds: [3, 2],
        nextBefore: 2,
        nextIds: [1],
        pendingIds: [3, 1],
        ids: [1, 2, 3]
    }))
    .assert("append update and delete mutate queue records", async () => {
        return await withTempDB(async (path) => {
            const mod = await loadPublicModule();
            const DB = asDBConstructor(mod.CTGPromptServerDB);

            if (DB === null) {
                return {
                    available: false
                };
            }

            const db = DB.init({ path });
            const record = db.create("prompt");
            const appended = db.append(record.id, "hello ");
            const updated = db.update({
                ...appended,
                response: `${appended.response}world`,
                runner: "codex"
            });
            const deleted = db.delete(record.id);
            const missing = db.read(record.id);

            db.close();

            return {
                available: true,
                appendedResponse: appended.response,
                updatedResponse: updated.response,
                updatedRunner: updated.runner,
                deletedId: deleted?.id ?? null,
                missing
            };
        });
    }, P.equals({
        available: true,
        appendedResponse: "hello ",
        updatedResponse: "hello world",
        updatedRunner: "codex",
        deletedId: 1,
        missing: null
    }))
    .assert("claim finish cancel and interrupt use numeric status and error codes", async () => {
        return await withTempDB(async (path) => {
            const mod = await loadPublicModule();
            const DB = asDBConstructor(mod.CTGPromptServerDB);
            const ServerError = asServerErrorConstructor(mod.CTGPromptServerError);

            if (DB === null || ServerError === null) {
                return {
                    available: false
                };
            }

            const db = DB.init({ path });
            const first = db.create("one");
            const second = db.create("two");
            const third = db.create("three");
            const claimed = db.claimNext();
            const done = claimed === null ? null : db.finish(claimed.id, {
                statusCode: 3,
                response: "done"
            });
            const cancelled = db.cancel(second.id);
            const active = db.claimNext();
            const interruptedCount = db.interruptActive();
            const interrupted = db.read(third.id);

            db.close();

            return {
                available: true,
                ids: [first.id, second.id, third.id],
                claimedStatus: claimed?.statusCode ?? null,
                doneStatus: done?.statusCode ?? null,
                doneResponse: done?.response ?? null,
                cancelledStatus: cancelled.statusCode,
                activeId: active?.id ?? null,
                interruptedCount,
                interruptedStatus: interrupted?.statusCode ?? null,
                interruptedCode: interrupted?.errorCode ?? null,
                interruptedLabel: interrupted === null ? null : ServerError.labelOf(interrupted.errorCode ?? 0)
            };
        });
    }, P.equals({
        available: true,
        ids: [1, 2, 3],
        claimedStatus: 2,
        doneStatus: 3,
        doneResponse: "done",
        cancelledStatus: 5,
        activeId: 3,
        interruptedCount: 1,
        interruptedStatus: -1,
        interruptedCode: 5,
        interruptedLabel: "PROMPT_INTERRUPTED"
    }))
    .assert("purgeFinished purgeAll and reset operate on the prompts table", async () => {
        return await withTempDB(async (path) => {
            const mod = await loadPublicModule();
            const DB = asDBConstructor(mod.CTGPromptServerDB);

            if (DB === null) {
                return {
                    available: false
                };
            }

            const db = DB.init({ path });
            const first = db.create("one");
            const second = db.create("two");
            const third = db.create("three");

            db.finish(first.id, {
                statusCode: 3,
                response: "done"
            });
            db.cancel(second.id);

            const purgeFinished = db.purgeFinished();
            const afterFinished = db.paginate({
                limit: 10
            }).records.map((record) => record.id);
            const purgeAll = db.purgeAll();
            const afterAll = db.paginate({
                limit: 10
            }).records.length;

            db.create("after purge");
            db.reset();

            const afterReset = db.paginate({
                limit: 10
            }).records.length;

            db.close();

            return {
                available: true,
                ids: [first.id, second.id, third.id],
                purgeFinished,
                afterFinished,
                purgeAll,
                afterAll,
                afterReset
            };
        });
    }, P.equals({
        available: true,
        ids: [1, 2, 3],
        purgeFinished: 2,
        afterFinished: [3],
        purgeAll: 1,
        afterAll: 0,
        afterReset: 0
    }));
