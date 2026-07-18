/**
 * Vault-config resolution — the personal (~/.pi) tier, precedence, stale
 * fall-through, scope-aware writes, and the one-time run-dir migration.
 *
 *   bun test extensions/__tests__/vaultConfig.test.mjs
 *
 * Hermetic: redirects `process.env.HOME` to a temp dir so the real `~/.pi` and
 * the real Obsidian app registry are never touched. Every test that resolves
 * keeps a personal/project config (or env) in play so resolution never depends
 * on the non-hermetic app-open tier (Tier 2).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
	resolveVault,
	writeVaultConfig,
	readPersonalConfig,
	readProjectConfig,
	personalConfigPath,
	projectConfigPath,
	runDirConfigPath,
} from "../obsidian.ts";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ORIG_HOME = process.env.HOME;
const ORIG_ENV = process.env.OB_VAULT_PATH;
const ORIG_GLOBAL = process.env.OB_USE_GLOBAL;

let tmpHome;
let projectDir;

async function makeVault(p) {
	await mkdir(p, { recursive: true });
	return p;
}

beforeEach(async () => {
	tmpHome = await mkdtemp(join(tmpdir(), "obhome-"));
	projectDir = await mkdtemp(join(tmpdir(), "obproj-"));
	process.env.HOME = tmpHome;
	delete process.env.OB_VAULT_PATH;
	delete process.env.OB_USE_GLOBAL;
});

afterEach(async () => {
	process.env.HOME = ORIG_HOME;
	if (ORIG_ENV) process.env.OB_VAULT_PATH = ORIG_ENV;
	else delete process.env.OB_VAULT_PATH;
	if (ORIG_GLOBAL) process.env.OB_USE_GLOBAL = ORIG_GLOBAL;
	await rm(tmpHome, { force: true }).catch(() => {});
	await rm(projectDir, { force: true }).catch(() => {});
});

describe("config paths", () => {
	it("personalConfigPath is ~/.pi/obsidian_config.json under HOME", () => {
		expect(personalConfigPath()).toBe(join(tmpHome, ".pi", "obsidian_config.json"));
	});

	it("projectConfigPath is <cwd>/.pi/obsidian_config.json", () => {
		expect(projectConfigPath(projectDir)).toBe(
			join(projectDir, ".pi", "obsidian_config.json"),
		);
	});
});

describe("read helpers", () => {
	it("readPersonalConfig returns {} when absent", async () => {
		expect(await readPersonalConfig()).toEqual({});
	});

	it("readProjectConfig returns {} when absent", async () => {
		expect(await readProjectConfig(projectDir)).toEqual({});
	});
});

describe("writeVaultConfig scope", () => {
	it("default scope = personal (writes ~/.pi)", async () => {
		const v = await makeVault(join(tmpHome, "pv"));
		await writeVaultConfig(projectDir, { vault_path: v, mode: "explicit" });
		const cfg = await readPersonalConfig();
		expect(cfg.vault_path).toBe(v);
		expect(cfg.mode).toBe("explicit");
		// project config untouched
		expect(await readProjectConfig(projectDir)).toEqual({});
	});

	it("scope=project writes <cwd>/.pi", async () => {
		const v = await makeVault(join(tmpHome, "qv"));
		await writeVaultConfig(projectDir, { vault_path: v }, "project");
		const cfg = await readProjectConfig(projectDir);
		expect(cfg.vault_path).toBe(v);
		// personal config untouched
		expect(await readPersonalConfig()).toEqual({});
	});

	it("personal scope rejects mode:app", async () => {
		await expect(
			writeVaultConfig(projectDir, { mode: "app" }, "personal"),
		).rejects.toThrow(/mode:"app".*personal tier/);
	});

	it("project scope accepts mode:app", async () => {
		await writeVaultConfig(projectDir, { mode: "app" }, "project");
		expect((await readProjectConfig(projectDir)).mode).toBe("app");
	});

	it("drops an empty vault_path rather than persisting \"\"", async () => {
		await writeVaultConfig(projectDir, { vault_path: "/x" }, "personal");
		await writeVaultConfig(projectDir, { vault_path: "" }, "personal");
		expect((await readPersonalConfig()).vault_path).toBeUndefined();
	});
});

describe("resolveVault precedence", () => {
	it("personal tier wins when set (source: personal)", async () => {
		const v = await makeVault(join(tmpHome, "pv"));
		await writeVaultConfig(projectDir, { vault_path: v }, "personal");
		const r = await resolveVault(projectDir);
		expect(r.source).toBe("personal");
		expect(r.path).toBe(v);
	});

	it("personal wins over project", async () => {
		const pv = await makeVault(join(tmpHome, "pv"));
		const qv = await makeVault(join(tmpHome, "qv"));
		await writeVaultConfig(projectDir, { vault_path: pv }, "personal");
		await writeVaultConfig(projectDir, { vault_path: qv }, "project");
		const r = await resolveVault(projectDir);
		expect(r.source).toBe("personal");
		expect(r.path).toBe(pv);
	});

	it("OB_VAULT_PATH env beats personal", async () => {
		const pv = await makeVault(join(tmpHome, "pv"));
		const envV = await makeVault(join(tmpHome, "env"));
		await writeVaultConfig(projectDir, { vault_path: pv }, "personal");
		process.env.OB_VAULT_PATH = envV;
		const r = await resolveVault(projectDir);
		expect(r.source).toBe("env");
		expect(r.path).toBe(envV);
	});

	it("project wins when personal is absent (source: config)", async () => {
		const qv = await makeVault(join(tmpHome, "qv"));
		await writeVaultConfig(projectDir, { vault_path: qv }, "project");
		const r = await resolveVault(projectDir);
		expect(r.source).toBe("config");
		expect(r.path).toBe(qv);
	});
});

describe("resolveVault stale fall-through (personal tier)", () => {
	it("personal mode:app falls through to project + propagates staleReason", async () => {
		const qv = await makeVault(join(tmpHome, "qv"));
		await writeVaultConfig(projectDir, { vault_path: qv }, "project");
		// Hand-edit a mode:app into the personal config (writeVaultConfig would refuse it).
		await mkdir(join(tmpHome, ".pi"), { recursive: true });
		await writeFile(personalConfigPath(), JSON.stringify({ mode: "app" }));
		const r = await resolveVault(projectDir);
		expect(r.source).toBe("config");
		expect(r.path).toBe(qv);
		expect(r.staleReason).toMatch(/personal config.*mode.*app.*not honored/);
	});

	it("stale personal vault_path falls through to project + propagates staleReason", async () => {
		const qv = await makeVault(join(tmpHome, "qv"));
		await writeVaultConfig(projectDir, { vault_path: qv }, "project");
		await mkdir(join(tmpHome, ".pi"), { recursive: true });
		await writeFile(
			personalConfigPath(),
			JSON.stringify({ vault_path: "/no/such/vault" }),
		);
		const r = await resolveVault(projectDir);
		expect(r.source).toBe("config");
		expect(r.staleReason).toMatch(
			/personal config vault_path.*does not exist/,
		);
	});
});

describe("run-dir one-time migration", () => {
	it("migrates a retired run-dir config into <cwd>/.pi on first read", async () => {
		const legacy = runDirConfigPath();
		// Start clean: no legacy, no project config.
		await rm(legacy, { force: true });
		await rm(projectConfigPath(projectDir), { force: true });
		try {
			// Seed the retired run-dir location with a config.
			await mkdir(runDirConfigPath().replace(/obsidian_config\.json$/, ""), {
				recursive: true,
			});
			await writeFile(legacy, JSON.stringify({ vault_path: "/migrated/vault" }));

			expect(existsSync(projectConfigPath(projectDir))).toBe(false);
			const cfg = await readProjectConfig(projectDir);
			// Migrated into the project location.
			expect(cfg.vault_path).toBe("/migrated/vault");
			expect(existsSync(projectConfigPath(projectDir))).toBe(true);
			// Retired run-dir config removed so it won't re-migrate.
			expect(existsSync(legacy)).toBe(false);
		} finally {
			await rm(legacy, { force: true }).catch(() => {});
		}
	});
});
