// Dependencies:
import CTGTest, { CTGTestPredicates as P } from "ctg-js-test"; // Pipeline test API and predicates
import { CTGPromptServerError } from "../../src/index.ts";     // Public typed error class under conformance
import { captureThrown } from "./helpers.ts";                  // Captures constructor failures as assertion values

const requestRows = [
    ["INVALID_CONFIG", 1001, null],
    ["UNAUTHORIZED", 1002, 401],
    ["INVALID_CONTENT_TYPE", 1003, 415],
    ["INVALID_BODY", 1004, 400],
    ["INVALID_PROMPT", 1005, 400],
    ["INVALID_QUERY", 1006, 400],
    ["PROMPT_NOT_FOUND", 1007, 404],
    ["CANCEL_NOT_ALLOWED", 1008, 409],
    ["NOT_FOUND", 1009, 404],
    ["METHOD_NOT_ALLOWED", 1010, 405],
    ["STORE_FAILED", 1011, 500],
    ["INTERNAL_ERROR", 1012, 500]
] as const;

const outcomeRows = [
    ["RUNNER", 1013, null],
    ["SERVER", 1014, null],
    ["INTERRUPTED", 1015, null]
] as const;

export default CTGTest.init("error class")
    .assert("§9.3 TYPES is bidirectional and contiguous across request and outcome rows", () => {
        return [...requestRows, ...outcomeRows].every(([type, code]) => {
            return CTGPromptServerError.TYPES[type] === code
                && CTGPromptServerError.TYPES[String(code)] === type;
        });
    }, P.isTrue())
    .assert("§9.1/§9.2 statusOf matches HTTP status and null outcome status", () => {
        return [...requestRows, ...outcomeRows].every(([type, _code, status]) => {
            return CTGPromptServerError.statusOf(type) === status
                && new CTGPromptServerError(type, "message").status === status;
        });
    }, P.isTrue())
    .assert("§9.3 toResult exposes exactly type code message", () => {
        const error = new CTGPromptServerError("UNAUTHORIZED", "Invalid or missing credentials.", {
            secret: "not serialized"
        });
        const result = error.toResult();

        return {
            keys: Object.keys(result).sort(),
            result
        };
    }, P.equals({
        keys: ["code", "message", "type"],
        result: {
            type: "UNAUTHORIZED",
            code: 1002,
            message: "Invalid or missing credentials."
        }
    }))
    .assert("§9.3 data is shallow frozen and never aliases caller object", () => {
        const data: Record<string, unknown> = {
            id: 7
        };
        const error = new CTGPromptServerError("CANCEL_NOT_ALLOWED", "no", data);

        data.id = 8;

        return Object.isFrozen(error.data) && error.data.id === 7;
    }, P.isTrue())
    .assert("§9.3 unknown type throws a plain Error", () => {
        const caught = captureThrown(() => {
            new CTGPromptServerError("BOGUS", "bad");
        });

        return caught instanceof Error && !CTGPromptServerError.is(caught);
    }, P.isTrue());

