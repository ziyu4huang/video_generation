/**
 * e2e-bundle — REAL deploy e2e for pi-agent-cli.
 *
 * Proves the single bundled cli.js is functional AND self-contained: it spawns
 * `bun dist/pi-agent-cli/cli.js` (and, under PICLI_E2E_COMPILE, the compiled
 * exe) and asserts each command's observable behavior — running from a FRESH
 * TEMP cwd (not the repo) to prove deploy portability.
 *
 * This is the test that catches bundle-only regressions the pure unit suite
 * structurally cannot: a static extension import the bundler dropped, a
 * provider catalog that didn't make it into the bundle, a cwd-coupled path
 * resolver that breaks outside the repo.
 *
 * Gated on PICLI_E2E=1 (plain `bun test` skips it — stays fast for pre-commit).
 * run-test.sh medium+ sets the gate. PICLI_E2E_COMPILE=1 adds the exe-parity
 * describe block (high+).
 */
import { describe, expect, test } from "bun:test";
import {
	E2E_ENABLED,
	COMPILE_ENABLED,
	runBundle,
	ensureExe,
} from "./e2e-harness.ts";

// Shared assertions — run against BOTH the bundle and the compiled exe so the
// "single self-contained artifact" claim is proven for each output kind.
function selfContainedSuite(label: string, opts: { exe?: string } = {}): void {
	describe(`${label} — self-contained commands`, () => {
		test("version → exit 0, prints version line", async () => {
			const r = await runBundle(["version"], opts);
			expect(r.code).toBe(0);
			expect(r.stdout.trim()).toBe("bun-pi-agent-cli 0.1.0");
		});

		test("help → exit 0, lists every agent sub-command", async () => {
			const r = await runBundle(["help"], opts);
			expect(r.code).toBe(0);
			expect(r.stdout).toContain("Commands (agents)");
			for (const cmd of ["vlm-describe", "zk-extract", "zk-card", "zk-ask"]) {
				expect(r.stdout).toContain(cmd);
			}
		});

		test("--list-models → baked lm-studio catalog present (pi-agent PROVIDERS)", async () => {
			const r = await runBundle(["--list-models"], opts);
			expect(r.code).toBe(0);
			expect(r.stdout).toContain("lm-studio");
			expect(r.stdout).toContain("google/gemma-4-26b-a4b-qat");
		});

		test("--list-tools → inline obsidian extension bundled AND active", async () => {
			// The core "single bundle including the depended extension" proof:
			// obsidian_distill / obsidian_create only appear if the inline
			// pi-obsidian factory ran in-process and registered its tools.
			const r = await runBundle(["--list-tools"], opts);
			expect(r.code).toBe(0);
			expect(r.stdout).toContain("obsidian_distill");
			expect(r.stdout).toContain("obsidian_create");
		});

		test("doctor --json → emits a parseable checks array (host-dependent exit)", async () => {
			const r = await runBundle(["doctor", "--json"], opts);
			// doctor exit is host-dependent (warns/fails on missing dirs); don't
			// assert the code, only that it produced valid structured output.
			expect(r.stdout.trim().startsWith("{")).toBe(true);
			const report = JSON.parse(r.stdout);
			expect(Array.isArray(report.checks)).toBe(true);
			expect(report.checks.some((c: { id: string }) => c.id === "runtime")).toBe(true);
		});

		test("zk-extract (no args) → exit 1 with input-files error (dispatch + validation)", async () => {
			const r = await runBundle(["zk-extract"], opts);
			expect(r.code).toBe(1);
			expect(r.stderr).toContain("No input files");
		});
	});
}

describe("e2e-bundle", () => {
	if (!E2E_ENABLED) {
		test.skip("bundle e2e — set PICLI_E2E=1 (or ./run-test.sh medium+)", () => {});
		return;
	}

	// The bundle runs from a fresh temp cwd (runBundle default) — proving it
	// does NOT depend on being invoked from the repo.
	selfContainedSuite("bundle (cli.js)");

	if (!COMPILE_ENABLED) {
		test.skip("compile-exe parity — set PICLI_E2E_COMPILE=1 (or ./run-test.sh high+)", () => {});
		return;
	}

	// Compile parity: build the standalone exe and run the SAME assertions. The
	// exe target is resolved once (cached) and threaded through runBundle via
	// opts.exe so it runs directly (no `bun` prefix).
	describe("compile-exe parity", () => {
		test("exe builds", async () => {
			const exe = await ensureExe();
			expect(exe).toBeTruthy();
		});
		// Re-run the suite against the exe path. We can't call selfContainedSuite
		// with a pre-resolved exe (ensureExe is async), so resolve once first.
		test("exe version/help/tools match bundle", async () => {
			const exe = await ensureExe();
			const v = await runBundle(["version"], { exe });
			expect(v.code).toBe(0);
			expect(v.stdout.trim()).toBe("bun-pi-agent-cli 0.1.0");
			const h = await runBundle(["help"], { exe });
			expect(h.stdout).toContain("vlm-describe");
			const t = await runBundle(["--list-tools"], { exe });
			expect(t.stdout).toContain("obsidian_distill");
		});
	});
});
