/// <reference path="./tool-gating.d.ts" />
// First-class gate contract (wayfinder ticket 01): the exported `Gate` type +
// shared `GATE_DEFS` registry. Importable — no ambient-global dependency.
export { GATE_DEFS, type Gate } from "./gates.js";
export { SEAM_KEYS, SEAM_KEY_ENTRIES, type SeamKey } from "./seam-keys.js";
export { publishSeam, readSeam, type SeamImplMap } from "./seam.js";
export type {
  KnowledgePipeline, KnowledgeRecord, KnowledgeRecordEvidence, SourceFamily, LinkWeighting,
  IngestOptions, IngestSummary, ConvergeOptions, ConvergeReceipt,
  RetrieveOptions, RetrieveResult, CollectInputFilesResult,
  HealOptions, HealReceipt,
} from "./interfaces/knowledge-pipeline.js";
// Deterministic entity primitives, shared BY VALUE across the ADR-0001 tier
// boundary (knowledge-card ranking ↔ hermes-memory entityRecall). See
// ./entities.ts for why they live below both rather than in the hub.
export {
  extractEntities, normEntity, computeIdf, scoreOverlap,
  type EntityType, type ExtractedEntity, type Relation,
} from "./entities.js";
