/**
 * autocompact — hermetic unit tests for the /autocompact command and the
 * agent_settled trigger check. No LLM, no TUI: ctx is a fake with injected
 * ContextUsage and a compact spy. The contract pin (the factory registers the
 * command) lives at the bottom, using the same mock-pi shape as
 * extension-contract.test.ts.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  parseAutocompactArg,
  renderStatus,
  checkAutocompact,
  setThreshold,
  getThreshold,
  isCompacting,
  resetAutocompact,
  makeAutocompactCommand,
} from "../autocompact.ts";

interface FakeUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

function makeCtx(usage: FakeUsage | undefined, sid = "sess-1") {
  const notifications: { msg: string; level?: string }[] = [];
  const compactCalls: unknown[] = [];
  let idle = true;
  const ctx = {
    ui: { notify: (msg: string, level?: string) => notifications.push({ msg, level }) },
    isIdle: () => idle,
    getContextUsage: () => usage,
    compact: (opts?: { onComplete?: () => void; onError?: (e: Error) => void }) => {
      compactCalls.push(opts);
      // Simulate async completion by default so the debounce guard clears.
      queueMicrotask(() => opts?.onComplete?.());
    },
    sessionManager: { getSessionId: () => sid },
  };
  return {
    ctx,
    notifications,
    compactCalls,
    setIdle(v: boolean) {
      idle = v;
    },
  };
}

beforeEach(() => resetAutocompact());

describe("parseAutocompactArg", () => {
  test("no args → status", () => {
    expect(parseAutocompactArg("")).toEqual({ ok: true, value: { kind: "status" } });
    expect(parseAutocompactArg("   ")).toEqual({ ok: true, value: { kind: "status" } });
  });
  test("off synonyms", () => {
    for (const a of ["off", "OFF", "none", "disable"]) {
      expect(parseAutocompactArg(a)).toEqual({ ok: true, value: { kind: "off" } });
    }
  });
  test("<N>k and <N> parse to token counts", () => {
    expect(parseAutocompactArg("400k")).toEqual({ ok: true, value: { kind: "set", threshold: 400_000 } });
    expect(parseAutocompactArg("2K")).toEqual({ ok: true, value: { kind: "set", threshold: 2_000 } });
    expect(parseAutocompactArg("400000")).toEqual({ ok: true, value: { kind: "set", threshold: 400_000 } });
    expect(parseAutocompactArg("1.5k")).toEqual({ ok: true, value: { kind: "set", threshold: 1_500 } });
  });
  test("rejects junk, zero, negatives", () => {
    expect(parseAutocompactArg("banana").ok).toBe(false);
    expect(parseAutocompactArg("-5k").ok).toBe(false);
    expect(parseAutocompactArg("0k").ok).toBe(false);
    expect(parseAutocompactArg("0").ok).toBe(false);
    expect(parseAutocompactArg("4k bananas").ok).toBe(false);
  });
});

describe("command handler", () => {
  async function run(args: string, usage: FakeUsage | undefined) {
    const env = makeCtx(usage);
    const cmd = makeAutocompactCommand();
    await cmd.handler(args, env.ctx as never);
    return env;
  }

  test("status with no args, unarmed", async () => {
    const env = await run("", { tokens: 1000, contextWindow: 128000, percent: 0.8 });
    expect(env.notifications[0].msg).toContain("OFF");
    expect(env.notifications[0].msg).toContain("1,000");
  });

  test("arming records the threshold and echoes status", async () => {
    const env = await run("50k", { tokens: 1000, contextWindow: 128000, percent: 0.8 });
    expect(getThreshold("sess-1")).toBe(50_000);
    expect(env.notifications[0].msg).toContain("armed at 50k");
  });

  test("rejects threshold ≥ context window", async () => {
    const env = await run("400k", { tokens: 1000, contextWindow: 200000, percent: 0.5 });
    expect(getThreshold("sess-1")).toBeUndefined();
    expect(env.notifications[0].level).toBe("error");
    expect(env.notifications[0].msg).toContain("context window");
  });

  test("invalid arg notifies an error and does not touch state", async () => {
    const env = await run("banana", { tokens: 1000, contextWindow: 128000, percent: 0.8 });
    expect(getThreshold("sess-1")).toBeUndefined();
    expect(env.notifications[0].level).toBe("error");
  });

  test("off disarms an armed session", async () => {
    await run("50k", { tokens: 1000, contextWindow: 128000, percent: 0.8 });
    const env = await run("off", undefined);
    expect(getThreshold("sess-1")).toBeUndefined();
    expect(env.notifications[0].msg).toContain("disarmed");
  });

  test("status survives unknown usage (no model)", async () => {
    const env = await run("", undefined);
    expect(env.notifications[0].msg).toContain("OFF");
    expect(env.notifications[0].msg).toContain("unknown");
  });
});

describe("renderStatus", () => {
  test("unknown tokens render the fresh-compaction note", () => {
    setThreshold("s", 5000);
    const out = renderStatus("s", { tokens: null, contextWindow: 128000, percent: null });
    expect(out).toContain("armed at 5k");
    expect(out).toContain("unknown");
  });
});

describe("checkAutocompact (agent_settled hook)", () => {
  test("no trigger when unarmed", () => {
    const env = makeCtx({ tokens: 100000, contextWindow: 128000, percent: 78 });
    expect(checkAutocompact(env.ctx as never)).toBe(false);
    expect(env.compactCalls.length).toBe(0);
  });

  test("no trigger below threshold", () => {
    setThreshold("sess-1", 50_000);
    const env = makeCtx({ tokens: 49_999, contextWindow: 128000, percent: 39 });
    expect(checkAutocompact(env.ctx as never)).toBe(false);
  });

  test("triggers at/above threshold, notifies, calls compact", () => {
    setThreshold("sess-1", 50_000);
    const env = makeCtx({ tokens: 50_000, contextWindow: 128000, percent: 39.1 });
    expect(checkAutocompact(env.ctx as never)).toBe(true);
    expect(env.compactCalls.length).toBe(1);
    expect(env.notifications.some((n) => n.msg.includes("threshold 50k reached"))).toBe(true);
  });

  test("debounce: in-flight guard blocks a second trigger until onComplete", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const env = makeCtx({ tokens: 60_000, contextWindow: 128000, percent: 47 });
    // Replace compact with a gated one that only completes when released.
    (env.ctx as { compact: unknown }).compact = (opts?: { onComplete?: () => void }) => {
      env.compactCalls.push(opts);
      void gate.then(() => opts?.onComplete?.());
    };
    setThreshold("sess-1", 50_000);
    expect(checkAutocompact(env.ctx as never)).toBe(true);
    expect(isCompacting("sess-1")).toBe(true);
    expect(checkAutocompact(env.ctx as never)).toBe(false); // in-flight
    expect(env.compactCalls.length).toBe(1);
    release();
    await gate;
    expect(isCompacting("sess-1")).toBe(false);
    expect(checkAutocompact(env.ctx as never)).toBe(true); // still over → re-arms after completion
    expect(env.compactCalls.length).toBe(2);
  });

  test("skips when tokens unknown (null — fresh compaction)", () => {
    setThreshold("sess-1", 50_000);
    const env = makeCtx({ tokens: null, contextWindow: 128000, percent: null });
    expect(checkAutocompact(env.ctx as never)).toBe(false);
  });

  test("skips when usage undefined (no model)", () => {
    setThreshold("sess-1", 50_000);
    const env = makeCtx(undefined);
    expect(checkAutocompact(env.ctx as never)).toBe(false);
  });

  test("skips when not idle (mid-stream belt guard)", () => {
    setThreshold("sess-1", 50_000);
    const env = makeCtx({ tokens: 90_000, contextWindow: 128000, percent: 70 });
    env.setIdle(false);
    expect(checkAutocompact(env.ctx as never)).toBe(false);
  });

  test("per-session isolation: sibling session's threshold does not leak", () => {
    setThreshold("parent", 50_000);
    const child = makeCtx({ tokens: 90_000, contextWindow: 128000, percent: 70 }, "child-session");
    expect(checkAutocompact(child.ctx as never)).toBe(false);
    expect(getThreshold("child-session")).toBeUndefined();
  });

  test("onError clears the guard and notifies the failure", () => {
    setThreshold("sess-1", 50_000);
    const env = makeCtx({ tokens: 60_000, contextWindow: 128000, percent: 47 });
    // compact fires onError instead of onComplete.
    (env.ctx as { compact: unknown }).compact = (opts?: { onError?: (e: Error) => void }) => {
      env.compactCalls.push(opts);
      queueMicrotask(() => opts?.onError?.(new Error("Nothing to compact (session too small)")));
    };
    checkAutocompact(env.ctx as never);
    // Drain the microtask queue, then assert the guard cleared + error surfaced.
    return Promise.resolve().then(() => {
      Promise.resolve().then(() => {
        expect(isCompacting("sess-1")).toBe(false);
        const err = env.notifications.find((n) => n.level === "error");
        expect(err?.msg).toContain("compaction failed");
        expect(err?.msg).toContain("Nothing to compact");
      });
    });
  });

  test("arming while already over the threshold does NOT compact mid-command (waits for agent_settled)", async () => {
    const env = makeCtx({ tokens: 90_000, contextWindow: 128000, percent: 70 });
    const cmd = makeAutocompactCommand();
    await cmd.handler("50k", env.ctx as never);
    expect(getThreshold("sess-1")).toBe(50_000);
    expect(env.compactCalls.length).toBe(0); // pin: the handler never triggers compaction itself
  });

  test("re-arming clears a stuck in-flight guard (review finding 1)", async () => {
    setThreshold("sess-1", 50_000);
    // Simulate a hung compaction: compact that never calls back.
    const env = makeCtx({ tokens: 60_000, contextWindow: 128000, percent: 47 });
    (env.ctx as { compact: unknown }).compact = (opts?: unknown) => env.compactCalls.push(opts);
    checkAutocompact(env.ctx as never);
    expect(isCompacting("sess-1")).toBe(true);
    // Re-arm via the command — fresh intent must reset the guard.
    const cmd = makeAutocompactCommand();
    await cmd.handler("60k", env.ctx as never);
    expect(isCompacting("sess-1")).toBe(false);
    // ...and the next settled check can fire again.
    expect(checkAutocompact(env.ctx as never)).toBe(true);
  });
});

describe("contract pin: factory registers /autocompact", () => {
  test("extension factory registers the autocompact command and the agent_settled hook", async () => {
    const commands: { name: string; handler: unknown }[] = [];
    const events: string[] = [];
    const pi = {
      registerTool: () => {},
      registerCommand: (name: string, opts: { handler: unknown }) => commands.push({ name, handler: opts.handler }),
      on: (event: string) => events.push(event),
      getAllTools: () => [],
      getCommands: () => [],
    };
    const { default: factory } = await import("../index.ts");
    factory(pi as never);
    const cmd = commands.find((c) => c.name === "autocompact");
    expect(cmd).toBeDefined();
    expect(typeof cmd?.handler).toBe("function");
    expect(events).toContain("agent_settled");
  });
});
