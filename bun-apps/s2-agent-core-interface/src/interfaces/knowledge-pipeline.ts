/** Contract types for the KnowledgePipeline seam (zk publishes, hermes consumes).
 *  Mirrors s2-agent-ext-knowledge-card's public function signatures. */
export type SourceFamily = "workflow-jsonl" | "hermes" | "auto-memory" | "generic";
// Imported and re-exported, not redeclared: the same union used to be spelled
// out both here and in knowledge-card's entities.ts. Now that entities.ts lives
// in this package (tier rule — see ../entities.ts), there is one definition.
// The import (not just a re-export) is required — the options types below
// reference the name in their own declarations.
import type { LinkWeighting } from "../entities.js";
export type { LinkWeighting };

/** Provenance timestamps / occurrence stats carried by structured sources (the
 *  workflow `.knowledge.jsonl` evidence block). Optional — hermes's
 *  knowledge-jsonl adapter passes it through the seam so zk's ingestRecords can
 *  use `first_seen` for the card `created:` date instead of the 1970-01-01
 *  fallback (review F1). Mirrors zk's own KnowledgeRecord.evidence shape. */
export interface KnowledgeRecordEvidence {
  occurrences?: number;
  first_seen?: string;
  last_seen?: string;
  run_ids?: string[];
  extracted_at?: string;
}
export interface KnowledgeRecord {
  id: string; type: string; title: string; detail: string; tags: string[];
  dimension: string | null; confidence: number; status: string;
  superseded_by: string | null; entities?: unknown[];
  /** Optional provenance (workflow evidence block). Carried verbatim into
   *  zk's ingestRecords when the seam is used (walkAndIngest path). */
  evidence?: KnowledgeRecordEvidence;
  schema_version?: number;
  extracted_at?: string;
}
export interface CollectInputFilesResult { files: string[]; skipped: { path: string; reason: string }[]; }
export interface IngestOptions {
  vaultPath: string; source: SourceFamily; sourceLabel: string; folder?: string;
  mocPath?: string; dryRun?: boolean; maxLinks?: number; wikiAware?: boolean; linkWeighting?: LinkWeighting;
  /** Opt-in LLM typed-relation extraction (LeanRAG ⑤ Phase-2 / D4). Default OFF
   *  (deterministic-by-design, tier rule). When true, zk's ingest gate selects
   *  the LLM extractor (Phase-2) instead of the dictionary default; until then
   *  it's a graceful no-op (dictionary fallback). Carried from hermes's
   *  `MemoryConfig.kgLlm` (env fallback `PI_KG_LLM=1`). */
  kgLlm?: boolean;
  /** Chat model id for the kg.llm extractor (Phase-2 T2). Threaded to zk's
   *  `resolveExtractor` as the `LlmRelationExtractor` model override; env
   *  fallback `PI_KG_LLM_MODEL` (zk default "prism-ml/bonsai-27b").
   *  Walk-and-ingest / hermes call-sites may rely on the env default — the
   *  field is the explicit carrier. */
  kgLlmModel?: string;
}
// Mirrors zk's actual IngestCardReport ({id,path,status,links}); the plan's
// draft wrongly declared `title` (zk has none) — return-type covariance requires
// the contract to be a SUBSET of zk's fields.
export interface IngestCardReport { id: string; path: string; status: string; links: number; }
export interface IngestSummary {
  source: SourceFamily; sourceLabel: string; total: number; created: number; updated: number;
  unchanged: number; skipped: number; linked: number; wikiMerged: number; mocUpdated: boolean;
  vaultPath: string; folder: string; cards: IngestCardReport[]; parseErrors: { line: number; reason: string }[];
}
export interface RetrievedCard {
  id: string;
  title: string;
  detail: string;
  tags: string[];
  /** Typed graph edges (ticket 03 T5 / D2). OPTIONAL — undefined for cards
   *  with no `relations:` frontmatter (the default dictionary ingest path
   *  emits entities only, never relations). When present, the edges are the
   *  on-disk `relations:` block (canonicalized by T4's serializer write-back);
   *  retrieve is a faithful pass-through, it does NOT re-normalize. Substrate
   *  for ticket 20 (multi-signal frequency-vote) + LeanRAG ③ (dedup). */
  relations?: Array<{ s: string; rel: string; o: string }>;
}
export interface RetrieveOptions {
  vaultPath: string; folder?: string; tags: string[]; excludeIds?: string[]; topK?: number;
  maxDetailChars?: number; linkWeighting?: LinkWeighting; bodyMatch?: boolean; slugDom?: boolean;
  semantic?: boolean; queryText?: string; semanticAlpha?: number; semanticModel?: string;
  /** D18 typed filter (kcard-parity ticket 05): exact leaf-type match —
   *  frontmatter `type` on the flat lane, index `kind` on the hier lane. */
  type?: string;
}
export interface RetrieveResult {
  count: number; cards: RetrievedCard[]; digest: string; folder: string; scanned: number; excluded: number;
}
/** Scoped graph-heal options. Maps 1:1 to zk's GraphHealthOptions
 *  (retrieve.ts). The convergence-folder scope keeps heal from touching
 *  human-authored cards outside it. */
export interface HealOptions {
  /** Absolute vault path (the convergence sink). */
  vaultPath: string;
  /** Convergence folder inside the vault (default: Zettelkasten/knowledge-graph). */
  folder?: string;
  /** MOC note path, vault-relative (default: Tags/Knowledge Graph.md). */
  mocPath?: string;
}

/** Receipt for a scoped graph-heal. Maps 1:1 to zk's HealResult (retrieve.ts);
 *  renamed HealReceipt here as the canonical seam contract. zk's richer type
 *  assigns structurally at the publishSeam call site (the contract is a SUBSET
 *  promise, per the core-interface pattern). */
export interface HealReceipt {
  /** true iff the MOC was regenerated from on-disk cards. */
  mocRegenerated: boolean;
  /** # of dead canonical `[[…]]` link lines pruned in-card. */
  deadLinksPruned: number;
  /** # of duplicate canonical link lines deduped within `## 連結`. */
  linksDeduped: number;
  /** Vault-relative paths of cards the heal mutated. */
  cardsTouched: string[];
}

/** Options for the hierarchy build (LeanRAG ① / ticket 04a). `cards` are the
 *  leaf records; `embedFn`/`summarizeFn` are injected callables (D4 — hermes
 *  supplies card_vectors + llm-chat; zk never imports a store or LLM client
 *  for this). */
export interface HierarchyBuildOptions {
  /** Convergence folder the derived agg cards + layer checkpoints live in. */
  kbDir: string;
  /** Explicit card set. When omitted, zk loads cards + entities
   *  from the .md files in kbDir (agg-L*-* MoCs skipped). */
  cards?: { id: string; text: string; entities: string[]; sources?: string[] }[];
  embedFn(texts: string[]): Promise<number[][]>;
  summarizeFn?(clusterText: string, budget: number): Promise<string>;
  tokenBudget?: number;
  threshold?: number;
  maxDepth?: number;
}
/** Receipt for a hierarchy build. `nodes` is the full multi-level set
 *  (AggregationNode-lite, inlined — zk's richer type assigns structurally,
 *  per the core-interface SUBSET pattern). */
export interface HierarchyBuildResult {
  layers: number;
  nodes: { id: string; parentOf: string[]; entities: string[]; sources: string[]; summary: string; layer: number; clusterSize: number }[];
  llmCalls: number;
  resumed: boolean;
  skipped?: string;
}

/** OPTIONAL entity-summary augmentation leaf for embed-text construction
 *  (es1 = entity-summary augmented embed lineage). zk publishes it backed by
 *  entity-summary.ts's pure augmentEmbedText; consumers (hermes's vector
 *  backfill) read it defensively — an absent leaf means unaugmented embed
 *  texts, byte-identical to the pre-es1 behavior. */
export interface EntityAugment {
  /** Pure transform: empty/absent summary → base unchanged; otherwise
   *  (summary.slice(0, 200) + " " + base).slice(0, 1000). */
  augmentEmbedText(base: string, summary?: string | null): string;
}

export interface KnowledgePipeline {
  collectInputFiles(paths: string[], opts: { source: SourceFamily; cwd: string }): CollectInputFilesResult;
  ingestRecords(records: KnowledgeRecord[], opts: IngestOptions): Promise<IngestSummary>;
  /** Scoped graph-heal (06b). A LEAF primitive — regenerate the convergence-folder
   *  MOC from on-disk cards + prune dead canonical [[…]] links in-card. No ingest,
   *  no convergence loop, no probe. zk already implements it (retrieve.ts);
   *  hermes calls it AFTER ingest to keep the vault graph healthy. */
  healGraph(opts: HealOptions): Promise<HealReceipt>;
  /** Multi-layer aggregation-hierarchy build (LeanRAG ① / ticket 04a).
   *  Embeds + clusters the leaf cards into aggregation nodes, recurses (node
   *  summaries become the next layer's cards) until ≤4 nodes / depth cap,
   *  materializes derived MOC cards + per-layer checkpoints in kbDir — a
   *  crashed batch build resumes at the last complete layer. */
  buildHierarchy(opts: HierarchyBuildOptions): Promise<HierarchyBuildResult>;
  retrieveRecords(opts: RetrieveOptions): Promise<RetrieveResult>;
  /** OPTIONAL entity-augment leaf (es1 lineage). Absent on hosts without
   *  zk's entity-summary surface — consumers must treat that as "no
   *  augmentation" (identical embed texts), never as an error. */
  entityAugment?: EntityAugment;
}
