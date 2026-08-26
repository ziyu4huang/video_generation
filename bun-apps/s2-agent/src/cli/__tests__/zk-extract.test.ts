/**
 * commands/zk-extract.ts — the two pure resolution helpers.
 *
 * The command's `run()` drives a live agent session (already covered by
 * task-runner.test.ts + dispatch.test.ts), but `resolveInputs` and
 * resolveVault` are pure file/env resolution with branching + throws — prime
 * targets. Real filesystem under a temp dir; no network, no mocks.
 *
 *   bun test src/cli/__tests__/zk-extract.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resolveInputs,
	resolveVault,
} from "../commands/zk-extract.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "zkex-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

// --- resolveInputs ----------------------------------------------------------

describe("resolveInputs", () => {
	test("throws when no inputs are given", () => {
		expect(() => resolveInputs([], root)).toThrow(/No input files given/);
	});

	test("throws when a path does not exist", () => {
		expect(() => resolveInputs(["nope.md"], root)).toThrow(/Input not found/);
	});

	test("returns the absolute path for a single file", () => {
		writeFileSync(join(root, "a.md"), "x");
		const [only] = resolveInputs(["a.md"], root);
		expect(only).toBe(join(root, "a.md"));
	});

	test("accepts absolute input paths verbatim", () => {
		const abs = join(root, "abs.txt");
		writeFileSync(abs, "x");
		expect(resolveInputs([abs], "/some/other/cwd")).toEqual([abs]);
	});

	test("expands a folder recursively and keeps only .md/.txt family", () => {
		mkdirSync(join(root, "sub", "deep"), { recursive: true });
		writeFileSync(join(root, "a.md"), "");
		writeFileSync(join(root, "b.markdown"), "");
		writeFileSync(join(root, "c.txt"), "");
		writeFileSync(join(root, "d.text"), "");
		writeFileSync(join(root, "skip.json"), "");
		writeFileSync(join(root, "sub", "e.md"), "");
		writeFileSync(join(root, "sub", "deep", "f.txt"), "");

		const got = resolveInputs(["."], root);
		const names = got.map((p) => p.slice(root.length));
		expect(names).toContain("/a.md");
		expect(names).toContain("/b.markdown");
		expect(names).toContain("/c.txt");
		expect(names).toContain("/d.text");
		expect(names).toContain("/sub/e.md");
		expect(names).toContain("/sub/deep/f.txt");
		// Non md/txt is filtered out.
		expect(names.some((n) => n.endsWith(".json"))).toBe(false);
	});

	test("dedupes the same file reached via multiple inputs", () => {
		writeFileSync(join(root, "a.md"), "");
		const got = resolveInputs(["a.md", "a.md", join(root, "a.md")], root);
		expect(got).toEqual([join(root, "a.md")]);
	});

	test("output is sorted", () => {
		writeFileSync(join(root, "c.md"), "");
		writeFileSync(join(root, "a.md"), "");
		writeFileSync(join(root, "b.md"), "");
		const got = resolveInputs(["b.md", "a.md", "c.md"], root);
		expect(got).toEqual([
			join(root, "a.md"),
			join(root, "b.md"),
			join(root, "c.md"),
		]);
	});

	test("throws when a folder yields no md/txt files", () => {
		mkdirSync(join(root, "empty"), { recursive: true });
		writeFileSync(join(root, "empty", "x.json"), "");
		expect(() => resolveInputs(["empty"], root)).toThrow(
			/No markdown\/text files found/,
		);
	});
});

// --- resolveVault -----------------------------------------------------------

// HOME is redirected per-suite so the personal-config tier (~/.pi/…) reads a
// clean temp home, never the developer machine's real config (the tier is
// covered in depth by vault-resolution.test.ts).
const ENV_KEYS = ["OB_VAULT_PATH", "OB_VAULT_DIR", "HOME"] as const;
let saved: Record<string, string | undefined>;
let home: string;

beforeEach(() => {
	saved = {};
	for (const k of ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	home = mkdtempSync(join(tmpdir(), "zkex-home-"));
	process.env.HOME = home;
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	rmSync(home, { recursive: true, force: true });
});

function parsed(p: Partial<{ vault: string; vaultDir: string; vaultCreate: boolean }> = {}) {
	// Only the vault-related fields are read by resolveVault.
	return { vault: p.vault, vaultDir: p.vaultDir, vaultCreate: p.vaultCreate } as any;
}

describe("resolveVault", () => {
	test("--vault absolute + existing → returned verbatim", () => {
		const v = join(root, "myvault");
		mkdirSync(v, { recursive: true });
		expect(resolveVault(parsed({ vault: v }), root)).toBe(v);
	});

	test("--vault missing → REFUSED (typo guard, #2055); --vault-create seeds", () => {
		const v = join(root, "newvault");
		expect(existsSync(v)).toBe(false);
		expect(() => resolveVault(parsed({ vault: v }), root)).toThrow(/does not exist/);
		expect(existsSync(v)).toBe(false); // nothing seeded on refusal
		const got = resolveVault(parsed({ vault: v, vaultCreate: true }), root);
		expect(got).toBe(v);
		expect(existsSync(v)).toBe(true);
	});

	test("--vault relative → resolved against cwd", () => {
		mkdirSync(join(root, "rel-vault")); // explicit target must exist
		const got = resolveVault(parsed({ vault: "rel-vault" }), root);
		expect(got).toBe(join(root, "rel-vault"));
	});

	test("--vault-dir → <cwd>/<dir>, created", () => {
		const got = resolveVault(parsed({ vaultDir: "notes" }), root);
		expect(got).toBe(join(root, "notes"));
		expect(existsSync(got)).toBe(true);
	});

	test("no flags → <cwd>/vault (default dir name)", () => {
		const got = resolveVault(parsed({}), root);
		expect(got).toBe(join(root, "vault"));
		expect(existsSync(got)).toBe(true);
	});

	test("OB_VAULT_PATH env acts as the explicit-vault fallback", () => {
		mkdirSync(join(root, "envvault"));
		process.env.OB_VAULT_PATH = join(root, "envvault");
		const got = resolveVault(parsed({}), root);
		expect(got).toBe(join(root, "envvault"));
	});

	test("--vault beats OB_VAULT_PATH env", () => {
		mkdirSync(join(root, "envvault"));
		mkdirSync(join(root, "flagvault"));
		process.env.OB_VAULT_PATH = join(root, "envvault");
		const flag = join(root, "flagvault");
		const got = resolveVault(parsed({ vault: flag }), root);
		expect(got).toBe(flag);
	});

	test("OB_VAULT_DIR env fallback for the dir name", () => {
		process.env.OB_VAULT_DIR = "envdir";
		const got = resolveVault(parsed({}), root);
		expect(got).toBe(join(root, "envdir"));
	});
});
