# Task 8 Brief — stale graduation gate (wayfind) (10-impl T8)

> The "what I'm about to do + contract" record. Pairs with `task-8-report.md`.
>
> Branch: `knowledge-pipeline/10-impl-staleness` (CONTINUED off `9eaeaac7`).
> This is the **FIRST wayfind consumer of the T7 seam** (decision β reader).

## Contract (decision ε — BLOCK graduation while cited deps drifted)

`closeEffortReflection` (wayfind's `/wayfind done` closing ceremony) becomes a
**graduation gate**: it REFUSES to graduate an effort while any closed planning
decision whose cited/declared source-file deps changed since last validation
remains. This is the read-side consumer of the T7 seam.

### The gate (mirrors the existing frontier-check `{refused}` arm)

`closeEffortReflection` already refuses when the frontier is non-empty (open
tickets). T8 adds a SECOND refuse arm **after** the frontier check and **before**
the graduation tail (`fileCompletedEffort`):

```ts
const stale = await readStaleDecisions(effort, cwd);
if (stale && stale.length > 0) {
  const which = stale.map((s) => s.cardId).join(", ");
  return { refused: `${stale.length} stale decision(s) remain on "${effort}" — … re-grill … before /wayfind done` };
}
```

The structural template is the frontier-check arm (`wayfinder.ts:254–260`):
read a guard → if non-empty → `return { refused: <count + ids + remediation> }`.
The stale arm is the same shape, sourced from the seam instead of `computeFrontier`.

### Why ASYNC (β ripple — the plan's only public-signature change)

`readStaleDecisions` (T7) is `async` (hermes computes staleness from the DB +
source files at call time). Therefore `closeEffortReflection` becomes `async`
(return type `CloseEffortReflection | CloseEffortRefused` →
`Promise<CloseEffortReflection | CloseEffortRefused>`). The signature ripple is
**localized + mechanical**:

- **sole non-test caller** `commands.ts:handleWayfindDone` is already `async` →
  add ONE `await` to `const r = closeEffortReflection(ctx.cwd, effort);`.
- **3 existing test assertions** in `tests/wayfinder.test.ts` (lines 170, 177,
  193) each get ONE `await` (+ the enclosing `it()` callbacks become `async`).
  `await` on a non-promise still resolves to the value, so the RED→GREEN
  transition is clean.

### Why null-safe (the gate must NEVER crash / NEVER false-block)

- **hermes absent** (T7 reader returns `null` — `typeof fn !== "function"`) → the
  gate's `if (stale && stale.length > 0)` short-circuits → graduation proceeds.
  This is the **critical no-op test**: a wayfind install without hermes-memory
  graduates exactly as before T8.
- **seam throws** (T7 reader's `try/catch → null`) → same no-op.
- **empty list** (`{ stale: [] }`) → `stale.length > 0` is false → proceeds.

### How `effort` + `cwd` are obtained (already in scope)

`closeEffortReflection(cwd, effort, now)` already takes BOTH `cwd` (the repo
root — required by `fileCompletedEffort` → `completeEffort` to write into
`.planning/done/`) and `effort` as its first two parameters. They are passed
verbatim to `readStaleDecisions(effort, cwd)` — NO new threading needed. (This
was verified: the frontier-check arm and `fileCompletedEffort` both already use
these same params.)

## N1 heads-up (T7 review — awareness, not a blocker)

`getStaleCards`→`computeStaleness` (which the seam calls) **lazily seeds** a
baseline for never-validated cards on first touch (inherited T4 semantic). This
is SAFE for the gate: a card the graduation gate cares about (validated →
drifted → stale) already has a stored baseline, so the lazy-seed branch won't
fire. My tests do NOT need to pre-seed anything via the real hermes compute —
they FAKE the seam via `globalThis.__piHermesStaleCheck` (the real seam path,
mirrors the T7 wayfind test), so the gate sees a non-empty `stale` list directly.

## Files

| File | Action |
|---|---|
| `src/wayfinder.ts` | MODIFY — `closeEffortReflection` → `async`; +import `readStaleDecisions` from `./stale-seam.js`; +stale-check arm (after frontier arm, before `deferredPrizes`) |
| `src/commands.ts` | MODIFY — `handleWayfindDone`: `closeEffortReflection(...)` → `await closeEffortReflection(...)` (1 line; function already async) |
| `tests/wayfinder.test.ts` | MODIFY — `await` on the 3 existing `closeEffortReflection` assertions (lines 170/177/193) + their `it()` callbacks → `async`; +new `describe` block with 4 gate tests |

## Tests (TDD, RED first) — `tests/wayfinder.test.ts`

New `describe("closeEffortReflection — staleness graduation gate (10-impl T8)")`:

1. **refuses when stale decisions remain** — publish a seam returning
   `{ stale: [{cardId, effort}] }`; `await closeEffortReflection(...)` →
   `{refused}` mentioning the count (`1 stale decision(s)`) + the effort.
2. **proceeds when hermes is absent (seam undefined → null → no-op)** — NO seam
   published; `await closeEffortReflection(...)` on a frontier-clear effort →
   NOT refused (graduates). **The critical null-safe test.**
3. **proceeds when the seam reports zero stale** — seam returns `{ stale: [] }`;
   proceeds (graduates). Distinguishes null-no-op from empty-proceeds.
4. **frontier check still fires first** — a frontier violation (open ticket) AND
   a stale seam published; `await closeEffortReflection(...)` → `{refused}`
   mentioning "open ticket" (the frontier message wins; the stale arm, being
   AFTER it, is never reached). Proves the ordering invariant.

`afterEach` in the new describe deletes `globalThis.__piHermesStaleCheck`
(scoped to the describe — does not disturb the file's existing temp-cleanup
`afterEach`).

## Pre-implementation adjustments (adaptation of the plan's verbatim T8 code)

### #1 — refused message wording (ε verbatim + count/effort)

The plan's verbatim message is:
`"...stale decision(s) remain on "${effort}" — dependencies changed since last
validation (${which}). Re-grill to resolve (re-open ticket, re-validate, update
resolution) before /wayfind done"`. I'll implement it verbatim — it carries the
count + effort + the stale `cardId`s + the remediation. My "refuses" test
asserts `.toContain("1 stale decision(s)")` + `.toContain(effort)` (subset
checks, robust to wording).

### #2 — one EXTRA test (frontier-first) beyond the plan's 3

The plan's T8 gives 3 new tests (refuses-stale / absent-proceeds /
zero-stale-proceeds). I add a 4th (**frontier check still fires first**) because
the task explicitly calls it out and the plan's DoD lists "the frontier-check
arm still fires first" as a required invariant. It is cheap (one open ticket +
a stale seam) and pins the arm-ordering that the "additive, after the frontier
arm" contract depends on.

### #3 — `readStaleDecisions` import path + `cwd`/`effort` param order

Import `readStaleDecisions` from `./stale-seam.js` (the `.js` extension matches
every other wayfind import: `./lifecycle.js`, `./map.js`, `./model.js`). Call it
as `readStaleDecisions(effort, cwd)` — param order matches the T7 signature
`readStaleDecisions(effort: string, cwd: string)` (NOT `cwd, effort`).

## Master invariants (additive)

- **The frontier-check arm + `fileCompletedEffort` + all existing graduation
  behavior are UNCHANGED.** T8 is additive: one new arm + `async` + `await`s.
- **Null-safe.** Hermes absent / seam throws → `null` → gate is a no-op →
  graduation proceeds, NEVER crashes, NEVER false-blocks.
- **Gate fires only on validated→drifted.** A never-validated card (no stored
  baseline) is lazily-seeded, not flagged stale (T4 semantic) — so the gate only
  blocks when a PREVIOUSLY-VALIDATED decision's deps have since drifted.

## RED → GREEN → regression gates

1. **RED** — the 3+1 new gate tests fail (`closeEffortReflection` is sync + has
   no stale arm → "refuses when stale" assertion fails; the others pass by luck
   of the no-op/empty paths). The 3 `await`-updated existing tests still pass
   (awaiting a non-thenable returns the value).
2. **GREEN** — async signature + import + stale-check arm + caller/test awaits.
3. **Regression** — wayfind `bun run check` (biome) AND `bunx tsc --noEmit` AND
   `bun test`. Expected after-T7 **471 pass / 1 skip / 1 fail / 1 err** →
   after-T8 (+new tests, SAME pre-existing fail/err UNCHANGED:
   `architecture-render.test.ts` ENOENT + `map.test.ts` biome debt). tsc exit 0.
   Any OTHER failure → STOP, report.
