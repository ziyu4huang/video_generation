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

/** Pull the concatenated text content (bash stdout / generic text). */
function textContent(event: ToolResultEvent): string {
  return (event.content ?? [])
    .filter((c): c is { type: "text"; text: string } => c && (c as { type?: string }).type === "text")
    .map((c) => (c as { text?: string }).text ?? "")
    .join("\n");
}

/** One-line truncation/limit note for read/grep/find/ls. */
function limitNote(d: { truncation?: { truncated?: boolean } } & Record<string, unknown>): string {
  const bits: string[] = [];
  if (d.truncation?.truncated) bits.push("output truncated");
  for (const k of ["matchLimitReached", "resultLimitReached", "entryLimitReached"]) {
    if (typeof d[k] === "number") bits.push(`${k}=${d[k]}`);
  }
  if (d.linesTruncated) bits.push("lines truncated");
  return bits.length ? `_${bits.join("; ")}_` : "";
}

/**
 * Generic key-value markdown of a custom tool's details (paths as inline code).
 * Stable string/number/boolean fields get a dedicated `- **k**: ...` line;
 * unknown object keys are ALSO rendered generically (per the 04-spec §8 custom
 * intent) so e.g. `{ weird: [...] }` still surfaces as a truncated JSON block
 * (this is what the T1 unknown-shape regression asserts). Non-object details
 * fall back to truncated JSON. NEVER throws.
 */
function formatCustomDetails(details: unknown): string {
  if (details === null || typeof details !== "object") {
    // non-object fallback -> truncated JSON
    try {
      return "```json\n" + cap(JSON.stringify(details)) + "\n```";
    } catch {
      return "_(unserializable details)_";
    }
  }
  const known = ["ok", "command", "exitCode", "output", "outputs", "manifestPath", "manifest", "model", "elapsedSeconds", "gate", "stdout"] as const;
  const lines: string[] = [];
  const o = details as Record<string, unknown>;
  const seen = new Set<string>();
  for (const k of known) {
    if (!(k in o)) continue;
    seen.add(k);
    const v = o[k];
    if (typeof v === "string") {
      // paths/commands as inline code; long stdout/command capped
      lines.push(`- **${k}**: \`${cap(v)}\``);
    } else if (typeof v === "number" || typeof v === "boolean") {
      lines.push(`- **${k}**: ${String(v)}`);
    } else if (Array.isArray(v)) {
      const items = v.map((x) => (typeof x === "string" ? `\`${cap(x)}\`` : String(x)));
      lines.push(`- **${k}**: ${items.join(", ")}`);
    }
  }
  // Unknown object keys -> rendered generically (04-spec §8 intent). Without
  // this, a custom details object carrying only unknown keys (no stable field)
  // would render as `_(no stable fields)_` and silently hide its content.
  const unknownKeys = Object.keys(o).filter((k) => !seen.has(k));
  if (unknownKeys.length) {
    const rest: Record<string, unknown> = {};
    for (const k of unknownKeys) rest[k] = o[k];
    try {
      lines.push("```json\n" + cap(JSON.stringify(rest, null, 2)) + "\n```");
    } catch {
      // ignore an unserializable unknown field — stable fields still render
    }
  }
  return lines.length ? lines.join("\n") : "_(no stable fields)_";
}

/**
 * Pure formatter. T2 expands the body with the built-in type guards (edit/bash/
 * read/grep/find/ls/write) + a generic key-value path for custom tools (incl.
 * image/video-gen). The header is the stable T1 scaffold. NEVER throws.
 */
export function formatToolResult(event: ToolResultEvent): string {
  const status = event.isError ? "❌" : "✅";
  const id = (event.toolCallId ?? "").slice(0, 8);
  const header = `### 🔧 ${event.toolName} ${status} \`${id}\``;

  let body: string;
  try {
    if (isEditToolResult(event) && event.details) {
      const d = event.details;
      body = "```diff\n" + cap(d.diff) + "\n```" + (d.firstChangedLine ? `\n\n_first changed line: ${d.firstChangedLine}_` : "");
    } else if (isBashToolResult(event)) {
      const out = cap(textContent(event));
      const note = event.details?.truncation?.truncated ? "\n\n_output truncated_" : "";
      const full = event.details?.fullOutputPath ? `\n\nfull output: \`${event.details.fullOutputPath}\`` : "";
      body = out ? "```\n" + out + "\n```" + note + full : "_(no stdout)_" + note + full;
    } else if (isWriteToolResult(event)) {
      body = "_(no details)_";
    } else if (isReadToolResult(event) || isGrepToolResult(event) || isFindToolResult(event) || isLsToolResult(event)) {
      const note = event.details
        ? limitNote(event.details as Record<string, unknown> & { truncation?: { truncated?: boolean } })
        : "";
      body = note || "_(no metadata)_";
    } else {
      // custom tool (incl. image/video-gen) — generic key-value, paths as TEXT
      body = formatCustomDetails(event.details);
    }
  } catch {
    body = "_(formatting failed)_";
  }
  return `${header}\n\n${body}`;
}

/** Markdown horizontal-rule separator between accumulated entries. */
const SEP = "\n\n---\n\n";

/**
 * Build a mirror handler bound to a registry. The wiring subscribes the
 * returned handler via `reg("tool_result", createToolMirror(registry))` so it
 * inherits the `disposed` guard used by the outbound broadcast.
 *
 * The mirror owns its own entry array (RenderService is replace-only) and
 * enforces a rolling cap on every event (ticket 05 D3): entry count ≤
 * `maxEntries` AND joined-log length ≤ `maxChars`. The char cap drops OLDEST
 * entries until under budget; a single over-budget entry is itself truncated
 * in place so the view never exceeds `maxChars`. Defaults: 50 entries / 20000
 * chars. NEVER throws (a flood of tool_results must never grow the log
 * unbounded, nor crash the host event bus).
 */
export function createToolMirror(
  registry: RenderService,
  opts: ToolMirrorOptions = {}
): ToolMirrorHandler {
  const maxEntries = opts.maxEntries ?? 50;
  const maxChars = opts.maxChars ?? 20000;
  let entries: string[] = [];

  const flush = (): void => {
    registry.render({ content: entries.join(SEP), mode: "md", view: "tools", title: "Tools" });
  };

  return (event) => {
    try {
      let entry = formatToolResult(event);
      // single entry larger than the whole budget: truncate it in place
      if (entry.length > maxChars) entry = entry.slice(0, maxChars);
      entries.push(entry);

      // entry cap
      if (entries.length > maxEntries) entries = entries.slice(entries.length - maxEntries);

      // char cap: drop oldest until under budget
      let joined = entries.join(SEP);
      while (joined.length > maxChars && entries.length > 1) {
        entries.shift();
        joined = entries.join(SEP);
      }
      flush();
    } catch {
      // a mirror handler must NEVER crash the host event bus
    }
  };
}
