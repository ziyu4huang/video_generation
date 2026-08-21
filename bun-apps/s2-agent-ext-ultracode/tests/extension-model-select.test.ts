import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Upstream ticket 10 — `model_select` subscription in extensions/ultracode.ts:
 * a mid-session model switch (/model, model cycling) must reach
 * manager.setMainModel so future dispatches auto-tier against the newly
 * selected main model (mirrors the session_start capture; in-flight runs are
 * not mutated).
 *
 * The manager is closure-private inside extension(), but every model capture
 * funnels through WorkflowManager.prototype.setMainModel — spy it. Only
 * model_select is fired here (session_start needs a full ctx.ui and is covered
 * elsewhere); firing model_select twice proves the captured model CHANGES.
 */
describe("workflow extension — model_select tracking (upstream 10)", () => {
  it("routes each model_select event's model into manager.setMainModel", async () => {
    type Handler = (...args: unknown[]) => unknown;
    const handlers: Record<string, Handler[]> = {};
    const pi = new Proxy(
      { events: { on: () => {}, emit: () => {} } },
      {
        get(target, prop) {
          if (prop === "on")
            return (event: string, handler: Handler) => {
              const bucket = handlers[event];
              if (bucket) bucket.push(handler);
              else handlers[event] = [handler];
            };
          if (prop === "getActiveTools") return () => [];
          if (prop === "events") return target.events;
          if (prop in target) return (target as Record<PropertyKey, unknown>)[prop];
          return () => {};
        },
      },
    ) as unknown as ExtensionAPI;

    const setCalls: Array<string | undefined> = [];
    const { WorkflowManager } = await import("../src/index.js");
    const original = WorkflowManager.prototype.setMainModel;
    WorkflowManager.prototype.setMainModel = function (this: WorkflowManager, spec: string | undefined) {
      setCalls.push(spec);
      return original.call(this, spec);
    };

    try {
      const { default: extension } = await import("../extensions/ultracode.js");
      extension(pi);

      assert.ok(handlers.model_select?.length, "extension registered no model_select handler");

      const fire = (model: { provider: string; id: string } | undefined) => {
        for (const handler of handlers.model_select ?? []) handler({ model });
      };

      fire({ provider: "prov-a", id: "id-a" });
      fire({ provider: "prov-b", id: "id-b" });

      // The two switches each landed, in order, and the captured model CHANGED.
      const tail = setCalls.slice(-2);
      assert.deepEqual(
        tail,
        ["prov-a/id-a", "prov-b/id-b"],
        `unexpected setMainModel calls: ${JSON.stringify(setCalls)}`,
      );

      // Unset model clears the capture (mirrors the session_start ternary).
      fire(undefined);
      assert.equal(setCalls[setCalls.length - 1], undefined, "model_select with no model must clear mainModel");
    } finally {
      WorkflowManager.prototype.setMainModel = original;
    }
  });
});
