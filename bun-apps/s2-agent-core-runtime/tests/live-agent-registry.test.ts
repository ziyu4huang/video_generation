import { describe, expect, test } from "bun:test";
import {
  __resetLiveAgentRegistryForTests,
  getLiveAgentRegistry,
  type LiveAgentHandle,
  LiveAgentRegistry,
  maxLiveFromEnv,
  RESERVED_AGENT_NAMES,
} from "../src/live-agent-registry.js";

/** Minimal LiveAgentHandle double — the registry only reads status and calls send/dispose/touch. */
function fakeHandle(status: "running" | "idle" = "idle") {
  const state = { disposed: 0, touched: 0, status };
  const handle: LiveAgentHandle = {
    get status() {
      return state.status;
    },
    send: async () => ({ output: "" }),
    touch: () => state.touched++,
    dispose: () => state.disposed++,
  };
  return { handle, state };
}

function register(reg: LiveAgentRegistry, name: string, status: "running" | "idle" = "idle", agentId = `${name}-id`) {
  const { handle, state } = fakeHandle(status);
  const res = reg.register({ name, agentId, agent: handle, cwd: "/repo" });
  if ("error" in res) throw new Error(`register failed: ${res.error}`);
  return { entry: res, state };
}

describe("LiveAgentRegistry — naming", () => {
  test("reserved names are rejected", () => {
    const reg = new LiveAgentRegistry(4);
    for (const name of RESERVED_AGENT_NAMES) {
      const { handle } = fakeHandle();
      const res = reg.register({ name, agentId: "x", agent: handle, cwd: "/repo" });
      expect("error" in res).toBe(true);
    }
  });

  test("name collisions are rejected and report the live roster", () => {
    const reg = new LiveAgentRegistry(4);
    register(reg, "researcher");
    const { handle } = fakeHandle();
    const res = reg.register({ name: "researcher", agentId: "other", agent: handle, cwd: "/repo" });
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toContain("researcher");
    expect(reg.size).toBe(1);
  });

  test("get resolves by name then agentId", () => {
    const reg = new LiveAgentRegistry(4);
    register(reg, "writer", "idle", "wid-1");
    expect(reg.get("writer")?.agentId).toBe("wid-1");
    expect(reg.get("wid-1")?.name).toBe("writer");
    expect(reg.get("nobody")).toBeUndefined();
  });
});

describe("LiveAgentRegistry — LRU eviction + capacity", () => {
  test("registering past the cap evicts the least-recently-touched IDLE agent", () => {
    const reg = new LiveAgentRegistry(2);
    const a = register(reg, "a");
    const b = register(reg, "b");
    // Force distinct LRU clocks (same-ms registration would tie; ties fall back
    // to registration order, which this test deliberately does not rely on).
    a.entry.lastTouchedAt = 2000;
    b.entry.lastTouchedAt = 1000; // `b` is the LRU victim
    register(reg, "c");
    expect(reg.names().sort()).toEqual(["a", "c"]);
    expect(reg.get("b")).toBeUndefined(); // evicted…
    expect(b.state.disposed).toBe(1); // …and disposed
    expect(a.state.disposed).toBe(0);
  });

  test("a RUNNING agent is never the eviction victim; all-running at cap = error", () => {
    const reg = new LiveAgentRegistry(1);
    register(reg, "busy", "running");
    const { handle } = fakeHandle();
    const res = reg.register({ name: "next", agentId: "n", agent: handle, cwd: "/repo" });
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toContain("mid-exchange");
  });

  test("hasCapacity reflects room and idle-evictability", () => {
    const reg = new LiveAgentRegistry(1);
    expect(reg.hasCapacity()).toBe(true);
    register(reg, "a");
    expect(reg.hasCapacity()).toBe(true); // idle → evictable
    const busy = new LiveAgentRegistry(1);
    register(busy, "busy", "running");
    expect(busy.hasCapacity()).toBe(false);
  });

  test("maxLive=0 disables named agents entirely", () => {
    const reg = new LiveAgentRegistry(0);
    expect(reg.hasCapacity()).toBe(false);
    const { handle } = fakeHandle();
    const res = reg.register({ name: "a", agentId: "i", agent: handle, cwd: "/repo" });
    expect("error" in res).toBe(true);
  });
});

describe("LiveAgentRegistry — disposal scope", () => {
  test("release disposes the agent exactly once and frees the name", () => {
    const reg = new LiveAgentRegistry(4);
    const { state } = register(reg, "a");
    expect(reg.release("a")).toBe(true);
    expect(state.disposed).toBe(1);
    expect(reg.release("a")).toBe(false); // idempotent no-op
    expect(reg.names()).toEqual([]);
    register(reg, "a"); // name reusable after release
  });

  test("disposeFor disposes matching-session entries; '*' disposes everything", () => {
    const reg = new LiveAgentRegistry(8);
    const a = register(reg, "a");
    const b = register(reg, "b");
    a.entry.sessionId = "s1";
    b.entry.sessionId = "s2";
    expect(reg.disposeFor("s1")).toBe(1);
    expect(a.state.disposed).toBe(1);
    expect(b.state.disposed).toBe(0);
    expect(reg.disposeFor("*")).toBe(1);
    expect(b.state.disposed).toBe(1);
  });
});

describe("LiveAgentRegistry — env + singleton", () => {
  test("maxLiveFromEnv parses SUBAGENT_MAX_LIVE with default fallback", () => {
    expect(maxLiveFromEnv({})).toBe(6);
    expect(maxLiveFromEnv({ SUBAGENT_MAX_LIVE: "2" })).toBe(2);
    expect(maxLiveFromEnv({ SUBAGENT_MAX_LIVE: "0" })).toBe(0);
    expect(maxLiveFromEnv({ SUBAGENT_MAX_LIVE: "nope" })).toBe(6);
    expect(maxLiveFromEnv({ SUBAGENT_MAX_LIVE: "-3" })).toBe(6);
  });

  test("getLiveAgentRegistry is a process singleton; reset recreates it", () => {
    const a = getLiveAgentRegistry();
    const b = getLiveAgentRegistry();
    expect(a).toBe(b);
    __resetLiveAgentRegistryForTests();
    expect(getLiveAgentRegistry()).not.toBe(a);
  });
});
