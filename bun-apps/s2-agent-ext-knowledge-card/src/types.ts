/** Shared knowledge-card data contract (split from ingest.ts — hermes-arch-13). */
import type { ExtractedEntity, LinkWeighting, Relation } from "@repo/s2-agent-core-interface";
import type { Extractor } from "./extractor.ts";
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A structured knowledge record (the .knowledge.jsonl 12-key schema). Fields
 *  beyond the canonical 12 are tolerated and preserved in evidence only. */
export interface KnowledgeRecord {
	id: string;
	type: string; // lever | avoid | pattern | gotcha | metric | false_positive | experience (schema v2)
	title: string;
	detail: string;
	tags: string[];
	dimension: string | null;
	confidence: number;
	status: string; // active | superseded | retired
	superseded_by: string | null;
	/** Schema v2 (D4) L0 abstract, ≤256 chars. When absent it is derived at
	 *  ingest (deterministic first sentence; LLM condense only for long
	 *  bodies) and stamped by scripts/backfill-summaries.mjs on old cards. */
	summary?: string;
	/** Structured Situation/Approach/Reflect payload for `type: "experience"`
	 *  records (schema v2, OpenViking experiences pattern). Rendered as the
	 *  `## 情境 / 做法 / 反思` section; absent parts render as "—". */
	experience?: {
		situation: string;
		approach: string;
		reflection: string;
	};
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
	 *  OFF (deterministic-by-design, tier rule). When true, the ingest gate
	 *  selects the LLM extractor (Phase-2) instead of the dictionary default;
	 *  until Phase-2 the flag is real + wired but turning it ON is a graceful
	 *  no-op (dictionary fallback). Env fallback `PI_KG_LLM=1`. */
	kgLlm?: boolean;
	/** Chat model id for the kg.llm extractor (Phase-2 T2). Threaded to
	 *  `resolveExtractor` as the `LlmRelationExtractor` model override; env
	 *  fallback `PI_KG_LLM_MODEL` (zk default "prism-ml/bonsai-27b"). */
	kgLlmModel?: string;
	/** Opt-in LLM condense for schema-v2 summaries (D4). Default OFF — the
	 *  over-budget body then keeps its clamped deterministic first sentence
	 *  (the package tier rule: the default ingest path is LLM-free, same shape
	 *  as `kgLlm`). When ON, bodies over SUMMARY_BODY_BUDGET are condensed via
	 *  the local chat endpoint (llm-chat.ts), best-effort, deterministic
	 *  fallback on failure. Env fallback `PI_KG_SUMMARY_LLM=1`. */
	summaryLlm?: boolean;
	/** @internal Test seam: overrides the resolved extractor so tests can
	 *  inject an `LlmRelationExtractor` with a canned `_fetchImpl` (no live
	 *  LM Studio). Production callers leave this unset — the effective
	 *  extractor is `resolveExtractor(kgLlm, …)` (Phase-2 T3). */
	_extractor?: Extractor;
	/** @internal Test seam: fetch override for the schema-v2 summary LLM
	 *  condense (over-budget bodies only) so tests can count calls without a
	 *  live LM Studio. Production callers leave this unset. */
	_summaryFetch?: typeof fetch;
	/** Post-write index rebuild (ticket 08 fold-back, landed via the ticket 10
	 *  reconciliation): after the writes land, schedule the fingerprint-gated
	 *  SurrealDB card-index rebuild (fire-and-forget, coalesced, non-fatal on
	 *  any failure). Default FALSE — production callers (zk_ingest tools/CLI,
	 *  the extract loop) opt in; tests stay hermetic (a rebuild touches the
	 *  live Surreal service). */
	indexRebuild?: boolean;
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

