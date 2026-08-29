import { getMessageText } from "../types.js";

export function applyRecentMessageLimit(parts: string[], recentMessages = 0): string[] {
  if (Number.isFinite(recentMessages) && recentMessages > 0) {
    return parts.slice(-recentMessages);
  }
  return parts;
}

export function collectMessageParts(entries: unknown[], recentMessages = 0): string[] {
  const parts: string[] = [];

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    if ((entry as { type?: unknown }).type !== "message") continue;

    const msg = (entry as { message?: unknown }).message;
    const text = getMessageText(msg);
    if (!text) continue;

    const role = (msg as { role?: unknown } | null)?.role;
    const prefix = role === "user" ? "[USER]" : "[ASSISTANT]";
    parts.push(`${prefix}: ${text}`);
  }

  return applyRecentMessageLimit(parts, recentMessages);
}

/** Per-output cap for captured subagent findings (relaxed vs getMessageText's 500). */
export const SUBAGENT_OUTPUT_MAX_CHARS = 4000;

/** Dispatch tool whose results the learning loop should capture.
 * `spawn_subagent` renamed from `subagent` 2026-08-20 (bun-apps/s2-agent-ext-devops/skills/extension-naming/SKILL.md)
 * — BOTH names accepted because historical transcripts carry the legacy name. */
const SUBAGENT_TOOL_NAMES = new Set(["subagent", "spawn_subagent"]);

/** Read the textual content of a tool_result block (string or text-block array). */
function readToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as { type?: string; text?: string }[]) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/**
 * Collect the textual output of `subagent` tool calls from a session branch.
 *
 * The shared `getMessageText` extracts only `text` content blocks (capped 500),
 * so a subagent's output — which returns as a `tool_result` block on the
 * preceding `subagent` tool_use — is invisible to `collectMessageParts` and thus
 * never reaches the background-review learning loop. This dedicated collector
 * closes that gap WITHOUT broadening `getMessageText` (which `session-flush` and
 * `correction-detector` also consume — broadening it would inject grep/file
 * noise into those paths).
 *
 * Pass 1 builds an `id → toolName` map from assistant `toolCall`/`tool_use`
 * blocks; pass 2 keeps user-role `tool_result` blocks whose producer was the
 * `subagent` tool, extracting their textual content at a relaxed per-output cap.
 */
export function collectSubagentOutputs(entries: unknown[]): string[] {
  const idToName = new Map<string, string>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    if ((entry as { type?: unknown }).type !== "message") continue;
    const message = (entry as { message?: { role?: unknown; content?: unknown } }).message;
    if (!message || message.role !== "assistant") continue;
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as { type?: unknown; id?: unknown; name?: unknown };
      if ((b.type === "toolCall" || b.type === "tool_use") && typeof b.id === "string" && typeof b.name === "string") {
        idToName.set(b.id, b.name);
      }
    }
  }

  const parts: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    if ((entry as { type?: unknown }).type !== "message") continue;
    const message = (entry as { message?: { role?: unknown; content?: unknown } }).message;
    if (!message || message.role !== "user") continue;
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as { type?: unknown; tool_use_id?: unknown; content?: unknown };
      if (b.type !== "tool_result") continue;
      const id = typeof b.tool_use_id === "string" ? b.tool_use_id : undefined;
      if (!id || !SUBAGENT_TOOL_NAMES.has(idToName.get(id) ?? "")) continue;
      const text = readToolResultContent(b.content);
      if (!text) continue;
      parts.push(`[SUBAGENT]: ${text.slice(0, SUBAGENT_OUTPUT_MAX_CHARS)}`);
    }
  }
  return parts;
}
