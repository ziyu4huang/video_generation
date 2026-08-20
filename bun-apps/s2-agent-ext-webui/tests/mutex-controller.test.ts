import { describe, expect, it } from "bun:test";
import { MutexController, type MutexNotifier } from "../src/mutex-controller.js";
import type { Frontend } from "../src/mutex.js";
import { FakeClock } from "./helpers/fake-clock.js";

const realClock = {
  now: () => Date.now(),
  setInterval: (h: () => void, ms: number) => {
    const id = globalThis.setInterval(h, ms);
    return { clear: () => globalThis.clearInterval(id) };
  },
};

/** Recording notifier — captures calls so tests can assert on them. */
function recorder(): MutexNotifier & {
  blocked: Array<{ blocked: Frontend; by: Frontend }>;
  force: Frontend[];
} {
  const blocked: Array<{ blocked: Frontend; by: Frontend }> = [];
  const force: Frontend[] = [];
  return {
    blocked,
    force,
    notifyBlocked(b, by) { blocked.push({ blocked: b, by }); },
    notifyForceRelease(d) { force.push(d); },
  };
}

describe("MutexController.handleInput", () => {
  it("acquires from idle and returns continue (no notify)", () => {
    const n = recorder();
    const c = new MutexController({ clock: realClock, notifier: n });
    expect(c.handleInput("interactive")).toEqual({ action: "continue" });
    expect(c.driver).toBe("tui");
    expect(n.blocked).toHaveLength(0);
  });

  it("blocks the other side: handled + notifyBlocked(web, tui)", () => {
    const n = recorder();
    const c = new MutexController({ clock: realClock, notifier: n });
    c.handleInput("interactive");
    expect(c.handleInput("extension")).toEqual({ action: "handled" });
    expect(n.blocked).toEqual([{ blocked: "web", by: "tui" }]);
    expect(c.driver).toBe("tui");
  });

  it("symmetric: blocks tui while web driving", () => {
    const n = recorder();
    const c = new MutexController({ clock: realClock, notifier: n });
    c.handleInput("extension");
    expect(c.handleInput("interactive")).toEqual({ action: "handled" });
    expect(n.blocked).toEqual([{ blocked: "tui", by: "web" }]);
  });

  it("same-side resubmit: continue, no notify", () => {
    const n = recorder();
    const c = new MutexController({ clock: realClock, notifier: n });
    c.handleInput("extension");
    expect(c.handleInput("extension")).toEqual({ action: "continue" });
    expect(n.blocked).toHaveLength(0);
  });

  it("rpc passes through: continue, no acquire", () => {
    const n = recorder();
    const c = new MutexController({ clock: realClock, notifier: n });
    expect(c.handleInput("rpc")).toEqual({ action: "continue" });
    expect(c.driver).toBeNull();
  });
});

describe("MutexController lifecycle", () => {
  it("handleSettled releases the lock", () => {
    const n = recorder();
    const c = new MutexController({ clock: realClock, notifier: n });
    c.handleInput("interactive");
    c.handleSettled();
    expect(c.driver).toBeNull();
  });

  it("handleShutdown releases the lock", () => {
    const n = recorder();
    const c = new MutexController({ clock: realClock, notifier: n });
    c.handleInput("extension");
    c.handleShutdown();
    expect(c.driver).toBeNull();
  });

  it("watchdog force-release routes through notifyForceRelease", () => {
    const clock = new FakeClock();
    const n = recorder();
    const c = new MutexController({
      clock,
      watchdog: { staleMs: 1000, intervalMs: 100 },
      notifier: n,
    });
    c.handleInput("interactive");
    clock.advance(1000);
    expect(c.driver).toBeNull();
    expect(n.force).toEqual(["tui"]);
  });
});
