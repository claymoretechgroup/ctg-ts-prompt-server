// Type dependencies:
import type {
    CTGPromptEventSink,                 // Writable subscriber sink
    CTGPromptSubscription,              // Public subscription handle
    EventRecord                         // Event published to sinks
} from "../types.js";

/**
 *
 * Class
 *
 */

// In-memory fan-out registry for prompt event sinks.
export default class CTGPromptSubscribers {

    /* Instance Fields */
    private readonly _subscriptions: Map<number, Set<PromptSubscription>>; // Prompt id to open subscriptions

    // CONSTRUCTOR :: VOID -> this
    // Creates an empty subscriber registry.
    private constructor() {
        this._subscriptions = new Map<number, Set<PromptSubscription>>();
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: NUMBER, ctgPromptEventSink -> ctgPromptSubscription
    // Registers a sink for one prompt.
    add(id: number, sink: CTGPromptEventSink): CTGPromptSubscription {
        const subscription = new PromptSubscription(this, id, sink);
        const set = this._subscriptions.get(id) ?? new Set<PromptSubscription>();

        set.add(subscription);
        this._subscriptions.set(id, set);

        return subscription;
    }

    // METHOD :: NUMBER, eventRecord -> VOID
    // Publishes an event to every sink for the prompt.
    publish(id: number, event: EventRecord): void {
        const set = this._subscriptions.get(id);

        if (set === undefined) {
            return;
        }

        for (const subscription of [...set]) {
            subscription.writeEvent(event);
        }
    }

    // METHOD :: NUMBER -> VOID
    // Ends every subscription for a prompt.
    closePrompt(id: number): void {
        const set = this._subscriptions.get(id);

        if (set === undefined) {
            return;
        }

        for (const subscription of [...set]) {
            subscription.end();
        }
    }

    // METHOD :: VOID -> VOID
    // Ends every open subscription.
    closeAll(): void {
        for (const set of [...this._subscriptions.values()]) {
            for (const subscription of [...set]) {
                subscription.end();
            }
        }
    }

    // METHOD :: NUMBER -> NUMBER
    // Counts open subscriptions for a prompt.
    count(id: number): number {
        return this._subscriptions.get(id)?.size ?? 0;
    }

    /**
     *
     * Private Methods
     *
     */

    // METHOD :: promptSubscription -> VOID
    // Removes one subscription from the registry.
    _remove(subscription: PromptSubscription): void {
        const set = this._subscriptions.get(subscription.id);

        if (set === undefined) {
            return;
        }

        set.delete(subscription);
        if (set.size === 0) {
            this._subscriptions.delete(subscription.id);
        }
    }

    /**
     *
     * Static Methods
     *
     */

    // Static Factory Method :: VOID -> ctgPromptSubscribers
    // Creates a subscriber registry.
    static init(): CTGPromptSubscribers {
        return new this();
    }
}

/**
 *
 * Class
 *
 */

// One prompt subscription with per-sink high-water mark.
class PromptSubscription implements CTGPromptSubscription {

    /* Instance Fields */
    readonly id: number;                                      // Prompt id this subscription follows
    private readonly _owner: CTGPromptSubscribers;            // Registry that owns this subscription
    private readonly _sink: CTGPromptEventSink;               // Writable sink
    private _closed: boolean;                                 // Whether the subscription is closed
    private _lastSequence: number;                            // Highest event sequence written to this sink

    // CONSTRUCTOR :: ctgPromptSubscribers, NUMBER, ctgPromptEventSink -> this
    // Creates one live subscription.
    constructor(owner: CTGPromptSubscribers, id: number, sink: CTGPromptEventSink) {
        this._owner = owner;
        this.id = id;
        this._sink = sink;
        this._closed = false;
        this._lastSequence = 0;
    }

    /**
     *
     * Instance Methods
     *
     */

    // METHOD :: VOID -> VOID
    // Deregisters this subscription and ends the sink.
    close(): void {
        if (this._closed) {
            return;
        }

        this._closed = true;
        this._owner._remove(this);
        try {
            this._sink.end();
        } catch {
            return;
        }
    }

    // METHOD :: eventRecord -> VOID
    // Writes one SSE frame if it is newer than this sink's high-water mark.
    writeEvent(event: EventRecord): void {
        if (this._closed || event.sequence <= this._lastSequence) {
            return;
        }

        this._lastSequence = event.sequence;
        try {
            this._sink.write(CTGPromptSubscribersFrame.format(event));
            if (CTGPromptSubscribersFrame.isFinished(event.name)) {
                this.end();
            }
        } catch {
            this.end();
        }
    }

    // METHOD :: VOID -> VOID
    // Ends the sink and deregisters the subscription.
    end(): void {
        this.close();
    }
}

/**
 *
 * Class
 *
 */

// Formats event records as SSE frames.
class CTGPromptSubscribersFrame {

    /**
     *
     * Static Methods
     *
     */

    // METHOD :: eventRecord -> STRING
    // Returns the exact three-line SSE frame for an event.
    static format(event: EventRecord): string {
        return `id: ${event.sequence}\nevent: ${event.name}\ndata: ${JSON.stringify(event.payload)}\n\n`;
    }

    // METHOD :: STRING -> BOOLEAN
    // Returns whether an event name terminates a stream.
    static isFinished(name: string): boolean {
        return name === "done" || name === "error" || name === "cancelled";
    }
}
