import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Wiring-level regression for the Layer-3 guideline injection (RCA: the
 * before_agent_start handler interpolated the ASYNC builder without awaiting
 * it, so every turn's system prompt ended in the literal "[object Promise]"
 * and the guidelines never reached the model). Unit tests on the builder
 * cannot catch this — only firing the extension's actual handler can.
 */
describe("workflow extension — before_agent_start guideline injection", () => {
  it("appends resolved guideline text (never '[object Promise]') to the system prompt", async () => {
    type Handler = (event: { prompt?: string; systemPrompt?: string }) => unknown;
    const handlers: Handler[] = [];
    const pi = new Proxy(
      { events: { on: () => {}, emit: () => {} } },
      {
        get(target, prop) {
          if (prop === "on")
            return (event: string, handler: Handler) => {
              if (event === "before_agent_start") handlers.push(handler);
            };
          if (prop === "getActiveTools") return () => [];
          if (prop === "events") return target.events;
          if (prop in target) return (target as Record<PropertyKey, unknown>)[prop];
          return () => {};
        },
      },
    ) as unknown as ExtensionAPI;

    const { default: extension } = await import("../extensions/ultracode.js");
    extension(pi);
    assert.ok(handlers.length > 0, "extension registered no before_agent_start handler");

    // Fire every registered handler; the guideline injector is the one that
    // returns { systemPrompt } (the tool-activation handler returns undefined).
    const base = "BASE-SYSTEM-PROMPT";
    let injected: string | undefined;
    for (const handler of handlers) {
      const result = await handler({ prompt: "run a workflow to audit this repo", systemPrompt: base });
      const sp = (result as { systemPrompt?: unknown } | undefined)?.systemPrompt;
      if (typeof sp === "string" && sp !== base) injected = sp;
    }

    assert.ok(injected, "no handler returned an augmented systemPrompt");
    assert.ok(injected.startsWith(base), "base system prompt must be preserved");
    assert.ok(!injected.includes("[object Promise]"), "async builder result must be awaited, not interpolated");
    // The appended block must be real guideline prose, not an empty suffix.
    assert.ok(
      injected.length > base.length + 40,
      `guideline block looks empty: ${JSON.stringify(injected.slice(base.length))}`,
    );
  });
});
