/**
 * `applied` must report OUTCOME, not intent.
 *
 * WHY THIS EXISTS
 * ---------------
 * `applyPatches()` returned `resolvePatchPlan()`, a pure function of the
 * environment: a patch was "applied" if the env gate said to import its module.
 * Six modules then hardcoded `…PatchApplied = true` regardless of what their own
 * apply function returned, and two discarded the boolean entirely and printed
 * "patch applied" under debug even when the wrap had failed.
 *
 * That is the exact bug class this package has already paid for once: pre-0.80,
 * `ModelRegistry.prototype.loadModels` disappeared upstream, the patch installed
 * a method nothing called, and nobody noticed because ~/.pi/agent/models.json
 * happened to duplicate the baked catalog. The reporting chain built AFTER that
 * incident could not have caught a recurrence — and neither could
 * `e2e-patches.test.ts`, whose "every entry reports ✓ applied" assertion only
 * ever proved the module was imported.
 *
 * These tests are on `readPatchOutcome` and the per-module `patchApplied`
 * contract rather than on `applyPatches()` itself, because calling the real
 * `applyPatches()` in-process writes to ~/.pi, creates repo-root symlinks, and
 * permanently mutates process.argv for every later test file.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readPatchOutcome, PATCH_TABLE, resolvePatchPlan } from "./index.ts";

/** Every patch module in this directory, with its source. Not tests, not the registry. */
function patchModules(): { name: string; source: string }[] {
	return readdirSync(import.meta.dir)
		.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
		.map((f) => f.slice(0, -".ts".length))
		.filter((n) => n !== "index")
		.sort()
		.map((name) => ({ name, source: readFileSync(join(import.meta.dir, `${name}.ts`), "utf8") }));
}

describe("readPatchOutcome — the intent/outcome seam", () => {
	test("a module reporting false is a failure", () => {
		expect(readPatchOutcome({ patchApplied: false })).toBe(false);
	});

	test("a module reporting true is a success", () => {
		expect(readPatchOutcome({ patchApplied: true })).toBe(true);
	});

	test("a module that makes no claim is undefined, not false", () => {
		// Unconditional side effects (set-package-dir, skip-update-check) have
		// nothing to fail. They must NOT be reported as broken.
		expect(readPatchOutcome({})).toBeUndefined();
		expect(readPatchOutcome(null)).toBeUndefined();
		expect(readPatchOutcome(undefined)).toBeUndefined();
	});

	test("a non-boolean export is treated as no claim", () => {
		// Guards against a module exporting a truthy non-boolean and accidentally
		// reading as success — or a falsy one reading as failure.
		expect(readPatchOutcome({ patchApplied: "yes" })).toBeUndefined();
		expect(readPatchOutcome({ patchApplied: 0 })).toBeUndefined();
		expect(readPatchOutcome({ patchApplied: null })).toBeUndefined();
	});
});

describe("resolvePatchPlan is intent only", () => {
	test("it reports every default-on patch as applied, having executed nothing", () => {
		// This is the property that made the old reporting useless on its own.
		// Documented here so the distinction is not re-collapsed by accident.
		const plan = resolvePatchPlan(PATCH_TABLE, {});
		expect(plan.every((p) => p.applied)).toBe(true);
		expect(plan.length).toBe(PATCH_TABLE.length);
	});
});

/**
 * The patches that CAN fail must say so. Each is imported in a subprocess with
 * its own module cache: these modules apply their wrap at import time and are
 * idempotent-guarded, so a second import in this process would report `false`
 * for the honest reason "already applied" and the assertion would be
 * meaningless.
 */
describe("patch modules self-report a real outcome", () => {
	// DERIVED, not hand-listed. This list used to be typed out by hand, and
	// `force-response-language` was missing from it for its entire life: it
	// wraps `AgentSession.prototype._installAgentNextTurnRefresh`, returns false
	// when that target vanishes, discarded the boolean, and exported a hardcoded
	// `= true`. A hand-synced roster is the same defect as the module it failed
	// to cover — it reports success about a thing nobody checked.
	const FAILABLE = patchModules().filter((m) => /^export const patchApplied\b/m.test(m.source)).map((m) => m.name);

	test("the roster is non-empty (vacuity canary)", () => {
		// Deriving the list means a broken derivation yields zero tests and a
		// green suite. Any refactor that empties this must fail loudly instead.
		expect(FAILABLE.length, "no patch module declares `export const patchApplied` — the derivation broke").toBeGreaterThan(0);
	});

	for (const name of FAILABLE) {
		test(`${name} exports a boolean patchApplied`, async () => {
			const proc = Bun.spawn(
				[
					process.execPath,
					"-e",
					`const m = await import(${JSON.stringify(`${import.meta.dir}/${name}.ts`)});` +
						`console.log(JSON.stringify({ t: typeof m.patchApplied, v: m.patchApplied }));`,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const [out, err, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(code, `stderr:\n${err}`).toBe(0);
			const last = out.trim().split("\n").pop() ?? "";
			const parsed = JSON.parse(last) as { t: string; v: boolean };
			expect(parsed.t).toBe("boolean");
			// On a healthy tree every hook target exists, so a fresh import binds.
			// A false here means the pinned pi core moved under us — which is
			// exactly the signal this whole change exists to surface.
			expect(parsed.v, `${name} did not bind against the pinned pi core`).toBe(true);
		});
	}
});

/**
 * The RED half. Everything above proves the contract is wired on a healthy
 * tree; this proves it would actually FIRE — without it, the whole change is
 * indistinguishable from the `= true` constants it replaced.
 *
 * The simulation is the historical failure verbatim: make the hook target
 * disappear the way `ModelRegistry.prototype.loadModels` did, then check the
 * patch reports failure instead of installing a wrapper over nothing.
 */
describe("RED: a vanished hook target is reported, not swallowed", () => {
	// Subprocess: this deliberately breaks the SDK module for the process it
	// runs in, which must not leak into any other test file.
	const runWithBrokenHook = async (script: string) => {
		const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { out, err, code };
	};

	const BREAK_CREATE =
		`const pca = await import("@earendil-works/pi-coding-agent");` +
		`Object.defineProperty(pca.ModelRuntime, "create", ` +
		`{ value: undefined, configurable: true, writable: true });`;

	test("the module reports patchApplied=false", async () => {
		const { out, code, err } = await runWithBrokenHook(
			BREAK_CREATE +
				`const m = await import(${JSON.stringify(`${import.meta.dir}/pre-load-providers.ts`)});` +
				`console.log("RESULT:" + m.patchApplied);`,
		);
		expect(code, `stderr:\n${err}`).toBe(0);
		expect(out).toContain("RESULT:false");
	});

	test("applyPatches downgrades `applied` and warns on stderr (not debug-gated)", async () => {
		const { out, err, code } = await runWithBrokenHook(
			// Disable the three patches with side effects outside the repo so this
			// subprocess cannot write ~/.pi or repo-root symlinks.
			`process.env.BUN_PI_LOAD_RUN_DIR = "0";` +
				`process.env.BUN_PI_ENSURE_EXT_DEPS = "0";` +
				`process.env.BUN_PI_ENSURE_MODEL_TIERS = "0";` +
				BREAK_CREATE +
				`const { applyPatches } = await import(${JSON.stringify(`${import.meta.dir}/index.ts`)});` +
				`const r = await applyPatches();` +
				`console.log("RESULT:" + r.find((x) => x.name === "pre-load-providers").applied);`,
		);
		expect(code, `stderr:\n${err}`).toBe(0);
		expect(out).toContain("RESULT:false");
		// The warning must appear WITHOUT BUN_PI_DEBUG_PATCHES: a silent no-op is
		// invisible by construction unless something shouts on the default path.
		expect(err).toContain('patch "pre-load-providers" was enabled but did NOT bind');
	});
});

/**
 * STRUCTURAL. The tests above prove the contract holds for the modules that
 * opted into it. These prove no module can quietly opt back out — which is how
 * `force-response-language` sat outside the contract from the day the contract
 * was written, reporting success while its wrap could have been binding to
 * nothing.
 *
 * Both patterns below are the failure verbatim, taken from the incident
 * described at the top of this file. They are source-level checks because
 * that is where the defect is visible: the module still runs, still imports,
 * still prints "applied". Only the source says the outcome went nowhere.
 */
describe("STRUCTURAL: a patch cannot silently stop reporting its outcome", () => {
	test("no module hardcodes `…PatchApplied = true`", () => {
		const offenders = patchModules()
			.filter((m) => /\bexport const \w*PatchApplied\s*=\s*true\s*;/.test(m.source))
			.map((m) => m.name);
		expect(
			offenders,
			`these modules export a hardcoded applied-flag: ${offenders.join(", ")}. ` +
				"A constant `true` is not an outcome — it reports success even when the wrap " +
				"bound to nothing. Export `patchApplied` carrying the real return value instead " +
				"(see ./index.ts readPatchOutcome).",
		).toEqual([]);
	});

	test("no module discards the boolean its own apply function returns", () => {
		// The exact `force-response-language` defect: `applyX(): boolean` declared
		// in the file, then called at top level as a bare statement with the
		// result thrown away. Bind it to something (`const outcome = applyX()`)
		// and export it.
		const offenders: string[] = [];
		for (const { name, source } of patchModules()) {
			const boolFns = [...source.matchAll(/^export function (\w+)\([^)]*\)\s*:\s*boolean\b/gm)].map((m) => m[1]!);
			for (const fn of boolFns) {
				if (new RegExp(`^${fn}\\(\\);\\s*$`, "m").test(source)) offenders.push(`${name}.${fn}()`);
			}
		}
		expect(
			offenders,
			`these top-level calls throw away a boolean outcome: ${offenders.join(", ")}. ` +
				"The function returns false when its hook target is missing — discarding that " +
				"is how a dead patch reports itself as applied.",
		).toEqual([]);
	});

	test("the structural scan reads real modules (vacuity canary)", () => {
		const mods = patchModules();
		expect(mods.length, "no patch modules were discovered — both scans above are vacuous").toBeGreaterThan(5);
		expect(
			mods.some((m) => /export function \w+\([^)]*\)\s*:\s*boolean\b/.test(m.source)),
			"no patch module declares a boolean-returning apply function — the discarded-outcome scan has nothing to match",
		).toBe(true);
	});
});
