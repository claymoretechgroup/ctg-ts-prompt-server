// Dependencies:
import fallbackRoutes from "./fallback.js";                         // Fallback route group
import promptRoutes from "./prompt.js";                             // Single-prompt route group
import promptsRoutes from "./prompts.js";                           // Prompt collection route group
import sseRoutes from "./sse.js";                                   // SSE route group

// Type dependencies:
import type { Express } from "express";                            // Express app type
import type CTGPromptServer from "../CTGPromptServer.js";           // Server instance passed to route binders

// FUNCTION :: express, ctgPromptServer -> VOID
// Binds all CTGPromptServer routes in order.
export default function bindRoutes(app: Express, server: CTGPromptServer): void {
    promptRoutes(app, server);
    promptsRoutes(app, server);
    sseRoutes(app, server);
    fallbackRoutes(app, server);
}
