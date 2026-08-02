import { createHash } from "node:crypto";
import { MEMORY_POLICY_PROMPT, MEMORY_POLICY_PROMPT_COMPACT } from "./constants.js";
import type { MemoryConfig } from "./types.js";
import type { MemoryStore } from "./store/memory-store.js";
import type { AssemblyReceipt } from "./handlers/session-assembly.js";

type MemoryPolicyConfig = Pick<MemoryConfig, "memoryPolicyStyle" | "memoryPolicyCustomText">;

export function resolveMemoryPolicyPrompt(config: MemoryPolicyConfig): string {
  const style = config.memoryPolicyStyle ?? "full";

  switch (style) {
    case "compact":
      return MEMORY_POLICY_PROMPT_COMPACT;
    case "custom":
      return config.memoryPolicyCustomText && config.memoryPolicyCustomText.trim().length > 0
        ? config.memoryPolicyCustomText
        : MEMORY_POLICY_PROMPT_COMPACT;
    case "none":
      return "";
    case "full":
    default:
      return MEMORY_POLICY_PROMPT;
  }
}

export async function buildPromptContext(
  config: Pick<MemoryConfig, "memoryMode" | "memoryPolicyStyle" | "memoryPolicyCustomText">,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  projectName: string,
): Promise<string> {
  if (config.memoryMode === "policy-only") {
    return resolveMemoryPolicyPrompt(config);
  }

  const memoryBlock = store.formatForSystemPrompt();
  const projectBlock = projectStore ? projectStore.formatProjectBlock(projectName) : "";

  const parts: string[] = [];
  if (memoryBlock) parts.push(memoryBlock);
  if (projectBlock) parts.push(projectBlock);

  return parts.join("\n\n");
}

/**
 * Prompt-provenance receipt (UPSP §5 request_body_sha256 analogue). Returns the unioned
 * md_id set across all injected blocks + a SHA-256 of the joined memory+project block —
 * mirroring buildPromptContext's assembly so the logged set and hash describe the exact
 * text the agent is injected with (policy text excluded; it is constant config, not memory).
 * Returns null for policy-only mode or an empty assembly (nothing to prove).
 *
 * Sync: node:crypto's createHash is synchronous, avoiding async contagion at the session_start
 * wire-in. `buildPromptContext` is unchanged (no ripple to index.ts:331 / preview-context.ts).
 *
 * `signatures` (UPSP §9 / ticket #06): the per-entry content signatures for the surfaced
 * md_ids, threaded so session_start (Task 6) can populate the turn-end scanner. Union of
 * the memory-store + project-store manifest signatures, deduped by mdId (a memory entry and
 * a project entry could share an md_id — first occurrence wins; order memory-before-project).
 * captureAssembly ignores this field; it is consumed by Task 6's surfaced-set population.
 */
export function buildPromptAssembly(
  config: Pick<MemoryConfig, "memoryMode">,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  projectName: string,
): AssemblyReceipt | null {
  if (config.memoryMode === "policy-only") return null;
  const main = store.getAssemblyManifest();
  const proj = projectStore
    ? projectStore.getProjectAssemblyManifest(projectName)
    : { block: "", mdIds: [] as string[], signatures: [] as { mdId: string; signature: string }[] };
  const block = [main.block, proj.block].filter((b) => b.length > 0).join("\n\n");
  if (!block) return null;
  const mdIds = [...new Set([...main.mdIds, ...proj.mdIds])];
  // Signatures (UPSP §9 / ticket #06): union memory-store + project-store signatures,
  // deduped by mdId (first occurrence wins; order memory-store first, then project).
  // A manifest may return an empty array (empty block / under-min entries) — the union
  // just takes what exists. captureAssembly ignores this field.
  const seenSignatures = new Set<string>();
  const signatures: { mdId: string; signature: string }[] = [];
  for (const s of [...main.signatures, ...proj.signatures]) {
    if (!seenSignatures.has(s.mdId)) {
      seenSignatures.add(s.mdId);
      signatures.push(s);
    }
  }
  const hash = createHash("sha256").update(block, "utf8").digest("hex");
  return { mdIds, hash, signatures };
}
