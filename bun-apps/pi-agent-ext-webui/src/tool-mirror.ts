/**
 * tool-mirror.ts — the generic tool-mirror (specs/05 D1–D5). A THIRD producer
 * of the ticket-06 RenderService (alongside the `webui_render` tool and the
 * `"webui:render"` event channel). Subscribes to the AGENT `tool_result` event
 * (on `pi.on`, NOT `pi.events`), formats each result's typed `details` into
 * markdown, and renders an accumulating "tools" view.
 *
 * v1 is GENERIC only: built-in tools format via the SDK type guards; custom
 * tools (incl. image/video-gen) format their `details` as key-value text. NO
 * dedicated renderer, NO binary/URL serving, NO live tool_execution_* streaming
 * (all §Out of Scope). Paths are filesystem strings shown as TEXT.
 *
 * RenderService is REPLACE-ONLY (views.set, never append), so the mirror keeps
 * its OWN in-memory log and re-renders the whole log on every tool_result.
 *
 * Decoupled (ticket-06 D8): a pure producer — no sendUserMessage, no
 * mutex_blocked, no /ws touch; additive to wireWebui; no WebuiHost widening.
 */
import {
  isBashToolResult,
  isEditToolResult,
  isFindToolResult,
  isGrepToolResult,
  isLsToolResult,
  isReadToolResult,
  isWriteToolResult,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { RenderService } from "./render-service.js";

export type ToolMirrorHandler = (event: ToolResultEvent) => void;

export interface ToolMirrorOptions {
  /** Rolling cap: keep at most this many entries (default 50). Enforced in T3. */
  maxEntries?: number;
  /** Rolling cap: total log ≤ this many chars (default 20000). Enforced in T3. */
  maxChars?: number;
}

/** Cap for a single field (stdout/output/command) before it enters the log. */
const FIELD_CAP = 2000;

/** Truncate a string to `cap` chars + ellipsis. */
function cap(s: string, n: number = FIELD_CAP): string {
  return s.length <= n ? s : `${s.slice(0, n)} …[truncated ${s.length - n} chars]`;
}

/**
 * Pure formatter. T1 ships the MINIMAL body (header + truncated-JSON fallback);
 * T2 expands the body with the built-in type guards + custom key-value. The
 * header is the stable scaffold both build on. NEVER throws.
 */
export function formatToolResult(event: ToolResultEvent): string {
  const status = event.isError ? "❌" : "✅";
  const id = (event.toolCallId ?? "").slice(0, 8);
  const header = `### 🔧 ${event.toolName} ${status} \`${id}\``;

  // T1 minimal body: truncated JSON of details. (T2 narrows built-ins via the
  // guards above and custom tools by toolName; the fallback below stays as the
  // unknown-shape path.) Guard references keep the imports live for T2.
  void isBashToolResult;
  void isReadToolResult;
  void isEditToolResult;
  void isWriteToolResult;
  void isGrepToolResult;
  void isFindToolResult;
  void isLsToolResult;

  let body: string;
  try {
    body =
      event.details === undefined
        ? "_(no details)_"
        : "```json\n" + cap(JSON.stringify(event.details, null, 2)) + "\n```";
  } catch {
    body = "_(unserializable details)_";
  }
  return `${header}\n\n${body}`;
}

/**
 * Build a mirror handler bound to a registry. The wiring subscribes the
 * returned handler via `reg("tool_result", createToolMirror(registry))` so it
 * inherits the `disposed` guard used by the outbound broadcast.
 */
export function createToolMirror(
  registry: RenderService,
  _opts: ToolMirrorOptions = {}
): ToolMirrorHandler {
  let log = "";
  return (event) => {
    try {
      const entry = formatToolResult(event);
      log = log ? `${log}\n\n---\n\n${entry}` : entry;
      // T3 enforces the rolling cap here (maxEntries / maxChars). T1 renders the
      // raw accumulating log so the mechanism is testable in isolation.
      registry.render({ content: log, mode: "md", view: "tools", title: "Tools" });
    } catch {
      // A mirror handler must NEVER crash the host event bus.
    }
  };
}
