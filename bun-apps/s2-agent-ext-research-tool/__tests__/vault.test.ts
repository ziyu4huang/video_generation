import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVaultRoot, resolveWritePath } from "../lib/vault.ts";

let tmp: string;
let origHome: string | undefined;
let origVault: string | undefined;

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "vault-"));
	origHome = process.env.HOME;
	origVault = process.env.OB_VAULT_PATH;
	process.env.HOME = tmp; // personal ~/.pi → <tmp>/.pi
	delete process.env.OB_VAULT_PATH;
});

afterEach(async () => {
	if (origHome === undefined) delete process.env.HOME;
	else process.env.HOME = origHome;
	if (origVault === undefined) delete process.env.OB_VAULT_PATH;
	else process.env.OB_VAULT_PATH = origVault;
	await rm(tmp, { recursive: true, force: true });
});

test("resolveVaultRoot: OB_VAULT_PATH env resolves (Tier 1a)", async () => {
	const vault = join(tmp, "envvault");
	await mkdir(vault, { recursive: true });
	process.env.OB_VAULT_PATH = vault;
	expect(await resolveVaultRoot(tmp)).toBe(vault);
});

test("resolveVaultRoot: personal ~/.pi vault_path resolves (Tier 1b)", async () => {
	const vault = join(tmp, "myvault");
	await mkdir(vault, { recursive: true });
	await mkdir(join(tmp, ".pi"), { recursive: true });
	await writeFile(
		join(tmp, ".pi", "obsidian_config.json"),
		JSON.stringify({ vault_path: vault }),
	);
	const cwd = await mkdtemp(join(tmpdir(), "cwd-"));
	try {
		expect(await resolveVaultRoot(cwd)).toBe(vault);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("resolveVaultRoot: project <cwd>/.pi vault_path resolves (Tier 1c)", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cwd-"));
	const vault = join(cwd, "projvault");
	await mkdir(vault, { recursive: true });
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(
		join(cwd, ".pi", "obsidian_config.json"),
		JSON.stringify({ vault_path: vault }),
	);
	try {
		expect(await resolveVaultRoot(cwd)).toBe(vault);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("resolveVaultRoot: throws actionable error when no vault resolves", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cwd-"));
	try {
		let err: unknown;
		try {
			await resolveVaultRoot(cwd);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(Error);
		const msg = (err as Error).message;
		expect(msg).toMatch(/No active Obsidian vault resolved/);
		expect(msg).toMatch(/OB_VAULT_PATH/);
		expect(msg).toMatch(/obsidian-config/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("resolveWritePath: explicit outputPath bypasses vault resolution (no throw)", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cwd-"));
	try {
		const out = await resolveWritePath(cwd, "x.md", join(cwd, "out", "x.md"));
		expect(out).toBe(join(cwd, "out", "x.md"));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
