### Task 5: webui local channel redeclaration + bus helpers

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/btw-channels.ts`
- Test: `bun-apps/pi-agent-ext-webui/tests/btw-channels.test.ts`

**Interfaces:**
- Consumes: nothing from the btw package (that is the point — this is a deliberate LOCAL redeclaration of the shapes documented in Phase context; the string values are pinned by Task 11's contract test).
- Produces: `BTW_COMMAND_CHANNEL`, `BTW_EVENT_CHANNEL` (same values as btw's); payload types `BtwThreadMode`, `BtwModelRef`, `BtwThinkingLevel`, `BtwCommand`, `BtwMessageStatus`, `BtwMessageSnapshot`, `BtwThreadState`, `BtwEvent`; `isBtwEvent(data): data is BtwEvent`; `btwCommandFromFrame(frame: BtwCommandFrameInput): BtwCommand | null`; `emitBtwCommand(bus: { emit(channel, data) }, command: BtwCommand): void`; `onBtwEvent(bus: { on(channel, handler) }, handler: (event: BtwEvent) => void): () => void`.

- [ ] **Step 1: Write the failing test**

```ts
// bun-apps/pi-agent-ext-webui/tests/btw-channels.test.ts
import { describe, expect, it } from "bun:test";
import {
  BTW_COMMAND_CHANNEL,
  BTW_EVENT_CHANNEL,
  btwCommandFromFrame,
  emitBtwCommand,
  isBtwEvent,
  onBtwEvent,
} from "../src/btw-channels";

function fakeBus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(channel: string, handler: (data: unknown) => void) {
      const set = handlers.get(channel) ?? new Set();
      set.add(handler);
      handlers.set(channel, set);
      return () => set.delete(handler);
    },
    emit(channel: string, data: unknown) {
      handlers.get(channel)?.forEach((handler) => handler(data));
    },
  };
}

describe("btw-channels seam", () => {
  it("declares the agreed channel names", () => {
    expect(BTW_COMMAND_CHANNEL).toBe("webui:btw-command");
    expect(BTW_EVENT_CHANNEL).toBe("btw:event");
  });

  it("isBtwEvent accepts thread and notice payloads, rejects garbage", () => {
    expect(isBtwEvent({ type: "thread", state: { messages: [], mode: "contextual", model: null, thinking: null } })).toBe(true);
    expect(isBtwEvent({ type: "notice", text: "hi" })).toBe(true);
    expect(isBtwEvent({ type: "thread" })).toBe(false);
    expect(isBtwEvent({ type: "other" })).toBe(false);
    expect(isBtwEvent(null)).toBe(false);
  });

  it("btwCommandFromFrame maps validated frames to commands", () => {
    expect(btwCommandFromFrame({ kind: "ask", text: "hi" })).toEqual({ kind: "ask", text: "hi" });
    expect(btwCommandFromFrame({ kind: "clear" })).toEqual({ kind: "clear" });
    expect(btwCommandFromFrame({ kind: "mode", mode: "tangent" })).toEqual({ kind: "mode", mode: "tangent" });
    expect(btwCommandFromFrame({ kind: "model", model: { provider: "p", id: "m", api: "a" } })).toEqual({
      kind: "model",
      model: { provider: "p", id: "m", api: "a" },
    });
    expect(btwCommandFromFrame({ kind: "thinking", level: null })).toEqual({ kind: "thinking", level: null });
  });

  it("btwCommandFromFrame rejects invalid frames with null", () => {
    expect(btwCommandFromFrame({ kind: "ask" })).toBeNull(); // missing text
    expect(btwCommandFromFrame({ kind: "mode", mode: "bogus" })).toBeNull();
    expect(btwCommandFromFrame({ kind: "bogus" })).toBeNull();
  });

  it("emitBtwCommand / onBtwEvent round-trip over a fake bus", () => {
    const bus = fakeBus();
    const received: unknown[] = [];
    const seenEvents: unknown[] = [];
    const dispose = onBtwEvent(bus, (event) => seenEvents.push(event));
    bus.on(BTW_COMMAND_CHANNEL, (data) => received.push(data));

    emitBtwCommand(bus, { kind: "summarize" });
    expect(received).toEqual([{ kind: "summarize" }]);

    bus.emit("btw:event", { type: "notice", text: "ok" });
    expect(seenEvents).toEqual([{ type: "notice", text: "ok" }]);

    bus.emit("btw:event", { type: "garbage" });
    expect(seenEvents).toHaveLength(1); // guard dropped it

    dispose();
    bus.emit("btw:event", { type: "notice", text: "after dispose" });
    expect(seenEvents).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/btw-channels.test.ts )`
Expected: FAIL — cannot resolve `../src/btw-channels`.

- [ ] **Step 3: Write minimal implementation**

```ts
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

export type BtwThinkingLevel = "off" | "low" | "medium" | "high";

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/btw-channels.test.ts )`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/btw-channels.ts bun-apps/pi-agent-ext-webui/tests/btw-channels.test.ts
git commit -m "feat(webui): add local btw channel seam redeclaration and bus helpers"
```

