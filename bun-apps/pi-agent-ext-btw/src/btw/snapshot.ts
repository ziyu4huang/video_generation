// bun-apps/pi-agent-ext-btw/src/btw/snapshot.ts
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { BtwDetails } from "./types";
import type { BtwMessageSnapshot, BtwMessageStatus } from "./webui-events";

/** A status change derived from a sub-session AgentSessionEvent; null = no change. */
export interface BtwStatusUpdate {
  status: BtwMessageStatus;
  statusText?: string;
}

/** Persisted thread (BtwDetails[]) -> snapshots. Ids are index-stable: btw-d-<index>. */
export function snapshotsFromDetails(details: BtwDetails[]): BtwMessageSnapshot[] {
  const snapshots: BtwMessageSnapshot[] = [];
  for (const entry of details) {
    snapshots.push({ id: `btw-d-${snapshots.length}`, role: "user", text: entry.question, status: "done" });
    snapshots.push({ id: `btw-d-${snapshots.length}`, role: "assistant", text: entry.answer, status: "done" });
  }
  return snapshots;
}

/**
 * Map a sub-session event to a status override for the LAST live message.
 * Reads only the event type discriminant plus an optional tool name — never
 * full event payloads — so it stays robust across SDK event shapes.
 */
export function statusFromEvent(event: AgentSessionEvent): BtwStatusUpdate | null {
  const type = (event as { type?: unknown }).type;
  if (type === "tool_execution_start") {
    const toolName = (event as { toolName?: unknown }).toolName;
    return { status: "running-tool", statusText: `running-tool: ${typeof toolName === "string" && toolName ? toolName : "tool"}` };
  }
  if (type === "tool_execution_end") return { status: "streaming" };
  if (type === "turn_end") return { status: "done" };
  return null;
}

// roleOf/textOf mirror the extraction already used by src/btw/session.ts
// (runBtw's answer extraction / getBtwHandoffThread's live-message walk).
// If session.ts exports a reusable helper, import it instead of duplicating.
function roleOf(message: unknown): "user" | "assistant" {
  const role = (message as { role?: unknown }).role;
  return role === "user" ? "user" : "assistant";
}

function textOf(message: unknown): string {
  const parts = (message as { parts?: Array<{ type?: unknown; text?: unknown }> }).parts ?? [];
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

/**
 * Live sub-session messages -> snapshots. Ids are index-stable: btw-m-<index>.
 * The status override (if any) is folded into the LAST message only; with no
 * override the last message defaults to "streaming" (mid-turn).
 */
export function snapshotsFromMessages(
  messages: readonly unknown[],
  status: BtwStatusUpdate | null,
): BtwMessageSnapshot[] {
  return messages.map((message, index) => {
    const isLast = index === messages.length - 1;
    const update = isLast ? (status ?? { status: "streaming" as const }) : null;
    return {
      id: `btw-m-${index}`,
      role: roleOf(message),
      text: textOf(message),
      status: update ? update.status : "done",
      ...(update?.statusText ? { statusText: update.statusText } : {}),
    };
  });
}
