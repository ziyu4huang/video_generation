/**
 * e2e-patches — verify the monkey-patches actually fire in the BUILT bundle.
 *
 * The unit suite covers pure decision logic (resolvePatchPlan, resolveEnvBridges,
 * resolveRunDirArgv, detectMode, PROVIDERS config) and the `applyPatches()`
 * integration test confirms the switch↔PATCH_TABLE wiring at import time. Neither
 * proves the bundled pi-agent — a single compiled file produced by `bun
 * scripts/build.ts` — actually runs every patch around the real `main()`.
 *
 * That bundling step has one footgun the unit tests structurally cannot see: the
 * per-patch import in applyPatches() must be a STATIC string literal or bun omits
 * the module from the bundle (a patch silently vanishes). These tests build the
 * real bundle and spawn it with `--help` (offline — no model call), asserting:
 *   1. every PATCH_TABLE entry reports `✓ applied` in the debug log → all five
 *      patch modules were bundled + ran;
 *   2. default-model-env splices PI_MODEL/PI_PROVIDER into argv → the env→argv
 *      bridge works end-to-end in bundle mode;
 *   3. an explicit `--model` on the command line suppresses only PI_MODEL.
 *
 * Gated on PI_AGENT_E2E=1 (keeps `bun test` baseline fast). Run via
 * `./bun-apps/pi-agent/run-test.sh` or `PI_AGENT_E2E=1 bun test`.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { E2E_ENABLED, ensureBundle, runBundle } from "./e2e-harness.ts";
// Read PATCH_TABLE so the "all applied" assertion tracks the source of truth
// — this test then works whether or not default-model-env (a separate PR) is
// present, and auto-extends when future patches are added.
import { PATCH_TABLE } from "../patches/index.ts";

// Strip ANSI color codes so regex assertions match the bundled debug output.
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// The default-model-env splice test only applies once that patch lands; detect
// it from PATCH_TABLE so this file stays green on either side of that PR.
const HAS_DEFAULT_MODEL_ENV = PATCH_TABLE.some(
	(p) => p.name === "default-model-env",
);

describe.skipIf(!E2E_ENABLED)("e2e: patches fire in the built bundle", () => {
	beforeAll(async () => {
		await ensureBundle();
	});

	test("every PATCH_TABLE entry reports ✓ applied (none vanished from the bundle)", async () => {
		const { stderr } = await runBundle(["--help"], {
			env: { BUN_PI_DEBUG_PATCHES: "1" },
		});
		const log = strip(stderr);
		// Each patch must be present AND marked applied (✓), not just listed —
		// catches a static-literal-switch regression where bun drops a module.
		for (const { name } of PATCH_TABLE) {
			expect(log).toContain(`✓ ${name}`);
		}
	});

	// Skipped until the default-model-env patch lands; auto-activates then.
	describe.skipIf(!HAS_DEFAULT_MODEL_ENV)(
		"default-model-env splice (patch absent — skipped)",
		() => {
			test("splices PI_MODEL + PI_PROVIDER into argv", async () => {
				const { stderr } = await runBundle(["--help"], {
					env: {
						BUN_PI_DEBUG_PATCHES: "1",
						PI_MODEL: "zai/glm-5.2:high",
						PI_PROVIDER: "lm-studio",
					},
				});
				const log = strip(stderr);
				expect(log).toMatch(/default-model-env spliced argv:/);
				// provider/id:thinking shorthand passes through untouched.
				expect(log).toContain('"--model"');
				expect(log).toContain('"zai/glm-5.2:high"');
				expect(log).toContain('"--provider"');
				expect(log).toContain('"lm-studio"');
			});

			test("explicit --model suppresses only PI_MODEL (PI_THINKING still bridges)", async () => {
				const { stderr } = await runBundle(
					["--model", "explicit-model", "--help"],
					{
						env: {
							BUN_PI_DEBUG_PATCHES: "1",
							PI_MODEL: "env-value",
							PI_THINKING: "high",
						},
					},
				);
				const log = strip(stderr);
				expect(log).not.toContain('"env-value"');
				expect(log).toContain('"--thinking"');
				expect(log).toContain('"high"');
			});
		},
	);

	test("--help still exits cleanly with patches applied (no model call / hang)", async () => {
		const { code, stderr } = await runBundle(["--help"]);
		// --help is offline; a non-zero exit here means a patch broke startup.
		expect(code).toBe(0);
		expect(strip(stderr)).not.toMatch(/error:/i);
	});
});
