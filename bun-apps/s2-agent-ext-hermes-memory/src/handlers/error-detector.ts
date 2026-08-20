/**
 * Error detection — auto-captures lesson-worthy tool errors to the failure
 * store WITHOUT an agent `memory` call (Stage 1 of the smart-knowledge-pipeline).
 *
 * The correction-detector already covers user TEXT corrections. This handler
 * covers the other half: tool RESULTS that failed. It hooks `tool_result`
 * (fires for every tool execution, with `isError` + content + toolName), and:
 *
 *   1. SEVERITY GATE — only captures errors that match a LESSON_WORTHY pattern
 *      (stack traces, definitive failures like ModuleNotFoundError / EADDRINUSE /
 *      command-not-found) AND not a NOISE pattern (grep no-match, exploratory
 *      path-not-found). This is the "captured on real error, not every non-zero
 *      exit" gate that keeps the store from flooding with trivial failures.
 *   2. DEDUP — a canonical key (normalised first error line) is checked against
 *      the existing failure store; the same error twice → one entry, not N.
 *   3. WRITE — adds a `failure`-category memory entry (the same path the
 *      correction-detector and background-review use), so the lesson is
 *      durable + searchable + converge-able to the vault.
 *
 * Pure helpers (`isLessonWorthy`, `errorDedupKey`, `errorSignature`) are
 * exported for testing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { formatFailureMemoryContent } from "../store/memory-format.js";
import type { MemoryRepository } from "../store/repository.js";
import type { CardStore } from "../store/card-store.js";
import { mirrorMemoryAdd } from "../store/memory-card-mirror.js";
import { CaptureThrottle } from "./capture-throttle.js";
import { envInt } from "../utils/env.js";
import {
  LESSON_WORTHY_PATTERNS,
  ERROR_NOISE_PATTERNS,
  DEFAULT_ERROR_CAPTURE_RATE_LIMIT,
  DEFAULT_ERROR_CAPTURE_RATE_WINDOW_MS,
  DEFAULT_ERROR_CAPTURE_DEDUP_CACHE_SIZE,
} from "../constants.js";
import type { MemoryConfig } from "../types.js";

/** A single text/image content block from a tool_result event. */
interface ContentBlock {
  type?: string;
  text?: string;
}

/** Extract all readable text from a tool_result event's content blocks. */
export function extractResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as ContentBlock[]) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/**
 * Is this error text lesson-worthy? True iff it matches a LESSON_WORTHY
 * pattern and NOT a NOISE pattern.
 */
export function isLessonWorthy(text: string): boolean {
  if (!text || !text.trim()) return false;
  for (const re of ERROR_NOISE_PATTERNS) {
    if (re.test(text)) return false;
  }
  for (const re of LESSON_WORTHY_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

/** The first line of `text` that matches a lesson-worthy pattern (or the first
 *  non-empty line as a fallback). Used as the human-readable failure reason. */
function firstLessonLine(text: string): string {
  const lines = text.split("\n");
  for (const line of lines) {
    if (LESSON_WORTHY_PATTERNS.some((re) => re.test(line))) return line.trim();
  }
  for (const line of lines) {
    if (line.trim()) return line.trim();
  }
  return "";
}

/**
 * Canonical normalisation of an error line: paths / numbers / quoted strings
 * collapse so the SAME error (different paths / counts) maps to ONE key.
 * Tool-name-agnostic — an ENOENT from bash and from read is the same lesson.
 */
function normalizeErrorLine(line: string): string {
  return line
    .replace(/^(\[[^\]]*\]\s*)+/, "") // strip leading [failure] [tool error] tags
    .replace(/"[^"]*"/g, '"\u2026')
    .replace(/'[^']*\/[^']*'/g, "'<path>'")
    .replace(/\/[\w./-]+(:\d+)?:?/g, "<path>")
    .replace(/\b\d+\b/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100)
    .toLowerCase();
}

/**
 * The dedup key for an error: the normalised first lesson-worthy line. Two
 * occurrences of the same error (even with different absolute paths / counts)
 * produce the SAME key → captured once, not N times.
 */
export function errorDedupKey(text: string): string {
  const line = firstLessonLine(text) || text.slice(0, 120);
  return normalizeErrorLine(line);
}

/** Human-readable signature (includes toolName) for logging / display. */
export function errorSignature(toolName: string, text: string): string {
  const line = firstLessonLine(text) || text.slice(0, 120);
  return `${toolName}: ${normalizeErrorLine(line)}`;
}

/**
 * Wire the error-capture hook. No-op when `config.errorCapture` is false.
 *
 * @param projectName scoped project name for project-aware failure entries.
 */
export function setupErrorDetector(
  pi: ExtensionAPI,
  store: MemoryStore,
  _projectStore: MemoryStore | null,
  config: MemoryConfig,
  memoryRepo: MemoryRepository | null = null,
  projectName?: string | null,
  // kp13 Wave B: the failure-mirror target — the bundle CardStore
  // (md_id-keyed upsert; dedup rides the registered MemoryDedupStrategy).
  // memoryRepo is kept in the signature for call-site stability but no
  // longer mirrors on this path — the legacy syncMemoryEntry mirror is
  // retired from the memory-kind hot path.
  cardStore: CardStore | null = null,
): void {
  if (config.errorCapture === false) return;

  const rateLimit = config.errorCaptureRateLimit ?? envInt("PI_MEMORY_ERROR_CAPTURE_RATE_LIMIT", DEFAULT_ERROR_CAPTURE_RATE_LIMIT);
  const rateWindowMs = config.errorCaptureRateWindowMs ?? envInt("PI_MEMORY_ERROR_CAPTURE_RATE_WINDOW_MS", DEFAULT_ERROR_CAPTURE_RATE_WINDOW_MS);
  const dedupCacheSize = config.errorCaptureDedupCacheSize ?? envInt("PI_MEMORY_ERROR_CAPTURE_DEDUP_CACHE_SIZE", DEFAULT_ERROR_CAPTURE_DEDUP_CACHE_SIZE);
  const throttle = new CaptureThrottle({ rateLimit, rateWindowMs, dedupCacheSize });

  pi.on("tool_result", async (event, ctx) => {
    // Only failed tool results are candidates.
    if (!event.isError) return;

    const text = extractResultText(event.content);
    if (!isLessonWorthy(text)) return;

    const dedupKey = errorDedupKey(text);
    if (!throttle.allow(dedupKey)) return; // ① this-session dup OR ③ rate-capped

    // DEDUP GUARD — skip if an existing failure entry already carries this
    // error (cross-session; same error twice across sessions → one entry).
    try {
      const existing = store.getFailureEntries(30);
      if (existing.some((e) => errorDedupKey(e) === dedupKey)) {
        return; // ② cross-session dup — does NOT consume a rate slot (no recordCapture)
      }
    } catch {
      // best-effort dedup; never block the capture on a read failure
    }

    const reason = firstLessonLine(text).slice(0, 200) || errorSignature(event.toolName, text);
    const scopedProject = projectName?.trim() || undefined;
    try {
      const content = `[${event.toolName} error] ${reason}`;
      const addResult = await store.addFailure(content, {
        category: "failure",
        failureReason: reason,
        project: scopedProject,
      });

      if (addResult.success && cardStore) {
        try {
          await mirrorMemoryAdd(cardStore, "failure", {
            mdId: addResult.added_md_id,
            content: formatFailureMemoryContent(content, {
              category: "failure",
              failureReason: reason,
              project: scopedProject,
            }),
          });
        } catch {
          // best-effort card-store mirror only
        }
      }

      if (addResult.success) {
        throttle.recordCapture(dedupKey); // ④ count only on a real write
        const ui = (ctx as { ui?: { notify?: (message: string, level?: string) => void } }).ui;
        ui?.notify?.("🧠 Lesson-worthy error captured to memory", "info");
      }
    } catch {
      // best-effort — never block the session on a capture failure
    }
  });
}
