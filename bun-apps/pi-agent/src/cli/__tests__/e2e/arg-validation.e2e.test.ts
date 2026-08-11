/**
 * e2e: argument-validation error paths. These throw synchronously in parsePiArgs
 * (numeric flags) or fail-fast in the command setup (before any model), so they
 * are fully offline. The cross-cutting contract: exit 1 + a clean human message
 * + NO uncaught-exception stack trace (runCli()'s catch prints `error: <msg>`).
 */
import { describe, expect, test } from "bun:test";
import { runCli } from "./_helpers.ts";

const NO_STACK = /\n\s+at\s\S/;

describe("arg validation — --dpi (1–4096 positive integer)", () => {
	for (const bad of ["abc", "-1", "0", "99999", "1.5"]) {
		test(`--dpi ${bad} → Invalid --dpi, exit 1, no stack`, () => {
			const r = runCli(["file2md", "x.pdf", "--dpi", bad]);
			expect(r.exitCode).toBe(1);
			expect(r.stderr).toContain("Invalid --dpi");
			expect(r.stderr).not.toMatch(NO_STACK);
		});
	}
});

describe("arg validation — numeric flags fail-fast", () => {
	test("--max-rounds abc → Invalid --max-rounds", () => {
		const r = runCli(["kcard-loop", "--max-rounds", "abc", "x.jsonl"]);
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("Invalid --max-rounds");
		expect(r.stderr).not.toMatch(NO_STACK);
	});

	test("negative --consecutive-empty → rejected", () => {
		const r = runCli(["kcard-loop", "--consecutive-empty", "-1", "x.jsonl"]);
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toMatch(/consecutive-empty|Invalid/);
		expect(r.stderr).not.toMatch(NO_STACK);
	});

	test("--top-k abc → Invalid --top-k (zk-ask numeric)", () => {
		const r = runCli(["zk-ask", "--top-k", "abc", "q?"]);
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("Invalid --top-k");
		expect(r.stderr).not.toMatch(NO_STACK);
	});
});

describe("arg validation — command-level fail-fast", () => {
	test("kcard-loop --source bogus → Unknown --source (before file check)", () => {
		const r = runCli(["kcard-loop", "--source", "bogus", "x.jsonl"]);
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("Unknown --source");
		expect(r.stderr).not.toMatch(NO_STACK);
	});
});
