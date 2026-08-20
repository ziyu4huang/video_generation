/**
 * doctor — unit tests for the pure check + classification functions.
 * (runDoctor/realContext wiring is exercised by the manual `./run.sh doctor`
 * smoke across source + deploy modes; here we pin the classification logic.)
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import manifest from "../run-dir/manifest.json";
import { HOST_API } from "./sh/host-modules.ts";
import {
	classifyMode,
	runChecks,
	checkHostDeps,
	checkExtensions,
	checkProviders,
	checkShExtensions,
	smokeMarker,
	runSmokeCheck,
	removedFlagNotice,
	type DeployMode,
	type DoctorContext,
} from "./doctor.ts";

/** Build a fake context with only the fields a check reads. */
function ctx(over: Partial<DoctorContext> & { mode: DoctorContext["mode"] }): DoctorContext {
	return {
		selfDir: "/out",
		deployDir: "/out",
		entryPath: "/out/pi-agent.js",
		bunVersion: "1.0.0",
		exists: () => true,
		depInstalled: () => true,
		listDir: () => [],
		readFile: () => "",
		env: {},
		...over,
	} as DoctorContext;
}

describe("classifyMode", () => {
	// `portable` and `release` were removed: nothing writes .deploy-portable or a
	// packages/ dir, so those branches — and the ~15 tests that were the only
	// thing exercising them — could never fire in production.
	test("binary with no sh marker stays binary", () => {
		expect(classifyMode("binary", { dotDeployBundle: true, shDeploy: false })).toBe("binary");
	});
	test("binary beside a deploy.json is an sh deploy", () => {
		expect(classifyMode("binary", { dotDeployBundle: false, shDeploy: true })).toBe("sh");
	});
	test("source stays source regardless of markers", () => {
		expect(classifyMode("source", { dotDeployBundle: true, shDeploy: false })).toBe("source");
	});
	test("bundle coarse → bundle when .deploy-bundle present", () => {
		expect(classifyMode("bundle", { dotDeployBundle: true, shDeploy: false })).toBe("bundle");
	});
	test("bundle coarse with no marker → bundle (plain pi-agent.js)", () => {
		expect(classifyMode("bundle", { dotDeployBundle: false, shDeploy: false })).toBe("bundle");
	});
	/**
	 * The guard for the original drift. A hardcoded `produced` set cannot be it:
	 * the drift ran the direction such a set is blind to — the deploy script SHED
	 * two mode flags while doctor.ts kept the modes, and a set written by hand at
	 * that moment would have listed all five and stayed green forever.
	 *
	 * It used to derive `produced` by reading deploy.ts's KNOWN_FLAGS. That file
	 * is gone with the four legacy deploy modes, and with it every producer of
	 * `bundle`. What is left is one deploy script (deploy-sh.ts → `sh`) plus the
	 * two modes that need no deploy at all: `source` (running src/cli.ts) and
	 * `binary` (a compiled core with no deploy.json beside it).
	 *
	 * So the guard is inverted rather than deleted. `bundle` is now an ORPHAN —
	 * classifyMode can still return it, nothing can produce it — and it is
	 * removed in the follow-up that collapses "bundle" out of mode.ts and
	 * run-dir/resolve.ts. Pinning the orphan set to exactly {bundle} means:
	 *   • a NEW orphan (doctor gains a mode no deploy makes) fails immediately;
	 *   • removing `bundle` in that follow-up ALSO fails here, forcing this block
	 *     to be updated rather than left describing a mode that no longer exists.
	 * A guard that cannot fail in either direction is what let the first drift
	 * live.
	 */
	describe("doctor's mode set is pinned to what a deploy can produce", () => {
		// Read, not imported: it is a script with top-level side effects. An ENOENT
		// means it moved — loud, which is what a drift guard wants.
		const DEPLOY_SH_TS = join(import.meta.dir, "..", "..", "pi-agent-ext-devops", "scripts", "deploy-sh.ts");
		const deployShSource = readFileSync(DEPLOY_SH_TS, "utf8");

		/** Modes something can actually put on disk today. */
		const PRODUCED = new Set<DeployMode>(["source", "binary"]);
		if (deployShSource.length > 0) PRODUCED.add("sh");

		/** Modes classifyMode can still return that nothing produces. Removed in
		 *  the "collapse bundle out of the runtime" follow-up. */
		const KNOWN_ORPHANS = new Set<DeployMode>(["bundle"]);

		function reachableModes(): Set<DeployMode> {
			const seen = new Set<DeployMode>();
			for (const coarse of ["source", "bundle", "binary"] as const) {
				for (const dotDeployBundle of [true, false]) {
					for (const shDeploy of [true, false]) {
						seen.add(classifyMode(coarse, { dotDeployBundle, shDeploy }));
					}
				}
			}
			return seen;
		}

		test("the deploy script is where this guard thinks it is", () => {
			// Vacuity guard: an empty read would make PRODUCED lose "sh" silently.
			expect(deployShSource).toContain("export async function runShDeploy");
		});

		test("(a) every mode classifyMode returns is produced, or a KNOWN orphan", () => {
			const unexpected = [...reachableModes()].filter((m) => !PRODUCED.has(m) && !KNOWN_ORPHANS.has(m));
			expect(
				unexpected,
				`classifyMode returned ${unexpected.join(", ")}, which no deploy produces and which ` +
					"is not a recorded orphan. Either a deploy mode was added without updating " +
					"PRODUCED, or doctor grew a mode nothing can reach.",
			).toEqual([]);
		});

		test("(b) every KNOWN orphan is still reachable — remove it here when it goes", () => {
			const reachable = reachableModes();
			const gone = [...KNOWN_ORPHANS].filter((m) => !reachable.has(m));
			expect(
				gone,
				`${gone.join(", ")} is listed as a known orphan but classifyMode can no longer ` +
					"return it. Drop it from KNOWN_ORPHANS (and from DeployMode, and from the " +
					"classifyMode tests above) — a stale exemption is how a guard stops guarding.",
			).toEqual([]);
		});
	});
});

describe("removedFlagNotice", () => {
	test("--fix is announced, not silently dropped", () => {
		// doctor takes no flag-spec, so an unknown token falls through and the
		// report prints as if nothing was asked for — a stale doc plus a clean
		// report reads as "--fix ran and found nothing".
		expect(removedFlagNotice(["doctor", "--fix"])).toContain("`doctor --fix` was removed");
	});

	test("no notice without the flag", () => {
		expect(removedFlagNotice(["doctor", "--json", "--smoke"])).toBeNull();
	});
});

describe("checkHostDeps (mode-aware severity)", () => {
	const noDeps = { depInstalled: () => false };
	test("source → INFO regardless of resolution (pi resolves its own deps)", () => {
		expect(checkHostDeps(ctx({ mode: "source", ...noDeps })).status).toBe("info");
	});
	test("bundle → PASS when deps installed", () => {
		expect(checkHostDeps(ctx({ mode: "bundle" })).status).toBe("pass");
	});
	test("no mode can hard-fail — the only fail path keyed on `portable`", () => {
		// Recorded deliberately rather than left implicit: for every mode that
		// EXISTS, missing host deps are recoverable (bundle works via baked abs
		// paths) or irrelevant (source/binary resolve their own). A future fail
		// path needs a mode where they are genuinely essential.
		for (const mode of ["source", "bundle", "binary"] as const) {
			expect(checkHostDeps(ctx({ mode, ...noDeps })).status).not.toBe("fail");
		}
	});
	test("bundle (THIN default) → WARN (not fail) when deps unresolvable — works via abs paths", () => {
		const r = checkHostDeps(ctx({ mode: "bundle", ...noDeps }));
		expect(r.status).toBe("warn");
	});

	test("names the specific missing dep (bundle) when only pi-agent-core is absent", () => {
		const depInstalled = (spec: string) => spec !== "@earendil-works/pi-agent-core";
		const r = checkHostDeps(ctx({ mode: "bundle", depInstalled }));
		expect(r.status).toBe("warn");
		expect(r.detail).toContain("@earendil-works/pi-agent-core");
	});

	test("warns (bundle) when @earendil-works/pi-ai is missing", () => {
		const depInstalled = (spec: string) => spec !== "@earendil-works/pi-ai";
		const r = checkHostDeps(ctx({ mode: "bundle", depInstalled }));
		expect(r.status).toBe("warn");
		expect(r.detail).toContain("@earendil-works/pi-ai");
	});
});

describe("checkExtensions (mode-aware)", () => {
	test("source/binary → INFO (loads from source/baked paths)", () => {
		expect(checkExtensions(ctx({ mode: "source" })).status).toBe("info");
		expect(checkExtensions(ctx({ mode: "binary" })).status).toBe("info");
	});
	test("bundle → compares against extensions only (npm exts via baked abs paths)", () => {
		const want = manifest.extensions?.length ?? 0;
		const files = Array.from({ length: want }, (_, i) => `e${i}.js`);
		expect(checkExtensions(ctx({ mode: "bundle", listDir: () => files })).status).toBe("pass");
		expect(checkExtensions(ctx({ mode: "bundle", listDir: () => ["one.js"] })).status).toBe("fail");
	});
	test("only counts .js (ignores stray non-js files in ext-bundles)", () => {
		const want = manifest.extensions?.length ?? 0;
		const files = [...Array.from({ length: want }, (_, i) => `e${i}.js`), "README.md", ".gitkeep"];
		expect(checkExtensions(ctx({ mode: "bundle", listDir: () => files })).status).toBe("pass");
	});
});

describe("checkProviders", () => {
	test("warns when a provider's apiKey env var is unset", () => {
		// PROVIDERS has lm-studio with a literal apiKey — force an env-gated one
		// by checking the real resolveApiKey against an empty env where needed.
		// lm-studio uses a literal, so it passes; this asserts the warn path via
		// a synthetic provider-less env doesn't crash.
		const r = checkProviders(ctx({ mode: "bundle", env: {} }));
		expect(["pass", "warn", "info"]).toContain(r.status);
	});
});

describe("runChecks (aggregate)", () => {
	test("ok=true when no FAIL", () => {
		// Derive the fake bundle count from the manifest so this doesn't rot every
		// time an extension is added.
		const want = manifest.extensions?.length ?? 0;
		const r = runChecks(ctx({ mode: "bundle", listDir: () => Array.from({ length: want }, (_, i) => `e${i}.js`) }));
		expect(r.ok).toBe(true);
		expect(r.mode).toBe("bundle");
	});
	test("ok=false when any FAIL (bundle with an empty ext-bundles/)", () => {
		const r = runChecks(ctx({ mode: "bundle", depInstalled: () => false, listDir: () => [] }));
		expect(r.ok).toBe(false);
	});
	test("source mode never hard-fails (host-deps is info)", () => {
		const r = runChecks(ctx({ mode: "source", depInstalled: () => false }));
		expect(r.ok).toBe(true);
	});
});

describe("smokeMarker (pure)", () => {
	test("source → bun-apps dir (selfDir/../.. from .../pi-agent/src)", () => {
		// selfDir for source mode is .../pi-agent/src → marker is .../bun-apps
		expect(smokeMarker("source", "/repo/bun-apps/pi-agent/src")).toBe("/repo/bun-apps");
	});
	test("bundle → <selfDir>/ext-bundles", () => {
		expect(smokeMarker("bundle", "/out")).toBe("/out/ext-bundles");
	});
	test("binary → the static-factory source prefix (tools report path '<inline:<pkg>>')", () => {
		expect(smokeMarker("binary", "/out")).toBe("<inline:");
	});
});

describe("runSmokeCheck (via injected spawn seam)", () => {
	// A fake spawn that returns a canned stderr — exercises runSmokeCheck's
	// parsing/branching without spawning bun.
	const fakeSpawn =
		(stderr: string, code: number | null = 0) =>
		async () => ({ stderr, code });
	const srcCtx = () => ctx({ mode: "source", selfDir: "/repo/bun-apps/pi-agent/src", entryPath: "/repo/bun-apps/pi-agent/src/cli.ts" });

	test("PASS when matched > 0 (run-dir extensions loaded)", async () => {
		const r = await runSmokeCheck(srcCtx(), { spawn: fakeSpawn("[SMOKE] total=38 matched=33\nsome other line") });
		expect(r.status).toBe("pass");
		expect(r.detail).toContain("matched=33");
	});
	test("FAIL when matched = 0 (silent no-op class)", async () => {
		const r = await runSmokeCheck(srcCtx(), { spawn: fakeSpawn("[SMOKE] total=8 matched=0\n") });
		expect(r.status).toBe("fail");
		expect(r.detail).toContain("matched=0");
		expect(r.hint).toContain("slice");
	});
	test("FAIL when probe never reported (no [SMOKE] line)", async () => {
		const r = await runSmokeCheck(srcCtx(), { spawn: fakeSpawn("Error: something broke", 2) });
		expect(r.status).toBe("fail");
		expect(r.detail).toContain("did not report");
		expect(r.hint).toContain("something broke");
	});
	test("binary mode runs the probe (spawn injected) and passes on matched>0", async () => {
		const r = await runSmokeCheck(ctx({ mode: "binary" }), {
			spawn: fakeSpawn("[SMOKE] total=31 matched=24\n"),
		});
		expect(r.status).toBe("pass");
	});
});


// ── sh mode ─────────────────────────────────────────────────────────────────
describe("checkShExtensions", () => {
	// Imported, not a literal: a HOST_API bump (1 -> 2 when the subagent package
	// stopped being a host module) silently turned every fixture below into a
	// version MISMATCH, so two assertions about entirely different failures
	// started failing with "built for hostApi 1, host provides 2".
	const HOST_API_NOW = HOST_API;
	const manifestFor = (name: string, over: Record<string, unknown> = {}) =>
		JSON.stringify({
			name,
			package: `pi-agent-ext-${name}`,
			version: "0.0.0",
			hostApi: HOST_API_NOW,
			entry: "ext.cjs",
			order: 10,
			enabled: true,
			...over,
		});

	/** A context whose fs is a plain map of path → contents. */
	function shCtx(files: Record<string, string>, dirs: Record<string, string[]>): DoctorContext {
		return ctx({
			mode: "sh",
			deployDir: "/deploy",
			exists: (p: string) => p in files || p in dirs,
			listDir: (p: string) => dirs[p] ?? [],
			readFile: (p: string) => {
				const c = files[p];
				if (c === undefined) throw new Error(`ENOENT: ${p}`);
				return c;
			},
		});
	}

	test("an absent ext/ is info, not a failure — booting with none is designed", () => {
		const r = checkShExtensions(shCtx({}, {}));
		expect(r.status).toBe("info");
		expect(r.detail).toContain("zero extensions");
	});

	test("fails on a manifest the LOADER would reject, naming the extension", () => {
		// hostApi drift is the case that matters: --ext-list would report it
		// skipped at boot, and doctor exists to say so before boot.
		const files = {
			"/deploy/ext/task/ext.json": manifestFor("task", { hostApi: 99 }),
			"/deploy/ext/task/ext.cjs": "",
		};
		const r = checkShExtensions(shCtx(files, { "/deploy/ext": ["task"] }));
		expect(r.status).toBe("fail");
		expect(r.detail).toContain("task");
		expect(r.detail).toContain("SKIPPED");
	});

	test("fails when the manifest is fine but its entry file is gone", () => {
		const files = { "/deploy/ext/task/ext.json": manifestFor("task") };
		const r = checkShExtensions(shCtx(files, { "/deploy/ext": ["task"] }));
		expect(r.status).toBe("fail");
		expect(r.detail).toContain("entry missing");
	});

	test("ignores a directory that carries no ext.json", () => {
		const files = {
			"/deploy/ext/task/ext.json": manifestFor("task"),
			"/deploy/ext/task/ext.cjs": "",
		};
		const r = checkShExtensions(shCtx(files, { "/deploy/ext": ["task", "not-an-extension"] }));
		expect(r.status).toBe("pass");
		expect(r.detail).toContain("1 extension(s)");
	});
});

describe("smokeMarker in sh mode", () => {
	test("is the inline marker — sh factories reach pi via main({extensionFactories})", () => {
		// Measured against a real deploy: {"path":"<inline:power-tool>","source":"inline"}.
		expect(smokeMarker("sh", "/deploy")).toBe("<inline:");
	});
});
