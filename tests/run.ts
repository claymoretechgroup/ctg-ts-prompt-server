// Dependencies:
import { readdirSync } from "node:fs";                            // Enumerates suite test files in stable order
import {
    CTGTestConsoleFormatter,                                      // Formats failed pipeline states for the console
    CTGTestResult,                                                // Status constants for the pass decision
} from "ctg-js-test";

// Type dependencies:
import type { CTGTestState } from "ctg-js-test";                  // State returned by each case pipeline

/**
 *
 * Type Declarations
 *
 */

// TYPE :: "spec"|"live"
// Suite names accepted on the command line; one folder under tests/ each.
type SuiteName = "spec" | "live";

// TYPE :: {label:STRING, run:VOID -> PROMISE(ctgTestState)}
// One test case: builds, starts and returns its own pipeline.
export interface TestCase {
    label: string;                                                // Case label, in the spec's words
    run: () => Promise<CTGTestState>;                             // Builds and runs the case pipeline
}

// TYPE :: {label:STRING, skip:STRING?, cases:[testCase]}
// Manifest exported by every test file.
export interface TestFile {
    label: string;                                                // Area label, matching the spec document
    skip?: string;                                                // Reason the whole file is skipped, when it is
    cases: TestCase[];                                            // Cases, run in order
}

// TYPE :: {files:NUMBER, cases:NUMBER, passed:NUMBER, failed:NUMBER, skipped:NUMBER}
// Aggregate counts printed at the end.
interface Tally {
    files: number;                                                // Test files discovered
    cases: number;                                                // Cases discovered, including skipped
    passed: number;                                               // Cases whose state passed
    failed: number;                                               // Cases that failed, threw, or could not be imported
    skipped: number;                                              // Cases in files that declared skip
}

/**
 *
 * Constants
 *
 */

const { STATUS } = CTGTestResult;
const TEST_ROOT = new URL("./", import.meta.url);                 // tests/ directory
const TEST_FILE_PATTERN = /\.test\.ts$/;                          // Suite file suffix
const VALID_SUITES = ["spec", "live"] as const;                   // Every folder that is a suite

/**
 *
 * Functions
 *
 */

// HELPER :: [STRING] -> [suiteName]?
// Parses the command line into suite names; null when any argument is not a suite.
const requestedSuites = (args: string[]): SuiteName[] | null => {
    const suites = args.filter((a): a is SuiteName => (VALID_SUITES as readonly string[]).includes(a));
    return suites.length === args.length && suites.length > 0 ? suites : null;
};

// HELPER :: suiteName -> [STRING]
// Lists a suite's test files in lexical order.
const testFilesFor = (suite: SuiteName): string[] =>
    readdirSync(new URL(`${suite}/`, TEST_ROOT))
        .filter((name) => TEST_FILE_PATTERN.test(name))
        .sort((a, b) => a.localeCompare(b));

// HELPER :: tally, suiteName, STRING -> PROMISE(VOID)
// Imports and runs one test file; an import failure counts as one failed case.
// NOTE: Import is inside the try so a file whose source does not exist yet is reported, not fatal.
const runTestFile = async (tally: Tally, suite: SuiteName, fileName: string): Promise<void> => {
    const filePath = `tests/${suite}/${fileName}`;
    let testFile: TestFile;

    tally.files++;

    try {
        testFile = ((await import(new URL(`${suite}/${fileName}`, TEST_ROOT).href)) as { default: TestFile }).default;
    } catch (error) {
        tally.cases++;
        tally.failed++;
        console.log(`FAIL ${filePath} :: could not load`);
        console.error(error);
        return;
    }

    tally.cases += testFile.cases.length;

    if (testFile.skip !== undefined) {
        tally.skipped += testFile.cases.length;
        console.log(`SKIP ${filePath} :: ${testFile.label} -- ${testFile.skip}`);
        return;
    }

    for (const testCase of testFile.cases) {
        const line = `${filePath} :: ${testFile.label} :: ${testCase.label}`;

        try {
            const state = await testCase.run();
            if (state.status === STATUS.PASS) {
                tally.passed++;
                console.log(`PASS ${line}`);
                continue;
            }
            tally.failed++;
            console.log(`FAIL ${line}`);
            console.log(CTGTestConsoleFormatter.format(state));
        } catch (error) {
            tally.failed++;
            console.log(`FAIL ${line}`);
            console.error(error);
        }
    }
};

// HELPER :: VOID -> PROMISE(VOID)
// Entry point: runs the requested suites and sets the exit code.
const main = async (): Promise<void> => {
    const suites = requestedSuites(process.argv.slice(2));
    if (suites === null) {
        console.error(`Usage: tsx tests/run.ts <${VALID_SUITES.join("|")}> ...`);
        process.exitCode = 1;
        return;
    }

    const tally: Tally = { files: 0, cases: 0, passed: 0, failed: 0, skipped: 0 };
    for (const suite of suites) {
        for (const fileName of testFilesFor(suite)) {
            await runTestFile(tally, suite, fileName);
        }
    }

    console.log(`TALLY files=${tally.files} cases=${tally.cases} passed=${tally.passed} failed=${tally.failed} skipped=${tally.skipped}`);
    process.exitCode = tally.failed === 0 ? 0 : 1;
};

await main();
