import {
	join,
	resolve,
	relative,
	sep,
	isAbsolute,
} from "node:path";
import { lstat, realpath } from "node:fs/promises";

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

export const fsLstat = lstat;
export const fsRealpath = realpath;

/** Segments that must never be written via note tools. Reading is allowed
 *  (e.g. obsidian_read of app config for diagnostics), but create/append/move
 *  must refuse, so an agent cannot corrupt Obsidian app state or VCS internals. */
export const WRITE_BLOCKLIST = [".obsidian", ".git"];

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
