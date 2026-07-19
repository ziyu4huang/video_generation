import { describe, expect, test } from "bun:test";
import { isDoctorCommand, isExtDoctorCommand, userSuppressFlags } from "./cli-argv.ts";

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
