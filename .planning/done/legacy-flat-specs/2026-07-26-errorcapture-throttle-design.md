# errorCapture Throttle — Design Spec

**Issue:** [#854](https://github.com/ziyu4huang/video_generation/issues/854) — hermes-memory: throttle `errorCapture`; failures.md fills faster than consolidation keeps up.
**Package:** `bun-apps/pi-agent-ext-hermes-memory`
**Status:** Approved (brainstorm 2026-07-26) → implementation plan pending.
**Related:** #847 (op-retry mitigation), #851 (40k limit mitigation), #857 (consolidation progress UX), #853 (2-phase consolidation, deferred structural).

---

## 1. Problem

`errorCapture` auto-captures lesson-worthy tool errors to the shared global `failures.md` from **every** concurrent session, with no per-session rate limit. The result:

- A single chatty/looping session can fire many captures in quick succession (retry storm on the same or near-duplicate error).
- Across many sessions, the capture rate outpaces consolidation, so `failures.md` repeatedly refills toward the char limit → frequent overflow → frequent consolidation → 60s file-lock holds (the lock-contention symptom from #847/#851).

#847 (op-retry) and #851 (raise limit to 40000) are **symptom relief**. #854 is the **root-cause fill-rate reduction**: throttle capture so the headroom lasts and consolidation fires rarely regardless of the char limit.

### Current capture flow (`src/handlers/error-detector.ts`)

`setupErrorDetector` wires `pi.on("tool_result", …)`. For each failed result:

1. `event.isError` filter.
2. `isLessonWorthy(text)` — matches a `LESSON_WORTHY_PATTERNS` list and not a `ERROR_NOISE_PATTERNS` list (severity gate).
3. **DEDUP** — `errorDedupKey(text)` (normalised first lesson-line) checked against `store.getFailureEntries(30)`; exact-key match → skip. Cross-session (reads global store), but only a 30-entry window and exact-normalised-key only.
4. `store.addFailure(content, …)` — lock-acquiring write. On overflow → consolidation.

### Gaps

- **No per-session rate limit** → one session floods.
- **Weak dedup** — exact-key only, 30-entry window; near-duplicates with different wording/paths pass; once >30 entries, older keys can be re-captured.
- **No capture budget** — always appends, relies on post-overflow consolidation.

---

## 2. Goal & Non-Goals

**Goal.** Reduce the `failures.md` fill rate so that, under realistic multi-session load, it stays well under the char limit and consolidation fires rarely — **without losing high-signal captures** (corrections, recurring tool quirks).

**Non-Goals (deferred — see §8).**
- Fuzzy / similarity-based dedup (Levenshtein, token-overlap).
- Severity/lesson-worthy pattern retuning.
- Capture budget (near-limit best-effort skip).
- Cross-session shared rate budget.
- Persistence of throttle state.

---

## 3. Approach (chosen mechanism set)

From the issue's option list, this iteration implements the recommended MVP combination:

1. **Per-session rate limit** (primary anti-flood) — sliding-window cap, configurable.
2. **Session-local dedup cache** — O(1) fast path for this-session duplicates, decoupled from the 30-entry store window.
3. **Config knobs** — mirror #847's `config ?? envInt(env, default)` at-use resolution pattern.

**Throttle-logic placement:** extract a pure `CaptureThrottle` class (`src/handlers/capture-throttle.ts`). The detector stays thin; the throttle is isolated, in-memory, and trivially unit-testable. (Alternative considered: inline in the detector closure — rejected as harder to unit-test and bloating the detector. Pushing into `MemoryStore.addFailure` — rejected as wrong layer; store is target-agnostic, capture policy is detector-specific.)

---

## 4. Components & Files

| File | Change |
|---|---|
| **`src/handlers/capture-throttle.ts`** (new) | Pure in-memory `CaptureThrottle` class. Zero I/O, zero config/env awareness (constructor takes plain numbers). |
| **`src/handlers/error-detector.ts`** | `setupErrorDetector` constructs one `CaptureThrottle` instance (per-session) and threads `allow()`/`recordCapture()` into the existing `tool_result` handler. |
| `src/types.ts` | Add three optional `MemoryConfig` fields (beside `errorCapture?: boolean` at L80). |
| `src/constants.ts` | Add three `DEFAULT_*` constants. |
| `src/config.ts` | Carry the three new fields through `loadConfig` via selective copy (`isNonNegativeNumber`, mirroring `errorCapture`), so config-file values win. **Not** added to `DEFAULT_CONFIG` (keeps the env fallback applicable at the use-site). |
| **`src/utils/env.ts`** (new) | Extract `envInt(name, fallback)` to a shared helper. `memory-store.ts` imports it (replacing its local copy); `error-detector.ts` imports it for at-use resolution. (DRY; small targeted improvement to code under work.) |

---

## 5. CaptureThrottle API

```ts
// src/handlers/capture-throttle.ts
export interface CaptureThrottleOptions {
  /** Max captures per window. 0 = unlimited (no rate cap). */
  rateLimit: number;
  /** Sliding-window length in ms. */
  rateWindowMs: number;
  /** LRU capacity for this-session dedup keys. 0 = no session-cache fast-path. */
  dedupCacheSize: number;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

export class CaptureThrottle {
  constructor(opts: CaptureThrottleOptions);

  /**
   * Gate check BEFORE the store-check/write.
   * Returns false iff:
   *   ① the key is already in this-session dedup cache (this-session duplicate), OR
   *   ③ the sliding-window capture count is already at rateLimit.
   * Does NOT record — the caller invokes recordCapture(key) only after a
   * successful write, so rate slots and cache are consumed only by real writes.
   */
  allow(key: string): boolean;

  /**
   * Record a successful capture: push a timestamp into the sliding window and
   * insert the key into the LRU cache (evicting oldest if over capacity).
   */
  recordCapture(key: string): void;
}
```

**Internals.**
- `timestamps: number[]` — sliding window; `allow()` prunes entries older than `now() - rateWindowMs` before counting.
- `cache: Map<string, true>` — JS `Map` preserves insertion order → trivial LRU. Over-capacity eviction via `cache.keys().next()` (oldest). Lookup is O(1).
- `rateLimit === 0` → `allow()` never rate-denies (unlimited); cache check still applies.
- `dedupCacheSize === 0` → no session-cache fast-path (store-check still active downstream).
- **Fail-open:** any internal exception in `allow()` returns `true` (never blocks a capture due to a throttle bug).

---

## 6. Data Flow (error-detector handler)

```
tool_result event
  └─ if (!event.isError) return                          (unchanged)
  └─ text = extractResultText(event.content)
  └─ if (!isLessonWorthy(text)) return                   (unchanged severity gate)
  └─ dedupKey = errorDedupKey(text)
  └─ if (!throttle.allow(dedupKey)) return               ① this-session dup OR ③ rate-capped
  └─ existing = store.getFailureEntries(30)              (unchanged)
  └─ if (existing.some(e => errorDedupKey(e) === dedupKey)) return   ② cross-session dup (no count)
  └─ addResult = await store.addFailure(content, {…})    (unchanged write)
  └─ if (addResult.success) throttle.recordCapture(dedupKey)   ④ count only on real write
  └─ (existing memoryRepo.syncMemoryEntry + ui.notify path unchanged)
```

**Quality invariant:** rate slots and the session-cache are updated **only at step ④** (after a successful write). Consequences:

- A cross-session duplicate (same error already in global `failures.md`, caught at ②) **does not** consume a rate slot, so common shared errors (e.g. a recurring `ModuleNotFoundError`) cannot starve genuinely novel captures.
- A this-session duplicate (already written this session, now in the cache) is denied at ① without touching the store — the O(1) fast path.

---

## 7. Config Surface

Fields are optional and **not** in `DEFAULT_CONFIG` (so the env fallback can apply). They **are** carried through `loadConfig` via selective copy (like `errorCapture`), so a config-file value wins. At the use-site (`setupErrorDetector`) they resolve as `config.x ?? envInt(env, DEFAULT)` — env applies only when the config-file left the field unset. **Precedence: config-file > env > default.** (Stricter than #847's lock fields, which are env-only because they aren't carried through `loadConfig` — a latent limitation we avoid here.)

**`types.ts`** (beside `errorCapture?: boolean`):
```ts
errorCaptureRateLimit?: number;       // 0 = unlimited
errorCaptureRateWindowMs?: number;
errorCaptureDedupCacheSize?: number;
```

**`constants.ts`:**
```ts
export const DEFAULT_ERROR_CAPTURE_RATE_LIMIT = 5;          // 5 captures …
export const DEFAULT_ERROR_CAPTURE_RATE_WINDOW_MS = 600_000; // … per 10 min
export const DEFAULT_ERROR_CAPTURE_DEDUP_CACHE_SIZE = 64;
```

**`setupErrorDetector` resolution:**
```ts
const rateLimit     = config.errorCaptureRateLimit     ?? envInt("PI_MEMORY_ERROR_CAPTURE_RATE_LIMIT",      DEFAULT_ERROR_CAPTURE_RATE_LIMIT);
const rateWindowMs  = config.errorCaptureRateWindowMs  ?? envInt("PI_MEMORY_ERROR_CAPTURE_RATE_WINDOW_MS",  DEFAULT_ERROR_CAPTURE_RATE_WINDOW_MS);
const dedupCacheSize = config.errorCaptureDedupCacheSize ?? envInt("PI_MEMORY_ERROR_CAPTURE_DEDUP_CACHE_SIZE", DEFAULT_ERROR_CAPTURE_DEDUP_CACHE_SIZE);
const throttle = new CaptureThrottle({ rateLimit, rateWindowMs, dedupCacheSize });
```

**Precedence:** config-file field > env var > default. `config.errorCapture === false` short-circuits before construction (throttle never built) — unchanged.

---

## 8. Scope Boundaries (explicitly deferred)

- **Fuzzy/similarity dedup** — complex and brittle; exact-key dedup + rate cap cover the flood. Revisit if near-duplicate bloat persists post-deployment.
- **Severity/lesson-worthy pattern retuning** — brittle pattern-list work; separate effort.
- **Capture budget (near-limit best-effort skip)** — largely covered by the rate cap + #851's 40k limit.
- **Cross-session shared rate budget** — per-session cap + cross-session store-dedup suffice.
- **Throttle-state persistence** — per-session ephemeral is correct (each session gets its own fresh budget).
- **Consolidation child** capture — a spawned consolidator child may wire its own detector, but it is short-lived; out of scope for fill-rate reduction.

---

## 9. Testing

### Unit — `tests/handlers/capture-throttle.test.ts` (new)
- Under cap → `allow` true; at cap → `allow` false.
- Window reset: inject fake clock, advance past `rateWindowMs` → `allow` true again.
- `recordCapture(key)` then `allow(key)` → false (this-session dup, ①).
- `allow()` does **not** record: two `allow(sameKey)` without an intervening `recordCapture` both return true (proves the 2-phase contract).
- LRU eviction: exceed `dedupCacheSize` → oldest key evicted → its `allow` returns true again.
- `rateLimit: 0` → unlimited (never rate-denies).
- `dedupCacheSize: 0` → no cache fast-path.
- Fail-open: malformed input / internal throw → `allow` returns true.

### Integration — `tests/handlers/error-detector.test.ts` (extend existing)
- Throttle denies → `addFailure` **not** called (mock store; assert call count).
- At cap → further `isLessonWorthy` errors skipped (count `addFailure` calls ≤ cap).
- **Cross-session store-dup does not consume a rate slot**: pre-seed `store.getFailureEntries` with the key; fire several; assert cap not consumed (subsequent genuinely-novel error still captured).
- High cap (e.g. `rateLimit: 1_000_000`) → existing behaviour unchanged (no regression).

### Config — `tests/config.test.ts` (extend)
- `loadConfig` accepts the three new numeric fields.
- At-use resolution: `config` field wins over env; env wins over default; default when neither set.

---

## 10. Error Handling & Edge Cases

- `CaptureThrottle` is pure in-memory and never throws in normal operation; `allow()` **fails open** (returns `true`) on any internal error — a throttle bug must never block a lesson-worthy capture.
- The capture path remains best-effort `try/catch` (unchanged): a throttle failure can never break the agent session.
- **Concurrency soft-limit:** the `tool_result` handler `await`s the store-check + write; between `allow()` returning true and `recordCapture()`, another interleaved capture may also pass `allow()` against a stale count. Near the cap edge, captures may slightly exceed `rateLimit`. This is acceptable for an anti-flood mechanism (not a hard meter) and bounded by per-session serialization.
- **Per-session scope:** the throttle instance lives in the detector closure (one per `setupErrorDetector` call = one per session). Not persisted, not shared across sessions → correct per-session semantics.
- `rateLimit: 0` and `dedupCacheSize: 0` are valid disabling sentinels (see §5).

---

## 11. Backward Compatibility

- All three config fields are optional; defaults make the throttle **active by default** (the feature's intent). Users with no config get `5 / 10 min / 64`.
- `errorCapture: false` continues to fully disable (throttle never constructed).
- Non-error tool results are unaffected.
- No change to `MemoryStore`, `addFailure`, consolidation, or the DB backend.
- No change to the public extension/tool surface.

---

## 12. Acceptance Criteria (from #854)

- [x] At least one throttle mechanism implemented — **per-session rate limit + session-local dedup cache** (this spec).
- [x] Configurable via `MemoryConfig` / env with sane defaults (`5 / 600_000ms / 64`; precedence config > env > default).
- [x] High-signal captures preserved — rate slot consumed only on real write; cross-session dups and this-session dups do not consume the novel-capture budget.
- [x] Tests for rate-limiting + dedup behaviour (unit + integration).
- [ ] Under realistic multi-session load, `failures.md` growth rate drops measurably — **verifiable post-deployment** (operational, not a unit test).

---

## 13. References

- #854 — this issue.
- #847 — op-level retry on `ELOCKED` (symptom mitigation).
- #851 — raise failure char limit to 40000 (symptom mitigation).
- #857 — consolidation progress + model-id via `onUpdate` (UX).
- #853 — 2-phase consolidation structural fix (deferred).
- Code: `src/handlers/error-detector.ts`, `src/store/memory-store.ts` (`envInt` at L34, lock config at L148-150), `src/config.ts`, `src/types.ts`, `src/constants.ts`.
