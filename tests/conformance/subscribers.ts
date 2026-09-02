// Dependencies:
import CTGTest, { CTGTestPredicates as P } from "ctg-js-test"; // Pipeline test API and predicates
import { CTGPromptSubscribers } from "../../src/index.ts";     // Public subscriber fan-out class under conformance
import {
    cleanupTempDatabases,                         // Removes suite temp DB directories
    startServerFixture,                           // Starts queue fixtures for replay/finish subscription cases
    tempDatabasePath                              // Creates hermetic database paths
} from "./helpers.ts";

// Type dependencies:
import type { CTGPromptEventSink, EventRecord } from "../../src/index.ts"; // Public event sink and durable event shapes

class CaptureSink implements CTGPromptEventSink {
    readonly chunks: string[] = [];
    private readonly throwOnWrite: boolean;
    ended = false;

    constructor(throwOnWrite = false) {
        this.throwOnWrite = throwOnWrite;
    }

    write(chunk: string): void {
        if (this.throwOnWrite) {
            throw new Error("sink failed");
        }
        this.chunks.push(chunk);
    }

    end(): void {
        this.ended = true;
    }
}

const event = (sequence: number, name = "stream"): EventRecord => ({
    promptId: 1,
    sequence,
    name,
    payload: {
        sequence
    },
    createdAt: Date.now()
});

export default CTGTest.init("subscribers")
    .assert("§7.3 subscribers fan out one committed event to every sink for a prompt", () => {
        const subscribers = CTGPromptSubscribers.init();
        const one = new CaptureSink();
        const two = new CaptureSink();

        subscribers.add(1, one);
        subscribers.add(1, two);
        subscribers.publish(1, event(1));

        return {
            count: subscribers.count(1),
            one: one.chunks.length,
            two: two.chunks.length
        };
    }, P.equals({
        count: 2,
        one: 1,
        two: 1
    }))
    .assert("§7.3 duplicate published sequence is written once per subscription", () => {
        const subscribers = CTGPromptSubscribers.init();
        const sink = new CaptureSink();

        subscribers.add(1, sink);
        subscribers.publish(1, event(2));
        subscribers.publish(1, event(2));
        subscribers.publish(1, event(3));

        return sink.chunks.length;
    }, P.equals(2))
    .assert("§7.3 sink write errors close and drop only the failing sink", () => {
        const subscribers = CTGPromptSubscribers.init();
        const throwing = new CaptureSink(true);
        const healthy = new CaptureSink();

        subscribers.add(1, throwing);
        subscribers.add(1, healthy);
        subscribers.publish(1, event(1));
        subscribers.publish(1, event(2));

        return {
            throwingEnded: throwing.ended,
            healthyChunks: healthy.chunks.length,
            count: subscribers.count(1)
        };
    }, P.equals({
        throwingEnded: true,
        healthyChunks: 2,
        count: 1
    }))
    .assert("§5.2/§7.3 closePrompt and closeAll end and deregister sinks idempotently", () => {
        const subscribers = CTGPromptSubscribers.init();
        const one = new CaptureSink();
        const two = new CaptureSink();

        const subscription = subscribers.add(1, one);

        subscribers.add(2, two);
        subscription.close();
        subscription.close();
        subscribers.closePrompt(2);
        subscribers.closeAll();

        return {
            oneEnded: one.ended,
            twoEnded: two.ended,
            countOne: subscribers.count(1),
            countTwo: subscribers.count(2)
        };
    }, P.equals({
        oneEnded: true,
        twoEnded: true,
        countOne: 0,
        countTwo: 0
    }))
    .assert("§7.3 prompt already finished replays history then ends subscription", async () => {
        const fixture = await startServerFixture([{
            behavior: "resolve",
            expectedPrompt: "finished replay",
            events: [],
            result: "done"
        }], {
            database: tempDatabasePath("subscribers-finished")
        });
        const prompt = fixture.server.queue.submit("finished replay");

        await fixture.server.queue.drain();

        const sink = new CaptureSink();

        fixture.server.queue.subscribe(prompt.id, sink, 0);

        await fixture.server.close();

        return {
            ended: sink.ended,
            chunks: sink.chunks.length,
            rawShape: sink.chunks.every((chunk) => /^id: \d+\nevent: [a-z]+\ndata: .+\n\n$/.test(chunk))
        };
    }, P.equals({
        ended: true,
        chunks: 3,
        rawShape: true
    }))
    .assert("§11 cleanup temp databases", () => {
        cleanupTempDatabases();
        return true;
    }, P.isTrue());
