/**
 * PendingProtocolMap (agent-teams parity ticket 04,
 * effort .planning/2026-08-22-subagent-teams-parity).
 *
 * Pins the plan-approval hold/resolve contract: respond (approve + deny +
 * feedback), the D6 timeout default-deny, release/clear semantics, the
 * superseding second hold, and the singleton identity. Timers are faked —
 * no test sleeps on a real clock.
 */
import { describe, expect, test } from "bun:test";
import type { PendingProtocolTimer } from "./pending-protocol.js";
import { __resetPendingProtocolMapForTests, getPendingProtocolMap, PendingProtocolMap } from "./pending-protocol.js";

/** Deterministic timer fake: tasks queue in order, fire only when told. */
function fakeTimer(): PendingProtocolTimer & { fire(idx: number): void; pending: number; nowMs: number } {
  const tasks: Array<{ fn: () => void; at: number }> = [];
  let now = 0;
  return {
    pending: 0,
    get nowMs() {
      return now;
    },
    setTimeout(fn, ms) {
      const idx = tasks.push({ fn, at: now + ms }) - 1;
      this.pending = tasks.length;
      return idx;
    },
    clearTimeout(handle) {
      tasks[handle as number] = undefined as never;
      this.pending = tasks.filter(Boolean).length;
    },
    now: () => now,
    fire(idx) {
      const t = tasks[idx];
      if (!t) throw new Error(`no timer task ${idx}`);
      now = t.at;
      t.fn();
    },
  };
}

function mk() {
  const timer = fakeTimer();
  return { map: new PendingProtocolMap(timer), timer };
}

describe("PendingProtocolMap — hold + respond", () => {
  test("approve resolves the held promise with feedback", async () => {
    const { map } = mk();
    const p = map.hold("researcher", "do A then B", 1000);
    expect(map.respond("researcher", { approved: true, feedback: "skip B" })).toBe(true);
    await expect(p).resolves.toEqual({ approved: true, feedback: "skip B" });
  });

  test("deny resolves approved:false without timedOut (an explicit parental DENY)", async () => {
    const { map } = mk();
    const p = map.hold("researcher", "plan", 1000);
    map.respond("researcher", { approved: false, feedback: "too risky" });
    const outcome = await p;
    expect(outcome.approved).toBe(false);
    expect(outcome.feedback).toBe("too risky");
    expect(outcome.timedOut).toBeUndefined();
    expect(outcome.released).toBeUndefined();
  });

  test("respond with nothing pending returns false (no silent pass)", () => {
    const { map } = mk();
    expect(map.respond("ghost", { approved: true })).toBe(false);
  });

  test("a second hold under a taken key supersedes the first (released default-deny)", async () => {
    const { map } = mk();
    const first = map.hold("w", "plan one", 1000);
    const second = map.hold("w", "plan two", 1000);
    await expect(first).resolves.toEqual({ approved: false, released: true });
    map.respond("w", { approved: true });
    await expect(second).resolves.toEqual({ approved: true });
  });
});

describe("PendingProtocolMap — timeout (D6 default-deny)", () => {
  test("the timeout resolves approved:false + timedOut", async () => {
    const { map, timer } = mk();
    const p = map.hold("researcher", "plan", 500);
    timer.fire(0);
    await expect(p).resolves.toEqual({ approved: false, timedOut: true });
    // The fired hold is gone — a late respond is a no-op, never a second resolve.
    expect(map.respond("researcher", { approved: true })).toBe(false);
  });

  test("a responded hold clears its timer (no zombie default-deny)", async () => {
    const { map, timer } = mk();
    const p = map.hold("researcher", "plan", 500);
    map.respond("researcher", { approved: true });
    expect(() => timer.fire(0)).toThrow(); // cleared task
    await expect(p).resolves.toEqual({ approved: true });
  });
});

describe("PendingProtocolMap — release/clear", () => {
  test("release drops a hold default-deny", async () => {
    const { map } = mk();
    const p = map.hold("researcher", "plan", 1000);
    expect(map.release("researcher")).toBe(true);
    await expect(p).resolves.toEqual({ approved: false, released: true });
    expect(map.release("researcher")).toBe(false);
  });

  test("clear releases every held key and reports the count", async () => {
    const { map } = mk();
    const ps = [map.hold("a", "p", 1000), map.hold("b", "p", 1000), map.hold("c", "p", 1000)];
    expect(map.clear()).toBe(3);
    for (const p of ps) await expect(p).resolves.toEqual({ approved: false, released: true });
    expect(map.size).toBe(0);
  });

  test("pendingNames + view expose held state for diagnostics", () => {
    const { map } = mk();
    map.hold("researcher", "the plan", 1000);
    expect(map.pendingNames()).toEqual(["researcher"]);
    const v = map.view("researcher");
    expect(v?.plan).toBe("the plan");
    expect(v?.timeoutMs).toBe(1000);
    expect(map.view("ghost")).toBeUndefined();
  });
});

describe("PendingProtocolMap — singleton", () => {
  test("getPendingProtocolMap returns one instance until the test reset", () => {
    __resetPendingProtocolMapForTests();
    const a = getPendingProtocolMap();
    const b = getPendingProtocolMap();
    expect(a).toBe(b);
    __resetPendingProtocolMapForTests();
    expect(getPendingProtocolMap()).not.toBe(a);
  });
});
