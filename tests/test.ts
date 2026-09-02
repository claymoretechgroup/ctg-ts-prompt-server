// Dependencies:
import CTGTest, {
    CTGTestConsoleFormatter,
    CTGTestResult
} from "ctg-js-test";                              // Pipeline runner, console formatter, and status constants
import config from "./conformance/config.ts";       // §11 config conformance suite
import db from "./conformance/db.ts";               // §11 database conformance suite
import errorClass from "./conformance/errorClass.ts"; // §11 error class conformance suite
import events from "./conformance/events.ts";       // §11 runner event mapping suite
import lifecycle from "./conformance/lifecycle.ts"; // §11 server lifecycle suite
import longpoll from "./conformance/longpoll.ts";   // §11 long-poll suite
import purge from "./conformance/purge.ts";         // §11 purge suite
import queue from "./conformance/queue.ts";         // §11 queue and outcome suite
import recovery from "./conformance/recovery.ts";   // §11 recovery suite
import response from "./conformance/response.ts";   // §11 response accumulation suite
import routes from "./conformance/routes.ts";       // §11 HTTP route suite
import sse from "./conformance/sse.ts";             // §11 SSE projection suite
import subscribers from "./conformance/subscribers.ts"; // §11 subscriber suite

const state = await CTGTest.init("ctg-ts-prompt-server hermetic conformance")
    .chain("error class", errorClass)
    .chain("config", config)
    .chain("lifecycle", lifecycle)
    .chain("db", db)
    .chain("queue", queue)
    .chain("events", events)
    .chain("response", response)
    .chain("subscribers", subscribers)
    .chain("recovery", recovery)
    .chain("purge", purge)
    .chain("routes", routes)
    .chain("longpoll", longpoll)
    .chain("sse", sse)
    .start(undefined, {
        haltOnFailure: false,
        timeout: 3000
    });

console.log(CTGTestConsoleFormatter.format(state));

if (state.status === CTGTestResult.STATUS.FAIL || state.status === CTGTestResult.STATUS.ERROR) {
    throw new Error("ctg-ts-prompt-server conformance suite failed.");
}
