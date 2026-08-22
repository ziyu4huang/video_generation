import { afterEach, describe, expect, test } from "bun:test";
import {
  BackgroundRunManager,
  backgroundCap,
  formatTaskNotification,
  wireBackgroundDeliverer,
} from "../src/background-run-manager.js";

const spec = { id: "run-1", agent: "reviewer", model: "m", taskPreview: "do a thing", startedAt: 1000 };

afterEach(() => {
  delete process.env.SUBAGENT_MAX_BACKGROUND;
});

describe("formatTaskNotification", () => {
  test("done outcome renders id/agent/model/status/usage/preview + fetch hint", () => {
    const msg = formatTaskNotification(spec, {
      status: "done",
      output: "x".repeat(900),
      usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, total: 300, cost: 0.01 },
    });
    expect(msg).toContain("<task-notification>");
    expect(msg).toContain("run run-1");
    expect(msg).toContain("agent: reviewer");
    expect(msg).toContain("status: done");
    expect(msg).toContain("usage: 100in / 200out ($0.01)");
    expect(msg).toContain("[truncated]");
    expect(msg.length).toBeLessThan(1200);
    expect(msg).toContain('subcommand "get", id "run-1"');
  });
  test("all failure kinds map 1:1 onto status", () => {
    for (const status of ["failed", "timedout", "budget", "turns", "aborted"] as const) {
      expect(formatTaskNotification(spec, { status })).toContain(`status: ${status}`);
    }
  });
});

describe("BackgroundRunManager", () => {
  test("claim respects the cap; release happens on completion", async () => {
    process.env.SUBAGENT_MAX_BACKGROUND = "2";
    const m = new BackgroundRunManager();
    expect(m.claim("a").ok).toBe(true);
    expect(m.claim("b").ok).toBe(true);
    const full = m.claim("c");
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.error).toContain("background slot limit reached");
    let resolveB!: (o: { status: "done" }) => void;
    m.track(
      { ...spec, id: "b" },
      new Promise((r) => {
        resolveB = r;
      }),
    );
    resolveB({ status: "done" });
    await new Promise((r) => setTimeout(r, 10));
    expect(m.claim("d").ok).toBe(true);
  });
  test("completion delivers via the deliverer with followUp semantics", async () => {
    const m = new BackgroundRunManager();
    const delivered: string[] = [];
    m.setDeliverer((msg) => delivered.push(msg));
    m.track(spec, Promise.resolve({ status: "done", output: "all good" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("status: done");
    expect(m.runningIds()).toEqual([]);
  });
  test("rejection degrades to a failed notification, never an unhandled rejection", async () => {
    const m = new BackgroundRunManager();
    const delivered: string[] = [];
    m.setDeliverer((msg) => delivered.push(msg));
    m.track(spec, Promise.reject(new Error("boom")));
    await new Promise((r) => setTimeout(r, 10));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("status: failed");
    expect(delivered[0]).toContain("boom");
  });
  test("throwing deliverer is swallowed silently", async () => {
    const m = new BackgroundRunManager();
    m.setDeliverer(() => {
      throw new Error("send failed");
    });
    m.track(spec, Promise.resolve({ status: "done" }));
    await new Promise((r) => setTimeout(r, 10)); // no unhandled rejection = pass
  });
  test("backgroundCap: default 4, env override, invalid ignored", () => {
    expect(backgroundCap()).toBe(4);
    process.env.SUBAGENT_MAX_BACKGROUND = "7";
    expect(backgroundCap()).toBe(7);
    process.env.SUBAGENT_MAX_BACKGROUND = "not-a-number";
    expect(backgroundCap()).toBe(4);
  });
  test("release frees a claimed slot without completion (claim→track failure path)", () => {
    process.env.SUBAGENT_MAX_BACKGROUND = "1";
    const m = new BackgroundRunManager();
    expect(m.claim("x").ok).toBe(true);
    expect(m.claim("y").ok).toBe(false);
    m.release("x");
    expect(m.claim("z").ok).toBe(true, "released slot is claimable again");
  });
  test("wireBackgroundDeliverer routes completions through sendMessage with deliverAs followUp", async () => {
    const sent: Array<{ msg: { customType: string; content: string; display: boolean }; opts: unknown }> = [];
    const m = new BackgroundRunManager();
    wireBackgroundDeliverer({ sendMessage: (msg, opts) => sent.push({ msg, opts }) }, m);
    m.track(spec, Promise.resolve({ status: "done" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.opts).toEqual({ deliverAs: "followUp" });
    expect(sent[0]?.msg.customType).toBe("subagent-task-notification");
    expect(sent[0]?.msg.content).toContain("<task-notification>");
  });
  test("wireBackgroundDeliverer degrades to no-wake on a host without sendMessage", async () => {
    const m = new BackgroundRunManager();
    wireBackgroundDeliverer({}, m); // no sendMessage — must not throw, must not wake
    m.track(spec, Promise.resolve({ status: "done" }));
    await new Promise((r) => setTimeout(r, 10)); // completing silently = pass
  });
});
