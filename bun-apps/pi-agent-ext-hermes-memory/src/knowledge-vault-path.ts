import { existsSync } from "node:fs";

/** Convergence folder inside the vault (zk's default; the heal/ingest sink). */
export const KNOWLEDGE_FOLDER_DEFAULT = "Zettelkasten/knowledge-graph";

/** MOC note path, vault-relative (zk's default). */
export const KNOWLEDGE_MOC_DEFAULT = "Tags/Knowledge Graph.md";

/** Resolve the knowledge vault path from env ONLY (no obsidian/zk import).
 *  Precedence: KNOWLEDGE_VAULT_PATH (knowledge-pipeline alias) > OB_VAULT_PATH
 *  (obsidian Tier-1a key). Throws a clear, actionable error when both unset or
 *  the resolved path does not exist. */
export function resolveKnowledgeVaultPath(): string {
  const path = process.env.KNOWLEDGE_VAULT_PATH ?? process.env.OB_VAULT_PATH;
  if (!path) {
    throw new Error(
      "knowledge vault path not configured: set KNOWLEDGE_VAULT_PATH (preferred) or OB_VAULT_PATH to the absolute vault directory.",
    );
  }
  if (!existsSync(path)) {
    throw new Error(`knowledge vault path does not exist: ${path}`);
  }
  return path;
}
