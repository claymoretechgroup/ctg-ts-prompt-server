// Dependencies:
import CTGTest, {
    CTGTestConsoleFormatter,
    CTGTestResult
} from "ctg-js-test";                        // Pipeline runner, console formatter, and status constants
import errorClasses from "./errorClasses.ts"; // Spec2 server error class tests
import publicSurface from "./publicSurface.ts"; // Spec2 public export tests
import queueStatus from "./queueStatus.ts";   // Spec2 queue status registry tests

const state = await CTGTest.init("ctg-ts-prompt-server spec2 conformance")
    .chain("public surface", publicSurface)
    .chain("error classes", errorClasses)
    .chain("queue status", queueStatus)
    .start(undefined, {
        haltOnFailure: false,
        timeout: 3000
    });

console.log(CTGTestConsoleFormatter.format(state));

if (state.status === CTGTestResult.STATUS.FAIL || state.status === CTGTestResult.STATUS.ERROR) {
    throw new Error("ctg-ts-prompt-server spec2 conformance suite failed.");
}
