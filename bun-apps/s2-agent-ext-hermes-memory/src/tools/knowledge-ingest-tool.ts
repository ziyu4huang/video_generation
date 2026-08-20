/**
 * knowledge_ingest tool — the agent-facing on-demand trigger for
 * `walkAndIngest` (06b). A THIN wrapper: resolves the input path the agent
 * passes, calls `walkAndIngest`, and formats the `WalkAndIngestReceipt`
 * (ingest counts + heal + mirrored + skipped) into `text` + `details`.
 *
 * `walkAndIngest` owns the policy walk + family detection + adapt + zk ingest
 * + heal + DB-mirror. This tool just exposes it to the LLM. It mirrors the
 * `registerMemoryTool`/`registerKnowledgeSearchTool` registration pattern:
 * `gating:{core:true}`, typebox params, structured `details`.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { GATE_DEFS } from "@repo/s2-agent-core-interface";
import { Type } from "typebox";
import { walkAndIngest, type WalkAndIngestReceipt, type WalkAndIngestOptions } from "../walk-and-ingest.js";
import type { ToolRegistrar } from "./knowledge-search-tool.js";

GATE_DEFS["knowledge_ingest"] = {
  id: "knowledge_ingest",
  keywords: ["knowledge ingest", "ingest knowledge", "ingest records", "walk and ingest", "知識收錄", "匯入知識"],
  requires: {
    nouns: ["knowledge", "record", "knowledge.jsonl", "card", "知識", "記錄"],
    verbs: ["ingest", "import", "add", "heal", "收錄", "匯入", "新增"],
  },
  description: "Ingest .knowledge.jsonl records into the knowledge graph",
};

const KNOWLEDGE_INGEST_DESCRIPTION = `Ingest .knowledge.jsonl (file or dir) into the knowledge graph: writes vault-md cards, regenerates the MOC, mirrors cards into the memory store. Idempotent. Generic .md deferred; images/binaries/symlinks and junk dirs skipped.`;

/** Format a WalkAndIngestReceipt into a human-readable summary. */
function formatKnowledgeIngestText(receipt: WalkAndIngestReceipt): string {
  if (!receipt.ok) {
    return `✗ knowledge ingest skipped: ${receipt.reason ?? "unknown reason"}`;
  }
  const ingest = receipt.ingest;
  const parts: string[] = [`✓ ingested ${ingest ? `${ingest.created} created · ${ingest.updated} updated · ${ingest.unchanged} unchanged` : "?"} knowledge cards`];
  parts.push(`healed graph (MOC ${receipt.heal?.mocRegenerated ? "regenerated" : "unchanged"})`);
  parts.push(`mirrored ${receipt.mirrored} card${receipt.mirrored === 1 ? "" : "s"} into the store`);
  const sk = receipt.skipped;
  const skippedBits: string[] = [];
  if (sk.dirs.length > 0) skippedBits.push(`${sk.dirs.length} dir${sk.dirs.length === 1 ? "" : "s"}`);
  if (sk.binaries.length > 0) skippedBits.push(`${sk.binaries.length} binar${sk.binaries.length === 1 ? "y" : "ies"}`);
  if (sk.symlinks.length > 0) skippedBits.push(`${sk.symlinks.length} symlink${sk.symlinks.length === 1 ? "" : "s"}`);
  if (sk.deferredFamily.length > 0) skippedBits.push(`${sk.deferredFamily.length} deferred`);
  if (skippedBits.length > 0) parts.push(`skipped ${skippedBits.join(", ")}`);
  return parts.join(" · ");
}

/** Register the `knowledge_ingest` tool. `opts` carries ingest/mirror scope
 *  (folder, memoryDir, …) shared across calls — resolved once at wiring time. */
export function registerKnowledgeIngestTool(pi: ToolRegistrar, opts: WalkAndIngestOptions = {}): ToolDefinition {
  const definition = defineTool({
    name: "knowledge_ingest",
    label: "Knowledge ingest",
    gating: { gate: "knowledge_ingest" }, // demoted from core (ticket 02)
    description: KNOWLEDGE_INGEST_DESCRIPTION,
    parameters: Type.Object({
      path: Type.String({
        description: "Directory or .knowledge.jsonl file to ingest.",
      }),
    }),
    async execute(_toolCallId, params) {
      const receipt = await walkAndIngest([params.path], opts);
      return {
        content: [{ type: "text" as const, text: formatKnowledgeIngestText(receipt) }],
        details: receipt,
      };
    },
  });
  pi.registerTool(definition);
  return definition;
}


/**
 * Gate-Recall Guard probe set (QA-DATA only — NOT part of runtime gating).
 * Consumed by s2-agent-ext-tool-gate/qa/collect-probes.ts. Controls-only
 * (recallFloor 0, adversarial []): demoted from core in ticket 02; narrow
 * keywords are intentional, so we assert the predicate fires on its own
 * keyword/requires path, not paraphrased intent.
 */
export const __GATE_PROBES__ = {
  gate: "knowledge_ingest",
  recallFloor: 0,
  adversarial: [],
  controls: ["ingest the workflow's .knowledge.jsonl records", 'walk and ingest the knowledge directory', 'import the distilled knowledge cards', 'ingest the knowledge records from the workflow export'],
};
