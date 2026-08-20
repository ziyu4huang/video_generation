import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	checkFlux2Binary,
	checkLmStudio,
	checkModelsDir,
	checkOutputDir,
	checkPiHome,
	checkProvider,
	checkRepoRoot,
	checkRunDir,
	checkRuntime,
	checkVault,
	findRepoRoot,
	isFailing,
	runAllChecks,
	type DoctorContext,
} from "../commands/doctor.ts";

/** Build a ctx rooted at a fresh temp repo with a `bun-apps/` marker. */
function makeCtx(opts: {
	env?: Record<string, string | undefined>;
	existsExtra?: (p: string) => boolean;
	probe?: (url: string) => Promise<boolean>;
	cwd?: string;
}): { ctx: DoctorContext; repo: string } {
	const repo = mkdtempSync(join(tmpdir(), "pi-doctor-"));
	mkdirSync(join(repo, "bun-apps"), { recursive: true });
	const exists = (p: string) => existsSync(p) || (opts.existsExtra?.(p) ?? false);
	const ctx: DoctorContext = {
		cwd: opts.cwd ?? repo,
		env: opts.env ?? {},
		bunVersion: "1.3.14",
		exists,
		probeLmStudio: opts.probe ?? (async () => false),
	};
	return { ctx, repo };
}

describe("findRepoRoot", () => {
	test("walks up to the dir containing bun-apps/", () => {
		const { ctx, repo } = makeCtx({});
		const nested = join(repo, "a", "b", "c");
		mkdirSync(nested, { recursive: true });
		expect(findRepoRoot(nested, ctx.exists)).toBe(repo);
	});

	test("returns undefined when no bun-apps/ ancestor exists", () => {
		const elsewhere = mkdtempSync(join(tmpdir(), "pi-norepo-"));
		expect(findRepoRoot(elsewhere, () => false)).toBeUndefined();
	});
});

describe("individual checks", () => {
	test("runtime: empty version fails", () => {
		const { ctx } = makeCtx({});
		ctx.bunVersion = "";
		expect(checkRuntime(ctx).status).toBe("fail");
	});

	test("runtime: version passes", () => {
		const { ctx } = makeCtx({});
		expect(checkRuntime(ctx).status).toBe("pass");
	});

	test("repo-root: fails when no bun-apps/ ancestor", () => {
		const elsewhere = mkdtempSync(join(tmpdir(), "pi-norepo-"));
		const { result } = checkRepoRoot({
			cwd: elsewhere,
			env: {},
			bunVersion: "1.0",
			exists: () => false,
			probeLmStudio: async () => false,
		});
		expect(result.status).toBe("fail");
		expect(isFailing(result)).toBe(true);
	});

	test("models-dir: absent → fail with actionable hint", () => {
		const { ctx } = makeCtx({});
		const r = checkModelsDir(ctx, ctx.cwd);
		expect(r.status).toBe("fail");
		expect(r.hint).toMatch(/MLX_MODELS_DIR/);
	});

	test("models-dir: present → pass", () => {
		const { ctx, repo } = makeCtx({});
		mkdirSync(join(repo, "mlx-models"), { recursive: true });
		expect(checkModelsDir(ctx, repo).status).toBe("pass");
	});

	test("models-dir: env override wins", () => {
		const custom = mkdtempSync(join(tmpdir(), "pi-models-"));
		const { ctx } = makeCtx({ env: { MLX_MODELS_DIR: custom } });
		expect(checkModelsDir(ctx, "/anywhere").status).toBe("pass");
	});

	test("output-dir: absent → warn (not fail; auto-created on write)", () => {
		// Pin to a nonexistent path via env so the default (shared tmpdir sibling)
		// can't leak leftover state from other tests/runs.
		const { ctx } = makeCtx({ env: { MLX_OUTPUT_DIR: "/nonexistent-output-xyz" } });
		const r = checkOutputDir(ctx, "/anywhere");
		expect(r.status).toBe("warn");
		expect(isFailing(r)).toBe(false);
	});

	test("output-dir: present → pass", () => {
		// Use an env override pointing at a unique path — the default resolves to
		// repo/../video_generation__output, a SHARED sibling under tmpdir() that
		// would leak across repos and break the "absent → warn" test.
		const out = mkdtempSync(join(tmpdir(), "pi-out-"));
		const { ctx } = makeCtx({ env: { MLX_OUTPUT_DIR: out } });
		expect(checkOutputDir(ctx, "/anywhere").status).toBe("pass");
	});

	test("flux2-binary: missing binary → warn (auto-builds)", () => {
		const { ctx, repo } = makeCtx({});
		expect(checkFlux2Binary(ctx, repo).status).toBe("warn");
	});

	test("flux2-binary: FLUX2_BIN present → pass", () => {
		const bin = mkdtempSync(join(tmpdir(), "pi-bin-"));
		const { ctx } = makeCtx({ env: { FLUX2_BIN: bin } });
		expect(checkFlux2Binary(ctx, "/anywhere").status).toBe("pass");
	});

	test("run-dir: missing manifest → warn", () => {
		const { ctx, repo } = makeCtx({});
		expect(checkRunDir(ctx, repo).status).toBe("warn");
	});

	test("run-dir: manifest with all-resolving paths → pass", () => {
		const { ctx, repo } = makeCtx({});
		const manifestDir = join(repo, "bun-apps", "s2-agent", "run-dir");
		mkdirSync(manifestDir, { recursive: true });
		mkdirSync(join(repo, "bun-apps", "s2-agent-ext-obsidian", "extensions"), { recursive: true });
		writeFileSync(join(repo, "bun-apps", "s2-agent-ext-obsidian", "extensions", "obsidian.ts"), "// ok");
		writeFileSync(
			join(manifestDir, "manifest.json"),
			JSON.stringify({ extensions: ["s2-agent-ext-obsidian/extensions/obsidian.ts"], skills: [] }),
		);
		expect(checkRunDir(ctx, repo).status).toBe("pass");
	});

	test("run-dir: manifest with MIXED-TYPE entries (strings + objects) → pass, no crash", () => {
		// Regression guard: the real manifest.json mixes plain strings +
		// objects ({ name, entry, version }). Before the fix,
		// join(bunApps, <object>) threw "paths[1] must be string, got object".
		const { ctx, repo } = makeCtx({});
		const manifestDir = join(repo, "bun-apps", "s2-agent", "run-dir");
		mkdirSync(manifestDir, { recursive: true });
		// Create both entry dirs so both resolve.
		mkdirSync(join(repo, "bun-apps", "s2-agent-ext-obsidian", "extensions"), { recursive: true });
		writeFileSync(join(repo, "bun-apps", "s2-agent-ext-obsidian", "extensions", "obsidian.ts"), "// ok");
		mkdirSync(join(repo, "bun-apps", "s2-agent-ext-hermes-memory", "src"), { recursive: true });
		writeFileSync(join(repo, "bun-apps", "s2-agent-ext-hermes-memory", "src", "index.ts"), "// ok");
		writeFileSync(
			join(manifestDir, "manifest.json"),
			JSON.stringify({
				extensions: [
					"s2-agent-ext-obsidian/extensions/obsidian.ts",
					{
						name: "s2-agent-ext-hermes-memory",
						entry: "s2-agent-ext-hermes-memory/src/index.ts",
						version: "0.80.3",
					},
				],
				skills: [],
			}),
		);
		const r = checkRunDir(ctx, repo);
		expect(r.status).toBe("pass");
		expect(r.detail).toMatch(/2 entries resolve/);
	});

	test("run-dir: mixed-type manifest with a MISSING object entry → warn (not crash)", () => {
		const { ctx, repo } = makeCtx({});
		const manifestDir = join(repo, "bun-apps", "s2-agent", "run-dir");
		mkdirSync(manifestDir, { recursive: true });
		writeFileSync(
			join(manifestDir, "manifest.json"),
			JSON.stringify({
				extensions: [
					{ name: "s2-agent-ext-missing", entry: "s2-agent-ext-missing/src/index.ts" },
				],
				skills: [],
			}),
		);
		const r = checkRunDir(ctx, repo);
		expect(r.status).toBe("warn");
		expect(r.detail).toMatch(/s2-agent-ext-missing/);
	});

	test("vault: OB_VAULT_PATH present → pass", () => {
		const v = mkdtempSync(join(tmpdir(), "pi-vault-"));
		const { ctx } = makeCtx({ env: { OB_VAULT_PATH: v } });
		expect(checkVault(ctx).status).toBe("pass");
	});

	test("vault: absent → info (auto-created on use)", () => {
		const { ctx } = makeCtx({});
		const r = checkVault(ctx);
		expect(r.status).toBe("info");
		expect(isFailing(r)).toBe(false);
	});

	test("lm-studio: unreachable → warn", async () => {
		const { ctx } = makeCtx({ probe: async () => false });
		expect((await checkLmStudio(ctx)).status).toBe("warn");
	});

	test("lm-studio: reachable → pass", async () => {
		const { ctx } = makeCtx({ probe: async () => true });
		expect((await checkLmStudio(ctx)).status).toBe("pass");
	});

	test("provider: always info", () => {
		const { ctx } = makeCtx({ env: { PI_PROVIDER: "zai", PI_MODEL: "gpt-5.2" } });
		const r = checkProvider(ctx);
		expect(r.status).toBe("info");
		expect(r.detail).toMatch(/zai.*gpt-5.2/);
	});

	test("pi-home: present → pass", () => {
		const home = mkdtempSync(join(tmpdir(), "pi-home-"));
		const { ctx } = makeCtx({ env: { PI_CODING_AGENT_DIR: home } });
		expect(checkPiHome(ctx).status).toBe("pass");
	});

	test("pi-home: absent → warn", () => {
		const { ctx } = makeCtx({ env: { PI_CODING_AGENT_DIR: "/nonexistent-pi-home" } });
		expect(checkPiHome(ctx).status).toBe("warn");
	});
});

describe("runAllChecks", () => {
	test("aggregate ok=false when models dir missing", async () => {
		const { ctx } = makeCtx({ probe: async () => true });
		const results = await runAllChecks(ctx);
		const models = results.find((r) => r.id === "models-dir")!;
		expect(models.status).toBe("fail");
		const fails = results.filter(isFailing);
		expect(fails.map((r) => r.id)).toContain("models-dir");
	});

	test("all-green when repo + models + lm-studio present", async () => {
		const { ctx, repo } = makeCtx({ probe: async () => true });
		mkdirSync(join(repo, "mlx-models"), { recursive: true });
		const home = mkdtempSync(join(tmpdir(), "pi-home-"));
		ctx.env.PI_CODING_AGENT_DIR = home;
		const results = await runAllChecks(ctx);
		expect(results.filter(isFailing)).toHaveLength(0);
	});

	test("returns at least the core checks in order", async () => {
		const { ctx } = makeCtx({});
		const results = await runAllChecks(ctx);
		const ids = results.map((r) => r.id);
		expect(ids.indexOf("runtime")).toBeLessThan(ids.indexOf("repo-root"));
		expect(ids).toContain("lm-studio");
		expect(ids).toContain("provider");
	});
});
