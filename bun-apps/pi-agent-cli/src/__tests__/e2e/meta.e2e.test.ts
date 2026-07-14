/**
 * e2e: meta commands — version / help / list / list-tools / completions.
 *
 * All offline (short-circuit before any model call). `list` / `list-tools` build
 * a session to enumerate, but never call a model — assertions are STRUCTURAL
 * (header + Total line / no-models message), never exact counts, because the
 * model set depends on the host's ~/.pi/agent/models.json (not hermetic even
 * under PI_SKIP_MODELS_JSON=1 — see findings.md §D).
 */
import { describe, expect, test } from "bun:test";
import { runCli } from "./_helpers.ts";

/** A thrown/uncaught error would dump a stack frame ("    at …") to stderr. */
const NO_STACK = /\n\s+at\s\S/;

describe("meta — version", () => {
	for (const argv of [["version"], ["-v"], ["--version"]] as const) {
		test(`${argv.join(" ")} → exact version string, exit 0`, () => {
			const r = runCli([...argv]);
			expect(r.exitCode, `stderr:\n${r.stderr}`).toBe(0);
			expect(r.stdout.trim()).toBe("bun-pi-agent-cli 0.1.0");
			expect(r.stderr).not.toMatch(NO_STACK);
		});
	}
});

describe("meta — root help", () => {
	for (const argv of [[], ["help"], ["-h"], ["--help"]] as const) {
		test(`${argv.length ? argv.join(" ") : "(no args)"} → root help banner, exit 0`, () => {
			const r = runCli([...argv]);
			expect(r.exitCode, `stderr:\n${r.stderr}`).toBe(0);
			expect(r.stdout).toContain("self-contained pi-agent");
			expect(r.stdout).toContain("Usage:");
			expect(r.stdout).toContain("Commands (agents):");
		});
	}
});

describe("meta — list / --list-models (structural only)", () => {
	for (const argv of [["list"], ["--list-models"], ["-lm"]] as const) {
		test(`${argv.join(" ")} → exit 0, model table or no-models msg, no stack`, () => {
			const r = runCli([...argv]);
			expect(r.exitCode, `stderr:\n${r.stderr}`).toBe(0);
			expect(r.stderr).not.toMatch(NO_STACK);
			// either the table header + a Total footer, or the empty-registry msg
			expect(r.stdout).toMatch(/^(provider|No models registered)/m);
			if (!r.stdout.includes("No models registered")) {
				expect(r.stdout).toMatch(/Total: \d+/);
			}
		});
	}
});

describe("meta — list-tools / --list-tools (structural only)", () => {
	for (const argv of [["list-tools"], ["--list-tools"], ["-lt"]] as const) {
		test(`${argv.join(" ")} → exit 0, tool table, no stack`, () => {
			const r = runCli([...argv]);
			expect(r.exitCode, `stderr:\n${r.stderr}`).toBe(0);
			expect(r.stderr).not.toMatch(NO_STACK);
			expect(r.stdout).toMatch(/^(tool|No tools registered)/m);
			if (!r.stdout.includes("No tools registered")) {
				expect(r.stdout).toMatch(/Total: \d+/);
			}
		});
	}
});

describe("meta — completions", () => {
	for (const shell of ["bash", "zsh", "fish"] as const) {
		test(`completions ${shell} → non-empty script, exit 0`, () => {
			const r = runCli(["completions", shell]);
			expect(r.exitCode, `stderr:\n${r.stderr}`).toBe(0);
			expect(r.stdout.trim().length, `empty ${shell} completion`).toBeGreaterThan(0);
			// bash emits a function named after the CLI
			if (shell === "bash") expect(r.stdout).toContain("_bun_pi_agent_cli");
		});
	}

	test("completions (no shell) → usage error, exit 1", () => {
		const r = runCli(["completions"]);
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("Usage: completions");
		expect(r.stderr).not.toMatch(NO_STACK);
	});

	test("completions bogus → exit 1", () => {
		const r = runCli(["completions", "bogus"]);
		expect(r.exitCode).toBe(1);
		expect(r.stderr).not.toMatch(NO_STACK);
	});
});
