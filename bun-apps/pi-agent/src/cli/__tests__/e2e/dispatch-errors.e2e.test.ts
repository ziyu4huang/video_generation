/**
 * e2e: dispatch error paths — the reserved namespaces (`pipeline` / `workflow`)
 * fail fast with a clean usage message + exit 1, before any model resolution.
 *
 * Deliberately does NOT test a bare unknown command: that falls through to
 * passthrough and would need a model (risk of hang) — see _helpers.ts NOTE.
 */
import { describe, expect, test } from "bun:test";
import { runCli } from "./_helpers.ts";

const NO_STACK = /\n\s+at\s\S/;

describe("dispatch errors — pipeline namespace", () => {
	test("pipeline bogus → Unknown pipeline, exit 1", () => {
		const r = runCli(["pipeline", "bogus"]);
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("Unknown pipeline: bogus");
		expect(r.stderr).toContain("pdf-to-vault"); // lists available
		expect(r.stderr).not.toMatch(NO_STACK);
	});

	test("pipeline (no name) → usage, exit 1", () => {
		const r = runCli(["pipeline"]);
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("Usage: pipeline");
		expect(r.stderr).not.toMatch(NO_STACK);
	});
});

describe("dispatch errors — workflow namespace", () => {
	test("workflow bogus → Unknown workflow sub-command, exit 1", () => {
		const r = runCli(["workflow", "bogus"]);
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("Unknown workflow sub-command: bogus");
		expect(r.stderr).not.toMatch(NO_STACK);
	});

	test("workflow (no sub) → usage, exit 1", () => {
		const r = runCli(["workflow"]);
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("Usage: workflow");
		expect(r.stderr).not.toMatch(NO_STACK);
	});
});
