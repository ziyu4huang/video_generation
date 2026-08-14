import { describe, expect, it } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { makeFakeBusPi } from "./helpers/fake-pi";
import { BtwEngine } from "../src/btw/session";

function makeFakeSession(messages: unknown[] = []) {
  let listener: ((event: unknown) => void) | null = null;
  return {
    agent: { state: { messages } },
    subscribe(cb: (event: unknown) => void) {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    push(event: unknown) {
      listener?.(event);
    },
    abort() {},
    async dispose() {},
  };
}

const MESSAGES = [
  { role: "user", parts: [{ type: "text", text: "q" }] },
  { role: "assistant", parts: [{ type: "text", text: "partial" }] },
];

describe("BtwEngine webui bridge", () => {
  it("emits thread events with pre-reduced snapshots on every sub-session event", () => {
    const { pi, emitted } = makeFakeBusPi();
    const engine = new BtwEngine(pi);
    const fake = makeFakeSession(MESSAGES);
    engine.activeBtwSession = {
      session: fake as unknown as AgentSession,
      mode: "contextual",
      subscriptions: new Set(),
      sideThreadStartIndex: 0,
    };
    engine.subscribeWebuiBridge(engine.activeBtwSession);

    fake.push({ type: "message_update" });
    let last = emitted.filter((e) => e.channel === "btw:event").at(-1)?.data;
    expect(last).toEqual({
      type: "thread",
      state: {
        messages: [
          { id: "btw-m-0", role: "user", text: "q", status: "done" },
          { id: "btw-m-1", role: "assistant", text: "partial", status: "streaming" },
        ],
        mode: "contextual",
        model: null,
        thinking: null,
      },
    });

    fake.push({ type: "tool_execution_start", toolName: "bash" });
    last = emitted.filter((e) => e.channel === "btw:event").at(-1)?.data;
    expect(last).toMatchObject({
      type: "thread",
      state: {
        messages: [
          { id: "btw-m-0", status: "done" },
          { id: "btw-m-1", status: "running-tool", statusText: "running-tool: bash" },
        ],
      },
    });

    fake.push({ type: "turn_end" });
    last = emitted.filter((e) => e.channel === "btw:event").at(-1)?.data;
    expect(last).toMatchObject({
      type: "thread",
      state: { messages: [{ id: "btw-m-0" }, { id: "btw-m-1", status: "done" }] },
    });
  });

  it("falls back to pendingThread snapshots after the session is disposed", async () => {
    const { pi, emitted } = makeFakeBusPi();
    const engine = new BtwEngine(pi);
    const fake = makeFakeSession([]);
    engine.activeBtwSession = {
      session: fake as unknown as AgentSession,
      mode: "contextual",
      subscriptions: new Set(),
      sideThreadStartIndex: 0,
    };
    engine.pendingThread.push({
      question: "persisted q",
      thinking: "",
      answer: "persisted a",
      provider: "anthropic",
      model: "claude-sonnet-4",
      api: "anthropic",
      thinkingLevel: "off",
      timestamp: 1,
    });
    await engine.disposeBtwSession();
    engine.emitThreadEvent();
    expect(emitted.filter((e) => e.channel === "btw:event").at(-1)?.data).toEqual({
      type: "thread",
      state: {
        messages: [
          { id: "btw-d-0", role: "user", text: "persisted q", status: "done" },
          { id: "btw-d-1", role: "assistant", text: "persisted a", status: "done" },
        ],
        mode: "contextual",
        model: null,
        thinking: null,
      },
    });
  });

  it("keeps the TUI overlay path attachable while the webui bridge is active", async () => {
    const { pi, emitted } = makeFakeBusPi();
    const engine = new BtwEngine(pi);
    // Multi-listener fake: unlike makeFakeSession, every subscriber stays attached.
    const listeners = new Set<(event: unknown) => void>();
    const fake = {
      agent: { state: { messages: [] as unknown[] } },
      subscribe(cb: (event: unknown) => void) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      push(event: unknown) {
        for (const cb of [...listeners]) cb(event);
      },
      abort() {},
      async dispose() {},
    };
    const sr = {
      session: fake as unknown as AgentSession,
      mode: "contextual" as const,
      subscriptions: new Set<() => void>(),
      sideThreadStartIndex: 0,
    };
    engine.activeBtwSession = sr;
    engine.subscribeWebuiBridge(sr);
    // The bridge subscription must NOT occupy sr.subscriptions — otherwise the
    // guard in subscribeOverlayToActiveBtwSession sees size>0 and returns early.
    expect(sr.subscriptions.size).toBe(0);

    let overlayEvents = 0;
    engine.handleBtwSessionEvent = () => {
      overlayEvents++;
    };
    engine.subscribeOverlayToActiveBtwSession();
    expect(sr.subscriptions.size).toBe(1);

    fake.push({ type: "message_update" });
    // Both the overlay path and the webui bridge receive sub-session events.
    expect(overlayEvents).toBe(1);
    expect(emitted.filter((e) => e.channel === "btw:event").length).toBeGreaterThan(0);

    // Dispose clears the dedicated bridge disposer alongside the overlay subscription.
    await engine.disposeBtwSession();
    expect(sr.subscriptions.size).toBe(0);
    listeners.clear(); // fake has no weakrefs; engine-level clearing is asserted via size above
  });

  it("emitNotice posts a notice event on the event channel", () => {
    const { pi, emitted } = makeFakeBusPi();
    const engine = new BtwEngine(pi);
    engine.emitNotice("Injected into the main session");
    expect(emitted.filter((e) => e.channel === "btw:event").at(-1)?.data).toEqual({
      type: "notice",
      text: "Injected into the main session",
    });
  });
});
