// realizes: docs/specs/00-shared-types.md > PRED-01..PRED-06, TEST-01..TEST-02

// Dependencies:
import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";    // Pipeline API and predicate builders
// @ts-ignore TS2307: source under test is intentionally absent until implementation.
import { isCTGPromptServerErrorResponse, isCTGPromptServerResponse, isNonEmptyString } from "../../src/index.ts"; // Shared type predicates, via the public surface

// Type dependencies:
import type { TestFile } from "../run.ts";                        // Manifest contract consumed by the runner

/**
 *
 * Type Declarations
 *
 */

// TYPE :: {input:UNKNOWN}
// A predicate observation for one hand-built input.
interface PredicateInput {
    input: unknown;
}

/**
 *
 * Constants
 *
 */

const OBJECT_WITH_INHERITED_RESPONSE = Object.create({ success: true, result: 1 }) as unknown;
const ARRAY_WITH_RESPONSE_FIELDS = Object.assign([], { success: true, result: 1 }) as unknown;
const ARRAY_WITH_ERROR_RESULT = Object.assign([], { code: 1, message: "x" }) as unknown;

const testFile: TestFile = {
    label: "shared types",
    cases: [
        {
            label: "isNonEmptyString returns true for a string whose length is at least 1, including whitespace (PRED-01, TEST-01)",
            run: () => CTGTest.init<PredicateInput[]>("isNonEmptyString accepts non-empty strings")
                .assert("non-empty strings are accepted", (state) => state.subject.map((c) => isNonEmptyString(c.input)), P.equals([true, true]))
                .start([
                    { input: "a" },
                    { input: " " }
                ])
        },
        {
            label: "isNonEmptyString returns false for an empty string and for every non-string (PRED-02, TEST-01)",
            run: () => CTGTest.init<PredicateInput[]>("isNonEmptyString rejects empty and non-strings")
                .assert("empty and non-string values are rejected", (state) => state.subject.map((c) => isNonEmptyString(c.input)), P.equals([
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false
                ]))
                .start([
                    { input: "" },
                    { input: null },
                    { input: undefined },
                    { input: 1 },
                    { input: true },
                    { input: {} },
                    { input: [] },
                    { input: new String("x") }
                ])
        },
        {
            label: "isCTGPromptServerResponse returns true when value is a non-null non-array object with boolean success and result in value (PRED-03, TEST-02)",
            run: () => CTGTest.init<PredicateInput[]>("isCTGPromptServerResponse accepts response envelopes")
                .assert("response envelopes are accepted", (state) => state.subject.map((c) => ({
                    accepted: isCTGPromptServerResponse(c.input)
                })), P.equals([
                    { accepted: true },
                    { accepted: true },
                    { accepted: true }
                ]))
                .start([
                    { input: { success: true, result: 1 } },
                    { input: { success: true, result: undefined } },
                    { input: OBJECT_WITH_INHERITED_RESPONSE }
                ])
        },
        {
            label: "isCTGPromptServerResponse returns false for null, undefined, non-objects, arrays, missing success, non-boolean success, and missing result (PRED-04, TEST-02)",
            run: () => CTGTest.init<PredicateInput[]>("isCTGPromptServerResponse rejects non-envelopes")
                .assert("non-envelope values are rejected", (state) => state.subject.map((c) => ({
                    accepted: isCTGPromptServerResponse(c.input)
                })), P.equals([
                    { accepted: false },
                    { accepted: false },
                    { accepted: false },
                    { accepted: false },
                    { accepted: false },
                    { accepted: false },
                    { accepted: false },
                    { accepted: false },
                    { accepted: false }
                ]))
                .start([
                    { input: null },
                    { input: undefined },
                    { input: "x" },
                    { input: 1 },
                    { input: true },
                    { input: ARRAY_WITH_RESPONSE_FIELDS },
                    { input: { result: 1 } },
                    { input: { success: "true", result: 1 } },
                    { input: { success: true } }
                ])
        },
        {
            label: "isCTGPromptServerErrorResponse returns true when the response is false and result has numeric code and string message (PRED-05, TEST-02)",
            run: () => CTGTest.init("isCTGPromptServerErrorResponse accepts error envelopes")
                .assert("error response envelope is accepted", () => isCTGPromptServerErrorResponse({
                    success: false,
                    result: { code: 1, message: "x" }
                }), P.equals(true))
                .start(undefined)
        },
        {
            label: "isCTGPromptServerErrorResponse returns false for response rejects, success true, null result, array result, invalid code, or invalid message (PRED-06, TEST-02)",
            run: () => CTGTest.init<PredicateInput[]>("isCTGPromptServerErrorResponse rejects non-error envelopes")
                .assert("non-error envelopes are rejected", (state) => state.subject.map((c) => ({
                    accepted: isCTGPromptServerErrorResponse(c.input)
                })), P.equals([
                    { accepted: false },
                    { accepted: false },
                    { accepted: false },
                    { accepted: false },
                    { accepted: false },
                    { accepted: false },
                    { accepted: false },
                    { accepted: false },
                    { accepted: false },
                    { accepted: false },
                    { accepted: false },
                    { accepted: false },
                    { accepted: false },
                    { accepted: false }
                ]))
                .start([
                    { input: null },
                    { input: undefined },
                    { input: "x" },
                    { input: 1 },
                    { input: true },
                    { input: ARRAY_WITH_RESPONSE_FIELDS },
                    { input: { result: { code: 1, message: "x" } } },
                    { input: { success: "false", result: { code: 1, message: "x" } } },
                    { input: { success: false } },
                    { input: { success: true, result: 1 } },
                    { input: { success: false, result: null } },
                    { input: { success: false, result: ARRAY_WITH_ERROR_RESULT } },
                    { input: { success: false, result: { code: "1", message: "x" } } },
                    { input: { success: false, result: { code: 1, message: 1 } } }
                ])
        }
    ]
};

export default testFile;
