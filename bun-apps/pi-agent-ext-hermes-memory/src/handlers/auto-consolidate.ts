/**
 * Auto-consolidation — when memory hits capacity, trigger automatic
 * consolidation instead of returning an error.
 *
 * Uses pi.exec() to spawn a one-shot consolidation process.
 * The child process modifies files on disk, so the parent MUST reload
 * from disk after consolidation completes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { CONSOLIDATION_PROMPT, ENTRY_DELIMITER } from "../constants.js";
import type { ConsolidationResult, MemoryConfig } from "../types.js";
import { execChildPrompt } from "./pi-child-process.js";

type MemoryTarget = "memory" | "user" | "failure";
type ToolMemoryTarget = MemoryTarget | "project";
type ChildLlmConfig = Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride">;

/**
 * Resolve the model-id the consolidator subprocess will actually use, for
 * display in progress notifications. Mirrors execChildPrompt's resolution:
 *   1. llmModelOverride wins (passed to the child as --model).
 *   2. Otherwise the child inherits the parent env and pi uses PI_MODEL
 *      (qualified by PI_PROVIDER) when no --model flag is given.
 *   3. "default" when neither is present — the child then falls back to pi's
 *      settings defaultModel, which we don't read here to avoid extra I/O.
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

function describeConsolidationFailure(
  result: { code: number; stdout?: string; stderr?: string; killed?: boolean },
  timeoutMs: number,
): string {
  const stderr = result.stderr?.trim();
  const stdout = result.stdout?.trim();
  const terminated = result.killed || result.code === 143;

  if (terminated) {
    return `Consolidation subprocess was terminated (likely timeout or cancellation). Timeout: ${timeoutMs}ms. Consider increasing consolidationTimeoutMs if this is a manual run.`;
  }

  // Surface stderr first (the usual error channel), then fall back to stdout —
  // a child that fails to even start (e.g. a broken launcher shim printing
  // "Module not found") may emit its real error on stdout with empty stderr,
  // which must not collapse to an opaque "unknown error".
  const detail = (stderr || stdout)?.slice(0, 200) || "unknown error";
  return `Consolidation process exited with code ${result.code}: ${detail}`;
}

export async function triggerConsolidation(
  pi: ExtensionAPI,
  store: MemoryStore,
  target: MemoryTarget,
  signal?: AbortSignal,
  timeoutMs: number = 60000,
  toolTarget: ToolMemoryTarget = target,
  llmConfig: Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride"> = {},
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
    const result = await execChildPrompt(pi, prompt, llmConfig, {
      signal,
      timeoutMs,
      retryWithoutOverrides: true,
    }) as { code: number; stdout?: string; stderr?: string; killed?: boolean };

    if (result.code === 0) {
      return { consolidated: true };
    }
    return {
      consolidated: false,
      error: describeConsolidationFailure(result, timeoutMs),
    };
  } catch (err) {
    return {
      consolidated: false,
      error: `Consolidation failed: ${String(err).slice(0, 200)}`,
    };
  }
}

/**
 * Register the /memory-consolidate command for manual consolidation.
 */
export function registerConsolidateCommand(
  pi: ExtensionAPI,
  store: MemoryStore,
  timeoutMs: number = 60000,
  projectStore: MemoryStore | null = null,
  projectName?: string | null,
  llmConfig: Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride"> = {},
  heartbeatMs: number = 15000,
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

        // Per-note streaming is infeasible here: each target consolidates via
        // a single opaque LLM subprocess (pi.exec) that only returns on exit.
        // Surface the best feasible signal instead — which target we're on out
        // of the total, plus the magnitude (entry count) of the current work.
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
            pi,
            item.store,
            item.target,
            ctx.signal,
            manualTimeoutMs,
            item.toolTarget,
            llmConfig,
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
