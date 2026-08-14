/**
 * src/ingest.ts — deterministic knowledge-graph convergence primitive.
 *
 * The pi-knowledge-card tools (zk_card / zk_ask) are LLM-subagent
 * coordinators: they decompose free-form markdown into atomic zettels. That is
 * the right tool for UNSTRUCTURED text, but the self-improve loops already
 * produce STRUCTURED knowledge — `.claude/workflows/*.knowledge.jsonl` records
 * with a fixed 12-key schema (id/type/title/detail/tags/dimension/confidence/
 * status/superseded_by/evidence/...). Routing those through an LLM subagent
 * would be lossy, non-deterministic, and would re-introduce exactly the
 * "siloed per-workflow" fragmentation this module exists to dissolve.
 *
 * zk_ingest is the deterministic counterpart: it maps each structured record
 * 1:1 onto a canonical zettel card in ONE shared vault folder, dedup'd by the
 * record's stable id, cross-linked by shared tags, and indexed by a MOC. The
 * graph then spans every source (workflow-jsonl today; hermes + auto-memory
 * later) because every converged card lives in the same folder and shares the
 * same tag space — a flux2 gotcha and a krea2 gotcha with overlapping tags get
 * a `[[...]]` edge, and `zk_ask` (graph-enhanced RAG over the whole vault)
 * answers cross-source questions for free.
 *
 * Canonical card schema (frontmatter; validateZettelNote requires id/created/
 * tags with tags[0]=="zettel" and does NOT reject extra keys, so the lifecycle
 * + provenance fields ride along as extended frontmatter):
 *
 *   ---
 *   id: <record.id>                 # stable canonical key (namespaced, e.g. ltx:cfg-scale-7-lever)
 *   created: YYYY-MM-DD             # best-effort from evidence.first_seen / extracted_at
 *   tags: [zettel, <record.type>, ...record.tags, ...dimension parts]
 *   sources: [<provenance>]
 *   source: workflow-jsonl          # source family
 *   source_id: <record.id>          # dedup key (== id; kept explicit for scanners)
 *   record_type: lever              # lever|avoid|pattern|gotcha|metric|false_positive
 *   status: active                  # active|superseded|retired
 *   superseded_by: <id|null>
 *   confidence: 0.93
 *   dimension: <string|null>
 *   ---
 *
 * Library only — no ExtensionAPI, no LLM, no network. The extension tool
 * (zk_ingest) and the `pi-agent cli` subcommand (zk-ingest) are thin shells
 * over `ingestRecords`.
 *
 * Env (passed through from pi-obsidian): OB_VAULT_PATH / OB_VAULT_DIR.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
	parseFrontmatter,
	validateZettelNote,
	ZETTEL_MAX_BYTES,
	type VaultIndex,
} from "@repo/pi-agent-ext-obsidian/extensions/obsidian.ts";
import { tokeniseText, bestMatch } from "./similarity.ts";
import {
	computeIdf,
	scoreOverlap,
	type ExtractedEntity,
	type LinkWeighting,
} from "./entities.ts";
import { resolveExtractor, type Extractor, type Relation } from "./extractor.ts";

/**
 * Replace Obsidian wiki-links (`[[target|alias]]`, `[[target#anchor]]`,
 * `[[target]]`) with their display text: alias wins, else the target (anchor
 * stripped), else the raw inner text. Shared by the three markdown adapters.
 */
export function stripWikiLinkBrackets(content: string): string {
	return content.replace(/\[\[([^\]]+)\]\]/g, (_full, inner: string) => {
		const parts = String(inner).split("|");
		const target = parts[0]!.split("#")[0]!.trim();
		const alias = parts[1]?.trim();
		return alias || target || String(inner);
	});
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A structured knowledge record (the .knowledge.jsonl 12-key schema). Fields
 *  beyond the canonical 12 are tolerated and preserved in evidence only. */
export interface KnowledgeRecord {
	id: string;
	type: string; // lever | avoid | pattern | gotcha | metric | false_positive
	title: string;
	detail: string;
	tags: string[];
	dimension: string | null;
	confidence: number;
	status: string; // active | superseded | retired
	superseded_by: string | null;
	/** Pre-extracted typed entities (SAG-style). If absent, entities are
	 *  derived deterministically from `detail` via `extractEntities` when
	 *  `linkWeighting === "idf"` (additive frontmatter; absent otherwise). */
	entities?: ExtractedEntity[];
	schema_version?: number;
	evidence?: {
		occurrences?: number;
		first_seen?: string;
		last_seen?: string;
		run_ids?: string[];
		extracted_at?: string;
	};
	extracted_at?: string;
}

export type SourceFamily = "workflow-jsonl" | "hermes" | "auto-memory" | "generic";

export interface IngestOptions {
	/** Absolute vault path (the convergence sink — single shared vault). */
	vaultPath: string;
	/** Source family; becomes the `source` frontmatter key. */
	source: SourceFamily;
	/** Human-readable provenance, e.g. "workflow-jsonl:mlx-...-ltx". */
	sourceLabel: string;
	/** Convergence folder inside the vault (default: Zettelkasten/knowledge-graph). */
	folder?: string;
	/** MOC note path, vault-relative (default: Tags/Knowledge Graph.md). */
	mocPath?: string;
	/** Don't write anything; just report what would happen. */
	dryRun?: boolean;
	/** Max cross-link neighbours per card (default 8). */
	maxLinks?: number;
	/** Max detail length in chars before truncation (keeps the note < 64KB). */
	maxDetailChars?: number;
	/** When true, match each incoming record against EXISTING cards in the
	 *  folder (token-set Jaccard over title + detail). A match at or above
	 *  `wikiThreshold` UPSERTS into the existing canonical card (appends
	 *  evidence + bumps last_seen) instead of minting a parallel duplicate.
	 *  This is the wiki-aware convergence that keeps 10+ id namespaces from
	 *  growing parallel cards for the same lesson. */
	wikiAware?: boolean;
	/** Cross-link neighbour ranking weight. SAG-inspired (see src/entities.ts):
	 *  - "count" (default, the pinned iter-7 baseline): raw shared-tag count.
	 *  - "idf": Σ IDF(sharedTag) — rare specific bridges (pi-obsidian) outrank
	 *    ubiquitous type-tags (pattern). ADDITIVE + OPT-IN; the default preserves
	 *    the measured lexical+graph ranking so no retrieval regression ships
	 *    without its own measurement run (kg-improvement-plan P8).
	 *
	 *  When "idf", also extract typed entities from each card's detail body and
	 *  store them as additive `entities: [{type,name}]` frontmatter — the
	 *  SAG entity-event signal, deterministic (no LLM). */
	linkWeighting?: LinkWeighting;
	/** Minimum token-set Jaccard similarity to treat an incoming record as a
	 *  reuse of an existing card (default 0.85 — deliberately HIGH, one notch
	 *  below the 0.9 duplicate-merge bar, so a bad reuse never collapses two
	 *  merely-related ideas). */
	wikiThreshold?: number;
	/** Opt-in LLM typed-relation extraction (LeanRAG ⑤ Phase-2 / D4). Default
	 *  OFF (deterministic-by-design, ADR-0001). When true, the ingest gate
	 *  selects the LLM extractor (Phase-2) instead of the dictionary default;
	 *  until Phase-2 the flag is real + wired but turning it ON is a graceful
	 *  no-op (dictionary fallback). Env fallback `PI_KG_LLM=1`. */
	kgLlm?: boolean;
	/** Chat model id for the kg.llm extractor (Phase-2 T2). Threaded to
	 *  `resolveExtractor` as the `LlmRelationExtractor` model override; env
	 *  fallback `PI_KG_LLM_MODEL` (zk default "google/gemma-4-12b-qat"). */
	kgLlmModel?: string;
	/** @internal Test seam: overrides the resolved extractor so tests can
	 *  inject an `LlmRelationExtractor` with a canned `_fetchImpl` (no live
	 *  LM Studio). Production callers leave this unset — the effective
	 *  extractor is `resolveExtractor(kgLlm, …)` (Phase-2 T3). */
	_extractor?: Extractor;
}

export type CardOutcome = "created" | "updated" | "unchanged";

export interface IngestCardReport {
	id: string;
	path: string; // vault-relative
	status: CardOutcome;
	links: number;
}

export interface IngestSummary {
	source: SourceFamily;
	sourceLabel: string;
	total: number;
	created: number;
	updated: number;
	unchanged: number;
	skipped: number; // malformed records
	linked: number; // total cross-link edges written
	wikiMerged: number; // records wiki-aware-merged into an existing canonical card
	mocUpdated: boolean;
	vaultPath: string;
	folder: string;
	cards: IngestCardReport[];
	parseErrors: { line: number; reason: string }[];
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
 *    type        = callout-inferred (caution→avoid) else `pattern`
 *    title       = first `# H1`, else filename sans extension (cleaned, ≤120 chars)
 *    detail      = body after frontmatter, `[[wiki-link]]` brackets normalized
 *    tags        = frontmatter `tags` ∪ body `#hashtags` ∪ `[[wikilinks]]` ∪ distinctive H1 tokens
 *    dimension   = frontmatter `type`/`category`/`dimension` (first present), else null
 *    confidence  = 0.7 (machine-adapted, unreviewed — below human-curated sources)
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

	// 5. Type: infer from callouts (caution → avoid), else pattern.
	const feats = extractFeatures(detail);
	const type = feats.calloutTypes.some((c) => CAUTION_CALLOUTS.has(c)) ? "avoid" : "pattern";

	// 6. Dimension: frontmatter type/category/dimension (first present), else null.
	const dimensionRaw = data.type ?? data.category ?? data.dimension;
	const dimension =
		typeof dimensionRaw === "string" && dimensionRaw.trim()
			? normTag(dimensionRaw)
			: null;

	// 7. Provenance: created date from frontmatter (created/date), else undefined.
	const created = extractDate(
		typeof data.created === "string" ? data.created : undefined,
		typeof data.date === "string" ? data.date : undefined,
	);

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
		evidence: created ? { first_seen: created, last_seen: created } : undefined,
	};
}

// ---------------------------------------------------------------------------
// Obsidian feature extraction (callouts / tasks / embeds / code density)
// ---------------------------------------------------------------------------

/** Structured Obsidian feature metadata detected in a card body.
 *
 *  All keys are ADDITIVE: a feature-less body yields an empty result and the
 *  card frontmatter gains nothing (byte-identical to pre-feature ingest), so
 *  old cards validate + retrieve unchanged. Only the callout fields carry a
 *  retrieval LEVER (ranking boost + context surfacing); tasks/embeds/code are
 *  recorded as filter flags but are not ranked (deferred until a harness says
 *  they help — kg-improvement-plan P1). */
export interface MarkdownFeatures {
	/** True iff at least one `> [!type]` callout block is present. */
	hasCallouts: boolean;
	/** Lowercased callout types, in source order (e.g. ["warning", "tip"]). */
	calloutTypes: string[];
	/** Headline text per callout (`[!type] headline`), lifted into the digest. */
	calloutTexts: string[];
	/** True iff any `- [ ]` or `- [x]` task line is present. */
	hasTasks: boolean;
	/** Count of open tasks (`- [ ]`). */
	openTaskCount: number;
	/** Count of closed tasks (`- [x]`). */
	closedTaskCount: number;
	/** Count of `![[...]]` embeds (image/note), NOT plain `[[...]]` links. */
	embedCount: number;
	/** Number of fenced code blocks (``` / ~~~). */
	codeBlockCount: number;
	/** Total lines inside fenced code blocks (density proxy). */
	codeBlockLines: number;
}

function emptyFeatures(): MarkdownFeatures {
	return {
		hasCallouts: false,
		calloutTypes: [],
		calloutTexts: [],
		hasTasks: false,
		openTaskCount: 0,
		closedTaskCount: 0,
		embedCount: 0,
		codeBlockCount: 0,
		codeBlockLines: 0,
	};
}

/** Detect Obsidian structured features in a markdown body. Callouts (`>
 *  [!type]`), tasks (`- [ ]` / `- [x]`), embeds (`![[...]]`), and fenced-code
 *  density are counted. Tasks/embeds inside code fences are NOT counted
 *  (they are code, not prose). Returns an empty result for empty input. */
export function extractFeatures(body: string): MarkdownFeatures {
	if (!body || !body.trim()) return emptyFeatures();
	const lines = body.split(/\r?\n/);
	const f = emptyFeatures();

	// 1. Callouts — a `> [!type]` line starts a block; the headline is the text
	//    after `]` on that line, falling back to the first `>` continuation.
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const m = line.match(/^>\s*\[!(\w+)\]\s*(.*)$/);
		if (!m) continue;
		const type = m[1]!.toLowerCase();
		f.calloutTypes.push(type);
		let headline = (m[2] ?? "").trim();
		if (!headline) {
			const next = lines[i + 1];
			if (next) {
				const nm = next.match(/^>\s?(.*)$/);
				if (nm) headline = nm[1]!.trim();
			}
		}
		f.calloutTexts.push(headline ? `[!${type}] ${headline}` : `[!${type}]`);
	}
	f.hasCallouts = f.calloutTypes.length > 0;

	// 2. Tasks / embeds / code density — single pass, code-fence aware.
	let inCode = false;
	for (const line of lines) {
		if (/^(\s*)```|^\s*~~~/.test(line)) {
			if (inCode) {
				f.codeBlockLines++;
				inCode = false;
			} else {
				inCode = true;
				f.codeBlockCount++;
			}
			continue;
		}
		if (inCode) {
			f.codeBlockLines++;
			continue;
		}
		if (/^[-*]\s+\[\s\]/.test(line)) f.openTaskCount++;
		else if (/^[-*]\s+\[[xX]\]/.test(line)) f.closedTaskCount++;
		// Embeds: `![[...]]` only (plain `[[...]]` wiki-links are NOT embeds).
		for (const _ of line.matchAll(/!\[\[([^\]]+)\]\]/g)) f.embedCount++;
	}
	f.hasTasks = f.openTaskCount + f.closedTaskCount > 0;
	return f;
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Slugify a record id into a filename-safe basename (keeps the namespace
 *  prefix legible: "ltx:cfg-scale-7-lever" -> "ltx-cfg-scale-7-lever"). */
export function slugify(id: string): string {
	return id
		.trim()
		.replace(/[:/\\]+/g, "-") // namespace + path separators
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase()
		.slice(0, 80) || "untitled";
}

/** Best-effort extraction of a YYYY-MM-DD from the heterogeneous timestamp
 *  formats the workflows emit (`20260620_091118`, `2026-06-14T22-47-40`,
 *  ISO `2026-06-23T22:34:02Z`). Returns "" if nothing parses. */
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

/** Normalise a tag for cross-link matching (lowercase, trimmed, spaces->-). */
export function normTag(t: string): string {
	return t.trim().toLowerCase().replace(/\s+/g, "-");
}

/** Compute the tag set used for linking + indexing a record. tags[0] is always
 *  "zettel" (validateZettelNote contract); then record type, the record's own
 *  tags, and dimension parts — all normalised, dedup'd, preserving order. */
function cardTags(rec: KnowledgeRecord): string[] {
	const out: string[] = ["zettel", normTag(rec.type)];
	for (const t of rec.tags) {
		const n = normTag(t);
		if (n && !out.includes(n)) out.push(n);
	}
	if (rec.dimension) {
		for (const part of rec.dimension.split(/[./]+/)) {
			const n = normTag(part);
			if (n && !out.includes(n)) out.push(n);
		}
	}
	return out;
}

/** Render a zettel card body for a record, with `## 連結` placeholder lines
 *  filled from `links`. The links arg is a list of display targets (already
 *  resolved note basenames or `Tags/...#anchor`). */
function renderCard(
	rec: KnowledgeRecord,
	created: string,
	tags: string[],
	links: string[],
	sourceLabel: string,
	maxDetailChars: number,
	entities?: ExtractedEntity[],
	relations?: Relation[],
): string {
	const detail = rec.detail.length > maxDetailChars
		? rec.detail.slice(0, maxDetailChars) + "\n\n…(truncated)"
		: rec.detail;
	const ev = rec.evidence ?? {};
	const fm: Record<string, unknown> = {
		id: rec.id,
		created,
		tags,
		sources: [sourceLabel],
		source: sourceLabel,
		source_id: rec.id,
		record_type: rec.type,
		status: rec.status,
		superseded_by: rec.superseded_by ?? "",
		confidence: rec.confidence,
	};
	if (rec.dimension !== null) fm.dimension = rec.dimension;

	// Feature metadata (kg-improvement-plan P1): detect Obsidian callouts /
	// tasks / embeds / code density in the body that becomes 核心想法, and
	// carry them as ADDITIVE frontmatter keys. Written ONLY where the source
	// body has the feature, so feature-less records stay byte-identical to
	// pre-feature ingest (old cards validate + retrieve unchanged). Only the
	// callout fields carry a retrieval lever (ranking boost + context
	// surfacing); tasks/embeds/code are filter flags, not ranked.
	const feats = extractFeatures(detail);
	if (feats.hasCallouts) {
		fm.has_callouts = true;
		fm.callout_types = feats.calloutTypes;
	}
	if (feats.hasTasks) {
		fm.has_tasks = true;
		fm.open_task_count = feats.openTaskCount;
	}
	if (feats.embedCount > 0) fm.embed_count = feats.embedCount;
	if (feats.codeBlockLines > 0) fm.code_block_lines = feats.codeBlockLines;

	// Typed entities (SAG-inspired, kg-improvement-plan P8): when present
	// (linkWeighting:"idf" extracts them deterministically, or the source
	// JSONL supplied them pre-typed), carry them as ADDITIVE frontmatter so
	// retrieve.ts can use them as a cross-link / retrieval signal. Rendered as
	// quoted "type:name" strings (flat-YAML safe; yamlScalar quotes the colon).
	if (entities && entities.length > 0) {
		fm.entities = entities.map((e) => `${e.type}:${e.name}`);
	}

	// Relations (Phase-2 T3): emitted ONLY when the kg.llm LLM extractor
	// returned edges (write authority — the dictionary path passes undefined /,
	// from the fallback, []). The nested block is spliced into the frontmatter
	// AFTER `entities:` when present (sibling emission order), else at the end
	// of the fence. The block format is the shared cross-package contract:
	// zk `parseRelationsBlock` (retrieve.ts) and hermes
	// `KnowledgeSerializer.deserialize` both parse this exact shape.
	let fmText = renderFrontmatter(fm);
	if (relations && relations.length > 0) {
		fmText = spliceRelations(fmText, renderRelationsBlock(relations));
	}

	const evidenceLines = [
		`- type: ${rec.type}`,
		`- confidence: ${rec.confidence}`,
		`- status: ${rec.status}${rec.superseded_by ? ` → superseded_by ${rec.superseded_by}` : ""}`,
	];
	if (typeof ev.occurrences === "number") evidenceLines.push(`- occurrences: ${ev.occurrences}`);
	if (ev.first_seen) evidenceLines.push(`- first_seen: ${ev.first_seen}`);
	if (ev.last_seen) evidenceLines.push(`- last_seen: ${ev.last_seen}`);
	if (rec.extracted_at) evidenceLines.push(`- extracted_at: ${rec.extracted_at}`);
	evidenceLines.push(`- provenance: ${sourceLabel}`);

	const linkLines =
		links.length > 0
			? links.map((l) => `- 相關：[[${l}]]`)
			: ["- (no shared-tag neighbours yet)"];

	return `${fmText}# ${rec.title}

## 核心想法
${detail || "—"}

## 證據 / 脈絡
${evidenceLines.join("\n")}

## 連結
${linkLines.join("\n")}
`;
}

/** Minimal YAML frontmatter renderer for the flat scalar/list values we emit.
 *  We do not pull in a YAML dep: every value here is a string/number or a
 *  string[] (flow form `[a, b]`). */
function renderFrontmatter(data: Record<string, unknown>): string {
	const lines: string[] = ["---"];
	for (const [k, v] of Object.entries(data)) {
		if (v == null || v === "") {
			lines.push(`${k}: `);
		} else if (Array.isArray(v)) {
			const items = v.map((x) => yamlScalar(x));
			lines.push(`${k}: [${items.join(", ")}]`);
		} else if (typeof v === "number") {
			lines.push(`${k}: ${v}`);
		} else {
			lines.push(`${k}: ${yamlScalar(v)}`);
		}
	}
	lines.push("---", "");
	return lines.join("\n");
}

function yamlScalar(v: unknown): string {
	const s = String(v);
	// Quote if it contains chars that would confuse parseFrontmatter's scalar
	// stripper (colon, bracket, leading quote, etc).
	if (/[:\[\]#"']/.test(s) || s.includes(", ")) return JSON.stringify(s);
	return s;
}

/** Render the nested `relations:` frontmatter block (Phase-2 T3 — the LLM
 *  write-authority path). Focused emitter: a YAML block sequence of `{s, rel,
 *  o}` mappings whose exact byte shape is the shared cross-package contract:
 *
 *   relations:
 *     - s: a
 *       rel: references
 *       o: b
 *
 * Both readers parse this: zk's `parseRelationsBlock` (retrieve.ts — walks the
 * indented `- ` entries + their kv continuation lines, stripping a defensive
 * surrounding quote pair) and hermes's `KnowledgeSerializer.deserialize`
 * (`splitFencedYaml` → real YAML parse, canonicalizing `rel` on read). Values
 * reuse `yamlScalar` quoting so `:`-bearing / bracket-bearing ids stay
 * YAML-safe for both readers. NOT routed through `renderFrontmatter` — that
 * layer emits flat scalars/flow-lists only; relations need nesting. */
function renderRelationsBlock(relations: Relation[]): string {
	const lines: string[] = ["relations:"];
	for (const r of relations) {
		// Belt-and-braces: skip malformed entries whose s/rel/o are empty after
		// trim (normalizers upstream usually prevent this, but a blank scalar
		// here would corrupt the YAML block shape).
		if (!r.s.trim() || !r.rel.trim() || !r.o.trim()) continue;
		lines.push(`  - s: ${yamlScalar(r.s)}`);
		lines.push(`    rel: ${yamlScalar(r.rel)}`);
		lines.push(`    o: ${yamlScalar(r.o)}`);
	}
	return lines.join("\n");
}

/** Splice a rendered `relations:` block into an already-rendered frontmatter
 *  fence (the `---\n…\n---\n` string `renderFrontmatter` returns), after the
 *  top-level `entities:` line when present, else just before the closing
 *  fence. Returns the input unchanged when no insertion point exists. */
function spliceRelations(fmText: string, block: string): string {
	const lines = fmText.split("\n");
	// Last top-level `entities:` line inside the fence (entities is emitted
	// last by renderCard's key order, so end-of-fence == after entities in
	// practice; the explicit scan keeps the contract if key order ever shifts).
	let insertAt = -1;
	for (let k = lines.length - 1; k >= 0; k--) {
		if (/^entities:/.test(lines[k]!)) { insertAt = k + 1; break; }
	}
	if (insertAt === -1) {
		for (let k = lines.length - 1; k >= 0; k--) {
			if (lines[k]!.trim() === "---") { insertAt = k; break; }
		}
	}
	if (insertAt === -1) return fmText;
	lines.splice(insertAt, 0, block);
	return lines.join("\n");
}

/** Read a card file's frontmatter tags (normalised) + source_id + feature
 *  flags, for link computation, collision detection, and feature-aware
 *  retrieval ranking. Returns null if not a valid card. Feature keys are
 *  ADDITIVE (old cards just lack them → hasCallouts:false, backward-compatible). */
export function readCardMeta(absPath: string): {
	tags: Set<string>;
	source_id?: string;
	source?: string;
	hasCallouts: boolean;
	calloutTypes: string[];
} | null {
	try {
		const content = readFileSync(absPath, "utf8");
		const { data } = parseFrontmatter(content);
		if (!data || !Array.isArray(data.tags)) return null;
		const tags = new Set(
			(data.tags as unknown[]).map((t) => normTag(String(t))),
		);
		const hasCallouts = data.has_callouts === true;
		const calloutTypes = Array.isArray(data.callout_types)
			? (data.callout_types as unknown[]).map((t) => String(t).toLowerCase())
			: [];
		return {
			tags,
			source_id: typeof data.source_id === "string" ? data.source_id : undefined,
			source: typeof data.source === "string" ? data.source : undefined,
			hasCallouts,
			calloutTypes,
		};
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// MOC
// ---------------------------------------------------------------------------

/** Build (or rebuild) a MOC grouping every card in the folder by record_type
 *  then by tag. Fully deterministic — regenerated from the on-disk cards each
 *  run, so it never drifts. */
export function writeMoc(
	vaultPath: string,
	mocRel: string,
	cardsAbs: string[],
	dryRun: boolean,
): boolean {
	const groups = new Map<string, string[]>(); // group-key -> list of card names
	for (const abs of cardsAbs) {
		const meta = readCardMeta(abs);
		if (!meta) continue;
		const base = abs.slice(abs.lastIndexOf("/") + 1, -3); // strip ".md"
		// Group by the type tag if present (tags[1]); else "other".
		let type = "other";
		const typeTag = [...meta.tags][1];
		if (typeTag && typeTag !== "zettel") type = typeTag;
		if (!groups.has(type)) groups.set(type, []);
		groups.get(type)!.push(base);
	}
	for (const list of groups.values()) list.sort();

	const order = ["gotcha", "avoid", "lever", "pattern", "metric", "false_positive", "other"];
	const present = order.filter((g) => groups.has(g)).concat(
		[...groups.keys()].filter((g) => !order.includes(g)).sort(),
	);
	const lines: string[] = [
		"---",
		"id: knowledge-graph-moc",
		'created: "auto"',
		"tags: [zettel, moc, knowledge-graph]",
		"---",
		"",
		"# Knowledge Graph — Converged Cards MOC",
		"",
		"> Auto-generated by `zk_ingest`. Do not edit by hand — regenerate with a re-ingest.",
		"> One card per structured knowledge record, dedup'd by canonical id, cross-linked by shared tags.",
		"",
	];
	for (const g of present) {
		lines.push(`## ${g}`);
		lines.push("");
		for (const name of groups.get(g)!) lines.push(`- [[${name}]]`);
		lines.push("");
	}
	const content = lines.join("\n");
	const mocAbs = join(vaultPath, mocRel);
	if (dryRun) return true;
	mkdirSync(dirname(mocAbs), { recursive: true });
	writeFileSync(mocAbs, content, "utf8");
	return true;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Ingest a batch of structured records into the shared vault as zettel cards.
 *
 * Dedup: canonical key is `record.id`. The card filename is `slug(id).md` under
 * the convergence folder, so a re-ingest of the same record upserts in place
 * (created vs updated vs unchanged decided by content hash). Cross-links are
 * computed across ALL cards in the folder — so a card from a prior source
 * (e.g. hermes) links to today's workflow-jsonl card when they share a tag.
 *
 * Wiki-aware convergence (opts.wikiAware): before minting a new card, each
 * incoming record is matched against EXISTING cards in the folder (token-set
 * Jaccard over title + detail). A match at or above `wikiThreshold` UPSERTS
 * into the existing canonical card (append evidence + bump last_seen) instead
 * of creating a parallel duplicate — the Alluvium "add to the existing page"
 * pattern. Canonical-id policy: FIRST-WINS — the existing card keeps its id;
 * later sources upsert evidence into it.
 */

// ---------------------------------------------------------------------------
// Wiki-aware merge helpers
// ---------------------------------------------------------------------------

/** Tokenise a card FILE's title + 核心想法 body for wiki-aware matching.
 *  Mirrors merge.ts's tokeniseCard so the duplicate scanner and the ingest
 *  matcher agree on token sets. */
function tokeniseCardFile(content: string): Set<string> {
	const titleMatch = content.match(/^#\s+(.+?)\s*$/m);
	const title = titleMatch ? titleMatch[1]! : "";
	const bodyMatch = content.match(/## 核心想法\n([\s\S]*?)(?=\n## )/);
	const body = bodyMatch ? bodyMatch[1]! : "";
	return tokeniseText(`${title} ${body}`);
}

/** Surgical in-place merge of a wiki-matched record into an EXISTING canonical
 *  card. Appends the new source's evidence + bumps last_seen WITHOUT replacing
 *  the canonical card's title/body/links (first-wins policy). Returns the card
 *  outcome: "updated" if content changed, "unchanged" if already merged. */
function wikiMergeIntoCard(
	abs: string,
	rec: KnowledgeRecord,
	sourceLabel: string,
	similarity: number,
	today: string,
	dryRun: boolean,
): CardOutcome {
	const original = readFileSync(abs, "utf8");
	let next = original;
	let changed = false;

	// 1. Add sourceLabel to the `sources` frontmatter array if not present.
	const sourcesRe = /^(sources:\s*\[)([^\]]*)(\])/m;
	const sm = next.match(sourcesRe);
	if (sm) {
		const items = sm[2]!.split(",").map((s) => s.trim()).filter(Boolean);
		if (!items.includes(sourceLabel)) {
			items.push(sourceLabel);
			next = next.replace(sourcesRe, `${sm[1]}${items.join(", ")}${sm[3]}`);
			changed = true;
		}
	}

	// 2. Append a wiki-merge provenance line to the 證據 / 脈絡 section.
	const mergeLine = `- wiki-merged: ${sourceLabel} (sim=${similarity.toFixed(3)}, ${today})`;
	if (!next.includes(mergeLine)) {
		const secHdr = "## 證據 / 脈絡";
		const secStart = next.indexOf(secHdr);
		if (secStart >= 0) {
			const bodyStart = secStart + secHdr.length;
			const nextSec = next.indexOf("\n## ", bodyStart);
			const secEnd = nextSec < 0 ? next.length : nextSec;
			const before = next.slice(0, secEnd).replace(/\n+$/, "");
			const tail = next.slice(secEnd);
			next = `${before}\n${mergeLine}\n${tail}`;
			changed = true;
		}
	}

	// 3. Bump last_seen to today (if a last_seen evidence line exists).
	const lsRe = /^(- last_seen:\s*).*$/m;
	if (lsRe.test(next)) {
		const bumped = next.replace(lsRe, `$1${today}`);
		if (bumped !== next) {
			next = bumped;
			changed = true;
		}
	}

	if (!changed) return "unchanged";
	if (!dryRun) writeFileSync(abs, next, "utf8");
	return "updated";
}

// ---------------------------------------------------------------------------
// coverageReport — dry-run per-family convergence id-diff (no writes, no LLM)
// ---------------------------------------------------------------------------

export interface CoverageByFamily {
	expected: number;
	vault: number;
	matched: number;
	missing: string[];
	sourceOrphaned: string[];
}

export interface CoverageReport {
	expected: number;
	vault: number;
	matched: number;
	missing: string[];
	sourceOrphaned: string[];
	byFamily: Record<string, CoverageByFamily>;
}

/** A source family + the already-parsed records expected to have converged.
 *  The caller parses via the REAL adapters (parseKnowledgeJsonl /
 *  adaptAutoMemoryMarkdown / adaptHermesMarkdown) so coverage is faithful to
 *  ingest by construction (never a re-implementation). */
export interface CoverageSourceSpec {
	family: SourceFamily;
	records: KnowledgeRecord[];
}

/** Dry-run coverage: a per-family id-diff of expected records (E) vs vault cards
 *  (V). missing = E − V (never converged — the silent-failure tax);
 *  sourceOrphaned = V − E (card whose source record disappeared). Writes NOTHING.
 *  Reuses readCardMeta — the same vault-read path ingestRecords uses for its
 *  existing-card snapshot — so the V set is exactly what ingest sees.
 *
 *  PER-FAMILY by design: pi-memory:<hash> and hermes:<slug> mint different ids
 *  for the same lesson, so id-diff is only meaningful WITHIN a source family.
 *  Cross-family convergence is Jaccard ≥ 0.85 (invisible to id-diff). */
export async function coverageReport(opts: {
	vaultPath: string;
	folder?: string;
	sources: CoverageSourceSpec[];
}): Promise<CoverageReport> {
	const folderAbs = join(opts.vaultPath, opts.folder ?? "Zettelkasten/knowledge-graph");

	// V: vault cards grouped by source family (via readCardMeta — same path ingest uses).
	const vaultByFamily = new Map<string, Set<string>>();
	if (existsSync(folderAbs)) {
		for (const name of readdirSync(folderAbs)) {
			if (!name.endsWith(".md")) continue;
			const meta = readCardMeta(join(folderAbs, name));
			if (!meta?.source_id) continue;
			// The card's `source` frontmatter is the sourceLabel ("<family>:<detail>"
			// — verified for every real caller: host-fns builds `${source}:…`, the
			// CLI passes "hermes:pipeline" etc.). Extract the family prefix so the
			// vault set is grouped by the SAME family key CoverageSourceSpec uses.
			// Legacy/empty-source cards fall through to "unknown" (never a checked
			// family → not counted as sourceOrphaned, gracefully ignored).
			const fam = (meta.source ?? "").split(":")[0]?.trim() || "unknown";
			const set = vaultByFamily.get(fam) ?? new Set<string>();
			set.add(meta.source_id);
			vaultByFamily.set(fam, set);
		}
	}

	// Per-family diff. A family not present in the vault contributes vault=0
	// (every expected id is missing); a family in the vault but not checked is
	// left alone (no cross-family false-positive).
	const byFamily: Record<string, CoverageByFamily> = {};
	const missing: string[] = [];
	const sourceOrphaned: string[] = [];
	let expected = 0;
	let vaultTotal = 0;
	let matched = 0;
	for (const src of opts.sources) {
		const E = new Set(src.records.map((r) => r.id));
		const V = vaultByFamily.get(src.family) ?? new Set<string>();
		const famMissing = [...E].filter((id) => !V.has(id));
		const famOrphaned = [...V].filter((id) => !E.has(id));
		const famMatched = E.size - famMissing.length;
		byFamily[src.family] = {
			expected: E.size,
			vault: V.size,
			matched: famMatched,
			missing: famMissing,
			sourceOrphaned: famOrphaned,
		};
		missing.push(...famMissing);
		sourceOrphaned.push(...famOrphaned);
		expected += E.size;
		vaultTotal += V.size;
		matched += famMatched;
	}
	return { expected, vault: vaultTotal, matched, missing, sourceOrphaned, byFamily };
}

export async function ingestRecords(
	records: KnowledgeRecord[],
	opts: IngestOptions,
): Promise<IngestSummary> {
	const folder = opts.folder ?? "Zettelkasten/knowledge-graph";
	const mocPath = opts.mocPath ?? "Tags/Knowledge Graph.md";
	const maxLinks = opts.maxLinks ?? 8;
	const maxDetailChars = opts.maxDetailChars ?? 32_000;
	const dryRun = opts.dryRun === true;
	const wikiAware = opts.wikiAware === true;
	const wikiThreshold = opts.wikiThreshold ?? 0.85;
	const linkWeighting = opts.linkWeighting ?? "count";
	// kg.llm gate (D4, ticket 03 T3): the effective flag is IngestOptions.kgLlm
	// with a `PI_KG_LLM=1` env fallback (env mirrors the LMSTUDIO_BASE_URL read
	// style in semantic.ts). Threaded to the extractor-selection point
	// (resolveExtractor). Default OFF → dictionary path. Phase-2 SHIPPED: when
	// ON, resolveExtractor returns LlmRelationExtractor, which itself degrades
	// to dictionary-equivalent output on any LLM failure (never-throws).
	const kgLlm = opts.kgLlm ?? process.env.PI_KG_LLM === "1";
	const kgLlmModel = opts.kgLlmModel ?? process.env.PI_KG_LLM_MODEL;
	const folderAbs = join(opts.vaultPath, folder);

	if (!existsSync(opts.vaultPath)) {
		throw new Error(`vault does not exist: ${opts.vaultPath}`);
	}
	if (!dryRun) mkdirSync(folderAbs, { recursive: true });

	// 1. Snapshot existing cards in the folder (for cross-link + collision +
	//    wiki-aware matching). When wikiAware is on we also capture each card's
	//    source_id + tokenised title/body so incoming records can be matched
	//    against them BEFORE minting a new card.
	interface ExistingCard {
		abs: string;
		tags: Set<string>;
		sourceId: string;
		tokens: Set<string>;
	}
	const existing = new Map<string, ExistingCard>(); // basename -> meta
	if (existsSync(folderAbs)) {
		for (const name of readdirSync(folderAbs)) {
			if (!name.endsWith(".md")) continue;
			const abs = join(folderAbs, name);
			const meta = readCardMeta(abs);
			if (!meta) continue;
			let content = "";
			let tokens = new Set<string>();
			if (wikiAware) {
				try {
					content = readFileSync(abs, "utf8");
					tokens = tokeniseCardFile(content);
				} catch { /* best effort */ }
			}
			existing.set(name.slice(0, -3), {
				abs,
				tags: meta.tags,
				sourceId: meta.source_id ?? name.slice(0, -3),
				tokens,
			});
		}
	}

	const summary: IngestSummary = {
		source: opts.source,
		sourceLabel: opts.sourceLabel,
		total: records.length,
		created: 0,
		updated: 0,
		unchanged: 0,
		skipped: 0,
		linked: 0,
		wikiMerged: 0,
		mocUpdated: false,
		vaultPath: opts.vaultPath,
		folder,
		cards: [],
		parseErrors: [],
	};

	// 1b. Wiki-aware pre-filter: match each incoming record against existing
	//     cards. A match UPSERTS into the canonical card (first-wins policy);
	//     only unmatched records fall through to the normal create/update path.
	//     This is what prevents the 10+ id namespaces from growing parallel
	//     duplicate cards for the same lesson.
	const today = new Date().toISOString().slice(0, 10);
	const pendingRecords: typeof records = [];
	for (const rec of records) {
		let wikiMatched = false;
		if (wikiAware && existing.size > 0) {
			// Skip the wiki check for an EXACT id match (normal upsert path handles it).
			let exactId = false;
			for (const c of existing.values()) {
				if (c.sourceId === rec.id) { exactId = true; break; }
			}
			if (!exactId) {
				const recTokens = tokeniseText(`${rec.title} ${rec.detail}`);
				if (recTokens.size > 0) {
					const candidateBasenames = [...existing.keys()];
					const candidates = [...existing.values()];
					const candidateTokens = candidates.map((c) => c.tokens);
					const match = bestMatch(recTokens, candidateTokens, wikiThreshold);
					if (match.index >= 0) {
						const targetBasename = candidateBasenames[match.index]!;
						const target = candidates[match.index]!;
						const outcome = wikiMergeIntoCard(
							target.abs, rec, opts.sourceLabel, match.similarity, today, dryRun,
						);
						summary.wikiMerged++;
						if (outcome === "updated") summary.updated++;
						else summary.unchanged++;
						summary.cards.push({
							id: rec.id,
							path: `${folder}/${targetBasename}.md`,
							status: outcome,
							links: 0,
						});
						wikiMatched = true;
					}
				}
			}
		}
		if (!wikiMatched) pendingRecords.push(rec);
	}

	// 2. Resolve a target filename per record (handle slug collisions).
	const planned: {
		rec: KnowledgeRecord;
		rel: string;
		abs: string;
		basename: string;
	}[] = [];
	const plannedById = new Map<string, string>(); // canonical id → basename (in-batch upsert)
	const usedBasenames = new Set(existing.keys());
	for (const rec of pendingRecords) {
		let base = slugify(rec.id);
		// In-batch dedup: a canonical id already planned in THIS batch upserts onto
		// its basename (mirrors the on-disk same-id path below) instead of
		// disambiguating to `<slug>-2` and emitting a duplicate card. Without this,
		// two records sharing an id in a single fresh batch (card not yet on disk)
		// produce `<slug>.md` + `<slug>-2.md` — violating "dedup by canonical id".
		const alreadyPlanned = plannedById.get(rec.id);
		if (alreadyPlanned) {
			base = alreadyPlanned; // upsert onto the already-planned basename (last wins)
		} else {
			// Disambiguate slug collisions where the existing file is a DIFFERENT id.
			let candidate = base;
			let n = 2;
			while (usedBasenames.has(candidate)) {
				const prevAbs = join(folderAbs, `${candidate}.md`);
				const prev = readCardMeta(prevAbs);
				if (prev && prev.source_id === rec.id) {
					base = candidate; // same record → upsert in place
					break;
				}
				candidate = `${base}-${n++}`;
			}
			base = candidate;
			plannedById.set(rec.id, base);
			usedBasenames.add(base);
		}
		const rel = `${folder}/${base}.md`;
		planned.push({ rec, rel, abs: join(opts.vaultPath, rel), basename: base });
	}

	// 3. Compute cross-link neighbours for each planned card against the full
	//    folder tag graph (existing + this batch). Ranking weight is selected by
	//    `linkWeighting`: "count" (default, pinned iter-7 baseline) = raw
	//    shared-tag count; "idf" (SAG-inspired, P8) = Σ IDF(sharedTag) so rare
	//    specific bridges (pi-obsidian) outrank ubiquitous type-tags (pattern).
	const plannedTags = new Map(planned.map((p) => [p.basename, new Set(cardTags(p.rec))]));
	// Candidate pool keyed by basename so a card present BOTH on disk
	// (`existing`) AND in this batch (`planned`) — i.e. an upsert / re-ingest
	// — is counted ONCE (planned tags win, they're the freshest). Without this
	// dedup, re-ingesting a source that already has on-disk neighbours would
	// emit duplicate `相關：[[...]]` lines.
	const pool = new Map<string, Set<string>>();
	for (const [n, m] of existing.entries()) pool.set(n, m.tags);
	for (const [n, t] of plannedTags.entries()) pool.set(n, t);
	// IDF table over the full pool (only computed when needed; O(pool) pass).
	const idfTable = linkWeighting === "idf" ? computeIdf([...pool.values()]) : new Map<string, number>();
	const allNeighbours: Map<string, string[]> = new Map(); // basename -> targets
	for (const p of planned) {
		const myTags = plannedTags.get(p.basename)!;
		const scored: { name: string; shared: number }[] = [];
		for (const [name, tags] of pool) {
			if (name === p.basename) continue;
			const shared = scoreOverlap(myTags, tags, idfTable, linkWeighting);
			if (shared > 0) scored.push({ name, shared });
		}
		scored.sort((a, b) => b.shared - a.shared || a.name.localeCompare(b.name));
		allNeighbours.set(
			p.basename,
			scored.slice(0, maxLinks).map((s) => s.name),
		);
	}

	// kg.llm extractor (Phase-2 T3): resolved ONCE above the per-card loop
	// (T2 review NIT-1) — no per-card construction, no per-card env re-read.
	// With kgLlm ON this is the `LlmRelationExtractor` and runs for EVERY card
	// regardless of linkWeighting (its relations are the write authority); with
	// kgLlm OFF (default) it is the dictionary singleton and the flow below is
	// byte-identical to Phase-1 (extractor consulted only under idf, entities
	// only). `_extractor` is the test-injection seam (canned chat fixtures).
	const extractor =
		opts._extractor ?? resolveExtractor(kgLlm, kgLlmModel ? { kgLlmModel } : undefined);

	// 4. Render + write each card (or report only, in dryRun).
	for (const p of planned) {
		const rec = p.rec;
		const created =
			extractDate(rec.evidence?.first_seen, rec.evidence?.extracted_at, rec.extracted_at) ||
			"1970-01-01";
		const tags = cardTags(rec);
		const links = allNeighbours.get(p.basename) ?? [];
		// Typed entities (P8) + LLM relations (Phase-2 T3):
		// - Entities for frontmatter stay IDF-GATED (the dictionary/idf contract
		//   is unchanged); pre-supplied rec.entities (from JSONL) always win.
		// - When kgLlm is ON, the extractor runs REGARDLESS of linkWeighting —
		//   under idf its (LLM or degraded-dictionary) entities feed the same
		//   frontmatter slot; under non-idf the run is for RELATIONS only and
		//   entity frontmatter is still skipped.
		// - kgLlm OFF: EXACT Phase-1 flow — extractor only under idf, entities
		//   only, no relations ever (dictionary write-authorivity guard).
		let entities: ExtractedEntity[] | undefined;
		let relations: Relation[] | undefined;
		if (kgLlm) {
			const llmResult = await extractor.extract(`${rec.title} ${rec.detail}`);
			if (linkWeighting === "idf") {
				entities = (rec.entities as ExtractedEntity[] | undefined)?.length
					? (rec.entities as ExtractedEntity[])
					: llmResult.entities;
			}
			relations = llmResult.relations;
		} else if (linkWeighting === "idf") {
			entities = (rec.entities as ExtractedEntity[] | undefined)?.length
				? (rec.entities as ExtractedEntity[])
				: (await extractor.extract(`${rec.title} ${rec.detail}`)).entities;
		}
		const content = renderCard(
			rec,
			created,
			tags,
			links,
			opts.sourceLabel,
			maxDetailChars,
			entities,
			relations,
		);

		// Validate frontmatter-only (no idx → no dead-link false-positives mid-batch).
		const v = validateZettelNote(content);
		if (!v.ok) {
			summary.skipped++;
			summary.parseErrors.push({
				line: 0,
				reason: `card for ${rec.id} failed zettel validation: ${v.errors.join("; ")}`,
			});
			continue;
		}
		if (Buffer.byteLength(content, "utf8") > ZETTEL_MAX_BYTES) {
			summary.skipped++;
			summary.parseErrors.push({
				line: 0,
				reason: `card for ${rec.id} exceeds ${ZETTEL_MAX_BYTES / 1024}KB`,
			});
			continue;
		}

		let outcome: CardOutcome;
		const existedBefore = existing.has(p.basename);
		if (dryRun) {
			// Dry-run is a TRUE idempotency probe: for an existing card, compare the
			// would-be content against the on-disk content so a re-ingest reports
			// `unchanged` (not a conservative `updated`) when nothing changed.
			if (existedBefore) {
				try {
					outcome = readFileSync(p.abs, "utf8") === content ? "unchanged" : "updated";
				} catch {
					outcome = "updated";
				}
			} else {
				outcome = "created";
			}
		} else if (!existedBefore) {
			writeFileSync(p.abs, content, "utf8");
			outcome = "created";
		} else {
			const prev = readFileSync(p.abs, "utf8");
			if (prev === content) {
				outcome = "unchanged";
			} else {
				writeFileSync(p.abs, content, "utf8");
				outcome = "updated";
			}
		}
		summary[outcome === "created" ? "created" : outcome === "updated" ? "updated" : "unchanged"]++;
		summary.linked += links.length;
		summary.cards.push({ id: rec.id, path: p.rel, status: outcome, links: links.length });
	}

	// 5. Regenerate the MOC from every card now in the folder (post-write).
	if (!dryRun || existsSync(folderAbs)) {
		const allCards = existsSync(folderAbs)
			? readdirSync(folderAbs)
					.filter((n) => n.endsWith(".md"))
					.map((n) => join(folderAbs, n))
			: [];
		if (allCards.length > 0) {
			summary.mocUpdated = writeMoc(opts.vaultPath, mocPath, allCards, dryRun);
		}
	}

	return summary;
}

/** Human-readable summary for CLI / tool output. */
export function formatSummary(s: IngestSummary): string {
	const rel = (p: string) => relative(s.vaultPath, join(s.vaultPath, p));
	const head = [
		`vault:   ${s.vaultPath}`,
		`folder:  ${rel(s.folder)}/`,
		`source:  ${s.source} (${s.sourceLabel})`,
		`total:   ${s.total} record(s) → ${s.created} created, ${s.updated} updated, ${s.unchanged} unchanged, ${s.skipped} skipped${s.wikiMerged > 0 ? `, ${s.wikiMerged} wiki-merged` : ""}`,
		`links:   ${s.linked} cross-source edge(s) written`,
		`moc:     ${s.mocUpdated ? "regenerated " + rel("Tags/Knowledge Graph.md") : "(no MOC change)"}`,
	];
	if (s.parseErrors.length > 0) {
		head.push("", `parse errors (${s.parseErrors.length}):`);
		for (const e of s.parseErrors.slice(0, 12))
			head.push(`  line ${e.line}: ${e.reason}`);
		if (s.parseErrors.length > 12) head.push(`  …(+${s.parseErrors.length - 12} more)`);
	}
	return head.join("\n");
}

// VaultIndex is re-exported for downstream tooling that wants to feed a fresh
// index to validateZettelNote; ingestRecords itself does not need one.
export type { VaultIndex };
