// realizes: docs/specs/00-shared-types.md > PRED-01..PRED-06, TEST-01..TEST-02

// Dependencies:
import CTGTest, { CTGTestPredicates as P } from "ctg-js-test";     // Pipeline API and predicate builders
import {
    isCTGPromptServerErrorResponse,
    isCTGPromptServerResponse,
    isNonEmptyString
} from "../../src/index.ts";                                       // Shared type predicates, via the public surface

// Type dependencies:
import type { TestFile } from "../run.ts";                        // Manifest contract consumed by the runner

/**
 *
 * Type Declarations
 *
 */

// TYPE :: {label:STRING, input:UNKNOWN}
// A predicate observation for one hand-built input.
interface PredicateInput {
    label: string;                                                 // Short name for failure snapshots.
    input: unknown;                                                // Hand-built value supplied to the predicate.
}

/**
 *
 * Constants
 *
 */

const OBJECT_WITH_INHERITED_RESPONSE = Object.create({
    success: true,
    result: 1
}) as unknown; // Response fields inherited through the prototype chain.
const OBJECT_WITH_INHERITED_ERROR_RESPONSE = Object.create({
    success: false,
    result: { code: 1, message: "x" }
}) as unknown; // Error response fields inherited through the prototype chain.
const ARRAY_WITH_RESPONSE_FIELDS = Object.assign([], {
    success: true,
    result: 1
}) as unknown; // Array carrying a valid response envelope.
const ARRAY_WITH_ERROR_RESPONSE_FIELDS = Object.assign([], {
    success: false,
    result: { code: 1, message: "x" }
}) as unknown; // Array carrying a valid error response envelope.
const ARRAY_WITH_ERROR_RESULT_FIELDS = Object.assign([], {
    code: 1,
    message: "x"
}) as unknown; // Array carrying valid error result fields.
const FUNCTION_WITH_RESPONSE_FIELDS = Object.assign(() => undefined, {
    success: true,
    result: 1
}) as unknown; // Function carrying response fields, rejected because typeof is "function".

const testFile: TestFile = {
    label: "shared types",
    cases: [
        {
            label: "isNonEmptyString returns true for a string whose length is at least 1, including whitespace (PRED-01, TEST-01)",
            run: () => CTGTest.init<PredicateInput[]>("isNonEmptyString accepts non-empty strings")
                .assert("non-empty strings are accepted", (state) => state.subject.map((c) => ({
                    input: c.label,
                    accepted: isNonEmptyString(c.input)
                })), P.equals([
                    { input: "letter", accepted: true },
                    { input: "whitespace", accepted: true }
                ]))
                .start([
                    { label: "letter", input: "a" },
                    { label: "whitespace", input: " " }
                ])
        },
        {
            label: "isNonEmptyString returns false for an empty string and for every non-string (PRED-02, TEST-01)",
            run: () => CTGTest.init<PredicateInput[]>("isNonEmptyString rejects empty and non-strings")
                .assert("empty and non-string values are rejected", (state) => state.subject.map((c) => ({
                    input: c.label,
                    accepted: isNonEmptyString(c.input)
                })), P.equals([
                    { input: "empty string", accepted: false },
                    { input: "null", accepted: false },
                    { input: "undefined", accepted: false },
                    { input: "number", accepted: false },
                    { input: "boolean", accepted: false },
                    { input: "object", accepted: false },
                    { input: "array", accepted: false },
                    { input: "String object", accepted: false }
                ]))
                .start([
                    { label: "empty string", input: "" },
                    { label: "null", input: null },
                    { label: "undefined", input: undefined },
                    { label: "number", input: 1 },
                    { label: "boolean", input: true },
                    { label: "object", input: {} },
                    { label: "array", input: [] },
                    { label: "String object", input: new String("x") }
                ])
        },
        {
            label: "isCTGPromptServerResponse returns true when value is an object with boolean success and result in value (PRED-03, TEST-02)",
            run: () => CTGTest.init<PredicateInput[]>("isCTGPromptServerResponse accepts response envelopes")
                .assert("response envelopes are accepted", (state) => state.subject.map((c) => ({
                    input: c.label,
                    accepted: isCTGPromptServerResponse(c.input)
                })), P.equals([
                    { input: "plain response", accepted: true },
                    { input: "undefined result", accepted: true },
                    { input: "inherited response", accepted: true },
                    { input: "array response", accepted: true }
                ]))
                .start([
                    { label: "plain response", input: { success: true, result: 1 } },
                    { label: "undefined result", input: { success: true, result: undefined } },
                    { label: "inherited response", input: OBJECT_WITH_INHERITED_RESPONSE },
                    { label: "array response", input: ARRAY_WITH_RESPONSE_FIELDS }
                ])
        },
        {
            label: "isCTGPromptServerResponse returns false for null, undefined, a non-object, missing success, non-boolean success, and missing result (PRED-04, TEST-02)",
            run: () => CTGTest.init<PredicateInput[]>("isCTGPromptServerResponse rejects non-envelopes")
                .assert("non-envelope values are rejected", (state) => state.subject.map((c) => ({
                    input: c.label,
                    accepted: isCTGPromptServerResponse(c.input)
                })), P.equals([
                    { input: "null", accepted: false },
                    { input: "undefined", accepted: false },
                    { input: "string", accepted: false },
                    { input: "number", accepted: false },
                    { input: "boolean", accepted: false },
                    { input: "function", accepted: false },
                    { input: "missing success", accepted: false },
                    { input: "non-boolean success", accepted: false },
                    { input: "missing result", accepted: false }
                ]))
                .start([
                    { label: "null", input: null },
                    { label: "undefined", input: undefined },
                    { label: "string", input: "x" },
                    { label: "number", input: 1 },
                    { label: "boolean", input: true },
                    { label: "function", input: FUNCTION_WITH_RESPONSE_FIELDS },
                    { label: "missing success", input: { result: 1 } },
                    { label: "non-boolean success", input: { success: "true", result: 1 } },
                    { label: "missing result", input: { success: true } }
                ])
        },
        {
            label: "isCTGPromptServerErrorResponse returns true when PRED-03 is true, success is false, and result has numeric code and string message (PRED-05, TEST-02)",
            run: () => CTGTest.init<PredicateInput[]>("isCTGPromptServerErrorResponse accepts error envelopes")
                .assert("error response envelopes are accepted", (state) => state.subject.map((c) => ({
                    input: c.label,
                    accepted: isCTGPromptServerErrorResponse(c.input)
                })), P.equals([
                    { input: "plain error response", accepted: true },
                    { input: "inherited error response", accepted: true },
                    { input: "array error response", accepted: true },
                    { input: "array error result", accepted: true }
                ]))
                .start([
                    { label: "plain error response", input: { success: false, result: { code: 1, message: "x" } } },
                    { label: "inherited error response", input: OBJECT_WITH_INHERITED_ERROR_RESPONSE },
                    { label: "array error response", input: ARRAY_WITH_ERROR_RESPONSE_FIELDS },
                    { label: "array error result", input: { success: false, result: ARRAY_WITH_ERROR_RESULT_FIELDS } }
                ])
        },
        {
            label: "isCTGPromptServerErrorResponse returns false for every value PRED-04 rejects, success true, null result, non-object result, invalid code, or invalid message (PRED-06, TEST-02)",
            run: () => CTGTest.init<PredicateInput[]>("isCTGPromptServerErrorResponse rejects non-error envelopes")
                .assert("non-error envelopes are rejected", (state) => state.subject.map((c) => ({
                    input: c.label,
                    accepted: isCTGPromptServerErrorResponse(c.input)
                })), P.equals([
                    { input: "null", accepted: false },
                    { input: "undefined", accepted: false },
                    { input: "string", accepted: false },
                    { input: "number", accepted: false },
                    { input: "boolean", accepted: false },
                    { input: "function", accepted: false },
                    { input: "missing success", accepted: false },
                    { input: "non-boolean success", accepted: false },
                    { input: "missing result", accepted: false },
                    { input: "success true", accepted: false },
                    { input: "null result", accepted: false },
                    { input: "non-object result", accepted: false },
                    { input: "non-number code", accepted: false },
                    { input: "non-string message", accepted: false }
                ]))
                .start([
                    { label: "null", input: null },
                    { label: "undefined", input: undefined },
                    { label: "string", input: "x" },
                    { label: "number", input: 1 },
                    { label: "boolean", input: true },
                    { label: "function", input: FUNCTION_WITH_RESPONSE_FIELDS },
                    { label: "missing success", input: { result: { code: 1, message: "x" } } },
                    { label: "non-boolean success", input: { success: "false", result: { code: 1, message: "x" } } },
                    { label: "missing result", input: { success: false } },
                    { label: "success true", input: { success: true, result: { code: 1, message: "x" } } },
                    { label: "null result", input: { success: false, result: null } },
                    { label: "non-object result", input: { success: false, result: "x" } },
                    { label: "non-number code", input: { success: false, result: { code: "1", message: "x" } } },
                    { label: "non-string message", input: { success: false, result: { code: 1, message: 1 } } }
                ])
        }
    ]
};

export default testFile;
