import { describe, expect, it } from "bun:test";
import {
  AgentMutex,
  DEFAULT_WATCHDOG,
  toFrontend,
  type Frontend,
  type MutexClock,
} from "../src/mutex.js";
import { FakeClock } from "./helpers/fake-clock.js";

/** Real wall-clock + native setInterval (for the non-watchdog tests). */
const realClock: MutexClock = {
  now: () => Date.now(),
  setInterval: (h, ms) => {
    const id = globalThis.setInterval(h, ms);
    return { clear: () => globalThis.clearInterval(id) };
  },
};

describe("AgentMutex.gate", () => {
  it("acquires from idle for tui (interactive)", () => {
    const m = new AgentMutex({ clock: realClock });
    expect(m.driver).toBeNull();
    expect(m.gate("interactive")).toEqual({ verdict: "continue", driver: "tui" });
    expect(m.driver).toBe("tui");
  });

  it("acquires from idle for web (extension)", () => {
    const m = new AgentMutex({ clock: realClock });
    expect(m.gate("extension")).toEqual({ verdict: "continue", driver: "web" });
    expect(m.driver).toBe("web");
  });

  it("same-side resubmit while driving -> continue (followUp queues internally)", () => {
    const m = new AgentMutex({ clock: realClock });
    m.gate("interactive");
    expect(m.gate("interactive").verdict).toBe("continue");
    expect(m.driver).toBe("tui");
  });

  it("other-side submit while tui driving -> handled + blocked.by tui", () => {
    const m = new AgentMutex({ clock: realClock });
    m.gate("interactive");
    expect(m.gate("extension")).toEqual({ verdict: "handled", driver: "tui", blocked: { by: "tui" } });
    expect(m.driver).toBe("tui");
  });

  it("symmetric: other-side submit while web driving -> handled + blocked.by web", () => {
    const m = new AgentMutex({ clock: realClock });
    m.gate("extension");
    expect(m.gate("interactive")).toEqual({ verdict: "handled", driver: "web", blocked: { by: "web" } });
  });

  it("rpc passes through ungated from idle (no acquire)", () => {
    const m = new AgentMutex({ clock: realClock });
    expect(m.gate("rpc")).toEqual({ verdict: "continue", driver: null });
    expect(m.driver).toBeNull();
  });

  it("rpc passes through even while a frontend is driving", () => {
    const m = new AgentMutex({ clock: realClock });
    m.gate("interactive");
    expect(m.gate("rpc").verdict).toBe("continue");
    expect(m.driver).toBe("tui");
  });
});

describe("AgentMutex.release", () => {
  it("clears the driver", () => {
    const m = new AgentMutex({ clock: realClock });
    m.gate("interactive");
    m.release("settled");
    expect(m.driver).toBeNull();
  });

  it("is idempotent (release-when-idle is a no-op)", () => {
    const m = new AgentMutex({ clock: realClock });
    expect(() => m.release("settled")).not.toThrow();
    expect(m.driver).toBeNull();
  });

  it("allows re-acquire after release", () => {
    const m = new AgentMutex({ clock: realClock });
    m.gate("interactive");
    m.release("settled");
    expect(m.gate("extension")).toEqual({ verdict: "continue", driver: "web" });
    expect(m.driver).toBe("web");
  });
});

describe("AgentMutex watchdog", () => {
  it("force-releases after staleMs with no bumpActivity", () => {
    const clock = new FakeClock();
    let released: { driver: Frontend } | null = null;
    const m = new AgentMutex({
      clock,
      watchdog: { staleMs: 1000, intervalMs: 100 },
      callbacks: { onForceRelease: (i: { driver: Frontend }) => { released = i; } },
    });
    m.gate("interactive");
    expect(m.driver).toBe("tui");
    clock.advance(1000);
    expect(m.driver).toBeNull();
    expect(released).toEqual({ driver: "tui" });
  });

  it("does NOT force-release before staleMs", () => {
    const clock = new FakeClock();
    const m = new AgentMutex({ clock, watchdog: { staleMs: 1000, intervalMs: 100 } });
    m.gate("interactive");
    clock.advance(900);
    expect(m.driver).toBe("tui");
  });

  it("bumpActivity resets the inactivity window", () => {
    const clock = new FakeClock();
    const m = new AgentMutex({ clock, watchdog: { staleMs: 1000, intervalMs: 100 } });
    m.gate("interactive");
    clock.advance(800);
    m.bumpActivity();
    clock.advance(800);
    expect(m.driver).toBe("tui");
  });

  it("does not fire while idle (no acquire -> no watchdog)", () => {
    const clock = new FakeClock();
    let released = false;
    const m = new AgentMutex({
      clock,
      watchdog: { staleMs: 1000, intervalMs: 100 },
      callbacks: { onForceRelease: () => (released = true) },
    });
    clock.advance(5000);
    expect(released).toBe(false);
    expect(m.driver).toBeNull();
  });

  it("a SUSPENDED watchdog never force-releases (HITL block is legitimate)", () => {
    const clock = new FakeClock();
    let released: { driver: Frontend } | null = null;
    const m = new AgentMutex({
      clock,
      watchdog: { staleMs: 1000, intervalMs: 100 },
      callbacks: { onForceRelease: (i: { driver: Frontend }) => { released = i; } },
    });
    m.gate("interactive");
    m.setWatchdogSuspended(true); // wiring suspends while a presentation is pending
    clock.advance(5000); // far past staleMs — no activity, but suspended
    expect(m.driver).toBe("tui");
    expect(released).toBeNull();
    // Resume -> the NEXT tick force-releases (the turn is still stale).
    m.setWatchdogSuspended(false);
    clock.advance(1000);
    expect(m.driver).toBeNull();
    expect(released).toEqual({ driver: "tui" });
  });
});

describe("toFrontend + DEFAULT_WATCHDOG", () => {
  it("maps sources to frontends (rpc -> null)", () => {
    expect(toFrontend("interactive")).toBe("tui");
    expect(toFrontend("extension")).toBe("web");
    expect(toFrontend("rpc")).toBeNull();
  });

  it("DEFAULT_WATCHDOG = 10 min stale / 1 s tick", () => {
    expect(DEFAULT_WATCHDOG.staleMs).toBe(600_000);
    expect(DEFAULT_WATCHDOG.intervalMs).toBe(1000);
  });
});
