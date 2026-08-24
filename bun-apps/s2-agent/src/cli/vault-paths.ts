/**
 * Shared vault-path resolution for the `cli` command surface.
 *
 * One home for the vault-resolution rules that every knowledge/vault command
 * shares (previously copy-pasted in five commands):
 *
 *   1. explicit: --vault flag, else OB_VAULT_PATH env (relative → cwd-resolved)
 *   2. default:  --vault-dir flag / OB_VAULT_DIR env / <defaultDir> under cwd
 *
 * Both flavors mkdir-if-missing so a first run on a fresh tree never crashes.
 */
import { existsSync, mkdirSync } from "node:fs";
import { resolve, isAbsolute, join } from "node:path";
import type { ParsedArgs } from "./args.ts";

export interface VaultPathOptions {
	/** Fallback dir name under cwd when no flag/env is set. Default "vault". */
	defaultDir?: string;
}

/** The plain flavor: `<cwd>/<vaultDir|OB_VAULT_DIR|defaultDir>`, no walk-up. */
export function resolveVaultPath(
	parsed: ParsedArgs,
	cwd: string,
	opts: VaultPathOptions = {},
): string {
	const dir = opts.defaultDir ?? "vault";
	const explicit = parsed.vault ?? process.env.OB_VAULT_PATH;
	if (explicit) {
		const abs = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
		if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
		return abs;
	}
	const rel = parsed.vaultDir ?? process.env.OB_VAULT_DIR ?? dir;
	const abs = resolve(cwd, rel);
	if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
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
