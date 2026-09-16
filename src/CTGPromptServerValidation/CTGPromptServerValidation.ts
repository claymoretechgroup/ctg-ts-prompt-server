// Type dependencies:
import type {
    RunnerKind,        // Supported runner kind literal
    StreamMode         // Supported stream mode literal
} from "../types.js";
import type { CTGPromptServerValidationLiterals } from "./types.js"; // Accepted literal sets

/**
 *
 * Class
 *
 */

// Static validation helpers for server-side configuration and input shaping.
export default class CTGPromptServerValidation {

    /* Static Fields */
    static readonly LITERALS: CTGPromptServerValidationLiterals = Object.freeze({
        runnerKind: Object.freeze(["claude", "codex"] as const),
        streamMode: Object.freeze(["raw", "events"] as const)
    });

    // CONSTRUCTOR :: VOID -> this
    // Prevents instantiation of this static-only class.
    private constructor() {}

    /**
     *
     * Static Methods
     *
     */

    // METHOD :: UNKNOWN -> BOOLEAN
    // Narrows object values.
    static isObject(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null;
    }

    // METHOD :: UNKNOWN, STRING -> STRING
    // Validates non-empty strings.
    static nonEmptyString(value: unknown, label: string): string {
        if (typeof value !== "string" || value.trim() === "") {
            throw new Error(`${label} must be a non-empty string.`);
        }

        return value;
    }

    // METHOD :: UNKNOWN, STRING -> [STRING]
    // Validates an array of strings.
    static stringArray(value: unknown, label: string): string[] {
        if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
            throw new Error(`${label} must be an array of strings.`);
        }

        return [...value] as string[];
    }

    // METHOD :: UNKNOWN, STRING -> nodeProcessEnv
    // Validates a plain object for child env replacement.
    static objectEnv(value: unknown, label: string): NodeJS.ProcessEnv {
        if (!CTGPromptServerValidation.isObject(value) || Array.isArray(value)) {
            throw new Error(`${label} must be an object.`);
        }

        return value as NodeJS.ProcessEnv;
    }

    // METHOD :: UNKNOWN, STRING -> BOOLEAN?
    // Validates an optional boolean.
    static optionalBoolean(value: unknown, label: string): boolean | undefined {
        if (value === undefined) {
            return undefined;
        }
        if (typeof value !== "boolean") {
            throw new Error(`${label} must be a boolean.`);
        }

        return value;
    }

    // METHOD :: UNKNOWN, STRING, NUMBER, NUMBER? -> NUMBER?
    // Validates an optional integer range.
    static optionalInteger(value: unknown, label: string, min: number, max: number | undefined): number | undefined {
        if (value === undefined) {
            return undefined;
        }

        return CTGPromptServerValidation.integer(value, label, min, max);
    }

    // METHOD :: UNKNOWN, STRING, NUMBER, NUMBER? -> NUMBER
    // Validates an integer range.
    static integer(value: unknown, label: string, min: number, max: number | undefined): number {
        if (!Number.isInteger(value) || typeof value !== "number" || value < min || (max !== undefined && value > max)) {
            throw new Error(`${label} is outside its valid range.`);
        }

        return value;
    }

    // METHOD :: UNKNOWN, STRING -> runnerKind
    // Validates a configured runner kind.
    static runnerKind(value: unknown, label: string): RunnerKind {
        if (value === "claude" || value === "codex") {
            return value;
        }

        throw new Error(`${label} must be claude or codex.`);
    }

    // METHOD :: UNKNOWN, STRING -> streamMode?
    // Validates an optional stream mode.
    static optionalStreamMode(value: unknown, label: string): StreamMode | undefined {
        if (value === undefined) {
            return undefined;
        }
        if (value === "raw" || value === "events") {
            return value;
        }

        throw new Error(`${label} must be raw or events.`);
    }
}
