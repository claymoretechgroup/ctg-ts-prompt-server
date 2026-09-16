// Dependencies:
import express from "express";                                     // JSON body parser
import CTGPromptServerRequestError from "../../CTGPromptServerRequestError/CTGPromptServerRequestError.js"; // HTTP request errors
import {
    asyncRoute,
    isObject,
    parseId,
    parseWait,
    requireJson,
    single,
    success
} from "./helpers.js";                                             // Route helpers

// Type dependencies:
import type { Express } from "express";                            // Express app type
import type CTGPromptServer from "../CTGPromptServer.js";           // Server instance passed to route binders

/**
 *
 * Constants
 *
 */

const BODY_LIMIT_BYTES = 1048576;                                  // Fixed JSON reader limit required by the spec

// FUNCTION :: express, ctgPromptServer -> VOID
// Binds single-prompt JSON routes.
export default function promptRoutes(app: Express, server: CTGPromptServer): void {
    app.post("/prompt", requireJson, express.json({
        limit: BODY_LIMIT_BYTES
    }), asyncRoute(async (req, res) => {
        if (!isObject(req.body) || Array.isArray(req.body) || !("prompt" in req.body)) {
            throw CTGPromptServerRequestError.invalidBody("Body must be a JSON object with a prompt property.");
        }

        success(res, server.queue.submit(req.body.prompt as string), 202);
    }));

    app.get("/prompt/:id", asyncRoute(async (req, res) => {
        const id = parseId(single(req.params.id));
        const wait = parseWait(req.query.wait);
        const record = wait === null
            ? server.queue.read(id)
            : await server.waitForPrompt(id, wait);

        success(res, record, 200);
    }));

    app.delete("/prompt/:id", asyncRoute(async (req, res) => {
        const id = parseId(single(req.params.id));

        success(res, server.queue.cancel(id), 200);
    }));
}
