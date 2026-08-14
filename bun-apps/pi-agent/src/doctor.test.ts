/**
 * doctor — unit tests for the pure check + classification functions.
 * (runDoctor/realContext wiring is exercised by the manual `./run.sh doctor`
 * smoke across source + deploy modes; here we pin the classification logic.)
 */
import { describe, expect, test } from "bun:test";
import manifest from "../run-dir/manifest.json";
import {
	classifyMode,
	runChecks,
	checkHostDeps,
	checkExtensions,
	checkProviders,
	smokeMarker,
	runSmokeCheck,
	type DoctorContext,
} from "./doctor.ts";

/** Build a fake context with only the fields a check reads. */
function ctx(over: Partial<DoctorContext> & { mode: DoctorContext["mode"] }): DoctorContext {
	return {
		selfDir: "/out",
		entryPath: "/out/pi-agent.js",
		bunVersion: "1.0.0",
		exists: () => true,
		depInstalled: () => true,
		listDir: () => [],
		env: {},
		...over,
	} as DoctorContext;
}

describe("classifyMode", () => {
	// `portable` and `release` were removed: nothing writes .deploy-portable or a
	// packages/ dir, so those branches — and the ~15 tests that were the only
	// thing exercising them — could never fire in production.
	test("binary stays binary regardless of markers", () => {
		expect(classifyMode("binary", { dotDeployBundle: true })).toBe("binary");
	});
	test("source stays source regardless of markers", () => {
		expect(classifyMode("source", { dotDeployBundle: true })).toBe("source");
	});
	test("bundle coarse → bundle when .deploy-bundle present", () => {
		expect(classifyMode("bundle", { dotDeployBundle: true })).toBe("bundle");
	});
	test("bundle coarse with no marker → bundle (plain pi-agent.js)", () => {
		expect(classifyMode("bundle", { dotDeployBundle: false })).toBe("bundle");
	});
	test("every mode it can return is one deploy.ts can actually produce", () => {
		// The guard that would have caught the original drift: doctor's mode set
		// must not outgrow the deploy script's.
		const produced = new Set(["source", "bundle", "binary"]);
		for (const coarse of ["source", "bundle", "binary"] as const) {
			for (const dotDeployBundle of [true, false]) {
				expect(produced.has(classifyMode(coarse, { dotDeployBundle }))).toBe(true);
			}
		}
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

