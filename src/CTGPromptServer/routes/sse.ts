// Dependencies:
import {
    asyncRoute,
    parseId,
    single
} from "./helpers.js";                                             // Route helpers

// Type dependencies:
import type { Express } from "express";                            // Express app type
import type CTGPromptServer from "../CTGPromptServer.js";           // Server instance passed to route binders

// FUNCTION :: express, ctgPromptServer -> VOID
// Binds the live-only SSE route.
export default function sseRoutes(app: Express, server: CTGPromptServer): void {
    app.get("/sse/:id", asyncRoute(async (req, res) => {
        const id = parseId(single(req.params.id));

        server.queue.read(id);

        res.status(200);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        const subscription = server.openSSE(id, res);
        let timer: NodeJS.Timeout | null = null;

        const close = (): void => {
            if (timer !== null) {
                clearInterval(timer);
                timer = null;
            }
            subscription.close();
        };

        res.on("close", close);
        if (!res.writableEnded) {
            timer = setInterval(() => {
                if (res.writableEnded) {
                    close();
                    return;
                }
                res.write(": keep-alive\n\n");
            }, server.config.keepAliveMs ?? 15000);
        }
    }));
}
