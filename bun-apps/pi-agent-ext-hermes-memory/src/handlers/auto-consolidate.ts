/**
 * Auto-consolidation — when memory hits capacity, trigger automatic
 * consolidation instead of returning an error.
 *
 * Consolidation runs in-process via the shared `spawnSubagent` runner
 * (sub-project ①). The child subagent is handed the parent's `memory` tool
 * through `extensionTools` bridging — the `ToolDefinition` captured from
 * `registerMemoryTool`; its `execute` closure binds the parent `MemoryStore`,
 * so the child's writes land in the parent store directly. That is the same
 * end effect as the old `pi -p` subprocess (`-e <own-extension>`) without the
 * OS-process boundary. The store is still reloaded from disk after
 * consolidation completes as a belt-and-suspenders mirror.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { spawnSubagent } from "@repo/pi-agent-ext-subagent/src/index.ts";
import type { SpawnSubagentResult } from "@repo/pi-agent-ext-subagent/src/index.ts";
import { MemoryStore } from "../store/memory-store.js";
import { CONSOLIDATION_PROMPT, ENTRY_DELIMITER } from "../constants.js";
import type { ConsolidationResult, MemoryConfig } from "../types.js";

type MemoryTarget = "memory" | "user" | "failure";
type ToolMemoryTarget = MemoryTarget | "project";
type ChildLlmConfig = Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride">;

/**
 * Resolve the model-id the consolidator will actually use, for display in
 * progress notifications. With spawnSubagent the child resolves its model from
 * the `tier` config (or inherits the live session model when none is set); this
 * label is informational only and best-effort mirrors that resolution:
 *   1. llmModelOverride wins (it would be threaded through as `model`).
 *   2. Otherwise the child inherits the parent env and pi uses PI_MODEL
 *      (qualified by PI_PROVIDER) when no tier/model is given.
 *   3. "default" when neither is present.
 */
export function resolveConsolidatorModelLabel(config: ChildLlmConfig): string {
  const override = config.llmModelOverride?.trim();
  if (override) return override;
  const model = process.env.PI_MODEL;
  const provider = process.env.PI_PROVIDER;
  if (model) return provider ? `${provider}/${model}` : model;
  return "default";
}

function entriesForTarget(store: MemoryStore, target: MemoryTarget): string[] {
  if (target === "user") return store.getUserEntries();
  if (target === "failure") return store.getAllFailureEntries();
  return store.getMemoryEntries();
}

function labelForTarget(target: MemoryTarget, toolTarget: ToolMemoryTarget): string {
  if (toolTarget === "project") return "Project Memory";
  if (target === "user") return "User Profile";
  if (target === "failure") return "Failure Memory";
  return "Memory";
}

function describeConsolidationFailure(result: SpawnSubagentResult, timeoutMs: number): string {
  const stderr = result.stderr?.trim();
  const terminated = result.timedOut;

  if (terminated) {
    return `Consolidation subprocess was terminated (likely timeout or cancellation). Timeout: ${timeoutMs}ms. Consider increasing consolidationTimeoutMs if this is a manual run.`;
  }

  // spawnSubagent reports a failure via `stderr` + `exitCode` (a transient
  // abort/timeout also sets `timedOut`, handled above). On a non-zero exit with
  // empty stderr the runner gave us nothing to surface — fall back to a generic
  // descriptor that still names the exit code instead of an opaque "unknown
  // error", so a bare non-zero run is at least diagnosable.
  const detail = stderr?.slice(0, 200) || `runner exited (code ${result.exitCode})`;
  return `Consolidation process exited with code ${result.exitCode}: ${detail}`;
}

export async function triggerConsolidation(
  store: MemoryStore,
  target: MemoryTarget,
  memoryToolDef: ToolDefinition,
  signal?: AbortSignal,
  timeoutMs: number = 60000,
  toolTarget: ToolMemoryTarget = target,
  llmConfig: Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride"> = {},
  spawn: typeof spawnSubagent = spawnSubagent,
): Promise<ConsolidationResult> {
  const entries = entriesForTarget(store, target);
  const currentContent = entries.join(ENTRY_DELIMITER);

  const prompt = [
    CONSOLIDATION_PROMPT,
    "",
    `--- Current ${labelForTarget(target, toolTarget)} Entries ---`,
    currentContent || "(empty)",
    "",
    `Use the memory tool to consolidate. Target: '${toolTarget}'`,
  ].join("\n");

  try {
    // llmThinkingOverride has no spawnSubagent equivalent — inert under the migration.
    const modelOverride = llmConfig.llmModelOverride?.trim();
    const result = await spawn({
      task: prompt,
      // Honor llmModelOverride when set (keeps resolveConsolidatorModelLabel
      // honest); otherwise fall back to the small tier.
      ...(modelOverride ? { model: modelOverride } : { tier: "small" }),
      instructions:
        "You are a memory consolidator. Use ONLY the memory tool to merge/dedup entries as instructed. Do not read or modify any files.",
      tools: ["memory"],
      extensionTools: [memoryToolDef],
      timeoutMs,
      externalSignal: signal,
      // Consolidation runs WHILE the parent holds the cross-process fileLock on
      // the target (so the in-process child, which bypasses the lock, is the
      // sole writer). The in-process spawnSubagent classifies a timeout (signal
      // abort) as `transient` and would RETRY it — re-running the consolidator
      // for another full timeout while STILL holding the lock, starving every
      // concurrent sibling-agent writer for ~2× the timeout (perf.jsonl: 120s
      // = 60s + 60s, with 144s / 998s outliers). A timed-out merge is
      // best-effort (falls through to the vault-offload floor), so retrying
      // only re-holds the lock and re-fails. Opt OUT of transient retry.
      retryOnTransient: false,
    });
    if (result.exitCode === 0) {
      store.loadFromDisk(); // mirror today's post-child reload
      return { consolidated: true };
    }
    return { consolidated: false, error: describeConsolidationFailure(result, timeoutMs), terminated: result.timedOut };
  } catch (err) {
    return { consolidated: false, error: `Consolidation failed: ${String(err).slice(0, 200)}` };
  }
}

/**
 * Register the /memory-consolidate command for manual consolidation.
 */
export function registerConsolidateCommand(
  pi: ExtensionAPI,
  store: MemoryStore,
  memoryToolDef: ToolDefinition,
  timeoutMs: number = 60000,
  projectStore: MemoryStore | null = null,
  projectName?: string | null,
  llmConfig: Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride"> = {},
  heartbeatMs: number = 15000,
  spawn: typeof spawnSubagent = spawnSubagent,
): void {
  pi.registerCommand("memory-consolidate", {
    description: "Manually trigger memory consolidation to free up space",
    handler: async (_args, ctx) => {
      const manualTimeoutMs = Math.max(timeoutMs, 180000);
      const results: string[] = [];
      const targets: Array<{
        label: string;
        store: MemoryStore;
        target: MemoryTarget;
        toolTarget: ToolMemoryTarget;
      }> = [
        { label: "memory", store, target: "memory", toolTarget: "memory" },
        { label: "user", store, target: "user", toolTarget: "user" },
        { label: "failure", store, target: "failure", toolTarget: "failure" },
      ];

      if (projectStore) {
        targets.push({
          label: projectName ? `project:${projectName}` : "project",
          store: projectStore,
          target: "memory",
          toolTarget: "project",
        });
      }

      const modelLabel = resolveConsolidatorModelLabel(llmConfig);
      try {
        ctx.ui.notify(
          `🔄 Starting memory consolidation for ${targets.length} target${targets.length === 1 ? "" : "s"} · model ${modelLabel}...`,
          "info",
        );
      } catch {
        // Best-effort only. If the command context is already stale, continue
        // with the consolidation work rather than failing before it starts.
      }

      for (let idx = 0; idx < targets.length; idx++) {
        const item = targets[idx];
        const entries = entriesForTarget(item.store, item.target);

        if (entries.length === 0) {
          results.push(`${item.label}: (empty, nothing to consolidate)`);
          continue;
        }

        // Per-note streaming is infeasible here: each target consolidates via a
        // single opaque subagent run that only returns on completion. Surface
        // the best feasible signal instead — which target we're on out of the
        // total, plus the magnitude (entry count) of the current work.
        const noteCount = `${entries.length} note${entries.length === 1 ? "" : "s"}`;
        const progressLabel = `${item.label} (${idx + 1}/${targets.length}) · ${noteCount} · ${modelLabel}`;

        try {
          ctx.ui.notify(
            `⏳ Consolidating ${progressLabel}...`,
            "info",
          );
        } catch {
          // Best-effort progress feedback only.
        }

        const t0 = Date.now();
        const beat = setInterval(() => {
          try {
            ctx.ui.notify(`⏳ Consolidating ${progressLabel}… ${Math.round((Date.now() - t0) / 1000)}s elapsed`, "info");
          } catch {
            // Stale ctx (session reload mid-consolidation) — best-effort only.
          }
        }, heartbeatMs);
        let result: ConsolidationResult;
        try {
          result = await triggerConsolidation(
            item.store,
            item.target,
            memoryToolDef,
            ctx.signal,
            manualTimeoutMs,
            item.toolTarget,
            llmConfig,
            spawn,
          );
        } finally {
          clearInterval(beat);
        }

        if (result.consolidated) {
          await item.store.loadFromDisk();
          results.push(`${item.label}: ✅ consolidated`);
        } else {
          results.push(`${item.label}: ❌ ${result.error}`);
        }
      }

      const summary = `\n  🔄 Memory Consolidation\n  ${"─".repeat(30)}\n${results.map((r) => `  ${r}`).join("\n")}`;

      try {
        ctx.ui.notify(summary, "info");
      } catch {
        // Child consolidation can indirectly trigger a runtime reload/session
        // replacement. If that happens, the original command ctx is stale by
        // the time we reach the final summary, so the command should exit
        // quietly instead of surfacing a stale-ctx error.
      }
    },
  });
}
