import { describe, expect, test } from "bun:test";
import {
	isDoctorCommand,
	isExtDoctorCommand,
	isExtNewCommand,
	isCliCommand,
	userSuppressFlags,
	userExtensionPaths,
	overriddenStaticExtensions,
} from "./cli-argv.ts";

describe("isDoctorCommand", () => {
	test("true for the `doctor` subcommand", () => {
		expect(isDoctorCommand(["doctor"])).toBe(true);
		expect(isDoctorCommand(["doctor", "--json"])).toBe(true);
	});

	test("false when argv[0] is not doctor", () => {
		expect(isDoctorCommand(["-p", "hello"])).toBe(false);
	});

	test("a literal '--doctor' prompt passed to -p is NOT hijacked", () => {
		expect(isDoctorCommand(["-p", "--doctor"])).toBe(false);
	});
});

describe("isExtDoctorCommand", () => {
	test("true for `ext doctor`", () => {
		expect(isExtDoctorCommand(["ext", "doctor"])).toBe(true);
	});

	test("false otherwise", () => {
		expect(isExtDoctorCommand(["doctor"])).toBe(false);
		expect(isExtDoctorCommand(["ext"])).toBe(false);
		expect(isExtDoctorCommand(["ext", "something-else"])).toBe(false);
	});
});

describe("isExtNewCommand", () => {
	test("true for `ext new <name>`", () => {
		expect(isExtNewCommand(["ext", "new", "foo"])).toBe(true);
		expect(isExtNewCommand(["ext", "new", "foo", "--lib"])).toBe(true);
	});

	test("false otherwise (same contract as isExtDoctorCommand)", () => {
		expect(isExtNewCommand(["ext", "doctor"])).toBe(false);
		expect(isExtNewCommand(["ext"])).toBe(false);
		expect(isExtNewCommand(["new"])).toBe(false);
		expect(isExtNewCommand(["-p", "ext new foo"])).toBe(false);
	});
});

describe("isCliCommand", () => {
	test("true for the `cli` namespace token", () => {
		expect(isCliCommand(["cli"])).toBe(true);
		expect(isCliCommand(["cli", "zk-ask", "what?"])).toBe(true);
	});

	test("false when argv[0] is not `cli`", () => {
		expect(isCliCommand([])).toBe(false);
		expect(isCliCommand(["doctor"])).toBe(false);
		expect(isCliCommand(["-p", "hello"])).toBe(false);
	});

	// The whole point of matching only argv[0]: a literal "cli" travelling as a
	// PROMPT or a flag VALUE must reach pi untouched, exactly like isDoctorCommand.
	test("a literal 'cli' passed as a prompt or flag value is NOT hijacked", () => {
		expect(isCliCommand(["-p", "cli"])).toBe(false);
		expect(isCliCommand(["--append-system-prompt", "cli"])).toBe(false);
		expect(isCliCommand(["--model", "sonnet", "-p", "cli"])).toBe(false);
	});
});

describe("userSuppressFlags", () => {
	test("-ne / --no-extensions set noExtensions", () => {
		expect(userSuppressFlags(["-ne"])).toEqual({ noExtensions: true, noSkills: false });
		expect(userSuppressFlags(["--no-extensions", "-p", "hi"])).toEqual({
			noExtensions: true,
			noSkills: false,
		});
	});

	test("-ns / --no-skills set noSkills", () => {
		expect(userSuppressFlags(["-ns"])).toEqual({ noExtensions: false, noSkills: true });
		expect(userSuppressFlags(["--no-skills"])).toEqual({ noExtensions: false, noSkills: true });
	});

	test("both flags combine; empty argv is all-false", () => {
		expect(userSuppressFlags(["-ne", "-ns"])).toEqual({ noExtensions: true, noSkills: true });
		expect(userSuppressFlags([])).toEqual({ noExtensions: false, noSkills: false });
	});

	test("matches pi's own parser: token anywhere in argv counts", () => {
		// pi's args.js treats `-ne` as a flag wherever it appears (prompts are
		// positional), so plain includes() mirrors upstream semantics exactly.
		expect(userSuppressFlags(["-p", "hello", "-ne"]).noExtensions).toBe(true);
	});
});

describe("userExtensionPaths", () => {
	test("collects -e and --extension values in order", () => {
		expect(userExtensionPaths(["-e", "/a/x.ts", "--extension", "/b/y.ts", "-p", "hi"])).toEqual([
			"/a/x.ts",
			"/b/y.ts",
		]);
	});

	test("empty when no -e present; trailing -e with no value is ignored", () => {
		expect(userExtensionPaths(["-p", "hi"])).toEqual([]);
		expect(userExtensionPaths(["-e"])).toEqual([]);
	});
});

describe("overriddenStaticExtensions", () => {
	const NAMES = ["s2-agent-ext-hermes-memory", "s2-agent-ext-workflow"];

	test("a -e path inside a static package dir overrides that package", () => {
		const argv = ["-e", "/repo/bun-apps/s2-agent-ext-hermes-memory/extensions/hermes-memory.ts"];
		expect(overriddenStaticExtensions(argv, NAMES)).toEqual(new Set(["s2-agent-ext-hermes-memory"]));
	});

	test("unrelated -e paths override nothing", () => {
		expect(overriddenStaticExtensions(["-e", "/tmp/probe.ts"], NAMES)).toEqual(new Set());
	});

	test("matches whole path segments only (no substring false-positives)", () => {
		const argv = ["-e", "/x/s2-agent-ext-hermes-memory-v2/extensions/hm.ts"];
		expect(overriddenStaticExtensions(argv, NAMES)).toEqual(new Set());
	});

	test("multiple -e paths accumulate; windows separators work", () => {
		const argv = [
			"-e", "/a/s2-agent-ext-workflow/extensions/workflow.ts",
			"-e", "C:\\x\\s2-agent-ext-hermes-memory\\extensions\\hm.ts",
		];
		expect(overriddenStaticExtensions(argv, NAMES)).toEqual(
			new Set(["s2-agent-ext-workflow", "s2-agent-ext-hermes-memory"]),
		);
	});
});
