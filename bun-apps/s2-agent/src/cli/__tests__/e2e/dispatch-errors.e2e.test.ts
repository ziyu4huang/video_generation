/**
 * e2e: dispatch error paths — the reserved `pipeline` namespace fails fast
 * with a clean usage message + exit 1, before any model resolution.
 * (The `workflow` namespace was removed 2026-08-25 — ultracode TRIM,
 * .planning/2026-08-25-s2-agent-simplify-round2/ ticket 02; `workflow` as a
 * first token now falls through to passthrough like any unknown word.)
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
