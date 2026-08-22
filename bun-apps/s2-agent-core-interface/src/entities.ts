/**
 * src/entities.ts — deterministic typed-entity extraction + IDF-weighted
 * cross-link ranking (SAG-inspired, graph-first).
 *
 * ── What SAG teaches us ─────────────────────────────────────────
 * SAG's core retrieval innovation is the **entity-event bipartite graph**:
 * each document chunk is distilled into ONE fused "event" + MULTIPLE *typed*
 * entities (person / product / concept / metric / …), each with a role
 * description. Multi-hop retrieval then traverses entity→event→entity→event,
 * hitting key evidence with fewer tokens than a heavyweight knowledge graph.
 *
 * The structural property that makes it work: **entities are specific and
 * content-grounded**. A query for "flux2" matches the *entity* flux2 (3
 * events), not the ubiquitous type-tag "pattern" (282 events). This is exactly
 * the "generic-tag noise" limitation our convergence folder suffers
 * (TOOL-ORCHESTRATION.md §"Convergence gotchas"): flat shared-tag count lets
 * `pattern` crowd out the `pi-obsidian` bridge.
 *
 * ── What we adopt (and what we reject) ──────────────────────────
 * ✅ ADOPT: typed-entity extraction (deterministic, no LLM — like SAG's
 *    `localNamedEntities` fallback) + **IDF-weighted** tag/entity matching so
 *    rare specific bridges outrank ubiquitous type-tags. Both are ADDITIVE and
 *    OPT-IN, preserving the measured lexical+graph baseline (iter-7).
 * ❌ REJECT: embeddings (P3 retired — semantic blend lost iter-6/7), per-section
 *    chunking (P5 rejected — atomic-zettel is load-bearing), LLM extraction at
 *    ingest time (zk_ingest is deterministic-by-design; zk_extract is the LLM
 *    distill path). We are Bun/TS; SAG is TypeScript too but its extraction is
 *    LLM-backed for real quality — our ingest path stays LLM-free, so this is
 *    the *deterministic fallback* tier of SAG's design, ported to our domain.
 *
 * ── The taxonomy ────────────────────────────────────────────────
 * SAG uses 11 types (person/organization/location/time/product/metric/action/
 * work/group/subject/tags). Our domain is developer-knowledge (tools, models,
 * configs, errors), so we re-target to 8 types that surface the *specific*
 * bridges our flat tags miss. Each entity carries {type, name} (an optional
 * `description` exists for the Phase-2 LLM extractor; the deterministic
 * dictionary path never sets it — adding fabricated descriptions would be
 * lossy).
 *
 * Library only — no ExtensionAPI, no LLM, no network, and zero imports.
 *
 * ── Why this lives in core-interface, not in knowledge-card ─────
 * It used to live at `s2-agent-ext-knowledge-card/src/entities.ts`. Two
 * packages need it, on opposite sides of the knowledge-layer tier boundary:
 *   - knowledge-card (TIER-1 hub) — ingest.ts (IDF-weighted cross-link
 *     computation + additive frontmatter) and retrieve.ts (IDF ranking, opt-in)
 *   - hermes-memory (TIER-0 foundation) — the query-side `entityRecall` signal
 *     in tools/knowledge-search-tool.ts
 * and the two sides are only correct if they normalize with the SAME function:
 * `normEntity` is what makes "MLX" in prose match "mlx" in a card's graph.
 *
 * A TIER-0 package may not import the hub, so hermes reaching into
 * knowledge-card for it was an upward edge (forbidden — see
 * `bun-apps/docs/adr/0001-strict-downward-edges-knowledge-layer.md`). Routing
 * it through the `__piKnowledgePipeline` runtime seam instead would have made
 * the agreement a runtime coincidence and killed the signal whenever zk is not
 * loaded. Owning it HERE, below both, makes both edges point down and the
 * agreement structural.
 *
 * This is the reason core-interface is not a types-only package: it also owns
 * the deterministic primitives two tiers must share by value.
 */

// ---------------------------------------------------------------------------
// Entity taxonomy (re-targeted from SAG's benchmarkEntityTypes)
// ---------------------------------------------------------------------------

export type EntityType =
	| "tool" // CLI commands, scripts, subcommands (run.py, flux2, ltx-video, zk-ingest)
	| "model" // ML models / pipelines (Z-Image, Flux2 Klein, bge-large, LTX-2.3)
	| "config" // config keys, flags, env vars (--cfg-scale, MLX_MODELS_DIR, OB_VAULT_PATH)
	| "concept" // domain concepts (atomic zettel, semantic blend, multi-hop, IDF)
	| "error" // error types / failure modes (MPS crash, dead link, segfault, OOM)
	| "lib" // libraries / packages / runtimes (mlx, bun, transformers, typebox)
	| "file" // file paths / extensions (.knowledge.jsonl, MEMORY.md, package.json)
	| "tag"; // fallback: untyped entity (mirrors SAG's "tags" catch-all)

export interface ExtractedEntity {
	type: EntityType;
	name: string;
	/** Optional gloss (Phase-2 LLM extractor only). The dictionary path
	 *  always leaves this undefined — it is deterministic and fabricating
	 *  descriptions would be lossy; the card body is the role context. */
	description?: string;
}

/** A typed graph edge emitted by an `Extractor` (LeanRAG ⑤). The dictionary
 *  path emits entities only; relations come from the Phase-2 LLM impl. */
export type Relation = { s: string; rel: string; o: string };

/** Display-order for deterministic frontmatter output (mirrors the type
 *  priority SAG assigns: specific types before the catch-all). */
const ENTITY_TYPE_ORDER: EntityType[] = [
	"tool",
	"model",
	"config",
	"error",
	"lib",
	"file",
	"concept",
	"tag",
];

// ---------------------------------------------------------------------------
// Extraction patterns (adapted from SAG llm-client.ts localNamedEntities)
// ---------------------------------------------------------------------------

/**
 * Extract typed entities from a text body, deterministically (no LLM).
 *
 * Ported from SAG's `localNamedEntities` + `inferEntityType`, re-targeted to
 * our developer-knowledge domain. The extraction layers five deterministic
 * passes, each contributing candidates that are then typed by suffix/keyword
 * heuristics:
 *
 * 1. **Backtick code spans** (`` `run.py` ``, `` `--cfg-scale` ``) → the
 *    highest-precision signal in developer prose. These are almost always a
 *    tool, config flag, file, or identifier.
 * 2. **Title-case multi-word terms** (Flux2 Klein, LM Studio, Zettelkasten) →
 *    named tools/products/concepts (SAG's primary signal for English).
 * 3. **Hyphenated slugs** (pi-obsidian, zk-ingest, self-improve) → our
 *    package/namespace naming convention.
 * 4. **Quoted concepts** ("atomic zettel", "semantic blend") → domain terms.
 * 5. **CJK domain-suffixed terms** (…模型, …系統, …管線) → SAG's CJK signal,
 *    adapted to our zh-TW working language.
 *
 * Each candidate is typed via `inferType`, dedup'd by normalised name, capped
 * at `maxEntities` (default 16 — enough for cross-linking without frontmatter
 * bloat; SAG caps local extraction at 20).
 *
 * Returns entities sorted by type-priority then name for deterministic output.
 */
export function extractEntities(text: string, maxEntities = 16): ExtractedEntity[] {
	if (!text || !text.trim()) return [];
	const candidates = new Map<string, string>(); // normalised name → original display

	// 1. Backtick code spans — highest precision in developer prose.
	for (const m of text.matchAll(/`([^`]{1,60})`/g)) {
		const raw = m[1]!.trim();
		if (raw.length < 2) continue;
		candidates.set(normEntity(raw), raw);
	}

	// 2. Title-case multi-word terms (SAG's primary English signal).
	//    "Flux2 Klein", "LM Studio", "Knowledge Graph" — but NOT sentence starts
	//    (we require a second capitalised word OR a known suffix to reduce noise).
	for (const m of text.matchAll(/\b([A-Z][A-Za-z0-9]+(?:[-\s][A-Z][A-Za-z0-9]+){1,4})\b/g)) {
		const raw = m[1]!.trim();
		candidates.set(normEntity(raw), raw);
	}
	// Single Capitalised terms with a domain suffix (strong tool/product signal).
	for (const m of text.matchAll(/\b([A-Z][A-Za-z0-9]+(?:2|3|VR|ML|SDK|CLI|API)?)\b/g)) {
		const raw = m[1]!.trim();
		// Require length ≥ 3 and a vowel (filters sentence-initial "The" etc.)
		if (raw.length >= 3 && /[aeiouAEIOU]/.test(raw)) candidates.set(normEntity(raw), raw);
	}

	// 3. Hyphenated slugs — our package/namespace convention (pi-obsidian, zk-ingest).
	for (const m of text.matchAll(/\b([a-z][a-z0-9]+(?:-[a-z0-9]+){1,5})\b/g)) {
		const raw = m[1]!.trim();
		if (raw.length < 4) continue;
		candidates.set(normEntity(raw), raw);
	}

	// 4. Quoted concepts ("atomic zettel", "semantic blend").
	for (const m of text.matchAll(/["'“”]([^"'“”]{3,60})["'“”]/g)) {
		const raw = m[1]!.trim();
		if (raw.length < 3) continue;
		candidates.set(normEntity(raw), raw);
	}

	// 5. CJK domain-suffixed terms (SAG's CJK signal, zh-TW adapted).
	for (const m of text.matchAll(/[\u4e00-\u9fffA-Za-z0-9_-]{2,18}(?:模型|系統|管線|工具|腳本|擴展|套件|函式|模組|配置)/g)) {
		const raw = m[0]!.trim();
		candidates.set(normEntity(raw), raw);
	}

	// Type + dedup. Keep the first-seen display form per normalised name.
	const typed = new Map<string, ExtractedEntity>();
	for (const [normName, display] of candidates) {
		if (typed.has(normName)) continue;
		const type = inferType(display);
		typed.set(normName, { type, name: display });
	}

	// Sort by type-priority then name (deterministic frontmatter output).
	return [...typed.values()]
		.sort((a, b) => {
			const ta = ENTITY_TYPE_ORDER.indexOf(a.type);
			const tb = ENTITY_TYPE_ORDER.indexOf(b.type);
			if (ta !== tb) return ta - tb;
			return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
		})
		.slice(0, maxEntities);
}

/** Normalise an entity name for dedup (lowercase, collapse internal whitespace).
 *  Keeps hyphens/slashes/dots — they are part of the identifier (pi-obsidian,
 *  run.py, --cfg-scale). */
export function normEntity(name: string): string {
	return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Infer an entity type from its surface form, using suffix/keyword heuristics.
 * Adapted from SAG's `inferEntityType`, re-targeted to our domain. Order
 * matters: check the most specific signals first (file extensions, config
 * flags) before falling back to the generic concept/tag types.
 */
function inferType(name: string): EntityType {
	const lower = name.toLowerCase();

	// Config: leading-dash flags or SCREAMING_SNAKE env vars.
	if (/^--?[\w-]/.test(name) || /^[A-Z][A-Z0-9_]{3,}$/.test(name)) return "config";

	// File: has a known extension or path separator.
	if (/\.(jsonl?|ya?ml|md|ts|mjs|js|py|sh|toml|txt|lock|safetensors)$/i.test(lower)) return "file";
	if (/[\\/]/.test(name)) return "file";

	// Error: failure-mode keywords.
	if (/(crash|segfault|oom|panic|dead.?link|orphan|stale|drift|fail|error|hang|abort)/i.test(lower))
		return "error";

	// Tool: CLI command / subcommand patterns.
	if (/^(run|bun|npm|pnpm|git|rg|grep|sed|awk|curl|ffmpeg|docker|brew|uv|pip)\b/i.test(lower))
		return "tool";
	if (/^[a-z][\w-]*-(video|cli|ext|agent|pipeline|studio)$/.test(lower)) return "tool";
	if (/\b(subcommand|command|script|runner)\b/i.test(lower)) return "tool";

	// Model: known ML model suffixes/patterns.
	if (/(flux|ltx|z-image|zimage|krea|seedvr|gemma|qwen|bge|llama|mistral|clip|vae|esrgan|sdxl)/i.test(lower))
		return "model";
	if (/(klein|turbo|flash|pro|mini|nano|large|base)$/i.test(lower) && /\d/.test(name)) return "model";

	// Lib: runtime / package keywords.
	if (/(mlx|bun|node|python|transformers|typebox|react|fastify|postgress?|chroma)/i.test(lower))
		return "lib";

	// CJK domain suffix → concept (our working language is zh-TW).
	if (/[\u4e00-\u9fff]/.test(name)) return "concept";

	// Fallback: concept for multi-word, tag for single-word.
	return name.includes(" ") || name.includes("-") ? "concept" : "tag";
}

// ---------------------------------------------------------------------------
// IDF (Inverse Document Frequency) weighting
// ---------------------------------------------------------------------------

/**
 * Compute IDF (inverse document frequency) for each tag across a set of cards.
 *
 *   IDF(tag) = log(N / df(tag))     where N = total cards, df = cards bearing tag
 *
 * A tag on 3 of 600 cards gets IDF ≈ 5.3 (strong bridge); a tag on 282 of 600
 * gets IDF ≈ 0.75 (weak signal). This is the lever SAG's typed entities exploit
 * implicitly (its entities ARE the rare specific terms) and that our flat
 * shared-tag count lacks — documented as a known limitation in
 * TOOL-ORCHESTRATION.md §"Convergence gotchas / Generic-tag noise".
 *
 * We use natural-log IDF (standard IR form). Tags present on ALL cards get IDF
 * 0 (useless for discrimination). The "zettel" tag (present on every card) is
 * excluded upstream by ingest.ts's existing `shared -= 1` guard, but this
 * function is robust to it: log(N/N) = 0.
 *
 * @param tagSets  one Set<normalised-tag> per card in the folder
 * @returns        Map<normalised-tag, idf>  (tags with df=N have idf=0)
 */
export function computeIdf(tagSets: Set<string>[]): Map<string, number> {
	const N = tagSets.length;
	const df = new Map<string, number>(); // tag → document frequency
	for (const tags of tagSets) {
		for (const t of tags) df.set(t, (df.get(t) ?? 0) + 1);
	}
	const idf = new Map<string, number>();
	for (const [tag, freq] of df) {
		// Guard against log(0) / log(1)=0 edge; freq is always ≥1 here.
		idf.set(tag, Math.log(N / freq));
	}
	return idf;
}

/**
 * Score the overlap between two tag sets under a weighting scheme.
 *
 * - "count"  (default, the pinned baseline): raw |intersection| — the existing
 *   ingest.ts / retrieve.ts behaviour, byte-for-byte. Used when `linkWeighting`
 *   is unset so the measured lexical+graph ranking (iter-7) is preserved.
 * - "idf":   Σ IDF(tag) for each shared tag — rare specific bridges
 *   (pi-obsidian) outrank ubiquitous type-tags (pattern). The SAG-aligned lever.
 *
 * Both modes exclude the "zettel" tag from the sum (every card has it; it
 * carries no discrimination signal and would inflate "count" by a constant).
 */
export function scoreOverlap(
	myTags: Set<string>,
	theirTags: Set<string>,
	idf: Map<string, number>,
	mode: LinkWeighting = "count",
): number {
	let score = 0;
	for (const t of myTags) {
		if (t === "zettel") continue;
		if (!theirTags.has(t)) continue;
		score += mode === "idf" ? (idf.get(t) ?? 0) : 1;
	}
	return score;
}

export type LinkWeighting = "count" | "idf";
