import { describe, expect, test } from "bun:test";
import {
	isDoctorCommand,
	isExtDoctorCommand,
	isExtNewCommand,
	isCliCommand,
	userSuppressFlags,
	userExtensionPaths,
	overriddenStaticExtensions,
	webuiFlags,
} from "./cli-argv.ts";

describe("webuiFlags", () => {
	test("default: enabled, no port, argv unchanged", () => {
		expect(webuiFlags([])).toEqual({ disabled: false, port: null, rest: [] });
		expect(webuiFlags(["-p", "hi"]).rest).toEqual(["-p", "hi"]);
	});

	test("--no-webui disables and is stripped from rest", () => {
		const f = webuiFlags(["--no-webui", "-p", "hi"]);
		expect(f.disabled).toBe(true);
		expect(f.port).toBeNull();
		expect(f.rest).toEqual(["-p", "hi"]);
	});

	test("--webui-port <n> pins the port and strips BOTH tokens", () => {
		const f = webuiFlags(["--webui-port", "8787", "-p", "hi"]);
		expect(f.disabled).toBe(false);
		expect(f.port).toBe("8787");
		expect(f.rest).toEqual(["-p", "hi"]); // the value token is consumed, not leaked to pi
	});

	test("--webui-port=<n> form works", () => {
		const f = webuiFlags(["--webui-port=8787"]);
		expect(f.port).toBe("8787");
		expect(f.rest).toEqual([]);
	});

	test("--webui-port with a following flag (no value) -> port stays null, flag stripped", () => {
		const f = webuiFlags(["--webui-port", "--no-webui"]);
		expect(f.port).toBeNull();
		expect(f.disabled).toBe(true);
		expect(f.rest).toEqual([]);
	});

	test("--webui-port with an empty value -> null (resolver falls back)", () => {
		const f = webuiFlags(["--webui-port="]);
		expect(f.port).toBeNull();
	});

	test("combination: --no-webui --webui-port 0 strips both and keeps unrelated tokens", () => {
		const f = webuiFlags(["-e", "x.ts", "--no-webui", "--webui-port", "0", "--offline"]);
		expect(f.disabled).toBe(true);
		expect(f.port).toBe("0");
		expect(f.rest).toEqual(["-e", "x.ts", "--offline"]);
	});
});

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
	const NAMES = ["s2-agent-ext-hermes-memory", "s2-agent-ext-ultracode"];

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
			"-e", "/a/s2-agent-ext-ultracode/extensions/ultracode.ts",
			"-e", "C:\\x\\s2-agent-ext-hermes-memory\\extensions\\hm.ts",
		];
		expect(overriddenStaticExtensions(argv, NAMES)).toEqual(
			new Set(["s2-agent-ext-ultracode", "s2-agent-ext-hermes-memory"]),
		);
	});
});
