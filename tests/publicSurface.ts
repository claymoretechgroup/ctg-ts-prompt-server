// Dependencies:
import CTGTest, { CTGTestPredicates as P } from "ctg-js-test"; // Pipeline test API and predicates
import { loadPublicModule } from "./helpers.ts";               // Dynamic public module loader

const expectedClassExports = [
    "CTGPromptServer",
    "CTGPromptServerDB",
    "CTGPromptServerQueue",
    "CTGPromptServerError",
    "CTGPromptServerRequestError"
] as const;

export default CTGTest.init("public surface")
    .assert("class exports are present and constructable", async () => {
        const mod = await loadPublicModule();

        return Object.fromEntries(expectedClassExports.map((name) => {
            return [name, typeof mod[name]];
        }));
    }, P.equals({
        CTGPromptServer: "function",
        CTGPromptServerDB: "function",
        CTGPromptServerQueue: "function",
        CTGPromptServerError: "function",
        CTGPromptServerRequestError: "function"
    }))
    .assert("renamed DB and queue exports preserve class identity", async () => {
        const mod = await loadPublicModule();

        return {
            dbName: typeof mod.CTGPromptServerDB === "function" ? mod.CTGPromptServerDB.name : null,
            queueName: typeof mod.CTGPromptServerQueue === "function" ? mod.CTGPromptServerQueue.name : null
        };
    }, P.equals({
        dbName: "CTGPromptServerDB",
        queueName: "CTGPromptServerQueue"
    }));
