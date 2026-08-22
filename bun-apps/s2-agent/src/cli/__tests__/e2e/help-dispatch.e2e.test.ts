/**
 * e2e: `help [target]` / `--help [target]` / `-h [target]` shows help and NEVER
 * dispatches the target as a command.
 *
 * Regression guard for the bug where a leading help token was eaten by
 * parsePiArgs as the --help flag, so the next positional dispatched as a
 * command. COMMANDS/PIPELINES/WORKFLOWS happened to print help (runAgentCommand
 * checks the help flag), but META commands (version/list/list-tools/completions)
 * have explicit `if (first === "X")` branches that do NOT check the help flag →
 * they EXECUTED instead of showing help.
 *
 * Documented contract (root help): `help [command]  Show help (root, or a
 * command's details)`.
 */
import { describe, expect, test } from "bun:test";
import { runCli, VERSION } from "./_helpers.ts";

describe("help <target> — never executes the target", () => {
	// ── RED (bug) cases: these must NOT run the meta command ──────────────
	test("help version does NOT execute the version command", () => {
		const r = runCli(["help", "version"]);
		expect(r.exitCode, `stderr:\n${r.stderr}`).toBe(0);
		// the `version` command prints EXACTLY `s2-agent cli ${VERSION}`; help must
		// instead surface root help (banner `v${VERSION}` + a Usage: block).
		expect(r.stdout.trim()).not.toBe(`s2-agent cli ${VERSION}`);
		expect(r.stdout).toContain("Usage:");
	});

	test("help list does NOT run list (no model table)", () => {
		const r = runCli(["help", "list"]);
		expect(r.exitCode, `stderr:\n${r.stderr}`).toBe(0);
		// the model table starts with the `provider  model …` header
		expect(r.stdout).not.toMatch(/^provider\s+model/m);
	});

	test("help list-tools does NOT run list-tools (no tool table)", () => {
		const r = runCli(["help", "list-tools"]);
		expect(r.exitCode, `stderr:\n${r.stderr}`).toBe(0);
		expect(r.stdout).not.toMatch(/^tool\s+source\s+description/m);
	});

	test("help completions does NOT execute completions (exit 0, not 1)", () => {
		const r = runCli(["help", "completions"]);
		// currently: `completions` with no shell arg → die() → exit 1
		expect(r.exitCode, `stderr:\n${r.stderr}`).not.toBe(1);
	});

	test("--help list (flag form) also shows help, not the model table", () => {
		const r = runCli(["--help", "list"]);
		expect(r.exitCode, `stderr:\n${r.stderr}`).toBe(0);
		expect(r.stdout).not.toMatch(/^provider\s+model/m);
	});

	// ── GREEN controls: these already work and must keep working ──────────
	test("help <real command> shows that command's details", () => {
		const r = runCli(["help", "zk-ask"]);
		expect(r.exitCode, `stderr:\n${r.stderr}`).toBe(0);
		expect(r.stdout).toContain("Ask a natural language question");
	});

	test("help <pipeline> shows the pipeline's details", () => {
		const r = runCli(["help", "pdf-to-vault"]);
		expect(r.exitCode, `stderr:\n${r.stderr}`).toBe(0);
		expect(r.stdout).toContain("PDF");
	});

	test("bare help → root help banner", () => {
		const r = runCli(["help"]);
		expect(r.exitCode, `stderr:\n${r.stderr}`).toBe(0);
		expect(r.stdout).toContain("non-interactive command namespace");
		expect(r.stdout).toContain("Usage:");
	});

	test("-h and --help alone → root help", () => {
		for (const flag of ["-h", "--help"] as const) {
			const r = runCli([flag]);
			expect(r.exitCode, `[${flag}] stderr:\n${r.stderr}`).toBe(0);
			expect(r.stdout).toContain("non-interactive command namespace");
		}
	});
});

/**
 * The inverse bug: the bare WORD `help` counted as the help flag at ANY argv
 * position, so an ordinary unquoted prompt containing it printed the banner and
 * exited 0 having done nothing — and the token was stripped from the prompt too.
 * `-h` / `--help` are flags and must stay position-independent.
 */
describe("a positional `help` is prompt text, not the help flag", () => {
	// NOTE: the discriminating cases (`-p explain the help system` must reach the
	// agent rather than the help path) are pinned in-process by
	// `args.test.ts` → "the bare word `help` is positional-sensitive" and by
	// `dispatch.test.ts` → findCommandToken. They are NOT repeated here: proving
	// it at the process boundary means letting the run actually reach a model,
	// which took this suite from 37s to 871s. What stays here is the cheap half
	// — that the flag form is unaffected.
	test("--help still wins from any position", () => {
		const r = runCli(["zk-ask", "--help"]);
		expect(r.exitCode, `stderr:\n${r.stderr}`).toBe(0);
		expect(r.stdout).toContain("Ask a natural language question");
	});

	test("--model <x> help still reaches root help (flags before the token)", () => {
		const r = runCli(["--model", "some-model", "help"]);
		expect(r.exitCode, `stderr:\n${r.stderr}`).toBe(0);
		expect(r.stdout).toContain("non-interactive command namespace");
	});
});
