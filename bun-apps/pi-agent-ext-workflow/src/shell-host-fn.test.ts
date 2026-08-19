/**
 * Unit tests for shell.run host-fn.
 */

import { describe, expect, test } from "bun:test";
import { shellRunHostFn } from "./shell-host-fn.js";

describe("shell.run host-fn", () => {
	test("executes a simple command and returns exitCode/stdout/stderr", () => {
		const result = shellRunHostFn.fn({ cmd: ["/bin/echo", "hello world"] }, { cwd: "/", signal: new AbortController().signal, runId: "test" }) as {
			exitCode: number;
			stdout: string;
			stderr: string;
		};

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("hello world");
		expect(result.stderr).toBe("");
	});

	test("rejects non-array cmd", () => {
		expect(() =>
			shellRunHostFn.fn({ cmd: "not an array" }, { cwd: "/", signal: new AbortController().signal, runId: "test" }),
		).toThrow("cmd must be a non-empty array");
	});

	test("rejects empty array cmd", () => {
		expect(() =>
			shellRunHostFn.fn({ cmd: [] }, { cwd: "/", signal: new AbortController().signal, runId: "test" }),
		).toThrow("cmd must be a non-empty array");
	});

	test("rejects array with non-string elements", () => {
		expect(() =>
			shellRunHostFn.fn({ cmd: [123] }, { cwd: "/", signal: new AbortController().signal, runId: "test" }),
		).toThrow("cmd must be a non-empty array");
	});

	test("returns non-zero exitCode for failing command", () => {
		const result = shellRunHostFn.fn({ cmd: ["false"] }, { cwd: "/", signal: new AbortController().signal, runId: "test" }) as {
			exitCode: number;
			stdout: string;
			stderr: string;
		};

		expect(result.exitCode).not.toBe(0);
	});

	test("truncates output at 20k chars", () => {
		// Generate a large output by printing many lines
		const largeCmd = ["bun", "-e", "console.log('x'.repeat(25000))"];
		const result = shellRunHostFn.fn({ cmd: largeCmd }, { cwd: "/", signal: new AbortController().signal, runId: "test" }) as {
			exitCode: number;
			stdout: string;
			stderr: string;
		};

		// Should be truncated
		expect(result.stdout.length).toBeLessThan(25000);
		expect(result.stdout).toContain("[...truncated");
	});

	test("rejects missing args object", () => {
		expect(() =>
			shellRunHostFn.fn(null, { cwd: "/", signal: new AbortController().signal, runId: "test" }),
		).toThrow("requires args object");
	});
});
