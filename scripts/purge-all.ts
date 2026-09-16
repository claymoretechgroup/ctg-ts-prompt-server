// Dependencies:
import { CTGPromptServerDB } from "../src/index.ts"; // Public DB purge API

const path = process.env.PROMPT_SERVER_DB ?? "prompts.db";
const db = CTGPromptServerDB.init({ path });

try {
    const count = db.purgeAll();

    console.log(count);
} finally {
    db.close();
}
