import { homedir } from "node:os";
import {
	join,
	resolve,
	normalize,
	sep,
	isAbsolute,
	dirname,
} from "node:path";
import {
	readFile,
	mkdir,
	readdir,
	cp,
	rm,
} from "node:fs/promises";
import { existsSync } from "node:fs";

import { execFileP } from "./utils";
import { atomicWriteFile } from "./fs-cache";
import { shExtDir } from "./ext-dir";

export const OBSIDIAN_JSON = join(
	homedir(),
	"Library",
	"Application Support",
	"obsidian",
	"obsidian.json",
);

export interface VaultEntry {
	path: string;
	ts?: number;
	open?: boolean;
}
export interface ObsidianConfig {
	vaults: Record<string, VaultEntry>;
}

/** Where a resolved vault came from. Mirrors the resolution order:
 *  - "env"      : OB_VAULT_PATH env (Tier 1a, explicit — overrides everything)
 *  - "personal" : ~/.pi/obsidian_config.json vault_path (Tier 1b, explicit — user-global default; mode not honored)
 *  - "config"   : <cwd>/.pi/obsidian_config.json vault_path (Tier 1c, explicit — per-project override)
 *  - "app"      : obsidian.json vault marked open:true (Tier 2, auto-follow app)
 *  - "local"    : project-local <cwd>/<OB_VAULT_DIR|"vault"> auto-seeded (Tier 3, fallback)
 *  - "global"   : OB_USE_GLOBAL / OB_VAULT named vault (legacy global resolver)
 */
export type VaultSource =
	| "env"
	| "personal"
	| "config"
	| "app"
	| "local"
	| "global";

export interface ResolvedVault {
	path: string;
	name: string;
	/** true if the vault is registered in the Obsidian app's obsidian.json. */
	registered: boolean;
	/** which tier produced this vault (for transparency / display). */
	source: VaultSource;
	/** set when a Tier-1 target was configured but missing/stale; lets the
	 *  UI surface a warning without aborting resolution. */
	staleReason?: string;
}

/** Shape of the persistent, user-editable vault config. Two locations:
 *  - personal: `~/.pi/obsidian_config.json` — the user-global default (Tier 1b).
 *    Honors `vault_path` ONLY (absolute, machine-local); `mode` is NOT honored
 *    here — a present `mode:"app"` is recorded as stale and resolution falls
 *    through. The personal tier is a FIXED default by design.
 *  - project:  `<cwd>/.pi/obsidian_config.json` — the per-project override
 *    (Tier 1c). Full schema: `vault_path` + `mode` ("explicit" | "app").
 *  Backwards compatible with the legacy `{ "vault_path": "..." }` form. */
export interface VaultConfigFile {
	/** Absolute or cwd-relative path to the vault (Tier 1, explicit). */
	vault_path?: string;
	/** Resolution mode (PROJECT tier only — ignored at the personal tier):
	 *  - "explicit" (default when vault_path is set): use vault_path directly
	 *  - "app": ignore vault_path and follow the Obsidian app's open vault (Tier 2)
	 *  Setting mode:"app" is what `/obsidian-config --use-app` persists. */
	mode?: "explicit" | "app";
}

/** Resolve the pi-agent run-dir/ location from this extension's own path.
 *  sh deploy: `require("#pi/ext-dir")` → no run-dir/ exists beside the ext
 *  bundle, so the legacy migration read simply finds nothing (by design —
 *  the portable deploy has no repo run-dir).
 *  Bundle mode: ext-bundles/obsidian.full.js → ../run-dir/
 *  Source mode: bun-apps/pi-obsidian/extensions/ → ../../pi-agent/run-dir/
 *  RETIRED as a config-write location; kept only to migrate any pre-existing
 *  run-dir config into <cwd>/.pi/ on first read (see readProjectConfig). */
export function runDirPath(): string | undefined {
	const extDir = shExtDir();
	if (extDir === undefined) return undefined;
	const selfDir = dirname(extDir);
	if (selfDir.includes("ext-bundles")) {
		// Bundle mode: sibling run-dir/
		return resolve(selfDir, "..", "run-dir");
	}
	// Source mode: <pkg>/ → ../../pi-agent/run-dir/ (ext-dir is the package root)
	return resolve(extDir, "..", "..", "pi-agent", "run-dir");
}

/** Retired config location — one-time migration source only. Undefined when
 *  the ext dir is unresolvable (native ESM / portable deploy) — there is no
 *  run-dir to migrate from, which is the same as "nothing to migrate". */
export function runDirConfigPath(): string | undefined {
	const dir = runDirPath();
	return dir === undefined ? undefined : join(dir, "obsidian_config.json");
}

/** Home-directory base for the personal tier. Honors `process.env.HOME`
 *  (redirectable for tests / sandboxing — Bun's os.homedir() caches the
 *  startup value and ignores runtime HOME changes); falls back to os.homedir()
 *  when HOME is unset. */
function _homeBase(): string {
	return process.env.HOME || homedir();
}

/** Personal (user-global) config path: ~/.pi/obsidian_config.json. */
export function personalConfigPath(): string {
	return join(_homeBase(), ".pi", "obsidian_config.json");
}

/** Project (per-cwd) config path: <cwd>/.pi/obsidian_config.json. */
export function projectConfigPath(cwd: string): string {
	return resolve(cwd, ".pi", "obsidian_config.json");
}

/** Backwards-compatible alias for {@link projectConfigPath} (the per-project
 *  config file). Display code should show BOTH personal + project paths. */
export function vaultConfigPath(cwd: string): string {
	return projectConfigPath(cwd);
}

/** Read the personal (user-global) config ({} when absent / unparseable). */
export async function readPersonalConfig(): Promise<VaultConfigFile> {
	try {
		return JSON.parse(await readFile(personalConfigPath(), "utf8"));
	} catch {
		return {};
	}
}

/** Read the project (per-cwd) config ({} when absent / unparseable).
 *  One-time migration: if the retired run-dir config exists and no project
 *  config does, the run-dir config is read once and written to <cwd>/.pi/ so
 *  the project location becomes canonical. Best-effort, never throws. */
export async function readProjectConfig(
	cwd: string,
): Promise<VaultConfigFile> {
	const projPath = projectConfigPath(cwd);
	if (!existsSync(projPath)) {
		const legacy = runDirConfigPath();
		if (legacy !== undefined && existsSync(legacy)) {
			try {
				const legacyCfg = JSON.parse(await readFile(legacy, "utf8"));
				await mkdir(dirname(projPath), { recursive: true });
				await atomicWriteFile(
					projPath,
					JSON.stringify(legacyCfg, null, 2) + "\n",
				);
				// Remove the retired run-dir config so we don't re-migrate.
				await rm(legacy, { force: true }).catch(() => {
					/* best-effort cleanup */
				});
			} catch {
				/* malformed legacy config — ignore, leave it in place */
			}
		}
	}
	try {
		return JSON.parse(await readFile(projPath, "utf8"));
	} catch {
		return {};
	}
}

/** Backwards-compatible alias for {@link readProjectConfig} (the project
 *  config). NOTE: reads the PROJECT config only — the personal tier is read
 *  separately via {@link readPersonalConfig}. */
export async function readVaultConfig(cwd: string): Promise<VaultConfigFile> {
	return readProjectConfig(cwd);
}

/** Merge a patch into a vault config (atomic write, mkdir -p).
 *  @param scope "personal" (default — writes ~/.pi, the tier that wins on
 *    read) or "project" (writes <cwd>/.pi). The personal tier honors
 *    `vault_path` ONLY; writing `mode:"app"` at personal scope throws (use
 *    scope:"project", i.e. `/obsidian-config --scope project`). */
export async function writeVaultConfig(
	cwd: string,
	patch: VaultConfigFile,
	scope: "personal" | "project" = "personal",
): Promise<void> {
	if (scope === "personal" && patch.mode === "app") {
		throw new Error(
			`mode:"app" is not supported at the personal tier (~/.pi) — the personal tier is explicit vault_path only. Use scope:"project" (/obsidian-config --scope project) for app-follow, or clear the personal config.`,
		);
	}
	const targetPath =
		scope === "project" ? projectConfigPath(cwd) : personalConfigPath();
	const current =
		scope === "project"
			? await readProjectConfig(cwd)
			: await readPersonalConfig();
	const next: VaultConfigFile = { ...current, ...patch };
	// Drop empty `vault_path` rather than persisting "".
	if (next.vault_path != null && next.vault_path.trim() === "") {
		delete next.vault_path;
	}
	await mkdir(dirname(targetPath), { recursive: true });
	await atomicWriteFile(targetPath, JSON.stringify(next, null, 2) + "\n");
}

/** Parse obsidian.json (the Obsidian app's registry). Returns [] if absent. */
export async function readObsidianVaults(): Promise<
	Array<{ path: string; open: boolean }>
> {
	try {
		const config = JSON.parse(
			await readFile(OBSIDIAN_JSON, "utf8"),
		) as ObsidianConfig;
		return Object.values(config.vaults ?? {}).map((v) => ({
			path: v.path,
			open: v.open === true,
		}));
	} catch {
		return [];
	}
}

/** True if directory contains no visible entries. */
export async function isDirEmpty(dir: string): Promise<boolean> {
	try {
		const entries = await readdir(dir);
		return entries.filter((e) => !e.startsWith(".")).length === 0;
	} catch {
		return true;
	}
}

/** Copy bundled `vault-template/` into a fresh vault. Skips files that already exist. */
export async function seedFromTemplate(target: string): Promise<void> {
	// Resolve the template through the ext-dir idiom (see ./ext-dir.ts):
	// sh deploy copies `vault-template/` beside the bundle
	// (`ext/obsidian/vault-template/`); source mode resolves the package root
	// where `vault-template/` lives. NOT import.meta.url — bun's cjs output
	// folds it into a build-machine path (relocatability gate rejects that).
	const extDir = shExtDir();
	if (extDir === undefined) return;
	const templateDir = resolve(extDir, "vault-template");
	if (!existsSync(templateDir)) return;
	await cp(templateDir, target, {
		recursive: true,
		// Skip files that already exist; always allow directories.
		filter: (src, dest) => {
			if (src === templateDir) return true;
			return !existsSync(dest);
		},
	});
}

export function basenameOf(p: string): string {
	return normalize(p).split(sep).pop() ?? "vault";
}

/** Resolve the vault. Resolution order (top-down):
 *
 *   Tier 1 — explicit (user said exactly this):
 *     1a. OB_VAULT_PATH env (absolute path)
 *     1b. personal config ~/.pi/obsidian_config.json { vault_path }
 *         (mode is NOT honored here; mode:"app" → stale + fall through)
 *     1c. project config <cwd>/.pi/obsidian_config.json { vault_path }
 *         when mode != "app"
 *
 *   Tier 2 — auto-follow app (what the user sees in Obsidian):
 *     2. obsidian.json vault marked open:true
 *        (also reached when project config mode:"app", or OB_USE_GLOBAL is set)
 *
 *   Tier 3 — fallback (zero-config, project-local):
 *     3. <cwd>/<OB_VAULT_DIR || "vault"> — auto-created + seeded
 *
 *  Stale-config handling: if a Tier-1 target is configured but the path no
 *  longer exists (or the personal tier carries an unsupported mode),
 *  resolution does NOT abort — it records a `staleReason` and falls through
 *  to the next tier, so the agent keeps working instead of silently pointing
 *  at a ghost path (or creating an empty ./vault and confusing the user).
 *  Tier 1a (env) always wins; the personal tier (1b) always wins over the
 *  project tier (1c) — a project cannot override the user's personal default
 *  short of an env var.
 */
export async function resolveVault(cwd: string): Promise<ResolvedVault> {
	const stale: string[] = [];

	// ---- Tier 1a: OB_VAULT_PATH env (absolute path) ----------------------
	const envPath = process.env.OB_VAULT_PATH;
	if (envPath) {
		if (existsSync(envPath)) {
			return {
				path: envPath,
				name: basenameOf(envPath),
				registered: true,
				source: "env",
			};
		}
		stale.push(`OB_VAULT_PATH="${envPath}" does not exist`);
	}

	// ---- Tier 1b: personal config ~/.pi (vault_path only; mode ignored) --
	const personal = await readPersonalConfig();
	if (personal.mode === "app") {
		// Personal tier honors vault_path ONLY; mode:"app" is unsupported here.
		stale.push(
			`personal config (~/.pi) mode:"app" is not honored — the personal tier is explicit vault_path only; falling through`,
		);
	} else if (personal.vault_path) {
		const p = isAbsolute(personal.vault_path)
			? personal.vault_path
			: resolve(_homeBase(), personal.vault_path);
		if (existsSync(p)) {
			return {
				path: p,
				name: basenameOf(p),
				registered: true,
				source: "personal",
				staleReason: stale.length ? stale.join("; ") : undefined,
			};
		}
		stale.push(
			`personal config vault_path="${personal.vault_path}" does not exist`,
		);
	}

	// ---- Tier 1c: project config <cwd>/.pi (full schema) -----------------
	const cfg = await readProjectConfig(cwd);
	if (cfg.mode !== "app" && cfg.vault_path) {
		const p = isAbsolute(cfg.vault_path)
			? cfg.vault_path
			: resolve(cwd, cfg.vault_path);
		if (existsSync(p)) {
			return {
				path: p,
				name: basenameOf(p),
				registered: true,
				source: "config",
				staleReason: stale.length ? stale.join("; ") : undefined,
			};
		}
		stale.push(`config vault_path="${cfg.vault_path}" does not exist`);
	}

	// ---- Tier 2: auto-follow Obsidian app open vault ---------------------
	const appVaults = await readObsidianVaults();
	const openVault = appVaults.find((v) => v.open);
	if (openVault) {
		return {
			path: openVault.path,
			name: basenameOf(openVault.path),
			registered: true,
			source: "app",
			staleReason: stale.length ? stale.join("; ") : undefined,
		};
	}

	// OB_VAULT named-vault (legacy) — honor only in global mode, after open.
	if (process.env.OB_USE_GLOBAL) {
		const byName = process.env.OB_VAULT
			? appVaults.find((v) => basenameOf(v.path) === process.env.OB_VAULT)
			: undefined;
		const picked = byName ?? appVaults[0];
		if (picked) {
			return {
				path: picked.path,
				name: basenameOf(picked.path),
				registered: true,
				source: "global",
				staleReason: stale.length ? stale.join("; ") : undefined,
			};
		}
	}

	// ---- Tier 3: project-local fallback (auto-created + seeded) ----------
	const dir = process.env.OB_VAULT_DIR ?? "vault";
	const localPath = resolve(cwd, dir);
	const fresh = !existsSync(localPath);
	await mkdir(localPath, { recursive: true });
	if (fresh || (await isDirEmpty(localPath))) {
		await seedFromTemplate(localPath).catch(() => {
			/* template optional */
		});
	}
	return {
		path: localPath,
		name: dir,
		registered: false,
		source: "local",
		staleReason: stale.length ? stale.join("; ") : undefined,
	};
}

/** Enumerate all vault candidates for `/obsidian-config` display:
 *  env path, config path, app-registered vaults, local folder. */
export async function listVaultCandidates(
	cwd: string,
): Promise<
	Array<{ path: string; source: VaultSource; open?: boolean; exists: boolean }>
> {
	const out: Array<{
		path: string;
		source: VaultSource;
		open?: boolean;
		exists: boolean;
	}> = [];
	const envPath = process.env.OB_VAULT_PATH;
	if (envPath)
		out.push({ path: envPath, source: "env", exists: existsSync(envPath) });
	const personal = await readPersonalConfig();
	if (personal.vault_path) {
		const p = isAbsolute(personal.vault_path)
			? personal.vault_path
			: resolve(_homeBase(), personal.vault_path);
		out.push({ path: p, source: "personal", exists: existsSync(p) });
	}
	const cfg = await readProjectConfig(cwd);
	if (cfg.vault_path) {
		const p = isAbsolute(cfg.vault_path)
			? cfg.vault_path
			: resolve(cwd, cfg.vault_path);
		out.push({ path: p, source: "config", exists: existsSync(p) });
	}
	for (const v of await readObsidianVaults()) {
		out.push({
			path: v.path,
			source: "app",
			open: v.open,
			exists: existsSync(v.path),
		});
	}
	const dir = process.env.OB_VAULT_DIR ?? "vault";
	const localPath = resolve(cwd, dir);
	out.push({ path: localPath, source: "local", exists: existsSync(localPath) });
	return out;
}

/** Open an obsidian:// URI via macOS `open`. */
/** Open an obsidian:// URI via the platform launcher (C2.1).
 *  macOS: `open`; Linux: `xdg-open`; Windows: `start` (via cmd /c). */
export async function openObsidianUri(uri: string): Promise<void> {
	const platform =
		(typeof process !== "undefined" && process.platform) || "darwin";
	if (platform === "win32") {
		await execFileP("cmd", ["/c", "start", "", uri]);
	} else if (platform === "linux") {
		await execFileP("xdg-open", [uri]);
	} else {
		await execFileP("open", [uri]);
	}
}

/** Exposed for tests: returns the launcher command + args for a platform. */
export function launcherForUri(
	uri: string,
	platform: string = (typeof process !== "undefined" && process.platform) ||
		"darwin",
): { command: string; args: string[] } {
	if (platform === "win32")
		return { command: "cmd", args: ["/c", "start", "", uri] };
	if (platform === "linux") return { command: "xdg-open", args: [uri] };
	return { command: "open", args: [uri] };
}
