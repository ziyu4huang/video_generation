/**
 * A3.5 — subagent retry-once (transient-error detection).
 *   bun test extensions/__tests__/subagentRetry.test.mjs
 */
import { describe, it, expect } from "bun:test";
import { isTransientError } from "../obsidian.ts";

describe("isTransientError (A3.5)", () => {
	it("exit 0 is never transient", () => {
		expect(isTransientError("anything", 0)).toBe(false);
	});

	it("empty stderr is not transient", () => {
		expect(isTransientError("", 1)).toBe(false);
	});

	it("network errors are transient", () => {
		expect(isTransientError("Error: ETIMEDOUT", 1)).toBe(true);
		expect(isTransientError("fetch failed: ECONNRESET", 1)).toBe(true);
		expect(isTransientError("socket hang up", 1)).toBe(true);
	});

	it("rate-limit / 429 / 503 are transient", () => {
		expect(isTransientError("HTTP 429 Too Many Requests", 1)).toBe(true);
		expect(isTransientError("503 Service Unavailable", 1)).toBe(true);
		expect(isTransientError("rate limit exceeded", 1)).toBe(true);
	});

	it("logic/tool errors are NOT transient", () => {
		expect(isTransientError("TypeError: cannot read property", 1)).toBe(false);
		expect(isTransientError("Error: note not found", 1)).toBe(false);
		expect(isTransientError("SyntaxError: unexpected token", 1)).toBe(false);
	});

	it("case-insensitive matching", () => {
		expect(isTransientError("NETWORK ERROR", 1)).toBe(true);
		expect(isTransientError("Timeout Occurred", 1)).toBe(true);
	});
});
