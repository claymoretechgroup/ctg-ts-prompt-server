// Dependencies:
import { readFileSync } from "node:fs";                  // Reads the JSON config file
import { CTGPromptServer } from "../src/index.ts";       // Public server entry point

// Type dependencies:
import type { CTGPromptServerConfig } from "../src/index.ts"; // Server config shape

const configPath = process.argv[2];

if (configPath === undefined) {
    throw new Error("Usage: npm start <config.json> [port]");
}

const fileConfig = JSON.parse(readFileSync(configPath, "utf8")) as CTGPromptServerConfig;
const config: CTGPromptServerConfig = {
    ...fileConfig,
    apiKey: fileConfig.apiKey ?? process.env.PROMPT_SERVER_API_KEY
} as CTGPromptServerConfig;
const portText = process.argv[3] ?? process.env.PORT ?? "8080";
const port = Number(portText);
const server = CTGPromptServer.init(config);
const bound = await server.start(port);

console.log(`${bound.host}:${bound.port}`);

const close = async (): Promise<void> => {
    await server.close();
    process.exit(0);
};

process.once("SIGINT", () => {
    void close();
});
process.once("SIGTERM", () => {
    void close();
});
