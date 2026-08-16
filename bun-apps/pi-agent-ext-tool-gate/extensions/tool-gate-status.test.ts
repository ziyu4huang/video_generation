/**
 * tool_gate_status seam (wayfinder ticket 06) — the live-state introspection
 * surface. tool-gate publishes a reader via publishSeam("__piToolGateStatus");
 * power-tool's inspect_context reads it to render the "tool gate" section.
 * This test proves the seam: after session_start the reader reports the core
 * count, per-gate fired/dormant + token cost, and the sticky set; firing a gate
 * updates it live.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import toolGateExtension from "./tool-gate.ts";
import { readSeam, type ToolGateStatus } from "@repo/pi-agent-core-interface";
import { GATE_DEFS } from "@repo/pi-agent-core-interface";

describe("tool_gate_status seam (ticket 06)", () => {
  const saved = { ...GATE_DEFS };
  beforeEach(() => {
    GATE_DEFS["flux2"] = { id: "flux2", keywords: ["flux"] };
    GATE_DEFS["ltx"] = { id: "ltx", keywords: ["ltx"] };
  });
  afterEach(() => {
    for (const k of Object.keys(GATE_DEFS)) delete GATE_DEFS[k];
    Object.assign(GATE_DEFS, saved);
  });

  test("publishes live gate state readable after session_start; updates on gate fire", async () => {
    const handlers: Record<string, (e?: any, ctx?: any) => Promise<void> | void> = {};
    const pi: any = {
      getAllToolDefinitions: () => [
        { name: "read", gating: { core: true } },
        { name: "flux2", gating: { gate: "flux2" } },
        { name: "ltx", gating: { gate: "ltx" } },
      ],
      on: (e: string, h: any) => { handlers[e] = h; },
      setActiveTools: () => {},
      registerTool: () => {},
    };
    toolGateExtension(pi);
    const ctx = { sessionManager: { getSessionId: () => "s" } };
    await handlers.session_start!({}, { ui: { theme: { fg: (_k: string, s: string) => s }, setWidget: () => {} }, ...ctx } as any);

    let status = readSeam("__piToolGateStatus")?.() as ToolGateStatus | undefined;
    expect(status).toBeDefined();
    expect(status!.sessionId).toBe("s");
    expect(status!.activeCount).toBe(1); // read only (core)
    expect(status!.coreCount).toBe(1);
    expect(status!.gates).toHaveLength(2);
    expect(status!.gates.every((g) => g.dormant && !g.fired)).toBe(true);
    expect(status!.sticky).toEqual(["read"]);

    // fire flux2 → sticky + per-gate state update live
    await handlers.before_agent_start!({ prompt: "use flux for a render" }, ctx);
    status = readSeam("__piToolGateStatus")?.() as ToolGateStatus | undefined;
    const flux = status!.gates.find((g) => g.id === "flux2")!;
    expect(flux.fired).toBe(true);
    expect(flux.dormant).toBe(false);
    expect(flux.tokens).toBeGreaterThan(0);
    expect(status!.sticky).toEqual(expect.arrayContaining(["read", "flux2"]));
    expect(status!.sticky).not.toContain("ltx"); // ltx still dormant
  });
});
