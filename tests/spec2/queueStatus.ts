// Dependencies:
import CTGTest, { CTGTestPredicates as P } from "ctg-js-test"; // Pipeline test API and predicates
import {
    asQueueConstructor,
    loadPublicModule
} from "./helpers.ts";                                          // Dynamic public module helpers

const expectedStatus = {
    PENDING: 1,
    ACTIVE: 2,
    DONE: 3,
    ERROR: -1,
    CANCELLED: 5
};

export default CTGTest.init("spec2 CTGPromptServerQueue status")
    .assert("STATUS exposes the spec2 label-to-code registry", async () => {
        const mod = await loadPublicModule();
        const Queue = asQueueConstructor(mod.CTGPromptServerQueue);

        return Queue === null ? null : Queue.STATUS;
    }, P.equals(expectedStatus))
    .assert("statusOf resolves valid status labels and rejects invalid codes", async () => {
        const mod = await loadPublicModule();
        const Queue = asQueueConstructor(mod.CTGPromptServerQueue);

        if (Queue === null) {
            return {
                available: false
            };
        }

        return {
            available: true,
            pending: Queue.statusOf(Queue.STATUS.PENDING),
            active: Queue.statusOf(Queue.STATUS.ACTIVE),
            done: Queue.statusOf(Queue.STATUS.DONE),
            error: Queue.statusOf(Queue.STATUS.ERROR),
            cancelled: Queue.statusOf(Queue.STATUS.CANCELLED),
            invalid: Queue.statusOf(999)
        };
    }, P.equals({
        available: true,
        pending: "PENDING",
        active: "ACTIVE",
        done: "DONE",
        error: "ERROR",
        cancelled: "CANCELLED",
        invalid: "ERROR"
    }));
