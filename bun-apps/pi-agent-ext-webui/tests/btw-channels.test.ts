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
