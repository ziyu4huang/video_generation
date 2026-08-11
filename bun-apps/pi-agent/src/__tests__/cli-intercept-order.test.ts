/**
 * Source-order guard for src/cli.ts's three pre-patch intercepts.
 *
 * `doctor`, `ext doctor` and `cli` are all dispatched on the argv slice taken
 * BEFORE applyPatches() runs. That ordering is load-bearing, not stylistic:
 *
 *   - applyPatches() splices the run-dir extension/skill paths into
 *     process.argv at the FRONT (`process.argv.splice(2, 0, …)`), so after it
 *     runs argv[0] is no longer the user's subcommand token and none of the
 *     three `argv[0] === …` classifiers in cli-argv.ts can ever match.
 *   - `doctor` must stay reachable even when patches/deploys are broken —
 *     that is the entire point of a diagnostic.
 *   - `cli` must NOT inherit the TUI's provider patch or static extension
 *     factories; it curates its own extension set per command (docs/adr/0001).
 *
 * A refactor that hoists applyPatches() above these blocks would defeat all
 * three SILENTLY — the commands would fall through to the interactive TUI
 * rather than erroring. This test is a cheap textual tripwire for that.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// This file lives at <pkg>/src/__tests__/ → up one level to <pkg>/src/.
const cliSource = readFileSync(join(__dirname, "..", "cli.ts"), "utf8");

describe("cli.ts intercept ordering", () => {
	const marks = {
		doctor: "isDoctorCommand(argv)",
		extDoctor: "isExtDoctorCommand(argv)",
		cli: "isCliCommand(argv)",
		patches: "await applyPatches()",
	} as const;

	test("every marker is present exactly where the guard can see it", () => {
		for (const [name, needle] of Object.entries(marks)) {
			expect(cliSource.indexOf(needle), `missing marker for ${name}: ${needle}`).toBeGreaterThan(-1);
		}
	});

	test("all three intercepts precede applyPatches()", () => {
		const doctor = cliSource.indexOf(marks.doctor);
		const extDoctor = cliSource.indexOf(marks.extDoctor);
		const cli = cliSource.indexOf(marks.cli);
		const patches = cliSource.indexOf(marks.patches);

		expect(doctor, "doctor intercept must precede `ext doctor`").toBeLessThan(extDoctor);
		expect(extDoctor, "`ext doctor` intercept must precede the `cli` intercept").toBeLessThan(cli);
		expect(cli, "the `cli` intercept must precede applyPatches()").toBeLessThan(patches);
	});
});
