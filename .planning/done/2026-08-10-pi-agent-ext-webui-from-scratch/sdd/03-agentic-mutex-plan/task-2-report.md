# Task 2 Report — `MutexController` adapter + tests (ticket 03, zk-spawn)

**Status:** DONE
**Branch:** `03-agentic-mutex-impl` (on top of Task 1 commit `7169e9ec`)
**Commit:** `b360cdee` — `feat(webui): MutexController adapter - events<->mutex + notifications (ticket 03)`

## What I implemented

Two files under `bun-apps/pi-agent-ext-webui/`, copied **verbatim** from the task brief (no paraphrasing, no renames):

1. **`tests/mutex-controller.test.ts`** (8 tests) — pure wiring/translation tests for `MutexController`.
   - Uses a `recorder()` notifier that captures `notifyBlocked` / `notifyForceRelease` calls.
   - `MutexController.handleInput` suite (5 tests): idle acquire → `continue` + `driver` set + no notify; cross-side block → `handled` + `notifyBlocked(blocked, by)`; symmetric (tui blocked while web driving); same-side resubmit → `continue` no notify; `rpc` passthrough → `continue`, `driver === null`.
   - `MutexController.lifecycle` suite (3 tests): `handleSettled` releases; `handleShutdown` releases; watchdog force-release routes through `notifyForceRelease` (FakeClock, `staleMs: 1000, intervalMs: 100`, advance 1000ms).

2. **`src/mutex-controller.ts`** — the event↔mutex adapter.
   - Exports `interface MutexNotifier { notifyBlocked(blocked: Frontend, by: Frontend): void; notifyForceRelease(driver: Frontend): void }`, `interface MutexControllerOptions`, and `class MutexController`.
   - Constructor builds an `AgentMutex`, wiring `callbacks.onForceRelease` → `notifier.notifyForceRelease(driver)`.
   - `get driver(): Frontend | null` delegates to `mutex.driver`.
   - `handleInput(source)` → calls `mutex.gate`, returns `{ action: "continue" | "handled" }`; on a reject (`verdict === "handled" && r.blocked`) it computes the blocked frontend via `toFrontend(source)` and fires `notifyBlocked(blocked, r.blocked.by)`.
   - `handleSettled()` → `mutex.release("settled")`; `handleActivity()` → `mutex.bumpActivity()`; `handleShutdown()` → `mutex.release("shutdown")`.
   - No pi import (`InputSource`/`Frontend` mirrored from Task 1's `mutex.ts`).

Consumed unchanged from Task 1's `src/mutex.ts`: `AgentMutex`, `toFrontend`, `Frontend`, `InputSource`, `MutexClock`, `WatchdogConfig`. **Task 1 files were NOT modified.**

## TDD evidence

### RED (Step 2) — test created before implementation

Command: `( cd bun-apps/pi-agent-ext-webui && bun test tests/mutex-controller.test.ts )`

```
bun test v1.3.14 (0d9b296a)

tests/mutex-controller.test.ts:

# Unhandled error between tests
-------------------------------
error: Cannot find module '../src/mutex-controller.js' from '.../tests/mutex-controller.test.ts'
-------------------------------

 0 pass
 1 fail
 1 error
Ran 1 test across 1 file. [8.00ms]
EXIT=1
```

Matches the brief's predicted failure exactly: `Cannot find module '../src/mutex-controller.js'`.

### GREEN (Step 4) — after creating the implementation

Command: `( cd bun-apps/pi-agent-ext-webui && bun test tests/mutex-controller.test.ts )`

```
 8 pass
 0 fail
 16 expect() calls
Ran 8 tests across 1 file. [11.00ms]
EXIT=0
```

All 8 new tests green.

## Full suite + typecheck (Step 5)

Command: `( cd bun-apps/pi-agent-ext-webui && bun test && bun run build )`

- `bun test` (which the package's `test` script runs as `bun run build && bun run test:unit`) → **24 pass / 0 fail** (8 new mutex-controller + 16 existing mutex), 47 `expect()` calls.
- `bun run build` (= `bunx tsc`) → **EXIT=0** (strict, NodeNext; `.js` import extensions resolve).

```
 24 pass
 0 fail
 47 expect() calls
Ran 24 tests across 2 files. [13.00ms]
$ bunx tsc
EXIT=0
```

## Files changed

| File | Change |
|---|---|
| `bun-apps/pi-agent-ext-webui/src/mutex-controller.ts` | new (+99 lines) |
| `bun-apps/pi-agent-ext-webui/tests/mutex-controller.test.ts` | new (+79 lines) |

Commit `b360cdee`: `2 files changed, 178 insertions(+)`. Staged with explicit paths (`git add <src> <test>`); no `git add -A`. No `bun-apps/bun.lock` change (Task 2 adds no deps, as expected).

## Self-review findings

1. **Verbatim adherence** — both files are byte-for-byte the brief's spec (modulo only whitespace the writer normalized). No wording/semantics changed; no minimal-fix override was needed. The brief's code compiled and passed on the first run.
2. **Spec coverage (SS4/SS5 wiring)** — `input → gate → {action}`, `agent_settled → release`, activity → `bumpActivity`, shutdown → `release` all present and tested; `notifyBlocked(blocked, by)` carries the correct `by` (asserted both directions); watchdog force-release flows to `notifyForceRelease` (asserted). Out-of-plan (intentional): real `pi.on(...)` + `Bun.serve` → ticket 04.
3. **Separation of concerns (binding)** — the pure `AgentMutex` stays I/O-free; `mutex-controller.ts` is the **only** place that maps verdicts → `{action}` and fires notifications. ✓
4. **Type consistency** — `GateResult.blocked` is `{ by: Frontend } | undefined`; the controller guards `r.verdict === "handled" && r.blocked` before reading `r.blocked.by` and narrows `toFrontend(source)` with an `if (blocked)` (rpc can't be blocked, but the guard is correct defense-in-depth). `notifyForceRelease` receives the `Frontend` string, matching the test's `expect(n.force).toEqual(["tui"])`.
5. **Commit scope** — post-commit `git status` shows only the pre-existing out-of-scope noise (`python/embed-bench/backends/mlx_native.py` modified, `.planning/.../sdd/` untracked) which the brief forbids touching; my commit touches nothing else. `dist/` is correctly gitignored.

## Concerns

None.
