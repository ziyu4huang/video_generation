// bun-apps/pi-agent-ext-webui/src/btw-channels.ts
/**
 * LOCAL redeclaration of the btw <-> webui event-bus seam.
 *
 * Mirrors bun-apps/pi-agent-ext-btw/src/btw/webui-events.ts WITHOUT importing
 * it: there is deliberately NO package dependency webui -> btw. The string
 * channel values are the contract; tests/btw-contract.test.ts pins them.
 */

export const BTW_COMMAND_CHANNEL = "webui:btw-command" as const;
export const BTW_EVENT_CHANNEL = "btw:event" as const;

export type BtwThreadMode = "contextual" | "tangent";

export interface BtwModelRef {
  provider: string;
  id: string;
  api: string;
}

// Keep in sync with btw's webui-events.ts BtwThinkingLevel (pi-ai 0.84.2 surface).
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

/** Narrow an unknown event-bus payload to a BtwEvent; unknown data is dropped. */
export function isBtwEvent(data: unknown): data is BtwEvent {
  if (!data || typeof data !== "object") return false;
  const event = data as { type?: unknown; state?: unknown; text?: unknown };
  if (event.type === "notice") return typeof event.text === "string";
  if (event.type === "thread") return !!event.state && typeof event.state === "object";
  return false;
}

/** Input shape of a validated inbound `btw` WS frame minus the `type` literal. */
export interface BtwCommandFrameInput {
  kind: string;
  text?: string;
  mode?: string;
  model?: BtwModelRef | null;
  level?: BtwThinkingLevel | null;
}

/** Map a validated frame body to a BtwCommand; null when the body is inconsistent. */
export function btwCommandFromFrame(frame: BtwCommandFrameInput): BtwCommand | null {
  switch (frame.kind) {
    case "ask":
      return typeof frame.text === "string" && frame.text.length > 0 ? { kind: "ask", text: frame.text } : null;
    case "new":
    case "clear":
    case "inject":
    case "summarize":
      return { kind: frame.kind };
    case "model":
      return { kind: "model", model: frame.model ?? null };
    case "thinking":
      return { kind: "thinking", level: frame.level ?? null };
    case "mode":
      return frame.mode === "contextual" || frame.mode === "tangent"
        ? { kind: "mode", mode: frame.mode }
        : null;
    default:
      return null;
  }
}

/** Emit a panel command on the command channel (webui -> btw direction). */
export function emitBtwCommand(
  bus: { emit(channel: string, data: unknown): void },
  command: BtwCommand,
): void {
  bus.emit(BTW_COMMAND_CHANNEL, command);
}

/** Subscribe to thread events (btw -> webui direction); returns disposer. */
export function onBtwEvent(
  bus: { on(channel: string, handler: (data: unknown) => void): () => void },
  handler: (event: BtwEvent) => void,
): () => void {
  return bus.on(BTW_EVENT_CHANNEL, (data) => {
    if (isBtwEvent(data)) handler(data);
  });
}
