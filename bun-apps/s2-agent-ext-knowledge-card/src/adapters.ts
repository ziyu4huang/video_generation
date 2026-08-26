/** Source → KnowledgeRecord adapters + input collection + jsonl parsing (split from ingest.ts — hermes-arch-13). */
import { type Dirent, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@repo/s2-agent-ext-obsidian";
import type { ExtractedEntity } from "@repo/s2-agent-core-interface";
import { normTag, slugify } from "./card-format.ts";
import { extractFeatures } from "./card-render.ts";
import { firstSentenceSummary } from "./extractor.ts";
import type { KnowledgeRecord, SourceFamily } from "./types.ts";
export function stripWikiLinkBrackets(content: string): string {
	return content.replace(/\[\[([^\]]+)\]\]/g, (_full, inner: string) => {
		const parts = String(inner).split("|");
		const target = parts[0]!.split("#")[0]!.trim();
		const alias = parts[1]?.trim();
		return alias || target || String(inner);
	});
}

// ---------------------------------------------------------------------------
// input collection (directory expansion)
// ---------------------------------------------------------------------------

/** File extension each source family ingests. */
const SOURCE_EXT: Record<SourceFamily, "md" | "knowledge.jsonl"> = {
	"workflow-jsonl": "knowledge.jsonl",
	hermes: "md",
	"auto-memory": "md",
	generic: "md",
};

/** Basenames to skip when expanding a directory (rollup/index files, not
 *  atomic topics — their content is already carried by the per-topic files). */
const DIR_SKIP_BASENAMES = new Set(["MEMORY.md", "README.md"]);

/** Recursively collect files under `dir` matching `ext`, skipping index
 *  basenames. Returns absolute paths. */
function collectDir(dir: string, ext: "md" | "knowledge.jsonl"): string[] {
	const out: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const ent of entries) {
		const isDir = ent.isDirectory();
		const isFile = ent.isFile();
		const abs = join(dir, ent.name);
		if (isDir) {
			out.push(...collectDir(abs, ext));
		} else if (isFile) {
			if (DIR_SKIP_BASENAMES.has(ent.name)) continue;
			if (abs.endsWith(`.${ext}`)) out.push(abs);
		}
	}
	return out;
}

/** Expand input paths: directories are recursively globbed for the source's
 *  file type (.md for auto-memory/hermes, .knowledge.jsonl for workflow-jsonl);
 *  files pass through unchanged. Missing paths are reported in `skipped` rather
 *  than thrown. Non-memory `.md` (no `name`+`description` frontmatter) is NOT
 *  filtered here — `adaptAutoMemoryMarkdown` returns null for those and the
 *  caller records a parse error, keeping concerns separated.
 *
 *  Returned files are absolute, sorted, and unique. */
export function collectInputFiles(
	paths: string[],
	opts: { source: SourceFamily; cwd: string },
): { files: string[]; skipped: { path: string; reason: string }[] } {
	const ext = SOURCE_EXT[opts.source] ?? "md";
	const collected: string[] = [];
	const skipped: { path: string; reason: string }[] = [];
	for (const p of paths) {
		const abs = /^\//.test(p) ? p : join(opts.cwd, p);
		let st;
		try {
			// existsSync + statSync (lstatSync to avoid following symlinks). */
			st = statSync(abs);
		} catch {
			skipped.push({ path: p, reason: "not found" });
			continue;
		}
		if (st.isDirectory()) {
			collected.push(...collectDir(abs, ext));
		} else if (st.isFile()) {
			collected.push(abs);
		} else {
			skipped.push({ path: p, reason: "not a regular file or directory" });
		}
	}
	const unique = [...new Set(collected)].sort();
	return { files: unique, skipped };
}

// ---------------------------------------------------------------------------
// auto-memory parsing (the second convergence source)
// ---------------------------------------------------------------------------

/**
 * Adapt an auto-memory topic file (the `.claude-glm/.../memory/*.md` shape) into
 * a KnowledgeRecord, so it can converge into the SAME graph as workflow-jsonl.
 *
 * Memory file frontmatter:
 *   ---
 *   name: <slug>
 *   description: "<one-line summary>"
 *   metadata:
 *     type: user | feedback | project | reference
 *   ---
 *   <body — the fact; for feedback/project, Why/How-to-apply lines>
 *
 * Mapping:
 *   id          = `auto-memory:<name>`        (stable; namespaced like workflow ids)
 *   type        = `pattern` (default) — memory is human-curated, not a gotcha/lever
 *                 in the workflow sense; the metadata.type rides as a tag.
 *   title       = description (the one-line hook)
 *   detail      = body (Why/How stripped of frontmatter)
 *   tags        = [auto-memory, <metadata.type>, ...slugs extracted from [[links]]]
 *   dimension   = metadata.type
 *   confidence  = 1 (human-curated)
 *
 * Returns null if the file has no `name` + `description` (not a memory file).
 */
export function adaptAutoMemoryMarkdown(content: string): KnowledgeRecord | null {
	const { data, bodyStart } = parseFrontmatter(content);
	const name = typeof data.name === "string" ? data.name.trim() : "";
	const description =
		typeof data.description === "string" ? data.description.trim() : "";
	if (!name || !description) return null;

	const meta = (data.metadata ?? {}) as Record<string, unknown>;
	// parseFrontmatter is flat-YAML; nested `metadata.type` won't appear in
	// `meta` — scan the raw frontmatter for it as a fallback.
	let memType =
		typeof meta.type === "string" ? meta.type.trim().toLowerCase() : "";
	if (!memType) {
		const lines = content.split("\n");
		let inMeta = false;
		// Skip the opening "---" (line 0); scan until the closing "---".
		for (let i = 1; i < lines.length; i++) {
			const ln = lines[i]!;
			if (ln.trim() === "---") break;
			if (/^metadata\s*:/.test(ln)) {
				inMeta = true;
				continue;
			}
			if (inMeta) {
				if (/^\S/.test(ln)) break; // left the metadata block
				const m = ln.match(/^\s+type\s*:\s*(.+)$/);
				if (m) {
					memType = m[1]!.trim().replace(/^["']|["']$/g, "").toLowerCase();
					break;
				}
			}
		}
	}
	if (!memType) memType = "reference";

	// Body = everything after the frontmatter block.
	const body = content.split("\n").slice(bodyStart).join("\n").trim();

	// Harvest [[wiki-link]] targets AND body #hashtags as cross-link tags so
	// memory cards connect to workflow cards that name the same concept (e.g.
	// both link [[git-pr-workflow-...]] or both tag the concept #flux2).
	const linkTags = new Set<string>();
	const linkRe = /\[\[([^\]]+)\]\]/g;
	// `#\w[\w-]*` — a leading-# token. Avoid matching inside code/urls by
	// requiring a word char right after `#` and a non-word char before it.
	const hashRe = /(^|[^\w/])#([a-z0-9][\w-]*)/gi;
	for (const line of content.split("\n")) {
		let m: RegExpExecArray | null;
		while ((m = linkRe.exec(line)) !== null) {
			const t = normTag(m[1]!.split(/[#|]/)[0]!);
			if (t) linkTags.add(t);
		}
		hashRe.lastIndex = 0;
		while ((m = hashRe.exec(line)) !== null) {
			const t = normTag(m[2]!);
			if (t) linkTags.add(t);
		}
	}

	// Strip inline `[[sibling-name]]` wiki-link brackets from the body, keeping
	// the link text as plain prose. Memory files cross-reference sibling memory
	// topics by bare `name` slug (per the auto-memory convention), but converged
	// cards are namespaced + slugified (`auto-memory-<slugify(name)>.md`), so
	// raw body links would mostly be dead links (namespace mismatch, `.`→`-`
	// slug divergence, or pointers to topics absent from this vault). Graph
	// connectivity does NOT depend on these: the tag harvest above drives the
	// real cross-source edges via `## 連結` (computed from shared tags against
	// actual folder cards). Stripping keeps the prose readable and the graph
	// dead-link-free. `[[X|alias]]` → `alias`; `[[X#anchor]]` → `X`.
	const detailBody = body ? stripWikiLinkBrackets(body) : body;

	return {
		id: `auto-memory:${name}`,
		type: "pattern",
		title: description.replace(/^["']|["']$/g, ""),
		detail: detailBody || description,
		tags: ["auto-memory", memType, ...[...linkTags].slice(0, 8)],
		dimension: memType,
		confidence: 1,
		status: "active",
		superseded_by: null,
	};
}

// ---------------------------------------------------------------------------
// hermes memory parsing (the third convergence source)
// ---------------------------------------------------------------------------

/** Mapping from a hermes `[category]` prefix to the KnowledgeRecord `type`.
 *  Hermes entries are prefixed `[failure]` / `[correction]` / `[insight]` /
 *  `[tool-quirk]` / `[convention]` / `[preference]`; entries with no prefix are
 *  general notes. The literal category is ALSO carried as a tag (preserving
 *  the human classification) — the `type` is the schema enum the ranking /
 *  retrieve paths key on. */
const HERMES_TYPE: Record<string, string> = {
	failure: "avoid",
	correction: "false_positive",
	insight: "pattern",
	"tool-quirk": "gotcha",
	convention: "pattern",
	preference: "pattern",
};

/** Common English stopwords + generic glue/modal tokens excluded from the
 *  keyword-tag harvest so hermes cards cross-link on *distinctive* tokens
 *  (argparse, fp8, metallib, bun, vae) rather than filler (always, never,
 *  the, with, test, runs). Min token length for harvest is 3 (catches bun/
 *  mlx/vae/cli/tui), so this list must cover the 3-4 char filler that the old
 *  ≥4 gate let through (always/never/test/runs/node/yarn). */
const HERMES_STOP = new Set([
	// articles / conjunctions / prepositions / pronouns
	"the", "and", "for", "with", "that", "this", "how", "why", "does", "did",
	"was", "were", "when", "what", "have", "has", "had", "not", "but", "are",
	"is", "its", "all", "any", "can", "you", "your", "from", "into", "than",
	"via", "per", "each", "their", "they", "them", "our", "who", "which",
	// modal / imperative filler (high-frequency, non-semantic)
	"use", "using", "used", "will", "must", "should", "would", "could", "may",
	"then", "every", "always", "never", "make", "makes", "made", "run", "runs",
	"get", "got", "set", "try", "need", "keep", "let", "want", "way", "thing",
	// generic dev-process nouns (too common to discriminate)
	"test", "tests", "code", "file", "files", "build", "data", "line", "step",
	"note", "here", "case", "cases", "real", "new", "old", "add", "fix",
	"only", "just", "also", "both", "same", "even", "still", "now", "back",
]);

/** Infer a hermes category for entries that lack a `[category]` prefix, so the
 *  ~50% of cards that defaulted to `dimension: general` get a meaningful axis
 *  for retrieval filtering. Conservative (precision over recall): only
 *  reclassifies on a strong content signal, else returns "" → general.
 *  Patterns derived from the study-news corpus (USER.md preferences,
 *  MEMORY.md methodology entries). */
function inferHermesCategory(text: string): string {
	const t = text.toLowerCase();
	// preference: user-facing rules / standing instructions
	if (/\b(prefer|preference|always use|never |hard rule|standing|policy|rule:|一律|偏好|預設|務必|優先)\b/.test(t))
		return "preference";
	// tool-quirk: non-obvious / intermittent / surprising tool behavior
	if (/\b(quirks?|intermittent|flake|flaky|silently|unexpected|behaves?|mask(ed|s)?|false-negative|false-positive|missing|lacks?|cannot|won't|refuses?)\b/.test(t))
		return "tool-quirk";
	// insight: transferable lessons / methodology / proven patterns
	if (/\b(methodology|pattern|proven|lesson|generaliz(?:e|able)|consequence|signal|insight|verify-e2e|method)\b/.test(t))
		return "insight";
	// failure: a bug / hang / crash / regression that was fixed
	if (/\b(fix:|bug|hang|hangs|crash|crashes|fails|failed|broken|error:|regression|infinite loop)\b/.test(t))
		return "failure";
	// convention: a chosen standard / formatting / naming rule
	if (/\b(convention|standard|when generating|naming|format)\b/.test(t))
		return "convention";
	return ""; // genuinely unclassifiable → general
}

/** Extract an atomic, readable title from a hermes entry's first line.
 *  Previously the title was the raw first line truncated at 120 chars — often
 *  mid-word (`...scripts/foo.mjs\` / \`b`). Now: strip markdown + trailing
 *  provenance, then (if long) cut at the first clause boundary (em-dash,
 *  open-paren, colon+space, period+space, CJK punctuation) so the CONCEPT
 *  clause survives, then cap at a word boundary ≤ 80 chars. Short first lines
 *  pass through unchanged (preserves expectations like "Tool quirks"). */
function extractAtomicTitle(firstLine: string): string {
	let t = firstLine
		.replace(/\*\*/g, "")
		.replace(/\s*\(verified[^)]*\)\s*:?\s*$/, "")
		.replace(/\s*\(\d{4}[^)]*\)\s*:?\s*$/, "")
		.replace(/[:：]\s*$/, "")
		.trim();
	// Long line → cut at the first clause boundary, keeping a meaningful prefix.
	if (t.length > 50) {
		const m = t.match(/^(.{12,}?)\s*(?:—|–|\(|:\s|\.\s|[，：。])/);
		if (m && m[1]!.trim().length >= 12) t = m[1]!.trim();
	}
	// Final cap at a word boundary (no mid-word truncation, no ellipsis).
	if (t.length > 80) {
		const cut = t.slice(0, 80);
		const lastSpace = cut.lastIndexOf(" ");
		t = (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim();
	}
	return t;
}

/** Adapt a hermes memory file into an array of `KnowledgeRecord`s — one per
 *  `§`-separated entry. Unlike auto-memory (one fact per FILE), a hermes file
 *  (`~/.pi/agent/pi-hermes-memory/{MEMORY,failures,USER}.md`) holds MANY dense,
 *  human-curated entries separated by a line containing only `§`. Each entry
 *  typically carries a `[category]` prefix and a trailing
 *  `<!-- created=YYYY-MM-DD, last=YYYY-MM-DD -->` provenance comment.
 *
 *  Mapping (mirrors `adaptAutoMemoryMarkdown` where the shapes overlap):
 *    id          = `hermes:<slug>`        (slug from the entry's first line)
 *    type        = HERMES_TYPE[prefix]    (failure→avoid, insight→pattern, …)
 *    title       = first line (prefix + `**` + trailing `:`/date stripped), ≤120 chars
 *    detail      = full entry body (prefix + timestamp comment stripped)
 *    tags        = [hermes, <category>, …[[wikilink]] slugs, …distinctive title keywords]
 *    dimension   = category (or "general")
 *    confidence  = 0.9 (human-curated working memory)
 *    evidence    = { first_seen, last_seen } harvested from the timestamp comment
 *
 *  Defensive: malformed/empty entries are skipped (never throws), mirroring how
 *  `adaptAutoMemoryMarkdown` returns null on bad input. Returns [] if no entry
 *  in the file parses — the caller records a parse error in that case.
 */
export function adaptHermesMarkdown(content: string): KnowledgeRecord[] {
	if (!content || !content.trim()) return [];
	// Entries are separated by "a line containing only §" (per hermes MEMORY.md).
	const rawEntries = content.split(/^§\s*$/m);
	const records: KnowledgeRecord[] = [];
	for (const raw of rawEntries) {
		const entry = raw.trim();
		if (!entry) continue;

		// 1. Category prefix (optional): `[failure]` / `[tool-quirk]` / …
		const prefixMatch = entry.match(
			/^\[(failure|correction|insight|tool-quirk|convention|preference)\]\s*/,
		);
		const prefixCategory = prefixMatch?.[1] ?? "";
		const afterPrefix = prefixMatch ? entry.slice(prefixMatch[0]!.length) : entry;
		// No `[category]` prefix → infer one from content (cuts the ~50% of cards
		// that otherwise defaulted to dimension:"general"). Conservative: empty
		// string (→ general) when no strong signal.
		const category = prefixCategory || inferHermesCategory(afterPrefix);
		const type = category ? (HERMES_TYPE[category] ?? "pattern") : "pattern";

		// 2. Harvest provenance timestamps (may be duplicated; take first created,
		//    last `last`). Strip the comment(s) from the body afterward.
		const createdDates: string[] = [];
		const lastDates: string[] = [];
		// Harvest provenance timestamps. Two forms occur in the wild:
		//   `created=YYYY-MM-DD, last=YYYY-MM-DD` (full) and `created=YYYY-MM-DD`
		//   (created-only — last falls back to created). The old single regex
		//   REQUIRED `last=`, so created-only entries got first_seen="" and
		//   rendered `created: 1970-01-01` downstream (2 cards in study-news).
		const fullRe = /<!--\s*created=([^,\s>]+)[^>]*?last=([^,\s>]+)[^>]*?-->/g;
		const onlyRe = /<!--\s*created=([^,\s>]+?)\s*-->/g;
		let tm: RegExpExecArray | null;
		while ((tm = fullRe.exec(entry)) !== null) {
			const c = extractDate(tm[1]);
			const l = extractDate(tm[2]);
			if (c) createdDates.push(c);
			if (l) lastDates.push(l);
		}
		// created-only comments (no `last=`): last defaults to created.
		if (createdDates.length === 0) {
			while ((tm = onlyRe.exec(entry)) !== null) {
				const c = extractDate(tm[1]);
				if (c) { createdDates.push(c); lastDates.push(c); }
			}
		}
		const firstSeen = createdDates[0] ?? "";
		const lastSeen = lastDates[lastDates.length - 1] ?? firstSeen ?? "";
		const bodyNoTs = afterPrefix.replace(/<!--\s*created=[^>]*?-->/g, "").trim();
		if (!bodyNoTs) continue;

		// 3. Title = atomic concept from the first line. Old behavior truncated
		//    the raw first line at 120 chars (often mid-word). extractAtomicTitle
		//    strips markdown + trailing provenance, then cuts at the first clause
		//    boundary (em-dash / paren / colon / period) so the concept survives.
		const firstLine = bodyNoTs.split(/\r?\n/)[0]!.trim();
		const title = extractAtomicTitle(firstLine) || firstLine.slice(0, 80);
		if (!title) continue;

		// 4. Detail = the full entry body (richest signal for zk_ask full-text).
		//    Strip inline `[[wiki-link]]` brackets → plain link text (same rationale
		//    as adaptAutoMemoryMarkdown: namespaced slugs diverge from raw targets,
		//    so raw links would be dead; shared-TAG edges drive the real graph).
		const detail = stripWikiLinkBrackets(bodyNoTs);

		// 5. Tags: hermes + category + [[wikilink]] slugs + distinctive keywords
		//    harvested from title AND detail (title alone is too sparse). Min
		//    token length lowered 4→3 so semantic short tokens (bun/mlx/vae/cli/
		//    tui) survive; the expanded HERMES_STOP absorbs the 3-4 char filler
		//    (always/never/test/runs) that the old ≥4 gate let through.
		const tagSet = new Set<string>();
		tagSet.add("hermes");
		tagSet.add(category || "note");
		const linkRe = /\[\[([^\]]+)\]\]/g;
		let lm: RegExpExecArray | null;
		while ((lm = linkRe.exec(entry)) !== null) {
			const t = normTag(lm[1]!.split(/[#|]/)[0]!);
			if (t) tagSet.add(t);
		}
		for (const tok of `${title} ${detail}`.toLowerCase().split(/[^a-z0-9-]+/)) {
			if (tok.length >= 3 && !HERMES_STOP.has(tok)) tagSet.add(tok);
		}
		const tags = [...tagSet].slice(0, 8);

		records.push({
			id: `hermes:${slugify(title)}`,
			type,
			title,
			detail,
			tags,
			dimension: category || "general",
			confidence: 0.9,
			status: "active",
			superseded_by: null,
			evidence:
				firstSeen || lastSeen ? { first_seen: firstSeen, last_seen: lastSeen } : undefined,
		});
	}
	return records;
}

// ---------------------------------------------------------------------------
// generic markdown parsing (the universal convergence source)
// ---------------------------------------------------------------------------

/** Callout-type → record-type inference. A `> [!warning]` / `[!danger]`
 *  callout is a cheap deterministic signal that the doc is cautionary (→
 *  avoid); any other callout (tip/info/note) defaults to `pattern`. The first
 *  cautionary callout wins. This is ADDITIVE signal the hermes/auto-memory
 *  adapters lack — generic markdown has no category prefix, so the body's
 *  callouts are the only structural hint we have. */
const CAUTION_CALLOUTS = new Set([
	"warning", "danger", "error", "caution", "bug", "failure", "attention",
]);

/** Adapt ANY `.md` file into a `KnowledgeRecord` — the universal convergence
 *  source. Unlike hermes (many `§` entries per file) and auto-memory (needs
 *  `name`+`description` frontmatter), the generic adapter makes NO assumptions
 *  about the file's shape: frontmatter, H1, tags, and callouts are all
 *  best-effort, with filename/title fallbacks so a valid card is ALWAYS
 *  produced (only a truly empty file returns null). This is what makes
 *  `zk_ingest` accept a random folder of `.md` files and converge them into
 *  the shared knowledge graph.
 *
 *  Mapping (composes the same primitives as the other adapters):
 *    id          = `generic:<slug>`        (slug from H1 or filename)
 *    type        = callout-inferred (caution→avoid) else `reference` (#2056 —
 *                  plain prose is NOT a pattern; keeps the `pattern` tag's
 *                  IDF cross-linking meaningful)
 *    title       = first `# H1`, else filename sans extension (cleaned, ≤120 chars)
 *    detail      = body after frontmatter, `[[wiki-link]]` brackets normalized
 *    tags        = frontmatter `tags` ∪ body `#hashtags` ∪ `[[wikilinks]]` ∪ distinctive H1 tokens
 *    dimension   = frontmatter `type`/`category`/`dimension` (first present), else null
 *    confidence  = 0.7 (machine-adapted, unreviewed — below human-curated sources)
 *    summary     = explicit deterministic L0 abstract from the boilerplate-stripped
 *                  body (#2056 — explicit > on-disk, so re-ingest converges
 *                  cards written by the pre-#2056 adapter)
 *    evidence    = created from frontmatter, else source-file mtime (UTC date)
 *
 *  Returns null ONLY for a file with no title-able content AND no body (truly
 *  empty / whitespace). A frontmatter-less file with any prose still yields a
 *  card, per the "graceful over strict" principle. */
export function adaptGenericMarkdown(
	content: string,
	filePath: string,
): KnowledgeRecord | null {
	if (!content || !content.trim()) return null;

	// 1. Frontmatter (optional). parseFrontmatter returns {data:{}, bodyStart:0}
	//    for a file with no frontmatter, so `body` is the whole file in that case.
	const { data, bodyStart } = parseFrontmatter(content);
	const body = content.split("\n").slice(bodyStart).join("\n").trim();

	// 2. Title = first H1; else filename (no extension, dashes→spaces, title-cased).
	const h1 = body.match(/^#\s+(.+?)\s*$/m);
	let title: string;
	let titleSlugSrc: string;
	if (h1 && h1[1]!.trim()) {
		title = h1[1]!.replace(/\*\*/g, "").trim();
		titleSlugSrc = h1[1]!;
	} else {
		const base = (filePath.split("/").pop() ?? "untitled").replace(/\.md$/i, "");
		title = base
			.replace(/[-_]+/g, " ")
			.replace(/\b\w/g, (c) => c.toUpperCase())
			.trim();
		titleSlugSrc = base;
	}
	title = title.slice(0, 120);
	if (!title) return null;

	// 3. Detail = body with [[wiki-link]] brackets normalized to plain text
	//    (same rationale as the other adapters: namespaced slugs diverge from
	//    raw targets, so raw links would be dead; shared-TAG edges drive the graph).
	const detail = body ? stripWikiLinkBrackets(body) : body;

	// 4. Tags: frontmatter tags ∪ body #hashtags ∪ [[wikilinks]] ∪ distinctive
	//    H1 tokens (mirrors the hermes/auto-memory harvest).
	const tagSet = new Set<string>();
	tagSet.add("generic");
	const fmTags = data.tags;
	if (Array.isArray(fmTags)) {
		for (const t of fmTags) {
			const n = normTag(String(t));
			if (n) tagSet.add(n);
		}
	} else if (typeof fmTags === "string") {
		for (const t of String(fmTags).split(/[, ]+/)) {
			const n = normTag(t);
			if (n) tagSet.add(n);
		}
	}
	const linkRe = /\[\[([^\]]+)\]\]/g;
	const hashRe = /(^|[^\w/])#([a-z0-9][\w-]*)/gi;
	let m: RegExpExecArray | null;
	for (const line of content.split("\n")) {
		linkRe.lastIndex = 0;
		while ((m = linkRe.exec(line)) !== null) {
			const t = normTag(m[1]!.split(/[#|]/)[0]!);
			if (t) tagSet.add(t);
		}
		hashRe.lastIndex = 0;
		while ((m = hashRe.exec(line)) !== null) {
			const t = normTag(m[2]!);
			if (t) tagSet.add(t);
		}
	}
	for (const tok of titleSlugSrc.toLowerCase().split(/[^a-z0-9-]+/)) {
		if (tok.length >= 4 && !HERMES_STOP.has(tok)) tagSet.add(tok);
	}
	const tags = [...tagSet].slice(0, 10);

	// 5. Type: infer from callouts (caution → avoid), else `reference` (#2056
	//    symptom 2). Plain prose pages are NOT patterns — stamping every
	//    frontmatter-less page `pattern` (839 file2md cards did) pollutes the
	//    `pattern` tag's IDF cross-linking (P8 demotes a tag on everything).
	//    `reference` is the neutral prose-page type; a cautionary callout is
	//    still the one deterministic avoid-signal.
	const feats = extractFeatures(detail);
	const type = feats.calloutTypes.some((c) => CAUTION_CALLOUTS.has(c)) ? "avoid" : "reference";

	// 6. Dimension: frontmatter type/category/dimension (first present), else null.
	const dimensionRaw = data.type ?? data.category ?? data.dimension;
	const dimension =
		typeof dimensionRaw === "string" && dimensionRaw.trim()
			? normTag(dimensionRaw)
			: null;

	// 7. Provenance: created date from frontmatter (created/date); fallback =
	//    the source file's mtime (#2056 symptom 1 — frontmatter-less pages
	//    otherwise stamp `created: 1970-01-01` downstream). statSync is wrapped:
	//    a non-existent path (unit tests pass fake paths) keeps `undefined`.
	//    mtime is formatted in UTC (toISOString) — matches the ingest path's
	//    UTC "today" stamps, and keeps the date TZ-independent (review finding 2).
	let created = extractDate(
		typeof data.created === "string" ? data.created : undefined,
		typeof data.date === "string" ? data.date : undefined,
	);
	if (!created) {
		try {
			created = statSync(filePath).mtime.toISOString().slice(0, 10);
		} catch {
			// no file behind the path (test fixtures) — leave undefined
		}
	}

	// 8. Explicit summary (#2056 symptom 3): the adapter states its own L0
	//    abstract from the boilerplate-stripped body. This is REQUIRED for
	//    re-ingest convergence, not just first ingest: ingest's summary
	//    precedence is explicit rec.summary > the EXISTING card's on-disk
	//    summary > deterministic derivation — an adapter that left summary
	//    unset would preserve the polluted on-disk abstracts forever. The
	//    deterministic sentence therefore both anchors new cards and
	//    converges old ones. Trade-off: generic records never take the
	//    opt-in LLM-condense path (explicit summary always present).
	const summary = firstSentenceSummary(detail || title) || undefined;

	return {
		id: `generic:${slugify(titleSlugSrc)}`,
		type,
		title,
		detail: detail || title,
		tags,
		dimension,
		confidence: 0.7,
		status: "active",
		superseded_by: null,
		summary,
		evidence: created ? { first_seen: created, last_seen: created } : undefined,
	};
}

// ---------------------------------------------------------------------------
// .knowledge.jsonl parsing
// ---------------------------------------------------------------------------

/** Parse newline-delimited JSON records. Blank lines and comments (#) ignored.
 *  Returns well-formed records plus per-line parse errors (never throws). */
export function parseKnowledgeJsonl(content: string): {
	records: KnowledgeRecord[];
	parseErrors: { line: number; reason: string }[];
} {
	const records: KnowledgeRecord[] = [];
	const parseErrors: { line: number; reason: string }[] = [];
	const lines = content.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]!.trim();
		if (raw === "" || raw.startsWith("#")) continue;
		let obj: unknown;
		try {
			obj = JSON.parse(raw);
		} catch (e) {
			parseErrors.push({ line: i + 1, reason: `JSON parse: ${(e as Error).message}` });
			continue;
		}
		const rec = obj as Partial<KnowledgeRecord>;
		if (typeof rec.id !== "string" || rec.id === "") {
			parseErrors.push({ line: i + 1, reason: "missing/empty `id`" });
			continue;
		}
		if (typeof rec.title !== "string" || rec.title === "") {
			parseErrors.push({ line: i + 1, reason: `missing/empty \`title\` (id=${rec.id})` });
			continue;
		}
		// Coerce + default optional fields so downstream never sees undefined.
		records.push({
			id: rec.id,
			type: typeof rec.type === "string" ? rec.type : "pattern",
			title: rec.title,
			detail: typeof rec.detail === "string" ? rec.detail : "",
			tags: Array.isArray(rec.tags) ? rec.tags.map(String) : [],
			dimension: rec.dimension ?? null,
			confidence: typeof rec.confidence === "number" ? rec.confidence : 0,
			status: typeof rec.status === "string" ? rec.status : "active",
			superseded_by: rec.superseded_by ?? null,
			entities: Array.isArray(rec.entities)
				? (rec.entities as unknown[]).filter(
						(e): e is ExtractedEntity =>
							typeof e === "object" && e !== null &&
							typeof (e as Record<string, unknown>).type === "string" &&
							typeof (e as Record<string, unknown>).name === "string",
					)
				: undefined,
			schema_version: rec.schema_version,
			evidence: rec.evidence,
			extracted_at: rec.extracted_at,
		});
	}
	return { records, parseErrors };
}

export function extractDate(...candidates: (string | undefined | null)[]): string {
	for (const c of candidates) {
		if (!c) continue;
		const m = c.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})/);
		if (m) {
			const [, y, mo, d] = m;
			return `${y}-${mo}-${d}`;
		}
	}
	return "";
}

