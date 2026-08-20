import { describe, expect, it } from "bun:test";
import { createPresentTool, describeHitlResponse } from "../src/present-tool.js";
import type { HitlResponse } from "../src/webui-wiring.js";

/**
 * Fake dependency set mirroring the wiring's pending registry: registerPending
 * stores the resolver; resolve/cancelPending drive it exactly like the wiring's
 * appexec dispatch / abort paths do. The connected-gate surface (ticket 01)
 * mirrors the server's clientCount + clients-changed seam: `setClients(n)`
 * updates the count and fans out to active subscribers (exactly what
 * WebServer.notifyClientsChanged does on ws open/close).
 */
function fakeDeps(opts?: { clientCount?: number; dropOnPresent?: boolean }) {
  const resolvers = new Map<string, (r: HitlResponse) => void>();
  const presented: Array<Record<string, unknown> & { id: string }> = [];
  let clients = opts?.clientCount ?? 1;
  const watchers = new Set<(count: number) => void>();
  const deps = {
    presented,
    present: (input: Record<string, unknown> & { id: string }): string => {
      presented.push(input);
      // Simulates a disconnect landing BETWEEN the call-time gate and the
      // mid-wait subscription (the arm race the re-check closes).
      if (opts?.dropOnPresent) clients = 0;
      return input.id;
    },
    registerPending: (id: string): Promise<HitlResponse> =>
      new Promise<HitlResponse>((resolve) => resolvers.set(id, resolve)),
    hasPending: (): boolean => resolvers.size > 0,
    cancelPending: (id: string, reason?: string): void => {
      const r = resolvers.get(id);
      if (r) {
        resolvers.delete(id);
        r(reason !== undefined ? { cancelled: true, reason } : { cancelled: true });
      }
    },
    getClientCount: (): number => clients,
    onClientsChanged: (cb: (count: number) => void): (() => void) => {
      watchers.add(cb);
      return () => watchers.delete(cb);
    },
    /** Test-side: resolve like the appexec dispatch does. */
    respond: (id: string, action: string, tweak?: string): void => {
      const r = resolvers.get(id);
      if (r) {
        resolvers.delete(id);
        r(tweak !== undefined ? { action, tweak } : { action });
      }
    },
    /** Test-side: simulate a client connect/disconnect (fires watchers). */
    setClients: (n: number): void => {
      clients = n;
      for (const cb of [...watchers]) cb(n);
    },
    /** Test-side: active watcher count (asserts detach-on-settlement). */
    watcherCount: (): number => watchers.size,
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

describe("createPresentTool — connected-gate (ticket 01, spec §C1)", () => {
  it("zero clients at call time → immediate {skipped:'no_client'} (no view, nothing pending)", async () => {
    const deps = fakeDeps({ clientCount: 0 });
    const tool = createPresentTool(deps);
    const out = await tool.execute("g1", { content: "x", controls: CONTROLS }, undefined, undefined, {} as never);
    // Skipped RESULT (same ask-user envelope style), never a throw or a hang.
    expect(out.details).toEqual({ skipped: "no_client" });
    expect(out.content[0].text).toContain("No webui client connected");
    // Nothing was minted or armed — the TUI-only session never blocks.
    expect(deps.presented).toHaveLength(0);
    expect(deps.hasPending()).toBe(false);
    expect(deps.watcherCount()).toBe(0);
  });

  it("no-client gate wins over the one-pending guard", async () => {
    const deps = fakeDeps({ clientCount: 0 });
    const tool = createPresentTool(deps);
    // Arm a pending manually so hasPending() is true, then call — no_client
    // must take precedence (it tells the caller to FALL BACK and continue).
    // Arm the entry WITHOUT awaiting — its promise only settles via
    // respond/cancelPending, so `await` here would hang forever.
    void deps.registerPending("present_manual_1");
    const out = await tool.execute("g2", { content: "x", controls: CONTROLS }, undefined, undefined, {} as never);
    expect(out.details).toEqual({ skipped: "no_client" });
    expect(deps.presented).toHaveLength(0);
    deps.cancelPending("present_manual_1");
  });

  it("mid-wait disconnect (1→0) → {cancelled:true, reason:'no_client'} + watcher detached", async () => {
    const deps = fakeDeps({ clientCount: 1 });
    const tool = createPresentTool(deps);
    const p = tool.execute("g3", { content: "x", controls: CONTROLS }, undefined, undefined, {} as never);
    const id = deps.presented[0].id;
    expect(deps.hasPending()).toBe(true);
    expect(deps.watcherCount()).toBe(1); // subscribed while pending
    deps.setClients(0); // last client disconnects mid-wait
    const out = await p;
    expect(out.details).toEqual({ cancelled: true, reason: "no_client" });
    expect(out.content[0].text).toContain("disconnected");
    expect(deps.hasPending()).toBe(false); // registry cleared — no leak
    expect(deps.watcherCount()).toBe(0); // detached on settlement
    // Post-settlement count churn is inert (no permanent listeners).
    deps.setClients(1);
    deps.setClients(0);
    expect(id).toMatch(/^present_\d+_\d+$/);
  });

  it("arm race: disconnect landing between the call-time gate and the subscription still releases", async () => {
    // dropOnPresent flips the count to 0 DURING arming — the subscription
    // callback never fires for it, so only the re-check can catch it.
    const deps = fakeDeps({ clientCount: 1, dropOnPresent: true });
    const tool = createPresentTool(deps);
    const p = tool.execute("g4", { content: "x", controls: CONTROLS }, undefined, undefined, {} as never);
    const out = await p;
    expect(out.details).toEqual({ cancelled: true, reason: "no_client" });
    expect(deps.hasPending()).toBe(false);
    expect(deps.watcherCount()).toBe(0);
  });

  it("partial disconnect (2→1) does NOT release; with-client respond flow unchanged", async () => {
    const deps = fakeDeps({ clientCount: 2 });
    const tool = createPresentTool(deps);
    const p = tool.execute("g5", { content: "x", controls: CONTROLS }, undefined, undefined, {} as never);
    deps.setClients(1); // one browser tab of two closes — still connected
    expect(deps.hasPending()).toBe(true); // still blocked, not released
    deps.respond(deps.presented[0].id, "approve");
    const out = await p;
    // Byte-identical to the pre-gate with-client result.
    expect(out.content).toEqual([{ type: "text", text: "User approved (action: approve)." }]);
    expect(out.details).toEqual({ action: "approve" });
    expect(deps.watcherCount()).toBe(0);
  });

  it("gate deps absent → ungated v1 behavior (count surface optional)", async () => {
    const deps = fakeDeps({ clientCount: 0 }) as Record<string, unknown>;
    delete deps.getClientCount;
    delete deps.onClientsChanged;
    const tool = createPresentTool(deps as unknown as Parameters<typeof createPresentTool>[0]);
    // No gate: the call proceeds (presents + blocks) exactly like v1.
    const p = tool.execute("g6", { content: "x", controls: CONTROLS }, undefined, undefined, {} as never);
    expect(deps.presented as unknown[]).toHaveLength(1);
    (deps.respond as (id: string, action: string) => void)(
      ((deps.presented as Array<{ id: string }>)[0]).id,
      "approve"
    );
    const out = await p;
    expect(out.details).toEqual({ action: "approve" });
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
