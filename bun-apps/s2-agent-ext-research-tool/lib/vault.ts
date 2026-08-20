/**
 * Output-directory resolution — re-aligned to the obsidian extension's vault
 * tiers so collected Markdown lands in the SAME active vault the obsidian tools
 * operate on.
 *
 *   Tier 1a. OB_VAULT_PATH env (absolute)
 *   Tier 1b. personal config ~/.pi/obsidian_config.json { vault_path }
 *            (the tier that was MISSING before — the user-global default)
 *   Tier 1c. project config <cwd>/.pi/obsidian_config.json { vault_path }
 *            when mode != "app"
 *
 * DELIBERATE divergence from obsidian-lib.resolveVault: when no Tier-1 vault
 * resolves, this resolver THROWS (a paper/notes tool must not auto-create or
 * seed a vault, nor chase the Obsidian app's open vault). Callers MUST either
 * have a resolvable vault or pass an explicit outputPath/vaultRoot.
 *
 * Drift guard: __tests__/vault-parity.test.ts dev-imports obsidian-lib and
 * asserts this resolver agrees with resolveVault() for every Tier-1 success
 * case. If obsidian-lib's tiers change, that test fails loudly.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, isAbsolute, join } from "node:path";

/** HOME base (honors process.env.HOME for testability; mirrors obsidian-lib._homeBase). */
function homeBase(): string {
	return process.env.HOME || homedir();
}

/** Personal (user-global) config path: ~/.pi/obsidian_config.json. Mirrors obsidian-lib.personalConfigPath. */
function personalConfigPath(): string {
	return join(homeBase(), ".pi", "obsidian_config.json");
}

/** Project (per-cwd) config path: <cwd>/.pi/obsidian_config.json. Mirrors obsidian-lib.projectConfigPath. */
function projectConfigPath(cwd: string): string {
	return resolve(cwd, ".pi", "obsidian_config.json");
}

interface VaultConfigFile {
	vault_path?: string;
	mode?: "explicit" | "app";
}

async function readConfig(p: string): Promise<VaultConfigFile> {
	try {
		return JSON.parse(await readFile(p, "utf8"));
	} catch {
		return {};
	}
}

/** Resolve the active vault root directory (absolute), or throw an actionable error. */
export async function resolveVaultRoot(cwd: string): Promise<string> {
	// Tier 1a — env
	const envPath = process.env.OB_VAULT_PATH;
	if (envPath && existsSync(envPath)) return envPath;

	// Tier 1b — personal ~/.pi (vault_path only; mode is a project-tier concept)
	const personal = await readConfig(personalConfigPath());
	if (personal.vault_path) {
		// Relative personal paths resolve against HOME (== obsidian-lib._homeBase), NOT cwd.
		const p = isAbsolute(personal.vault_path)
			? personal.vault_path
			: resolve(homeBase(), personal.vault_path);
		if (existsSync(p)) return p;
	}

	// Tier 1c — project <cwd>/.pi (only when mode != "app")
	const project = await readConfig(projectConfigPath(cwd));
	if (project.mode !== "app" && project.vault_path) {
		const p = isAbsolute(project.vault_path)
			? project.vault_path
			: resolve(cwd, project.vault_path);
		if (existsSync(p)) return p;
	}

	// No resolution — loud, actionable error (never a silent cwd fallback).
	throw new Error(
		`No active Obsidian vault resolved for research-tool. Tried (in order):\n` +
			`  1. OB_VAULT_PATH env — ${envPath ? `"${envPath}" not found` : "not set"}\n` +
			`  2. ${personalConfigPath()} (personal) — ${personal.vault_path ? "path not found" : "not set"}\n` +
			`  3. ${projectConfigPath(cwd)} (project) — ${project.vault_path ? "path not found" : "not set"}\n` +
			`Fix: set OB_VAULT_PATH to your vault, run \`/obsidian-config\` to register a vault, ` +
			`or pass an explicit outputPath/vaultRoot to this tool.`,
	);
}

/** Resolve the weekly-news output directory for the active vault. */
export async function resolveOutputDir(cwd: string): Promise<string> {
	return join(await resolveVaultRoot(cwd), "weekly-news");
}

/**
 * Resolve the final file path to write.
 * - If `outputPath` is given (absolute or cwd-relative), use it verbatim.
 * - Otherwise derive <vaultRoot>/weekly-news/<filename>.
 */
export async function resolveWritePath(
	cwd: string,
	filename: string,
	outputPath?: string,
): Promise<string> {
	if (outputPath) return isAbsolute(outputPath) ? outputPath : resolve(cwd, outputPath);
	return join(await resolveOutputDir(cwd), filename);
}

/** Ensure a directory exists (mkdir -p). */
export async function ensureDir(dir: string): Promise<void> {
	const { mkdir } = await import("node:fs/promises");
	await mkdir(dir, { recursive: true });
}
