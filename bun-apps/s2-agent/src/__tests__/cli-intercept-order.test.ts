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
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// This file lives at <pkg>/src/__tests__/ → up one level to <pkg>/src/.
const cliSource = readFileSync(join(__dirname, "..", "cli.ts"), "utf8");

/**
 * Specifiers of the real top-level ESM `import` statements in `source`.
 *
 * Matches `import … from <specifier>` (including the multi-line brace form —
 * the clause cannot contain a quote, so `[^'"]` safely spans newlines) and
 * the bare `import <specifier>` form. Anchored at start-of-line, so an
 * `await import()` inside a function body — indented, and not the `import` keyword in statement position
 * — is correctly NOT reported. That distinction is the entire point: only the
 * top-level form is hoisted.
 */
function topLevelImports(source: string): string[] {
	return [...source.matchAll(/^import\s(?:[^'"]*?from\s*)?["']([^"']+)["']/gm)].map((m) => m[1]);
}

/** The subtrees that must never be evaluated by a pre-patch code path. */
const EXPENSIVE = [
	// The TUI must never evaluate the CLI subtree: it statically pulls
	// flux2/krea2/ltx/movie-director through each cli-subcommand.ts.
	"./cli/dispatch.ts",
	// No pre-patch path may evaluate the TUI's 14 static extension entry graphs.
	// This was a STATIC import in cli.ts: the protection was one-way, and an
	// undeclared import inside s2-agent-ext-webui's graph was evaluated before
	// the patch that makes it resolvable — breaking snapshot boot.
	"./static-extensions.ts",
] as const;

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
		for (const mod of EXPENSIVE) {
			test(`${mod} is reached via await import()`, () => {
				expect(cliSource).toContain(`await import("${mod}")`);
			});

			test(`${mod} is NOT imported at the top level`, () => {
				expect(
					topLevelImports(cliSource).some((spec) => spec === mod),
					`${mod} is imported at the top level — hoisting makes every entry ` +
						`path pay for it, which defeats the intercepts above`,
				).toBe(false);
			});
		}
	});

	/**
	 * cli.ts's own source is not the whole surface. Every module that runs before
	 * applyPatches() — its hoisted static imports, plus whatever the three
	 * pre-patch intercepts `await import()` — is equally able to drag an
	 * expensive subtree in transitively, and the assertions above are blind to
	 * that: they only read cli.ts.
	 *
	 * This is not hypothetical. ext-doctor.ts held a static
	 * `import … from "./static-extensions.ts"`, so `s2-agent ext doctor` kept
	 * evaluating all 14 extension entry graphs pre-patch — the exact failure the
	 * cli.ts fix closed on the `cli` path — while every assertion above stayed
	 * green. One level of transitivity is enough to cover the real entry points;
	 * a full graph walk would just be a slower way to say the same thing.
	 */
	describe("no pre-patch module drags an expensive subtree in transitively", () => {
		const srcDir = join(__dirname, "..");
		const prePatchRegion = cliSource.slice(0, cliSource.indexOf(marks.patches));

		/** Local modules evaluated before applyPatches(): cli.ts's hoisted static
		 *  imports (which run first no matter where they sit) + the dynamic
		 *  imports written above the applyPatches() call. */
		const prePatchModules = [
			...topLevelImports(cliSource),
			...[...prePatchRegion.matchAll(/await import\(\s*["'](\.[^"']+)["']\s*\)/g)].map((m) => m[1]),
		].filter((spec) => spec.startsWith("."));

		test("the scan actually found the pre-patch entry points", () => {
			// A regex that silently matches nothing would make every assertion
			// below vacuously pass, so pin the two dynamic ones by name.
			expect(prePatchModules).toContain("./ext-doctor.ts");
			expect(prePatchModules).toContain("./cli/dispatch.ts");
		});

		for (const spec of [...new Set(prePatchModules)]) {
			test(`${spec} does not statically import an expensive subtree`, () => {
				const file = join(srcDir, spec);
				if (!existsSync(file)) return; // npm specifiers / generated files
				const offenders = topLevelImports(readFileSync(file, "utf8")).filter((s) =>
					EXPENSIVE.some((e) => s.endsWith(e)),
				);
				expect(
					offenders,
					`${spec} runs before applyPatches() and statically imports ` +
						`${offenders.join(", ")} — hoisting evaluates that graph before the ` +
						`patch that makes its deps resolvable. Use await import() inside the ` +
						`function instead.`,
				).toEqual([]);
			});
		}
	});
});
