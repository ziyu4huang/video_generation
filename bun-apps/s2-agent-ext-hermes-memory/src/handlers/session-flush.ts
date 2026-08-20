/**
 * Session flush — gives the agent one turn to save memories before context is lost.
 * Ported from hermes-agent/run_agent.py (flush_memories).
 * See PLAN.md → "Hermes Source File Reference Map" for source lines.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { roleAwareDirectCall, spawnSubagent } from "@repo/s2-agent-core-runtime";
import { MemoryStore } from "../store/memory-store.js";
import { FLUSH_PROMPT } from "../constants.js";
import type { MemoryConfig } from "../types.js";
import { collectMessageParts } from "./message-parts.js";

export function setupSessionFlush(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  config: MemoryConfig,
  memoryToolDef?: ToolDefinition,
  spawn: typeof spawnSubagent = spawnSubagent,
): void {
  let userTurnCount = 0;

  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role === "user") userTurnCount++;
  });

  /** Shared flush logic — builds conversation snapshot and spawns a one-shot
   *  reviewer subagent bridged with the parent memory tool. */
  async function flush(ctx: any, signal?: AbortSignal, timeoutMs = 30000): Promise<void> {
    if (userTurnCount < config.flushMinTurns) return;

    let entries;
    try {
      entries = ctx.sessionManager.getBranch();
    } catch {
      return; // Context already stale
    }

    const parts = collectMessageParts(entries, config.flushRecentMessages);
    const flushMessage = [
      FLUSH_PROMPT,
      "",
      "--- Conversation ---",
      parts.join("\n\n"),
    ].join("\n");

    try {
      if (!memoryToolDef) return;
      // llmThinkingOverride has no spawnSubagent equivalent — inert under the migration.
      const modelOverride = config.llmModelOverride?.trim();
      // 2026-08-18 envelope closure (#1652/#1654/#1655 companion): direct
      // spawnSubagent calls bypass the tool-seam role bounds — same gap
      // class. roleAwareDirectCall carries the caps and the abort-safety
      // footer together; the tighter local timeoutMs wins over the envelope
      // wall. SUBAGENT_TOKEN_BUDGET_DISABLE escape hatch honored (computed at
      // call time). Computed here — not module scope — so the env flag is
      // read at call time.
      const d = roleAwareDirectCall("writer", flushMessage, `hermes-session-flush-${Date.now()}`);
      await spawn({
        task: d.task,
        ...(modelOverride ? { model: modelOverride } : { tier: "small" }),
        instructions: "Use ONLY the memory tool to save memories before context is lost. Do not read or modify files.",
        tools: ["memory"],
        extensionTools: [memoryToolDef],
        tokenBudget: d.tokenBudget,
        maxTurns: d.maxTurns,
        timeoutMs,
        // Forward the host signal (compact path) so a cancellation propagates;
        // shutdown path passes undefined. Brief omitted this, but it is the
        // spawn equivalent of the old child-process `signal` option and keeps
        // behavior parity with the correction-detector / consolidation spawns.
        externalSignal: signal,
        retryOnTransient: false, // shutdown path — do not retry
      });
    } catch {
      // Best-effort flush — never block shutdown
    }
  }

  // Flush before compaction (can afford to wait)
  pi.on("session_before_compact", async (event, ctx) => {
    if (!config.flushOnCompact) return;
    await flush(ctx, event.signal, 30000);
  });

  // Flush before session shutdown (must be fast, non-blocking)
  pi.on("session_shutdown", async (event, ctx) => {
    if (!config.flushOnShutdown) return;
    // Fire-and-forget with a short timeout so we don't block Pi's shutdown.
    // We intentionally do NOT await — Pi should not wait for the child process.
    flush(ctx, undefined, 10000).catch(() => {});
  });
}
