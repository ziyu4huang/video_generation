import { readSeam, type KnowledgePipeline, type HealOptions, type HealReceipt } from "@repo/pi-agent-core-interface";

// Re-export the heal contract types so hermes callers (knowledge-heal.ts, the
// walkAndIngest orchestrator) consume the seam contract from ONE site.
export type { HealOptions, HealReceipt };

/** hermes-memory's defensive reader of zk's KnowledgePipeline seam.
 *  Returns undefined when zk is absent (graceful fallback). Ticket 06's spine
 *  orchestration consumes this. */
export function getKnowledgePipeline(): KnowledgePipeline | undefined {
  return readSeam("__piKnowledgePipeline");
}
