/**
 * Memory tool — registers the LLM-callable `memory` tool.
 * Ported from hermes-agent/tools/memory_tool.py (MEMORY_SCHEMA + memory_tool dispatch).
 * See PLAN.md → "Hermes Source File Reference Map" for source lines.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { MemoryStore } from "../store/memory-store.js";
import { DatabaseManager } from "../store/db.js";
import {
  formatFailureMemoryContent,
  removeExactSyncedMemories,
  removeSyncedMemories,
  replaceSyncedMemories,
  syncMemoryEntry,
} from "../store/sqlite-memory-store.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { MEMORY_TOOL_DESCRIPTION } from "../constants.js";
import type { MemoryCategory, MemoryResult } from "../types.js";
import { convergeToVault, type ConvergeResult } from "../store/vault-converge.js";

function appendSyncWarning(result: MemoryResult, warning: string): MemoryResult {
  const warnings = [...(((result as any).warnings ?? []) as string[]), warning];
  const message = result.message ? `${result.message} Warning: ${warning}` : warning;
  return {
    ...result,
    message,
    warning,
    warnings,
  } as MemoryResult;
}

/**
 * Write transferred entries as a .knowledge.jsonl archive file.
 * Returns the file path for the caller to pass to zk_ingest.
 */
function writeTransferArchive(
  target: "memory" | "user" | "failure",
  entries: string[],
): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = pathJoin(tmpdir(), "pi-memory-archive");
  mkdirSync(dir, { recursive: true });

  const jsonlPath = pathJoin(dir, `memory-transfer-${target}-${ts}.knowledge.jsonl`);

  const lines = entries.map((entry) => {
    const record = {
      id: `pi-memory-${target}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: "memory_entry",
      title: entry.slice(0, 80).replace(/\n/g, " "),
      detail: entry,
      tags: ["pi-memory", `target:${target}`],
      dimension: "operational",
      confidence: "high",
      status: "active",
      evidence: `Transferred from pi-hermes-memory ${target} target on ${new Date().toISOString().split("T")[0]}.`,
    };
    return JSON.stringify(record);
  });

  writeFileSync(jsonlPath, lines.join("\n") + "\n", "utf-8");
  return jsonlPath;
}

function formatTransferResult(
  result: MemoryResult,
  archivePath: string | undefined,
  converge: ConvergeResult | null,
): string {
  const lines: string[] = [];
  lines.push(result.message ?? "Transfer complete.");
  lines.push("");
  lines.push("Transferred entries:");
  lines.push("");

  const transferred = result.transferred_entries ?? [];
  transferred.forEach((entry, i) => {
    lines.push(`${i + 1}. ${entry}`);
    lines.push("");
  });

  // ── Single-hop convergence outcome ──
  // When pi-knowledge-card is installed, the entries were ingested directly as
  // atomic zettel cards in the default vault — no manual zk_ingest needed.
  if (converge && converge.ok) {
    const n = transferred.length;
    lines.push(
      `Converged ${n} entr${n === 1 ? "y" : "ies"} → ${
        (converge.created ?? 0) + (converge.updated ?? 0)
      } zettel card(s) in the default vault (${converge.created ?? 0} created, ${converge.updated ?? 0} updated, ${converge.unchanged ?? 0} unchanged, ${converge.linked ?? 0} cross-link(s)).`,
    );
    if (converge.vaultPath) lines.push(`vault: ${converge.vaultPath}`);
  } else if (converge && converge.unavailable && archivePath) {
    // Fallback: knowledge-card extension absent — keep the archive handoff.
    lines.push(`Archive file: ${archivePath}`);
    lines.push("");
    lines.push("Run zk_ingest on this file to import entries into the Obsidian vault:");
    lines.push(`  zk_ingest --files "${archivePath}"`);
    lines.push("");
    if (converge.reason) lines.push(`(auto-converge unavailable: ${converge.reason})`);
  } else if (archivePath) {
    lines.push(`Archive file: ${archivePath}`);
    lines.push("");
    lines.push("Run zk_ingest on this file to import entries into the Obsidian vault:");
    lines.push(`  zk_ingest --files "${archivePath}"`);
    lines.push("");
  }

  if (result.usage) lines.push(`Usage: ${result.usage}`);
  if (result.freed_chars) lines.push(`Chars freed: ${result.freed_chars}`);
  return lines.join("\n").trim();
}

function formatMemoryToolText(result: MemoryResult): string {
  const evictedEntries = result.evicted_entries ?? [];
  const archivePath = result.archive_path;

  if (result.success && evictedEntries.length > 0) {
    const lines = [
      result.message ?? `Memory updated. Rotated ${evictedEntries.length} older ${evictedEntries.length === 1 ? "entry" : "entries"} to stay within the limit.`,
      "",
    ];

    if (archivePath) {
      // Vault-offload: entries preserved in archive, not lost
      lines.push("Offloaded entries (saved to vault archive):");
    } else {
      // FIFO eviction: entries are lost
      lines.push("Rotated active memory entries:");
    }
    lines.push("");

    evictedEntries.forEach((entry, index) => {
      lines.push(`${index + 1}. ${entry}`);
      lines.push("");
    });

    if (archivePath) {
      lines.push(`Archive file: ${archivePath}`);
      lines.push("");
      lines.push("Run zk_ingest to import these entries into the Obsidian vault:");
      lines.push(`  zk_ingest --files "${archivePath}"`);
      lines.push("");
    } else {
      lines.push("If one of these entries should stay active, add it again.");
    }

    if (result.usage) lines.push(`Usage: ${result.usage}`);
    return lines.join("\n").trim();
  }

  return JSON.stringify(result);
}

function sqliteProjectFor(rawTarget: "memory" | "user" | "project" | "failure", projectName?: string | null): string | null | undefined {
  if (rawTarget === "project") return projectName?.trim() || null;
  if (rawTarget === "memory") return null;
  if (rawTarget === "user") return null;
  if (rawTarget === "failure") return null;
  return undefined;
}

function sqliteTargetFor(rawTarget: "memory" | "user" | "project" | "failure"): "memory" | "user" | "failure" {
  if (rawTarget === "project") return "memory";
  return rawTarget;
}

async function syncAddToSqlite(
  rawTarget: "memory" | "user" | "project" | "failure",
  content: string,
  category: MemoryCategory | undefined,
  failureReason: string | undefined,
  dbManager: DatabaseManager | null,
  projectName?: string | null,
): Promise<string | null> {
  if (!dbManager) return null;

  try {
    const sqliteTarget = sqliteTargetFor(rawTarget);
    const sqliteProject = sqliteProjectFor(rawTarget, projectName);

    if (rawTarget === "failure") {
      const failureCategory = category ?? "failure";
      syncMemoryEntry(dbManager, {
        content: formatFailureMemoryContent(content, {
          category: failureCategory,
          failureReason,
        }),
        target: "failure",
        project: sqliteProject ?? null,
        category: failureCategory,
        failureReason,
      });
      return null;
    }

    syncMemoryEntry(dbManager, {
      content,
      target: sqliteTarget,
      project: sqliteProject ?? null,
    });
    return null;
  } catch (err) {
    return `Saved to Markdown, but SQLite search sync failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function syncReplaceToSqlite(
  rawTarget: "memory" | "user" | "project" | "failure",
  oldText: string,
  newContent: string,
  dbManager: DatabaseManager | null,
  projectName?: string | null,
): Promise<string | null> {
  if (!dbManager) return null;

  try {
    const sqliteTarget = sqliteTargetFor(rawTarget);
    const sqliteProject = sqliteProjectFor(rawTarget, projectName);
    const syncResult = replaceSyncedMemories(dbManager, oldText, {
      content: newContent,
      target: sqliteTarget,
      project: sqliteProject,
    });

    if (syncResult.matched === 0) {
      return "Saved to Markdown, but no matching SQLite memory row was updated. Run /memory-sync-markdown if search results look stale.";
    }

    return null;
  } catch (err) {
    return `Saved to Markdown, but SQLite search sync failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function syncRemoveFromSqlite(
  rawTarget: "memory" | "user" | "project" | "failure",
  oldText: string,
  dbManager: DatabaseManager | null,
  projectName?: string | null,
): Promise<string | null> {
  if (!dbManager) return null;

  try {
    const sqliteTarget = sqliteTargetFor(rawTarget);
    const sqliteProject = sqliteProjectFor(rawTarget, projectName);
    const syncResult = removeSyncedMemories(dbManager, oldText, {
      target: sqliteTarget,
      project: sqliteProject,
    });

    if (syncResult.matched === 0) {
      return "Saved to Markdown, but no matching SQLite memory row was removed. Run /memory-sync-markdown if search results look stale.";
    }

    return null;
  } catch (err) {
    return `Saved to Markdown, but SQLite search sync failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function syncEvictionsFromSqlite(
  rawTarget: "memory" | "user" | "project" | "failure",
  evictedEntries: string[] | undefined,
  dbManager: DatabaseManager | null,
  projectName?: string | null,
): Promise<void> {
  if (!dbManager) return;
  if (!evictedEntries || evictedEntries.length === 0) return;

  const sqliteTarget = sqliteTargetFor(rawTarget);
  const sqliteProject = sqliteProjectFor(rawTarget, projectName);

  for (const entry of evictedEntries) {
    try {
      removeExactSyncedMemories(dbManager, entry, {
        target: sqliteTarget,
        project: sqliteProject,
      });
    } catch {
      // FIFO already updated the Markdown source of truth. SQLite is only a
      // best-effort search mirror, so eviction cleanup must not fail the write.
    }
  }
}

export function registerMemoryTool(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  dbManager: DatabaseManager | null = null,
  projectName?: string | null,
): void {
  pi.registerTool({
    name: "memory",
    label: "Memory",
    description: MEMORY_TOOL_DESCRIPTION,
    promptSnippet:
      "Save or manage persistent memory that survives across sessions",
    promptGuidelines: [
      "Use memory proactively when the user corrects you, shares a preference or personal details, or you discover environment facts, conventions, or reusable patterns worth keeping across sessions.",
      "Do NOT use memory for temporary task state, TODOs, or session progress — only durable, cross-session facts.",
      "Use target='failure' with category to save what didn't work (failures, corrections, insights).",
    ],
    parameters: Type.Object({
      action: StringEnum(["add", "replace", "remove", "transfer"] as const),
      target: StringEnum(["memory", "user", "project", "failure"] as const),
      content: Type.Optional(
        Type.String({ description: "Entry content for add/replace" })
      ),
      old_text: Type.Optional(
        Type.String({
          description:
            "Substring identifying entry for replace/remove",
        })
      ),
      query: Type.Optional(
        Type.String({
          description:
            "Substring to match entries for transfer. Omit to transfer all entries from the target.",
        })
      ),
      category: Type.Optional(
        StringEnum(["failure", "correction", "insight", "preference", "convention", "tool-quirk"] as const, {
          description: "Category for failure memories",
        })
      ),
      failure_reason: Type.Optional(
        Type.String({ description: "Why it failed (for failure category)" })
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { action, target: rawTarget, content, old_text, query, category, failure_reason } = params;

      // Route 'project' to projectStore using the normal MEMORY.md target.
      const target = rawTarget === "project" ? "memory" : rawTarget as "memory" | "user" | "failure";
      const activeStore = rawTarget === "project" ? projectStore : store;

      if (rawTarget === "project" && !projectStore) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: "Project memory is not available (no project detected)." }) }],
          details: {},
        };
      }

      // After the guard above, activeStore is guaranteed non-null when rawTarget === 'project'
      const store_ = activeStore!;

      let result: MemoryResult;
      let syncWarning: string | null = null;
      switch (action) {
        case "add":
          if (!content) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: "Content is required for 'add' action.",
                  }),
                },
              ],
              details: {},
            };
          }
          // Handle failure target with category
          if (rawTarget === "failure") {
            const memoryCategory = (category || "failure") as MemoryCategory;
            result = await store_.addFailure(content, {
              category: memoryCategory,
              failureReason: failure_reason,
            });
            if (result.success) {
              syncWarning = await syncAddToSqlite(rawTarget, content, memoryCategory, failure_reason, dbManager, projectName);
            }
          } else {
            result = await store_.add(target, content);
            if (result.success) {
              await syncEvictionsFromSqlite(rawTarget, result.evicted_entries, dbManager, projectName);
              syncWarning = await syncAddToSqlite(rawTarget, content, undefined, undefined, dbManager, projectName);
            }
          }
          break;

        case "replace":
          if (!old_text) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: "old_text is required for 'replace' action.",
                  }),
                },
              ],
              details: {},
            };
          }
          if (!content) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: "content is required for 'replace' action.",
                  }),
                },
              ],
              details: {},
            };
          }
          result = await store_.replace(target, old_text, content);
          if (result.success) {
            syncWarning = await syncReplaceToSqlite(rawTarget, old_text, content, dbManager, projectName);
          }
          break;

        case "remove":
          if (!old_text) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: "old_text is required for 'remove' action.",
                  }),
                },
              ],
              details: {},
            };
          }
          result = await store_.remove(target, old_text);
          if (result.success) {
            syncWarning = await syncRemoveFromSqlite(rawTarget, old_text, dbManager, projectName);
          }
          break;

        case "transfer":
          if (rawTarget === "project") {
            return {
              content: [{ type: "text", text: JSON.stringify({ success: false, error: "Transfer is not supported for project target. Use 'memory', 'user', or 'failure'." }) }],
              details: {},
            };
          }
          result = await store_.transferEntries(target, query);
          if (result.success && result.transferred_entries && result.transferred_entries.length > 0) {
            // Write a .knowledge.jsonl archive (audit trail / fallback)
            const archivePath = writeTransferArchive(target, result.transferred_entries);
            result = { ...result, archive_path: archivePath };

            // Single-hop convergence: ingest the entries directly into the
            // default vault as atomic zettel cards. Stays standalone-safe —
            // if pi-knowledge-card is absent, converge returns unavailable and
            // the formatter falls back to the archive-handoff message.
            const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
            const converge = await convergeToVault(
              result.transferred_entries,
              target,
              cwd,
              projectName,
            );

            // Sync removal to SQLite — use exact match to avoid overly broad removal
            if (dbManager) {
              const sqliteTarget = sqliteTargetFor(rawTarget);
              const sqliteProject = sqliteProjectFor(rawTarget, projectName);
              for (const entry of result.transferred_entries) {
                try {
                  removeExactSyncedMemories(dbManager, entry, {
                    target: sqliteTarget,
                    project: sqliteProject,
                  });
                } catch {
                  // Best-effort SQLite sync only
                }
              }
            }

            return {
              content: [{ type: "text", text: formatTransferResult(result, archivePath, converge) }],
              details: { ...result, converge },
            };
          }
          break;

        default:
          result = {
            success: false,
            error: `Unknown action '${action}'. Use: add, replace, remove, transfer`,
          };
      }

      if (syncWarning && result.success) {
        result = appendSyncWarning(result, syncWarning);
      }

      // Tag project results so the caller knows the scope
      if (rawTarget === "project" && result.success) {
        result = {
          ...result,
          target: "project",
        };
      }

      return {
        content: [{ type: "text", text: formatMemoryToolText(result) }],
        details: result,
      };
    },
  });
}
