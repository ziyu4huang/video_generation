/**
 * Parse-level regression test for the `news` subcommand's flags.
 *
 * The e2e task-builder tests in s2-agent-ext-research-tool feed hand-built
 * flag objects, so they can't catch a flag missing from flag-spec.ts —
 * parsePiArgs silently drops unknown flags WITH their values, which made
 * `news --date 2026-09-01` scaffold the CURRENT week (backfill silently
 * wrong). These tests pin the spec wiring itself.
 */
import { describe, test, expect } from "bun:test";
import { parsePiArgs } from "../args.ts";

describe("news flags (parse-level)", () => {
	test("parses --date as a value flag", () => {
		const p = parsePiArgs(["news", "--date", "2026-09-01"]);
		expect(p.date).toBe("2026-09-01");
	});

	test("parses --overwrite as a boolean", () => {
		const p = parsePiArgs(["news", "--overwrite"]);
		expect(p.overwrite).toBe(true);
	});

	test("--overwrite absent → not set", () => {
		const p = parsePiArgs(["news"]);
		expect(p.overwrite).toBeUndefined();
		expect(p.date).toBeUndefined();
	});

	test("combined with shared flags", () => {
		const p = parsePiArgs(["news", "--date", "2026-09-01", "--output-path", "/tmp/issue.md", "--dry-run"]);
		expect(p.date).toBe("2026-09-01");
		expect(p.outputPath).toBe("/tmp/issue.md");
		expect(p.dryRun).toBe(true);
	});
});
