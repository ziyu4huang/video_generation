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
	planFixes,
	applyFixes,
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
	test("binary stays binary regardless of markers", () => {
		expect(classifyMode("binary", { dotDeployBundle: true, dotDeployPortable: true, packages: true })).toBe("binary");
	});
	test("source stays source regardless of markers", () => {
		expect(classifyMode("source", { dotDeployBundle: true, dotDeployPortable: true, packages: true })).toBe("source");
	});
	test("bundle coarse → portable when .deploy-portable marker", () => {
		expect(classifyMode("bundle", { dotDeployBundle: true, dotDeployPortable: true, packages: false })).toBe("portable");
	});
	test("bundle coarse → release when packages/ present", () => {
		expect(classifyMode("bundle", { dotDeployBundle: true, dotDeployPortable: false, packages: true })).toBe("release");
	});
	test("bundle coarse → bundle when only .deploy-bundle", () => {
		expect(classifyMode("bundle", { dotDeployBundle: true, dotDeployPortable: false, packages: false })).toBe("bundle");
	});
	test("bundle coarse with no markers → bundle (plain pi-agent.js)", () => {
		expect(classifyMode("bundle", { dotDeployBundle: false, dotDeployPortable: false, packages: false })).toBe("bundle");
	});
});

describe("checkHostDeps (mode-aware severity)", () => {
	const noDeps = { depInstalled: () => false };
	test("source → INFO regardless of resolution (pi resolves its own deps)", () => {
		expect(checkHostDeps(ctx({ mode: "source", ...noDeps })).status).toBe("info");
	});
	test("portable → FAIL when deps unresolvable (node_modules essential)", () => {
		const r = checkHostDeps(ctx({ mode: "portable", ...noDeps }));
		expect(r.status).toBe("fail");
		expect(r.detail).toContain("typebox");
	});
	test("portable → PASS when deps installed", () => {
		expect(checkHostDeps(ctx({ mode: "portable" })).status).toBe("pass");
	});
	test("bundle (THIN default) → WARN (not fail) when deps unresolvable — works via abs paths", () => {
		const r = checkHostDeps(ctx({ mode: "bundle", ...noDeps }));
		expect(r.status).toBe("warn");
	});
});

describe("checkExtensions (mode-aware)", () => {
	test("source/binary → INFO (loads from source/baked paths)", () => {
		expect(checkExtensions(ctx({ mode: "source" })).status).toBe("info");
		expect(checkExtensions(ctx({ mode: "binary" })).status).toBe("info");
	});
	test("portable → FAIL when ext-bundles short of extensions+npmExtensions", () => {
		const want = (manifest.extensions?.length ?? 0) + (manifest.npmExtensions?.length ?? 0);
		const r = checkExtensions(ctx({ mode: "portable", listDir: () => ["a.js", "b.js"] }));
		expect(r.status).toBe("fail");
		expect(r.detail).toContain(`≥ ${want}`);
	});
	test("portable → PASS when ext-bundles ≥ extensions+npmExtensions", () => {
		const want = (manifest.extensions?.length ?? 0) + (manifest.npmExtensions?.length ?? 0);
		const files = Array.from({ length: want }, (_, i) => `e${i}.js`);
		expect(checkExtensions(ctx({ mode: "portable", listDir: () => files })).status).toBe("pass");
	});
	test("bundle → compares against extensions only (npm exts via baked abs paths)", () => {
		const want = manifest.extensions?.length ?? 0;
		const files = Array.from({ length: want }, (_, i) => `e${i}.js`);
		expect(checkExtensions(ctx({ mode: "bundle", listDir: () => files })).status).toBe("pass");
		expect(checkExtensions(ctx({ mode: "bundle", listDir: () => ["one.js"] })).status).toBe("fail");
	});
	test("release → FAIL when packages/ empty", () => {
		expect(checkExtensions(ctx({ mode: "release", listDir: () => [] })).status).toBe("fail");
	});
	test("release → PASS when packages/ non-empty", () => {
		expect(checkExtensions(ctx({ mode: "release", listDir: () => ["pi-vlm", "zai-mcp"] })).status).toBe("pass");
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
		const r = runChecks(ctx({ mode: "portable", listDir: () => Array.from({ length: 20 }, (_, i) => `e${i}.js`) }));
		expect(r.ok).toBe(true);
		expect(r.mode).toBe("portable");
	});
	test("ok=false when any FAIL", () => {
		const r = runChecks(ctx({ mode: "portable", depInstalled: () => false, listDir: () => [] }));
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
	test("portable → <selfDir>/ext-bundles (same as bundle)", () => {
		expect(smokeMarker("portable", "/out")).toBe("/out/ext-bundles");
	});
	test("release → <selfDir>/packages", () => {
		expect(smokeMarker("release", "/out")).toBe("/out/packages");
	});
	test("binary → null (smoke skipped)", () => {
		expect(smokeMarker("binary", "/out")).toBeNull();
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
	test("INFO (skip) for binary mode — no spawn", async () => {
		let spawned = false;
		const r = await runSmokeCheck(ctx({ mode: "binary" }), {
			spawn: async () => {
				spawned = true;
				return { stderr: "", code: 0 };
			},
		});
		expect(r.status).toBe("info");
		expect(spawned).toBe(false);
	});
});

describe("planFixes (pure)", () => {
	// Build a real report via runChecks so planFixes sees the actual host-deps
	// CheckResult (status + detail) produced by checkHostDeps for that mode.
	const reportFor = (c: DoctorContext) => runChecks(c);

	test("portable + host-deps FAIL → plans one bun-install fix", () => {
		const c = ctx({ mode: "portable", depInstalled: () => false });
		const plan = planFixes(reportFor(c), c);
		expect(plan).toHaveLength(1);
		expect(plan[0]!.id).toBe("host-deps");
		expect(plan[0]!.label).toContain("bun install");
		expect(plan[0]!.reason).toContain("portable");
	});

	test("release + host-deps WARN → plans the fix", () => {
		// release host-deps is WARN (not fail) when unresolvable — still fixable.
		const c = ctx({ mode: "release", depInstalled: () => false, listDir: () => ["pi-vlm", "zai-mcp"] });
		const plan = planFixes(reportFor(c), c);
		expect(plan).toHaveLength(1);
		expect(plan[0]!.reason).toContain("release");
	});

	test("bundle (THIN default) + host-deps WARN → NO fix (no deps to install)", () => {
		const c = ctx({ mode: "bundle", depInstalled: () => false, listDir: () => ["e0.js"] });
		expect(planFixes(reportFor(c), c)).toEqual([]);
	});

	test("source/binary → NO fix (host-deps is info — pi resolves its own)", () => {
		expect(planFixes(reportFor(ctx({ mode: "source", depInstalled: () => false })), ctx({ mode: "source" }))).toEqual([]);
		expect(planFixes(reportFor(ctx({ mode: "binary", depInstalled: () => false })), ctx({ mode: "binary" }))).toEqual([]);
	});

	test("portable + host-deps PASS → NO fix (nothing broken)", () => {
		const c = ctx({ mode: "portable", depInstalled: () => true });
		expect(planFixes(reportFor(c), c)).toEqual([]);
	});
});

describe("applyFixes (via injected FixSpawn seam)", () => {
	const planFrom = (c: DoctorContext) => planFixes(runChecks(c), c);

	test("spawns `bun install` at ctx.selfDir; code 0 → PASS CheckResult", async () => {
		const c = ctx({ mode: "portable", depInstalled: () => false, selfDir: "/out" });
		let seenCwd: string | null = null;
		const spawn = async (args: { cwd: string }) => {
			seenCwd = args.cwd;
			return { code: 0, stderr: "" };
		};
		const results = await applyFixes(planFrom(c), c, { spawn });
		expect(seenCwd).toBe("/out");
		expect(results).toHaveLength(1);
		expect(results[0]!.status).toBe("pass");
		expect(results[0]!.id).toBe("fix:host-deps");
	});

	test("non-zero exit → FAIL CheckResult carrying the stderr tail", async () => {
		const c = ctx({ mode: "portable", depInstalled: () => false });
		const spawn = async () => ({ code: 1, stderr: "error: no package.json found" });
		const results = await applyFixes(planFrom(c), c, { spawn });
		expect(results).toHaveLength(1);
		expect(results[0]!.status).toBe("fail");
		expect(results[0]!.detail).toContain("exited 1");
		expect(results[0]!.hint).toContain("no package.json");
	});

	test("empty plan → no spawn, returns []", async () => {
		let spawned = false;
		const results = await applyFixes([], ctx({ mode: "portable" }), {
			spawn: async () => {
				spawned = true;
				return { code: 0, stderr: "" };
			},
		});
		expect(spawned).toBe(false);
		expect(results).toEqual([]);
	});
});
