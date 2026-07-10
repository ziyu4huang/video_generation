/**
 * Output-directory resolution — mirrors the obsidian extension's vault tiers
 * (decoupled: no cross-package import) so collected Markdown lands in the same
 * active vault the obsidian tools operate on.
 *
 *   Tier 1a. OB_VAULT_PATH env (absolute)
 *   Tier 1b. run-dir/obsidian_config.json { vault_path } when mode != "app"
 *   Tier 1c. <cwd>/.pi/obsidian_config.json { vault_path } (legacy)
 *   Tier 2.  <cwd>  (fallback)
 *
 * The output dir is <vaultRoot>/weekly-news/. An explicit `outputPath` param
 * (absolute or cwd-relative) always wins and bypasses vault resolution.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the pi-agent run-dir/ from this extension's own path (source mode). */
function runDirPath(): string {
	const selfDir = dirname(fileURLToPath(import.meta.url));
	if (selfDir.includes("ext-bundles")) {
		return resolve(selfDir, "..", "run-dir");
	}
	return resolve(selfDir, "..", "..", "pi-agent", "run-dir");
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

/** Resolve the active vault root directory (absolute). */
export async function resolveVaultRoot(cwd: string): Promise<string> {
	// Tier 1a — env
	const envPath = process.env.OB_VAULT_PATH;
	if (envPath && existsSync(envPath)) return envPath;

	// Tier 1b — run-dir config
	const runDirCfg = join(runDirPath(), "obsidian_config.json");
	const cfg = await readConfig(runDirCfg);
	if (cfg.mode !== "app" && cfg.vault_path) {
		const p = isAbsolute(cfg.vault_path) ? cfg.vault_path : resolve(cwd, cfg.vault_path);
		if (existsSync(p)) return p;
	}

	// Tier 1c — legacy project config
	const legacy = await readConfig(resolve(cwd, ".pi", "obsidian_config.json"));
	if (legacy.mode !== "app" && legacy.vault_path) {
		const p = isAbsolute(legacy.vault_path) ? legacy.vault_path : resolve(cwd, legacy.vault_path);
		if (existsSync(p)) return p;
	}

	// Tier 2 — cwd fallback
	return cwd;
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
