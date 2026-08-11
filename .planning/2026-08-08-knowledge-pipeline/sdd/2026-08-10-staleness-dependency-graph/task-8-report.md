# Task 8 Report — stale graduation gate (wayfind) (10-impl T8)

> The "what I actually did + evidence" record. Pairs with `task-8-brief.md`.
>
> Branch: `knowledge-pipeline/10-impl-staleness` (CONTINUED off `9eaeaac7`).
> **FIRST wayfind consumer of the T7 seam** (decision β reader).

## What was implemented

The graduation gate (decision ε) — `closeEffortReflection` (wayfind's
`/wayfind done` closing ceremony) now REFUSES to graduate an effort while any
closed planning decision whose cited/declared source-file deps changed since last
validation remains. This is the FIRST read-side consumer of the T7 seam.

### `src/wayfinder.ts` (MODIFIED — additive: async + 1 import + 1 arm)

1. **Import** — `import { readStaleDecisions } from "./stale-seam.js";` (line 20;
   the `.js` extension matches every other wayfind import).
2. **Signature** — `closeEffortReflection` → `async`, return type
   `CloseEffortReflection | CloseEffortRefused` →
   `Promise<CloseEffortReflection | CloseEffortRefused>`. The doc comment grew to
   describe the new gate + the null-safe no-op semantic.
3. **Stale-check arm** (line 275) — inserted AFTER the frontier-check refused arm
   (line 264, `if (frontier.length > 0)`) and BEFORE `const deferredPrizes`
   (line 282) and `fileCompletedEffort` (line 295):
   ```ts
   const stale = await readStaleDecisions(effort, cwd);
   if (stale && stale.length > 0) {
     const which = stale.map((s) => s.cardId).join(", ");
     return { refused: `${stale.length} stale decision(s) remain on "${effort}" — dependencies changed since last validation (${which}). Re-grill to resolve (re-open ticket, re-validate, update resolution) before /wayfind done` };
   }
   ```
   The arm is the SAME shape as the frontier-check `{refused}` arm (read a guard
   → non-empty → `return { refused: <count + ids + remediation> }`), sourced from
   the seam instead of `computeFrontier`.

### How `effort` + `cwd` are obtained

`closeEffortReflection(cwd, effort, now)` already takes BOTH as its first two
params. `cwd` is the repo root (required by `fileCompletedEffort` →
`completeEffort` to write `.planning/done/`). They are passed verbatim to
`readStaleDecisions(effort, cwd)` — **NO new threading**; the param order matches
the T7 signature `readStaleDecisions(effort, cwd)`.

### `src/commands.ts` (MODIFIED — 1 line)

`handleWayfindDone` (already `async`): `const r = closeEffortReflection(...)`
→ `const r = await closeEffortReflection(...)`. **No other non-test caller**
exists (verified: `grep -rn "closeEffortReflection("` → only the definition,
this caller, + the test sites).

### `tests/wayfinder.test.ts` (MODIFIED — 3 awaits + 1 new describe)

- The 3 existing `closeEffortReflection` assertions (the "refuses when open
  tickets remain", "refuses when the effort has no map", and "harvests fog"
  tests) each get ONE `await` + their `it()` callbacks became `async`. Awaiting a
  non-thenable returns the value, so the RED→GREEN transition was clean.
- New `describe("closeEffortReflection — staleness graduation gate (10-impl T8)")`
  with **4** tests + a scoped `afterEach` that deletes
  `globalThis.__piHermesStaleCheck`:
  1. **refuses when stale decisions remain** — seam returns a non-empty list →
     `{refused}` mentioning `1 stale decision(s)` + the effort + the cardId.
  2. **proceeds when hermes absent** (no seam → null → no-op → graduates). The
     critical null-safe no-op test.
  3. **proceeds when the seam reports zero stale** (`{ stale: [] }` → graduates).
  4. **fires the frontier-check arm FIRST** — an open ticket + a stale seam → the
     frontier message wins; the stale arm (after it) is never reached.

## Deviation from the plan's literal T8 code — and why

### #1 — one EXTRA test (frontier-first) beyond the plan's 3

The plan's T8 gives 3 new tests (refuses-stale / absent-proceeds /
zero-stale-proceeds). I added a 4th (**frontier check fires first**) because the
task explicitly calls it out and the plan's DoD lists "the frontier-check arm
still fires first" as a required invariant. It is cheap (one open ticket + a
stale seam) and pins the arm-ordering that the "additive, after the frontier arm"
contract depends on. No semantic deviation.

### #2 — refused message + import implemented verbatim

The plan's verbatim refused message (count + effort + the stale `cardId`s via
`${which}` + the remediation "Re-grill … before /wayfind done") is implemented
verbatim. The import path `./stale-seam.js` matches every other wayfind import.
No deviation.

## Evidence

### RED (before implementing the arm — `bun test tests/wayfinder.test.ts`)

```
(fail) refuses when stale decisions remain (seam returns a non-empty list)
  expect("refused" in r).toBe(true)  →  Received: false   [no stale arm yet → graduates instead of refusing]
(pass) proceeds when hermes is absent … (no-op path happens to hold)
(pass) proceeds when the seam reports zero stale … (empty path happens to hold)
(pass) fires the frontier-check arm FIRST … (frontier arm already exists)
(pass) the 3 await-updated existing closeEffortReflection tests  (await on non-thenable returns the value)
22 pass / 1 fail
```
The "refuses when stale" test fails for the RIGHT reason (no stale arm → not
refused). The other 3 new tests pass by luck of the no-op/empty/frontier paths
existing pre-arm. Correct RED.

### GREEN (after async + import + arm + awaits)

```
23 pass / 0 fail / 77 expect() calls   [tests/wayfinder.test.ts]
```
All 4 new gate tests pass + the 3 await-updated existing tests + the rest.

### Full-suite regression

**Wayfind** — `bun run check` (biome) AND `bunx tsc --noEmit` AND `bun test`:

| stage | pass | skip | fail | err | expect | biome | tsc | note |
|---|---|---|---|---|---|---|---|---|
| after-T7 (stated baseline) | 471 | 1 | 1 | 1 | 933 | 1 (`tests/map.test.ts` format) | exit 0 | pre-existing `architecture-render.test.ts` ENOENT (missing `.planning/.../sample-report.md` fixture) + `map.test.ts` biome debt |
| **after-T8** | **475** | **1** | **1** | **1** | **942** | **1 (same `map.test.ts`)** | **exit 0** | +4 pass / +9 expect (my 4 new gate tests); my 3 changed files are biome-clean; the 1 fail/1 err/biome-error are ALL unchanged baseline |

> **Zero regressions.** Net delta = **+4 pass / +9 expect() calls**, identical
> skip/fail/err. The 1 fail (`architecture-render.test.ts` ENOENT on a missing
> `.planning/2026-08-08-improve-codebase-architecture/brainstorm/sample-report.md`
> fixture) + the 1 biome error (`tests/map.test.ts` format debt) are BOTH
> pre-existing baseline (carried unchanged since T7, flagged in T7's report). My 3
> changed files are biome-clean and tsc-clean. tsc exit 0.

## Self-review (master invariants)

- ✅ **Additive.** The frontier-check arm (line 264) + `fileCompletedEffort`
  (line 295) + ALL existing graduation behavior are UNCHANGED. T8 = one new arm
  (line 275) + `async` + caller/test `await`s. Verified by diff: only the
  signature line, the import line, and the inserted arm changed in `wayfinder.ts`;
  only one `await` in `commands.ts`.
- ✅ **Null-safe.** Hermes absent (T7 reader → `null`) OR seam throws (T7 reader
  → `null`) → the gate's `if (stale && stale.length > 0)` short-circuits →
  graduation proceeds. Proven by the "proceeds when hermes absent" test. NEVER
  crashes, NEVER false-blocks.
- ✅ **Frontier check still fires first.** The stale arm is AFTER the frontier arm
  + BEFORE the graduation tail, so a frontier violation refuses first. Proven by
  the "fires the frontier-check arm FIRST" test (frontier message wins; the stale
  message is never produced).
- ✅ **Gate fires only on validated→drifted.** A never-validated card is
  lazily-seeded by `computeStaleness` (T4 semantic) and is NOT flagged stale
  (N1 heads-up) — so the gate only blocks when a PREVIOUSLY-VALIDATED decision's
  deps have since drifted. The tests fake the seam directly with a non-empty
  `stale` list, so they exercise the gate path without needing the real hermes
  compute.
- ✅ **Async ripple localized + mechanical.** Sole non-test caller
  (`commands.ts:handleWayfindDone`) was already `async` → one `await`. The 3
  existing test callbacks became `async` + got one `await` each. tsc exit 0
  confirms no broken promise/no-missing-await.

## Files changed

```
bun-apps/pi-agent-ext-wayfind/src/wayfinder.ts        (MODIFIED: +import readStaleDecisions; closeEffortReflection → async; +stale-check arm @ line 275)
bun-apps/pi-agent-ext-wayfind/src/commands.ts         (MODIFIED: handleWayfindDone +1 await)
bun-apps/pi-agent-ext-wayfind/tests/wayfinder.test.ts (MODIFIED: 3 existing asserts → await/async; +new describe, 4 gate tests + scoped afterEach)
```

## Diff hunks

`src/commands.ts` — `handleWayfindDone` (already async):
```diff
-    const r = closeEffortReflection(ctx.cwd, effort);
+    const r = await closeEffortReflection(ctx.cwd, effort);
```

`src/wayfinder.ts` — import + signature + arm:
```diff
+import { readStaleDecisions } from "./stale-seam.js";
…
-export function closeEffortReflection(
+export async function closeEffortReflection(
   cwd: string,
   effort: string,
   now: Date = new Date(),
-): CloseEffortReflection | CloseEffortRefused {
+): Promise<CloseEffortReflection | CloseEffortRefused> {
…
   if (frontier.length > 0) { … return { refused: … }; }
+  // 10-impl: BLOCK graduation while closed decisions whose deps changed remain.
+  // readStaleDecisions → null when hermes absent/throws → no-op (never crashes).
+  const stale = await readStaleDecisions(effort, cwd);
+  if (stale && stale.length > 0) {
+    const which = stale.map((s) => s.cardId).join(", ");
+    return { refused: `${stale.length} stale decision(s) remain on "${effort}" — dependencies changed since last validation (${which}). Re-grill to resolve (re-open ticket, re-validate, update resolution) before /wayfind done` };
+  }
   const deferredPrizes = map.fog.filter((p) => !p.startsWith("<!--"));
```

## Concerns

- **Wayfind pre-existing baseline failures** (1 test fail `architecture-render.test.ts`
  ENOENT on a missing `.planning/.../sample-report.md` fixture; 1 biome error
  `tests/map.test.ts` format debt) — both carried unchanged since T7's baseline.
  Not T8-caused, not T8's to fix. Flagged for awareness.
- The gate now BLOCKS `/wayfind done` whenever the seam reports ≥1 stale decision.
  Once T9 lands (read-side surfacing) the agent will see *why* in the effort panel
  before invoking done. Until then the refused message names the stale `cardId`s +
  the remediation (re-grill), so the agent has an actionable path.
- **Dist files** (`dist/wayfinder.js`, `dist/commands.js`, `dist/wayfinder.d.ts`)
  still reference the OLD sync signature — these are build artifacts regenerated
  by `bun run build`; out of T8's scope (T7 also did not rebuild dist).

## Commit

```
feat(knowledge-pipeline): stale graduation gate (10-impl T8)
```
