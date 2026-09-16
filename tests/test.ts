// Dependencies:
import CTGTest, {
    CTGTestConsoleFormatter,
    CTGTestResult
} from "ctg-js-test";                          // Pipeline runner, console formatter, and status constants
import db from "./db.ts";                       // Database spec tests
import errorClasses from "./errorClasses.ts";   // Server error class spec tests
import publicSurface from "./publicSurface.ts"; // Public export spec tests
import queueStatus from "./queueStatus.ts";     // Queue status registry spec tests
import routes from "./routes.ts";               // HTTP route spec tests

const state = await CTGTest.init("ctg-ts-prompt-server spec")
    .chain("public surface", publicSurface)
    .chain("error classes", errorClasses)
    .chain("db", db)
    .chain("queue status", queueStatus)
    .chain("routes", routes)
    .start(undefined, {
        haltOnFailure: false,
        timeout: 3000
    });

console.log(CTGTestConsoleFormatter.format(state));

if (state.status === CTGTestResult.STATUS.FAIL || state.status === CTGTestResult.STATUS.ERROR) {
    throw new Error("ctg-ts-prompt-server spec test suite failed.");
}
