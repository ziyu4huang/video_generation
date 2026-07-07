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
import { DatabaseManager } from "../store/db.js";
import {
  formatFailureMemoryContent,
  syncMemoryEntry,
} from "../store/sqlite-memory-store.js";
import {
  LESSON_WORTHY_PATTERNS,
  ERROR_NOISE_PATTERNS,
} from "../constants.js";
import type { MemoryConfig } from "../types.js";

/** A single text/image content block from a tool_result event. */
interface ContentBlock {
  type?: string;
  text?: string;
}

/** Extract all readable text from a tool_result event's content blocks. */
function extractResultText(content: unknown): string {
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
  dbManager: DatabaseManager | null = null,
  projectName?: string | null,
): void {
  if (config.errorCapture === false) return;

  pi.on("tool_result", async (event, ctx) => {
    // Only failed tool results are candidates.
    if (!event.isError) return;

    const text = extractResultText(event.content);
    if (!isLessonWorthy(text)) return;

    // DEDUP GUARD — skip if an existing failure entry already carries this
    // error (same error twice → one entry). The key normalises paths/counts,
    // so a re-occurrence matches regardless of which tool produced it.
    const dedupKey = errorDedupKey(text);
    try {
      const existing = store.getFailureEntries(30);
      if (existing.some((e) => errorDedupKey(e) === dedupKey)) {
        return; // already captured — dedup (criterion 2)
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

      if (addResult.success && dbManager) {
        try {
          syncMemoryEntry(dbManager, {
            content: formatFailureMemoryContent(content, {
              category: "failure",
              failureReason: reason,
              project: scopedProject,
            }),
            target: "failure",
            project: scopedProject,
            category: "failure",
            failureReason: reason,
          });
        } catch {
          // best-effort SQLite sync only
        }
      }

      if (addResult.success) {
        const ui = (ctx as { ui?: { notify?: (message: string, level?: string) => void } }).ui;
        ui?.notify?.("🧠 Lesson-worthy error captured to memory", "info");
      }
    } catch {
      // best-effort — never block the session on a capture failure
    }
  });
}
