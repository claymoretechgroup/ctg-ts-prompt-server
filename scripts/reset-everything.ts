// Dependencies:
import { CTGPromptServerDB } from "../src/index.ts"; // Public DB reset API

const path = process.env.PROMPT_SERVER_DB ?? "prompts.db";
const db = CTGPromptServerDB.init({ path });

try {
    db.reset();

    console.log("reset");
} finally {
    db.close();
}
