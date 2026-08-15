import { describe, expect, it } from "bun:test";
import { createPresentTool, describeHitlResponse } from "../src/present-tool.js";
import type { HitlResponse } from "../src/webui-wiring.js";

/**
 * Fake dependency set mirroring the wiring's pending registry: registerPending
 * stores the resolver; resolve/cancelPending drive it exactly like the wiring's
 * appexec dispatch / abort paths do.
 */
function fakeDeps() {
  const resolvers = new Map<string, (r: HitlResponse) => void>();
  const presented: Array<Record<string, unknown> & { id: string }> = [];
  const deps = {
    presented,
    present: (input: Record<string, unknown> & { id: string }): string => {
      presented.push(input);
      return input.id;
    },
    registerPending: (id: string): Promise<HitlResponse> =>
      new Promise<HitlResponse>((resolve) => resolvers.set(id, resolve)),
    hasPending: (): boolean => resolvers.size > 0,
    cancelPending: (id: string): void => {
      const r = resolvers.get(id);
      if (r) {
        resolvers.delete(id);
        r({ cancelled: true });
      }
    },
    /** Test-side: resolve like the appexec dispatch does. */
    respond: (id: string, action: string, tweak?: string): void => {
      const r = resolvers.get(id);
      if (r) {
        resolvers.delete(id);
        r(tweak !== undefined ? { action, tweak } : { action });
      }
    },
  };
  return deps;
}

const CONTROLS = [
  { id: "approve", label: "Approve" },
  { id: "regenerate", label: "Regenerate…", takesInput: true },
];

describe("createPresentTool", () => {
  it("returns a tool named webui_present with controls as a REQUIRED param", () => {
    const tool = createPresentTool(fakeDeps());
    expect(tool.name).toBe("webui_present");
    expect(tool.parameters.type).toBe("object");
    expect(tool.parameters.properties).toHaveProperty("content");
    expect(tool.parameters.properties).toHaveProperty("controls");
    expect(tool.parameters.required).toContain("controls");
    expect(tool.parameters.properties.controls.type).toBe("array");
  });

  it("execute() presents, blocks, and resolves {action} on respond", async () => {
    const deps = fakeDeps();
    const tool = createPresentTool(deps);
    const p = tool.execute("c1", { content: "# hi", controls: CONTROLS }, undefined, undefined, {} as never);
    // The present dep fired with the full payload + a generated unique id.
    expect(deps.presented).toHaveLength(1);
    expect(deps.presented[0]).toMatchObject({ content: "# hi", controls: CONTROLS });
    const id = deps.presented[0].id;
    expect(id).toMatch(/^present_\d+_\d+$/);
    // respond resolves the blocked execute.
    deps.respond(id, "approve");
    const out = await p;
    expect(out.content).toEqual([{ type: "text", text: "User approved (action: approve)." }]);
    expect(out.details).toEqual({ action: "approve" });
  });

  it("execute() surfaces a tweak in text + details", async () => {
    const deps = fakeDeps();
    const tool = createPresentTool(deps);
    const p = tool.execute("c2", { content: "img", controls: CONTROLS }, undefined, undefined, {} as never);
    deps.respond(deps.presented[0].id, "regenerate", "more red");
    const out = await p;
    expect(out.content[0].text).toBe('User requested regenerate with tweak: "more red".');
    expect(out.details).toEqual({ action: "regenerate", tweak: "more red" });
  });

  it("execute() forwards mode/view/title to the present dep", async () => {
    const deps = fakeDeps();
    const tool = createPresentTool(deps);
    const p = tool.execute(
      "c3",
      { content: "<p>x</p>", mode: "html", view: "review", title: "Review", controls: CONTROLS },
      undefined, undefined, {} as never
    );
    expect(deps.presented[0]).toMatchObject({ mode: "html", view: "review", title: "Review" });
    deps.respond(deps.presented[0].id, "approve");
    await p;
  });

  it("aborting the tool signal cancels the pending → {cancelled:true}", async () => {
    const deps = fakeDeps();
    const tool = createPresentTool(deps);
    const ac = new AbortController();
    const p = tool.execute("c4", { content: "x", controls: CONTROLS }, ac.signal, undefined, {} as never);
    const id = deps.presented[0].id;
    ac.abort();
    const out = await p;
    expect(out.content).toEqual([{ type: "text", text: "User cancelled / connection lost." }]);
    expect(out.details).toEqual({ cancelled: true });
    // cancelPending was invoked with the registered id (the wiring's registry cleared).
    expect(deps.hasPending()).toBe(false);
    expect(id).toMatch(/^present_\d+_\d+$/);
  });

  it("a SECOND webui_present while one is pending → error result (no throw, no second view)", async () => {
    const deps = fakeDeps();
    const tool = createPresentTool(deps);
    const first = tool.execute("c5", { content: "a", controls: CONTROLS }, undefined, undefined, {} as never);
    const second = await tool.execute("c6", { content: "b", controls: CONTROLS }, undefined, undefined, {} as never);
    // Error RESULT (ask-user style: text + details.error), never a thrown crash.
    expect(second.details).toEqual({ error: "already_pending" });
    expect(second.content[0].text).toContain("already pending");
    // Only the FIRST presentation was minted.
    expect(deps.presented).toHaveLength(1);
    // The first is still pending; cancelling it clears the guard.
    deps.cancelPending(deps.presented[0].id);
    const firstOut = await first;
    expect(firstOut.details).toEqual({ cancelled: true });
    const third = tool.execute("c7", { content: "c", controls: CONTROLS }, undefined, undefined, {} as never);
    expect(deps.presented).toHaveLength(2); // guard released — a new present is allowed
    deps.respond(deps.presented[1].id, "approve");
    await third;
  });

  it("generated ids are unique across calls", async () => {
    const deps = fakeDeps();
    const tool = createPresentTool(deps);
    const a = tool.execute("c8", { content: "a", controls: CONTROLS }, undefined, undefined, {} as never);
    deps.cancelPending(deps.presented[0].id);
    await a;
    const b = tool.execute("c9", { content: "b", controls: CONTROLS }, undefined, undefined, {} as never);
    deps.cancelPending(deps.presented[1].id);
    await b;
    expect(deps.presented[0].id).not.toBe(deps.presented[1].id);
  });

  it("an ALREADY-ABORTED signal resolves {cancelled:true} immediately (no hang) and cancels the pending", async () => {
    const deps = fakeDeps();
    const tool = createPresentTool(deps);
    const ac = new AbortController();
    ac.abort(); // aborted BEFORE execute() — the abort listener would never fire
    const out = await tool.execute(
      "c10", { content: "x", controls: CONTROLS }, ac.signal, undefined, {} as never
    );
    expect(out.details).toEqual({ cancelled: true });
    expect(out.content[0].text).toBe("User cancelled / connection lost.");
    // The pending was cancelled through the abort path (not leaked), and the
    // presentation WAS minted before the abort short-circuit.
    expect(deps.presented).toHaveLength(1);
    expect(deps.hasPending()).toBe(false);
  });
});

describe("describeHitlResponse", () => {
  it("approve without tweak", () => {
    expect(describeHitlResponse({ action: "approve" })).toBe("User approved (action: approve).");
  });
  it("any action with tweak", () => {
    expect(describeHitlResponse({ action: "regenerate", tweak: "more red" })).toBe(
      'User requested regenerate with tweak: "more red".'
    );
  });
  it("generic action without tweak", () => {
    expect(describeHitlResponse({ action: "reject" })).toBe('User chose action "reject".');
  });
  it("cancelled", () => {
    expect(describeHitlResponse({ cancelled: true })).toBe("User cancelled / connection lost.");
  });
});
