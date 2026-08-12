# Task 7 Brief — hermes→wayfind staleness reverse seam (10-impl T7)

> The "what I'm about to do + contract" record. Pairs with `task-7-report.md`.
>
> Branch: `knowledge-pipeline/10-impl-staleness` (CONTINUED off `c2ced3bc`).
> This is the **FIRST CROSS-PACKAGE task** (hermes + wayfind).

## Contract (decision β — async, null-safe, ADR-0004 no cross-package import)

A **reverse** `globalThis` seam — the roles of `grill-seam.ts` are flipped:

| | grill-seam (existing) | stale-seam (T7 — NEW) |
|---|---|---|
| **Owner of the data** | wayfind (grill-active per session) | **hermes** (staleness compute) |
| **Publisher** | wayfind `coordination.ts` `publishWayfindGrill` | **hermes** `stale-seam.ts` `publishStaleCheck` |
| **Reader** | hermes `grill-seam.ts` `readGrillActive` (sync `boolean`) | **wayfind** `stale-seam.ts` `readStaleDecisions` (**async**, `StaleCard[] \| null`) |
| **globalThis key** | `__piWayfindGrill` (dup in both constants) | **`__piHermesStaleCheck`** (dup literal, both sides) |
| **Shape crossing** | `(sessionId) => boolean` | **`async (effort, cwd) => { stale: StaleCard[] }`** |

This seam is the connection **T8** (wayfind graduation gate) + **T9** (wayfind
read-side `stale` surfacing) need: wayfind asks hermes "are there stale planning
decisions for `<effort>`?" at `closeEffortReflection` time (T8) and for the effort
panel (T9).

### Why ASYNC (β — pinned in the plan's resolved decisions)

`getStaleCards` is async (it opens an ephemeral `CardStore`, enumerates
`getCardsByKind`, and re-parses source `.md`s via `readSourceCard` + reads dep
bytes from disk — all async). Therefore the seam fn is `async`, and **T8's
`closeEffortReflection` becomes `async`** (adaptation a — the plan's only
public-signature ripple; localized + mechanical). This task does NOT touch
`closeEffortReflection` — it only lands the seam that T8 will `await`.

### Why null-safe (the gate must NEVER crash / NEVER false-block)

- **wayfind reader** returns `null` when hermes is absent (`typeof fn !== "function"`)
  OR when the published fn throws (`try/catch → null`). T8's gate degrades to a
  no-op on `null` (graduation proceeds).
- **hermes publisher** returns `{ stale: [] }` (never throws) when the ephemeral
  store can't open OR `getStaleCards` throws. So even a broken hermes never
  false-blocks a wayfind graduation.

### ADR-0004 — NO cross-package import

The key literal (`"__piHermesStaleCheck"`) and the `StaleCard` shape
(`{ cardId, effort, missingDeps? }`) are **DUPLICATED** in both packages. A
cross-extension `import` is not reliable under jiti (see wayfind's
`coordination.ts` comment). `globalThis` is process-singleton → reliable.

## Files

| Side | File | Action |
|---|---|---|
| hermes (publisher) | `src/stale-seam.ts` | CREATE — `HERMES_STALE_CHECK_KEY` + `publishStaleCheck(memoryDir)` + `unpublishStaleCheck()` |
| hermes (wire) | `src/index.ts` | MODIFY — `publishStaleCheck(globalDir)` at init (after `registerPlanningStaleTool`); `unpublishStaleCheck()` in `session_shutdown` |
| hermes (test) | `src/stale-seam.test.ts` | CREATE — `node:test` + `node:assert/strict` (co-located, mirrors `src/store/planning-staleness.test.ts`) |
| wayfind (reader) | `src/stale-seam.ts` | CREATE — dup `HERMES_STALE_CHECK_KEY` literal + dup `StaleCard` type + `readStaleDecisions(effort, cwd)` |
| wayfind (test) | `tests/stale-seam.test.ts` | CREATE — `bun:test` (mirrors `tests/grill-seam.test.ts`) |

## Pre-implementation adjustments (adaptation of the plan's verbatim T7 code)

### #1 — hermes test seed is Path-B-wrong (read deps from source `.md`, NOT the store row)

The plan's verbatim hermes test does `store.upsertCard(card with graph.relations)` +
`computeStaleness(store, cardId, root)` with **no source `.md` on disk**. That is
the SAME latent bug T6's report flagged (and the committed T4 test fixed): post-η,
`computeStaleness` reads deps from `readSourceCard(store, id, fsRoot)` (a re-parse
of the source `.md`), NOT from `store.getCard(id).graph.relations` (the 06a store
does NOT persist `card.graph`). With no source `.md`, `readSourceCard` → `null` →
`computeStaleness` → `{ stale:false }` + writes **no** baseline → the card would
never be flagged stale; the "returns the stale card" assertion would fail for the
wrong reason.

**Fix:** mirror the committed T4 test's `seedSource` / `writeDep` idiom verbatim
(`src/store/planning-staleness.test.ts`): write a REAL source `.md` under
`<root>/.planning/seam/tickets/01-<slug>.md` with a `depends_on:` frontmatter dep
+ a `cites <path>` body line, write both dep files, `upsertCard` the ticket id
(for `getStaleCards` enumeration — id only, NO graph), `computeStaleness` to seed
the baseline @ v1, then edit the dep to v2, then call the published seam fn and
assert the card surfaces. This is exactly what the brief's STEP-6 anticipation
("prefer a real ephemeral store like T6" / "set up a stale card via the T4/T6
source-.md + dep-file idiom") directs. **Test semantics are unchanged** — only
the seed mechanics are corrected to match the committed T4 reality.

### #2 — publisher null-safe envelope

The plan's publisher body wraps BOTH the `createCardStore` (returns `{stale:[]}`
on throw) AND the `getStaleCards` call (returns `{stale:[]}` on throw, with a
`finally { store.close() }` best-effort). I'll implement it verbatim — it is the
correct null-safe envelope and matches the brief's "never false-blocks"
invariant. (`store` is declared outside the `try` so `finally` can close it; the
`createCardStore`-throw path has nothing to close.)

### #3 — wire location in `src/index.ts`

Publish at init immediately after the T6 `registerPlanningStaleTool(pi,
{ memoryDir: globalDir });` line (both are the staleness surfaces; `globalDir`
is in scope there). Unpublish in the existing `session_shutdown` handler — add a
best-effort `try { unpublishStaleCheck(); } catch {}` near the top of the
shutdown handler (before the DB drain, so the seam is cleared even if the drain
throws). Mirrors the grill seam's publish-at-init / unpublish-on-shutdown lifecycle.

## Master invariants (additive BOTH sides)

- **hermes:** grill-seam + every existing tool/handler UNCHANGED. The new
  `stale-seam.ts` is additive; `index.ts` gains ONE publish line + ONE unpublish
  line. T1–T6 behavior untouched.
- **wayfind:** existing behavior UNCHANGED. The new `stale-seam.ts` is additive;
  nothing reads it yet (T8/T9 will). No existing wayfind file is modified.
- No cross-package IMPORT. The key literal + `StaleCard` shape are duplicated.

## RED → GREEN → regression gates

1. **RED** — both seam tests fail (`Cannot find module "./stale-seam.js"`).
2. **GREEN** — implement both `stale-seam.ts` + wire `index.ts`; both tests pass.
3. **Regression** — hermes `bun run check && bun test` (after-T6 1477/1/1 →
   after-T7: +new tests, same 1 known date-aging fail unchanged); wayfind
   `bun run check && bunx tsc --noEmit && bun test` (baseline → after: additive,
   existing suite green). Any OTHER failure → STOP, report.
