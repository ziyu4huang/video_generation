### Task 2: `MutexController` adapter + tests

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/mutex-controller.ts`
- Create: `bun-apps/pi-agent-ext-webui/tests/mutex-controller.test.ts`

**Interfaces:**
- Consumes: from `./mutex.js` — `AgentMutex`, `toFrontend`, `Frontend`, `InputSource`, `MutexClock`, `WatchdogConfig` (all produced by Task 1).
- Produces (consumed by ticket 04): `interface MutexNotifier { notifyBlocked(blocked: Frontend, by: Frontend): void; notifyForceRelease(driver: Frontend): void }`; `class MutexController` with `handleInput(source: InputSource): { action: "continue" | "handled" }`, `handleSettled(): void`, `handleActivity(): void`, `handleShutdown(): void`, `get driver(): Frontend | null`.

- [ ] **Step 1: Write the failing tests `tests/mutex-controller.test.ts`**

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/mutex-controller.test.ts )`
Expected: FAIL — `Cannot find module "../src/mutex-controller.js"`.

- [ ] **Step 3: Implement `src/mutex-controller.ts`**

```typescript
/**
 * MutexController — the adapter that wires a pure AgentMutex to an event-driven
 * host (pi extension events in production; a fake emitter in tests). It owns no
 * state beyond the mutex + a notifier; it translates gate verdicts into the
 * InputEventResult `action` and fires the blocked / force-release notifications.
 *
 * The real pi wiring (ticket 04) calls these methods from its pi.on(...) handlers.
 * Kept separate from mutex.ts so the pure module stays I/O-free and the
 * translation is independently testable.
 */

import {
  AgentMutex,
  toFrontend,
  type Frontend,
  type InputSource,
  type MutexClock,
  type WatchdogConfig,
} from "./mutex.js";

/** How the controller tells each side about a block / force-release. */
export interface MutexNotifier {
  /** `blocked` tried to submit while `by` was driving. */
  notifyBlocked(blocked: Frontend, by: Frontend): void;
  /** A hung turn by `driver` was force-released by the watchdog. */
  notifyForceRelease(driver: Frontend): void;
}

export interface MutexControllerOptions {
  clock: MutexClock;
  watchdog?: WatchdogConfig;
  notifier: MutexNotifier;
}

export class MutexController {
  private readonly mutex: AgentMutex;
  private readonly notifier: MutexNotifier;

  constructor(opts: MutexControllerOptions) {
    this.notifier = opts.notifier;
    this.mutex = new AgentMutex({
      clock: opts.clock,
      watchdog: opts.watchdog,
      callbacks: { onForceRelease: (i) => this.notifier.notifyForceRelease(i.driver) },
    });
  }

  get driver(): Frontend | null {
    return this.mutex.driver;
  }

  /** Called from pi.on("input"). Returns the InputEventResult `action`. */
  handleInput(source: InputSource): { action: "continue" | "handled" } {
    const r = this.mutex.gate(source);
    if (r.verdict === "handled" && r.blocked) {
      const blocked = toFrontend(source);
      if (blocked) this.notifier.notifyBlocked(blocked, r.blocked.by);
      return { action: "handled" };
    }
    return { action: "continue" };
  }

  /** Called from pi.on("agent_settled"). */
  handleSettled(): void {
    this.mutex.release("settled");
  }

  /** Called from pi.on("message_update" | "tool_execution_update"). */
  handleActivity(): void {
    this.mutex.bumpActivity();
  }

  /** Called from pi.on("session_shutdown"). */
  handleShutdown(): void {
    this.mutex.release("shutdown");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/mutex-controller.test.ts )`
Expected: PASS — all tests green.

- [ ] **Step 5: Full suite + typecheck**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test && bun run build )`
Expected: every test PASS; `bunx tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/mutex-controller.ts bun-apps/pi-agent-ext-webui/tests/mutex-controller.test.ts
git commit -m "feat(webui): MutexController adapter - events<->mutex + notifications (ticket 03)"
```

---

## Self-Review

**1. Spec coverage** (against `specs/03-agentic-mutex-design.md`):
- SS3 Interface (`gate`/`driver`/`release`/`bumpActivity`) -> Task 1.
- SS3 Transition table (acquire / same-side / reject / rpc) -> Task 1 tests.
- SS3 Watchdog (force-release on stale; `bumpActivity` reset; idle no-fire) -> Task 1 tests.
- SS4 Wiring (input->gate->action; `agent_settled`->release; activity->bump; shutdown) -> Task 2.
- SS5 Blocked presentation (notify with the correct `by`) -> Task 2 `notifyBlocked`.
- SS6 Failure modes (abort/crash via `settled`; timeout via watchdog; shutdown) -> Tasks 1+2.
- SS7 Tests (unit + wiring) -> Tasks 1+2.
- Gap (intentional, out of this plan): real `pi.on(...)` registration + WS response shapes -> ticket 04 (transport).

**2. Placeholder scan:** none — every code step is concrete.

**3. Type consistency:** `Frontend`, `InputSource`, `GateResult`, `MutexClock`, `WatchdogConfig` are defined in Task 1 and consumed unchanged in Task 2. `notifyBlocked(blocked, by)` matches the test assertions. `handleInput` returns `{ action: "continue" | "handled" }`, a valid subset of pi's `InputEventResult`.

---

## Execution Handoff

Plan complete and saved to `.planning/2026-08-10-pi-agent-ext-webui-from-scratch/plans/03-agentic-mutex-plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. (REQUIRED SUB-SKILL: superpowers:subagent-driven-development.)
2. **Inline Execution** — execute the tasks in this session via executing-plans, batch with checkpoints. (REQUIRED SUB-SKILL: superpowers:executing-plans.)

Which approach?
