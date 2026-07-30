/**
 * Worth-scoring trigger — the session-outcome half of memory-worth accounting.
 *
 * Pairs with MemoryRepository.bumpMemoryWorth (the DB-only worth mutator from
 * Plan 2). At `message_end` we flag whether the user's message was a
 * correction (reusing the EXPORTED `isCorrection` predicate from
 * correction-detector.ts — single source of truth for correction detection).
 * At `turn_end` we drain the shared RecallSet (populated by touchMemory /
 * memory_search recall) and bump each recalled memory's worth:
 *   correction turn  → mw_fail++   (the recalled memory did NOT help)
 *   clean turn       → mw_success++ (the recalled memory helped)
 *
 * Best-effort, fully try/catch-wrapped — never blocks the session. Mirrors
 * correction-detector's safety envelope. DB-authoritative: no .md write-through.
 * The RecallSet is ALWAYS drained at turn_end (even when disabled) so it
 * cannot grow unbounded — touchMemory records unconditionally (Task 2).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryRepository } from "../store/repository.js";
import type { MemoryConfig } from "../types.js";
import { isCorrection } from "./correction-detector.js";
import { isLessonWorthy, extractResultText } from "./error-detector.js";
import { getMessageText } from "../types.js";

/** Per-turn set of memory ids recalled via memory_search (the touchMemory path). */
export class RecallSet {
  private readonly ids = new Set<number>();
  record(id: number): void { this.ids.add(id); }
  drain(): number[] { const out = [...this.ids]; this.ids.clear(); return out; }
}

/**
 * Bump memory-worth counters on session outcome. Records a `message_end` flag
 * (correction detected via isCorrection) and, at `turn_end`, drains the
 * recall-set and bumps each recalled memory: mw_fail++ if the turn had a
 * correction, else mw_success++. Best-effort, never blocks.
 * DB-authoritative (no .md write-through).
 */
export function setupWorthScoring(
  pi: ExtensionAPI,
  memoryRepo: MemoryRepository | null,
  recallSet: RecallSet,
  config: MemoryConfig,
): void {
  const enabled = config.worthScoring !== false;
  let hadCorrection = false;
  let hadError = false;

  pi.on("message_end", async (event) => {
    try {
      if (!enabled) return;
      if (event.message.role !== "user") return;
      const text = getMessageText(event.message);
      if (text && isCorrection(text, config)) hadCorrection = true;
    } catch {
      // Best-effort — never block the session
    }
  });

  pi.on("tool_result", async (event) => {
    try {
      if (!enabled) return;
      if (!event.isError) return;
      const text = extractResultText(event.content);
      if (isLessonWorthy(text)) hadError = true;
    } catch {
      // Best-effort — never block the session
    }
  });

  pi.on("turn_end", async () => {
    try {
      const ids = recallSet.drain(); // always drain (bounds the set even when disabled)
      if (!enabled || !memoryRepo || ids.length === 0) { hadCorrection = false; hadError = false; return; }
      const failed = hadCorrection || hadError;
      const successDelta = failed ? 0 : 1;
      const failDelta = failed ? 1 : 0;
      hadCorrection = false;
      hadError = false;
      for (const id of ids) {
        try { await memoryRepo.bumpMemoryWorth(id, successDelta, failDelta); } catch { /* best-effort per-id */ }
      }
    } catch {
      // never block the session
    }
  });
}
