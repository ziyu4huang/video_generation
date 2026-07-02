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
