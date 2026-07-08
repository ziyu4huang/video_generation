/**
 * Obsidian Extension (project-local vault)
 *
 * Defaults to a vault located at `<cwd>/vault/` (auto-created). This keeps the
 * knowledge base next to the code project. Override the subfolder name with
 * OB_VAULT_DIR (relative to cwd) or point elsewhere with OB_VAULT_PATH
 * (absolute) / OB_VAULT (registered vault name from obsidian.json).
 *
 * Tools:
 *   - obsidian_list           : list notes under a folder
 *   - obsidian_read           : read a note
 *   - obsidian_create         : create or overwrite a note
 *   - obsidian_append         : append text to a note
 *   - obsidian_append_section : insert text under a specific heading (creates heading if missing)
 *   - obsidian_search         : full-text grep across the vault (returns file:line matches)
 *   - obsidian_open           : open a note / vault in the Obsidian app
 *   - obsidian_distill        : distill input markdown into Zettelkasten notes (subagent)
 *   - obsidian_garden          : audit/repair vault health (subagent)
 *
 * Commands:
 *   - /obsidian [note]        : open vault or note in Obsidian
 *   - /obsidian-init          : register the project vault with the Obsidian app
 *
 * Wiki-link syntax ([[Target]]) works natively because notes are plain markdown.
 */

import { execFile, spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import {
	join,
	resolve,
	normalize,
	sep,
	relative,
	isAbsolute,
	dirname,
} from "node:path";
import { promisify } from "node:util";
import {
	readFile,
	writeFile,
	mkdir,
	readdir,
	cp,
	mkdtemp,
	rm,
	lstat,
	realpath,
	stat,
} from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const execFileP = promisify(execFile);

const OBSIDIAN_JSON = join(
	homedir(),
	"Library",
	"Application Support",
	"obsidian",
	"obsidian.json",
);

function _findMonorepoRoot(from: string | undefined): string {
	if (!from) return "(repo root)";
	let dir = from;
	while (dir !== dirname(dir)) {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			if (pkg.workspaces) return dir;
		} catch {
			/* no package.json or unreadable — keep walking up */
		}
		dir = dirname(dir);
	}
	return "(repo root)";
}

function _missingDeps(deps: string[], from: string | undefined): string[] {
	if (!from) return [];
	return deps.filter((dep) => {
		const pkgName = dep.startsWith("@")
			? dep.split("/").slice(0, 2).join("/")
			: dep.split("/")[0] ?? dep;
		let dir = from;
		while (true) {
			if (existsSync(join(dir, "node_modules", pkgName, "package.json")))
				return false;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		return true;
	});
}

interface VaultEntry {
	path: string;
	ts?: number;
	open?: boolean;
}
interface ObsidianConfig {
	vaults: Record<string, VaultEntry>;
}

/** Where a resolved vault came from. Mirrors the 3-tier resolution order:
 *  - "env"    : OB_VAULT_PATH env (Tier 1, explicit)
 *  - "config" : run-dir/obsidian_config.json vault_path (Tier 1, explicit)
 *  - "app"    : obsidian.json vault marked open:true (Tier 2, auto-follow app)
 *  - "local"  : project-local <cwd>/<OB_VAULT_DIR|"vault"> auto-seeded (Tier 3, fallback)
 *  - "global" : OB_USE_GLOBAL / OB_VAULT named vault (legacy global resolver)
 */
type VaultSource = "env" | "config" | "app" | "local" | "global";

interface ResolvedVault {
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

/** Shape of the persistent, user-editable vault config.
 *  Lives at `run-dir/obsidian_config.json` (consolidated with pi-agent's other
 *  config), with `.pi/obsidian_config.json` as a legacy fallback for reads.
 *  Backwards compatible with the legacy `{ "vault_path": "..." }` form. */
interface VaultConfigFile {
	/** Absolute or cwd-relative path to the vault (Tier 1, explicit). */
	vault_path?: string;
	/** Resolution mode:
	 *  - "explicit" (default when vault_path is set): use vault_path directly
	 *  - "app": ignore vault_path and follow the Obsidian app's open vault (Tier 2)
	 *  Setting mode:"app" is what `/obsidian-config --use-app` persists. */
	mode?: "explicit" | "app";
}

/** Resolve the pi-agent run-dir/ location from this extension's own path.
 *  Bundle mode: ext-bundles/obsidian.full.js → ../run-dir/
 *  Source mode: bun-apps/pi-obsidian/extensions/ → ../../pi-agent/run-dir/ */
function runDirPath(): string {
	const selfDir = dirname(fileURLToPath(import.meta.url));
	if (selfDir.includes("ext-bundles")) {
		// Bundle mode: sibling run-dir/
		return resolve(selfDir, "..", "run-dir");
	}
	// Source mode: bun-apps/pi-obsidian/extensions/../../pi-agent/run-dir/
	return resolve(selfDir, "..", "..", "pi-agent", "run-dir");
}

/** Preferred config location: run-dir/obsidian_config.json (consolidated). */
function runDirConfigPath(): string {
	return join(runDirPath(), "obsidian_config.json");
}

/** Path to the persistent per-project config file.
 *  Tries run-dir/ first (consolidated location); falls back to legacy .pi/. */
function vaultConfigPath(cwd: string): string {
	const runDirConfig = runDirConfigPath();
	if (existsSync(runDirConfig)) return runDirConfig;
	return resolve(cwd, ".pi", "obsidian_config.json");
}

/** Read the vault config (returns {} when absent / unparseable). */
async function readVaultConfig(cwd: string): Promise<VaultConfigFile> {
	try {
		return JSON.parse(await readFile(vaultConfigPath(cwd), "utf8"));
	} catch {
		return {};
	}
}

/** Merge a patch into the persistent vault config (atomic write, mkdir -p).
 *  Writes to run-dir/obsidian_config.json (preferred). If the config currently
 *  lives at the legacy .pi/ path, the first write migrates it to run-dir/. */
async function writeVaultConfig(
	cwd: string,
	patch: VaultConfigFile,
): Promise<void> {
	const current = await readVaultConfig(cwd);
	const next: VaultConfigFile = { ...current, ...patch };
	// Drop empty `vault_path` rather than persisting "".
	if (next.vault_path != null && next.vault_path.trim() === "") {
		delete next.vault_path;
	}
	const dir = runDirPath();
	await mkdir(dir, { recursive: true });
	await atomicWriteFile(
		runDirConfigPath(),
		JSON.stringify(next, null, 2) + "\n",
	);
}

/** Parse obsidian.json (the Obsidian app's registry). Returns [] if absent. */
async function readObsidianVaults(): Promise<
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
async function isDirEmpty(dir: string): Promise<boolean> {
	try {
		const entries = await readdir(dir);
		return entries.filter((e) => !e.startsWith(".")).length === 0;
	} catch {
		return true;
	}
}

/** Copy bundled `vault-template/` into a fresh vault. Skips files that already exist. */
async function seedFromTemplate(target: string): Promise<void> {
	// Resolve template relative to this extension file: ../../vault-template
	// (extension is in <pkg>/extensions/, template in <pkg>/vault-template/).
	const here = fileURLToPath(import.meta.url);
	const templateDir = resolve(here, "..", "..", "vault-template");
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

function basenameOf(p: string): string {
	return normalize(p).split(sep).pop() ?? "vault";
}

/** Resolve the vault. Resolution order (3 tiers, top-down):
 *
 *   Tier 1 — explicit (user said exactly this):
 *     1a. OB_VAULT_PATH env (absolute path)
 *     1b. run-dir/obsidian_config.json { vault_path } when mode != "app"
 *
 *   Tier 2 — auto-follow app (what the user sees in Obsidian):
 *     2. obsidian.json vault marked open:true
 *        (also reached when config mode:"app", or when OB_USE_GLOBAL is set)
 *
 *   Tier 3 — fallback (zero-config, project-local):
 *     3. <cwd>/<OB_VAULT_DIR || "vault"> — auto-created + seeded
 *
 *  Stale-config handling: if a Tier-1 target is configured but the path no
 *  longer exists, resolution does NOT abort — it records a `staleReason` and
 *  falls through to Tier 2 / 3, so the agent keeps working instead of silently
 *  pointing at a ghost path (or creating an empty ./vault and confusing the
 *  user). Tier 1 env always wins over config; OB_VAULT_PATH can override
 *  everything for CI / one-off runs.
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

	const cfg = await readVaultConfig(cwd);

	// ---- Tier 1b: config file vault_path (unless mode:"app") --------------
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
	const cfg = await readVaultConfig(cwd);
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

/** Resolve and guard a vault-relative note path. */
export function safeNotePath(vaultPath: string, note: string): string {
	if (typeof note !== "string" || note.length === 0) {
		throw new Error(`Invalid note path (empty): ${JSON.stringify(note)}`);
	}
	// A1.4: reject control chars (NUL injection, newlines, etc.)
	if (/[\u0000-\u001f]/.test(note)) {
		throw new Error(
			`Invalid note path (control chars): ${JSON.stringify(note)}`,
		);
	}
	const cleaned = note.replace(/^[/\\]+/, "").replace(/\.md$/i, "") + ".md";
	const vaultReal = resolve(vaultPath);
	const abs = resolve(vaultReal, cleaned);
	const rel = relative(vaultReal, abs);
	// rel must be a non-empty, in-vault relative path. "" means the vault root
	// itself (not a file); ".." prefix or absolute means escape.
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`Invalid note path (escapes vault): ${note}`);
	}
	// A6: reject control/formatting chars the C0 regex above misses — C1
	// (DEL 0x7f + 0x80-0x9f), bidi/override controls, ZWSP/RLM/ZWJ, invisible
	// operators (WJ), BOM, line/paragraph separators. Numeric code-point test
	// keeps the source free of embedded invisible bytes (no \u escapes needed).
	// (Backslash is intentionally NOT rejected: A1.5 treats it as a cross-
	// platform separator that gets normalized, not a control char.)
	for (let i = 0; i < note.length; ) {
		const cp = note.codePointAt(i)!;
		const unsafe =
			(cp >= 0x7f && cp <= 0x9f) ||
			(cp >= 0x200b && cp <= 0x200f) ||
			(cp >= 0x202a && cp <= 0x202e) ||
			(cp >= 0x2060 && cp <= 0x206f) ||
			cp === 0xfeff ||
			cp === 0x2028 ||
			cp === 0x2029;
		if (unsafe)
			throw new Error(
				`Invalid note path (control/formatting char U+${cp
					.toString(16)
					.toUpperCase()
					.padStart(4, "0")}): ${JSON.stringify(note)}`,
			);
		i += cp > 0xffff ? 2 : 1;
	}
	// A6: cross-platform — a vault git-synced to Windows corrupts on reserved
	// device names (CON/PRN/AUX/NUL/COM1-9/LPT1-9) and on the reserved chars
	// < > : " | ? *. Checked per resolved segment (`rel` is normalized).
	for (const seg of rel.split(sep)) {
		if (!seg) continue;
		const base = seg.replace(/[.]md$/i, "");
		if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])([.]|$)/i.test(base))
			throw new Error(
				`Invalid note path (Windows reserved name "${base}"): ${note}`,
			);
		if (/[<>:"|?*]/.test(seg))
			throw new Error(`Invalid note path (reserved char): ${note}`);
	}
	return abs;
}

const fsLstat = lstat;
const fsRealpath = realpath;

/** Atomic write: write to `<path>.<pid>.tmp` then rename. Prevents partial
 *  writes from being observed by the Obsidian app or a concurrent search if
 *  the process is killed mid-write (A2.1). Temp file is cleaned up on failure. */
export async function atomicWriteFile(
	absPath: string,
	data: string,
): Promise<void> {
	const tmp = `${absPath}.${process.pid}.tmp`;
	try {
		await writeFile(tmp, data, "utf8");
		await renameOverwrite(tmp, absPath);
	} catch (e) {
		await rm(tmp, { force: true }).catch(() => {});
		throw e;
	}
}

/** rename with fallback to copy+delete if cross-device (rare, same vault fs). */
const renameOverwrite = async (from: string, to: string) => {
	const { rename } = await import("node:fs/promises");
	try {
		await rename(from, to);
	} catch (e: any) {
		if (e && e.code === "EXDEV") {
			await cp(from, to, { force: true });
			await rm(from, { force: true });
		} else throw e;
	}
};

/** Segments that must never be written via note tools. Reading is allowed
 *  (e.g. obsidian_read of app config for diagnostics), but create/append/move
 *  must refuse, so an agent cannot corrupt Obsidian app state or VCS internals. */
const WRITE_BLOCKLIST = [".obsidian", ".git"];

/** Async symlink-escape check (A1.2). Walks path components from the vault root
 *  to `absPath`; if any component is a symlink, resolves its realpath and
 *  confirms it still lives inside the vault. Catches both file-symlink escapes
 *  (`vault/evil.md -> /etc/passwd`) and directory-symlink escapes
 *  (`vault/linkdir -> /tmp/outside`).
 *
 *  `safeNotePath` handles the lexical (`../`) containment synchronously; this
 *  complements it for paths whose resolution depends on the filesystem.
 *
 *  Residual (A6): there is a TOCTOU window between `lstat` and `realpath` — a
 *  symlink could be swapped to point outside the vault between the two calls.
 *  Accepted as a read-only risk: write tools call this before writing, but a
 *  privileged local attacker who can race the fs can already replace files;
 *  closing it fully needs an atomic openat-with-resolve walk. */
export async function assertWithinVault(
	vaultPath: string,
	absPath: string,
): Promise<void> {
	const vaultReal = resolve(vaultPath);
	const target = resolve(absPath);
	// Walk ancestors of `target` that are strictly inside the vault.
	const rel = relative(vaultReal, target);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`Path escapes vault (lexical): ${rel}`);
	}
	const parts = rel.split(sep).filter(Boolean);
	// Drop the final component if the file doesn't exist yet (create case):
	// we still want to check that every existing ancestor is real.
	let cur = vaultReal;
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (!part) continue;
		cur = join(cur, part);
		let st;
		try {
			st = await fsLstat(cur);
		} catch {
			break; /* missing — create path */
		}
		if (st.isSymbolicLink()) {
			const real = await fsRealpath(cur);
			const r = relative(vaultReal, real);
			if (r === "" || r.startsWith("..") || isAbsolute(r)) {
				throw new Error(`Symlink escapes vault: ${cur} -> ${real}`);
			}
		}
	}
}

/** Throw if `absPath` falls under a write-blocked top-level segment of the vault. */
export function assertWritablePath(vaultPath: string, absPath: string): void {
	const rel = relative(resolve(vaultPath), absPath);
	const first = rel.split(sep)[0] ?? rel;
	if (WRITE_BLOCKLIST.includes(first)) {
		throw new Error(
			`Refusing to write inside blocklisted segment '${first}/' (vault internals): ${rel}`,
		);
	}
}

/** Open an obsidian:// URI via macOS `open`. */
/** Open an obsidian:// URI via the platform launcher (C2.1).
 *  macOS: `open`; Linux: `xdg-open`; Windows: `start` (via cmd /c). */
async function openObsidianUri(uri: string): Promise<void> {
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

/** Extract a human-readable message from any thrown value (Error, string, or unknown). */
function errMsg(e: unknown): string {
	if (e instanceof Error) return e.message;
	if (typeof e === "string") return e;
	const m = (e as Record<string, unknown>)?.message;
	return typeof m === "string" ? m : String(e);
}

// ---- Structured errors (Phase 1: WS-A1 + WS-A2) ---------------------------
// Tool failures surface a machine-branchable `code` on `details` so callers can
// react (retry on CONFLICT, prompt on PERMISSION_DENIED, …) instead of parsing
// a human string. The prior shape (`details.error = "<lowercase>"` + ad-hoc
// booleans) is preserved for back-compat; `code` is the canonical field.
export type ErrCode =
	| "NOT_FOUND"
	| "ALREADY_EXISTS"
	| "CONFLICT"
	| "PERMISSION_DENIED"
	| "OUTSIDE_VAULT"
	| "INVALID_PATH"
	| "IO_ERROR"
	| "BAD_REQUEST";

/** A filesystem/IO error carrying a structured code. Helpers throw this; tool
 *  execute()s catch and turn it into a structured result via toolError(). */
export class VaultError extends Error {
	code: ErrCode;
	constructor(code: ErrCode, message: string) {
		super(message);
		this.name = "VaultError";
		this.code = code;
	}
}

/** Pull the NodeFS error code (e.g. "ENOENT", "EACCES") off any thrown value. */
function fsErrCode(e: unknown): string | undefined {
	const code = (e as { code?: unknown })?.code;
	return typeof code === "string" ? code : undefined;
}

/** Map a thrown filesystem error to a structured ErrCode. */
function classifyFsError(e: unknown): ErrCode {
	switch (fsErrCode(e)) {
		case "ENOENT":
		case "ENOTDIR":
			return "NOT_FOUND";
		case "EACCES":
		case "EPERM":
			return "PERMISSION_DENIED";
		case "EEXIST":
			return "ALREADY_EXISTS";
		default:
			return "IO_ERROR";
	}
}

/** Build a structured tool-error result. `extra` is merged into details. */
function toolError(
	code: ErrCode,
	message: string,
	extra: Record<string, unknown> = {},
): {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
	isError: true;
} {
	return {
		content: [{ type: "text", text: message }],
		details: { ...extra, code, error: code },
		isError: true,
	};
}

/** Convert a caught value (preferably a VaultError) into a structured result. */
function toolErrorFromCaught(
	e: unknown,
	extra: Record<string, unknown> = {},
): { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError: true } {
	if (e instanceof VaultError)
		return toolError(e.code, e.message, extra);
	// A raw NodeFS error: classify it.
	if (fsErrCode(e)) return toolError(classifyFsError(e), errMsg(e), extra);
	return toolError("IO_ERROR", errMsg(e), extra);
}

/** Stat a note; return its mtime (ms) or undefined if absent. Throws VaultError
 *  on non-ENOENT FS errors (WS-A1: don't conflate EACCES with "absent"). */
async function noteMtime(absPath: string): Promise<number | undefined> {
	try {
		return (await stat(absPath)).mtimeMs;
	} catch (e) {
		if (fsErrCode(e) === "ENOENT") return undefined;
		throw new VaultError(classifyFsError(e), errMsg(e));
	}
}

/** Optimistic-concurrency guard (WS-A4). expectedMtime only constrains the
 *  existing-file case: when the file is absent the caller proceeds (append /
 *  create may create-new); update_frontmatter treats absent as NOT_FOUND
 *  upstream. Returns a VaultError(CONFLICT) to throw, or null. */
function mtimeConflict(
	note: string,
	expected: number | undefined,
	actual: number | undefined,
): VaultError | null {
	if (expected === undefined || actual === undefined) return null;
	if (expected !== actual)
		return new VaultError(
			"CONFLICT",
			`Conflict: ${note} was modified (expected mtime ${expected}, actual ${actual}).`,
		);
	return null;
}


// ---- Session-scoped read cache (Phase 3) ----------------------------------
// Caches file content + derived structures keyed by absolute path, invalidated
// by mtime or explicitly via invalidateCache(). Write tools call invalidateCache
// for the path they touched so a subsequent search reflects the change at once.
interface CacheEntry {
	mtime: number;
	content: string;
	lines: string[];
}
const fileCache = new Map<string, CacheEntry>();
/** Soft cap on the file cache. Read live from OB_CACHE_MAX so it is tunable at
 *  runtime (operator hot-reload of a small/large working set) and so tests can
 *  exercise eviction without re-loading the module. Defaults to 500. */
function fileCacheMax(): number {
	return Number(process.env.OB_CACHE_MAX ?? 500);
}

/** Read a file through the cache. Re-reads only when mtime changed. */
export async function readCached(absPath: string): Promise<CacheEntry | null> {
	let stat;
	try {
		stat = await (await import("node:fs/promises")).stat(absPath);
	} catch (e) {
		// Absent/vanished (ENOENT) is an expected cache miss → drop & return null.
		// Other errors (EACCES/EIO/ENOTDIR) are ALSO absorbed here on purpose:
		// readCached is a best-effort hot path feeding batch search & index, and
		// must NEVER crash a whole search because ONE file is unreadable. The
		// user-facing tools read their single target file DIRECTLY (not through
		// this cache) and surface a structured PERMISSION_DENIED / IO_ERROR there.
		fileCache.delete(absPath);
		return null;
	}
	const mtime = stat.mtimeMs;
	const cached = fileCache.get(absPath);
	if (cached && cached.mtime === mtime) {
		// A8: access-order LRU. Map iterates in insertion order; a plain hit
		// returns without moving the entry, so a hot MOC/index note read
		// repeatedly gets evicted the moment the cap fills, identical to a
		// one-shot read. Re-inserting on a hit promotes it to the tail, so the
		// head-eviction below drops the genuinely least-recently-used entry.
		fileCache.delete(absPath);
		fileCache.set(absPath, cached);
		return cached;
	}
	let content: string;
	try {
		content = await readFile(absPath, "utf8");
	} catch (e) {
		// Same best-effort contract as the stat catch above (see WS-A1 note).
		fileCache.delete(absPath);
		return null;
	}
	const entry: CacheEntry = { mtime, content, lines: content.split("\n") };
	// A8: delete-then-set so an mtime-stale re-read (existing key) is also
	// promoted to the tail — `set` on an existing key would update the value
	// but leave it at its old position, breaking access-order.
	fileCache.delete(absPath);
	fileCache.set(absPath, entry);
	// A8: LRU cap — evict least-recently-used entries (map head) until at/below
	// the limit. `while` (not `if`) so shrinking OB_CACHE_MAX mid-session, or a
	// batch insert, can never leave the cache over cap. Combined with the
	// re-insert-on-hit / delete-then-set above, this is true access-order LRU.
	while (fileCache.size > fileCacheMax()) {
		const oldest = fileCache.keys().next().value;
		if (oldest === undefined) break;
		fileCache.delete(oldest);
	}
	return entry;
}

/** Invalidate a single path (pass the vault-relative note path) or the whole cache.
 *  Safe to call with a path that was never cached. */
export function invalidateCache(absPath?: string): void {
	if (absPath) fileCache.delete(absPath);
	else fileCache.clear();
}

/** @internal Test-only: ordered snapshot of cached paths (LRU head → tail).
 *  Lets eviction order be asserted without exposing the live Map. */
export function __fileCacheOrder(): string[] {
	return [...fileCache.keys()];
}

/** Read up to `concurrency` files in parallel via readCached. Returns entries
 *  in the SAME order as the input paths (null for unreadable). */
async function readBatched(
	paths: string[],
	concurrency = 32,
): Promise<(CacheEntry | null)[]> {
	const out: (CacheEntry | null)[] = new Array(paths.length);
	let idx = 0;
	async function worker() {
		while (idx < paths.length) {
			const i = idx++;
			const p = paths[i];
			if (!p) continue;
			out[i] = await readCached(p);
		}
	}
	const n = Math.min(concurrency, paths.length);
	await Promise.all(Array.from({ length: n }, () => worker()));
	return out;
}

/** Recursively list .md files under a folder, relative to the vault root. */
async function listNotes(vaultPath: string, folder: string): Promise<string[]> {
	const root = resolve(vaultPath, folder);
	const out: string[] = [];
	async function walk(dir: string) {
		let entries: import("node:fs").Dirent<string>[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (e) {
			// Unreadable subfolder (EACCES/ENOTDIR/vanished race) → skip it and
			// keep walking the rest. Best-effort enumeration, like readCached.
			return;
		}
		for (const e of entries) {
			if (e.name === ".obsidian" || e.name.startsWith(".")) continue;
			const full = join(dir, e.name);
			if (e.isDirectory()) await walk(full);
			else if (e.isFile() && e.name.endsWith(".md")) {
				out.push(full.slice(vaultPath.length).replace(/^[/\\]+/, ""));
			}
		}
	}
	await walk(root);
	return out.sort();
}

/** Count markdown notes in a vault (best-effort: 0 on any FS error). */
async function countNotes(vaultPath: string): Promise<number> {
	try {
		return (await listNotes(vaultPath, "")).length;
	} catch {
		return 0;
	}
}

export type MatchMode = "substring" | "regex" | "words" | "fuzzy";
export type NoteField = "all" | "title" | "tags" | "body" | "frontmatter";

/** True if `needle`'s characters appear in `hay` in order (not necessarily contiguous). */
function isSubsequence(hay: string, needle: string): boolean {
	if (!needle) return true;
	let i = 0;
	for (const ch of hay) {
		if (ch === needle[i]) i++;
		if (i === needle.length) return true;
	}
	return i === needle.length;
}

/** Standard iterative Levenshtein edit distance with O(min(m,n)) rolling rows. */
function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	if (m === 0) return n;
	if (n === 0) return m;
	let prev = new Array<number>(n + 1);
	let curr = new Array<number>(n + 1);
	for (let j = 0; j <= n; j++) prev[j] = j;
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		const ca = a.charCodeAt(i - 1);
		for (let j = 1; j <= n; j++) {
			const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
			curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
		}
		const tmp = prev;
		prev = curr;
		curr = tmp;
	}
	return prev[n]!;
}

/** Fuzzy line match. Exact substring → true; else (tol 0) ordered subsequence;
 *  else (tol ≥ 1) sliding-window edit distance ≤ tol over windows of length
 *  [len-tol, len+tol]. Used for typo-tolerant search. */
export function fuzzyMatch(line: string, q: string, tol: number): boolean {
	if (!q) return false;
	if (line.includes(q)) return true;
	if (tol <= 0) return isSubsequence(line, q);
	const m = q.length;
	for (let wlen = Math.max(1, m - tol); wlen <= m + tol; wlen++) {
		for (let i = 0; i + wlen <= line.length; i++) {
			if (levenshtein(line.slice(i, i + wlen), q) <= tol) return true;
		}
	}
	return false;
}

/** Compile a query + mode + case-sensitivity into a per-line predicate.
 *  Returns { error } on invalid regex so the caller can surface a clean message
 *  instead of throwing.
 *
 *  Modes:
 *  - substring: literal substring (the historical default; byte-identical to
 *    the old lowercased-`includes` implementation when caseSensitive=false).
 *  - regex:     JS regular expression (`new RegExp(query, flags)`).
 *  - words:     boolean. Whitespace-split tokens; `-word` = NOT (file-level:
 *    excludes any file where the term appears anywhere, not just per-line);
 *    `|` separates OR groups; tokens within a group are AND.
 *  - fuzzy:     typo-tolerant via fuzzyMatch; tolerance scales with query
 *    length (≤3 chars → 0, ≤6 → 1, else 2).
 *
 *  `fileFilter` (when present) must be applied to the entire file content
 *  before per-line matching — currently emitted only by `words` mode for NOT
 *  terms so they exclude files regardless of which line the term appears on. */
/**
 * Strip backslashes before grouping/alternation regex metacharacters. Weak LLMs
 * frequently OVER-ESCAPE (e.g. `SEARCH\(WORD\|TERM\)` meaning `SEARCH(WORD|TERM)`),
 * which compiles fine but matches the literal string and yields 0 hits. Used only
 * as a 0-match fallback in regex mode, gated on the query containing an alternation
 * `|` (a literal `|` in note prose is rare, and `|` in regex is almost always OR).
 */
function deescapeRegex(q: string): string {
	return q.replace(/\\([()|])/g, "$1");
}

export function buildMatcher(
	query: string,
	mode: MatchMode,
	caseSensitive: boolean,
): {
	match?: (line: string) => boolean;
	fileFilter?: (content: string) => boolean;
	error?: string;
} {
	const ci = !caseSensitive;
	const norm = (s: string) => (ci ? s.toLowerCase() : s);
	switch (mode) {
		case "substring": {
			const needle = norm(query);
			return { match: (line) => norm(line).includes(needle) };
		}
		case "regex": {
			try {
				const re = new RegExp(query, ci ? "i" : "");
				return { match: (line) => re.test(line) };
			} catch (e) {
				return { error: `Invalid regex /${query}/: ${(e as Error).message}` };
			}
		}
		case "words": {
			const tokens = query.trim().split(/\s+/).filter(Boolean);
			const negatives = tokens
				.filter((t) => t.startsWith("-") && t.length > 1)
				.map((t) => norm(t.slice(1)));
			const positives = tokens.filter(
				(t) => !(t.startsWith("-") && t.length > 1),
			);
			const groups = positives
				.join(" ")
				.split("|")
				.map((g) =>
					g
						.trim()
						.split(/\s+/)
						.filter(Boolean)
						.map((t) => norm(t)),
				);
			// NOT terms are checked at file level so a term in frontmatter/title
			// correctly excludes the whole file, not just individual lines.
			const fileFilter =
				negatives.length > 0
					? (content: string) =>
							!negatives.some((neg) => norm(content).includes(neg))
					: undefined;
			return {
				match: (line) => {
					const lc = norm(line);
					// groups.some with an empty inner array ([].every) is vacuously true,
					// which is the desired behaviour for a NOT-only query: all lines of
					// non-excluded files are returned.
					return groups.some((g) => g.every((t) => lc.includes(t)));
				},
				fileFilter,
			};
		}
		case "fuzzy": {
			const q = norm(query);
			const tol = q.length <= 3 ? 0 : q.length <= 6 ? 1 : 2;
			return { match: (line) => fuzzyMatch(norm(line), q, tol) };
		}
		default:
			return { error: `Unknown matchMode: ${mode}` };
	}
}

/** Per-line (0-indexed) classification into note-section labels.
 *  - frontmatter block (incl. `---` fences) → "frontmatter"; a `tags:`/`tag:`
 *    line inside it also → "tags".
 *  - first H1 (`# ...`) → "title".
 *  - other lines → "body"; body lines with an inline `#tag` also → "tags". */
export function computeFieldLabels(lines: string[]): Set<NoteField>[] {
	const labels: Set<NoteField>[] = new Array(lines.length);
	let fmStart = -1;
	let fmEnd = -1;
	if (lines.length > 0 && lines[0]!.trim() === "---") {
		fmStart = 0;
		for (let i = 1; i < lines.length; i++) {
			if (lines[i]!.trim() === "---") {
				fmEnd = i;
				break;
			}
		}
		if (fmEnd === -1) fmStart = -1; // unterminated → no frontmatter
	}
	let titleIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (/^#\s+\S/.test(lines[i]!)) {
			titleIdx = i;
			break;
		}
	}
	const inlineTagRe = /(^|\s)#[A-Za-z0-9_-]+/;
	for (let i = 0; i < lines.length; i++) {
		const s = new Set<NoteField>();
		if (fmStart !== -1 && i >= fmStart && i <= fmEnd) {
			s.add("frontmatter");
			if (/^\s*tags?\s*:/.test(lines[i]!)) s.add("tags");
		} else if (i === titleIdx) {
			s.add("title");
		} else {
			s.add("body");
			if (inlineTagRe.test(lines[i]!)) s.add("tags");
		}
		labels[i] = s;
	}
	return labels;
}

/** One search hit, possibly enriched with field label and relevance score. */
export interface SearchMatch {
	file: string;
	line: number;
	text: string;
	/** Which note section this hit fell in (only when `enrich` / scoring is on). */
	field?: NoteField;
	/** Relevance weight of this hit (only when scoring is on). */
	score?: number;
}

/** Parse frontmatter `created:` (YYYY-MM-DD) → epoch days; 0 if absent/invalid. */
function noteRecencyDays(content: string): number {
	const m = content.match(
		/^---\n[\s\S]*?\ncreated:\s*["']?(\d{4}-\d{2}-\d{2})/m,
	);
	if (!m) return 0;
	const t = Date.parse(m[1]!);
	return Number.isNaN(t) ? 0 : Math.floor(t / 86_400_000);
}

/** Relevance weight of a hit by field. Per plan: title +10 | tag +6 | frontmatter +3 | body +1. */
function fieldWeight(field: NoteField | undefined): number {
	switch (field) {
		case "title":
			return 10;
		case "tags":
			return 6;
		case "frontmatter":
			return 3;
		default:
			return 1; // body / unknown
	}
}

/** Pick the most specific field label on a line for scoring. */
function pickField(labels: Set<NoteField> | undefined): NoteField | undefined {
	if (!labels) return undefined;
	if (labels.has("title")) return "title";
	if (labels.has("tags")) return "tags";
	if (labels.has("frontmatter")) return "frontmatter";
	return "body";
}

/** Full-text search across the vault. Returns matches, optionally enriched
 *  with field labels, relevance scores, and sorted/grouped.
 *
 *  Options:
 *  - match:       per-line predicate (build via buildMatcher).
 *  - fields:      restrict eligible note sections; null/["all"] = everywhere.
 *  - folder:      restrict to a sub-tree; "" = whole vault.
 *  - context:     lines of surrounding context per match (0 = single line).
 *                When >0, the match `text` is replaced by an indented `> ` block
 *                showing [lo..hi] lines with the hit line marked `> `.
 *  - sort:        "file" (default: alphabetical traversal order) | "relevance"
 *                | "recency". relevance ranks by summed field weight per file
 *                then by per-hit weight; recency by frontmatter `created:` desc.
 *  - groupByFile: collapse to at most `perFile` matches per file (default false).
 *  - perFile:     max matches to keep per file when groupByFile (default 3).
 *  - max:         hard cap on total returned matches; early return.
 *  - enrich:      populate `field` + `score` on each match. Auto-enabled when
 *                sort is "relevance". Default false keeps results lean.
 *
 *  Default behavior (match + fields:null + folder:"" + context:0 + sort:"file"
 *  + groupByFile:false + enrich:false) is byte-identical to the historical
 *  implementation: {file,line,text} in alphabetical traversal order, hard-capped. */
export async function searchVault(
	vaultPath: string,
	opts: {
		match: (line: string) => boolean;
		/** Optional file-level pre-filter. When present, files for which this
		 *  returns false are skipped entirely before per-line matching. Used by
		 *  `words` mode to apply NOT exclusions at file scope. */
		fileFilter?: (content: string) => boolean;
		fields: NoteField[] | null;
		folder: string;
		context?: number;
		sort?: "file" | "relevance" | "recency";
		groupByFile?: boolean;
		perFile?: number;
		max: number;
		enrich?: boolean;
		/** B4.3: restrict matching to this exact set of vault-relative paths
		 *  (e.g. pipe in queryNotes() output). When set, `folder` is ignored. */
		paths?: string[];
	},
): Promise<SearchMatch[]> {
	const allowedPaths = opts.paths ? new Set(opts.paths) : null;
	// Phase 6 validation: when an explicit path set is given, skip the O(n)
	// listNotes readdir — the caller (e.g. C5 trigram candidates) has already
	// scoped the search, and listNotes otherwise dominated wall-time on large
	// vaults, masking the trigram win. When a folder restriction is ALSO in
	// play, intersect it with the candidate set by prefix (the candidates are
	// vault-relative paths) rather than re-enumerating the vault — otherwise a
	// folder-scoped substring search silently loses the C5 speedup. Falls back
	// to listNotes only when there is no explicit path set (unscoped search).
	const folder = opts.folder ?? "";
	const inFolder = (p: string) => !folder || p.startsWith(folder + "/") || p === folder;
	const files = allowedPaths
		? [...allowedPaths].filter(inFolder)
		: await listNotes(vaultPath, opts.folder);
	const fieldFilter =
		opts.fields && !opts.fields.includes("all") ? new Set(opts.fields) : null;
	const contextN = opts.context ?? 0;
	const sort = opts.sort ?? "file";
	const groupByFile = opts.groupByFile ?? false;
	const perFile = opts.perFile ?? 3;
	const enrich = opts.enrich ?? sort === "relevance";
	const max = opts.max;

	// Need per-line field labels when filtering by field OR scoring/enriching.
	const needLabels = !!fieldFilter || enrich;

	// file -> matches (in traversal order). Keep raw line indices + content for context.
	const byFile = new Map<string, { i: number; m: SearchMatch }[]>();
	const fileLines = new Map<string, string[]>(); // for context rendering
	const fileRecency = new Map<string, number>(); // for recency sort

	// Parallel cached reads (Phase 3). `files` is already alphabetical; readBatched
	// preserves order so the default "file" sort stays identical to the old impl.
	const entries = await readBatched(files.map((f) => join(vaultPath, f)));
	for (let fi = 0; fi < files.length; fi++) {
		const f = files[fi];
		if (!f) continue;
		if (allowedPaths && !allowedPaths.has(f)) continue;
		const entry = entries[fi];
		if (!entry) continue;
		// File-level pre-filter (e.g. words mode NOT exclusion).
		if (opts.fileFilter && !opts.fileFilter(entry.content)) continue;
		const lines = entry.lines;
		if (sort === "recency") fileRecency.set(f, noteRecencyDays(entry.content));
		const labels = needLabels ? computeFieldLabels(lines) : null;

		for (let i = 0; i < lines.length; i++) {
			let lineLabels: Set<NoteField> | undefined;
			if (needLabels) {
				lineLabels = labels![i];
				if (!lineLabels) continue;
				if (fieldFilter) {
					let eligible = false;
					for (const lf of lineLabels)
						if ((fieldFilter as Set<NoteField>).has(lf)) {
							eligible = true;
							break;
						}
					if (!eligible) continue;
				}
			}
			const li = lines[i]!;
			if (!opts.match(li)) continue;

			const field = enrich ? pickField(lineLabels) : undefined;
			const m: SearchMatch = {
				file: f,
				line: i + 1,
				text: li.trim(),
				field,
				score: enrich ? fieldWeight(field) : undefined,
			};
			if (!enrich) {
				delete m.field;
				delete m.score;
			}
			let arr = byFile.get(f);
			if (!arr) {
				arr = [];
				byFile.set(f, arr);
			}
			arr.push({ i, m });
			if (contextN > 0 && !fileLines.has(f)) fileLines.set(f, lines);
		}
	}

	// Order files per chosen sort.
	let orderedFiles: string[];
	if (sort === "relevance") {
		orderedFiles = [...byFile.keys()].sort((a, b) => {
			const sa = (byFile.get(a) ?? []).reduce(
				(s, e) => s + (e.m.score ?? 0),
				0,
			);
			const sb = (byFile.get(b) ?? []).reduce(
				(s, e) => s + (e.m.score ?? 0),
				0,
			);
			return sb - sa || a.localeCompare(b);
		});
	} else if (sort === "recency") {
		orderedFiles = [...byFile.keys()].sort(
			(a, b) =>
				(fileRecency.get(b) ?? 0) - (fileRecency.get(a) ?? 0) ||
				a.localeCompare(b),
		);
	} else {
		orderedFiles = [...byFile.keys()]; // Map preserves insertion = alphabetical traversal
	}

	const results: SearchMatch[] = [];
	for (const f of orderedFiles) {
		const arr = byFile.get(f) ?? [];
		// For relevance, also order hits within a file by score desc.
		const orderedHits =
			sort === "relevance"
				? [...arr].sort(
						(a, b) => (b.m.score ?? 0) - (a.m.score ?? 0) || a.i - b.i,
					)
				: arr;
		const kept = groupByFile ? orderedHits.slice(0, perFile) : orderedHits;

		for (const { i, m } of kept) {
			if (contextN > 0) {
				const ls = fileLines.get(f);
				if (ls) m.text = renderContext(ls, i, contextN, m.text);
			}
			results.push(m);
			if (results.length >= max) return results;
		}
	}
	return results;
}

/** Render a context snippet: lines [i-n .. i+n], hit line prefixed `> `, others `  `. */
function renderContext(
	lines: string[],
	i: number,
	n: number,
	hitText: string,
): string {
	const lo = Math.max(0, i - n);
	const hi = Math.min(lines.length - 1, i + n);
	const out: string[] = [];
	for (let j = lo; j <= hi; j++) {
		const raw = lines[j]!;
		const t = raw.trim();
		if (j === i) out.push(`> ${hitText}`);
		else out.push(`  ${t}`);
	}
	return out.join("\n");
}

/** Match [[Target]] wiki-links on a line. Returns the inner target strings.
 *  Handles display aliases `[[Target|Display]]` and path targets `[[A/B/C]]`. */
function extractWikiLinks(line: string): string[] {
	const re = /\[\[([^\]]+)\]\]/g;
	const out: string[] = [];
	let mm: RegExpExecArray | null;
	while ((mm = re.exec(line))) {
		let target = mm[1]!;
		const pipe = target.indexOf("|");
		if (pipe !== -1) target = target.slice(0, pipe); // drop alias
		target = target.replace(/#.*$/, "").trim(); // drop heading ref
		if (target) out.push(target);
	}
	return out;
}

// ---- Frontmatter parser (C1) ----------------------------------------------

export interface ParsedFrontmatter {
	data: Record<string, any>;
	bodyStart: number; // line index where body begins (after closing ---)
}

/** Parse a YAML-ish frontmatter block (delimited by --- at line 0) into an
 *  object. Supports: flow `key: [a, b]`, block `key:\n  - a`, scalars, quoted
 *  strings. Returns {data: {}, bodyStart: 0} if no frontmatter. (C1.1) */
export function parseFrontmatter(content: string): ParsedFrontmatter {
	const lines = content.split("\n");
	if (lines.length === 0 || lines[0]!.trim() !== "---")
		return { data: {}, bodyStart: 0 };
	let end = -1;
	for (let i = 1; i < lines.length; i++)
		if (lines[i]!.trim() === "---") {
			end = i;
			break;
		}
	if (end === -1) return { data: {}, bodyStart: 0 }; // unterminated
	const data: Record<string, any> = {};
	let i = 1;
	while (i < end) {
		const line = lines[i]!;
		const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
		if (!m) {
			i++;
			continue;
		}
		const key = m[1]!;
		const val = m[2]!.trim();
		if (val === "") {
			// block list: subsequent indented "- item" lines
			const items: any[] = [];
			let j = i + 1;
			for (; j < end; j++) {
				const bm = lines[j]!.match(/^\s+-\s+(.*)$/);
				if (!bm) break;
				items.push(stripScalar(bm[1]!));
			}
			data[key] = items.length ? items : "";
			i = j;
		} else if (val.startsWith("[")) {
			// flow list [a, b, c]
			const inner = val.replace(/^\[/, "").replace(/\]$/, "");
			data[key] = inner
				.split(",")
				.map((s) => stripScalar(s))
				.filter((s) => s !== "");
			i++;
		} else {
			data[key] = stripScalar(val);
			i++;
		}
	}
	return { data, bodyStart: end + 1 };
}

function stripScalar(s: string): any {
	const t = s.trim().replace(/^["']/, "").replace(/["']$/, "");
	if (t === "true") return true;
	if (t === "false") return false;
	if (t === "null" || t === "") return null;
	return t;
}

// ---- Vault index (B1) ------------------------------------------------------
// Session-scoped derived index over the vault: title/tags/links adjacency,
// plus reverse maps (byTag, byTitle, reverseAdjacency) for O(1) graph queries.
// Built lazily on first use, incrementally updated on write (reindexFile).

export interface NoteMeta {
	path: string; // vault-relative, e.g. "Zettelkasten/Foo.md"
	title: string; // first H1 text, lowercased for lookup
	tags: string[]; // normalized, lowercased, no leading #
	links: string[]; // outgoing [[targets]], normalized (no .md, no alias/section)
	created?: string; // frontmatter created (YYYY-MM-DD)
	mtime: number; // last indexed mtime (ms)
	// Phase 6 / WS-C5: lowercase 3-grams of the note's full content, used to
	// pre-filter substring searches (trigram inverted index). A superset of all
	// searchable fields, so candidate filtering is always sound (never drops a
	// real hit) — only slightly loose across fields. Not persisted (C6 rebuilds
	// from content); hence omitted from serialization.
	trigrams: Set<string>;
}

export interface VaultIndex {
	vaultPath: string;
	notes: Map<string, NoteMeta>;
	byTag: Map<string, Set<string>>;
	byTitle: Map<string, string>; // lowercased title/path/basename -> path
	reverseAdjacency: Map<string, Set<string>>; // targetPath -> Set<sourcePath>
	// Phase 6 / WS-C5: trigram -> Set<notePath> inverted index for substring
	// search pre-filtering. Maintained incrementally by indexNote/unindexNote
	// (like byTag), so no rev/invalidation needed.
	trigrams: Map<string, Set<string>>;
	// Phase 3 / WS-C2: memoized undirected adjacency for graph queries.
	// Built lazily by getAdjacency(); invalidated by bumping `rev` on every
	// note mutation (indexNote/unindexNote). graphNeighbors rebuilds only when
	// adjacencyRev !== rev, instead of O(n) per call.
	rev: number; // mutation counter; bump on any notes change
	adjacency?: Map<string, Set<string>>; // undirected: path -> Set<neighborPath>
	adjacencyRev?: number; // rev the cache was built at
}

/** Compute the set of lowercase 3-grams of a string (Phase 6 / WS-C5).
 *  Used for substring-search candidate pre-filtering. Covers the FULL content
 *  (a superset of every searchable field) so trigram-based candidate sets are
 *  always a sound over-approximation — they never exclude a real hit. */
function contentTrigrams(text: string): Set<string> {
	const s = new Set<string>();
	const lower = text.toLowerCase();
	for (let i = 0; i + 3 <= lower.length; i++) s.add(lower.slice(i, i + 3));
	return s;
}

/** Phase 6 / WS-C5 — narrow the substring-search candidate set via the trigram
 *  inverted index. Returns the set of note paths containing EVERY trigram of
 *  the query (a sound over-approximation: a file missing any query trigram
 *  cannot contain the query substring, so it is safely excluded). Returns null
 *  when filtering is not applicable (query shorter than 3 chars, or the index
 *  has no trigram map yet) — caller then falls back to scanning all files.
 *  Returns an empty set when some query trigram is absent from the vault. */
export function trigramCandidates(
	idx: VaultIndex | undefined,
	query: string,
): Set<string> | null {
	if (!idx || !idx.trigrams || query.length < 3) return null;
	const q = query.toLowerCase();
	let result: Set<string> | null = null;
	for (let i = 0; i + 3 <= q.length; i++) {
		const paths = idx.trigrams.get(q.slice(i, i + 3));
		if (!paths || paths.size === 0) return new Set(); // trigram absent → no hit possible
		if (!result) {
			result = new Set(paths);
		} else {
			for (const p of result) if (!paths.has(p)) result.delete(p);
		}
		if (result.size === 0) return result;
	}
	return result;
}

/** Parse a note into NoteMeta (no I/O). Reused by index build + reindex. */
function parseNoteMeta(path: string, content: string, mtime: number): NoteMeta {
	const lines = content.split("\n");
	// title = first H1
	let title = "";
	for (const l of lines) {
		const m = l.match(/^#\s+(.+?)\s*$/);
		if (m) {
			title = m[1]!;
			break;
		}
	}
	// tags: frontmatter + inline
	const tags = new Set<string>();
	let inFm = false,
		fmDone = false;
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i]!;
		if (!fmDone && i === 0 && l.trim() === "---") {
			inFm = true;
			continue;
		}
		if (inFm && l.trim() === "---") {
			inFm = false;
			fmDone = true;
			continue;
		}
		if (inFm && /^\s*tags?\s*:/.test(l)) {
			const arr = l.replace(/^\s*tags?\s*:\s*/, "");
			for (const raw of arr.split(",")) {
				const t = raw
					.replace(/[[\]"']/g, "")
					.trim()
					.toLowerCase();
				if (t) tags.add(t);
			}
		} else if (!inFm) {
			const re = /(^|\s)#([A-Za-z0-9_-]+)/g;
			let mm;
			while ((mm = re.exec(l))) tags.add(mm[2]!.toLowerCase());
		}
	}
	// created
	let created: string | undefined;
	const cm = content.match(
		/^---\n[\s\S]*?^created:\s*["']?(\d{4}-\d{2}-\d{2})/m,
	);
	if (cm) created = cm[1]!;
	// links
	const links = new Set<string>();
	for (const l of lines)
		for (const link of extractWikiLinks(l)) {
			links.add(link.replace(/\.md$/i, ""));
		}
	return {
		path,
		title: title.toLowerCase(),
		tags: [...tags],
		links: [...links],
		created,
		mtime,
		trigrams: contentTrigrams(content),
	};
}

const indexCache = new Map<string, VaultIndex>();
// Phase 3 / WS-C4: in-flight index builds, so concurrent getIndex() calls on
// the same (uncached) vault share ONE buildIndex instead of racing parallel
// full-vault scans. Resolved + cleared once the build settles into indexCache.
const indexInFlight = new Map<string, Promise<VaultIndex>>();

// ---- Index coherence (Phase 4: WS-A5 + WS-C3) -----------------------------
// The file cache (readCached) is already mtime-coherent per read. The INDEX,
// however, is built once and cached — so external edits (e.g. a note changed in
// the Obsidian app mid-session) left byTag / byTitle / reverseAdjacency stale
// until a manual obsidian_invalidate. refreshIndex() fixes that incrementally:
// it re-enumerates the vault (readdir + stat only — no content read) and
// reindexes just the files whose mtime changed, plus picks up adds/deletes.
// Throttled so a burst of tool calls within one turn doesn't re-scan repeatedly.
// Poll window is read live from env so it can be tuned at runtime (and set to 0
// in tests to disable throttling without waiting).
const INDEX_POLL_MS_DEFAULT = 2000;
const indexPollMs = () => Number(process.env.OB_INDEX_POLL_MS ?? INDEX_POLL_MS_DEFAULT);
const indexRefreshAt = new Map<string, number>(); // vault real path -> ms of last refresh

/** Get or lazily build the index for a vault. On a cache hit, opportunistically
 *  refresh incrementally (throttled) so external edits are picked up without a
 *  manual invalidate. */
export async function getIndex(vaultPath: string): Promise<VaultIndex> {
	const real = resolve(vaultPath);
	let idx = indexCache.get(real);
	if (idx) {
		await refreshIndex(idx, { force: false });
		return idx;
	}
	// Phase 3 / WS-C4: single-flight — if another caller is already building
	// this vault's index, await its promise rather than starting a parallel scan.
	let inflight = indexInFlight.get(real);
	if (!inflight) {
		inflight = (async () => {
			try {
				// Phase 6 / WS-C6: try a persisted index first (stat-validated);
				// only fall back to a full O(n) buildIndex if there's no cache.
				let built = await loadCachedIndex(real);
				if (!built) built = await buildIndex(real);
				indexCache.set(real, built);
				indexRefreshAt.set(real, Date.now());
				// persist for next session (best-effort, non-blocking)
				void saveIndex(built).catch(() => {});
				return built;
			} finally {
				indexInFlight.delete(real);
			}
		})();
		indexInFlight.set(real, inflight);
	}
	return inflight;
}

/** Build a fresh index over the whole vault. O(n). */
export async function buildIndex(vaultPath: string): Promise<VaultIndex> {
	const real = resolve(vaultPath);
	const files = await listNotes(real, "");
	const paths = files.map((f) => join(real, f));
	const entries = await readBatched(paths);
	const idx: VaultIndex = {
		vaultPath: real,
		notes: new Map(),
		byTag: new Map(),
		byTitle: new Map(),
		reverseAdjacency: new Map(),
		trigrams: new Map(),
		rev: 0,
	};
	for (let i = 0; i < files.length; i++) {
		const entry = entries[i];
		if (!entry) continue;
		const meta = parseNoteMeta(files[i]!, entry.content, entry.mtime);
		indexNote(idx, meta);
	}
	// Second pass: now that all notes are in byTitle, recompute link resolution
	// so reverseAdjacency keys are actual note paths (a link added before its
	// target was indexed would otherwise key on the raw lowercased target).
	rebuildReverseAdjacency(idx);
	return idx;
}

/** Second pass: recompute reverseAdjacency so its keys are actual note paths
 *  (a link parsed before its target was indexed keys on the raw target). Shared
 *  by buildIndex and loadCachedIndex. */
function rebuildReverseAdjacency(idx: VaultIndex): void {
	idx.reverseAdjacency.clear();
	for (const meta of idx.notes.values()) {
		for (const link of meta.links) {
			const resolved = resolveLink(idx, link) ?? link.toLowerCase();
			let s = idx.reverseAdjacency.get(resolved);
			if (!s) {
				s = new Set();
				idx.reverseAdjacency.set(resolved, s);
			}
			s.add(meta.path);
		}
	}
}

// ---- Cross-session index persistence (Phase 6 / WS-C6) --------------------
// The index is a module-level Map cleared on exit, so every fresh session paid
// a full O(n) buildIndex (read every file's content + parse). This persists the
// index to <vault>/.cache/pi-obsidian-index.json and, on a cold getIndex, loads
// it + stat-validates each note: notes unchanged since last session reuse their
// persisted meta (incl. trigrams — no content re-read), only changed/new notes
// are re-read. Disable with OB_INDEX_PERSIST=0; relocate the file with
// OB_INDEX_CACHE_DIR. Best-effort — any read/parse/write failure silently falls
// back to a full buildIndex.
const INDEX_CACHE_VERSION = 1;
function indexCachePath(vaultReal: string): string {
	const dir = process.env.OB_INDEX_CACHE_DIR || join(vaultReal, ".cache");
	return join(dir, "pi-obsidian-index.json");
}

/** Parallel stat → mtimeMs (null for absent). */
async function statMtimes(absPaths: string[]): Promise<(number | null)[]> {
	return Promise.all(
		absPaths.map((p) =>
			stat(p)
				.then((s) => s.mtimeMs)
				.catch(() => null),
		),
	);
}

/** Serialize the index to a plain JSON-safe object. Persisted notes carry their
 *  trigrams so a warm reload needs NO content re-read (keeps C5 trigram search
 *  working across sessions). Derived maps (byTag/byTitle/reverseAdjacency/
 *  trigrams-inverted) are rebuilt on load, not stored. */
export function serializeIndex(idx: VaultIndex): {
	version: number;
	vaultPath: string;
	rev: number;
	notes: any[];
} {
	return {
		version: INDEX_CACHE_VERSION,
		vaultPath: idx.vaultPath,
		rev: idx.rev,
		notes: [...idx.notes.values()].map((n) => ({
			path: n.path,
			title: n.title,
			tags: n.tags,
			links: n.links,
			created: n.created,
			mtime: n.mtime,
			trigrams: [...n.trigrams],
		})),
	};
}

/** Write the index to disk (best-effort, never throws). */
export async function saveIndex(idx: VaultIndex): Promise<void> {
	if (process.env.OB_INDEX_PERSIST === "0") return;
	try {
		const path = indexCachePath(idx.vaultPath);
		await mkdir(join(path, ".."), { recursive: true });
		await atomicWriteFile(path, JSON.stringify(serializeIndex(idx)));
	} catch {
		// best-effort: a failed save just means a full rebuild next session
	}
}

/** Load + mtime-validate a persisted index. Returns null when there is no
 *  cache, it's the wrong version, or anything goes wrong (caller falls back to
 *  buildIndex). Notes unchanged on disk reuse their persisted meta (incl.
 *  trigrams); changed/new notes are re-read and re-parsed. */
export async function loadCachedIndex(
	vaultReal: string,
): Promise<VaultIndex | null> {
	if (process.env.OB_INDEX_PERSIST === "0") return null;
	let raw: string;
	try {
		raw = await readFile(indexCachePath(vaultReal), "utf8");
	} catch {
		return null;
	}
	let data: any;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!data || data.version !== INDEX_CACHE_VERSION || !Array.isArray(data.notes))
		return null;

	const files = await listNotes(vaultReal, "");
	const persisted = new Map<string, any>(data.notes.map((n: any) => [n.path, n]));
	const mtimes = await statMtimes(files.map((f) => join(vaultReal, f)));

	const idx: VaultIndex = {
		vaultPath: vaultReal,
		notes: new Map(),
		byTag: new Map(),
		byTitle: new Map(),
		reverseAdjacency: new Map(),
		trigrams: new Map(),
		rev: 0,
	};
	const stale: string[] = [];
	for (let i = 0; i < files.length; i++) {
		const f = files[i];
		if (!f) continue;
		const mtime = mtimes[i];
		const p = persisted.get(f);
		if (mtime !== null && p && p.mtime === mtime) {
			// unchanged since last session — reuse persisted meta (trigrams incl.)
			indexNote(idx, {
				path: p.path,
				title: p.title,
				tags: Array.isArray(p.tags) ? p.tags : [],
				links: Array.isArray(p.links) ? p.links : [],
				created: p.created,
				mtime: p.mtime,
				trigrams: new Set(Array.isArray(p.trigrams) ? p.trigrams : []),
			});
		} else {
			// changed or new — must re-read content
			stale.push(f);
		}
	}
	if (stale.length > 0) {
		const entries = await readBatched(stale.map((f) => join(vaultReal, f)));
		for (let i = 0; i < stale.length; i++) {
			const entry = entries[i];
			if (!entry) continue;
			indexNote(idx, parseNoteMeta(stale[i]!, entry.content, entry.mtime));
		}
	}
	rebuildReverseAdjacency(idx);
	return idx;
}

/** Resolve a tool-name allowlist from an env var (comma-separated), falling
 *  back to `defaults` when unset/empty. Used by distill/garden so a custom
 *  workflow can override the tool set without code changes (Phase 5 / WS-B6).
 *  Empty/whitespace-only entries are dropped; an all-empty value falls back. */
export function toolAllowlist(envVar: string, defaults: string[]): string[] {
	const raw = process.env[envVar];
	if (!raw || !raw.trim()) return defaults;
	const parsed = raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	return parsed.length > 0 ? parsed : defaults;
}

/** Phase 5 / WS-C8 — verify the host satisfies the ExtensionAPI contract.
 *  `core` methods are hard-required (their absence means the extension can't
 *  function → throw); `secondary` methods are warned about, not fatal, so a
 *  forward-compatible host that dropped an unused hook isn't blocked. */
export function assertExtensionApi(pi: any): void {
	const core = ["registerTool"];
	const secondary = ["registerCommand", "on"];
	const missingCore = core.filter((m) => typeof pi?.[m] !== "function");
	if (missingCore.length > 0) {
		throw new Error(
			`pi-obsidian: host does not satisfy the ExtensionAPI contract — missing core method(s): ${missingCore.join(", ")}. ` +
				`Ensure @earendil-works/pi-coding-agent is up to date (the host vendors an inline copy of ExtensionAPI).`,
		);
	}
	const missingSecondary = secondary.filter((m) => typeof pi?.[m] !== "function");
	if (missingSecondary.length > 0) {
		console.error(
			`pi-obsidian: warning — host ExtensionAPI is missing secondary method(s): ${missingSecondary.join(", ")} (commands/events will be unavailable but tools still register).`,
		);
	}
}

/** Keys under which a note should be discoverable in byTitle: its lowercased
 *  title (H1) AND its lowercased path-without-extension AND bare basename.
 *  This lets `[[Name]]`, `[[folder/Name]]`, and title-based links all resolve. */
function titleKeysFor(meta: NoteMeta): string[] {
	const keys = new Set<string>();
	if (meta.title) keys.add(meta.title);
	const noExt = meta.path.replace(/\.md$/i, "").toLowerCase();
	keys.add(noExt);
	keys.add(noExt.split("/").pop() ?? noExt);
	return [...keys];
}

/** Insert/update a single note's meta in the index. */
function indexNote(idx: VaultIndex, meta: NoteMeta): void {
	// remove any prior entry for this path (incremental reindex)
	unindexNote(idx, meta.path);
	idx.notes.set(meta.path, meta);
	for (const k of titleKeysFor(meta)) idx.byTitle.set(k, meta.path);
	for (const t of meta.tags) {
		let s = idx.byTag.get(t);
		if (!s) {
			s = new Set();
			idx.byTag.set(t, s);
		}
		s.add(meta.path);
	}
	for (const link of meta.links) {
		const resolved = resolveLink(idx, link) ?? link.toLowerCase();
		let s = idx.reverseAdjacency.get(resolved);
		if (!s) {
			s = new Set();
			idx.reverseAdjacency.set(resolved, s);
		}
		s.add(meta.path);
	}
	// Phase 6 / WS-C5: trigram inverted index.
	for (const tg of meta.trigrams) {
		let s = idx.trigrams.get(tg);
		if (!s) {
			s = new Set();
			idx.trigrams.set(tg, s);
		}
		s.add(meta.path);
	}
	idx.rev++; // Phase 3 / WS-C2: invalidate memoized adjacency
}

/** Remove a note from all index maps. */
function unindexNote(idx: VaultIndex, path: string): void {
	const old = idx.notes.get(path);
	if (!old) return;
	idx.rev++; // Phase 3 / WS-C2: invalidate memoized adjacency
	idx.notes.delete(path);
	for (const k of titleKeysFor(old))
		if (idx.byTitle.get(k) === path) idx.byTitle.delete(k);
	for (const t of old.tags) {
		const s = idx.byTag.get(t);
		if (s) {
			s.delete(path);
			if (s.size === 0) idx.byTag.delete(t);
		}
	}
	for (const link of old.links) {
		const resolved = resolveLink(idx, link) ?? link.toLowerCase();
		const s = idx.reverseAdjacency.get(resolved);
		if (s) {
			s.delete(path);
			if (s.size === 0) idx.reverseAdjacency.delete(resolved);
		}
	}
	// Phase 6 / WS-C5: remove from trigram inverted index.
	for (const tg of old.trigrams) {
		const s = idx.trigrams.get(tg);
		if (s) {
			s.delete(path);
			if (s.size === 0) idx.trigrams.delete(tg);
		}
	}
}

/** Resolve a wiki-link target to an actual note path via byTitle (exact, then basename). */
function resolveLink(idx: VaultIndex, target: string): string | undefined {
	const t = target.replace(/\.md$/i, "").toLowerCase();
	if (idx.byTitle.has(t)) return idx.byTitle.get(t)!;
	const base = t.split("/").pop() ?? t;
	if (idx.byTitle.has(base)) return idx.byTitle.get(base)!;
	return undefined;
}

/** Reindex a single file (called after writes). Reads through the cache. */
export async function reindexFile(
	vaultPath: string,
	notePath: string,
): Promise<void> {
	const real = resolve(vaultPath);
	const idx = indexCache.get(real);
	if (!idx) return; // not yet built; lazy build will pick it up
	const abs = join(real, notePath);
	const entry = await readCached(abs);
	if (!entry) {
		unindexNote(idx, notePath);
		return;
	}
	indexNote(idx, parseNoteMeta(notePath, entry.content, entry.mtime));
}

/** Drop the index for a vault (forces rebuild on next getIndex). */
export function dropIndex(vaultPath: string): void {
	indexCache.delete(resolve(vaultPath));
}

/** Incrementally reconcile the index with the current on-disk vault state.
 *  Readdir + stat every file (cheap — no content read), then reindex only the
 *  changed/added files and drop the deleted ones. Returns a small diff summary
 *  so callers (obsidian_invalidate, tests) can report what changed.
 *
 *  Throttled by INDEX_POLL_MS unless `force` is true (used by the explicit
 *  obsidian_invalidate tool and write paths, which want immediate effect). */
export async function refreshIndex(
	idx: VaultIndex,
	opts: { force?: boolean } = {},
): Promise<{ added: number; changed: number; deleted: number }> {
	const real = idx.vaultPath;
	const now = Date.now();
	if (!opts.force && now - (indexRefreshAt.get(real) ?? 0) < indexPollMs()) {
		return { added: 0, changed: 0, deleted: 0 };
	}
	indexRefreshAt.set(real, now);

	const files = await listNotes(real, "");
	const seen = new Set<string>();
	const toReindex: string[] = [];
	let added = 0;
	let changed = 0;
	for (const f of files) {
		seen.add(f);
		const abs = join(real, f);
		let st;
		try {
			st = await stat(abs);
		} catch {
			continue; // vanished between readdir and stat; next refresh retries
		}
		const prev = idx.notes.get(f);
		if (!prev) added++;
		else if (prev.mtime !== st.mtimeMs) changed++;
		else continue;
		toReindex.push(f);
	}
	// Deleted externally: indexed paths no longer present on disk.
	const deleted: string[] = [];
	for (const p of idx.notes.keys()) if (!seen.has(p)) deleted.push(p);

	for (const f of toReindex) {
		const entry = await readCached(join(real, f));
		if (entry) indexNote(idx, parseNoteMeta(f, entry.content, entry.mtime));
		// (if readCached returned null — race: file gone — unindex below via deleted)
	}
	for (const f of deleted) unindexNote(idx, f);

	return { added, changed, deleted: deleted.length };
}

/** Resolve a wiki-link target to a note path (exported for tests/B3). */
export function resolveWikiLink(
	idx: VaultIndex,
	target: string,
): string | undefined {
	return resolveLink(idx, target);
}

/** O(1) backlink path set via index.reverseAdjacency (B1.2). */
export function backlinkPaths(idx: VaultIndex, target: string): Set<string> {
	const t = target.replace(/\.md$/i, "").toLowerCase();
	const resolved =
		idx.byTitle.get(t) ?? idx.byTitle.get(t.split("/").pop() ?? t) ?? t;
	return idx.reverseAdjacency.get(resolved) ?? new Set();
}

/** O(1) tag path set via index.byTag (B1.2). */
export function tagPaths(idx: VaultIndex, tag: string): Set<string> {
	return idx.byTag.get(tag.replace(/^#/, "").toLowerCase()) ?? new Set();
}

// ---- Graph queries (B2) ----------------------------------------------------

export type GraphMode =
	| "backlinks"
	| "outgoing"
	| "orphans"
	| "dead-links"
	| "neighbors";

export interface GraphResult {
	path: string;
	line?: number; // 0 when not applicable
	text: string; // title or the offending link line
	depth?: number; // only for neighbors
}

/** Outgoing links of a note (B2.1). */
export function graphOutgoing(idx: VaultIndex, note: string): GraphResult[] {
	const path =
		idx.byTitle.get(note.toLowerCase()) ??
		idx.byTitle.get(note.toLowerCase().split("/").pop() ?? note);
	if (!path) return [];
	const meta = idx.notes.get(path);
	if (!meta) return [];
	const out: GraphResult[] = [];
	for (const link of meta.links) {
		const resolved = resolveLink(idx, link);
		out.push({
			path: resolved ?? link,
			text: `[[${link}]]${resolved ? "" : " (unresolved)"}`,
		});
	}
	return out;
}

/** Orphan notes: no inbound links (B2.2). An orphan is a note that no
 *  other note links TO — i.e. it never appears as a resolved target in
 *  reverseAdjacency (whose KEYS are link targets). */
export function graphOrphans(idx: VaultIndex): GraphResult[] {
	const linkedTargets = new Set<string>();
	for (const target of idx.reverseAdjacency.keys()) linkedTargets.add(target);
	return [...idx.notes.values()]
		.filter((m) => !linkedTargets.has(m.path))
		.map((m) => ({ path: m.path, text: m.title || m.path }));
}

/** Dead links: [[Target]] whose target is not in byTitle (B2.3).
 *  Requires re-reading source files for line numbers; falls back to no-line. */
export function graphDeadLinks(idx: VaultIndex): GraphResult[] {
	const out: GraphResult[] = [];
	for (const meta of idx.notes.values()) {
		for (const link of meta.links) {
			if (!resolveLink(idx, link)) {
				out.push({ path: meta.path, text: `[[${link}]]` });
			}
		}
	}
	return out;
}

/** Build the undirected adjacency map (path -> Set<neighborPath>) from notes'
 *  resolved links. Phase 3 / WS-C2: memoized on the index via getAdjacency()
 *  so repeated graphNeighbors calls don't rebuild it O(n) each time. */
function buildAdjacency(idx: VaultIndex): Map<string, Set<string>> {
	const adj = new Map<string, Set<string>>();
	const addEdge = (a: string, b: string) => {
		if (!adj.has(a)) adj.set(a, new Set());
		if (!adj.has(b)) adj.set(b, new Set());
		adj.get(a)!.add(b);
		adj.get(b)!.add(a);
	};
	for (const meta of idx.notes.values()) {
		for (const link of meta.links) {
			const resolved = resolveLink(idx, link) ?? link;
			addEdge(meta.path, resolved);
		}
	}
	return adj;
}

/** Return the memoized undirected adjacency, rebuilding only when notes changed
 *  since the last build (tracked by idx.rev). Phase 3 / WS-C2. */
export function getAdjacency(idx: VaultIndex): Map<string, Set<string>> {
	if (idx.adjacency && idx.adjacencyRev === idx.rev) return idx.adjacency;
	const adj = buildAdjacency(idx);
	idx.adjacency = adj;
	idx.adjacencyRev = idx.rev;
	return adj;
}

/** N-hop neighborhood via BFS over undirected adjacency (B2.4).
 *  Phase 3 / WS-C2: uses the memoized adjacency (getAdjacency) instead of
 *  rebuilding the full edge set on every call. */
export function graphNeighbors(
	idx: VaultIndex,
	note: string,
	maxDepth = 1,
	max = 50,
): GraphResult[] {
	const startKey = note.toLowerCase();
	const startPath =
		idx.byTitle.get(startKey) ??
		idx.byTitle.get(startKey.split("/").pop() ?? startKey);
	if (!startPath) return [];
	const adj = getAdjacency(idx);
	const results: GraphResult[] = [];
	const visited = new Set<string>([startPath]);
	let frontier = [startPath];
	for (let d = 1; d <= maxDepth && frontier.length; d++) {
		const next: string[] = [];
		for (const node of frontier) {
			for (const nb of adj.get(node) ?? []) {
				if (!visited.has(nb)) {
					visited.add(nb);
					next.push(nb);
					results.push({
						path: nb,
						depth: d,
						text: idx.notes.get(nb)?.title || nb,
					});
					if (results.length >= max) return results;
				}
			}
		}
		frontier = next;
	}
	return results;
}

// ---- Structured editing (B3) -----------------------------------------------

/** Rewrite a single wiki-link reference, preserving alias and #section.
 *  Returns the new [[...]] form, or the original if it doesn't match the old target. */
function rewriteLinkToken(
	raw: string,
	oldPaths: string[],
	newTitle: string,
	newPath: string,
	idx: VaultIndex,
): string {
	// raw is the inside of [[...]]
	let target = raw;
	const pipe = target.indexOf("|");
	let alias = "";
	if (pipe !== -1) {
		alias = target.slice(pipe);
		target = target.slice(0, pipe);
	}
	let section = "";
	const hash = target.indexOf("#");
	if (hash !== -1) {
		section = target.slice(hash);
		target = target.slice(0, hash);
	}
	const t = target.replace(/\.md$/i, "").toLowerCase();
	const isMatch = oldPaths.some(
		(p) =>
			p.toLowerCase() === t ||
			p.toLowerCase().split("/").pop() === t.split("/").pop(),
	);
	if (!isMatch) return raw;
	const qualified = newPath.replace(/\.md$/i, "");
	const bare = newTitle;
	const useBare =
		idx.byTitle.has(bare.toLowerCase()) &&
		idx.byTitle.get(bare.toLowerCase()) === newPath;
	return (useBare ? bare : qualified) + section + alias;
}

// ---- Wiki-link rewrite protection (Phase 1: WS-A3) ------------------------
// move/delete rewrite inbound [[links]] across the vault. Doing that with a
// naive content.replace() corrupts regions where [[..]] is NOT a real link:
// the YAML frontmatter block, fenced code blocks, and inline `code` spans.
// rewriteLinksProtected() runs the per-link decision only over safe text.
export const LINK_KEEP = Symbol("pi-obsidian/link-keep");
export const LINK_DELETE = Symbol("pi-obsidian/link-delete");

/** Apply a per-[[link]] rewriter to file content, PROTECTING frontmatter,
 *  fenced code blocks (``` / ~~~), and inline `code` spans. The rewriter
 *  receives the raw inside of [[...]] and returns:
 *    - a string  → replace the token with [[that string]]
 *    - LINK_KEEP → leave the token untouched
 *    - LINK_DELETE → remove the token entirely (used by delete cleanup) */
export function rewriteLinksProtected(
	content: string,
	rewriter: (rawInner: string) => string | typeof LINK_KEEP | typeof LINK_DELETE,
): string {
	const linkRe = /\[\[([^\]]+)\]\]/g;
	const apply = (text: string): string =>
		text.replace(linkRe, (full, raw) => {
			const decision = rewriter(String(raw));
			if (decision === LINK_KEEP) return full;
			if (decision === LINK_DELETE) return "";
			return `[[${String(decision)}]]`;
		});
	/** Rewrite a single line, leaving inline `code` spans untouched. */
	const rewriteLine = (line: string): string => {
		let out = "";
		let last = 0;
		const inlineRe = /`[^`]*`/g;
		let m: RegExpExecArray | null;
		while ((m = inlineRe.exec(line))) {
			out += apply(line.slice(last, m.index)) + m[0];
			last = m.index + m[0].length;
		}
		out += apply(line.slice(last));
		return out;
	};

	const lines = content.split("\n");
	const out: string[] = [];
	let inFence = false;
	let fenceChar: string | null = null;
	let inFm = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		// Frontmatter: a leading "---" fence at the very top of the file.
		if (i === 0 && line.trim() === "---") {
			inFm = true;
			out.push(line);
			continue;
		}
		if (inFm) {
			if (line.trim() === "---" || line.trim() === "...") inFm = false;
			out.push(line); // protected
			continue;
		}
		// Fenced code block open/close (``` or ~~~, 3+, ≤3 leading spaces).
		const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
		if (fence) {
			const ch = fence[1]![0]!;
			if (!inFence) {
				inFence = true;
				fenceChar = ch;
			} else if (ch === fenceChar) {
				inFence = false;
				fenceChar = null;
			}
			out.push(line); // fence line protected
			continue;
		}
		if (inFence) {
			out.push(line); // protected
			continue;
		}
		out.push(rewriteLine(line));
	}
	return out.join("\n");
}

/** Move/rename a note and rewrite all inbound [[links]] (B3.1 + B3.2). */
export async function moveNote(
	vaultPath: string,
	from: string,
	to: string,
	opts: { overwrite?: boolean } = {},
): Promise<{
	moved: boolean;
	from: string;
	to: string;
	linksRewritten: string[];
	failedSources: string[];
}> {
	const real = resolve(vaultPath);
	const fromAbs = safeNotePath(real, from);
	const toAbs = safeNotePath(real, to);
	assertWritablePath(real, fromAbs);
	assertWritablePath(real, toAbs);
	await assertWithinVault(real, fromAbs);
	await assertWithinVault(real, toAbs);
	try {
		await stat(toAbs);
		if (!opts.overwrite)
			throw new Error(`Destination exists: ${to} (pass overwrite:true)`);
	} catch (e: any) {
		if (e instanceof Error && e.message.startsWith("Destination")) throw e;
	}
	const idx = await getIndex(real);
	const fromPath = from.replace(/\.md$/i, "") + ".md";
	const newPath = to.replace(/\.md$/i, "") + ".md";
	const fromMeta = idx.notes.get(fromPath);
	const fromTitle =
		fromMeta?.title ??
		fromPath.split("/").pop()!.replace(/\.md$/i, "").toLowerCase();
	const sources = backlinkPaths(idx, fromTitle);
	const linksRewritten: string[] = [];
	const failedSources: string[] = [];
	// Move the file FIRST. If the rename fails (EXDEV, read-only FS, mkdir
	// failure, destination race), we bail out before touching any backlink, so
	// the graph stays intact — links still resolve to the existing source note —
	// instead of all pointing at a destination that was never created.
	await mkdir(join(toAbs, ".."), { recursive: true });
	await renameOverwrite(fromAbs, toAbs);
	invalidateCache(fromAbs);
	invalidateCache(toAbs);
	for (const src of sources) {
		const srcAbs = join(real, src);
		try {
			const entry = await readCached(srcAbs);
			if (!entry) continue;
			let changed = false;
			const updated = rewriteLinksProtected(entry.content, (raw) => {
				const after = rewriteLinkToken(
					raw,
					[fromPath, fromTitle],
					fromTitle,
					newPath,
					idx,
				);
				if (after !== raw) {
					changed = true;
					return after;
				}
				return LINK_KEEP;
			});
			if (changed) {
				await atomicWriteFile(srcAbs, updated);
				invalidateCache(srcAbs);
				linksRewritten.push(src);
			}
		} catch (e) {
			failedSources.push(src);
		}
	}
	dropIndex(real);
	return {
		moved: true,
		from: fromPath,
		to: newPath,
		linksRewritten,
		failedSources,
	};
}

/** Delete a note and optionally strip inbound [[links]] (B3.4). */
export async function deleteNote(
	vaultPath: string,
	note: string,
	opts: { cleanupLinks?: boolean } = {},
): Promise<{ deleted: boolean; note: string; linksCleaned: string[] }> {
	const real = resolve(vaultPath);
	const abs = safeNotePath(real, note);
	assertWritablePath(real, abs);
	await assertWithinVault(real, abs);
	const cleanup = opts.cleanupLinks ?? true;
	const notePath = note.replace(/\.md$/i, "") + ".md";
	const linksCleaned: string[] = [];
	if (cleanup) {
		const idx = await getIndex(real);
		// Wiki-links target a note's FILENAME (basename), not its H1 title — links are
		// keyed in reverseAdjacency by the lowercased raw link target. Using meta.title
		// here missed [[filename]] refs whenever title !== filename (e.g. "# Old Draft"
		// inside OldDraft.md). Resolve by basename, matching how links are actually keyed.
		const target = notePath.split("/").pop()!.replace(/\.md$/i, "");
		const sources = backlinkPaths(idx, target);
		for (const src of sources) {
			const srcAbs = join(real, src);
			const entry = await readCached(srcAbs);
			if (!entry) continue;
			const tLower = target.toLowerCase();
			let changed = false;
			const updated = rewriteLinksProtected(entry.content, (raw) => {
				const tgt = raw
					.replace(/\|.*/, "")
					.replace(/#.*/, "")
					.replace(/\.md$/i, "")
					.trim()
					.toLowerCase();
				if (
					tgt === tLower ||
					tgt.split("/").pop() === tLower.split("/").pop()
				) {
					changed = true;
					return LINK_DELETE;
				}
				return LINK_KEEP;
			});
			if (changed) {
				const tidied = updated
					.split("\n")
					.filter((l, i, arr) => {
						const trimmed = l.trim();
						if (trimmed === "") {
							const prev = arr[i - 1]?.trim() ?? "x";
							const next = arr[i + 1]?.trim() ?? "x";
							return !(prev === "" && next === "");
						}
						return true;
					})
					.join("\n");
				await atomicWriteFile(srcAbs, tidied);
				invalidateCache(srcAbs);
				linksCleaned.push(src);
			}
		}
	}
	await rm(abs, { force: true });
	invalidateCache(abs);
	dropIndex(real);
	return { deleted: true, note: notePath, linksCleaned };
}

/** Serialize a frontmatter object back to text (flow-style for arrays). */
function stringifyFrontmatter(data: Record<string, any>): string {
	const lines = ["---"];
	for (const [k, v] of Object.entries(data)) {
		if (Array.isArray(v)) {
			const items = v.map((x) =>
				String(x).includes(" ") ? JSON.stringify(String(x)) : String(x),
			);
			lines.push(`${k}: [${items.join(", ")}]`);
		} else if (v === null) lines.push(`${k}: null`);
		else if (typeof v === "boolean") lines.push(`${k}: ${v}`);
		else {
			const s = String(v);
			lines.push(
				s.includes(":") || s.startsWith('"')
					? `${k}: ${JSON.stringify(s)}`
					: `${k}: ${s}`,
			);
		}
	}
	lines.push("---");
	return lines.join("\n");
}

/** Merge `patch` into a note's frontmatter without touching the body (B3.5).
 *  `tags` is special-cased: array union instead of overwrite. */
export async function updateFrontmatter(
	vaultPath: string,
	note: string,
	patch: Record<string, any>,
	opts: { expectedMtime?: number } = {},
): Promise<{ note: string; updated: string[]; bodyUntouched: boolean }> {
	const real = resolve(vaultPath);
	const abs = safeNotePath(real, note);
	assertWritablePath(real, abs);
	await assertWithinVault(real, abs);
	const entry = await readCached(abs);
	if (!entry) throw new VaultError("NOT_FOUND", `Note not found: ${note}`);
	// WS-A4: optimistic concurrency.
	const conflict = mtimeConflict(note, opts.expectedMtime, entry.mtime);
	if (conflict) throw conflict;
	const content = entry.content;
	const { data, bodyStart } = parseFrontmatter(content);
	const lines = content.split("\n");
	const body = lines.slice(bodyStart).join("\n");
	const updated: string[] = [];
	for (const [k, v] of Object.entries(patch)) {
		if (k === "tags") {
			const cur: string[] = Array.isArray(data.tags)
				? data.tags.map(String)
				: data.tags != null
					? [String(data.tags)]
					: [];
			const incoming: string[] = Array.isArray(v) ? v.map(String) : [String(v)];
			const merged = [...new Set([...cur, ...incoming])];
			if (merged.length !== cur.length || merged.some((t, i) => t !== cur[i])) {
				data.tags = merged;
				updated.push("tags");
			}
		} else if (JSON.stringify(data[k]) !== JSON.stringify(v)) {
			data[k] = v;
			updated.push(k);
		}
	}
	const newFm = stringifyFrontmatter(data);
	const next = bodyStart === 0 ? newFm + "\n\n" + content : newFm + "\n" + body;
	await atomicWriteFile(abs, next);
	invalidateCache(abs);
	dropIndex(real);
	return {
		note: note.replace(/\.md$/i, "") + ".md",
		updated,
		bodyUntouched: true,
	};
}

/** Structured metadata query (B4.1/B4.2). Index-only, no body reads.
 *  - tags:    AND semantics (note must carry ALL listed tags)
 *  - anyTags: OR semantics (note carries ANY of these)
 *  - folder:  restrict to a sub-tree
 *  - createdAfter / createdBefore: filter by frontmatter `created` (YYYY-MM-DD)
 *  Returns note metadata (path, title, tags, created). */
export async function queryNotes(
	vaultPath: string,
	opts: {
		tags?: string[];
		anyTags?: string[];
		folder?: string;
		createdAfter?: string;
		createdBefore?: string;
		max?: number;
	} = {},
): Promise<
	{ path: string; title: string; tags: string[]; created?: string }[]
> {
	const idx = await getIndex(vaultPath);
	let candidates = [...idx.notes.values()];
	const folder = opts.folder?.replace(/^[/\\]+/, "");
	if (folder)
		candidates = candidates.filter(
			(m) => m.path.startsWith(folder + "/") || m.path.startsWith(folder),
		);
	if (opts.tags && opts.tags.length) {
		const want = opts.tags.map((t) => t.replace(/^#/, "").toLowerCase());
		candidates = candidates.filter((m) =>
			want.every((t) => m.tags.includes(t)),
		);
	}
	if (opts.anyTags && opts.anyTags.length) {
		const want = new Set(
			opts.anyTags.map((t) => t.replace(/^#/, "").toLowerCase()),
		);
		candidates = candidates.filter((m) => m.tags.some((t) => want.has(t)));
	}
	if (opts.createdAfter)
		candidates = candidates.filter(
			(m) => (m.created ?? "") >= opts.createdAfter!,
		);
	if (opts.createdBefore)
		candidates = candidates.filter(
			(m) => (m.created ?? "") <= opts.createdBefore!,
		);
	const max = opts.max ?? 200;
	return candidates.slice(0, max).map((m) => ({
		path: m.path,
		title: m.title,
		tags: m.tags,
		created: m.created,
	}));
}

/** Detect Zettel titles that deviate from the dominant separator style (C3.4).
 *  Classifies each title by its top-level separator: 'em' (—), 'colon' (:),
 *  'dash' (-), or 'plain'. Returns titles whose style is not the vault's mode. */
export function detectTitleStyleOutliers(
	idx: VaultIndex,
): { path: string; title: string; style: string }[] {
	const styleOf = (title: string): string => {
		if (title.includes("\u2014")) return "em"; // —
		if (/^[^:]+:/.test(title)) return "colon";
		if (title.includes(" - ")) return "dash";
		return "plain";
	};
	const counts: Record<string, number> = {};
	const metas = [...idx.notes.values()];
	// Compute each title's style once and reuse it for the count, filter, and
	// map passes (styleOf runs regexes, so this avoids 3× work per outlier).
	const tagged = metas.map((m) => ({ m, s: styleOf(m.title) }));
	for (const { s } of tagged) counts[s] = (counts[s] ?? 0) + 1;
	let mode = "plain";
	let max = 0;
	for (const [s, c] of Object.entries(counts))
		if (c > max) {
			max = c;
			mode = s;
		}
	return tagged
		.filter((t) => t.s !== mode)
		.map((t) => ({ path: t.m.path, title: t.m.title, style: t.s }));
}

/** Find notes that wiki-link to `target` (a note title/path). Returns matches
 *  like searchVault: {file, line, text}. `target` may include `.md`; it is
 *  normalized away. Matching is case-insensitive unless `caseSensitive`.
 *
 *  Obsidian allows both bare `[[name]]` and path-qualified `[[folder/name]]`
 *  wikilinks to refer to the same note. This function matches a link when:
 *  - the full link path equals `target` (exact), OR
 *  - the basename of the link equals the basename of `target`
 *  so that searching for backlinks to "z001" also finds `[[Zettelkasten/z001]]`. */
export async function findBacklinks(
	vaultPath: string,
	target: string,
	opts: { folder?: string; caseSensitive?: boolean; max: number },
): Promise<{ file: string; line: number; text: string }[]> {
	const want = target.replace(/\.md$/i, "").trim();
	const cmp = (s: string) => (opts.caseSensitive ? s : s.toLowerCase());
	const wantN = cmp(want);
	// Pre-compute basename of target for path-qualified link matching.
	const wantBase = cmp(want.split("/").pop() ?? want);
	const results: { file: string; line: number; text: string }[] = [];
	const max = opts.max;

	// Phase 3 / WS-C1: narrow to the O(1) candidate set from reverseAdjacency
	// instead of line-scanning the whole vault. The index is coherence-refreshed
	// by getIndex, so its candidate set is reliable mid-session. Fall back to a
	// full scan only when the index is not yet built (empty) — the legacy path.
	let files: string[];
	let idx: VaultIndex | undefined;
	try {
		idx = await getIndex(vaultPath);
	} catch {
		idx = undefined;
	}
	const candidates = idx ? backlinkPaths(idx, target) : new Set<string>();
	if (idx && idx.notes.size > 0) {
		// Filter candidates by folder scope (reverseAdjacency is vault-wide).
		const folder = opts.folder ?? "";
		files = [...candidates].filter((p) => !folder || p.startsWith(folder + "/") || p === folder);
		// No candidates means no backlinks per a coherent index — return early.
		if (files.length === 0) return [];
	} else {
		files = await listNotes(vaultPath, opts.folder ?? "");
	}

	const entries = await readBatched(files.map((f) => join(vaultPath, f)));
	for (let fi = 0; fi < files.length; fi++) {
		const f = files[fi];
		if (!f) continue;
		const entry = entries[fi];
		if (!entry) continue;
		const lines = entry.lines;
		for (let i = 0; i < lines.length; i++) {
			const li = lines[i]!;
			for (const link of extractWikiLinks(li)) {
				const linkStripped = link.replace(/\.md$/i, "");
				const linkN = cmp(linkStripped);
				const linkBase = cmp(linkStripped.split("/").pop() ?? linkStripped);
				if (linkN === wantN || linkBase === wantBase) {
					results.push({ file: f, line: i + 1, text: li.trim() });
					if (results.length >= max) return results;
					break; // one match per line is enough
				}
			}
		}
	}
	return results;
}

/** Find notes carrying tag `tag` (without leading #). Matches frontmatter
 *  `tags:` arrays and inline `#tag` tokens. Returns {file, line, text}. */
export async function findTagNotes(
	vaultPath: string,
	tag: string,
	opts: { folder?: string; caseSensitive?: boolean; max: number },
): Promise<{ file: string; line: number; text: string }[]> {
	const want = tag.replace(/^#/, "").trim();
	const cmp = (s: string) => (opts.caseSensitive ? s : s.toLowerCase());
	const wantN = cmp(want);
	const inlineRe = /(^|\s)#([A-Za-z0-9_-]+)/g;
	const results: { file: string; line: number; text: string }[] = [];
	const files = await listNotes(vaultPath, opts.folder ?? "");
	const max = opts.max;
	const entries = await readBatched(files.map((f) => join(vaultPath, f)));
	for (let fi = 0; fi < files.length; fi++) {
		const f = files[fi];
		if (!f) continue;
		const entry = entries[fi];
		if (!entry) continue;
		const lines = entry.lines;
		// C1.2: parseFrontmatter recognizes flow + block-YAML tag forms.
		const { data: fm } = parseFrontmatter(entry.content);
		const fmTags: string[] = Array.isArray(fm.tags)
			? fm.tags.map(String)
			: fm.tags != null
				? [String(fm.tags)]
				: [];
		let inFm = false,
			fmDone = false,
			fmTagsLine = -1;
		for (let i = 0; i < lines.length; i++) {
			const l = lines[i]!;
			if (!fmDone && i === 0 && l.trim() === "---") {
				inFm = true;
				continue;
			}
			if (inFm && l.trim() === "---") {
				inFm = false;
				fmDone = true;
				continue;
			}
			if (inFm && /^\s*tags?\s*:/.test(l) && fmTagsLine === -1) fmTagsLine = i;
		}
		let fmHit = false;
		for (const t of fmTags)
			if (cmp(t) === wantN) {
				fmHit = true;
				break;
			}
		if (fmHit && fmTagsLine >= 0) {
			results.push({
				file: f,
				line: fmTagsLine + 1,
				text: lines[fmTagsLine]!.trim(),
			});
			if (results.length >= max) return results;
		}
		for (let i = 0; i < lines.length; i++) {
			const l = lines[i]!;
			let mm: RegExpExecArray | null;
			inlineRe.lastIndex = 0;
			while ((mm = inlineRe.exec(l))) {
				if (cmp(mm[2]!) === wantN) {
					results.push({ file: f, line: i + 1, text: l.trim() });
					if (results.length >= max) return results;
					break;
				}
			}
		}
	}
	return results;
}

/**
 * Append text under a heading in a note. If the heading does not exist, it is
 * appended at the end as a new `## <heading>` section. Existing notes are
 * preserved; new notes are created with just the section.
 *
 * Heading levels are matched loosely: `## Foo`, `# Foo`, `### Foo` all match
 * the query "Foo". Indentation of inserted lines follows the provided content.
 */
export async function appendUnderHeading(
	vaultPath: string,
	note: string,
	heading: string,
	content: string,
	opts: { expectedMtime?: number } = {},
): Promise<{ created: boolean; insertedAt: "heading" | "end" }> {
	const abs = safeNotePath(vaultPath, note);
	assertWritablePath(vaultPath, abs);
	await assertWithinVault(vaultPath, abs);
	await mkdir(join(abs, ".."), { recursive: true });

	let existing = "";
	let created = false;
	let actualMtime: number | undefined;
	try {
		existing = await readFile(abs, "utf8");
		actualMtime = await noteMtime(abs);
	} catch (e) {
		// ENOENT → create-new (append-section's contract). Other FS errors throw a
		// structured VaultError for the calling tool to surface (WS-A1).
		if (fsErrCode(e) === "ENOENT") created = true;
		else
			throw new VaultError(
				classifyFsError(e),
				`Cannot read ${note}: ${errMsg(e)}`,
			);
	}
	// WS-A4: optimistic concurrency (only constrains the existing-file case).
	const conflict = mtimeConflict(note, opts.expectedMtime, actualMtime);
	if (conflict) throw conflict;

	const lines = existing.split("\n");
	// Heading match tolerates a leading '#' on EITHER side: a tag-MOC section
	// is conventionally headed `## #tag`, but callers (distill/garden subagents)
	// pass the heading sometimes as `#tag` and sometimes as `tag`. Without
	// normalization, the `tag` form fails to match an existing `## #tag` line
	// (regex `^#{1,6}\s+tag$` vs literal `#tag`), `findIndex` returns -1, and a
	// DUPLICATE section is created at end-of-file — the exact failure behind the
	// duplicated `## #architecture-pattern` / `## #obsidian` MOC sections. Strip
	// one leading '#' from the arg, then make the line's tag-'#' optional (`#?`).
	// `## foo` and `## #foo` are the same tag section; merging them is correct.
	const headingNorm = heading.replace(/^#/, "");
	const headingEsc = headingNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const headingRe = new RegExp(`^#{1,6}\\s+#?${headingEsc}\\s*$`, "i");
	const idx = lines.findIndex((l) => headingRe.test(l));

	const block = content.endsWith("\n") ? content : content + "\n";
	const ensureLeadingNewline = (s: string) =>
		s.startsWith("\n") ? s : "\n" + s;

	if (idx === -1) {
		// append a new section at the end
		const sep =
			existing && !existing.endsWith("\n")
				? "\n\n"
				: existing.endsWith("\n")
					? "\n"
					: "";
		const next = existing + sep + `## ${heading}` + ensureLeadingNewline(block);
		await atomicWriteFile(abs, next);
		invalidateCache(abs);
		return { created, insertedAt: "end" };
	}

	// find end of the matched section: next heading of same-or-higher level, or EOF
	const levelMatch = lines[idx]!.match(/^(#{1,6})/);
	const level = levelMatch ? levelMatch[1]!.length : 2;
	let endIdx = lines.length;
	for (let j = idx + 1; j < lines.length; j++) {
		const m = lines[j]!.match(/^(#{1,6})\s/);
		if (m && m[1]!.length <= level) {
			endIdx = j;
			break;
		}
	}

	// trim trailing empties of the section
	let insertAt = endIdx;
	while (insertAt - 1 > idx && lines[insertAt - 1]!.trim() === "") insertAt--;

	lines.splice(
		insertAt,
		0,
		...ensureLeadingNewline(block).slice(1).split("\n"),
	);
	await atomicWriteFile(abs, lines.join("\n"));
	invalidateCache(abs);
	return { created, insertedAt: "heading" };
}

// ---- Zettelkasten distillation subagent ----------------------------------

/** System prompt that turns the child `pi` process into a Zettelkasten distiller.
 *  Encodes the full methodology: atomic decomposition, the exact output template,
 *  whole-vault linking, MOC update, Traditional Chinese output. */
const ZETTEL_SYSTEM_PROMPT = `你是一名 Zettelkasten 蒸餾助手。你的任務：把給定的輸入文件分解成「一個原子化想法 = 一張卡」的 Zettelkasten 筆記，寫入專案本地的 Obsidian vault。

## 核心原則
1. **原子化**：每張卡只承載一個可獨立成立、能被單獨引用的論點。若一段內容含多個獨立主張，拆成多張卡。
2. **用自己的話寫**：核心想法必須改寫重述，不是逐字抄錄來源。
3. **互聯**：每張卡的「## 連結」段落至少一條 wiki-link。先用 obsidian_search 搜尋整個 vault 既存筆記，找出語義相關者，用 [[筆記標題]] 連結（取不含 .md 的檔名）。
4. **繁體中文輸出**：所有卡片內容以繁體中文撰寫（專有名詞、程式碼保留原文）。

## 處理流程（依序執行）
### ① 讀取與拆解
用 read 工具讀取指定的輸入檔。通讀後，列出所有可獨立成立的原子想法（不要重寫內容，只標邊界）。

### ② 逐張萃取
對每個原子想法，建立一張卡片，呼叫 obsidian_create 寫入 vault 的指定資料夾。

### ③ 連結
對每張新卡，呼叫 obsidian_search 搜尋整個 vault（不只 Zettelkasten/）找相關既存筆記，在「## 連結」段落填入 wiki-link。

### ④ 更新 MOC
每建好一張卡，用 obsidian_append_section 把它的 wiki-link 加進 Tags/Index.md 對應的 tag 段落（若該 tag 段落不存在，先加段落標題）。

## 嚴格輸出格式（每張卡都必須完全符合此範本）
檔名：vault 的 <輸出資料夾>/<標題>.md，標題簡潔、首字母大寫、不含斜線。
\`\`\`
---
id: <YYYYMMDDHHmm 時間戳，每張卡不同>
created: <YYYY-MM-DD>
tags: [zettel, <主題1>, <主題2>]
sources: ["<輸入檔檔名或來源>"]
---

# <這張卡的原子化標題：一個論點>

## 核心想法
- <用你自己的話，2-4 句陳述這張卡的主張>

## 證據 / 脈絡
- <來源文件的支撐細節、範例、引用，可多條>

## 連結
- 相關：[[<既存筆記A>]]
- 延伸：[[<既存筆記B>]]
- 上層概念：[[Tags/Index#<主題tag>]]
\`\`\`

## 輸入大小指引（重要）
- 一張卡的蒸餾約略對應來源 1–3 段文字。若輸入檔很大（粗估超過 ~12KB，或明顯多於十幾個段落），**不要一次通讀後草草萃取**——會漏掉尾段。
- 改成分批處理：先完整萃取前半部的原子想法，逐張建立；再用 obsidian_read 重新定位到未處理的段落繼續。每張卡仍須獨立、互連。
- 你無法精確量位元組，請用「段落數 / 是否出現捲動」當粗略指引，寧可多建一張卡也不要丟失論點。

## 範例卡（gold standard — 輸出請對齊此結構）
以下是「原子化筆記與互連」一張理想卡的長相（frontmatter 完整、用自己的話、至少一條已解析的 wiki-link）：
\`\`\`
---
id: 202607010930
created: 2026-07-01
tags: [zettel, 知識管理, 筆記法]
sources: ["input.md"]
---

# 原子化筆記優先於主題資料夾

## 核心想法
- 筆記的價值來自單一論點能被獨立引用與重組，而非被歸進某個資料夾就固定不動；原子化讓連結成為主要結構，資料夾只是輔助。

## 證據 / 脈絡
- 來源指出：把多個主張塞進同一張筆記，會讓它既難被引用也難被連結。
- 互連的密度比分類的整齊更能反映思考網絡。

## 連結
- 相關：[[Zettelkasten 方法概論]]
- 延伸：[[雙向連結與圖譜密度]]
- 上層概念：[[Tags/Index#知識管理]]
\`\`\`

## 規則
- tags[0] 永遠是 zettel。
- 每張卡 id 不可重複（用當下時間，逐張遞增分鐘）。
- 不重複建立內容相同的卡（若與既存卡語義高度重疊，仍建新卡但務必互連）。
- 只用提供的工具，不要使用 bash 或寫 vault 以外的路徑。

## 完成後（重要）
先以繁體中文回報：共建了幾張卡、逐張列出檔名與一句話摘要、指出建立的主要連結。簡潔即可。

**最後一行必須是一條結構化 JSON**（供父代理解析），格式如下，獨占一行，不要用 markdown 包裹：

    {"type":"pi_obsidian_result","notesCreated":<數字>,"notesUpdated":<數字>,"linksAdded":<數字>,"notes":["相對 vault 的檔名"],"errors":["若有的話"]}

若無法填的字段填 0 或空陣列。這條 JSON 是給程式讀的，不是給人讀的。`;

/** Resolve the `pi` launcher + args for a child process (mirrors official subagent helper). */
function getPiInvocation(extra: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtual && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...extra] };
	}
	const execName = (process.execPath.split(sep).pop() ?? "").toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName))
		return { command: process.execPath, args: extra };
	return { command: "pi", args: extra };
}

/**
 * Optional overrides for a spawned subagent. Without these the child uses the
 * pi default model and the caller-curated tool set; passing them lets an
 * extension tool control its subagent the same way the CLI does via
 * --model / --exclude-tools.
 */
export interface SubagentOptions {
	/** Model id, `provider/id`, or `provider/id:thinking` → child `--model`. */
	model?: string;
	/** Tool names to deny the child → child `--exclude-tools` (joined CSV). */
	excludeTools?: string[];
	/** Live-event observer: invoked for every parsed NDJSON event the child
	 *  emits (tool_execution_start/end, message_update, message_end, …). Use to
	 *  surface progress (see makeSubagentProgressLogger). Default: no-op. */
	onEvent?: (event: any) => void;
}

/** Build a live progress logger for a subagent run. Prints compact lines to
 *  stderr so long-running distill/garden runs are observable: confirms the
 *  subagent started, reports each note created, and exposes final tallies.
 *  Returns `{ onEvent, stats }` — pass `onEvent` as SubagentOptions.onEvent
 *  and read `stats()` after the run for a summary line. */
export function makeSubagentProgressLogger(label: string): {
	onEvent: (event: any) => void;
	stats: () => { created: number; failed: number; toolCalls: number };
} {
	let started = false;
	let created = 0;
	let failed = 0;
	let toolCalls = 0;
	const onEvent = (event: any) => {
		if (!event || typeof event.type !== "string") return;
		if (!started) {
			started = true;
			console.error(`  [${label}] subagent started`);
		}
		if (event.type === "tool_execution_start") {
			toolCalls++;
		} else if (
			event.type === "tool_execution_end" &&
			event.toolName === "obsidian_create"
		) {
			if (event.isError) {
				failed++;
				console.error(`  [${label}] ✗ note create failed`);
			} else {
				created++;
				console.error(`  [${label}] +note #${created}`);
			}
		}
	};
	return { onEvent, stats: () => ({ created, failed, toolCalls }) };
}

/**
 * Build the pi-compatible argv for a subagent child process. Pure function —
 * extracted from runSubagent so the flag wiring is unit-testable without
 * spawning a process. The caller appends the task (positional) as the last arg.
 */
export function buildSubagentArgs(
	toolsCsv: string,
	promptPath: string,
	pkgRoot: string,
	opts: SubagentOptions = {},
): string[] {
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--approve",
		"-e",
		pkgRoot,
		"--tools",
		toolsCsv,
		"--append-system-prompt",
		promptPath,
	];
	if (opts.model) args.push("--model", opts.model);
	if (opts.excludeTools && opts.excludeTools.length > 0) {
		args.push("--exclude-tools", opts.excludeTools.join(","));
	}
	return args;
}

// ---- Subagent model resolution (Phase 2 / WS-B2) --------------------------
// A subagent's model was previously inherited blindly from OB_PARENT_MODEL.
// A weak/TC-unaware parent model silently degrades distill/garden output. We
// now: honor an explicit per-call model; fall back to a configured floor
// (OB_SUBAGENT_MODEL); refuse to INHERIT a known-weak parent model; and warn
// when no model is configured at all. The floor for TC-aware distill/garden is
// a config decision (open question #2 in the PRD) — OB_SUBAGENT_MODEL is the
// mechanism; weak-detection is pattern-based so it doesn't hardcode an id.

/** Substring patterns that mark a model as "weak" (small/fast tiers that are a
 *  poor floor for the TC-heavy distill/garden prompts). Used only to REFUSE
 *  inheritance and to WARN on explicit selection — never to silently clear an
 *  explicit caller choice. */
const WEAK_MODEL_PATTERNS = [
	/haiku/i,
	/mini/i,
	/nano/i,
	/\bsmall\b/i,
	/-lite\b/i,
	/flash/i,
	/tiny/i,
	/nano[-_]?code/i,
];

/** Is this model id a known-weak tier? (substring match on the id.) */
export function isWeakModel(modelId: string | undefined): boolean {
	if (!modelId) return false;
	return WEAK_MODEL_PATTERNS.some((re) => re.test(modelId));
}

export interface ResolvedModel {
	model: string | undefined;
	/** Where the resolution came from — surfaced for logging/diagnostics. */
	source: "explicit" | "floor" | "inherited" | "default";
	warned: boolean;
}

/** Resolve the subagent model per WS-B2. Pure function — unit-tested without
 *  spawning. Resolution order:
 *    1. opts.model            (explicit — caller's choice; warn if weak)
 *    2. OB_SUBAGENT_MODEL     (configured floor — trusted, no weakness check)
 *    3. OB_PARENT_MODEL       (inherited — REFUSED if weak)
 *    4. undefined             (pi default — warn that no model is configured) */
export function resolveSubagentModel(opts: SubagentOptions = {}): ResolvedModel {
	const warn = (m: string) => console.error(`  [subagent] ⚠ ${m}`);
	// 1. Explicit per-call model: honor it, but warn on a known-weak choice.
	if (opts.model) {
		if (isWeakModel(opts.model))
			warn(`explicit model "${opts.model}" looks like a weak tier for TC distill/garden`);
		return { model: opts.model, source: "explicit", warned: isWeakModel(opts.model) };
	}
	// 2. Configured floor (OB_SUBAGENT_MODEL) — trusted; not weakness-checked.
	const floor = process.env.OB_SUBAGENT_MODEL;
	if (floor) return { model: floor, source: "floor", warned: false };
	// 3. Inherited parent model — refuse if known-weak so a parent `--model`
	//    selection can't silently degrade every spawned subagent.
	const parent = process.env.OB_PARENT_MODEL;
	if (parent) {
		if (isWeakModel(parent)) {
			warn(`refusing to inherit weak parent model "${parent}"; falling back to pi default`);
			return { model: undefined, source: "default", warned: true };
		}
		return { model: parent, source: "inherited", warned: false };
	}
	// 4. Nothing configured — let pi pick its default, but surface that no
	//    explicit/floor model is set so the operator can tune OB_SUBAGENT_MODEL.
	warn("no subagent model configured (set OB_SUBAGENT_MODEL for a stable TC-aware floor)");
	return { model: undefined, source: "default", warned: true };
}

/** Spawn a child pi (isolated context) as a specialized subagent.
 *  Loads this extension (-e) so obsidian tools are available in any cwd,
 *  restricts tools, appends the given system prompt, and runs the task.
 *  Returns the child's final assistant text + exit status. */

/** A3.4: extract a trailing structured-result JSON object from assistant text.
 *  Looks for the LAST line that parses to an object with type 'pi_obsidian_result'.
 *  Returns the parsed object, or null if none found. Exported for testing. */
export function parseStructuredResult(text: string): any {
	if (!text) return null;
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!;
		const trimmed = line.trim();
		if (!trimmed.startsWith("{") || !trimmed.includes("pi_obsidian_result"))
			continue;
		try {
			const obj = JSON.parse(trimmed);
			if (obj && obj.type === "pi_obsidian_result") return obj;
		} catch {
			/* not valid JSON, keep scanning */
		}
	}
	return null;
}

export function runSubagentWithRetry(
	cwd: string,
	systemPrompt: string,
	task: string,
	toolsCsv: string,
	signal: AbortSignal | undefined,
	tmpPrefix = "pi-subagent-",
	opts: SubagentOptions = {},
): Promise<{
	output: string;
	exitCode: number;
	stderr: string;
	timedOut: boolean;
	result: any;
	attempts: number;
}> {
	return runSubagentWithRetryImpl(
		cwd,
		systemPrompt,
		task,
		toolsCsv,
		signal,
		tmpPrefix,
		1,
		opts,
	);
}

/** Heuristic: does this stderr indicate a transient (retryable) failure? (A3.5) */
export function isTransientError(stderr: string, exitCode: number): boolean {
	if (exitCode === 0) return false;
	if (!stderr) return false;
	const s = stderr.toLowerCase();
	const signals = [
		"etimedout",
		"econnreset",
		"econnrefused",
		"enotfound",
		"socket hang up",
		"timeout",
		"rate limit",
		"429",
		"503",
		"502",
		"network",
		"fetch failed",
		"eai_again",
	];
	return signals.some((sig) => s.includes(sig));
}

async function runSubagentWithRetryImpl(
	cwd: string,
	systemPrompt: string,
	task: string,
	toolsCsv: string,
	signal: AbortSignal | undefined,
	tmpPrefix: string,
	attempt: number,
	opts: SubagentOptions = {},
): Promise<{
	output: string;
	exitCode: number;
	stderr: string;
	timedOut: boolean;
	result: any;
	attempts: number;
}> {
	const res = await runSubagent(
		cwd,
		systemPrompt,
		task,
		toolsCsv,
		signal,
		tmpPrefix,
		opts,
	);
	// Retry once on transient error AND no useful output.
	if (
		res.exitCode !== 0 &&
		!res.output &&
		!res.timedOut &&
		attempt === 1 &&
		isTransientError(res.stderr, res.exitCode)
	) {
		const retry = await runSubagent(
			cwd,
			systemPrompt,
			task,
			toolsCsv,
			signal,
			tmpPrefix,
			opts,
		);
		return { ...retry, attempts: 2 };
	}
	return { ...res, attempts: attempt };
}

export async function runSubagent(
	cwd: string,
	systemPrompt: string,
	task: string,
	toolsCsv: string,
	signal: AbortSignal | undefined,
	tmpPrefix = "pi-subagent-",
	opts: SubagentOptions = {},
): Promise<{
	output: string;
	exitCode: number;
	stderr: string;
	timedOut: boolean;
	result: any;
}> {
	// Phase 2 / WS-B2: resolve a validated model instead of blindly inheriting
	// OB_PARENT_MODEL. The resolution logs warnings itself (weak/explicit,
	// refused inheritance, unset) — so the parent surfaces a degrading choice.
	const resolved = resolveSubagentModel(opts);
	let tmpDir: string | null = null;
	let timer: NodeJS.Timeout | undefined;
	let timedOut = false;
	const timeoutMs = Number(process.env.OB_SUBAGENT_TIMEOUT_MS ?? 5 * 60_000);
	try {
		tmpDir = await mkdtemp(join(tmpdir(), tmpPrefix));
		const promptPath = join(tmpDir, "system.md");
		await writeFile(promptPath, systemPrompt, { mode: 0o600 });
		// Explicitly load this extension in the child so obsidian tools are
		// available regardless of whether the cwd has a .pi/settings.json.
		const pkgRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
		// Phase 2 / WS-B2: model comes from resolveSubagentModel (validated
		// floor/explicit; weak parent inheritance refused) rather than a raw
		// `opts.model ?? OB_PARENT_MODEL`.
		const inherited: SubagentOptions = { ...opts, model: resolved.model };
		// Argv is built by a pure helper (unit-tested); task is the last positional.
		const args = [...buildSubagentArgs(toolsCsv, promptPath, pkgRoot, inherited), task];
		const inv = getPiInvocation(args);
		const proc = spawn(inv.command, inv.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		// Await the child's completion as a single promise. With spawn, `error`
		// and `close` are mutually exclusive (an `error` means no process ever
		// ran, so no `close` follows) → this resolves exactly once. Phase 2 / B5:
		// this replaces the old `new Promise(async …)` antipattern whose `finish()`
		// helper could double-fire from both handlers.
		const completion = new Promise<{ exitCode: number; stderr: string; text: string }>(
			(resolveDone, rejectDone) => {
				let buf = "";
				let stderr = "";
				let lastText = "";
				const handle = (line: string) => {
					if (!line.trim()) return;
					let ev: any;
					try {
						ev = JSON.parse(line);
					} catch {
						return;
					}
					// Forward every parsed event to the live observer (progress logging).
					opts.onEvent?.(ev);
					if (ev.type === "message_end" && ev.message?.role === "assistant") {
						for (const part of ev.message.content ?? [])
							if (part.type === "text" && part.text) lastText = part.text;
					}
				};
				proc.stdout.on("data", (d) => {
					buf += d.toString();
					const lines = buf.split("\n");
					buf = lines.pop() ?? "";
					for (const l of lines) handle(l);
				});
				proc.stderr.on("data", (d) => {
					stderr += d.toString();
				});
				proc.on("close", (c) => {
					if (buf.trim()) handle(buf);
					resolveDone({ exitCode: c ?? 0, stderr, text: lastText });
				});
				proc.on("error", (e) => rejectDone(e));
			},
		);

		// AbortSignal: SIGTERM → 5s grace → SIGKILL.
		if (signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
		// A3.1: default 5min timeout (OB_SUBAGENT_TIMEOUT_MS). SIGTERM → 5s grace → SIGKILL.
		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			}, timeoutMs);
		}

		let outcome: { exitCode: number; stderr: string; text: string };
		try {
			outcome = await completion;
		} catch (e: any) {
			// spawn error (e.g. ENOENT — `pi` not on PATH). Single return path —
			// surface as exit 1 instead of leaking an unhandled rejection.
			const msg = e?.message ? String(e.message) : String(e);
			return {
				output: "",
				exitCode: 1,
				stderr: msg,
				timedOut,
				result: null,
			};
		}
		const result = parseStructuredResult(outcome.text);
		return {
			output: outcome.text,
			exitCode: outcome.exitCode,
			stderr: outcome.stderr,
			timedOut,
			result,
		};
	} finally {
		if (timer) clearTimeout(timer);
		if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
}

// ---- Vault gardener subagent ---------------------------------------------

/** System prompt for the vault gardener: audits & repairs knowledge-base health. */
const GARDEN_SYSTEM_PROMPT = `你是一名 Obsidian vault 圖丁（gardener），負責維護知識庫的健康度。你會掃描整個 vault，找出品質問題，依模式決定只回報或實際修復。

## 健康度檢查項（逐一執行）
用 obsidian_list 列出所有筆記，用 obsidian_read 讀內容，用 obsidian_search 驗證連結，檢查：

每個發現都標註嚴重等級，回報與 JSON 都要帶：🔴 critical（結構損壞，必須處理）、🟡 warning（明確的健康問題）、🟢 info（改善機會，非錯誤）。

1. 🔴 **破損 wiki-link**：[[Target]] 指向不存在的筆記。
2. 🔴 **缺漏 / 損壞 frontmatter**：Zettelkasten/ 下的筆記應有 id / created / tags / sources 欄位；缺任一者、或 YAML 無法解析即回報。
3. 🟡 **孤兒卡（Orphan）**：沒有任何其他筆記用 wiki-link 指向它的筆記（Zettelkasten 筆記尤其不能孤兒）。對每張可疑卡，用 obsidian_search 搜尋它的標題確認是否真無入連結。
4. 🟡 **疑似重複**：兩張以上筆記談論幾乎相同的論點。
5. 🟡 **MOC 漂移**：Tags/Index.md 缺少某些既存 tag 的段落，或某 tag 段落漏列了帶該 tag 的筆記。
6. 🟢 **漏連的相關筆記**：兩張筆記語義高度相關卻未互相 wiki-link——這是提升圖譜密度的高價值機會。

### 疑似重複的結構化前置篩選（避免對所有筆記兩兩比對）
不要直接對整個 vault 做語義兩兩比較（O(n²)、昂貴且不可重現）。先縮小候選集，只對候選集做語義判斷：
- 用 obsidian_search / 索引找出 **共享 ≥2 個 tag** 的筆記群。
- 在同一群內，再挑**標題詞彙重疊**者（用 obsidian_search 以標題中的關鍵詞查詢）。
- 只對這個候選短名單做語義判斷（是否談論幾乎相同的論點）。語義判斷要看主張內容，不是只看檔名或 tag 相同。

## 模式
- **audit（預設）**：只做檢查，不改動任何檔案。輸出一份結構化健康報告。
- **fix**：做完檢查後，對「安全且明確」的項目執行修復。**不確定就不改**。修復限於：
  - 為孤兒卡補上語義相關的 wiki-link（用 obsidian_append_section 加到「## 連結」段落）。
  - 為漏連的相關筆記對補雙向連結。
  - 把缺漏的筆記補進 Tags/Index.md 對應 tag 段落（obsidian_append_section）。
  - **不要**刪除或合併筆記，不要修改 frontmatter 的 id。疑似重複只回報，不自動合併。

## 輸出格式（繁體中文）
### 健康報告
為每個檢查項給一段：項目名、發現數量、逐條列出（每條標註嚴重等級 🔴/🟡/🟢 + 檔名 + 一句話問題描述）。
最後給「## 總結」：整體健康評分（1-5 ★）、最嚴重的 3 個問題、建議優先處理順序。

若為 fix 模式，在報告前加「### 已執行修復」段落，逐條列實際改了什麼（哪個檔案、加了什麼連結／更新了哪段）。

## 規則
- 只用提供的工具。fix 模式下只能用 obsidian_append_section / obsidian_create，不可刪檔。
- 所有路徑相對於 vault 根。
- 簡潔但完整。

## 完成後（重要）
報告完成後，**最後一行必須是一條結構化 JSON**（供父代理解析），格式如下，獨占一行，不要用 markdown 包裹：

    {"type":"pi_obsidian_result","notesCreated":<數字>,"linksAdded":<數字>,"notesModified":["fix 模式實際改動過的筆記檔名"],"issuesFound":<數字>,"issues":[{"kind":"orphan|dead-link|duplicate|missing-frontmatter|moc-drift","path":"檔名","severity":"critical|warning|info","detail":"一句話"}],"errors":["若有的話"]}

這條 JSON 是給程式讀的。數字字段若不適用填 0；audit 模式 notesModified 為空陣列。`;

// ---- Subagent output validation (Phase 2 / WS-B1) -------------------------
// distill/garden subagents write to the vault via obsidian_create inside the
// child process; the parent only sees the assistant's final text + the
// trailing `pi_obsidian_result` JSON (which lists created note paths). We can't
// intercept writes that happen in the child, so B1 is a POST-RUN audit: read
// every note the subagent claims to have created and validate it (frontmatter
// schema, valid YAML, sane size, wiki-link targets resolve). Malformed output
// is then REPORTED (and surfaced in the tool result) instead of silently
// corrupting the vault — the caller can review/repair/delete the bad notes.

/** Sane upper bound for a single Zettelkasten card. A subagent emitting a
 *  >64KB blob is almost certainly garbage / a prompt-injection dump. */
export const ZETTEL_MAX_BYTES = 64 * 1024;
/** Required frontmatter keys for a Zettelkasten card (per ZETTEL_SYSTEM_PROMPT). */
export const ZETTEL_REQUIRED_KEYS = ["id", "created", "tags"];

export interface NoteValidation {
	path: string;
	ok: boolean;
	errors: string[];
}

/** Validate a single note's content against the Zettelkasten card schema.
 *  Pure (no I/O) — unit-tested directly. When `idx` is provided, wiki-link
 *  targets are also checked for resolvability (dead links flagged). */
export function validateZettelNote(
	content: string | undefined,
	idx?: VaultIndex,
): { ok: boolean; errors: string[] } {
	const errors: string[] = [];
	if (!content || !content.trim()) return { ok: false, errors: ["empty content"] };
	if (Buffer.byteLength(content, "utf8") > ZETTEL_MAX_BYTES)
		errors.push(`note exceeds ${ZETTEL_MAX_BYTES / 1024}KB (likely garbage)`);
	// Frontmatter presence: leading `---` ... `---`.
	const lines = content.split("\n");
	const hasFm = lines.length > 0 && lines[0]!.trim() === "---" && lines.slice(1).some((l) => l.trim() === "---");
	if (!hasFm) {
		errors.push("missing YAML frontmatter (no leading `---` block)");
	} else {
		const { data } = parseFrontmatter(content);
		for (const k of ZETTEL_REQUIRED_KEYS)
			if (!(k in data) || data[k] === "" || data[k] == null)
				errors.push(`frontmatter missing required key: ${k}`);
		if (Array.isArray(data.tags) && data.tags.length > 0) {
			if (String(data.tags[0]).toLowerCase() !== "zettel")
				errors.push(`tags[0] should be "zettel" (got ${JSON.stringify(data.tags[0])})`);
		} else if (data.tags !== undefined) {
			errors.push("frontmatter `tags` must be a non-empty array");
		}
	}
	// Wiki-link target resolvability (only when an index is available).
	if (idx) {
		const dead = new Set<string>();
		for (const line of lines)
			for (const link of extractWikiLinks(line)) {
				if (!resolveLink(idx, link)) dead.add(link);
			}
		if (dead.size > 0)
			errors.push(`${dead.size} unresolved wiki-link target(s): ${[...dead].slice(0, 5).map((l) => `[[${l}]]`).join(", ")}${dead.size > 5 ? " …" : ""}`);
	}
	return { ok: errors.length === 0, errors };
}

/** Audit every note path a subagent reported creating. Returns a per-note
 *  validation report plus an aggregate. Notes that don't exist on disk (the
 *  subagent lied or the write raced) are flagged, not crashed on. */
export async function validateZettelNotes(
	vaultPath: string,
	paths: string[],
): Promise<{ notes: NoteValidation[]; valid: number; invalid: number }> {
	if (!paths || paths.length === 0)
		return { notes: [], valid: 0, invalid: 0 };
	let idx: VaultIndex | undefined;
	try {
		idx = await getIndex(vaultPath);
	} catch {
		idx = undefined;
	}
	const notes: NoteValidation[] = [];
	for (const rel of paths) {
		const abs = safeNotePath(vaultPath, rel);
		const cached = await readCached(abs);
		if (!cached) {
			notes.push({ path: rel, ok: false, errors: ["note not found on disk (subagent reported it but it's missing)"] });
			continue;
		}
		const { ok, errors } = validateZettelNote(cached.content, idx);
		notes.push({ path: rel, ok, errors });
	}
	return {
		notes,
		valid: notes.filter((n) => n.ok).length,
		invalid: notes.filter((n) => !n.ok).length,
	};
}

// ---- Note integrity check (Phase 5 / WS-B4) -------------------------------
// Lighter than validateZettelNote: garden edits ARBITRARY notes (not only
// Zettel cards), so the strict tags[0]==="zettel" rule does NOT apply. This
// only checks the markdown is still structurally sound after a fix-mode run —
// frontmatter (if present) is balanced, the note is non-empty, and code fences
// are paired. Pure (no I/O); unit-tested directly.

export interface IntegrityIssue {
	path: string;
	ok: boolean;
	errors: string[];
}

/** Validate a note's structural integrity. Pure (no I/O). */
export function validateNoteIntegrity(
	content: string | undefined,
): { ok: boolean; errors: string[] } {
	const errors: string[] = [];
	if (!content || !content.trim())
		return { ok: false, errors: ["empty content"] };
	const lines = content.split("\n");
	// Frontmatter: a leading `---` MUST be closed by a second `---`. An
	// unbalanced opener means the body got accidentally merged into YAML.
	if (lines[0]!.trim() === "---") {
		const closed = lines.slice(1).some((l) => l.trim() === "---");
		if (!closed) errors.push("frontmatter opened with --- but never closed");
	}
	// Code-fence balance: an odd count of ``` / ~~~ openers means a fence was
	// opened but never closed (or vice-versa) — a common append_section accident.
	const fence3 = lines.filter((l) => /^```/.test(l.trim())).length;
	const fence4 = lines.filter((l) => /^~~~/.test(l.trim())).length;
	if (fence3 % 2 !== 0) errors.push(`unbalanced \`\`\` code fences (${fence3} opener(s))`);
	if (fence4 % 2 !== 0) errors.push(`unbalanced ~~~ code fences (${fence4} opener(s))`);
	return { ok: errors.length === 0, errors };
}

/** Audit every note path a fix-mode garden run reported modifying. Reads each
 *  from disk (via the cache) and runs validateNoteIntegrity. Best-effort:
 *  missing-on-disk notes are flagged, never thrown on. */
export async function validateNoteIntegrityBatch(
	vaultPath: string,
	paths: string[],
): Promise<{ notes: IntegrityIssue[]; intact: number; broken: number }> {
	const notes: IntegrityIssue[] = [];
	for (const rel of paths) {
		const abs = safeNotePath(vaultPath, rel);
		const cached = await readCached(abs);
		if (!cached) {
			notes.push({ path: rel, ok: false, errors: ["note not found on disk (reported as modified but missing)"] });
			continue;
		}
		const { ok, errors } = validateNoteIntegrity(cached.content);
		notes.push({ path: rel, ok, errors });
	}
	return {
		notes,
		intact: notes.filter((n) => n.ok).length,
		broken: notes.filter((n) => !n.ok).length,
	};
}

/**
 * Schedule the transient "obsidian vault active" banner: show once after a
 * short delay, then auto-dismiss. Both deferred ctx.ui calls are guarded — a
 * session switch (/resume, ctx.fork, ctx.switchSession) between schedule and
 * fire leaves ctx stale, and ctx.ui's assertActive() would otherwise throw an
 * uncaughtException that crashes pi. Extracted from the session_start handler
 * so the guard is unit-testable (see __tests__/banner-stale-ctx.test.mjs).
 */
export function scheduleVaultBanner(
	ctx: { ui: { setWidget(key: string, lines: string[] | undefined): void } },
	line: string,
): void {
	const SHOW_DELAY_MS = 10_000; // past the startup notify burst (zai-mcp)
	const DISPLAY_MS = 8_000; // visible window before auto-dismiss
	setTimeout(() => {
		try {
			ctx.ui.setWidget("obsidian-vault", [line]);
		} catch {
			/* ctx stale after session switch — banner is non-essential */
			return;
		}
		// Auto-dismiss after DISPLAY_MS. Guarded the same way: a session
		// switch between show and dismiss leaves ctx stale.
		setTimeout(() => {
			try {
				ctx.ui.setWidget("obsidian-vault", undefined);
			} catch {
				/* ctx stale after session switch */
			}
		}, DISPLAY_MS);
	}, SHOW_DELAY_MS);
}

export default function (pi: ExtensionAPI) {
	// Phase 5 / WS-C8: light ExtensionAPI contract guard. The ExtensionAPI type
	// is a type-only import (no runtime symbol), and pi-agent-cli vendors an
	// inline copy — so a stale host could pass a `pi` that lacks methods this
	// extension calls. Fail fast on a missing CORE method (registerTool); warn
	// (don't throw) on the secondary ones so a forward-compatible host isn't
	// blocked. See the "Vault Submodule Remount" zettel for the inline-bundle
	// source-of-truth note.
	assertExtensionApi(pi);

	// Cached ResolvedVault (per session). `source` lets every tool surface
	// where the active vault came from; `staleReason` carries Tier-1 warnings.
	let vault: ResolvedVault | undefined;

	const getVault = async (cwd: string): Promise<ResolvedVault> => {
		if (!vault) vault = await resolveVault(cwd);
		return vault;
	};

	const vname = (v: { name: string }) => encodeURIComponent(v.name);

	// ---- Tool: obsidian_list -------------------------------------------------
	pi.registerTool({
		name: "obsidian_list",
		label: "Obsidian List",
		promptSnippet: "List markdown notes in a vault folder (recursive)",
		description:
			"List markdown notes in an Obsidian vault folder (recursive). Returns paths relative to the vault root. Omit folder to list the whole vault.",
		parameters: Type.Object({
			folder: Type.Optional(
				Type.String({
					description: "Folder relative to vault root. Default: root.",
				}),
			),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			const notes = await listNotes(v.path, params.folder ?? "");
			return {
				content: [
					{
						type: "text",
						text: notes.length
							? `Vault "${v.name}", ${notes.length} note(s):\n${notes.join("\n")}`
							: `No notes under "${params.folder || "root"}" in "${v.name}".`,
					},
				],
				details: { vault: v.name, notes },
			};
		},
	});

	// ---- Tool: obsidian_read -------------------------------------------------
	pi.registerTool({
		name: "obsidian_read",
		label: "Obsidian Read",
		promptSnippet: "Read a note's contents",
		description: "Read a note's contents. Path with or without .md.",
		parameters: Type.Object({
			note: Type.String({
				description: "Note path relative to vault root (e.g. Inbox/idea).",
			}),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			const abs = safeNotePath(v.path, params.note);
			assertWritablePath(v.path, abs);
			await assertWithinVault(v.path, abs);
			let content: string;
			try {
				content = await readFile(abs, "utf8");
			} catch (e) {
				const code = classifyFsError(e);
				return toolError(
					code,
					code === "NOT_FOUND"
						? `Note not found: ${params.note}`
						: `Cannot read ${params.note}: ${errMsg(e)}`,
					{ vault: v.name, note: params.note, fsCode: fsErrCode(e) },
				);
			}
			return {
				content: [{ type: "text", text: content }],
				details: { vault: v.name, note: params.note, bytes: content.length },
			};
		},
	});

	// ---- Tool: obsidian_create ----------------------------------------------
	pi.registerTool({
		name: "obsidian_create",
		label: "Obsidian Create",
		promptSnippet: "Create/overwrite a note (refuses overwrite unless overwrite:true)",
		description:
			"Create or overwrite a note. Parent folders are created automatically. Obsidian picks up changes live. By default refuses to overwrite an existing note (set overwrite:true or pass expectedMtime to update an existing file).",
		parameters: Type.Object({
			note: Type.String({ description: "Note path relative to vault root." }),
			content: Type.String({ description: "Full markdown content." }),
			overwrite: Type.Optional(
				Type.Boolean({
					description:
						"Set true to replace an existing note. Default false (returns an error if the note exists).",
				}),
			),
			expectedMtime: Type.Optional(
				Type.Number({
					description:
						"Epoch-ms mtime of the note as last seen by the caller; if the on-disk mtime differs, the write is rejected as a conflict (optimistic concurrency).",
				}),
			),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			const abs = safeNotePath(v.path, params.note);
			assertWritablePath(v.path, abs);
			await assertWithinVault(v.path, abs);
			// existing-file check + conflict detection (A2.2 / A2.3)
			let existingMtime: number | undefined;
			try {
				const st = await stat(abs);
				existingMtime = st.mtimeMs;
			} catch (e) {
				// ENOENT = not present (expected). Anything else (EACCES/…) is real.
				if (fsErrCode(e) !== "ENOENT") {
					return toolError(
						classifyFsError(e),
						`Cannot stat ${params.note}: ${errMsg(e)}`,
						{ vault: v.name, note: params.note, fsCode: fsErrCode(e) },
					);
				}
			}
			if (existingMtime !== undefined) {
				if (
					params.expectedMtime !== undefined &&
					params.expectedMtime !== existingMtime
				) {
					return toolError(
						"CONFLICT",
						`Conflict: ${params.note} was modified (expected mtime ${params.expectedMtime}, actual ${existingMtime}).`,
						{
							vault: v.name,
							note: params.note,
							conflict: true,
							expectedMtime: params.expectedMtime,
							actualMtime: existingMtime,
						},
					);
				}
				if (!params.overwrite && params.expectedMtime === undefined) {
					return toolError(
						"ALREADY_EXISTS",
						`Note already exists: ${params.note} (mtime ${existingMtime}). Pass overwrite:true to replace, or expectedMtime for optimistic concurrency.`,
						{ vault: v.name, note: params.note, exists: true, mtime: existingMtime },
					);
				}
			}
			await mkdir(join(abs, ".."), { recursive: true });
			await atomicWriteFile(abs, params.content);
			invalidateCache(abs);
			return {
				content: [
					{
						type: "text",
						text: `Wrote ${params.note} (${params.content.length} bytes) in "${v.name}".`,
					},
				],
				details: {
					vault: v.name,
					note: params.note,
					bytes: params.content.length,
					overwritten: existingMtime !== undefined,
				},
			};
		},
	});

	// ---- Tool: obsidian_append ----------------------------------------------
	pi.registerTool({
		name: "obsidian_append",
		label: "Obsidian Append",
		promptSnippet: "Append text to a note (creates if missing)",
		description:
			"Append text to a note. Creates the note if missing. Adds a blank-line separator before appended text.",
		parameters: Type.Object({
			note: Type.String({ description: "Note path relative to vault root." }),
			content: Type.String({ description: "Text to append." }),
			expectedMtime: Type.Optional(
				Type.Number({
					description:
						"Optional epoch-ms mtime as last seen by the caller; if the note exists and the on-disk mtime differs, the append is rejected as a conflict (optimistic concurrency). Ignored when the note is created new.",
				}),
			),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			const abs = safeNotePath(v.path, params.note);
			assertWritablePath(v.path, abs);
			await assertWithinVault(v.path, abs);
			await mkdir(join(abs, ".."), { recursive: true });
			let existing = "";
			let actualMtime: number | undefined;
			try {
				existing = await readFile(abs, "utf8");
				actualMtime = await noteMtime(abs);
			} catch (e) {
				// ENOENT → create-new (append's contract). Other FS errors surface.
				if (fsErrCode(e) !== "ENOENT") {
					return toolError(
						classifyFsError(e),
						`Cannot read ${params.note}: ${errMsg(e)}`,
						{ vault: v.name, note: params.note, fsCode: fsErrCode(e) },
					);
				}
			}
			// WS-A4: optimistic concurrency (only constrains the existing-file case).
			const conflict = mtimeConflict(params.note, params.expectedMtime, actualMtime);
			if (conflict) {
				return toolError("CONFLICT", conflict.message, {
					vault: v.name,
					note: params.note,
					conflict: true,
					expectedMtime: params.expectedMtime,
					actualMtime: actualMtime,
				});
			}
			const sep =
				existing && !existing.endsWith("\n")
					? "\n\n"
					: existing.endsWith("\n\n") || !existing
						? ""
						: "\n";
			const next =
				existing +
				sep +
				params.content +
				(params.content.endsWith("\n") ? "" : "\n");
			await atomicWriteFile(abs, next);
			invalidateCache(abs);
			return {
				content: [
					{
						type: "text",
						text: `Appended ${params.content.length} bytes to ${params.note}.`,
					},
				],
				details: {
					vault: v.name,
					note: params.note,
					appended: params.content.length,
				},
			};
		},
	});

	// ---- Tool: obsidian_append_section --------------------------------------
	pi.registerTool({
		name: "obsidian_append_section",
		label: "Obsidian Append Section",
		promptSnippet: "Append text under a heading in a note",
		description:
			"Append text under a heading in a note. Matches any heading level (## Foo, # Foo, ### Foo). If the heading does not exist it is appended as a new section. Useful for logging under a ## Log section without disturbing other content.",
		parameters: Type.Object({
			note: Type.String({ description: "Note path relative to vault root." }),
			heading: Type.String({
				description: "Heading text to append under (without the # marks).",
			}),
			content: Type.String({
				description: "Text to insert into that section.",
			}),
			expectedMtime: Type.Optional(
				Type.Number({
					description:
						"Optional epoch-ms mtime as last seen by the caller; if the note exists and the on-disk mtime differs, the update is rejected as a conflict (optimistic concurrency). Ignored when the note is created new.",
				}),
			),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			let res;
			try {
				res = await appendUnderHeading(
					v.path,
					params.note,
					params.heading,
					params.content,
					{ expectedMtime: params.expectedMtime },
				);
			} catch (e) {
				return toolErrorFromCaught(e, {
					vault: v.name,
					note: params.note,
					heading: params.heading,
				});
			}
			return {
				content: [
					{
						type: "text",
						text: `${res.created ? "Created" : "Updated"} ${params.note}; inserted under ${
							res.insertedAt === "heading"
								? `"${params.heading}"`
								: `new "## ${params.heading}" at end`
						}.`,
					},
				],
				details: {
					vault: v.name,
					note: params.note,
					heading: params.heading,
					...res,
				},
			};
		},
	});

	// ---- Tool: obsidian_search ----------------------------------------------
	pi.registerTool({
		name: "obsidian_search",
		label: "Obsidian Search",
		promptSnippet: "Full-text search across notes (substring/regex/words/fuzzy) + backlinks",
		description:
			"Full-text search across notes; returns file:line snippets. matchMode: substring (default, literal) " +
			"| regex (JS RegExp) | words (tokens AND; `|`=OR group, `-token`=NOT) | fuzzy (typo-tolerant). " +
			"`fields` restricts searchable sections (title/tags/body/frontmatter; default all); `folder` a sub-tree. " +
			"`sort`: file (default) | relevance | recency. `context`/`groupByFile`/`perFile` shape output (see params). " +
			"Graph: `backlinks:true` treats query as a note title → notes linking to it; a `#`-prefixed query is a tag search.",
		parameters: Type.Object({
			query: Type.String({
				description:
					"Search string. Meaning depends on matchMode. Prefix with # for a tag search. See also backlinks.",
			}),
			matchMode: Type.Optional(
				Type.Union(
					[
						Type.Literal("substring"),
						Type.Literal("regex"),
						Type.Literal("words"),
						Type.Literal("fuzzy"),
					],
					{
						description:
							"substring (default) | regex | words | fuzzy. See tool description for semantics.",
						default: "substring",
					},
				),
			),
			caseSensitive: Type.Optional(
				Type.Boolean({
					description:
						"Default false. Also applies to backlink matching unless backlinks is used (link targets are matched case-insensitively by default).",
				}),
			),
			folder: Type.Optional(
				Type.String({
					description:
						"Restrict search to a folder relative to vault root. Default: whole vault.",
				}),
			),
			fields: Type.Optional(
				Type.Array(
					Type.Union(
						[
							Type.Literal("all"),
							Type.Literal("title"),
							Type.Literal("tags"),
							Type.Literal("body"),
							Type.Literal("frontmatter"),
						],
						{
							description:
								"Restrict to note sections. 'all' (default) searches everywhere. title = first H1; tags = frontmatter tags: line + inline #tag lines; frontmatter = --- block; body = the rest.",
						},
					),
				),
			),
			context: Type.Optional(
				Type.Number({
					description:
						"Lines of surrounding context per match (0 = single line, the default). When >0 the text field shows an indented snippet with the hit line marked `>`.",
				}),
			),
			sort: Type.Optional(
				Type.Union(
					[
						Type.Literal("file"),
						Type.Literal("relevance"),
						Type.Literal("recency"),
					],
					{
						description:
							"Result ordering. file (default, alphabetical traversal) | relevance (title +10 / tag +6 / frontmatter +3 / body +1, summed per file) | recency (frontmatter created date desc).",
						default: "file",
					},
				),
			),
			groupByFile: Type.Optional(
				Type.Boolean({
					description:
						"Collapse to at most `perFile` matches per file. Default false.",
				}),
			),
			perFile: Type.Optional(
				Type.Number({
					description:
						"When groupByFile, max matches to keep per file. Default 3.",
				}),
			),
			backlinks: Type.Optional(
				Type.Boolean({
					description:
						"Treat `query` as a note title and return notes that wiki-link to it ([[query]]). Normalizes away .md; case-insensitive unless caseSensitive. Overrides matchMode/fields. (Legacy alias for graph:'backlinks'.)",
				}),
			),
			graph: Type.Optional(
				Type.Union(
					[
						Type.Literal("backlinks"),
						Type.Literal("outgoing"),
						Type.Literal("orphans"),
						Type.Literal("dead-links"),
						Type.Literal("neighbors"),
					],
					{
						description:
							"Graph query mode. backlinks=who links to `query`; outgoing=what `query` links to; orphans=notes with no inbound links; dead-links=[[Target]] pointing to nonexistent notes; neighbors=N-hop neighborhood of `query`. Overrides matchMode/fields.",
					},
				),
			),
			depth: Type.Optional(
				Type.Number({
					description: "Max hops for graph:'neighbors'. Default 1.",
					default: 1,
				}),
			),
			max: Type.Optional(
				Type.Number({ description: "Max matches to return. Default 50." }),
			),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"B4.3: restrict matching to this set of vault-relative paths (e.g. from obsidian_query). Ignores `folder`.",
				}),
			),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			const max = params.max ?? 50;
			const folder = params.folder ?? "";
			const caseSensitive = params.caseSensitive ?? false;

			// --- Graph query modes (B2.5 unified surface) ---
			const graphMode =
				params.graph ?? (params.backlinks ? "backlinks" : undefined);
			if (graphMode) {
				const gidx = await getIndex(v.path);
				let results: GraphResult[] = [];
				let modeLabel: string = graphMode;
				if (graphMode === "backlinks") {
					// keep the line-aware findBacklinks for back-compat when possible
					const bl = await findBacklinks(v.path, params.query, {
						folder,
						caseSensitive,
						max,
					});
					results = bl.map((b) => ({
						path: b.file,
						line: b.line,
						text: b.text,
					}));
				} else if (graphMode === "outgoing") {
					results = graphOutgoing(gidx, params.query);
				} else if (graphMode === "orphans") {
					results = graphOrphans(gidx);
				} else if (graphMode === "dead-links") {
					results = graphDeadLinks(gidx);
				} else if (graphMode === "neighbors") {
					results = graphNeighbors(gidx, params.query, params.depth ?? 1, max);
					modeLabel = `neighbors(d=${params.depth ?? 1})`;
				}
				results = results.slice(0, max);
				return {
					content: [
						{
							type: "text",
							text: results.length
								? `${results.length} ${modeLabel} result(s):
` +
									results
										.map(
											(r) =>
												`${r.path}${r.line ? `:${r.line}` : ""}: ${r.text}${r.depth ? ` (depth ${r.depth})` : ""}`,
										)
										.join("\n")
								: `No ${modeLabel} results.`,
						},
					],
					details: {
						vault: v.name,
						query: params.query,
						mode: modeLabel,
						results,
					},
				};
			}

			// --- Legacy tag shortcut (#query) ---
			if (params.query.startsWith("#")) {
				const matches = await findTagNotes(v.path, params.query, {
					folder,
					caseSensitive,
					max,
				});
				return {
					content: [
						{
							type: "text",
							text: matches.length
								? `${matches.length} note(s) tagged ${params.query}:\n` +
									matches
										.map((m) => `${m.file}:${m.line}: ${m.text}`)
										.join("\n")
								: `No notes tagged ${params.query} in vault "${v.name}".`,
						},
					],
					details: { vault: v.name, query: params.query, mode: "tag", matches },
				};
			}

			const mode = (params.matchMode ?? "substring") as MatchMode;
			const built = buildMatcher(params.query, mode, caseSensitive);
			if (built.error || !built.match) {
				return {
					content: [
						{ type: "text", text: built.error ?? "Could not build matcher." },
					],
					details: { vault: v.name, query: params.query, matchMode: mode },
					isError: true,
				};
			}
			const sort = (params.sort ?? "file") as "file" | "relevance" | "recency";
			// Phase 6 / WS-C5: for substring queries, narrow the candidate set via
			// the trigram inverted index so searchVault reads only files that COULD
			// contain the query (skips reading+line-scanning the rest). Sound —
			// never drops a real hit — as long as the index covers every note;
			// refreshIndex reconciles just-written/external notes first (cheap
			// readdir+stat diff, far less than reading all file bodies). regex/
			// words/fuzzy don't benefit (their "match" isn't a literal substring),
			// and an explicit caller `paths` restriction always wins.
			let trigramPaths: string[] | undefined;
			if (mode === "substring" && !params.paths && process.env.OB_TRIGRAM_SEARCH !== "0") {
				try {
					const idx = await getIndex(v.path);
					await refreshIndex(idx, { force: false });
					const cand = trigramCandidates(idx, params.query);
					if (cand) trigramPaths = [...cand];
				} catch {
					// index unavailable — fall back to a full scan
				}
			}
			const searchOpts = {
				fileFilter: built.fileFilter,
				fields: (params.fields as NoteField[] | undefined) ?? null,
				folder,
				context: params.context ?? 0,
				sort,
				groupByFile: params.groupByFile ?? false,
				perFile: params.perFile ?? 3,
				max,
				paths: params.paths ?? trigramPaths,
			};
			let matches = await searchVault(v.path, {
				match: built.match,
				...searchOpts,
			});
			// Regex auto-repair: on a 0-match regex query containing an alternation `|`
			// (bare or escaped), retry the de-escaped form — weak models over-escape the
			// surrounding parens/pipe often (e.g. SEARCH\(WORD|TERM\)).
			let regexRepaired: string | undefined;
			if (
				mode === "regex" &&
				matches.length === 0 &&
				params.query.includes("|")
			) {
				const deescaped = deescapeRegex(params.query);
				if (deescaped !== params.query) {
					const rb = buildMatcher(deescaped, "regex", caseSensitive);
					if (rb.match && !rb.error) {
						const repaired = await searchVault(v.path, {
							match: rb.match,
							...searchOpts,
						});
						if (repaired.length > 0) {
							matches = repaired;
							regexRepaired = deescaped;
						}
					}
				}
			}
			const repairNote = regexRepaired
				? `(auto-repaired over-escaped regex: "${params.query}" -> "${regexRepaired}")\n`
				: "";
			return {
				content: [
					{
						type: "text",
						text: matches.length
							? `${repairNote}${matches.length} match(es) for "${params.query}":\n` +
								matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n")
							: `${repairNote}No matches for "${params.query}" in vault "${v.name}".`,
					},
				],
				details: {
					vault: v.name,
					query: params.query,
					matchMode: mode,
					sort,
					regexRepaired,
					matches,
				},
			};
		},
	});

	// ---- Tool: obsidian_semantic_search ------------------------------------
	// Meaning-based (vector) retrieval over the vault via an external vault-mind
	// (ChromaDB) service. Complements obsidian_search (lexical): it surfaces
	// cards whose wording differs from the query but is conceptually on-point.
	// Optional infrastructure: when VAULT_MIND_BASE_URL is unset or the service
	// is unreachable, it returns a structured error (isError) so the agent can
	// fall back to obsidian_search without a hard failure. See README §Semantic.
	pi.registerTool({
		name: "obsidian_semantic_search",
		label: "Obsidian Semantic Search",
		promptSnippet:
			"Meaning-based (vector) search across notes — finds cards lexical search misses",
		description:
			"Semantic (vector embedding) search over the vault via a vault-mind ChromaDB backend. " +
			"Retrieves cards by MEANING rather than keyword match — use when obsidian_search returns nothing " +
			"because the query is phrased differently from card titles/tags (e.g. 'gpu exploding on big images' " +
			"→ finds the OOM/MemoryError-guard cards). Returns ranked chunks with similarity scores + metadata. " +
			"Requires a running vault-mind service (VAULT_MIND_BASE_URL; default http://127.0.0.1:8000) with the " +
			"vault indexed there. Gracefully errors (isError) if unreachable — fall back to obsidian_search.",
		parameters: Type.Object({
			query: Type.String({
				description:
					"Natural-language query. Phrasing need not match card vocabulary — semantic similarity is what ranks results.",
			}),
			vault_name: Type.Optional(
				Type.String({
					description:
						"Indexed vault collection name. Default: the resolved vault's name.",
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description: "Max results (1-100). Default 10.",
					minimum: 1,
					maximum: 100,
				}),
			),
			similarity_threshold: Type.Optional(
				Type.Number({
					description:
						"Minimum cosine similarity (0-1). Default 0.3 — lowered from vault-mind's 0.4 to surface weak-but-relevant CJK/technical hits that a lightweight multilingual model ranks low.",
					minimum: 0,
					maximum: 1,
				}),
			),
			include_tags: Type.Optional(
				Type.Array(Type.String(), {
					description: "Only return chunks whose tags include all of these.",
				}),
			),
			exclude_tags: Type.Optional(
				Type.Array(Type.String(), {
					description: "Exclude chunks whose tags include any of these.",
				}),
			),
		}),
		async execute(_id, params, _s, _u, ctx) {
			// String-concat (not new URL(absPath, base)) so a base URL with a path
			// prefix (e.g. http://host:9999/vm/) keeps /vm/api/search rather than
			// having the prefix clobbered by the absolute "/api/search".
			const baseUrl = (
				process.env.VAULT_MIND_BASE_URL ?? "http://127.0.0.1:8000"
			).replace(/\/+$/, "");
			let vaultName = params.vault_name;
			if (!vaultName) {
				const v = await getVault(ctx.cwd);
				vaultName = v.name;
			}

			const u = new URL(baseUrl + "/api/search");
			u.searchParams.set("vault_name", vaultName);
			u.searchParams.set("query", params.query);
			u.searchParams.set("limit", String(params.limit ?? 10));
			u.searchParams.set(
				"similarity_threshold",
				String(params.similarity_threshold ?? 0.3),
			);
			if (params.include_tags?.length)
				u.searchParams.set("include_tags", params.include_tags.join(","));
			if (params.exclude_tags?.length)
				u.searchParams.set("exclude_tags", params.exclude_tags.join(","));

			let resp: Response;
			try {
				resp = await fetch(u.toString(), { method: "GET" });
			} catch (e) {
				return toolError(
					"IO_ERROR",
					`vault-mind unreachable at ${baseUrl}: ${errMsg(e)}. Set VAULT_MIND_BASE_URL or fall back to obsidian_search (lexical).`,
					{ vault: vaultName, query: params.query, baseUrl },
				);
			}
			if (!resp.ok) {
				return toolError(
					"IO_ERROR",
					`vault-mind /api/search returned HTTP ${resp.status} ${resp.statusText}.`,
					{ vault: vaultName, query: params.query, baseUrl },
				);
			}

			const json: any = await resp.json();
			const data = json?.data ?? {};
			const results: any[] = Array.isArray(data.results) ? data.results : [];

			const text = results.length
				? `${results.length} semantic result(s) for "${params.query}" (vault "${vaultName}", ${Math.round(
						data.search_time_ms ?? 0,
					)}ms):\n` +
					results
						.map((r, i) => {
							const m = r.metadata ?? {};
							const name =
								m.file_name ??
								(m.file_path ?? "").toString().split("/").pop() ??
								(r.id ?? "?");
							const score = Number(r.similarity_score ?? 0).toFixed(3);
							const snip = (r.content ?? "")
								.slice(0, 200)
								.replace(/\s+/g, " ")
								.trim();
							return `${i + 1}. [${score}] ${name}\n   » ${snip}`;
						})
						.join("\n")
				: `No semantic hits for "${params.query}" in vault "${vaultName}" (0 cards above threshold). Lower similarity_threshold, rephrase, or try obsidian_search.`;

			return {
				content: [{ type: "text", text }],
				details: {
					vault: vaultName,
					query: params.query,
					total_found: data.total_found ?? results.length,
					search_time_ms: data.search_time_ms,
					results: results.map((r) => ({
						score: r.similarity_score,
						file: r.metadata?.file_name ?? r.metadata?.file_path,
						id: r.id,
						tags: r.metadata?.searchable_tags,
						snippet: (r.content ?? "").slice(0, 280),
					})),
				},
			};
		},
	});

	// ---- Tool: obsidian_move (B3.1/B3.2) -----------------------------------
	pi.registerTool({
		name: "obsidian_move",
		label: "Obsidian Move",
		promptSnippet: "Move/rename a note and rewrite inbound wiki-links",
		description:
			"Move/rename a note and rewrite all inbound [[wiki-links]] across the vault to point at the new location. Preserves aliases and #section refs. Atomic (temp+rename).",
		parameters: Type.Object({
			from: Type.String({ description: "Source note path (vault-relative)." }),
			to: Type.String({
				description: "Destination note path (vault-relative).",
			}),
			overwrite: Type.Optional(
				Type.Boolean({
					description: "Allow moving onto an existing note. Default false.",
				}),
			),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			try {
				const r = await moveNote(v.path, params.from, params.to, {
					overwrite: params.overwrite,
				});
				// A7: never silent partial state — if some inbound-link rewrites
				// failed, name them in the text (not just details) so the agent
				// knows the graph is half-rewritten and can retry those sources.
				const failedWarn =
					r.failedSources.length > 0
						? ` ⚠ ${r.failedSources.length} inbound rewrite(s) FAILED (${r.failedSources.join(", ")}) — those links still point at the old path; re-run or fix manually.`
						: "";
				return {
					content: [
						{
							type: "text",
							text: `Moved ${r.from} → ${r.to}; rewrote ${r.linksRewritten.length} inbound link(s).${failedWarn}`,
						},
					],
					details: r,
				};
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `Move failed: ${errMsg(e)}` }],
					isError: true,
					details: { from: params.from, to: params.to },
				};
			}
		},
	});

	// ---- Tool: obsidian_rename (B3.3, alias of move, same dir) --------------
	pi.registerTool({
		name: "obsidian_rename",
		label: "Obsidian Rename",
		promptSnippet: "Rename a note in place (same dir) and rewrite inbound links",
		description:
			"Rename a note in place (same directory) and rewrite inbound [[wiki-links]]. Thin alias of obsidian_move constrained to the basename.",
		parameters: Type.Object({
			note: Type.String({ description: "Source note path (vault-relative)." }),
			newName: Type.String({ description: "New basename (without folder)." }),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			const dir = params.note
				.replace(/^[/\\]+/, "")
				.split("/")
				.slice(0, -1)
				.join("/");
			const to = dir ? `${dir}/${params.newName}` : params.newName;
			try {
				const r = await moveNote(v.path, params.note, to);
				return {
					content: [{ type: "text", text: `Renamed ${r.from} → ${r.to}.` }],
					details: r,
				};
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `Rename failed: ${errMsg(e)}` }],
					isError: true,
					details: null,
				};
			}
		},
	});

	// ---- Tool: obsidian_query (B4) ----------------------------------------
	pi.registerTool({
		name: "obsidian_query",
		label: "Obsidian Query",
		promptSnippet: "Index-only metadata query (tags/folder/date) without reading bodies",
		description:
			"Structured metadata query (Dataview-lite). Returns note paths/titles/tags/created WITHOUT reading bodies — index-only, cheap. Use to find notes by tag/folder/date, then pipe paths into obsidian_search via its `paths` param.",
		parameters: Type.Object({
			tags: Type.Optional(
				Type.Array(Type.String(), {
					description: "AND semantics: notes carrying ALL these tags.",
				}),
			),
			anyTags: Type.Optional(
				Type.Array(Type.String(), {
					description: "OR semantics: notes carrying ANY of these tags.",
				}),
			),
			folder: Type.Optional(
				Type.String({ description: "Restrict to a sub-tree." }),
			),
			createdAfter: Type.Optional(
				Type.String({ description: "YYYY-MM-DD; notes with created >= this." }),
			),
			createdBefore: Type.Optional(
				Type.String({ description: "YYYY-MM-DD; notes with created <= this." }),
			),
			max: Type.Optional(Type.Number({ description: "Cap. Default 200." })),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			const rows = await queryNotes(v.path, params);
			return {
				content: [
					{
						type: "text",
						text:
							`${rows.length} note(s):\n` +
							rows
								.map((r) =>
									`- ${r.path} ${r.tags.length ? `#${r.tags.join(" #")}` : ""} ${r.created ?? ""}`.trimEnd(),
								)
								.join("\n"),
					},
				],
				details: { vault: v.name, count: rows.length, rows },
			};
		},
	});

	// ---- Tool: obsidian_update_frontmatter (B3.5) --------------------------
	pi.registerTool({
		name: "obsidian_update_frontmatter",
		label: "Obsidian Update Frontmatter",
		promptSnippet: "Merge keys into a note's frontmatter (tags additive)",
		description:
			"Merge keys into a note's frontmatter without touching the body. `tags` is special-cased: array union (additive), not overwrite. Other keys are set/replace.",
		parameters: Type.Object({
			note: Type.String({ description: "Note path (vault-relative)." }),
			patch: Type.Record(Type.String(), Type.Unknown(), {
				description:
					"Object of key→value pairs to merge. tags array is unioned.",
			}),
			expectedMtime: Type.Optional(
				Type.Number({
					description:
						"Optional epoch-ms mtime as last seen by the caller; if the on-disk mtime differs, the update is rejected as a conflict (optimistic concurrency).",
				}),
			),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			try {
				const r = await updateFrontmatter(v.path, params.note, params.patch, {
					expectedMtime: params.expectedMtime,
				});
				return {
					content: [
						{
							type: "text",
							text: `Updated frontmatter of ${r.note}: ${r.updated.join(", ") || "(no changes)"}.`,
						},
					],
					details: r,
				};
			} catch (e) {
				return toolErrorFromCaught(e, {
					vault: v.name,
					note: params.note,
				});
			}
		},
	});

	// ---- Tool: obsidian_delete (B3.4) --------------------------------------
	pi.registerTool({
		name: "obsidian_delete",
		label: "Obsidian Delete",
		promptSnippet: "Delete a note and strip inbound wiki-links (requires confirm:true)",
		description:
			"Delete/remove a note from the vault — THIS is the tool for removing or deleting a note. It also automatically strips all [[wiki-links]] pointing to the deleted note across the vault (cleanupLinks, default true), so a request to 'remove a note without leaving broken/dangling links' is satisfied automatically with no extra step. Set cleanupLinks:false to leave dangling refs. Requires confirm:true to actually delete (safety guard). If unsure whether the note exists, call obsidian_read or obsidian_list first rather than assuming it is absent.",
		parameters: Type.Object({
			note: Type.String({
				description: "Note path to delete (vault-relative).",
			}),
			cleanupLinks: Type.Optional(
				Type.Boolean({
					description:
						"Also remove [[note]] references across the vault. Default true.",
				}),
			),
			confirm: Type.Boolean({
				description: "Must be true to actually delete (safety guard).",
			}),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			if (!params.confirm) {
				return {
					content: [
						{
							type: "text",
							text: `Deletion requires confirm:true (got false). No changes made.`,
						},
					],
					isError: true,
					details: { note: params.note, confirmed: false },
				};
			}
			const r = await deleteNote(v.path, params.note, {
				cleanupLinks: params.cleanupLinks,
			});
			return {
				content: [
					{
						type: "text",
						text: `Deleted ${r.note}; cleaned ${r.linksCleaned.length} inbound link(s).`,
					},
				],
				details: r,
			};
		},
	});

	// ---- Tool: obsidian_invalidate (B1.4 / Phase 4: WS-C3) ------------------
	pi.registerTool({
		name: "obsidian_invalidate",
		label: "Obsidian Invalidate",
		promptSnippet: "Reconcile read cache/index with on-disk state after external edits",
		description:
			"Reconcile the read cache and vault index with the current on-disk state so subsequent searches reflect external edits (e.g. notes changed in the Obsidian app out-of-band). Pass `path` (a note or folder, vault-relative) to reconcile only that subtree; omit it to reconcile the whole vault. Returns a small +added/~changed/-deleted summary.",
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({
					description:
						"Optional vault-relative note or folder to reconcile scantly. Without it, the whole vault is reconciled incrementally (no full rebuild).",
				}),
			),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			const real = resolve(v.path);

			// Path-scoped reconcile: reindex only matching indexed entries.
			if (typeof params.path === "string" && params.path.trim()) {
				const note = safeNotePath(v.path, params.path);
				const abs = join(real, note);
				const isDir = await stat(abs)
					.then((s) => s.isDirectory())
					.catch(() => false);
				const idx = indexCache.get(real);
				if (!idx) {
					invalidateCache(abs);
					return {
						content: [
							{
								type: "text",
								text: `Cleared cache for "${params.path}" (index not yet built; next use builds it fresh).`,
							},
						],
						details: null,
					};
				}
				const prefix = isDir ? note.replace(/\/$/, "") + "/" : note;
				let n = 0;
				for (const p of [...idx.notes.keys()]) {
					const hit = isDir ? p.startsWith(prefix) : p === note;
					if (!hit) continue;
					invalidateCache(join(real, p));
					const entry = await readCached(join(real, p));
					if (entry) {
						indexNote(idx, parseNoteMeta(p, entry.content, entry.mtime));
						n++;
					} else {
						unindexNote(idx, p); // deleted externally
						n++;
					}
				}
				indexRefreshAt.set(real, Date.now());
				return {
					content: [
						{
							type: "text",
							text: `Reconciled ${n} note(s) under "${params.path}" in vault "${v.name}".`,
						},
					],
					details: null,
				};
			}

			// Whole-vault reconcile: clear file cache + incremental index refresh
			// (no full rebuild — only changed files are re-read/parsed).
			invalidateCache();
			const idx = indexCache.get(real);
			if (idx) {
				const diff = await refreshIndex(idx, { force: true });
				return {
					content: [
						{
							type: "text",
							text: `Refreshed vault "${v.name}": +${diff.added} added, ~${diff.changed} changed, -${diff.deleted} deleted.`,
						},
					],
					details: null,
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `Cleared cache for vault "${v.name}" (index not yet built; next use builds it fresh).`,
					},
				],
				details: null,
			};
		},
	});

	// ---- Tool: obsidian_open -------------------------------------------------
	pi.registerTool({
		name: "obsidian_open",
		label: "Obsidian Open",
		promptSnippet: "Open a note or vault in the Obsidian app via URI scheme",
		description:
			"Open a note or the whole vault in the Obsidian app via its URI scheme. Supports opening to a specific heading via note:'Note#Section' (Advanced URI / native).",
		parameters: Type.Object({
			note: Type.Optional(
				Type.String({
					description:
						"Note path relative to vault root. Omit to open the vault.",
				}),
			),
		}),
		async execute(_id, params, _s, _u, ctx) {
			const v = await getVault(ctx.cwd);
			const file = params.note
				? params.note.replace(/^[/\\]+/, "").replace(/\.md$/i, "")
				: undefined;
			const uri = file
				? `obsidian://open?vault=${vname(v)}&file=${encodeURIComponent(file)}`
				: v.registered
					? `obsidian://open?vault=${vname(v)}`
					: `obsidian://open?path=${encodeURIComponent(v.path)}`;
			await openObsidianUri(uri);
			return {
				content: [
					{
						type: "text",
						text: file
							? `Opened ${file} in Obsidian.`
							: `Opened vault "${v.name}".`,
					},
				],
				details: { vault: v.name, note: file ?? null, uri },
			};
		},
	});

	// ---- Tool: obsidian_distill (Zettelkasten subagent) --------------------
	// Tool allowlists for the spawned subagents. Defined once as arrays (not
	// inline CSV strings) so they are auditable and don't drift; joined to CSV
	// at the call site (runSubagentWithRetry takes a CSV string).
	// Phase 5 / WS-B6: distill/garden tool lists are env-overridable so a custom
	// workflow can grant extra tools (or restrict them) without code changes.
	// Each env var is a comma-separated tool-name list; empty/unset → defaults.
	const OBSIDIAN_DISTILL_TOOLS = toolAllowlist("OB_DISTILL_TOOLS", [
		"read",
		"obsidian_list",
		"obsidian_read",
		"obsidian_search",
		"obsidian_create",
		"obsidian_append_section",
	]);
	const GARDEN_AUDIT_TOOLS = toolAllowlist("OB_GARDEN_AUDIT_TOOLS", [
		"obsidian_list",
		"obsidian_read",
		"obsidian_search",
	]);
	const GARDEN_FIX_TOOLS = toolAllowlist("OB_GARDEN_FIX_TOOLS", [
		...GARDEN_AUDIT_TOOLS,
		"obsidian_create",
		"obsidian_append_section",
	]);
	pi.registerTool({
		name: "obsidian_distill",
		label: "Obsidian Distill",
		promptSnippet: "Distill files into atomic Zettelkasten notes via a subagent",
		description: [
			"Distill input markdown/text files into atomic Zettelkasten notes in the vault.",
			"Spawns an isolated subagent that reads the files, decomposes them into atomic ideas,",
			"creates one note per idea (following the Zettelkasten Note template), links each to",
			"existing notes via obsidian_search, and updates Tags/Index.md MOC. Output is Traditional Chinese.",
		].join(" "),
		parameters: Type.Object({
			files: Type.Array(Type.String(), {
				description:
					"Input file paths (markdown/text), relative to cwd or absolute. Each is decomposed into multiple notes.",
			}),
			folder: Type.Optional(
				Type.String({
					description:
						"Vault folder to write notes into. Default: Zettelkasten.",
					default: "Zettelkasten",
				}),
			),
			maxNotes: Type.Optional(
				Type.Number({
					description:
						"Optional hint: roughly cap the number of notes produced from all files combined.",
				}),
			),
		}),
		async execute(_id, params, signal, _u, ctx) {
			const cwd = ctx.cwd;
			const files = (params.files ?? []).map((f) => resolve(cwd, f));
			const missing = files.filter((f) => !existsSync(f));
			if (files.length === 0)
				return {
					content: [{ type: "text", text: "No input files provided." }],
					isError: true,
					details: null,
				};
			if (missing.length > 0)
				return {
					content: [
						{ type: "text", text: `File(s) not found: ${missing.join(", ")}` },
					],
					isError: true,
					details: null,
				};

			const folder = params.folder ?? "Zettelkasten";
			const taskParts = [
				`把以下輸入檔分解成 Zettelkasten 原子筆記，寫入 vault 的「${folder}」資料夾。`,
				params.maxNotes
					? `（提示：全部合計約不超過 ${params.maxNotes} 張卡，品質優先於數量。）`
					: "",
				"輸入檔：",
				...files.map((f) => `- ${relative(cwd, f) || f}`),
			].filter(Boolean);
			const task = taskParts.join("\n");

			const tools = OBSIDIAN_DISTILL_TOOLS.join(",");
			// Live progress: surface note creation to stderr so long distill runs
			// are observable (the subagent is otherwise silent until it exits).
			const prog = makeSubagentProgressLogger("distill");
			const t0 = Date.now();
			const { output, exitCode, stderr, timedOut, result } =
				await runSubagentWithRetry(
					cwd,
					ZETTEL_SYSTEM_PROMPT,
					task,
					tools,
					signal,
					"pi-distill-",
					{ onEvent: prog.onEvent },
				);
			const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
			const { created, failed } = prog.stats();
			console.error(
				`  [distill] ${created} note(s) created${failed ? `, ${failed} failed` : ""} (${elapsed}s)`,
			);
			invalidateCache(); // A3.2: child wrote notes; parent search must see them
			if (timedOut) {
				return {
					content: [
						{
							type: "text",
							text: `Distiller timed out after ${Number(process.env.OB_SUBAGENT_TIMEOUT_MS ?? 5 * 60_000) / 1000}s. Partial output:
${output.slice(-2000)}`,
						},
					],
					isError: true,
					details: { timedOut: true, stderr, result },
				};
			}
			if (exitCode !== 0 && !output) {
				return {
					content: [
						{
							type: "text",
							text: `Distiller failed (exit ${exitCode}).\n${stderr.slice(-2000)}`,
						},
					],
					isError: true,
					details: { exitCode, stderr, result },
				};
			}
			// Phase 2 / WS-B1: post-run audit of every note the subagent claims to
			// have created. Validate frontmatter schema, sane size, and wiki-link
			// resolvability; surface malformed output so the caller can repair it
			// instead of trusting silent corruption. Best-effort — never fails the
			// run, only annotates it.
			const reportedNotes = Array.isArray(result?.notes) ? result.notes.map(String) : [];
			let validation: { notes: NoteValidation[]; valid: number; invalid: number } | undefined;
			let validationText = "";
			if (reportedNotes.length > 0) {
				try {
					const v = await getVault(ctx.cwd);
					validation = await validateZettelNotes(v.path, reportedNotes);
				} catch {
					validation = undefined;
				}
				if (validation && validation.invalid > 0) {
					validationText =
						`\n\n⚠ Validation: ${validation.invalid}/${validation.notes.length} created note(s) failed the Zettelkasten schema check — review/repair before relying on them:\n` +
						validation.notes
							.filter((n) => !n.ok)
							.map((n) => `  - ${n.path}: ${n.errors.join("; ")}`)
							.join("\n");
				} else if (validation && validation.valid > 0) {
					validationText = `\n\n✓ Validation: all ${validation.valid} created note(s) pass the Zettelkasten schema check.`;
				}
			}
			return {
				content: [
					{
						type: "text",
						text: (output || "(distiller produced no output)") + validationText,
					},
				],
				details: { exitCode, stderr, result, validation },
			};
		},
	});

	// ---- Tool: obsidian_garden (vault gardener subagent) --------------------
	pi.registerTool({
		name: "obsidian_garden",
		label: "Obsidian Garden",
		promptSnippet: "Audit/repair vault graph health (orphans, broken links, MOC drift)",
		description: [
			"Audit and optionally repair the Obsidian vault's knowledge-graph health.",
			"Spawns an isolated subagent that scans all notes and reports: orphan notes (no backlinks),",
			"broken wiki-links, missing frontmatter, suspected duplicates, unlinked-but-related notes,",
			"and MOC drift in Tags/Index.md. In 'fix' mode it safely adds links and updates the MOC",
			"(never deletes or merges). Output is Traditional Chinese.",
		].join(" "),
		parameters: Type.Object({
			mode: Type.Optional(
				Type.Union([Type.Literal("audit"), Type.Literal("fix")], {
					description:
						"audit = report only (default); fix = also apply safe repairs (add links, update MOC)",
					default: "audit",
				}),
			),
			scope: Type.Optional(
				Type.String({
					description:
						"Restrict the scan to a vault folder (e.g. 'Zettelkasten'). Default: whole vault.",
					default: "",
				}),
			),
		}),
		async execute(_id, params, signal, _u, ctx) {
			const cwd = ctx.cwd;
			const mode = params.mode ?? "audit";
			const scope = params.scope?.trim() || "整個 vault";
			const task = `請對${scope}執行健康度${mode === "fix" ? "檢查並修復（fix 模式）" : "審計（audit 模式，僅回報不改動）"}。`;
			// fix mode needs write tools; audit is read-only.
			const tools = (
				mode === "fix" ? GARDEN_FIX_TOOLS : GARDEN_AUDIT_TOOLS
			).join(",");
			const prog = makeSubagentProgressLogger("garden");
			const t0 = Date.now();
			const { output, exitCode, stderr, timedOut, result } =
				await runSubagentWithRetry(
					cwd,
					GARDEN_SYSTEM_PROMPT,
					task,
					tools,
					signal,
					"pi-garden-",
					{ onEvent: prog.onEvent },
				);
			const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
			const { created, failed, toolCalls } = prog.stats();
			console.error(
				`  [garden] ${toolCalls} tool call(s)${created ? `, ${created} note(s) added` : ""}${failed ? `, ${failed} failed` : ""} (${elapsed}s)`,
			);
			invalidateCache(); // A3.2: child may have added links/notes
			if (timedOut) {
				return {
					content: [
						{
							type: "text",
							text: `Gardener timed out after ${Number(process.env.OB_SUBAGENT_TIMEOUT_MS ?? 5 * 60_000) / 1000}s. Partial output:\n${output.slice(-2000)}`,
						},
					],
					isError: true,
					details: { timedOut: true, stderr, result },
				};
			}
			if (exitCode !== 0 && !output) {
				return {
					content: [
						{
							type: "text",
							text: `Gardener failed (exit ${exitCode}).\n${stderr.slice(-2000)}`,
						},
					],
					isError: true,
					details: { exitCode, stderr, result },
				};
			}
			// Phase 5 / WS-B4: in fix mode, audit every note the gardener
			// reported modifying for structural integrity (frontmatter
			// balanced, non-empty, code fences paired). A misbehaving child
			// could corrupt a note via append_section; this surfaces it
			// instead of leaving invalid markdown. Best-effort — annotates,
			// never fails the run.
			let validationText = "";
			let validation: { notes: IntegrityIssue[]; intact: number; broken: number } | undefined;
			if (mode === "fix") {
				const modified = Array.isArray((result as any)?.notesModified)
					? (result as any).notesModified.map(String)
					: [];
				if (modified.length > 0) {
					try {
						const v = await getVault(cwd);
						validation = await validateNoteIntegrityBatch(v.path, modified);
					} catch {
						validation = undefined;
					}
					if (validation && validation.broken > 0) {
						validationText =
							`\n\n⚠ Integrity: ${validation.broken}/${validation.notes.length} modified note(s) failed the markdown integrity check — review before relying on them:\n` +
							validation.notes
								.filter((n) => !n.ok)
								.map((n) => `  - ${n.path}: ${n.errors.join("; ")}`)
								.join("\n");
					} else if (validation && validation.intact > 0) {
						validationText = `\n\n✓ Integrity: all ${validation.intact} modified note(s) passed the markdown integrity check.`;
					}
				}
			}
			return {
				content: [
					{ type: "text", text: (output || "(gardener produced no output)") + validationText },
				],
				details: { exitCode, stderr, result, validation },
			};
		},
	});

	// ---- Tool: obsidian_status ---------------------------------------------
	// Introspection: lets the agent (and zk_* workflows) see which vault is
	// active, where it came from, and all candidates BEFORE acting. Returns the
	// same `source` / `staleReason` fields the /obsidian-config command shows.
	pi.registerTool({
		name: "obsidian_status",
		label: "Obsidian Status",
		promptSnippet: "Show the active vault (path/source/note count) — call before vault writes",
		description:
			"Show the active Obsidian vault: resolved path, name, resolution source (env|config|app|local|global), whether it is registered in the Obsidian app, note count, stale-config warnings, and all candidate vaults. Use this BEFORE any vault write or when the user asks which vault is in use — obsidian_* and zk_* tools all operate on this vault.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _u, ctx) {
			const cwd = ctx.cwd;
			const active = await getVault(cwd);
			const candidates = await listVaultCandidates(cwd);
			const cfg = await readVaultConfig(cwd);
			const noteCount = await countNotes(active.path);
			const text = [
				`Active vault: ${active.name}`,
				`  path:       ${active.path}`,
				`  source:     ${active.source}${active.registered ? " (registered)" : " (not registered)"}`,
				active.staleReason ? `  ⚠ stale:     ${active.staleReason}` : null,
				`  notes:      ${noteCount}`,
				`  config:     ${vaultConfigPath(cwd)} (mode: ${cfg.mode ?? "(unset)"}${cfg.vault_path ? ", vault_path: " + cfg.vault_path : ""})`,
				"",
				"Candidates:",
				...candidates.map((c) => {
					const here = c.path === active.path ? " ← active" : "";
					return `  ${c.exists ? "✓" : "✗"} ${c.source.padEnd(7)} ${c.path}${c.open ? " [open]" : ""}${here}`;
				}),
			]
				.filter((s) => s !== null)
				.join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					active: {
						path: active.path,
						name: active.name,
						source: active.source,
						registered: active.registered,
						staleReason: active.staleReason ?? null,
						noteCount,
					},
					candidates,
					configPath: vaultConfigPath(cwd),
					config: cfg,
				},
			};
		},
	});

	// ---- Command: /obsidian --------------------------------------------------
	pi.registerCommand("obsidian", {
		description:
			"Open Obsidian vault (or a note). Usage: /obsidian [note/path]",
		handler: async (args, ctx) => {
			try {
				const v = await getVault(ctx.cwd);
				const file = args?.trim()
					? args.trim().replace(/\.md$/i, "")
					: undefined;
				const uri = file
					? `obsidian://open?vault=${vname(v)}&file=${encodeURIComponent(file)}`
					: v.registered
						? `obsidian://open?vault=${vname(v)}`
						: `obsidian://open?path=${encodeURIComponent(v.path)}`;
				await openObsidianUri(uri);
				ctx.ui.notify(
					file ? `Opened ${file} in Obsidian` : `Opened vault "${v.name}"`,
					"info",
				);
			} catch (e) {
				ctx.ui.notify(`Obsidian error: ${(e as Error).message}`, "error");
			}
		},
	});

	// ---- Command: /obsidian-init --------------------------------------------
	pi.registerCommand("obsidian-init", {
		description:
			"Register the project vault folder with the Obsidian app (opens it by absolute path).",
		handler: async (_args, ctx) => {
			try {
				const v = await getVault(ctx.cwd);
				// `obsidian://open?path=<abs>` adds the folder to Obsidian's vault list if absent.
				await openObsidianUri(
					`obsidian://open?path=${encodeURIComponent(v.path)}`,
				);
				ctx.ui.notify(
					`Registered vault "${v.name}" at ${v.path} with Obsidian`,
					"info",
				);
			} catch (e) {
				ctx.ui.notify(`Obsidian init error: ${(e as Error).message}`, "error");
			}
		},
	});

	// ---- Command: /obsidian-config -----------------------------------------
	// Human-friendly vault inspection / switching. One-stop view of which vault
	// the obsidian_* and zk_* tools will actually hit, and a way to change it.
	//
	//   /obsidian-config              show active vault + source + all candidates
	//   /obsidian-config <path>       set explicit vault path (mode "explicit")
	//   /obsidian-config --use-app    follow the Obsidian app's open vault (mode "app")
	//   /obsidian-config --list       list all registered vaults from obsidian.json
	//   /obsidian-config --clear      forget the explicit setting (fall back to app/local)
	pi.registerCommand("obsidian-config", {
		description:
			"Show or set the active Obsidian vault. Usage: /obsidian-config [path | --use-app | --list | --clear]",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const raw = (args ?? "").trim();
			const flag = raw.startsWith("--") ? raw : null;
			const setPath = !flag && raw.length > 0 ? raw : null;

			const lines: string[] = [];
			const push = (s: string) => lines.push(s);

			try {
				// --- mutations first ---
				if (setPath) {
					const abs = isAbsolute(setPath) ? setPath : resolve(cwd, setPath);
					if (!existsSync(abs)) {
						push(`⚠️  Path does not exist: ${abs}`);
						push(
							`Created config anyway. Run /obsidian-init after creating the folder.`,
						);
					} else {
						const count = await countNotes(abs);
						push(`✓ Active vault set to: ${abs} (${count} notes)`);
					}
					await writeVaultConfig(cwd, { vault_path: abs, mode: "explicit" });
					push(`  Written to ${vaultConfigPath(cwd)} (mode: explicit)`);
					ctx.ui.notify(`obsidian vault → ${basenameOf(abs)}`, "info");
				} else if (flag === "--use-app") {
					await writeVaultConfig(cwd, { mode: "app" });
					push(
						`✓ Mode set to "app": obsidian_* will follow the Obsidian app's open vault.`,
					);
					push(`  (Tier 1 env/config overrides still win if set.)`);
					ctx.ui.notify("obsidian mode → app", "info");
				} else if (flag === "--clear") {
					await writeVaultConfig(cwd, { vault_path: "", mode: "app" });
					push(
						`✓ Cleared explicit vault_path. Resolution falls back to app/local.`,
					);
					ctx.ui.notify("obsidian config cleared", "info");
				}

				// --- status (always shown) ---
				const active = await resolveVault(cwd);
				push("");
				push(`Active vault: ${active.name}`);
				push(`  path:       ${active.path}`);
				push(
					`  source:     ${active.source}${active.registered ? " (registered in Obsidian app)" : " (not registered)"}`,
				);
				if (active.staleReason) push(`  ⚠ stale:     ${active.staleReason}`);
				push(`  notes:      ${await countNotes(active.path)}`);

				// --- candidates (for --list or whenever helpful) ---
				if (flag === "--list" || !flag) {
					push("");
					push("Candidates:");
					const seen = new Set<string>();
					for (const c of await listVaultCandidates(cwd)) {
						const key = c.path;
						if (seen.has(key)) continue;
						seen.add(key);
						const here = c.path === active.path ? " ← active" : "";
						const extra = c.open
							? " [open in app]"
							: c.source === "env"
								? " [env]"
								: c.source === "config"
									? " [config]"
									: c.source === "local"
										? " [local fallback]"
										: "";
						push(
							`  ${c.exists ? "✓" : "✗"} ${c.source.padEnd(7)} ${c.path}${extra}${here}`,
						);
					}
				}

				push("");
				push(`Config file: ${vaultConfigPath(cwd)}`);
				ctx.ui.notify(lines.join("\n"), "info");
			} catch (e) {
				ctx.ui.notify(
					`/obsidian-config error: ${(e as Error).message}`,
					"error",
				);
			}
		},
	});

	// ---- Startup dep check --------------------------------------------------
	const _EXT_DIR: string | undefined = (() => {
		try {
			const metaDir = (import.meta as any).dir;
			if (typeof metaDir === "string" && metaDir) return metaDir;
			if (typeof import.meta.url === "string")
				return dirname(fileURLToPath(import.meta.url));
		} catch {
			/* import.meta unavailable (non-ESM context) — fall back to undefined */
		}
		return undefined;
	})();

	pi.on("session_start", async (_event, ctx) => {
		const missing = _missingDeps(["@earendil-works/pi-coding-agent"], _EXT_DIR);
		if (missing.length > 0) {
			ctx.ui.notify(
				`pi-obsidian: missing npm packages: ${missing.join(", ")}.\nRun: bun install (in ${_findMonorepoRoot(_EXT_DIR)})`,
				"error",
			);
			return;
		}
		try {
			const v = await getVault(ctx.cwd);
			// Above-editor banner (same placement as the /goal banner), delayed
			// 10s. Delaying past the startup notify burst (zai-mcp fires right
			// after this handler) sidesteps the clobbering that previously forced
			// a "warning" type: by the time this lands, the startup notifies have
			// settled, so we render a clean banner instead of the scary
			// "Warning:" line. setWidget(key, [lines]) with default placement
			// renders above the input editor (like /goal); setStatus would land in
			// the footer status bar, which is the wrong spot for this. The vault
			// is cached per-session (getVault). This is a TRANSIENT confirmation
			// banner, not a persistent status indicator: it shows once to confirm
			// which vault is active, then auto-dismisses (the setWidget API has
			// no TTL, so we clear it ourselves with a second timer).
			const theme = ctx.ui.theme;
			const icon = v.registered ? "📓" : "📎";
			const label = theme.fg("dim", "obsidian vault active:");
			const name = theme.fg("accent", v.name);
			const tag = v.registered ? "" : theme.fg("dim", " (local)");
			// Timers can straddle a session switch (/resume, ctx.fork,
			// ctx.switchSession): the captured ctx goes stale, and the ctx.ui
			// getter throws assertActive() inside the callback ->
			// uncaughtException -> pi crashes. Guard every deferred ctx.ui call;
			// a stale session needs no banner (the replacement session renders
			// its own on its own session_start).
			scheduleVaultBanner(ctx, `${icon} ${label} ${name}${tag}`);
		} catch {
			ctx.ui.notify("obsidian: no vault found", "warning");
		}
	});
}
