import { getKnowledgePipeline, type HealOptions, type HealReceipt } from "./knowledge-pipeline-seam.js";

/** Defensive graph-heal over the zk seam. Returns undefined when zk is absent
 *  (graceful — the caller degrades to no-op, never throws). */
export async function healKnowledgeGraph(opts: HealOptions): Promise<HealReceipt | undefined> {
  const kp = getKnowledgePipeline();
  if (!kp) return undefined;
  return kp.healGraph(opts);
}
