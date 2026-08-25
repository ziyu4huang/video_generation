/**
 * git.test.ts — locks gitLines' null-vs-empty contract (round-2 ticket 06,
 * added on ticket 05's review recommendation: pipeline-gate's gate rows
 * distinguish "git error" (null) from "no changed files" ([]), and nothing
 * else pins that seam).
 *
 * Real subprocesses, no mocks: `git` failing inside a real repo (bad flag),
 * succeeding with empty output (diff against self), and the `?? []` consumer
 * shape agent-trends uses.
 */
import { describe, expect, test } from "bun:test";
import { gitLines } from "./git.ts";

describe("gitLines — null-vs-empty contract", () => {
	test("non-zero exit → null (the failure signal pipeline-gate reports as \"git error\")", () => {
		const r = gitLines(process.cwd(), ["no-such-subcommand"]);
		expect(r).toBeNull();
	});

	test("successful spawn with EMPTY output → [] — never null (empty piped stdout is a truthy empty Buffer)", () => {
		// `git diff --name-only HEAD` against an unchanged HEAD: exit 0, no output.
		const r = gitLines(process.cwd(), ["diff", "--name-only", "HEAD", "HEAD"]);
		expect(r).not.toBeNull();
		expect(r).toEqual([]);
	});

	test("success with output → split lines, empties dropped (agent-trends' `?? []` shape)", () => {
		const r = gitLines(process.cwd(), ["diff", "--name-only", "HEAD~1", "HEAD"]);
		expect(Array.isArray(r)).toBe(true);
		// This repo's last commit always touches files, so a non-empty array is
		// the observable pin; the per-line non-empty check guards the filter.
		expect(r!.length).toBeGreaterThan(0);
		for (const line of r!) expect(line.length).toBeGreaterThan(0);
	});
});
