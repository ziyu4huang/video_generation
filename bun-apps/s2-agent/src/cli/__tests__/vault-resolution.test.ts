/**
 * resolveVaultPath (plain flavor) — vault-resolution hardening (#2054/#2055).
 *
 * Hermetic: HOME is redirected to a temp dir so the personal-config tier
 * (~/.pi/obsidian_config.json) is seeded per-test, never read from the real
 * machine; cwd is a parameter, not the process cwd. Every tier test asserts
 * its premise inline (the config file / vault dir exists, or deliberately
 * doesn't) — the mutation check for this file is reverting the config-tier
 * insertion in vault-paths.ts, under which the personal-config and
 * explicit-refusal tests must FAIL, not pass vacuously.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVaultPath } from "../vault-paths.ts";
import { parsePiArgs } from "../args.ts";

let home: string;
let cwd: string;
const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "vault-res-home-"));
	cwd = mkdtempSync(join(tmpdir(), "vault-res-cwd-"));
	for (const k of ["HOME", "OB_VAULT_PATH", "OB_VAULT_DIR"]) {
		SAVED[k] = process.env[k];
		delete process.env[k];
	}
	process.env.HOME = home;
});

afterEach(() => {
	for (const [k, v] of Object.entries(SAVED)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(home, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

function parsed(over: Record<string, unknown> = {}): Parameters<typeof resolveVaultPath>[0] {
	return { ...emptyParsedLike(), ...over } as Parameters<typeof resolveVaultPath>[0];
}

// Minimal ParsedArgs stand-in — resolveVaultPath reads only these fields.
function emptyParsedLike() {
	return { dryRun: false, vault: undefined, vaultDir: undefined, vaultCreate: false };
}

function writePersonalConfig(cfg: object) {
	mkdirSync(join(home, ".pi"), { recursive: true });
	writeFileSync(
		join(home, ".pi", "obsidian_config.json"),
		JSON.stringify(cfg, null, 2),
	);
}

// ── 1a. explicit: missing target refuses (#2055) ────────────────────────────

describe("explicit --vault / OB_VAULT_PATH", () => {
	test("missing --vault target REFUSES instead of silently seeding", () => {
		const missing = join(cwd, "typo-vault");
		expect(existsSync(missing)).toBe(false); // premise
		expect(() => resolveVaultPath(parsed({ vault: missing }), cwd)).toThrow(
			/does not exist/,
		);
		expect(existsSync(missing)).toBe(false); // nothing was written
	});

	test("missing OB_VAULT_PATH env target refuses too", () => {
		const missing = join(cwd, "env-typo-vault");
		process.env.OB_VAULT_PATH = missing;
		expect(() => resolveVaultPath(parsed(), cwd)).toThrow(/does not exist/);
		expect(existsSync(missing)).toBe(false);
	});

	test("--vault-create seeds the explicit target deliberately", () => {
		const fresh = join(cwd, "new-vault");
		expect(existsSync(fresh)).toBe(false);
		const got = resolveVaultPath(parsed({ vault: fresh, vaultCreate: true }), cwd);
		expect(got).toBe(fresh);
		expect(existsSync(fresh)).toBe(true);
	});

	test("--vault-create is suppressed under --dry-run", () => {
		const fresh = join(cwd, "dry-vault");
		const got = resolveVaultPath(
			parsed({ vault: fresh, vaultCreate: true, dryRun: true }),
			cwd,
		);
		expect(got).toBe(fresh);
		expect(existsSync(fresh)).toBe(false); // dry-run writes nothing
	});

	test("existing --vault target passes through unchanged", () => {
		const vault = join(cwd, "real-vault");
		mkdirSync(vault);
		expect(resolveVaultPath(parsed({ vault }), cwd)).toBe(vault);
	});
});

// ── 1c/1d. obsidian config tiers (#2054) ────────────────────────────────────

describe("obsidian config tiers", () => {
	test("personal config (~/.pi) vault_path wins over the cwd fallback (#2054)", () => {
		const vault = join(home, "study-news");
		mkdirSync(vault, { recursive: true });
		writePersonalConfig({ vault_path: vault, mode: "explicit" });
		// Premise: the config exists and the fallback dir does NOT — the old
		// resolver returned <cwd>/vault here (the filed foot-gun).
		expect(existsSync(join(cwd, "vault"))).toBe(false);
		expect(resolveVaultPath(parsed(), cwd)).toBe(vault);
		expect(existsSync(join(cwd, "vault"))).toBe(false); // fallback never seeded
	});

	test("personal config mode:'app' is not honored — falls through", () => {
		const vault = join(home, "app-vault");
		mkdirSync(vault, { recursive: true });
		writePersonalConfig({ vault_path: vault, mode: "app" });
		expect(resolveVaultPath(parsed(), cwd)).toBe(join(cwd, "vault"));
	});

	test("stale personal vault_path falls through to the fallback (warn, not abort)", () => {
		writePersonalConfig({ vault_path: join(home, "moved-away"), mode: "explicit" });
		expect(existsSync(join(home, "moved-away"))).toBe(false); // premise
		expect(resolveVaultPath(parsed(), cwd)).toBe(join(cwd, "vault"));
	});

	test("project config (<cwd>/.pi) is used when the personal tier is absent", () => {
		const vault = join(cwd, "project-vault");
		mkdirSync(vault);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "obsidian_config.json"),
			JSON.stringify({ vault_path: vault }),
		);
		expect(resolveVaultPath(parsed(), cwd)).toBe(vault);
	});

	test("personal tier outranks the project tier", () => {
		const personal = join(home, "personal-vault");
		const project = join(cwd, "project-vault");
		mkdirSync(personal, { recursive: true });
		mkdirSync(project);
		writePersonalConfig({ vault_path: personal });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "obsidian_config.json"),
			JSON.stringify({ vault_path: project }),
		);
		expect(resolveVaultPath(parsed(), cwd)).toBe(personal);
	});

	test("project config mode:'app' is skipped — falls to the cwd fallback", () => {
		const vault = join(cwd, "project-vault");
		mkdirSync(vault);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "obsidian_config.json"),
			JSON.stringify({ vault_path: vault, mode: "app" }),
		);
		expect(resolveVaultPath(parsed(), cwd)).toBe(join(cwd, "vault"));
	});

	test("stale project config vault_path falls through to the fallback", () => {
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "obsidian_config.json"),
			JSON.stringify({ vault_path: join(cwd, "gone") }),
		);
		expect(existsSync(join(cwd, "gone"))).toBe(false); // premise
		expect(resolveVaultPath(parsed(), cwd)).toBe(join(cwd, "vault"));
	});

	test("an existing <cwd>/vault bypassed by the personal config is NOT consumed", () => {
		const vault = join(home, "config-vault");
		mkdirSync(vault, { recursive: true });
		writePersonalConfig({ vault_path: vault });
		const local = join(cwd, "vault");
		mkdirSync(local); // pre-seeded local tree — must stay untouched
		expect(resolveVaultPath(parsed(), cwd)).toBe(vault);
		// The bypass notice is stderr-only; the observable contract is that the
		// local tree still exists and was not merged into or deleted.
		expect(existsSync(local)).toBe(true);
	});
});

// ── 1b vs configs + Tier 3 fallback ─────────────────────────────────────────

describe("precedence + fallback seeding", () => {
	test("--vault-dir outranks the personal config (explicit CLI intent)", () => {
		const vault = join(home, "config-vault");
		mkdirSync(vault, { recursive: true });
		writePersonalConfig({ vault_path: vault });
		const named = resolveVaultPath(parsed({ vaultDir: "notes" }), cwd);
		expect(named).toBe(join(cwd, "notes"));
	});

	test("zero-config fallback seeds <cwd>/vault (first-run behavior kept)", () => {
		const got = resolveVaultPath(parsed(), cwd);
		expect(got).toBe(join(cwd, "vault"));
		expect(existsSync(got)).toBe(true);
	});

	test("zero-config fallback under --dry-run creates nothing", () => {
		const got = resolveVaultPath(parsed({ dryRun: true }), cwd);
		expect(got).toBe(join(cwd, "vault"));
		expect(existsSync(got)).toBe(false);
	});
});

// ── CLI wiring: --vault-create must survive the real arg parser ─────────────

describe("--vault-create CLI wiring", () => {
	test("parsePiArgs maps --vault-create onto parsed.vaultCreate", () => {
		const p = parsePiArgs(["zk-ingest", "note.md", "--vault", "/v", "--vault-create"]);
		expect(p.vault).toBe("/v");
		expect(p.vaultCreate).toBe(true);
	});
});
