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

	/**
	 * Source ORDER is not sufficient on its own: a top-level `import` is hoisted
	 * and evaluated before any statement, so a heavy module pulled in at the top
	 * of the file is paid for by every intercept regardless of where the
	 * intercept sits. Both of the file's expensive subtrees must therefore be
	 * reached by `await import()`, and this pair of assertions is what makes the
	 * ordering guard above mean what it claims.
	 */
	describe("the expensive subtrees are dynamically imported, not hoisted", () => {
		const dynamic = [
			// The TUI must never evaluate the CLI subtree: it statically pulls
			// flux2/krea2/ltx/movie-director through each cli-subcommand.ts.
			"./cli/dispatch.ts",
			// The CLI must never evaluate the TUI's 14 static extension entry
			// graphs. This was a STATIC import: the protection was one-way, and an
			// undeclared import inside pi-agent-ext-webui's graph was evaluated
			// before the patch that makes it resolvable — breaking snapshot boot.
			"./static-extensions.ts",
		] as const;

		for (const mod of dynamic) {
			test(`${mod} is reached via await import()`, () => {
				expect(cliSource).toContain(`await import("${mod}")`);
			});

			test(`${mod} is NOT imported at the top level`, () => {
				// Matches a real ESM import statement at the start of a line —
				// `import … from "<mod>"` or a bare `import "<mod>"`.
				const hoisted = new RegExp(
					`^import\\s[^\\n]*["']${mod.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
					"m",
				);
				expect(
					hoisted.test(cliSource),
					`${mod} is imported at the top level — hoisting makes every entry ` +
						`path pay for it, which defeats the intercepts above`,
				).toBe(false);
			});
		}
	});
});
