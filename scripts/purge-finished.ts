// Dependencies:
import { CTGPromptDB } from "../src/index.ts"; // Public DB purge API

const path = process.env.PROMPT_SERVER_DB ?? "prompts.db";
const db = CTGPromptDB.init({ path });

try {
    const count = db.purgeFinished();

    console.log(count);
} finally {
    db.close();
}
