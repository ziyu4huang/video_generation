import { describe, expect, it } from "bun:test";
import { makeFakeBusPi } from "./helpers/fake-pi";
import { registerBtwFeature } from "../src/btw";
import { BTW_COMMAND_CHANNEL } from "../src/btw/webui-events";

const fakeCtx = {
  isIdle: () => true,
  sessionManager: { getBranch: () => [] },
  modelRegistry: { find: () => undefined, getAvailable: () => [] },
} as unknown as Parameters<Parameters<typeof registerBtwFeature>[0]["on"]>[1];

const threadEvents = (emitted: { channel: string; data: unknown }[]) =>
  emitted.filter((e) => e.channel === "btw:event" && (e.data as { type?: string }).type === "thread");

/** Drain pending microtask chains (session handlers / handleWebuiCommand are async, fire-and-forget). */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("webui command channel", () => {
  it("ignores commands before any session_start (no ctx yet)", () => {
    const fake = makeFakeBusPi();
    registerBtwFeature(fake.pi);
    fake.pi.events?.emit(BTW_COMMAND_CHANNEL, { kind: "clear" });
    const last = fake.emitted.filter((e) => e.channel === "btw:event").at(-1)?.data as
      | { type?: string; text?: string }
      | undefined;
    expect(last?.type).toBe("notice");
    expect(String(last?.text)).toContain("no active session");
  });

  it("dispatches clear through the engine (persisted reset entry) and emits a thread event", async () => {
    const fake = makeFakeBusPi();
    registerBtwFeature(fake.pi);
    fake.trigger("session_start", {}, fakeCtx);
    await flush();
    fake.pi.events?.emit(BTW_COMMAND_CHANNEL, { kind: "clear" });
    await flush();
    expect(fake.appendEntries.map((e) => e.type)).toContain("btw-thread-reset");
    expect(threadEvents(fake.emitted).length).toBeGreaterThan(0);
  });

  it("mode command switches pendingMode, disposes the session, and reports it", async () => {
    const fake = makeFakeBusPi();
    registerBtwFeature(fake.pi);
    fake.trigger("session_start", {}, fakeCtx);
    await flush();
    fake.pi.events?.emit(BTW_COMMAND_CHANNEL, { kind: "mode", mode: "tangent" });
    await flush();
    const last = threadEvents(fake.emitted).at(-1)?.data as { state?: { mode?: string } };
    expect(last?.state?.mode).toBe("tangent");
  });

  it("ignores malformed payloads instead of throwing", () => {
    const fake = makeFakeBusPi();
    registerBtwFeature(fake.pi);
    fake.trigger("session_start", {}, fakeCtx);
    expect(() => fake.pi.events?.emit(BTW_COMMAND_CHANNEL, { kind: "bogus" })).not.toThrow();
    expect(() => fake.pi.events?.emit(BTW_COMMAND_CHANNEL, null)).not.toThrow();
  });

  it("model command with an unresolvable model emits a notice and clears the override", async () => {
    const fake = makeFakeBusPi();
    // resolveBtwSettings (via setBtwModelOverride) reads the main thinking level.
    (fake.pi as unknown as { getThinkingLevel: () => string }).getThinkingLevel = () => "off";
    registerBtwFeature(fake.pi);
    fake.trigger("session_start", {}, fakeCtx);
    await flush();
    fake.pi.events?.emit(BTW_COMMAND_CHANNEL, {
      kind: "model",
      model: { provider: "anthropic", id: "no-such-model", api: "anthropic" },
    });
    await flush();
    const notices = fake.emitted.filter(
      (e) => e.channel === "btw:event" && (e.data as { type?: string }).type === "notice",
    );
    expect(notices.length).toBeGreaterThan(0);
    const text = String((notices.at(-1)?.data as { text?: string }).text);
    expect(text).toContain("model not found");
    expect(text).toContain("anthropic/no-such-model");
  });

  it("emits an initial thread event at session_start (seeds the webui store)", async () => {
    const fake = makeFakeBusPi();
    registerBtwFeature(fake.pi);
    fake.trigger("session_start", {}, fakeCtx);
    await flush();
    expect(threadEvents(fake.emitted).length).toBeGreaterThanOrEqual(1);
  });
});
