/**
 * Bridge availability regression (found by the live tmux deploy verification
 * 2026-08-24): pi 0.84.2's fixed-shape ExtensionAPI hides runtime methods from
 * the `pi` object extensions hold, so `pi.getAllToolDefinitions` is undefined
 * in real hosts. tool-gate's old direct read then produced [] and — because
 * tool-gate loads LAST in the deploy order (registry order 190) — its
 * setActiveTools(filterActive([])) wiped EVERY tool from the deployed
 * session's API requests (deployed request tools(0) vs repo tools(15); repo
 * was masked only by subagent/ultracode force-activators running later).
 *
 * Two contracts pinned here:
 *  1. Global-bridge-only host (the deployed reality): discovery goes through
 *     readAllToolDefinitions' globalThis fallback and gating works normally.
 *  2. Bridge fully down (no reader surface at all): session_start and
 *     before_agent_start NEVER call setActiveTools — an unreadable toolset is
 *     not an empty one.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import toolGateExtension from "./tool-gate.ts";
import { ALL_TOOL_DEFINITIONS_GLOBAL, GATE_DEFS } from "@repo/s2-agent-core-interface";

const g = globalThis as unknown as Record<string, unknown>;

describe("tool discovery bridge availability", () => {
  const saved = { ...GATE_DEFS };
  beforeEach(() => {
    GATE_DEFS["flux2"] = { id: "flux2", keywords: ["flux"] };
  });
  afterEach(() => {
    for (const k of Object.keys(GATE_DEFS)) delete GATE_DEFS[k];
    Object.assign(GATE_DEFS, saved);
    delete g[ALL_TOOL_DEFINITIONS_GLOBAL];
  });

  const makePi = (tools: Array<Record<string, unknown>>, active: string[]) => {
    const handlers: Record<string, (e?: any, ctx?: any) => Promise<void> | void> = {};
    let setActiveCalls = 0;
    const pi: any = {
      // NOTE: no getAllToolDefinitions — the pi 0.84.2 fixed-shape reality.
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => {
        setActiveCalls++;
        active.splice(0, active.length, ...names);
      },
      on: (e: string, h: any) => { handlers[e] = h; },
      registerTool: () => {},
    };
    g[ALL_TOOL_DEFINITIONS_GLOBAL] = () => tools;
    return { pi, handlers, get setActiveCalls() { return setActiveCalls; } };
  };

  test("global-bridge-only host: gating works via the globalThis fallback", async () => {
    const active = ["read", "spawn_subagent", "flux2"];
    const { pi, handlers } = makePi([
      { name: "read", gating: { core: true } },
      { name: "spawn_subagent", gating: { core: true } },
      { name: "flux2", gating: { gate: "flux2" } },
    ], active);
    toolGateExtension(pi);
    const ctx = { sessionManager: { getSessionId: () => "s" } };
    await handlers.session_start!({}, { ui: { theme: { fg: (_k: string, s: string) => s }, setWidget: () => {} }, ...ctx } as any);
    // core tools stay active, the gated flux2 is dormant until its keyword fires
    expect(active).toEqual(expect.arrayContaining(["read", "spawn_subagent"]));
    expect(active).not.toContain("flux2");
    await handlers.before_agent_start!({ prompt: "use flux for a render" }, ctx);
    expect(active).toContain("flux2");
  });

  test("bridge down: setActiveTools is never called (no wipe)", async () => {
    const handlers: Record<string, (e?: any, ctx?: any) => Promise<void> | void> = {};
    const active = ["read", "bash", "spawn_subagent", "run_workflow"];
    let setActiveCalls = 0;
    const pi: any = {
      // No getAllToolDefinitions AND no global reader set — bridge fully down.
      getActiveTools: () => active,
      setActiveTools: () => { setActiveCalls++; },
      on: (e: string, h: any) => { handlers[e] = h; },
      registerTool: () => {},
    };
    toolGateExtension(pi);
    const ctx = { sessionManager: { getSessionId: () => "s2" } };
    await handlers.session_start!({}, { ui: { theme: { fg: (_k: string, s: string) => s }, setWidget: () => {} }, ...ctx } as any);
    await handlers.before_agent_start!({ prompt: "use flux for a render" }, ctx);
    expect(setActiveCalls).toBe(0);
    expect(active).toEqual(["read", "bash", "spawn_subagent", "run_workflow"]);
  });
});
