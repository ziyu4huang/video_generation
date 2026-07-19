import { describe, expect, test } from "bun:test";
import { isDoctorCommand, isExtDoctorCommand } from "./cli-argv.ts";

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
