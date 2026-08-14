// bun-apps/pi-agent-ext-webui/tests/btw-contract.test.ts
import { describe, expect, it } from "bun:test";
import {
  BTW_COMMAND_CHANNEL,
  BTW_EVENT_CHANNEL,
  emitBtwCommand,
  onBtwEvent,
} from "../src/btw-channels";
import { createBtwForwarder, createBtwStore } from "../src/btw-store";
import type { BtwThreadState } from "../src/btw-channels";

// btw-side channel names, redeclared verbatim from
// bun-apps/pi-agent-ext-btw/src/btw/webui-events.ts — there is deliberately
// NO import between the two packages; these literals are the contract.
const BTW_COMMAND_CHANNEL_BTW_SIDE = "webui:btw-command";
const BTW_EVENT_CHANNEL_BTW_SIDE = "btw:event";

const THREAD_STATE: BtwThreadState = {
  messages: [
    { id: "btw-m-0", role: "user", text: "why did the render fail?", status: "done" },
    { id: "btw-m-1", role: "assistant", text: "the shader compile step", status: "done" },
  ],
  mode: "contextual",
  model: null,
  thinking: null,
};

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

describe("btw <-> webui bus contract", () => {
  it("channel names match the btw package's published constants", () => {
    expect(BTW_COMMAND_CHANNEL).toBe(BTW_COMMAND_CHANNEL_BTW_SIDE);
    expect(BTW_EVENT_CHANNEL).toBe(BTW_EVENT_CHANNEL_BTW_SIDE);
  });

  it("drives ask -> snapshot -> frame across both seams with no package dependency", () => {
    const bus = fakeBus();

    // btw side (fake engine): a subscriber on the command channel ...
    const receivedCommands: unknown[] = [];
    bus.on(BTW_COMMAND_CHANNEL_BTW_SIDE, (data) => receivedCommands.push(data));

    // webui side: store + forwarder wired to the bus, broadcast recorder
    const store = createBtwStore();
    const frames: unknown[] = [];
    const dispose = onBtwEvent(bus, createBtwForwarder(store, (frame) => frames.push(frame)));

    // ... and an emitter of pre-reduced thread snapshots on the event channel
    bus.emit(BTW_EVENT_CHANNEL_BTW_SIDE, { type: "thread", state: THREAD_STATE });

    // snapshot arrived in the pull store AND went out as the new WS frame
    expect(store.state()).toEqual(THREAD_STATE);
    expect(frames).toEqual([{ type: "btw", event: { type: "thread", state: THREAD_STATE } }]);

    // panel command flows back over the command channel
    emitBtwCommand(bus, { kind: "ask", text: "and the fix?" });
    expect(receivedCommands).toEqual([{ kind: "ask", text: "and the fix?" }]);

    dispose();
  });

  it("webui package.json declares no dependency on the btw package", async () => {
    const pkg = (await Bun.file(new URL("../package.json", import.meta.url).pathname).json()) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps["@repo/pi-agent-ext-btw"]).toBeUndefined();
  });
});
