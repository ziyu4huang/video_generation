/** Contract types for the KnowledgePipeline seam (zk publishes, hermes consumes).
 *  Mirrors pi-agent-ext-knowledge-card's public function signatures. */
export type SourceFamily = "workflow-jsonl" | "hermes" | "auto-memory" | "generic";
export type LinkWeighting = "count" | "idf";

export interface KnowledgeRecord {
  id: string; type: string; title: string; detail: string; tags: string[];
  dimension: string | null; confidence: number; status: string;
  superseded_by: string | null; entities?: unknown[];
}
export interface CollectInputFilesResult { files: string[]; skipped: { path: string; reason: string }[]; }
export interface IngestOptions {
  vaultPath: string; source: SourceFamily; sourceLabel: string; folder?: string;
  mocPath?: string; dryRun?: boolean; maxLinks?: number; wikiAware?: boolean; linkWeighting?: LinkWeighting;
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
export interface RetrievedCard { id: string; title: string; detail: string; tags: string[]; }
export interface RetrieveOptions {
  vaultPath: string; folder?: string; tags: string[]; excludeIds?: string[]; topK?: number;
  maxDetailChars?: number; linkWeighting?: LinkWeighting; bodyMatch?: boolean; slugDom?: boolean;
  semantic?: boolean; queryText?: string; semanticAlpha?: number; semanticModel?: string;
}
export interface RetrieveResult {
  count: number; cards: RetrievedCard[]; digest: string; folder: string; scanned: number; excluded: number;
}
export interface KnowledgePipeline {
  collectInputFiles(paths: string[], opts: { source: SourceFamily; cwd: string }): CollectInputFilesResult;
  ingestRecords(records: KnowledgeRecord[], opts: IngestOptions): Promise<IngestSummary>;
  runConvergenceLoop(opts: ConvergeOptions): Promise<ConvergeReceipt>;
  retrieveRecords(opts: RetrieveOptions): Promise<RetrieveResult>;
}
