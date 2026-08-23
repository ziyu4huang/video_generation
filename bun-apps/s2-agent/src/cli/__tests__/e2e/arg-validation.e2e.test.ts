/**
 * e2e: argument-validation error paths. These throw synchronously in parsePiArgs
 * (numeric flags) or fail-fast in the command setup (before any model), so they
 * are fully offline. The cross-cutting contract: exit 1 + a clean human message
 * + NO uncaught-exception stack trace (runCli()'s catch prints `error: <msg>`).
 */
import { describe, expect, test } from "bun:test";
import { runCli } from "./_helpers.ts";

const NO_STACK = /\n\s+at\s\S/;

describe("arg validation — --scale (0.1–16 positive number)", () => {
	for (const bad of ["abc", "-1", "0", "17", "99999"]) {
		test(`--scale ${bad} → Invalid --scale, exit 1, no stack`, () => {
			const r = runCli(["file2md", "x.pdf", "--scale", bad]);
			expect(r.exitCode).toBe(1);
			expect(r.stderr).toContain("Invalid --scale");
			expect(r.stderr).not.toMatch(NO_STACK);
		});
	}
});

describe("arg validation — numeric flags fail-fast", () => {
	test("--top-k abc → Invalid --top-k (zk-ask numeric)", () => {
		const r = runCli(["zk-ask", "--top-k", "abc", "q?"]);
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("Invalid --top-k");
		expect(r.stderr).not.toMatch(NO_STACK);
	});
});
