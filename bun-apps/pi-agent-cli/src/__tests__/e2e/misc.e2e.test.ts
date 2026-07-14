/**
 * e2e: misc dispatch behaviors — backward-compat alias, global-flags-before-
 * command dispatch, and the `--` end-of-options separator. All offline (the
 * exercised paths short-circuit before any model call).
 */
import { describe, expect, test } from "bun:test";
import { runCli } from "./_helpers.ts";

const NO_STACK = /\n\s+at\s\S/;

describe("misc — oneshot backward-compat alias", () => {
	test("oneshot version → strips alias, prints version, exit 0", () => {
		const r = runCli(["oneshot", "version"]);
		expect(r.exitCode, `stderr:\n${r.stderr}`).toBe(0);
		expect(r.stdout.trim()).toBe("bun-pi-agent-cli 0.1.0");
	});
});

describe("misc — global flags before the sub-command", () => {
	// Regression guard (mirrors dispatch.test's findCommandToken unit test, but
	// at the real process boundary): a value flag like --model placed BEFORE the
	// command must not push the command into passthrough-as-prompt.
	test("--model x version → dispatches version (not prompt), exit 0", () => {
		const r = runCli(["--model", "x", "version"]);
		expect(r.exitCode, `stderr:\n${r.stderr}`).toBe(0);
		expect(r.stdout.trim()).toBe("bun-pi-agent-cli 0.1.0");
	});

	test("--model x help → root help (passthrough help guard), exit 0", () => {
		const r = runCli(["--model", "x", "help"]);
		expect(r.exitCode, `stderr:\n${r.stderr}`).toBe(0);
		expect(r.stdout).toContain("self-contained pi-agent");
	});
});

describe("misc — `--` end-of-options separator", () => {
	test("vlm-describe -- -tricky.pdf → operand treated as a positional file path", () => {
		// After `--`, `-tricky.pdf` becomes a positional (the file to process),
		// NOT an unknown flag to skip. With no such file, vlm-describe fails
		// fast on input resolution — proving the leading-dash token reached the
		// command as a file, and dispatch did not silently swallow it as a flag.
		const r = runCli(["vlm-describe", "--", "-tricky.pdf"]);
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("Input not found");
		expect(r.stderr).not.toMatch(NO_STACK);
	});
});
