/** Contract types for the KnowledgePipeline seam (zk publishes, hermes consumes).
 *  Mirrors pi-agent-ext-knowledge-card's public function signatures. */
export type SourceFamily = "workflow-jsonl" | "hermes" | "auto-memory" | "generic";
// Imported and re-exported, not redeclared: the same union used to be spelled
// out both here and in knowledge-card's entities.ts. Now that entities.ts lives
// in this package (ADR-0001 — see ../entities.ts), there is one definition.
// The import (not just a re-export) is required — the options types below
// reference the name in their own declarations.
import type { LinkWeighting } from "../entities.js";
export type { LinkWeighting };

export interface KnowledgeRecord {
  id: string; type: string; title: string; detail: string; tags: string[];
  dimension: string | null; confidence: number; status: string;
  superseded_by: string | null; entities?: unknown[];
}
export interface CollectInputFilesResult { files: string[]; skipped: { path: string; reason: string }[]; }
export interface IngestOptions {
  vaultPath: string; source: SourceFamily; sourceLabel: string; folder?: string;
  mocPath?: string; dryRun?: boolean; maxLinks?: number; wikiAware?: boolean; linkWeighting?: LinkWeighting;
  /** Opt-in LLM typed-relation extraction (LeanRAG ⑤ Phase-2 / D4). Default OFF
   *  (deterministic-by-design, ADR-0001). When true, zk's ingest gate selects
   *  the LLM extractor (Phase-2) instead of the dictionary default; until then
   *  it's a graceful no-op (dictionary fallback). Carried from hermes's
   *  `MemoryConfig.kgLlm` (env fallback `PI_KG_LLM=1`). */
  kgLlm?: boolean;
  /** Chat model id for the kg.llm extractor (Phase-2 T2). Threaded to zk's
   *  `resolveExtractor` as the `LlmRelationExtractor` model override; env
   *  fallback `PI_KG_LLM_MODEL` (zk default "google/gemma-4-12b-qat").
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
export interface SourceInput { path: string; family: SourceFamily; label?: string; }
export interface ConvergeOptions {
  sources: SourceInput[]; vaultPath: string; folder?: string; mocPath?: string;
  probeQueries?: unknown[]; probeTopK?: number; maxRounds?: number; consecutiveEmpty?: number;
  linkWeighting?: LinkWeighting; wikiAware?: boolean; maxLinks?: number;
}
export interface ConvergeReceipt {
  sourcesIngested: number; created: number; updated: number; unchanged: number;
  deadLinksBefore: number; deadLinksAfter: number; mocMissingBefore: boolean;
  mocMissingAfter: boolean; rounds: number; converged: boolean; truncated: boolean;
  probeHitRate?: number; health: unknown;
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

export interface KnowledgePipeline {
  collectInputFiles(paths: string[], opts: { source: SourceFamily; cwd: string }): CollectInputFilesResult;
  ingestRecords(records: KnowledgeRecord[], opts: IngestOptions): Promise<IngestSummary>;
  /** Scoped graph-heal (06b). A LEAF primitive — regenerate the convergence-folder
   *  MOC from on-disk cards + prune dead canonical [[…]] links in-card. No ingest,
   *  no convergence loop, no probe. zk already implements it (retrieve.ts);
   *  hermes calls it AFTER ingest to keep the vault graph healthy. */
  healGraph(opts: HealOptions): Promise<HealReceipt>;
  runConvergenceLoop(opts: ConvergeOptions): Promise<ConvergeReceipt>;
  retrieveRecords(opts: RetrieveOptions): Promise<RetrieveResult>;
}
