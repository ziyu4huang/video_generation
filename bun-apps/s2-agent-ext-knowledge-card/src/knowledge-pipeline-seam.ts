import { publishSeam, type KnowledgePipeline } from "@repo/s2-agent-core-interface";
import { augmentEmbedText } from "./entity-summary.js";

/** Publish zk's knowledge surface as the __piKnowledgePipeline seam.
 *  Called from the extension factory on session_start.
 *
 *  es1 (entity-summary augmented embed lineage): the published surface is
 *  enriched with the OPTIONAL entityAugment leaf — the pure augmentEmbedText
 *  from entity-summary.ts — so seam consumers can build entity-summary
 *  augmented embed texts without importing zk directly (the hermes
 *  vector-backfill consumer was retired 2026-08-22, ADR-hermes-memory-0002).
 *  An impl that already carries its own entityAugment wins (no override). */
export function publishKnowledgePipeline(impl: KnowledgePipeline): void {
  publishSeam("__piKnowledgePipeline", { ...impl, entityAugment: impl.entityAugment ?? { augmentEmbedText } });
}

/** Unpublish (session_shutdown / unload). */
export function unpublishKnowledgePipeline(): void {
  delete (globalThis as Record<string, unknown>).__piKnowledgePipeline;
}
