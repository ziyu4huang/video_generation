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
import { readPatchOutcome, PATCH_TABLE, resolvePatchPlan } from "./index.ts";

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
	const FAILABLE = [
		"pre-load-providers",
		"ext-context-get-system-prompt-options",
		"ext-api-get-all-tool-definitions",
		"footer-extension-status-notify",
		"autocomplete-source-extension",
		"editor-history-restore",
		"startup-history-hint",
	] as const;

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
