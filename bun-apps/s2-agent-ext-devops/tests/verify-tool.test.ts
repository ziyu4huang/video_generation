import { describe, expect, test } from "bun:test";
import { parseVerifyOutput } from "../src/verify-tool.ts";

// run-test.sh wraps ✓/✗ in ANSI color and prints "✓ <name>  (Ns)" / "✗ <name>  (Ns)".
const OUTPUT = `\x1b[33m▶ s2-agent run-test.sh — effort=high\x1b[0m
\x1b[32m✓\x1b[0m unit + patch + extension e2e (high)  \x1b[2m(63s)\x1b[0m
\x1b[31m✗\x1b[0m read-only deploy e2e (readonly)  \x1b[2m(7s)\x1b[0m
\x1b[32m✓ effort=high passed\x1b[0m`;

describe("parseVerifyOutput", () => {
	test("strips ANSI and extracts step name + pass/fail + seconds", () => {
		const steps = parseVerifyOutput(OUTPUT);
		expect(steps).toEqual([
			{ name: "unit + patch + extension e2e (high)", passed: true, seconds: 63 },
			{ name: "read-only deploy e2e (readonly)", passed: false, seconds: 7 },
		]);
	});
	test("no step lines → empty array", () => {
		expect(parseVerifyOutput("nothing here")).toEqual([]);
	});
});
