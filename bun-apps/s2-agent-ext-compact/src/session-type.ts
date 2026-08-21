import { extractFileOps } from "./file-ops.ts";
import type { Message } from "@earendil-works/pi-ai";

export type SessionType = "implementation" | "debugging" | "review" | "discussion";

const ERROR_SIGNALS = [
  "error:", "failed", "fail:", "failing", "traceback", "exception",
  "✗", "✘", "x tests failed", "not ok ",
] as const;

/** Tool names that mutate state — their presence means hands-on work happened. */
const MUTATING_TOOLS = new Set(["edit", "edit_file", "write", "write_file", "create_file", "multi_edit", "patch", "apply_patch", "bash"]);

export function toolNamesIn(messages: readonly Message[]): string[] {
  const names = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const call = block as unknown as { type: string; name?: unknown } | null;
      if (call?.type === "toolCall" && typeof call.name === "string") names.add(call.name);
    }
  }
  return [...names];
}

export function inferSessionType(input: {
  toolNames: readonly string[];
  conversationText: string;
}): SessionType {
  const tools = input.toolNames.map((t) => t.toLowerCase());
  if (tools.length === 0) return "discussion";
  const lower = input.conversationText.toLowerCase();
  const hasErrors = ERROR_SIGNALS.some((s) => lower.includes(s));
  const mutating = tools.some((t) => MUTATING_TOOLS.has(t));
  if (!mutating) return "review";
  if (hasErrors) return "debugging";
  return "implementation";
}
