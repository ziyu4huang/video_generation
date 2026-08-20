import { resolve } from "node:path";

import { safeNotePath } from "./path-safety";
import { readCached } from "./fs-cache";
import { parseFrontmatter, updateFrontmatter } from "./frontmatter";
import { type VaultIndex, getIndex, resolveLink } from "./index";
import { extractWikiLinks } from "./links";

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
export const ZETTEL_REQUIRED_KEYS = ["id", "created", "tags", "sources"];

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

// ---- Deterministic health check registration (Phase 1 de-dup) ------------
// The deterministic graph health check (graphHealth/healGraph) lives in
// s2-agent-ext-knowledge-card/src/retrieve.ts. To avoid a backwards import
// dependency (obsidian → knowledge-card), knowledge-card registers its
// implementation here at extension load time. The garden tool's deterministic
// engine calls through this indirection.

export interface DetHealthResult {
	health: any;
	text: string;
}

let _detHealthFn: ((opts: {
	vaultPath: string;
	folder: string;
	mocPath: string;
	fix: boolean;
}) => Promise<DetHealthResult>) | null = null;

export function registerDeterministicHealthCheck(
	fn: (opts: {
		vaultPath: string;
		folder: string;
		mocPath: string;
		fix: boolean;
	}) => Promise<DetHealthResult>,
) {
	_detHealthFn = fn;
}

export async function runDeterministicHealthCheck(opts: {
	vaultPath: string;
	folder: string;
	mocPath: string;
	fix: boolean;
}): Promise<DetHealthResult> {
	if (!_detHealthFn) {
		throw new Error(
			"Deterministic health check not available — s2-agent-ext-knowledge-card not loaded",
		);
	}
	return _detHealthFn(opts);
}
// ---- Zettel frontmatter auto-repair (distill backstop) --------------------
// When the distill subagent omits a required key that can be computed
// deterministically, fill it instead of leaving the note malformed. Only fills
// ABSENT keys — never overwrites an existing value or reorders tags (a
// wrong-but-present tags[0] stays a reported warning, not a silent mutation).

/** Format an epoch-ms mtime into the Zettel `id` (YYYYMMDDHHmm, local) and
 *  `created` (YYYY-MM-DD, local) formats mandated by ZETTEL_SYSTEM_PROMPT. */
export function mtimeToZettelIds(mtimeMs: number): { id: string; created: string } {
	const d = new Date(mtimeMs);
	const p = (n: number) => String(n).padStart(2, "0");
	return {
		id: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`,
		created: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
	};
}

export interface FrontmatterRepair {
	path: string;
	repaired: string[]; // keys that were filled this run
	skipped: string[]; // required keys already present (left untouched)
	error?: string; // read/write failure reason, if any
}

/** Deterministically fill ABSENT required frontmatter keys on Zettel cards.
 *  Writes back via updateFrontmatter (preserves body, honors optimistic
 *  concurrency). Best-effort — never throws; a failed note is reported, not
 *  fatal. Returns a per-note repair report + total keys filled.
 *
 *  id      ← file mtime as YYYYMMDDHHmm
 *  created ← file mtime as YYYY-MM-DD
 *  tags    ← ["zettel"] (only if absent/empty — never reordered)
 *  sources ← defaultSources (only if absent) */
export async function repairZettelFrontmatter(
	vaultPath: string,
	paths: string[],
	defaultSources: string[],
): Promise<{ notes: FrontmatterRepair[]; totalRepaired: number }> {
	const real = resolve(vaultPath);
	const notes: FrontmatterRepair[] = [];
	let totalRepaired = 0;
	for (const rel of paths) {
		const abs = safeNotePath(real, rel);
		const repaired: string[] = [];
		const skipped: string[] = [];
		try {
			const entry = await readCached(abs);
			if (!entry) {
				notes.push({ path: rel, repaired, skipped, error: "note not found on disk" });
				continue;
			}
			const { data } = parseFrontmatter(entry.content);
			const patch: Record<string, any> = {};
			const has = (k: string) =>
				k in data && data[k] !== "" && data[k] != null &&
				(Array.isArray(data[k]) ? (data[k] as any[]).length > 0 : true);
			// id / created ← file mtime
			if (!has("id") || !has("created")) {
				const ids = mtimeToZettelIds(entry.mtime);
				if (!has("id")) patch.id = ids.id;
				if (!has("created")) patch.created = ids.created;
			}
			// tags ← ["zettel"] only if absent/empty (never reorder existing)
			const tagsArr = Array.isArray(data.tags) ? (data.tags as any[]) : null;
			if (!tagsArr || tagsArr.length === 0) patch.tags = ["zettel"];
			// sources ← defaultSources only if absent
			if (!has("sources") && defaultSources.length > 0) patch.sources = defaultSources;
			for (const k of ZETTEL_REQUIRED_KEYS) if (!(k in patch)) skipped.push(k);
			if (Object.keys(patch).length > 0) {
				await updateFrontmatter(real, rel, patch, { expectedMtime: entry.mtime });
				for (const k of Object.keys(patch)) repaired.push(k);
				totalRepaired += repaired.length;
			}
		} catch (e: any) {
			notes.push({ path: rel, repaired, skipped, error: String(e?.message ?? e) });
			continue;
		}
		notes.push({ path: rel, repaired, skipped });
	}
	return { notes, totalRepaired };
}
