/// <reference path="./tool-gating.d.ts" />
// First-class gate contract (wayfinder ticket 01): the exported `Gate` type +
// shared `GATE_DEFS` registry + the tool-facing `Gating` field type. Importable
// — no ambient-global dependency.
export { GATE_DEFS, type Gate, type Gating } from "./gates.js";
export { SEAM_KEYS, SEAM_KEY_ENTRIES, type SeamKey } from "./seam-keys.js";
export { ALL_TOOL_DEFINITIONS_GLOBAL, readAllToolDefinitions } from "./read-all-tool-definitions.js";
export { publishSeam, readSeam, type SeamImplMap, type ToolGateStatus } from "./seam.js";
export type {
  KnowledgePipeline, KnowledgeRecord, KnowledgeRecordEvidence, SourceFamily, LinkWeighting,
  IngestOptions, IngestSummary,
  RetrieveOptions, RetrieveResult, CollectInputFilesResult,
  HealOptions, HealReceipt, HierarchyBuildOptions, HierarchyBuildResult,
  EntityAugment,
} from "./interfaces/knowledge-pipeline.js";
// Deterministic entity primitives, shared BY VALUE across the knowledge-layer tier
// boundary (knowledge-card ranking ↔ hermes-memory entityRecall). See
// ./entities.ts for why they live below both rather than in the hub.
export {
  extractEntities, normEntity, computeIdf, scoreOverlap,
  type EntityType, type ExtractedEntity, type Relation,
} from "./entities.js";
// Hoisted L2 leaf (effort 2026-08-17-knowledge-pipeline-polish): the ONE
// embedder/cosine/fence-split primitive shared across the knowledge layer,
// replacing the deliberate mirrors in hermes-memory and zk.
export {
  SEMANTIC_MODEL_DEFAULT, SEMANTIC_EMBED_BASE_DEFAULT, resolveSemanticEmbedConfig,
  type Embedder, type DefaultEmbedderOptions,
  defaultEmbedder, lmStudioAvailable, type EmbedQueryOptions, embedQuery,
  cosine, splitFencedYaml,
} from "./embedding-leaf.js";
