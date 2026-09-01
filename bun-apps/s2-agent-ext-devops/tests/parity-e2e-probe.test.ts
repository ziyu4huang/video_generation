/**
 * parity probe wiring — capture + runDeployE2e integration, spawn-injected.
 * The real launchers are never executed; fingerprints are marker JSON fed
 * through the fake spawn's stderr, keyed on argv.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runDeployE2e, deriveExcludedExtensions } from "../src/deploy-e2e-recipe.js";
import { captureParityFingerprint, PARITY_PROBE_CAP_MS } from "../src/parity-capture.js";
import { PARITY_PROBE_SOURCE } from "../src/parity-probe.js";
import type { SpawnFn, SpawnResult } from "../src/spawn.js";

const root = mkdtempSync(join(tmpdir(), "parity-e2e-"));
const VERSION = "0.1.0+gfeedbeef";
const versionDir = join(root, VERSION);
const devLauncher = join(root, "dev", "s2-agent.sh");
afterAll(() => rmSync(root, { recursive: true, force: true }));

function makeTree(): void {
	mkdirSync(join(versionDir, "ext"), { recursive: true });
	writeFileSync(join(versionDir, "s2-agent.sh"), "#!/usr/bin/env bash\n");
	writeFileSync(
		join(versionDir, "deploy.json"),
		JSON.stringify({ version: VERSION, sourceSha: "feedbeef", config: { extensions: [{ name: "task", enabled: true }] } }),
	);
	// Re-created per test — remove the previous round's link first (EEXIST),
	// same guard as verify-deploy-e2e's makeTree.
	rmSync(join(root, "current"), { force: true });
	symlinkSync(VERSION, join(root, "current"));
	mkdirSync(join(root, "dev"), { recursive: true });
	writeFileSync(devLauncher, "#!/usr/bin/env bash\n");
}

const fpLine = (o: unknown): string => `\n[PARITY-FP-START]${JSON.stringify(o)}[PARITY-FP-END]\n`;

const DEV_FP = {
	marker: "PARITY_FP_v1", mode: "dev", sessionStartFired: true, toolCount: 2,
	tools: [
		{ n: "read", s: "builtin", p: "<builtin:read>", dh: "1", sh: "2" },
		{ n: "merge_pr_after_local_ci", s: "extension", p: "/w/bun-apps/s2-agent-ext-devops/extensions/devops.ts", dh: "3", sh: "4" },
	],
	skillCount: 1,
	skills: [{ n: "devops-workflow", p: "/w/bun-apps/s2-agent-ext-devops/skills/devops-workflow/SKILL.md", ch: "5" }],
};
const DEPLOY_FP = {
	marker: "PARITY_FP_v1", mode: "deploy", sessionStartFired: true, toolCount: 2,
	tools: [
		{ n: "read", s: "builtin", p: "<builtin:read>", dh: "1", sh: "2" },
		{ n: "merge_pr_after_local_ci", s: "extension", p: "/dist/ext/devops/ext.cjs", dh: "3", sh: "4" },
	],
	skillCount: 1,
	skills: [{ n: "devops-workflow", p: "/dist/ext/devops/skills/devops-workflow/SKILL.md", ch: "5" }],
};

const MODELS = "id\nprovider/glm-5.3\nprovider/qwen3-coder\n";

/** Fake spawn: dev launcher vs deployed launcher, keyed on argv. `-e` FIRST. */
function fakeSpawn(variants: { deployFp?: object | null; devFp?: object | null; devModels?: string } = {}): SpawnFn {
	return async (_cmd: string, args: string[]): Promise<SpawnResult> => {
		const argv = args.join(" ");
		const isDev = _cmd === devLauncher;
		if (argv.includes("-e")) {
			// undefined → side default; null → deliberate marker-missing variant
			// (?? would swallow the null back into the default).
			const fp = isDev
				? (variants.devFp === undefined ? DEV_FP : variants.devFp)
				: (variants.deployFp === undefined ? DEPLOY_FP : variants.deployFp);
			if (fp === null) return { stdout: "", stderr: "no marker — probe never ran (silent skip class)", exitCode: 0 };
			return { stdout: "", stderr: fpLine(fp), exitCode: 0 };
		}
		if (argv.includes("--list-models")) {
			return { stdout: isDev ? (variants.devModels ?? MODELS) : MODELS, stderr: "", exitCode: 0 };
		}
		if (argv.includes("--ext-list")) {
			return { stdout: JSON.stringify({ loaded: ["task"], loadedCount: 1, skillPaths: [], skipped: [] }), stderr: "", exitCode: 0 };
		}
		return { stdout: "ok", stderr: "", exitCode: 0 }; // --help etc.
	};
}

describe("captureParityFingerprint", () => {
	test("captures a fingerprint through the marker contract", async () => {
		const r = await captureParityFingerprint(devLauncher, "dev", fakeSpawn(), PARITY_PROBE_CAP_MS);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.fp.tools.map((t) => t.n)).toContain("read");
	});
	test("marker missing → ok:false (FAIL, never skip)", async () => {
		const r = await captureParityFingerprint(devLauncher, "dev", fakeSpawn({ devFp: null }), PARITY_PROBE_CAP_MS);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("marker");
	});
	test("probe source keys its mode off PARITY_MODE (the env contract capture relies on)", () => {
		expect(PARITY_PROBE_SOURCE).toContain("process.env.PARITY_MODE");
	});
});

describe("deriveExcludedExtensions", () => {
	test("ok:true against the real repo registry (in-repo determinism)", () => {
		const r = deriveExcludedExtensions(resolve(import.meta.dir, "..", ".."));
		expect(r.ok).toBe(true);
		if (r.ok) expect(Array.isArray(r.excluded)).toBe(true);
	});
	test("ok:false — a bunAppsDir with no registry packages throws → structured error, never a throw", () => {
		const empty = mkdtempSync(join(tmpdir(), "parity-no-registry-"));
		try {
			const r = deriveExcludedExtensions(empty);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});

describe("runDeployE2e parity probe", () => {
	test("pass when surfaces match; providers identical", async () => {
		makeTree();
		const r = await runDeployE2e({ versionDir, spawn: fakeSpawn(), devLauncher });
		const p = r.probes.find((x) => x.id === "parity")!;
		expect(p.verdict).toBe("pass");
	});
	test("fail when a shared tool hash drifts", async () => {
		makeTree();
		const drifted = { ...DEPLOY_FP, tools: DEPLOY_FP.tools.map((t) => ({ ...t, sh: t.n === "merge_pr_after_local_ci" ? "999" : t.sh })) };
		const r = await runDeployE2e({ versionDir, spawn: fakeSpawn({ deployFp: drifted }), devLauncher });
		const p = r.probes.find((x) => x.id === "parity")!;
		expect(p.verdict).toBe("fail");
		expect(p.note).toContain("hash-drift-tool");
	});
	test("fail when dev-only tool is unattributed (real registry exclusion list applies)", async () => {
		makeTree();
		const stray = { ...DEV_FP, tools: [...DEV_FP.tools, { n: "stray", s: "builtin", p: "<builtin:stray>", dh: "9", sh: "9" }] };
		const r = await runDeployE2e({ versionDir, spawn: fakeSpawn({ devFp: stray }), devLauncher });
		const p = r.probes.find((x) => x.id === "parity")!;
		expect(p.verdict).toBe("fail");
		expect(p.note).toContain("unattributed-dev-tool");
	});
	test("fail when providers lists differ", async () => {
		makeTree();
		const r = await runDeployE2e({ versionDir, spawn: fakeSpawn({ devModels: "id\nprovider/glm-5.3\n" }), devLauncher });
		const p = r.probes.find((x) => x.id === "parity")!;
		expect(p.verdict).toBe("fail");
		expect(p.note).toContain("providers");
	});
	test("skip (not fail) when devLauncher is absent", async () => {
		makeTree();
		const r = await runDeployE2e({ versionDir, spawn: fakeSpawn() });
		const p = r.probes.find((x) => x.id === "parity")!;
		expect(p.verdict).toBe("skip");
		expect(p.note).toContain("dev-launcher");
	});
});
