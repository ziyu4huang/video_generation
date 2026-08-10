### Task 1: `AgentMutex` module + unit tests

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/tests/helpers/fake-clock.ts`
- Create: `bun-apps/pi-agent-ext-webui/tests/mutex.test.ts`
- Create: `bun-apps/pi-agent-ext-webui/src/mutex.ts`

**Interfaces:**
- Produces (consumed by Task 2 and ticket 04): `type Frontend = "tui" | "web"`; `type InputSource = "interactive" | "rpc" | "extension"`; `type ReleaseReason = "settled" | "watchdog" | "shutdown"`; `interface GateResult { verdict: "continue" | "handled"; driver: Frontend | null; blocked?: { by: Frontend } }`; `interface MutexClock { now(): number; setInterval(handler: () => void, ms: number): MutexTimer }`; `interface MutexTimer { clear(): void }`; `interface WatchdogConfig { staleMs: number; intervalMs: number }`; `const DEFAULT_WATCHDOG: WatchdogConfig`; `function toFrontend(source: InputSource): Frontend | null`; `class AgentMutex` with `gate(source): GateResult`, `get driver(): Frontend | null`, `release(reason: ReleaseReason): void`, `bumpActivity(): void`.

- [ ] **Step 1: Create the fake-clock helper `tests/helpers/fake-clock.ts`**

```typescript
import type { MutexClock, MutexTimer } from "../../src/mutex.js";

/**
 * Deterministic MutexClock for watchdog tests. Models a single active
 * setInterval (the AgentMutex watchdog) and lets a test advance virtual time,
 * firing the tick handler every `period` until elapsed.
 */
export class FakeClock implements MutexClock {
  private _now = 0;
  private handler: (() => void) | null = null;
  private period = 0;

  now(): number {
    return this._now;
  }

  setInterval(handler: () => void, ms: number): MutexTimer {
    this.handler = handler;
    this.period = ms;
    return { clear: () => { if (this.handler === handler) this.handler = null; } };
  }

  /** Advance `ms` of virtual time, firing the tick handler every `period`. */
  advance(ms: number): void {
    if (ms <= 0 || this.handler === null) {
      this._now += Math.max(0, ms);
      return;
    }
    const end = this._now + ms;
    while (this._now + this.period <= end) {
      this._now += this.period;
      this.handler();
      if (this.handler === null) break; // watchdog cleared (force-released)
    }
    if (this._now < end) this._now = end;
  }
}
```

- [ ] **Step 2: Write the failing tests `tests/mutex.test.ts`**

```typescript
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
      callbacks: { onForceRelease: (i) => (released = i) },
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/mutex.test.ts )`
Expected: FAIL — `Cannot find module "../src/mutex.js"` (the module does not exist yet).

- [ ] **Step 4: Implement `src/mutex.ts`**

```typescript
/**
 * AgentMutex — agentic mutual-exclusion lock for co-driving frontends (TUI + web)
 * on one AgentSession. Deep module: state + transitions + a watchdog behind a tiny
 * interface, testable through that interface (pure logic + injectable clock; no pi,
 * no I/O).
 *
 * Design: specs/03-agentic-mutex-design.md (effort 2026-08-10-pi-agent-ext-webui-from-scratch).
 * Gate = the `input` extension event; release = `agent_settled`; watchdog backstops
 * hung turns. The extension wiring (mutex-controller.ts) feeds events and translates
 * verdicts into pi calls.
 */

/** A co-driving frontend. rpc is NOT a frontend (passes through ungated). */
export type Frontend = "tui" | "web";

/** Why the lock was released. */
export type ReleaseReason = "settled" | "watchdog" | "shutdown";

/** pi's InputSource — mirrored locally so this module has no pi import. */
export type InputSource = "interactive" | "rpc" | "extension";

/** Result of gating a submission. `verdict` maps 1:1 onto InputEventResult.action. */
export interface GateResult {
  verdict: "continue" | "handled";
  driver: Frontend | null;
  /** Present iff verdict === "handled". */
  blocked?: { by: Frontend };
}

/** Injectable wall clock + interval timer, so tests are deterministic. */
export interface MutexClock {
  now(): number;
  setInterval(handler: () => void, ms: number): MutexTimer;
}

export interface MutexTimer {
  clear(): void;
}

export interface WatchdogConfig {
  /** Force-release after this many ms with zero bumpActivity while driving. */
  staleMs: number;
  /** Watchdog tick interval (ms). */
  intervalMs: number;
}

/** Default: 10-min stale, 1s tick (pure app-logic turns do not take the lock). */
export const DEFAULT_WATCHDOG: WatchdogConfig = { staleMs: 10 * 60_000, intervalMs: 1000 };

/** Map a pi InputSource to a co-driving frontend (rpc -> null = passthrough). */
export function toFrontend(source: InputSource): Frontend | null {
  if (source === "interactive") return "tui";
  if (source === "extension") return "web";
  return null; // rpc
}

/** Watchdog callback — the controller wires this to notify both frontends. */
export interface MutexCallbacks {
  onForceRelease?(info: { driver: Frontend }): void;
}

export interface AgentMutexOptions {
  clock: MutexClock;
  watchdog?: WatchdogConfig;
  callbacks?: MutexCallbacks;
}

export class AgentMutex {
  private _driver: Frontend | null = null;
  private lastActivity = 0;
  private timer: MutexTimer | null = null;
  private readonly clock: MutexClock;
  private readonly watchdog: WatchdogConfig;
  private readonly callbacks: MutexCallbacks;

  constructor(opts: AgentMutexOptions) {
    this.clock = opts.clock;
    this.watchdog = opts.watchdog ?? DEFAULT_WATCHDOG;
    this.callbacks = opts.callbacks ?? {};
  }

  get driver(): Frontend | null {
    return this._driver;
  }

  /** Synchronous check-and-set. Call from the input handler BEFORE any await. */
  gate(source: InputSource): GateResult {
    const me = toFrontend(source);
    if (me === null) return { verdict: "continue", driver: this._driver }; // rpc passthrough
    if (this._driver === null) {
      this._driver = me;
      this.startWatchdog();
      return { verdict: "continue", driver: me };
    }
    if (this._driver === me) {
      this.bumpActivity();
      return { verdict: "continue", driver: me };
    }
    return { verdict: "handled", driver: this._driver, blocked: { by: this._driver } };
  }

  /** Release the lock. Idempotent (no-op when already idle). */
  release(_reason: ReleaseReason): void {
    if (this._driver === null) return;
    this.stopWatchdog();
    this._driver = null;
  }

  /** Reset the watchdog inactivity timer. Call on every message_*/tool_* event. */
  bumpActivity(): void {
    if (this._driver !== null) this.lastActivity = this.clock.now();
  }

  private startWatchdog(): void {
    this.lastActivity = this.clock.now();
    this.timer?.clear();
    this.timer = this.clock.setInterval(() => this.tick(), this.watchdog.intervalMs);
  }

  private stopWatchdog(): void {
    this.timer?.clear();
    this.timer = null;
  }

  private tick(): void {
    if (this._driver === null) return;
    if (this.clock.now() - this.lastActivity >= this.watchdog.staleMs) {
      const driver = this._driver;
      this.release("watchdog");
      this.callbacks.onForceRelease?.({ driver });
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/mutex.test.ts )`
Expected: PASS — all tests green.

- [ ] **Step 6: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run build )`
Expected: `bunx tsc` exits 0, emits `dist/`, no errors.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/mutex.ts bun-apps/pi-agent-ext-webui/tests/mutex.test.ts bun-apps/pi-agent-ext-webui/tests/helpers/fake-clock.ts
git commit -m "feat(webui): AgentMutex module - gate/release/watchdog (ticket 03)"
```

---

