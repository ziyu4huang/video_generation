# errorCapture Throttle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Throttle `errorCapture` so the shared global `failures.md` fills slowly and consolidation fires rarely, without losing high-signal captures (#854 root-cause fix).

**Architecture:** A pure in-memory `CaptureThrottle` class (sliding-window rate limit + this-session dedup LRU) is constructed once per session in `setupErrorDetector`. The `tool_result` handler calls `allow(key)` before the existing store-check and `recordCapture(key)` only after a successful write — so rate slots are consumed solely by real writes, and cross-session duplicates cannot starve novel captures.

**Tech Stack:** TypeScript on Bun; `node:test` + `node:assert/strict`; the `pi-agent-ext-hermes-memory` extension package.

## Global Constraints

(Each task's requirements implicitly include this section.)

- **Package / runner:** all work under `bun-apps/pi-agent-ext-hermes-memory`. Tests run via `bun test` from the package dir (or `bun test <path>`). Use `node:test` (`describe`/`it`/`beforeEach`) + `node:assert/strict`, matching existing tests.
- **Backward compatible:** every config field is optional with defaults that make the throttle **active by default** (`5 / 600_000ms / 64`). No config → throttle on. `config.errorCapture === false` short-circuits before the throttle is built (unchanged).
- **Precedence:** config-file field > env var > default. Fields ARE carried through `loadConfig` (selective copy, like `errorCapture`) so config-file wins; env applies only when config-file left the field unset.
- **Pure `CaptureThrottle`:** no I/O, no config/env awareness (constructor takes plain numbers). `allow()` **fails open** (returns `true` on any internal error — never blocks a capture).
- **Rate-slot invariant:** `recordCapture()` is called only after a successful `addFailure`. Cross-session dups (caught by the existing store-check) and this-session dups (caught by the cache) do **not** consume the rate budget.
- **No new dependencies.** No `@earendil-works/pi-ai` import (package convention); derive/inline types locally.
- **Commits:** one per task, conventional-commit style (`feat(hermes-memory): …` / `refactor(hermes-memory): …`).

---

## File Structure

| File | Responsibility |
|---|---|
| **`src/utils/env.ts`** (new) | Shared `envInt(name, fallback)` helper. |
| `src/store/memory-store.ts` | Drop its local `envInt`; import from `../utils/env.js`. |
| **`src/handlers/capture-throttle.ts`** (new) | Pure `CaptureThrottle` class (rate window + dedup LRU + `allow`/`recordCapture`). |
| `src/types.ts` | Three optional `MemoryConfig` fields. |
| `src/constants.ts` | Three `DEFAULT_*` constants. |
| `src/config.ts` | Carry the three fields through `loadConfig` (selective copy). |
| `src/handlers/error-detector.ts` | Build one `CaptureThrottle` per session; thread `allow()`/`recordCapture()` into the `tool_result` handler. |
| **`tests/utils/env.test.ts`** (new) | `envInt` unit tests. |
| **`tests/handlers/capture-throttle.test.ts`** (new) | `CaptureThrottle` unit tests. |
| `tests/config.test.ts` | New-field parsing tests. |
| `tests/handlers/error-detector.test.ts` | Throttle-wiring integration tests. |

---

## Task 1: Extract `envInt` to a shared util

**Files:**
- Create: `src/utils/env.ts`
- Create: `tests/utils/env.test.ts`
- Modify: `src/store/memory-store.ts` (remove local `envInt` at ~L34, add import)

**Interfaces:**
- Produces: `envInt(name: string, fallback: number): number` exported from `src/utils/env.ts`.
- Consumes (later): Task 4 (`error-detector.ts`) imports it for at-use config resolution; `memory-store.ts` adopts it now (replacing its local copy).

- [ ] **Step 1: Write the failing test**

Create `tests/utils/env.test.ts`:

```ts
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { envInt } from "../../src/utils/env.js";

describe("envInt", () => {
  const NAME = "HERMES_TEST_ENV_INT";
  afterEach(() => { delete process.env[NAME]; });

  it("returns the fallback when the var is unset", () => {
    assert.strictEqual(envInt(NAME, 42), 42);
  });
  it("returns the fallback when the var is empty", () => {
    process.env[NAME] = "";
    assert.strictEqual(envInt(NAME, 42), 42);
  });
  it("parses a non-negative integer", () => {
    process.env[NAME] = "7";
    assert.strictEqual(envInt(NAME, 42), 7);
  });
  it("floors a float", () => {
    process.env[NAME] = "7.9";
    assert.strictEqual(envInt(NAME, 42), 7);
  });
  it("rejects a negative value (fallback)", () => {
    process.env[NAME] = "-3";
    assert.strictEqual(envInt(NAME, 42), 42);
  });
  it("rejects a non-numeric value (fallback)", () => {
    process.env[NAME] = "abc";
    assert.strictEqual(envInt(NAME, 42), 42);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/utils/env.test.ts`
Expected: FAIL — cannot resolve `../../src/utils/env.js` (module does not exist).

- [ ] **Step 3: Write the implementation**

Create `src/utils/env.ts`:

```ts
/** Parse a non-negative int from an env var, falling back to `fallback`. */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/utils/env.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Adopt the shared helper in memory-store (refactor)**

In `src/store/memory-store.ts`:
- Remove the local function (the block starting `/** Parse a non-negative int from an env var … */ function envInt(name: string, fallback: number): number { … }` at ~L34-39).
- Add to the existing imports near the top: `import { envInt } from "../utils/env.js";`

(No behaviour change — identical implementation moves to the shared module. The lock-config resolution at ~L148-150 continues to call `envInt(…)` unchanged.)

- [ ] **Step 6: Run the memory-store suite to verify no regression**

Run: `bun test tests/store/memory-store.test.ts`
Expected: PASS (all existing tests; `envInt` is exercised by the lock-config paths).

- [ ] **Step 7: Commit**

```bash
git add src/utils/env.ts tests/utils/env.test.ts src/store/memory-store.ts
git commit -m "refactor(hermes-memory): extract envInt to shared util"
```

---

## Task 2: `CaptureThrottle` class (pure logic)

**Files:**
- Create: `src/handlers/capture-throttle.ts`
- Create: `tests/handlers/capture-throttle.test.ts`

**Interfaces:**
- Produces: `class CaptureThrottle` + `interface CaptureThrottleOptions` from `src/handlers/capture-throttle.ts`.
  - `new CaptureThrottle({ rateLimit, rateWindowMs, dedupCacheSize, now? })`
  - `allow(key: string): boolean` — gate; returns false on this-session dup OR window-full; does NOT record; fails open.
  - `recordCapture(key: string): void` — push timestamp + LRU-insert; call only after a successful write.
- Consumes: nothing (pure; constructed in Task 4).

- [ ] **Step 1: Write the failing tests**

Create `tests/handlers/capture-throttle.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CaptureThrottle } from "../../src/handlers/capture-throttle.js";

/** Throttle with a controllable fake clock; returns helpers to advance time. */
function makeThrottle(opts: {
  rateLimit?: number;
  rateWindowMs?: number;
  dedupCacheSize?: number;
  t0?: number;
} = {}) {
  let t = opts.t0 ?? 1_000_000;
  const throttle = new CaptureThrottle({
    rateLimit: opts.rateLimit ?? 3,
    rateWindowMs: opts.rateWindowMs ?? 10_000,
    dedupCacheSize: opts.dedupCacheSize ?? 64,
    now: () => t,
  });
  return { throttle, advance: (ms: number) => { t += ms; } };
}

describe("CaptureThrottle — rate limit", () => {
  it("allows under the cap", () => {
    const { throttle } = makeThrottle({ rateLimit: 3 });
    assert.equal(throttle.allow("a"), true);
    assert.equal(throttle.allow("b"), true); // not recorded yet → still under cap
  });

  it("denies a distinct key once the cap is reached", () => {
    const { throttle } = makeThrottle({ rateLimit: 2 });
    for (const k of ["a", "b"]) { assert.equal(throttle.allow(k), true); throttle.recordCapture(k); }
    assert.equal(throttle.allow("c"), false); // ③ rate-capped
  });

  it("allows again after the window expires (fake clock)", () => {
    const { throttle, advance } = makeThrottle({ rateLimit: 2, rateWindowMs: 10_000 });
    throttle.recordCapture("a"); throttle.recordCapture("b"); // fill window
    assert.equal(throttle.allow("c"), false); // capped
    advance(10_001); // past window
    assert.equal(throttle.allow("c"), true); // window reset
  });

  it("rateLimit:0 = unlimited (never rate-denies)", () => {
    const { throttle } = makeThrottle({ rateLimit: 0 });
    for (let i = 0; i < 50; i++) {
      throttle.recordCapture(`k${i}`);
      assert.equal(throttle.allow(`k${i + 100}`), true);
    }
  });
});

describe("CaptureThrottle — this-session dedup cache", () => {
  it("denies a key already recorded this session (① fast path)", () => {
    const { throttle } = makeThrottle({ dedupCacheSize: 64 });
    assert.equal(throttle.allow("enoent"), true);
    throttle.recordCapture("enoent");
    assert.equal(throttle.allow("enoent"), false); // ①
  });

  it("allow() does NOT record (two allows with no record both pass)", () => {
    const { throttle } = makeThrottle({ rateLimit: 1 });
    assert.equal(throttle.allow("x"), true);
    assert.equal(throttle.allow("x"), true); // not recorded → not cached → still true
  });

  it("evicts the oldest key when the LRU is full", () => {
    const { throttle } = makeThrottle({ dedupCacheSize: 2 });
    throttle.recordCapture("a");
    throttle.recordCapture("b");
    throttle.recordCapture("c"); // evicts "a" (oldest)
    assert.equal(throttle.allow("a"), true);  // "a" evicted → allowed
    assert.equal(throttle.allow("b"), false); // "b" still cached
  });

  it("dedupCacheSize:0 = no session-cache fast-path", () => {
    const { throttle } = makeThrottle({ dedupCacheSize: 0 });
    throttle.recordCapture("a");
    assert.equal(throttle.allow("a"), true); // cache disabled → not deduped here
  });
});

describe("CaptureThrottle — fail-open", () => {
  it("returns true (does not throw) when the injected clock throws", () => {
    const throttle = new CaptureThrottle({
      rateLimit: 1, rateWindowMs: 1000, dedupCacheSize: 1,
      now: () => { throw new Error("clock broke"); },
    });
    // Fresh key → reaches rate check → pruneWindow() → now() throws → fail-open.
    assert.equal(throttle.allow("k"), true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/handlers/capture-throttle.test.ts`
Expected: FAIL — cannot resolve `../../src/handlers/capture-throttle.js`.

- [ ] **Step 3: Write the implementation**

Create `src/handlers/capture-throttle.ts`:

```ts
/**
 * Per-session throttle for errorCapture: a sliding-window rate limit + an
 * in-memory LRU of this-session dedup keys. Pure logic — no I/O, no
 * config/env awareness (construction takes plain numbers).
 *
 * Two-phase contract (see error-detector data flow):
 *   - allow(key) GATES (false if this-session dup ① OR window full ③) but
 *     does NOT record.
 *   - recordCapture(key) is called by the detector ONLY after a successful
 *     write, so rate slots + cache are consumed solely by real writes. Thus
 *     cross-session duplicates (caught by the store-check ②) do not eat the
 *     rate budget and cannot starve genuinely novel captures.
 *
 * Fail-open: any internal error in allow() returns true (never blocks a
 * lesson-worthy capture due to a throttle bug).
 */
export interface CaptureThrottleOptions {
  /** Max captures per window. 0 = unlimited (no rate cap). */
  rateLimit: number;
  /** Sliding-window length in ms. */
  rateWindowMs: number;
  /** LRU capacity for this-session dedup keys. 0 = no fast-path. */
  dedupCacheSize: number;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

export class CaptureThrottle {
  private readonly rateLimit: number;
  private readonly rateWindowMs: number;
  private readonly dedupCacheSize: number;
  private readonly now: () => number;
  private readonly timestamps: number[] = [];
  private readonly cache: Map<string, true> = new Map();

  constructor(opts: CaptureThrottleOptions) {
    this.rateLimit = Math.max(0, Math.floor(opts.rateLimit));
    this.rateWindowMs = Math.max(0, opts.rateWindowMs);
    this.dedupCacheSize = Math.max(0, Math.floor(opts.dedupCacheSize));
    this.now = opts.now ?? (() => Date.now());
  }

  /** Drop timestamps older than the sliding window. */
  private pruneWindow(): void {
    const cutoff = this.now() - this.rateWindowMs;
    while (this.timestamps.length > 0 && this.timestamps[0] <= cutoff) {
      this.timestamps.shift();
    }
  }

  /**
   * Gate check BEFORE the store-check/write. Returns false iff:
   *   ① the key is in this-session dedup cache, OR
   *   ③ the sliding-window count is already at rateLimit.
   * Fail-open: on any internal error, returns true.
   */
  allow(key: string): boolean {
    try {
      if (this.dedupCacheSize > 0 && this.cache.has(key)) return false; // ①
      if (this.rateLimit > 0) {
        this.pruneWindow();
        if (this.timestamps.length >= this.rateLimit) return false; // ③
      }
      return true;
    } catch {
      return true; // fail-open
    }
  }

  /**
   * Record a successful capture: push a timestamp + LRU-insert the key
   * (evicting the oldest key if over capacity). Call only after a real write.
   */
  recordCapture(key: string): void {
    this.timestamps.push(this.now());
    if (this.dedupCacheSize > 0) {
      this.cache.delete(key); // LRU touch: re-insert as newest
      this.cache.set(key, true);
      while (this.cache.size > this.dedupCacheSize) {
        const oldest = this.cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/handlers/capture-throttle.test.ts`
Expected: PASS (all unit tests).

- [ ] **Step 5: Commit**

```bash
git add src/handlers/capture-throttle.ts tests/handlers/capture-throttle.test.ts
git commit -m "feat(hermes-memory): add CaptureThrottle (rate-limit + dedup cache)"
```

---

## Task 3: Config types, constants, and loadConfig carry-through

**Files:**
- Modify: `src/types.ts` (add 3 optional fields beside `errorCapture?: boolean` ~L80)
- Modify: `src/constants.ts` (add 3 `DEFAULT_*` constants)
- Modify: `src/config.ts` (selective-copy the 3 fields in `loadConfig`, beside the `errorCapture` line ~L176)
- Modify: `tests/config.test.ts` (add parsing tests)

**Interfaces:**
- Produces: `MemoryConfig.errorCaptureRateLimit?`, `.errorCaptureRateWindowMs?`, `.errorCaptureDedupCacheSize?` (all optional `number`); `DEFAULT_ERROR_CAPTURE_RATE_LIMIT/WINDOW_MS/DEDUP_CACHE_SIZE` constants. These are NOT in `DEFAULT_CONFIG` (so the env fallback stays applicable at the use-site).
- Consumes: Task 4 reads `config.<field>` and falls back via `envInt`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/config.test.ts` (inside the existing top-level `describe("loadConfig", …)` block):

```ts
  it("carries errorCapture throttle fields through from the config file", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      errorCaptureRateLimit: 2,
      errorCaptureRateWindowMs: 30_000,
      errorCaptureDedupCacheSize: 10,
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.errorCaptureRateLimit, 2);
    assert.strictEqual(config.errorCaptureRateWindowMs, 30_000);
    assert.strictEqual(config.errorCaptureDedupCacheSize, 10);
  });

  it("leaves errorCapture throttle fields undefined when unset (env/default applies at use-site)", () => {
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.errorCaptureRateLimit, undefined);
    assert.strictEqual(config.errorCaptureRateWindowMs, undefined);
    assert.strictEqual(config.errorCaptureDedupCacheSize, undefined);
  });

  it("ignores invalid errorCapture throttle values (negative / non-number)", () => {
    fs.mkdirSync(path.dirname(TEST_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      errorCaptureRateLimit: -1,
      errorCaptureRateWindowMs: "fast",
      errorCaptureDedupCacheSize: true,
    }));
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.strictEqual(config.errorCaptureRateLimit, undefined);
    assert.strictEqual(config.errorCaptureRateWindowMs, undefined);
    assert.strictEqual(config.errorCaptureDedupCacheSize, undefined);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/config.test.ts`
Expected: FAIL — `config.errorCaptureRateLimit` is `undefined` even when set (fields not yet carried through; TS may also error on unknown properties depending on strictness).

- [ ] **Step 3: Add the type fields**

In `src/types.ts`, beside the existing `errorCapture?: boolean;` line, add:

```ts
  /** Per-session errorCapture rate limit (0 = unlimited). #854 */
  errorCaptureRateLimit?: number;
  /** errorCapture sliding-window length in ms. #854 */
  errorCaptureRateWindowMs?: number;
  /** errorCapture this-session dedup LRU capacity (0 = no fast-path). #854 */
  errorCaptureDedupCacheSize?: number;
```

- [ ] **Step 4: Add the constants**

In `src/constants.ts` (near the other `DEFAULT_*` constants, e.g. after `DEFAULT_FAILURE_INJECTION_MAX_ENTRIES`):

```ts
export const DEFAULT_ERROR_CAPTURE_RATE_LIMIT = 5;
export const DEFAULT_ERROR_CAPTURE_RATE_WINDOW_MS = 600_000;
export const DEFAULT_ERROR_CAPTURE_DEDUP_CACHE_SIZE = 64;
```

- [ ] **Step 5: Carry the fields through loadConfig**

In `src/config.ts`, inside `loadConfig`, immediately after the existing `errorCapture` copy line (`if (typeof parsed.errorCapture === "boolean") config.errorCapture = parsed.errorCapture;`), add:

```ts
      if (isNonNegativeNumber(parsed.errorCaptureRateLimit)) config.errorCaptureRateLimit = parsed.errorCaptureRateLimit;
      if (isNonNegativeNumber(parsed.errorCaptureRateWindowMs)) config.errorCaptureRateWindowMs = parsed.errorCaptureRateWindowMs;
      if (isNonNegativeNumber(parsed.errorCaptureDedupCacheSize)) config.errorCaptureDedupCacheSize = parsed.errorCaptureDedupCacheSize;
```

(`isNonNegativeNumber` is already defined inside `loadConfig`; it accepts `0`, which is the "unlimited"/"disabled" sentinel.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/config.test.ts`
Expected: PASS (including the 3 new tests).

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/constants.ts src/config.ts tests/config.test.ts
git commit -m "feat(hermes-memory): add errorCapture throttle config fields (#854)"
```

---

## Task 4: Wire the throttle into error-detector

**Files:**
- Modify: `src/handlers/error-detector.ts`
- Modify: `tests/handlers/error-detector.test.ts` (add a wiring `describe` block)

**Interfaces:**
- Consumes: `CaptureThrottle` (Task 2), `envInt` (Task 1), `DEFAULT_ERROR_CAPTURE_*` constants (Task 3), `MemoryConfig.errorCapture*` fields (Task 3).
- Produces: the throttled capture behaviour (rate-cap + dedup) as observable through `setupErrorDetector`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/handlers/error-detector.test.ts` (new top-level `describe` block at the end of the file). This mirrors the fake-pi pattern used in `tests/handlers/correction-detector.test.ts`:

```ts
import { setupErrorDetector } from "../../src/handlers/error-detector.js";
import type { MemoryConfig } from "../../src/types.js";

function createMockPi(handlers: Record<string, Function[]>) {
  return {
    on: (event: string, handler: Function) => { (handlers[event] ||= []).push(handler); },
    registerTool: () => {},
    registerCommand: () => {},
  } as any;
}

function makeToolResultEvent(toolName: string, text: string, isError = true) {
  return { toolName, isError, content: [{ type: "text", text }] };
}

const LESSON_WORTHY_ENOENT = "Error: ENOENT: no such file or directory, open '/x/y'";
const LESSON_WORTHY_EADDR = "Error: listen EADDRINUSE: address already in use";

describe("setupErrorDetector — per-session throttle (#854)", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "errcap-throttle-")); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  /** Wire a fresh detector + store; return a fire() helper and a row counter. */
  function wire(configOverrides: Partial<MemoryConfig> = {}, seededStore?: MemoryStore) {
    const handlers: Record<string, Function[]> = {};
    const pi = createMockPi(handlers);
    const store = seededStore ?? new MemoryStore({ memoryDir: tmpDir });
    const config = { errorCapture: true, ...configOverrides } as MemoryConfig;
    setupErrorDetector(pi, store, null, config, null, undefined);
    const fire = async (text: string, isError = true) => {
      for (const fn of handlers["tool_result"] ?? []) {
        await fn(makeToolResultEvent("bash", text, isError), { ui: { notify() {} } });
      }
    };
    return { fire, store };
  }

  it("rate-caps repeated DISTINCT errors at errorCaptureRateLimit", async () => {
    const { fire, store } = wire({ errorCaptureRateLimit: 2, errorCaptureRateWindowMs: 600_000, errorCaptureDedupCacheSize: 64 });
    await fire(LESSON_WORTHY_ENOENT);
    await fire(LESSON_WORTHY_EADDR);
    await fire("ModuleNotFoundError: No module named 'pkg-three'");
    assert.equal(store.getFailureEntries(100).length, 2, "third distinct error is rate-capped");
  });

  it("the same error twice → one row (dedup)", async () => {
    const { fire, store } = wire({ errorCaptureRateLimit: 5 });
    await fire(LESSON_WORTHY_ENOENT);
    await fire(LESSON_WORTHY_ENOENT);
    assert.equal(store.getFailureEntries(100).length, 1);
  });

  it("cross-session store-dup does NOT consume a rate slot", async () => {
    // Pre-seed the store so the store-check (②) catches the ENOENT occurrence.
    const seeded = new MemoryStore({ memoryDir: tmpDir });
    await seeded.addFailure(`[bash error] ${LESSON_WORTHY_ENOENT}`, { category: "failure" });
    const { fire, store } = wire({ errorCaptureRateLimit: 1 }, seeded);

    // Fire the already-stored error 3× — all caught by ②, no write, no recordCapture.
    await fire(LESSON_WORTHY_ENOENT);
    await fire(LESSON_WORTHY_ENOENT);
    await fire(LESSON_WORTHY_ENOENT);
    // A genuinely NOVEL error must STILL be captured (rate slot not eaten by the dups).
    await fire(LESSON_WORTHY_EADDR);
    assert.equal(store.getFailureEntries(100).length, 2, "novel error still captured despite prior store-dup attempts");
  });

  it("non-error tool result is ignored", async () => {
    const { fire, store } = wire({ errorCaptureRateLimit: 5 });
    await fire(LESSON_WORTHY_ENOENT, false); // isError=false
    assert.equal(store.getFailureEntries(100).length, 0);
  });
});
```

> Note: the `import { setupErrorDetector } …` and `import type { MemoryConfig } …` lines are added once at the top of the file (merge into the existing imports; do not duplicate `MemoryStore`/`fs`/`os`/`path` which are already imported).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/handlers/error-detector.test.ts`
Expected: FAIL — with no throttle wired, the "rate-caps" test sees 3 rows (not 2), and the store-dup test sees 3 rows (the novel error was starved). (The "same error twice" and "non-error" tests may already pass via the existing store-check.)

- [ ] **Step 3: Wire the throttle into setupErrorDetector**

In `src/handlers/error-detector.ts`:

(a) Add imports (merge with existing imports near the top):

```ts
import { CaptureThrottle } from "./capture-throttle.js";
import { envInt } from "../utils/env.js";
import {
  LESSON_WORTHY_PATTERNS,
  ERROR_NOISE_PATTERNS,
  DEFAULT_ERROR_CAPTURE_RATE_LIMIT,
  DEFAULT_ERROR_CAPTURE_RATE_WINDOW_MS,
  DEFAULT_ERROR_CAPTURE_DEDUP_CACHE_SIZE,
} from "../constants.js";
```

(b) Inside `setupErrorDetector`, immediately after the `if (config.errorCapture === false) return;` line, construct the per-session throttle:

```ts
  const rateLimit = config.errorCaptureRateLimit ?? envInt("PI_MEMORY_ERROR_CAPTURE_RATE_LIMIT", DEFAULT_ERROR_CAPTURE_RATE_LIMIT);
  const rateWindowMs = config.errorCaptureRateWindowMs ?? envInt("PI_MEMORY_ERROR_CAPTURE_RATE_WINDOW_MS", DEFAULT_ERROR_CAPTURE_RATE_WINDOW_MS);
  const dedupCacheSize = config.errorCaptureDedupCacheSize ?? envInt("PI_MEMORY_ERROR_CAPTURE_DEDUP_CACHE_SIZE", DEFAULT_ERROR_CAPTURE_DEDUP_CACHE_SIZE);
  const throttle = new CaptureThrottle({ rateLimit, rateWindowMs, dedupCacheSize });
```

(c) In the `tool_result` handler, gate with `allow()` right after computing the dedup key (before the existing store-check `try` block), and record only after a successful write. The relevant handler section becomes:

```ts
    const dedupKey = errorDedupKey(text);
    if (!throttle.allow(dedupKey)) return; // ① this-session dup OR ③ rate-capped

    // DEDUP GUARD — skip if an existing failure entry already carries this
    // error (cross-session; same error twice across sessions → one entry).
    try {
      const existing = store.getFailureEntries(30);
      if (existing.some((e) => errorDedupKey(e) === dedupKey)) {
        return; // ② cross-session dup — does NOT consume a rate slot (no recordCapture)
      }
    } catch {
      // best-effort dedup; never block the capture on a read failure
    }

    const reason = firstLessonLine(text).slice(0, 200) || errorSignature(event.toolName, text);
    const scopedProject = projectName?.trim() || undefined;
    try {
      const content = `[${event.toolName} error] ${reason}`;
      const addResult = await store.addFailure(content, {
        category: "failure",
        failureReason: reason,
        project: scopedProject,
      });

      if (addResult.success && memoryRepo) {
        try {
          await memoryRepo.syncMemoryEntry({
            content: formatFailureMemoryContent(content, {
              category: "failure",
              failureReason: reason,
              project: scopedProject,
            }),
            target: "failure",
            project: scopedProject,
            category: "failure",
            failureReason: reason,
          });
        } catch {
          // best-effort SQLite sync only
        }
      }

      if (addResult.success) {
        throttle.recordCapture(dedupKey); // ④ count only on a real write
        const ui = (ctx as { ui?: { notify?: (message: string, level?: string) => void } }).ui;
        ui?.notify?.("🧠 Lesson-worthy error captured to memory", "info");
      }
    } catch {
      // best-effort — never block the session on a capture failure
    }
```

(The only changes vs. the current handler: the `if (!throttle.allow(dedupKey)) return;` line is inserted after `const dedupKey = …`, the comment on the cross-session dup return notes "does NOT consume a rate slot", and `throttle.recordCapture(dedupKey);` is added inside `if (addResult.success)` before the notify.)

- [ ] **Step 4: Run the wiring tests to verify they pass**

Run: `bun test tests/handlers/error-detector.test.ts`
Expected: PASS (all 4 new tests + the existing helper/store-check tests).

- [ ] **Step 5: Run the full package suite to verify no regression**

Run: `bun test`
Expected: PASS (all tests, including Task 1–3 tests and the pre-existing suite).

- [ ] **Step 6: Typecheck**

Run: `bunx tsc --noEmit` (from the package dir; the hermes-memory `check` script)
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/handlers/error-detector.ts tests/handlers/error-detector.test.ts
git commit -m "feat(hermes-memory): wire CaptureThrottle into error-detector (#854)"
```

---

## Self-Review

**1. Spec coverage** — each spec section maps to a task:
- §4 components/files → Task 1 (`env.ts`, memory-store), Task 2 (`capture-throttle.ts`), Task 3 (types/constants/config), Task 4 (error-detector). ✓
- §5 CaptureThrottle API → Task 2 (exact `allow`/`recordCapture` + fail-open + 0-sentinels). ✓
- §6 data flow ①②③④ → Task 4 wires exactly this order; the "cross-session store-dup does NOT consume a rate slot" test (Task 4) proves the invariant. ✓
- §7 config surface (config-file > env > default, carried through loadConfig, NOT in DEFAULT_CONFIG) → Task 3 (loadConfig selective copy) + Task 4 (use-site `config ?? envInt(env, DEFAULT)`). ✓
- §9 testing (unit rate/window/LRU/2-phase + integration store-dup-doesn't-eat-slot + config) → Tasks 1–4. ✓
- §10 error handling (fail-open, per-session, concurrency soft-limit) → Task 2 fail-open test; concurrency soft-limit is inherent (documented, not unit-testable). ✓
- §12 acceptance → tasks cover the testable criteria; the operational "growth rate drops" criterion is post-deployment (not a unit test), as the spec notes. ✓

**2. Placeholder scan** — every step contains concrete code or an exact run command. No "TBD"/"TODO"/"add error handling"/"similar to Task N". ✓

**3. Type consistency** — `CaptureThrottle` constructor field names (`rateLimit`, `rateWindowMs`, `dedupCacheSize`, `now`) and method names (`allow`, `recordCapture`) are identical across Task 2 (definition), Task 2 tests, and Task 4 (usage). Config field names (`errorCaptureRateLimit`/`RateWindowMs`/`DedupCacheSize`) match across Task 3 (types/constants/config) and Task 4 (resolution). Env var names (`PI_MEMORY_ERROR_CAPTURE_RATE_LIMIT`/`_WINDOW_MS`/`_DEDUP_CACHE_SIZE`) match across Task 4's three resolution lines. ✓

No gaps found; no inline fixes required.
