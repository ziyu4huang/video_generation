/**
 * Event-bus seam between pi-agent-ext-btw and pi-agent-ext-webui.
 *
 * Plain string channels (SDK EventBus convention: on() returns an unsubscribe
 * disposer, there is no off()). Payloads are JSON-safe. There is deliberately NO
 * package dependency webui -> btw; the string values are the contract.
 *
 * NO CONSUMER RIGHT NOW. webui used to redeclare these constants in its own
 * src/btw-channels.ts, and PR #1532 ("webui v2 cards-first") deleted that file
 * along with the btw sidebar. btw still publishes on both channels; nothing
 * subscribes. Kept rather than deleted because the seam is the documented
 * integration point and the v2 webui is expected to reattach — but treat "the
 * webui reflects this" as false until something in webui reads these strings
 * again. See __tests__/webui-channel-parity.test.ts.
 */

export const BTW_COMMAND_CHANNEL = "webui:btw-command" as const;
export const BTW_EVENT_CHANNEL = "btw:event" as const;

export type BtwThreadMode = "contextual" | "tangent";

/** Registry model reference; field names mirror the btw model-override entry payload. */
export interface BtwModelRef {
  provider: string;
  id: string;
  api: string;
}

/** Thinking override level; keep in sync with the SDK SessionThinkingLevel used by btw
 * (pi-ai 0.84.2 widened ThinkingLevel to minimal|low|medium|high|xhigh|max). */
export type BtwThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type BtwCommand =
  | { kind: "ask"; text: string }
  | { kind: "new" }
  | { kind: "clear" }
  | { kind: "inject" }
  | { kind: "summarize" }
  | { kind: "model"; model: BtwModelRef | null }
  | { kind: "thinking"; level: BtwThinkingLevel | null }
  | { kind: "mode"; mode: BtwThreadMode };

export type BtwMessageStatus = "streaming" | "running-tool" | "done" | "error";

export interface BtwMessageSnapshot {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: BtwMessageStatus;
  statusText?: string;
}

export interface BtwThreadState {
  messages: BtwMessageSnapshot[];
  mode: BtwThreadMode;
  model: BtwModelRef | null;
  thinking: BtwThinkingLevel | null;
}

export type BtwEvent =
  | { type: "thread"; state: BtwThreadState }
  | { type: "notice"; text: string };

const KINDS: ReadonlySet<string> = new Set([
  "ask",
  "new",
  "clear",
  "inject",
  "summarize",
  "model",
  "thinking",
  "mode",
]);

/** Narrow an unknown event-bus payload to a BtwCommand; unknown data is ignored. */
export function isBtwCommand(data: unknown): data is BtwCommand {
  if (!data || typeof data !== "object") return false;
  const command = data as Record<string, unknown>;
  if (typeof command.kind !== "string" || !KINDS.has(command.kind)) return false;
  switch (command.kind) {
    case "ask":
      return typeof command.text === "string";
    case "mode":
      return command.mode === "contextual" || command.mode === "tangent";
    default:
      return true;
  }
}
