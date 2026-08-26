/**
 * Shared vault-path resolution for the `cli` command surface.
 *
 * One home for the vault-resolution rules that every knowledge/vault command
 * shares (previously copy-pasted in five commands). Plain flavor order
 * (mirrors the obsidian ext ladder, `s2-agent-ext-obsidian/src/lib/vault-resolution.ts`):
 *
 *   1a. explicit:  --vault flag, else OB_VAULT_PATH env (relative → cwd-resolved)
 *       — nonexistent target REFUSES unless --vault-create (#2055: a typo must
 *         not silently seed a fresh tree)
 *   1b. named:     --vault-dir flag / OB_VAULT_DIR env under cwd (session-scoped
 *       explicit intent outranks the file tiers below)
 *   1c. personal:  ~/.pi/obsidian_config.json vault_path (mode:"app" skipped —
 *       the personal tier is explicit-only, same as the ext)
 *   1d. project:   <cwd>/.pi/obsidian_config.json vault_path when mode != "app"
 *   3.  fallback:  <defaultDir> under cwd, auto-seeded
 *
 * Config tiers (1c/1d) whose target is missing warn on stderr and fall
 * through instead of aborting (ext stale-config semantics). Nothing is ever
 * created under --dry-run.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, isAbsolute, join } from "node:path";
import type { ParsedArgs } from "./args.ts";
// Canonical config-path builders from the obsidian ext (the tier ladder this
// resolver mirrors); importing them also keeps the config FILENAME literal out
// of CLI sources — the tool-name contract guard scans for obsidian_* tokens.
import {
	personalConfigPath,
	projectConfigPath,
} from "@repo/s2-agent-ext-obsidian/src/lib/vault-resolution.ts";

export interface VaultPathOptions {
	/** Fallback dir name under cwd when no flag/env is set. Default "vault". */
	defaultDir?: string;
}

/** Minimal schema of the two obsidian_config.json locations (see the ext's
 *  VaultConfigFile for the full story; the CLI only reads these two keys). */
interface VaultConfigFile {
	vault_path?: string;
	mode?: "explicit" | "app";
}

/** Read an obsidian_config.json-shaped file; {} when absent/unparseable. */
function readVaultConfig(path: string): VaultConfigFile {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as VaultConfigFile;
	} catch {
		return {};
	}
}

/** The plain flavor: explicit → named → personal/project config → <cwd> fallback. */
export function resolveVaultPath(
	parsed: ParsedArgs,
	cwd: string,
	opts: VaultPathOptions = {},
): string {
	const dryRun = parsed.dryRun === true;

	// ---- 1a. explicit: --vault flag / OB_VAULT_PATH env -------------------
	const explicit = parsed.vault ?? process.env.OB_VAULT_PATH;
	if (explicit) {
		const abs = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
		if (!existsSync(abs)) {
			if (parsed.vaultCreate === true) {
				// Deliberate seeding intent: create (unless dry-run previews it).
				if (!dryRun) {
					mkdirSync(abs, { recursive: true });
					console.error(
						`vault:   ${abs} did not exist — seeded (--vault-create)`,
					);
				}
			} else {
				throw new Error(
					`Vault path does not exist: ${abs}\n` +
						`  An explicit --vault (or OB_VAULT_PATH) pointing at a missing directory is\n` +
						`  treated as a typo, not a first run — nothing was written. To seed a new\n` +
						`  vault tree there deliberately, pass --vault-create.`,
				);
			}
		}
		return abs;
	}

	// ---- 1b. named: --vault-dir flag / OB_VAULT_DIR env under cwd ---------
	// Deliberate divergence from the ext ladder (where OB_VAULT_DIR is a
	// Tier-3 dir name only): here it is session-scoped explicit intent and
	// outranks the ambient file tiers below — the historical CLI contract.
	const dir = opts.defaultDir ?? "vault";
	const named = parsed.vaultDir ?? process.env.OB_VAULT_DIR;
	if (named) {
		const abs = resolve(cwd, named);
		if (!existsSync(abs)) {
			if (dryRun) return abs;
			mkdirSync(abs, { recursive: true });
			console.error(`vault:   ${abs} did not exist — seeded (--vault-dir)`);
		}
		return abs;
	}

	// A locally seeded tree that the config tiers below are about to bypass
	// deserves a notice — otherwise pre-existing <cwd>/vault data silently
	// disappears from these commands' view (the #2054 population).
	const bypassed = join(cwd, dir);

	// ---- 1c. personal config ~/.pi/obsidian_config.json --------------------
	const personalPath = personalConfigPath();
	const personal = readVaultConfig(personalPath);
	if (personal.mode === "app") {
		// Personal tier honors vault_path ONLY (ext parity): mode:"app" is
		// recorded as unsupported here and resolution falls through.
		console.error(
			`vault:   ${personalPath} has mode:"app" — not honored at the personal tier; falling through`,
		);
	} else if (personal.vault_path) {
		const p = isAbsolute(personal.vault_path)
			? personal.vault_path
			: resolve(personalPath, "..", "..", personal.vault_path);
		if (existsSync(p)) {
			if (existsSync(bypassed)) {
				console.error(
					`vault:   bypassing existing ${bypassed} — personal config takes precedence`,
				);
			}
			return p;
		}
		console.error(
			`vault:   personal config vault_path="${personal.vault_path}" does not exist — falling through`,
		);
	}

	// ---- 1d. project config <cwd>/.pi/obsidian_config.json -----------------
	const projectPath = projectConfigPath(cwd);
	const project = readVaultConfig(projectPath);
	if (project.mode !== "app" && project.vault_path) {
		const p = isAbsolute(project.vault_path)
			? project.vault_path
			: resolve(cwd, project.vault_path);
		if (existsSync(p)) {
			if (existsSync(bypassed)) {
				console.error(
					`vault:   bypassing existing ${bypassed} — project config takes precedence`,
				);
			}
			return p;
		}
		console.error(
			`vault:   project config vault_path="${project.vault_path}" does not exist — falling through`,
		);
	}

	// ---- 3. fallback: <cwd>/<defaultDir>, auto-seeded ----------------------
	const abs = resolve(cwd, dir);
	if (!existsSync(abs)) {
		if (dryRun) return abs;
		mkdirSync(abs, { recursive: true });
		console.error(
			`vault:   no --vault/--vault-dir and no config vault — seeded fallback ${abs}`,
		);
	}
	return abs;
}

export interface VaultWalkUpOptions {
	/** Fallback dir (may itself contain path segments). Required here because the two callers disagree. */
	defaultDir: string;
	/** Create the dir when the walk finds nothing. knowledge-pipeline wants this; memory-to-vault does not. */
	mkdirIfMissing?: boolean;
}

/**
 * Apply vault-related flags to the process environment RAW (obsidian reads
 * these): --vault → OB_VAULT_PATH, --vault-dir → OB_VAULT_DIR, each only when
 * the flag is present (a pre-existing env value is never cleared). Used by the
 * agent-driving commands that do NOT resolve the vault themselves (passthrough,
 * zk-ask, zk-card, file2md, url-to-vault).
 */
export function applyVaultEnv(parsed: ParsedArgs): void {
	if (parsed.vault) process.env.OB_VAULT_PATH = parsed.vault;
	if (parsed.vaultDir) process.env.OB_VAULT_DIR = parsed.vaultDir;
}

/**
 * Publish a RESOLVED vault path to the environment: OB_VAULT_PATH = the path a
 * resolveVaultPath* call just returned (overriding any raw --vault value, which
 * is what the deterministic vault commands want — the extension should see the
 * concrete location, and resolveVaultPath already honored the flag). This is
 * the post-resolve half zk-ingest / zk-query / zk-extract / memory-to-vault /
 * knowledge-pipeline each repeated inline.
 *
 * `opts.vaultDir` (zk-extract only) additionally forwards the raw --vault-dir
 * flag as OB_VAULT_DIR. The other commands never set it and their env bytes
 * must not change, so the half is opt-in.
 *
 * Stderr headers stay at each call site: the commands' `vault:` lines differ in
 * alignment and presence (zk-query's health mode prints none), so folding them
 * in here would change output bytes.
 */
export function applyResolvedVaultEnv(
	parsed: ParsedArgs,
	vaultPath: string,
	opts: { vaultDir?: boolean } = {},
): void {
	if (opts.vaultDir && parsed.vaultDir) process.env.OB_VAULT_DIR = parsed.vaultDir;
	process.env.OB_VAULT_PATH = vaultPath;
}

/**
 * The convergence-sink flavor: like resolveVaultPath's explicit arm, but the
 * fallback walks UP from cwd looking for an EXISTING <search>/<dir> (the shared
 * sink may live at the repo root while the command runs in a subdir), then
 * optionally creates it under cwd.
 */
export function resolveVaultPathWalkUp(
	parsed: ParsedArgs,
	cwd: string,
	opts: VaultWalkUpOptions,
): string {
	const explicit = parsed.vault ?? process.env.OB_VAULT_PATH;
	if (explicit) {
		const abs = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
		if (opts.mkdirIfMissing && !existsSync(abs)) mkdirSync(abs, { recursive: true });
		return abs;
	}
	const dir = parsed.vaultDir ?? opts.defaultDir;
	let search = cwd;
	for (let i = 0; i < 10; i++) {
		const candidate = join(search, dir);
		if (existsSync(candidate)) return candidate;
		const parent = resolve(search, "..");
		if (parent === search) break;
		search = parent;
	}
	const abs = resolve(cwd, dir);
	if (opts.mkdirIfMissing && !existsSync(abs)) mkdirSync(abs, { recursive: true });
	return abs;
}
