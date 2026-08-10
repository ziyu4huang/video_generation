# Task 4 Report — staleness computation module (10-impl T4 — Path B)

> The "what I actually did + evidence" record. Pairs with `task-4-brief.md`.
>
> Branch: `knowledge-pipeline/10-impl-staleness` (CONTINUED off `01073323`).
> Plan amendment commit: `291fed79` (doc-only). T4 code commit: see below.

## Blocker recap (why this was re-dispatched as Path B)

The first T4 attempt STOPPED on a structural blocker: the verbatim plan body
sourced a card's deps from `store.getCard(id).graph.relations`, but the 06a store
does NOT persist `card.graph` —

- `card.ts` (lines 28–29, 37, 42) documents `graph?` as *"part of the TYPE but
  NOT persisted/indexed in 06a … round-trips as `undefined`"* (deferred to ticket
  03 / 06b);
- `rowToCard` (card-store.ts, lines 93–112) builds the card from the `memories`
  row with NO `graph` field (the table has no graph column);
- so `getCard(id).graph?.relations ?? []` was always `[]` → `depAggregateHash`
  hashed `hashEntry("")` (a constant) → the baseline never changed → **staleness
  was a no-op.**

**Empirically confirmed** before any Path B change: the prior attempt's test
file produced 3 failing cases (changed-dep, missing-dep, getStaleCards) for
exactly this reason; the full suite was `1459 pass / 1 skip / 4 fail` (3
staleness + 1 known memworth time-bomb).

## Path B approach (decision η)

Source deps by re-parsing the **git-canonical source `.md`** via a new additive
`readSourceCard(store, cardId, fsRoot): Promise<Card | null>` — factored from
`refreshPlanningCard`'s pre-T4 resolve→read→deserialize→find body
(`sourcePathForId` → `readFileSync` utf8 → derive kind from id prefix →
`serializerFor(kind).deserialize(bytes, { filePath })` → `find(id)`). The
deserialized card DOES carry `graph.relations` (the planning serializer populates
`blocked-by`/`cites`/`depends_on`), so `depAggregateHash` now sees real deps.
Self-contained (no `memories` migration); aligns with the Tier-1 md-wins model;
first-class `card.graph` persistence deferred to ticket 03.

`refreshPlanningCard` was **refactored** to call `readSourceCard` (behavior-
preserving extract) — see "Refactor result" below.

## TDD evidence

- **RED** (the blocker): before Path B, `computeStaleness` read deps from
  `store.getCard().graph` (always `[]`) → 3 of 4 prior-attempt cases failed
  (`a changed dep -> stale`, `a missing dep -> stale + missing[]`, `getStaleCards …`).
  Full suite before any Path B change: `1459 pass / 1 skip / 4 fail`.
- **GREEN** (Path B): after switching `computeStaleness` to `readSourceCard` +
  adding `readSourceCard`/exporting `sourcePathForId`, the new
  `planning-staleness.test.ts` (5 cases) passes:
  ```
  src/store/planning-staleness.test.ts: 5 pass / 0 fail
  ```

## Full-suite counts

| stage            | pass | skip | fail | notes |
| ---------------- | ---- | ---- | ---- | ----- |
| after-T3 (stated baseline) | 1457 | 1 | 1   | dispatch-stated; the 1 fail = memworth date-aging time-bomb |
| after-T4 (Path B)          | 1462 | 1 | 1   | same 1 skip / 1 known-fail UNCHANGED |

Net delta after-T3 → after-T4: **+5 pass**, 0 change to skip/fail. The +5 are
the new Path B staleness cases. The single remaining fail is the unchanged
memworth date-aging time-bomb (`numeric isolation … formatForSystemPrompt never
emits memworth`), NOT a T4 regression.

## Refactor result — `refreshPlanningCard` → `readSourceCard`

**Refactored** (NOT inlined). `readSourceCard` was extracted verbatim from
`refreshPlanningCard`'s resolve→read→deserialize→find body (the only change to
that body is the return shape: `null` instead of `{ action: "absent" }`).
`refreshPlanningCard` now begins `const card = await readSourceCard(store, cardId, fsRoot); if (!card) return { action: "absent" };` and the downstream hash-compare
branch (inserted/updated/unchanged) is byte-identical.

Rationale: the extraction is a clean, behavior-preserving refactor (the five
`null`-return arms of `readSourceCard` map 1:1 to `refreshPlanningCard`'s five
`{action:"absent"}` arms), and it gives `computeStaleness` + `refreshPlanningCard`
ONE shared source-of-truth reader. **Master invariant verified:** all 4
`refreshPlanningCard (09-impl T7)` cases + the `08→09 migration cohort` case +
the 5 T3 dep-aggregate cases pass (19/19 in `planning-sync-state.test.ts`).

## The effort-of-id helper used for `StaleCard.effort`

`effortOfTicketCardId(cardId)` — the local helper in `planning-staleness.ts`
(kept from the prior attempt). Parses `planning-ticket:<effort>:<no>` → `<effort>`
via `lastIndexOf(":")` (robust to an effort slug that itself contains no `:`);
returns `null` for non-ticket ids. Used both to scope `getStaleCards` to one
effort and to populate `StaleCard.effort`.

## Self-review

- **Master invariant**: `refreshPlanningCard` behavior preserved (refactored,
  09-impl tests green); memory/user/failure/knowledge/planning cards not
  regressed (full suite delta is +5 staleness pass only).
- **Additive**: `readSourceCard` is new + exported; `sourcePathForId` changed
  only from private→exported (same body); `computeStaleness`/`getStaleCards` are
  new. No `memories`/`card_md_hash`/schema change; no 09 mirror/reconcile/hash-
  compare behavior change.
- **Path B contract**: deps from `readSourceCard` (source `.md`), NOT
  `store.getCard().graph`; unresolvable → `{stale:false}` + NO baseline; first
  touch seeds via `writeValidatedBaseline`; compare-only thereafter; missing dep
  surfaces `missing[]` + `missingDeps`.
- **`computeStaleness` first-touch seed**: calls `writeValidatedBaseline` (which
  recomputes `depAggregateHash`) rather than reusing the already-computed
  `current`. This is a harmless double-compute (deterministic, idempotent) and
  matches the dispatch's stated contract; the returned `missing` is the value
  computed before the seed (identical to what `writeValidatedBaseline` computes).

## Concerns / deferred

- **First-touch double-compute**: `computeStaleness` computes `depAggregateHash`
  once for `current`/`missing`, then `writeValidatedBaseline` recomputes it
  internally. Minor (first-touch path, not hot); left as-is to honor the stated
  contract + reuse `writeValidatedBaseline`'s write path. Could later pass the
  precomputed hash through if profiling warrants.
- **`readSourceCard` is async but does no `await`**: declared `async` to match
  the dispatch's `Promise<Card | null>` signature + the CardStore async envelope
  + future async-fs evolution. No correctness impact.
- **First-class `card.graph` persistence**: still DEFERRED to ticket 03. Path B
  re-parses the source `.md` on every `computeStaleness`/`getStaleCards` call —
  acceptable for the on-access cadence (γ), but a future graph-persisted store
  could cache the deserialized card.
