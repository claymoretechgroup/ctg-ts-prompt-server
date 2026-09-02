// Dependencies:
import { request } from "node:http";                   // Opens SSE requests over loopback without browser EventSource behavior

/**
 *
 * Type Declarations
 *
 */

// TYPE :: {id:NUMBER?, name:STRING?, data:UNKNOWN?, comment:STRING?, raw:STRING}
// Parsed Server-Sent Events frame with byte-level source retained.
export interface SSEFrame {
    readonly id: number | null;         // Parsed id: line, or null for comment-only frames
    readonly name: string | null;       // Parsed event: line, or null for comment frames
    readonly data: unknown | null;      // Parsed JSON payload from data:, or null when absent
    readonly comment: string | null;    // Comment text from a leading : line, or null
    readonly raw: string;               // Exact frame text including the terminating blank line
}

// TYPE :: {port:NUMBER, apiKey:STRING}
// Construction config for the loopback SSE client.
export interface EventStreamClientConfig {
    readonly port: number;              // Server port to connect to on 127.0.0.1
    readonly apiKey: string;            // Bearer token attached to the request
}

// TYPE :: {count:NUMBER, resolve:([sseFrame] -> VOID)}
// Pending waitForFrames resolver and the frame count it needs.
interface FrameWaiter {
    readonly count: number;                             // Number of frames required before resolution
    readonly resolve: (frames: SSEFrame[]) => void;     // Promise resolver for the waiter
}

/**
 *
 * Class
 *
 */

// Dedicated SSE test client that preserves both parsed frames and raw wire text
export default class EventStreamClient {

    /* Instance Fields */
    private readonly _port: number;                                     // Loopback port under test
    private readonly _apiKey: string;                                   // Bearer key used for the stream request
    private _buffer: string;                                            // Unparsed partial response body
    private _frames: SSEFrame[];                                        // Parsed complete frames seen so far
    private _request: ReturnType<typeof request> | null;                // Active request, aborted by close()
    private _ended: boolean;                                            // Whether the server ended the response
    private _waiters: FrameWaiter[];                                    // Resolvers waiting for a frame count
    private _endWaiters: Array<(frames: SSEFrame[]) => void>;           // Resolvers waiting for stream end

    // CONSTRUCTOR :: eventStreamClientConfig -> this
    // Creates a loopback SSE client for one started test server.
    private constructor(config: EventStreamClientConfig) {
        this._port = config.port;
        this._apiKey = config.apiKey;
        this._buffer = "";
        this._frames = [];
        this._request = null;
        this._ended = false;
        this._waiters = [];
        this._endWaiters = [];
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: NUMBER, NUMBER? -> PROMISE(VOID)
    // Opens GET /prompt/:id/events, optionally with Last-Event-ID.
    open(id: number, lastEventId?: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const headers: Record<string, string> = {
                Authorization: `Bearer ${this._apiKey}`
            };

            if (lastEventId !== undefined) {
                headers["Last-Event-ID"] = String(lastEventId);
            }

            this._request = request({
                host: "127.0.0.1",
                port: this._port,
                method: "GET",
                path: `/prompt/${id}/events`,
                headers
            }, (res) => {
                res.setEncoding("utf8");
                res.on("data", (chunk: string) => {
                    this._buffer += chunk;
                    this._parseFrames();
                });
                res.on("end", () => {
                    this._ended = true;
                    this._resolveEndWaiters();
                });
                resolve();
            });

            this._request.once("error", reject);
            this._request.end();
        });
    }

    // METHOD :: VOID -> [sseFrame]
    // Returns every complete frame received so far.
    frames(): SSEFrame[] {
        return [...this._frames];
    }

    // METHOD :: NUMBER -> PROMISE([sseFrame])
    // Resolves once at least count complete frames have been received.
    waitForFrames(count: number): Promise<SSEFrame[]> {
        if (this._frames.length >= count) {
            return Promise.resolve(this.frames());
        }

        return new Promise<SSEFrame[]>((resolve) => {
            this._waiters.push({
                count,
                resolve
            });
        });
    }

    // METHOD :: VOID -> PROMISE([sseFrame])
    // Resolves when the server ends the stream.
    waitForEnd(): Promise<SSEFrame[]> {
        if (this._ended) {
            return Promise.resolve(this.frames());
        }

        return new Promise<SSEFrame[]>((resolve) => {
            this._endWaiters.push(resolve);
        });
    }

    // METHOD :: VOID -> VOID
    // Aborts the request from the client side.
    close(): void {
        this._request?.destroy();
        this._request = null;
    }

    /**
     *
     * Private Methods
     *
     */

    // METHOD :: VOID -> VOID
    // Splits accumulated response bytes on SSE blank-line boundaries.
    private _parseFrames(): void {
        let boundary = this._buffer.indexOf("\n\n");

        while (boundary >= 0) {
            const raw = this._buffer.slice(0, boundary + 2);

            this._buffer = this._buffer.slice(boundary + 2);
            this._frames.push(EventStreamClient._parseFrame(raw));
            this._resolveFrameWaiters();
            boundary = this._buffer.indexOf("\n\n");
        }
    }

    // METHOD :: VOID -> VOID
    // Resolves and clears frame-count waiters whose condition is now true.
    private _resolveFrameWaiters(): void {
        const waiting: FrameWaiter[] = [];

        for (const waiter of this._waiters.splice(0)) {
            if (this._frames.length >= waiter.count) {
                waiter.resolve(this.frames());
            } else {
                waiting.push(waiter);
            }
        }

        this._waiters.push(...waiting);
    }

    // METHOD :: VOID -> VOID
    // Resolves all end waiters with the final parsed frame list.
    private _resolveEndWaiters(): void {
        const waiters = this._endWaiters.splice(0);

        for (const waiter of waiters) {
            waiter(this.frames());
        }
    }

    /**
     *
     * Static Methods
     *
     */

    // Static Factory Method :: eventStreamClientConfig -> eventStreamClient
    // Creates a new SSE client instance.
    static init(config: EventStreamClientConfig): EventStreamClient {
        return new EventStreamClient(config);
    }

    /**
     *
     * Private Static Methods
     *
     */

    // METHOD :: STRING -> sseFrame
    // Parses one complete raw SSE frame into the assertion-friendly shape.
    private static _parseFrame(raw: string): SSEFrame {
        const lines = raw.trimEnd().split("\n");
        let id: number | null = null;
        let name: string | null = null;
        let data: unknown | null = null;
        let comment: string | null = null;

        for (const line of lines) {
            if (line.startsWith(":")) {
                comment = line.slice(1).trimStart();
            } else if (line.startsWith("id:")) {
                id = Number.parseInt(line.slice(3).trimStart(), 10);
            } else if (line.startsWith("event:")) {
                name = line.slice(6).trimStart();
            } else if (line.startsWith("data:")) {
                data = JSON.parse(line.slice(5).trimStart()) as unknown;
            }
        }

        return {
            id,
            name,
            data,
            comment,
            raw
        };
    }
}
