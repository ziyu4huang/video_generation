# Task 5 Brief — on-access refresh + background-sweep hooks (10-impl T5)

> The "what I agreed to build" record. Extracted from the plan's `### Task 5:`
> section, with the **ζ sweep-vs-revalidate** decision and the **pre-implementation
> adjustment** (task-spec CONTRACT supersedes the plan's literal T5 body) recorded
> where they diverge.
>
> Plan: `.planning/2026-08-08-knowledge-pipeline/plans/2026-08-10-staleness-dependency-graph.md` (Task 5 + decision ζ).
> Branch: `knowledge-pipeline/10-impl-staleness` (CONTINUED — NOT created/rebased/switched).
> Base SHA: `d17b9dd51088eb90f87c86cfe907547071011269` (the T1+T2+T3+η+T4 tip, already on the branch).

## Scope

T5 wires the T4 staleness compute layer into the runtime. Two additive
deliverables, plus their tests:

1. **`refreshStaleness(store, cardId, fsRoot): Promise<boolean>`** — the SOLE
   re-baseline primitive (in `planning-sync-state.ts`, mirroring `refreshIfStale`'s
   boolean envelope). Recomputes the dep aggregate, reports whether it **had**
   drifted relative to the OLD baseline, AND re-baselines to the CURRENT bytes
   (clearing the stale flag). This is the explicit re-validate op the agent re-grill
   flow (T6's `planning_stale` tool `revalidate` action) will call; the sweep does
   NOT call it.
2. **A staleness sweep folded INTO `schedulePlanningBackfill`'s deferred block** —
   compare-only (calls `computeStaleness` per planning-ticket). SEEDS the dep
   baseline on first touch + FLAGS stale thereafter; it MUST NOT re-baseline (so a
   stale card's state is never wiped on every `session_start`).

## Decision ζ — sweep = compare-only; `refreshStaleness` = sole rebaseline (pinned)

The sweep FLAGS via `computeStaleness` (compare-only after the first-touch seed),
so stale state **persists** across sessions. It does NOT call `refreshStaleness`:
a sweep that re-baselined every card on each `session_start` would wipe stale
state, contradicting γ (staleness survives until an explicit re-validate). The
sweep's observable WRITE is **seeding** dep baselines for newly-mirrored cards
(fixing "validated as of session start" snapshots so a dep change DURING the
session is detectable at graduation). `refreshStaleness` is the explicit
re-validate op (agent re-grill flow) — the only place a baseline is re-written to
clear a stale flag.

## Pre-implementation adjustment — task-spec CONTRACT supersedes the plan's literal T5 body

The plan's verbatim T5 `refreshStaleness` body used:

```ts
const card = await store.getCard(cardId);          // ❌ drops graph
…
await store.upsertCardDepHash(cardId, current);    // raw upsert
return { stale, missing };                          // richer return
```

That body is a **latent bug** post-η: `store.getCard` returns the `memories` row
**without** `graph` (the 06a store does NOT persist `card.graph` — card.ts:28-29;
`rowToCard` emits no `graph` field; see the T4 brief's "Why Path B"). So
`depAggregateHash(card, …)` would read `card.graph?.relations ?? []` → `[]` → hash
`hashEntry("")` (a constant) → the baseline would never reflect any real dep →
staleness could never fire on re-validate. The plan's T5 code block predates the η
amendment that routed the READ side (`computeStaleness`) through `readSourceCard`.

The **task-spec CONTRACT** already encodes the η correction. It is adopted
verbatim:

```ts
const card = await readSourceCard(store, cardId, fsRoot);   // Path B — graph present
if (!card) return false;
const { hash: current, missing } = await depAggregateHash(card, fsRoot);
const stored = await store.getCardDepHash(cardId);
const wasStale = stored !== null && (current !== stored.depHash || missing.length > 0);
await writeValidatedBaseline(store, card, fsRoot);           // named re-baseline op
return wasStale;                                             // boolean (mirrors refreshIfStale)
```

Two concrete divergences from the plan's literal body, both driven by η + the
task-spec CONTRACT:

- **Card source**: `readSourceCard` (Path B) instead of `store.getCard`. Without
  this, re-validate hashes the empty aggregate and never clears a real stale flag.
- **Return type**: `Promise<boolean>` (mirrors the sibling `refreshIfStale`), not
  `Promise<{ stale, missing }>`. The sweep already surfaces `missing` via
  `computeStaleness`/`getStaleCards`; the re-validate op's job is "clear the flag
  + report whether it HAD drifted" — a boolean suffices, and T6 is not yet built.

The tests are written to the boolean-return CONTRACT (not the plan's `r.stale`/
`r.missing` assertions).

## Sweep home — folded INTO `schedulePlanningBackfill` (chosen over a sibling)

Chosen: fold the sweep into `schedulePlanningBackfill`'s deferred block (the
plan's Step 4 prescription), placed AFTER `await walkAndIngest(…)` and BEFORE the
success notify. One-line rationale: the sweep must run AFTER the mirror seeds the
ticket rows (else `getCardsByKind("planning-ticket")` returns nothing on a fresh
store), so coupling it to the backfill's deferred block is the natural sequencing;
it also keeps a SINGLE `session_start` hook (the existing `pi.on("session_start")`
already calls `schedulePlanningBackfill(ctx.cwd, globalDir, …)` — `src/index.ts:356`)
so **zero `index.ts` change** is needed, and it matches the plan's sweep test
verbatim (which calls `schedulePlanningBackfill` twice and asserts the 2nd flags
stale).

A sibling `scheduleStalenessSweep` would have needed its own state +
`waitForStalenessSweep` + new `session_start` wiring in `src/index.ts`, and would
have forced a rewrite of the plan's sweep test. Fold-in is strictly simpler given
the sweep's hard sequencing dependency on the mirror.

The folded sweep is **best-effort** (a `try`/`catch` so a staleness failure NEVER
breaks the mirror/backfill), opens its own short-lived `CardStore` over
`memoryDir`, iterates `getCardsByKind("planning-ticket")`, and calls
`computeStaleness(store, t.id, repoRoot)` per card (one bad card does not abort the
sweep — inner `try`/`catch`). No `MAX_FILES` bound (planning-ticket card count is
small; the backfill's own `collectPlanningMdFiles` bound already gates the mirror).

## Files

- **Modify:** `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.ts` — add additive `refreshStaleness` (η-correct: `readSourceCard` + `writeValidatedBaseline`, boolean return). Existing exports unchanged in behavior.
- **Modify:** `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.test.ts` — append a `refreshStaleness` describe (boolean assertions); add `refreshStaleness` to the existing `./planning-sync-state.js` import + a new `computeStaleness` import from `./planning-staleness.js`.
- **Modify:** `bun-apps/pi-agent-ext-hermes-memory/src/handlers/planning-backfill.ts` — add the compare-only staleness pass inside `schedulePlanningBackfill`'s deferred block (after `walkAndIngest`, before the success notify); add `createCardStore` + `computeStaleness` imports.
- **Modify:** `bun-apps/pi-agent-ext-hermes-memory/src/handlers/planning-backfill.test.ts` — append sweep tests; add a `getStaleCards` import from `../store/planning-staleness.js`.

`src/index.ts` is NOT touched (the fold-in reuses the existing `session_start` hook).

## Interfaces

- **Consumes:** `CardStore` (`getCardDepHash`, `getCardsByKind`); `readSourceCard` + `depAggregateHash` + `writeValidatedBaseline` (T3/T4, planning-sync-state.ts); `computeStaleness` + `getStaleCards` (T4, planning-staleness.ts); `createCardStore` (card-store.ts); `walkAndIngest` (walk-and-ingest.ts).
- **Produces:**
  - `refreshStaleness(store: CardStore, cardId: string, fsRoot: string): Promise<boolean>` — `readSourceCard` (unresolvable → `false`, NO write); `depAggregateHash`; `getCardDepHash`; `wasStale = stored !== null && (current !== stored.depHash || missing.length > 0)`; `writeValidatedBaseline` (re-baseline to current); return `wasStale`. The SOLE re-baseline op.
  - the `schedulePlanningBackfill` deferred block gains a compare-only staleness pass: open a short-lived store; `getCardsByKind("planning-ticket")`; `computeStaleness` each (seeds on first touch, flags thereafter — NO `writeValidatedBaseline`/`refreshStaleness`).

## Test setup

### `refreshStaleness` (planning-sync-state.test.ts)

Mirrors the T3 dep-aggregate + T4 `readSourceCard` discipline: fresh temp dirs per
case, a real source `.md` under `<root>/.planning/<effort>/tickets/01-…md` with
`depends_on: src/d.ts` in frontmatter (so the deserialized card carries the
relation), and a real `src/d.ts` dep file. Cases:

1. **stale card (changed dep since baseline)** → `refreshStaleness` returns
   `true` AND a subsequent `computeStaleness` is `stale:false` (re-validate cleared
   the flag against current bytes).
2. **non-stale card (baseline already current)** → `refreshStaleness` returns
   `false`; the `card_dep_hash` row's `depHash` value is unchanged.
3. **unresolvable source (no source `.md`)** → `refreshStaleness` returns `false`
   + NO `card_dep_hash` row written (`getCardDepHash` null).

### staleness sweep (planning-backfill.test.ts)

Mirrors the existing "re-mirrors a changed planning md" shape (injected inline
`flush` `setTimeout` + `flushedState()`). Cases:

1. **sweep flags stale after a dep change** — 1st `schedulePlanningBackfill`
   mirrors the ticket + seeds the dep baseline @ v1; change `src/dep.ts` → `v2`;
   2nd `schedulePlanningBackfill` → `getStaleCards` now lists the card (the sweep
   flagged stale, NOT re-baselined — else it would be clean). This proves
   compare-only.
2. **no planning cards → sweep is a no-op (no throw)** — `schedulePlanningBackfill`
   on a root with no `.planning/` resolves cleanly (the backfill's empty-files early
   return + the sweep's empty `getCardsByKind` are both safe).

## DoD

`refreshStaleness` reports drift + re-baselines (clearing the flag; a subsequent
`computeStaleness` is clean); the folded `session_start` sweep seeds baselines for
newly-mirrored cards + flags a card stale after its dep changes (NO rebaseline — a
stale card STAYS stale across sweeps); the sweep is a no-op on an empty
planning-ticket set; existing `refreshIfStale`/`refreshPlanningCard`/
`schedulePlanningBackfill` behavior preserved (their 09-impl tests gate the
fold-in); full suite green (only the known date-aging time-bomb fail unchanged).
