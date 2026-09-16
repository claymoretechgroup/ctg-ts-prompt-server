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

export default CTGTest.init("spec2 public surface")
    .assert("spec2 class exports are present and constructable", async () => {
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
    }));
