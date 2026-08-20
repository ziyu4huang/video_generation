import { join, resolve } from "node:path";
import { mkdir, rm, stat } from "node:fs/promises";

import { safeNotePath, assertWithinVault, assertWritablePath } from "./path-safety";
import { atomicWriteFile, renameOverwrite, readCached, invalidateCache } from "./fs-cache";
import { type VaultIndex, getIndex, dropIndex } from "./index";
import { backlinkPaths } from "./graph";

/** Match [[Target]] wiki-links on a line. Returns the inner target strings.
 *  Handles display aliases `[[Target|Display]]` and path targets `[[A/B/C]]`. */
export function extractWikiLinks(line: string): string[] {
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

// ---- Structured editing (B3) -----------------------------------------------

/** Rewrite a single wiki-link reference, preserving alias and #section.
 *  Returns the new [[...]] form, or the original if it doesn't match the old target. */
export function rewriteLinkToken(
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
export const LINK_KEEP = Symbol("@repo/s2-agent-ext-obsidian/link-keep");
export const LINK_DELETE = Symbol("@repo/s2-agent-ext-obsidian/link-delete");

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
	// Rewrite every inbound backlink concurrently. Each source is isolated in
	// its own try/catch so a single failing read/write can't abort the rest —
	// throwers land in failedSources, successes in linksRewritten, both in the
	// original backlinkPaths iteration order (Promise.all preserves array order).
	const rewriteResults = await Promise.all(
		[...sources].map(async (src) => {
			const srcAbs = join(real, src);
			try {
				const entry = await readCached(srcAbs);
				if (!entry) return { src, ok: true as const, rewritten: false };
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
					return { src, ok: true as const, rewritten: true };
				}
				return { src, ok: true as const, rewritten: false };
			} catch (e) {
				return { src, ok: false as const };
			}
		}),
	);
	for (const r of rewriteResults) {
		if (!r.ok) failedSources.push(r.src);
		else if (r.rewritten) linksRewritten.push(r.src);
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
		const tLower = target.toLowerCase();
		// Strip inbound links from every source concurrently. On the happy path the
		// result matches the prior sequential `for`; on the exceptional path a thrown
		// read/write still rejects the whole op, but there is NO rollback — concurrent
		// writes that already started may have landed (deleteNote exposes no
		// failedSources field, so a partial mutation surfaces only as the rejection).
		// linksCleaned stays in backlinkPaths iteration order (Promise.all preserves
		// input order).
		const cleaned = await Promise.all(
			[...sources].map(async (src) => {
				const srcAbs = join(real, src);
				const entry = await readCached(srcAbs);
				if (!entry) return null;
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
				if (!changed) return null;
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
				return src;
			}),
		);
		for (const src of cleaned) if (src) linksCleaned.push(src);
	}
	await rm(abs, { force: true });
	invalidateCache(abs);
	dropIndex(real);
	return { deleted: true, note: notePath, linksCleaned };
}
