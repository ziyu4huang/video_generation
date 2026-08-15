// @ts-nocheck — pre-existing type errors, never checked before this file
// became reachable via pi-agent's static import (src/static-extensions.ts);
// see that file's header comment for the full rationale. Runtime unaffected
// (Bun doesn't enforce types).
/**
 * Memory tool — registers the LLM-callable `memory` tool.
 * Ported from hermes-agent/tools/memory_tool.py (MEMORY_SCHEMA + memory_tool dispatch).
 * See PLAN.md → "Hermes Source File Reference Map" for source lines.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { MemoryStore } from "../store/memory-store.js";
import { formatFailureMemoryContent, normalizeFailureState } from "../store/memory-format.js";
import type { CardStore } from "../store/card-store.js";
import {
  mirrorMemoryAdd,
  mirrorMemoryReplace,
  mirrorMemoryRemove,
  mirrorMemoryEvictions,
} from "../store/memory-card-mirror.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { MEMORY_TOOL_DESCRIPTION, DEFAULT_STALENESS_THRESHOLD_DAYS } from "../constants.js";
import type { FailureState, MemoryCategory, MemoryResult } from "../types.js";
import { fireProactiveIfReady } from "../handlers/auto-consolidate.js";
import { isConsolidatingChild, loadConfig } from "../config.js";

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
export function writeTransferArchive(
  target: "memory" | "user" | "failure",
  entries: string[],
  archiveDir: string = pathJoin(tmpdir(), "pi-memory-archive"),
): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const suffix = Math.random().toString(36).slice(2, 8);
  mkdirSync(archiveDir, { recursive: true });

  const jsonlPath = pathJoin(archiveDir, `memory-transfer-${target}-${ts}-${suffix}.knowledge.jsonl`);

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

  // ── Archive handoff (convergence moved to the hub — ADR-0001) ──
  // Entries are archived for audit; the knowledge-card hub auto-converges
  // hermes memory into the graph on session_shutdown. The archive stays as a
  // manual-converge fallback.
  if (archivePath) {
    lines.push(`Archive file: ${archivePath}`);
    lines.push("");
    lines.push("Entries auto-converge into the knowledge graph on session shutdown (knowledge-card hub).");
    lines.push(`To converge manually now: zk_ingest --files "${archivePath}"`);
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

  // One-line summary for the common cases (success without rotation, and
  // failure). Previously this fell through to raw JSON.stringify, dumping
  // {"success":true,"target":...,"usage":...} into the TUI — unreadable.
  return formatMemoryResultLine(result);
}

function formatMemoryResultLine(result: MemoryResult): string {
  const target = result.target ? `${result.target} memory` : null;
  if (!result.success) {
    const detail = result.error ?? result.message ?? "Operation failed";
    return target ? `✗ ${target}: ${detail}` : `✗ ${detail}`;
  }
  const head = result.message ?? "Done";
  const targetSuffix = target ? ` → ${target}` : "";
  const meta: string[] = [];
  if (typeof result.entry_count === "number") {
    meta.push(`${result.entry_count} ${result.entry_count === 1 ? "entry" : "entries"}`);
  }
  if (result.usage) meta.push(result.usage);
  if (result.warning) meta.push(`⚠ ${result.warning}`);
  const metaStr = meta.length > 0 ? ` · ${meta.join(" · ")}` : "";
  return `✓ ${head}${targetSuffix}${metaStr}`;
}

/** Build a tool response carrying a human-readable `text` for the TUI and the
 * structured `details` for programmatic/test consumers. Use for error paths. */
function memoryErrorResponse(error: string): { content: Array<{ type: "text"; text: string }>; details: MemoryResult } {
  const result: MemoryResult = { success: false, error };
  return { content: [{ type: "text", text: formatMemoryResultLine(result) }], details: result };
}

function sqliteTargetFor(rawTarget: "memory" | "user" | "project" | "failure"): "memory" | "user" | "failure" {
  if (rawTarget === "project") return "memory";
  return rawTarget;
}

// ── kp13 Wave B: the memory-kind DB mirror goes through the bundle CardStore
// (md_id-keyed upsert/update/delete; dedup rides upsertCard's registered
// MemoryDedupStrategy). The legacy memoryRepo.syncMemoryEntry content-keyed
// mirror is retired from this path — syncMemoryEntry stays on the repository
// interface for sessions + non-memory uses. md stays canonical: MemoryStore
// still owns MEMORY.md/USER.md/failures.md.
async function syncAddToCardStore(
  rawTarget: "memory" | "user" | "project" | "failure",
  content: string,
  category: MemoryCategory | undefined,
  failureReason: string | undefined,
  cardStore: CardStore | null,
  mdId?: string | null,
  state?: FailureState,
  severity?: number | null,
): Promise<string | null> {
  if (!cardStore) return null;

  try {
    const kind = sqliteTargetFor(rawTarget);

    if (rawTarget === "failure") {
      const failureCategory = category ?? "failure";
      await mirrorMemoryAdd(cardStore, "failure", {
        mdId,
        content: formatFailureMemoryContent(content, {
          category: failureCategory,
          failureReason,
        }),
        ...(state ? { state } : {}),
        ...(typeof severity === "number" ? { severity } : {}),
      });
      return null;
    }

    await mirrorMemoryAdd(cardStore, kind, {
      mdId,
      content,
    });
    return null;
  } catch (err) {
    return `Saved to Markdown, but search store sync failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function syncReplaceToCardStore(
  rawTarget: "memory" | "user" | "project" | "failure",
  oldText: string,
  newContent: string,
  cardStore: CardStore | null,
  mdId?: string | null,
  state?: FailureState,
  severity?: number | null,
): Promise<string | null> {
  if (!cardStore) return null;

  try {
    const matched = await mirrorMemoryReplace(cardStore, sqliteTargetFor(rawTarget), oldText, {
      mdId,
      content: newContent,
      ...(state ? { state } : {}),
      ...(typeof severity === "number" ? { severity } : {}),
    });

    if (matched === 0) {
      return "Saved to Markdown, but no matching search store row was updated. Run /memory-sync-markdown if search results look stale.";
    }

    return null;
  } catch (err) {
    return `Saved to Markdown, but search store sync failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function syncRemoveFromCardStore(
  rawTarget: "memory" | "user" | "project" | "failure",
  oldText: string,
  cardStore: CardStore | null,
): Promise<string | null> {
  if (!cardStore) return null;

  try {
    const matched = await mirrorMemoryRemove(cardStore, sqliteTargetFor(rawTarget), oldText);

    if (matched === 0) {
      return "Saved to Markdown, but no matching search store row was removed. Run /memory-sync-markdown if search results look stale.";
    }

    return null;
  } catch (err) {
    return `Saved to Markdown, but search store sync failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── kp13 Wave C: the memory-kind DB mirror is FULLY on the bundle CardStore —
// adds/replaces/removes via the md_id-keyed mirror helpers, and
// eviction/offload/transfer cleanup via mirrorMemoryEvictions (deleteCard by
// md_id; ids are globally unique so no target/project scope is needed). The
// legacy memoryRepo.removeByMdId loop is deleted — this tool holds NO
// memoryRepo seam anymore. md stays canonical: MemoryStore still owns
// MEMORY.md/USER.md/failures.md. syncMemoryEntry & co stay on the repository
// interface for sessions + non-memory uses (memory-mirror sole-source gate).

// ─── Staleness audit helpers (pure logic lives in staleness.ts) ─────────────
import { formatStalenessAudit } from "../staleness.js";

export function registerMemoryTool(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  projectName?: string | null,
  cardStore: CardStore | null = null,
): ToolDefinition {
  // Proactive-consolidation trigger gate (Task 4 / UPSP §1). memory-tool.ts
  // has no config in scope, and the wiring stays self-contained in this file
  // (the only caller, index.ts, is left untouched), so resolve the flag once
  // at registration from the same loadConfig() index.ts uses. The store is
  // constructed in index.ts from that same loadConfig() result, so this value
  // matches store.config.proactiveConsolidateEnabled (which the store also
  // re-checks as its own invariant inside maybeProactiveConsolidate).
  const proactiveConsolidateEnabled = loadConfig().proactiveConsolidateEnabled;
  const definition: ToolDefinition = {
    name: "memory",
    label: "Memory",
    gating: { core: true },
    description: MEMORY_TOOL_DESCRIPTION,
    parameters: Type.Object({
      action: StringEnum(["add", "replace", "remove", "transfer", "audit"] as const),
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
      state: Type.Optional(
        StringEnum(["active", "resolved", "acquired"] as const, {
          description: "Lifecycle state for failure entries (active|resolved|acquired). Default: active.",
        })
      ),
      severity: Type.Optional(
        Type.Number({
          description: "Advisory severity (1–3) for failure entries. Dropped when outside 1–3.",
        })
      ),
      older_than: Type.Optional(
        Type.Number({
          description: `Audit only: flag entries whose last-edited date is older than this many days (default ${DEFAULT_STALENESS_THRESHOLD_DAYS}).`,
        })
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { action, target: rawTarget, content, old_text, query, category, failure_reason, state: rawState, severity: rawSeverity } = params;
      // Task 7: validate failure lifecycle state/severity at the tool boundary.
      // `state` is normalized via normalizeFailureState (invalid → active);
      // `severity` outside 1–3 is dropped (undefined → downstream default).
      const state = typeof rawState === "string" ? normalizeFailureState(rawState) : undefined;
      const severity = typeof rawSeverity === "number" && rawSeverity >= 1 && rawSeverity <= 3 ? rawSeverity : undefined;
      // Surface consolidation progress (e.g. the consolidator's model-id) to the
      // TUI as a partial result. Consolidation runs a local LLM and can hold the
      // file lock for up to ~60s; without this the memory tool call is a silent
      // spinner with no indication a model is running.
      const onProgress = onUpdate
        ? (message: string) => onUpdate({ content: [{ type: "text" as const, text: message }], details: {} })
        : undefined;

      // Route 'project' to projectStore using the normal MEMORY.md target.
      const target = rawTarget === "project" ? "memory" : rawTarget as "memory" | "user" | "failure";
      const activeStore = rawTarget === "project" ? projectStore : store;

      if (rawTarget === "project" && !projectStore) {
        return memoryErrorResponse("Project memory is not available (no project detected).");
      }

      // After the guard above, activeStore is guaranteed non-null when rawTarget === 'project'
      const store_ = activeStore!;

      let result: MemoryResult;
      let syncWarning: string | null = null;
      switch (action) {
        case "add":
          if (!content) {
            return memoryErrorResponse("Content is required for 'add' action.");
          }
          // Handle failure target with category
          if (rawTarget === "failure") {
            const memoryCategory = (category || "failure") as MemoryCategory;
            result = await store_.addFailure(content, {
              category: memoryCategory,
              failureReason: failure_reason,
              ...(state ? { state } : {}),
              ...(typeof severity === "number" ? { severity } : {}),
              onProgress,
            });
            if (result.success) {
              syncWarning = await syncAddToCardStore(rawTarget, content, memoryCategory, failure_reason, cardStore, result.added_md_id, state, severity);
            }
          } else {
            result = await store_.add(target, content, { onProgress });
            if (result.success) {
              // Task 4 / UPSP §1: fires-after-write proactive consolidation.
              // Fire-and-forget (void + .catch): the write already succeeded, so
              // this MUST NOT block the return or break on a proactive failure.
              // The enable + in-flight gate lives in the helper; the store's
              // maybeProactiveConsolidate owns cooldown/pressure/selection.
              fireProactiveIfReady(store_, target, {
                enabled: proactiveConsolidateEnabled,
                inFlight: isConsolidatingChild,
              });
              // Steady-state DB-sync keys on md_id (ticket 04). evicted_md_ids
              // carries the stable frontmatter ids; offloaded_superseded is
              // ALREADY md_id-only (no archive/display consumer — destructive).
              await mirrorMemoryEvictions(cardStore, result.evicted_md_ids);
              await mirrorMemoryEvictions(cardStore, result.offloaded_superseded);
              // Task 7 / F1: thread the birth id so the card row's id == the
              // `.md` frontmatter id (live-in-session bridge, not just restart).
              syncWarning = await syncAddToCardStore(rawTarget, content, undefined, undefined, cardStore, result.added_md_id);
            }
          }
          break;

        case "replace":
          if (!old_text) {
            return memoryErrorResponse("old_text is required for 'replace' action.");
          }
          if (!content) {
            return memoryErrorResponse("content is required for 'replace' action.");
          }
          result = await store_.replace(target, old_text, content);
          if (result.success) {
            syncWarning = await syncReplaceToCardStore(rawTarget, old_text, content, cardStore, result.added_md_id, state, severity);
          }
          break;

        case "remove":
          if (!old_text) {
            return memoryErrorResponse("old_text is required for 'remove' action.");
          }
          result = await store_.remove(target, old_text);
          if (result.success) {
            syncWarning = await syncRemoveFromCardStore(rawTarget, old_text, cardStore);
          }
          break;

        case "transfer":
          if (rawTarget === "project") {
            return memoryErrorResponse("Transfer is not supported for project target. Use 'memory', 'user', or 'failure'.");
          }
          result = await store_.transferEntries(target, query);
          if (result.success && result.transferred_entries && result.transferred_entries.length > 0) {
            // Write a .knowledge.jsonl archive (audit trail / fallback)
            const archivePath = writeTransferArchive(target, result.transferred_entries);
            result = { ...result, archive_path: archivePath };

            // (Convergence moved to the knowledge-card hub — ADR-0001.
            //  Hub auto-converges hermes memory on session_shutdown.)

            // Sync removal to the store by md_id (ticket 04: full replace, no
            // content-key fallback). writeTransferArchive above already consumed
            // the CONTENT field (transferred_entries); the DB-sync uses the
            // parallel transferred_md_ids field. kp13 Wave C: deleteCard by
            // md_id via the card-store mirror (the legacy memoryRepo.removeByMdId
            // loop is retired — per-id best-effort inside the helper).
            await mirrorMemoryEvictions(cardStore, result.transferred_md_ids ?? []);

            return {
              content: [{ type: "text", text: formatTransferResult(result, archivePath) }],
              details: { ...result },
            };
          }
          break;

        case "audit": {
          const threshold = params.older_than ?? DEFAULT_STALENESS_THRESHOLD_DAYS;
          const report = formatStalenessAudit(
            store_,
            threshold,
            rawTarget === "project" ? (projectName ?? null) : null,
          );
          return {
            content: [{ type: "text", text: report }],
            details: { success: true, action: "audit", threshold, store: rawTarget },
          };
        }

        default:
          result = {
            success: false,
            error: `Unknown action '${action}'. Use: add, replace, remove, transfer, audit`,
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
  };
  pi.registerTool(definition);
  return definition;
}
