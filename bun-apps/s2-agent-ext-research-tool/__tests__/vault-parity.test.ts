import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVaultRoot } from "../lib/vault.ts";
import { resolveVault as obsidianResolveVault } from "@repo/s2-agent-ext-obsidian/src/obsidian-lib.ts";

// Drift guard: research-tool's resolver must agree with obsidian-lib.resolveVault
// for every Tier-1 success case (env / personal ~/.pi / project <cwd>/.pi).
// The no-vault case deliberately diverges (research-tool throws; obsidian-lib
// auto-creates a Tier-3 ./vault) — that divergence lives in vault.test.ts.

let tmp: string;
let origHome: string | undefined;
let origVault: string | undefined;

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "vparity-"));
	origHome = process.env.HOME;
	origVault = process.env.OB_VAULT_PATH;
	process.env.HOME = tmp;
	delete process.env.OB_VAULT_PATH;
});

afterEach(async () => {
	if (origHome === undefined) delete process.env.HOME;
	else process.env.HOME = origHome;
	if (origVault === undefined) delete process.env.OB_VAULT_PATH;
	else process.env.OB_VAULT_PATH = origVault;
	await rm(tmp, { recursive: true, force: true });
});

test("parity: OB_VAULT_PATH env — research-tool == obsidian-lib", async () => {
	const vault = join(tmp, "envvault");
	await mkdir(vault, { recursive: true });
	process.env.OB_VAULT_PATH = vault;
	expect(await resolveVaultRoot(tmp)).toBe((await obsidianResolveVault(tmp)).path);
});

test("parity: personal ~/.pi — research-tool == obsidian-lib", async () => {
	const vault = join(tmp, "pervault");
	await mkdir(vault, { recursive: true });
	await mkdir(join(tmp, ".pi"), { recursive: true });
	await writeFile(
		join(tmp, ".pi", "obsidian_config.json"),
		JSON.stringify({ vault_path: vault }),
	);
	const cwd = await mkdtemp(join(tmpdir(), "cwd-"));
	try {
		expect(await resolveVaultRoot(cwd)).toBe((await obsidianResolveVault(cwd)).path);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("parity: personal ~/.pi with RELATIVE vault_path — research-tool == obsidian-lib", async () => {
	// Relative personal paths resolve against HOME (obsidian-lib._homeBase), so the
	// vault lives under tmp (== HOME); cwd is a DIFFERENT dir so a cwd-base would diverge.
	const vault = join(tmp, "relvault");
	await mkdir(vault, { recursive: true });
	await mkdir(join(tmp, ".pi"), { recursive: true });
	await writeFile(
		join(tmp, ".pi", "obsidian_config.json"),
		JSON.stringify({ vault_path: "relvault" }), // RELATIVE
	);
	const cwd = await mkdtemp(join(tmpdir(), "cwd-"));
	try {
		expect(await resolveVaultRoot(cwd)).toBe((await obsidianResolveVault(cwd)).path);
		expect(await resolveVaultRoot(cwd)).toBe(vault);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("parity: project <cwd>/.pi — research-tool == obsidian-lib", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cwd-"));
	const vault = join(cwd, "projvault");
	await mkdir(vault, { recursive: true });
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(
		join(cwd, ".pi", "obsidian_config.json"),
		JSON.stringify({ vault_path: vault }),
	);
	try {
		expect(await resolveVaultRoot(cwd)).toBe((await obsidianResolveVault(cwd)).path);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
