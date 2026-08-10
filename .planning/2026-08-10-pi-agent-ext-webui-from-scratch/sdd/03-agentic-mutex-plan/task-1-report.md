# Task 1 Report — `AgentMutex` module + unit tests (ticket-03 zk-spawn)

**Branch:** `03-agentic-mutex-impl`
**Commit:** `7169e9ec` — `feat(webui): AgentMutex module - gate/release/watchdog (ticket 03)`
**Scope:** files under `bun-apps/pi-agent-ext-webui/` ONLY (3 files, 320 insertions).

---

## What I implemented

The pure "deep module" behind ticket-03's agentic mutual-exclusion lock, exactly
per `task-1-brief.md`. No pi dependency; `InputSource`/`Frontend` are mirrored
locally (the bridge to real pi types is ticket 04).

**Files created (all VERBATIM from the brief, except one comment-only fix — see Concerns):**

| Path | Role |
|------|------|
| `bun-apps/pi-agent-ext-webui/src/mutex.ts` | The module: types, interfaces, `DEFAULT_WATCHDOG`, `toFrontend`, `class AgentMutex`. |
| `bun-apps/pi-agent-ext-webui/tests/mutex.test.ts` | 16 tests: gate acquire/conflict/passthrough, release + idempotency, watchdog force-release/no-fire/bump-reset, `toFrontend` + `DEFAULT_WATCHDOG`. |
| `bun-apps/pi-agent-ext-webui/tests/helpers/fake-clock.ts` | Deterministic `MutexClock` (single active `setInterval`, virtual `advance(ms)`). |

**Exported API (consumed unchanged by Task 2 / ticket 04):**

- Types: `Frontend = "tui" | "web"`, `ReleaseReason = "settled" | "watchdog" | "shutdown"`,
  `InputSource = "interactive" | "rpc" | "extension"`.
- Interfaces: `GateResult { verdict: "continue"|"handled"; driver: Frontend|null; blocked?: { by: Frontend } }`,
  `MutexClock { now(); setInterval(handler, ms): MutexTimer }`, `MutexTimer { clear() }`,
  `WatchdogConfig { staleMs; intervalMs }`, `MutexCallbacks { onForceRelease?(info) }`,
  `AgentMutexOptions { clock; watchdog?; callbacks? }`.
- `const DEFAULT_WATCHDOG: WatchdogConfig = { staleMs: 10 * 60_000, intervalMs: 1000 }` (= `{ 600_000, 1000 }`).
- `function toFrontend(source): Frontend | null` — `interactive→"tui"`, `extension→"web"`, `rpc→null`.
- `class AgentMutex`: `gate(source): GateResult` (synchronous check-and-set, atomic by JS single-threading),
  `get driver(): Frontend | null`, `release(reason: ReleaseReason): void` (idempotent),
  `bumpActivity(): void`. Watchdog starts on first acquire, force-releases via
  `callbacks.onForceRelease?.({ driver })` after `staleMs` with no `bumpActivity`.

Semantics verified by tests: rpc passes through ungated (no acquire); same-side resubmit
while driving → `continue`; other-side submit while driving → `handled` + `blocked.by`.

---

## TDD evidence

### RED (Step 3) — expected failure, captured verbatim

Command: `( cd bun-apps/pi-agent-ext-webui && bun test tests/mutex.test.ts )`
Run AFTER creating the two test files (Step 1 & 2) but BEFORE `src/mutex.ts` existed.

```
bun test v1.3.14 (0d9b296a)

tests/mutex.test.ts:

# Unhandled error between tests
-------------------------------
error: Cannot find module '../src/mutex.js' from '/Users/huangziyu/proj/video_generation__webui/bun-apps/pi-agent-ext-webui/tests/mutex.test.ts'
-------------------------------


 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [9.00ms]
```

**Why expected:** the module under test did not exist yet, so the import
`from "../src/mutex.js"` failed to resolve. This matches the brief's Step-3 prediction
exactly (`Cannot find module "../src/mutex.js"`). Confirms the tests genuinely exercise
the not-yet-written module (true RED), not a vacuous green.

### GREEN (Step 5) — all tests pass, captured verbatim

Command (identical): `( cd bun-apps/pi-agent-ext-webui && bun test tests/mutex.test.ts )`
Run AFTER implementing `src/mutex.ts` (Step 4).

```
bun test v1.3.14 (0d9b296a)

tests/mutex.test.ts:
(pass) AgentMutex.gate > acquires from idle for tui (interactive) [0.19ms]
(pass) AgentMutex.gate > acquires from idle for web (extension) [0.02ms]
(pass) AgentMutex.gate > same-side resubmit while driving -> continue (followUp queues internally) [0.03ms]
(pass) AgentMutex.gate > other-side submit while tui driving -> handled + blocked.by tui [0.02ms]
(pass) AgentMutex.gate > symmetric: other-side submit while web driving -> handled + blocked.by web [0.01ms]
(pass) AgentMutex.gate > rpc passes through ungated from idle (no acquire) [0.01ms]
(pass) AgentMutex.gate > rpc passes through even while a frontend is driving [0.01ms]
(pass) AgentMutex.release > clears the driver [0.03ms]
(pass) AgentMutex.release > is idempotent (release-when-idle is a no-op) [0.03ms]
(pass) AgentMutex.release > allows re-acquire after release [0.02ms]
(pass) AgentMutex watchdog > force-releases after staleMs with no bumpActivity [0.18ms]
(pass) AgentMutex watchdog > does NOT force-release before staleMs [0.02ms]
(pass) AgentMutex watchdog > bumpActivity resets the inactivity window [0.04ms]
(pass) AgentMutex watchdog > does not fire while idle (no acquire -> no watchdog) [0.02ms]
(pass) toFrontend + DEFAULT_WATCHDOG > maps sources to frontends (rpc -> null) [0.01ms]
(pass) toFrontend + DEFAULT_WATCHDOG > DEFAULT_WATCHDOG = 10 min stale / 1 s tick

 16 pass
 0 fail
 31 expect() calls
Ran 16 tests across 1 file. [9.00ms]
```

**16/16 passing**, 31 `expect()` calls, output pristine (no warnings, no unhandled errors).

---

## Typecheck (Step 6)

Command: `( cd bun-apps/pi-agent-ext-webui && bun run build )`

```
$ bunx tsc
EXIT=0
```

`bunx tsc` exits 0, emits `dist/` (`index.d.ts`, `index.js`, `mutex.d.ts`, `mutex.js`),
no errors. The emitted `dist/mutex.d.ts` was inspected and confirms the public API
surface matches the brief exactly (all types/interfaces, `DEFAULT_WATCHDOG`,
`toFrontend`, `class AgentMutex` with `gate`/`driver`/`release`/`bumpActivity`).
Per design, `tsconfig.json` `include` is `src/**/*.ts` only, so the tests are not
`tsc`-compiled (they run under `bun:test`).

---

## Files changed

Committed in `7169e9ec` (3 files, +320 lines):

- `bun-apps/pi-agent-ext-webui/src/mutex.ts` (new)
- `bun-apps/pi-agent-ext-webui/tests/mutex.test.ts` (new)
- `bun-apps/pi-agent-ext-webui/tests/helpers/fake-clock.ts` (new)

Explicit-path staging (`git add <three paths>`); never `git add -A`. `dist/` is
gitignored and was correctly NOT staged. No `bun-apps/bun.lock` change (Task 1 adds
no dependencies — as expected). Pre-existing repo changes left untouched:
`python/embed-bench/backends/mlx_native.py` (modified) and
`.planning/2026-08-10-pi-agent-ext-webui-from-scratch/sdd/` (untracked) remain
exactly as found — not in this commit.

---

## Self-review findings

1. **Public API surface matches the brief exactly.** Verified against the emitted
   `dist/mutex.d.ts`: every exported name/type/signature — `Frontend`, `ReleaseReason`,
   `InputSource`, `GateResult`, `MutexClock`, `MutexTimer`, `WatchdogConfig`,
   `DEFAULT_WATCHDOG` (`{ staleMs: 600_000, intervalMs: 1000 }`), `toFrontend`,
   `MutexCallbacks`, `AgentMutexOptions`, and `class AgentMutex` (`gate`, `driver`,
   `release`, `bumpActivity`) — is present and unchanged. Downstream Task 2
   (`MutexController`) and ticket 04 (`pi.on(...)` wiring) can consume this verbatim.
2. **No pi dependency.** Module imports nothing; `InputSource`/`Frontend` are mirrored
   locally. Confirmed by `dist/mutex.js` (zero runtime imports).
3. **Strict, NodeNext, `.js` import extensions** preserved in both source and tests.
4. **Atomicity claim holds.** `gate()` is fully synchronous (no `await`); the check-and-set
   is atomic by JS single-threading, so two near-simultaneous frontends cannot both acquire.
5. **Watchdog correctness.** Started only on first acquire; cleared on release (both
   manual `release("settled"|"shutdown")` and self-release via `tick()`→`release("watchdog")`).
   `bumpActivity()` is a no-op while idle (does not corrupt state). The
   `force-releases after staleMs` test exercises the full acquire→tick→`onForceRelease`
   path with the deterministic `FakeClock`.
6. **`release()` idempotency + re-acquire** covered by explicit tests.
7. **Commit message** is the brief's exact string.

---

## Concerns

1. **One verbatim deviation — comment-only, forced by a syntax bug in the brief's code.**
   The brief's `src/mutex.ts` line for `bumpActivity()` was a JSDoc block comment:
   `/** Reset the watchdog inactivity timer. Call on every message_*/tool_* event. */`.
   The literal substring `*/` inside `message_*/tool_*` **terminates the JSDoc block
   comment early**, leaving `tool_* event. */` as bare TypeScript — a hard syntax error
   (`Expected ";" but found "*"`, etc.). The verbatim text is therefore unparseable and
   directly violates the brief's own mandatory acceptance criteria (Step 5 GREEN + Step 6
   `tsc` exit 0), and would break downstream consumers. I applied the **minimal possible
   fix**: switched that single comment from a JSDoc block (`/** ... */`) to a `//` line
   comment, preserving the exact wording ("Reset the watchdog inactivity timer. Call on
   every message_*/tool_* event.") character-for-character. **Zero change to any logic,
   type, or signature.** No other line in any of the three files was altered. Flagging
   here for transparency and so Task 2 / ticket-04 authors are aware of the one-line
   difference from the brief text. (Recommended follow-up: amend the brief to use `//`
   or reword to avoid the embedded `*/`.)

No other concerns. All acceptance gates pass: RED demonstrated the failing import,
GREEN is 16/16 pristine, typecheck exits 0 with correct `dist/` emission, commit is
scoped to exactly the three intended files.
