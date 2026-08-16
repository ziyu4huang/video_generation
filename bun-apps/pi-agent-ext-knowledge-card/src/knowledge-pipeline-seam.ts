import { publishSeam, type KnowledgePipeline } from "@repo/pi-agent-core-interface";

/** Publish zk's knowledge surface as the __piKnowledgePipeline seam.
 *  Called from the extension factory on session_start. */
export function publishKnowledgePipeline(impl: KnowledgePipeline): void {
  publishSeam("__piKnowledgePipeline", impl);
}

/** Unpublish (session_shutdown / unload). */
export function unpublishKnowledgePipeline(): void {
  delete (globalThis as Record<string, unknown>).__piKnowledgePipeline;
}
