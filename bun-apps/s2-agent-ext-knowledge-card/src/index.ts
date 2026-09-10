/**
 * Lib face for @repo/s2-agent-ext-knowledge-card — the importable surface
 * for OTHER workspace packages (created 2026-09-10 for bench-kcards; the
 * package previously exported only through the pi tool layer). Additive
 * only: the tool/extension registration lives in extensions/ and is
 * untouched. Edges point down only (ADR-knowledge-layer-0001).
 */
export { ingestRecords, formatSummary, coverageReport } from "./ingest.ts";
export { retrieveRecords } from "./retrieve.ts";
export { readCardMeta } from "./card-format.ts";
export { adaptGenericMarkdown } from "./adapters.ts";
export type {
	IngestSummary,
	KnowledgeRecord,
} from "./types.ts";
