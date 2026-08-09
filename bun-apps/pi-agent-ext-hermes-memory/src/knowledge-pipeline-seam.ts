import { readSeam, type KnowledgePipeline } from "@repo/pi-agent-ext-core-interface";

/** hermes-memory's defensive reader of zk's KnowledgePipeline seam.
 *  Returns undefined when zk is absent (graceful fallback). Ticket 06's spine
 *  orchestration consumes this. */
export function getKnowledgePipeline(): KnowledgePipeline | undefined {
  return readSeam("__piKnowledgePipeline");
}
