# Agentic Mutex (`AgentMutex`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and unit-test the `AgentMutex` module and its `MutexController` adapter for ticket 03 — the mutual-exclusion lock that makes TUI and web agent-driving turns exclusive on one `AgentSession`.

**Architecture:** A pure deep module (`AgentMutex`: state + transitions + injectable-clock watchdog behind a tiny `gate`/`release`/`bumpActivity` interface) plus a thin adapter (`MutexController`: translates gate verdicts into the `InputEventResult` `action` and fires blocked/force-release notifications). No pi dependency in this plan — both files mirror `InputSource` locally. The real `pi.on(...)` registration + `Bun.serve` extension is tickets 02-impl/04; this plan delivers the tested lock + adapter they call.

**Tech Stack:** TypeScript (strict, NodeNext), `bun:test`, bun workspace package `@repo/pi-agent-ext-webui`.

## Global Constraints

- **Workspace:** `bun-apps/` is the workspace root (`workspaces: ["./*"]`, isolated linker). `bun install` is run from `bun-apps/`, NEVER the repo root. The new package lives at `bun-apps/pi-agent-ext-webui/`.
- **Shell:** NEVER top-level `cd` (a hook blocks it) — always use `( cd <dir> && ... )` subshells.
- **Language:** English for all written artifacts (code, comments, commit messages).
- **TypeScript:** strict; `module: NodeNext`; `moduleResolution: NodeNext`; `target: ES2022`. Import paths MUST include the `.js` extension (NodeNext). `rootDir: src`; `include: ["src/**/*.ts"]`.
- **pi:** NOT a dependency of this plan's code (mutex + controller mirror `InputSource` locally). The bridge to real pi types lands in ticket 04.
- **TDD:** write failing test → run → see it fail → implement → run → see it pass → commit. Frequent commits.
- **Commit scope:** this plan creates files under `bun-apps/pi-agent-ext-webui/` only. NEVER `git add -A`; stage explicit paths.

---

## File Structure

```
bun-apps/pi-agent-ext-webui/
├── .gitignore                  # node_modules, dist
├── package.json                # @repo/pi-agent-ext-webui (scaffold; full extension in 02/04)
├── tsconfig.json               # strict, NodeNext, rootDir src
├── src/
│   ├── index.ts                # placeholder module (extension entry wired in ticket 04)
│   ├── mutex.ts                # AgentMutex — pure deep module (gate/release/bumpActivity/watchdog)
│   └── mutex-controller.ts     # MutexController — adapter: events <-> AgentMutex + notifications
└── tests/
    ├── helpers/
    │   └── fake-clock.ts       # deterministic MutexClock for watchdog tests
    ├── mutex.test.ts           # AgentMutex unit tests
    └── mutex-controller.test.ts # MutexController tests (recording notifier)
```

**Responsibilities:** `mutex.ts` = pure state/transition/watchdog logic (no I/O; injectable clock). `mutex-controller.ts` = the only place that maps gate verdicts to `{action}` and fires notifications; the real extension (ticket 04) calls its methods from `pi.on(...)` handlers. `tests/helpers/fake-clock.ts` = shared deterministic clock.

---

### Task 0: Scaffold the `pi-agent-ext-webui` package

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/package.json`
- Create: `bun-apps/pi-agent-ext-webui/tsconfig.json`
- Create: `bun-apps/pi-agent-ext-webui/src/index.ts`
- Create: `bun-apps/pi-agent-ext-webui/.gitignore`

**Interfaces:** none (scaffold).

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@repo/pi-agent-ext-webui",
  "private": true,
  "version": "0.1.0",
  "description": "Pi extension: a web frontend co-driving one AgentSession with the TUI behind an agentic mutex. Scaffold (mutex module); full Bun.serve extension lands in tickets 02/04.",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./src/*": "./src/*"
  },
  "scripts": {
    "build": "bunx tsc",
    "test:unit": "bun test",
    "test": "bun run build && bun run test:unit"
  },
  "license": "MIT",
  "devDependencies": {
    "@types/bun": "^1.3.14",
    "typescript": "^7.0.2"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ESNext", "DOM"],
    "types": ["bun"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `src/index.ts` placeholder**

```typescript
/**
 * pi-agent-ext-webui — a web frontend that co-drives one AgentSession with the
 * TUI behind an agentic mutex (ticket 03). This scaffold hosts the mutex module
 * and its tests only; the Bun.serve extension + pi registration land in tickets
 * 02/04 and call into src/mutex-controller.ts.
 */
export {};
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules
dist
```

- [ ] **Step 5: Install + verify the toolchain runs**

Run:
```bash
( cd bun-apps && bun install )
( cd bun-apps/pi-agent-ext-webui && bun run build )
( cd bun-apps/pi-agent-ext-webui && bun test )
```
Expected: `bun install` registers the new workspace package; `bun run build` (`bunx tsc`) emits `dist/index.js` + `dist/index.d.ts` with no errors; `bun test` reports no tests found (fine — Task 1 adds them). If `tsc` cannot resolve `typescript`, align the `typescript` devDependency version to whatever `bun-apps/pi-agent-ext-wayfind/package.json` uses.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/package.json bun-apps/pi-agent-ext-webui/tsconfig.json bun-apps/pi-agent-ext-webui/src/index.ts bun-apps/pi-agent-ext-webui/.gitignore
git commit -m "feat(webui): scaffold pi-agent-ext-webui package (ticket 03 host)"
```

---

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

  // Reset the watchdog inactivity timer. Call on every message_*/tool_* event.
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
