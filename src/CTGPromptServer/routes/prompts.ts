// Dependencies:
import {
    asyncRoute,
    parseListQuery,
    parseStatus,
    single,
    success
} from "./helpers.js";                                             // Route helpers

// Type dependencies:
import type { Express } from "express";                            // Express app type
import type CTGPromptServer from "../CTGPromptServer.js";           // Server instance passed to route binders

// FUNCTION :: express, ctgPromptServer -> VOID
// Binds prompt collection JSON routes.
export default function promptsRoutes(app: Express, server: CTGPromptServer): void {
    app.get("/prompts", asyncRoute(async (req, res) => {
        success(res, server.queue.list(parseListQuery(req, null, server)), 200);
    }));

    app.get("/prompts/:status", asyncRoute(async (req, res) => {
        const status = parseStatus(single(req.params.status));

        success(res, server.queue.list(parseListQuery(req, status, server)), 200);
    }));
}
