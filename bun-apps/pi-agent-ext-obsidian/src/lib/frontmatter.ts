import { join, resolve } from "node:path";
import { mkdir, readFile } from "node:fs/promises";

import {
	VaultError,
	classifyFsError,
	fsErrCode,
	errMsg,
} from "./errors";
import {
	atomicWriteFile,
	noteMtime,
	mtimeConflict,
	readCached,
	invalidateCache,
} from "./fs-cache";
import {
	safeNotePath,
	assertWritablePath,
	assertWithinVault,
} from "./path-safety";
import { reindexFile } from "./index";

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

export function stripScalar(s: string): any {
	const t = s.trim().replace(/^["']/, "").replace(/["']$/, "");
	if (t === "true") return true;
	if (t === "false") return false;
	if (t === "null" || t === "") return null;
	return t;
}

/** Serialize a frontmatter object back to text (flow-style for arrays). */
export function stringifyFrontmatter(data: Record<string, any>): string {
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
	// Incremental reindex (matches appendUnderHeading / obsidian_create / _append).
	await reindexFile(vaultPath, note);
	return {
		note: note.replace(/\.md$/i, "") + ".md",
		updated,
		bodyUntouched: true,
	};
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
		await reindexFile(vaultPath, note);
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
	await reindexFile(vaultPath, note);
	return { created, insertedAt: "heading" };
}
