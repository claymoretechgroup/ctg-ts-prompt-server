// Dependencies:
import CTGPromptServerRequestError from "../../CTGPromptServerRequestError/CTGPromptServerRequestError.js"; // HTTP request errors

// Type dependencies:
import type { Express } from "express";                            // Express app type
import type CTGPromptServer from "../CTGPromptServer.js";           // Server instance passed to route binders

// FUNCTION :: express, ctgPromptServer -> VOID
// Binds method-not-allowed and not-found fallback routes.
export default function fallbackRoutes(app: Express, _server: CTGPromptServer): void {
    app.all(["/prompt", "/prompt/:id", "/sse/:id", "/prompts", "/prompts/:status"], (_req, _res, next) => {
        next(CTGPromptServerRequestError.methodNotAllowed("Method not allowed."));
    });

    app.use((_req, _res, next) => {
        next(CTGPromptServerRequestError.notFound("Not found."));
    });
}
