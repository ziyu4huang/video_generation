# Task 4 Brief — staleness computation module (10-impl T4 — Path B)

> The "what I agreed to build" record. Extracted from the plan's `### Task 4:`
> section, with the **Path B** amendment (decision η) recorded where the real
> source diverged from the verbatim plan body.
>
> Plan: `.planning/2026-08-08-knowledge-pipeline/plans/2026-08-10-staleness-dependency-graph.md` (Task 4 + decision η).
> Branch: `knowledge-pipeline/10-impl-staleness` (CONTINUED — NOT created/rebased/switched).
> Base SHA: `010733234b956adc5a9c9f8170a7e900060afa68` (the T1+T2+T3 tip, already on the branch).

## Why Path B (the structural blocker)

The verbatim T4 body sourced a card's deps from `store.getCard(id).graph.relations`.
That is a **no-op against the real store**: the 06a store does NOT persist
`card.graph` —

- `card.ts` (lines 28–29) documents `graph?` as *"part of the TYPE but NOT
  persisted/indexed in 06a … round-trips as `undefined`"*;
- `rowToCard` (card-store.ts) emits a card with NO `graph` field (the `memories`
  table has no graph column); `upsertCard`/`getCard` therefore never round-trip it.

So `getCard(id).graph?.relations ?? []` was always `[]` → `depAggregateHash` hashed
the empty string → the stored baseline never changed → staleness could NEVER fire.
(The prior T4 attempt confirmed this empirically: 3 of its 4 test cases failed
because deps were `[]`.) First-class `card.graph` persistence is the graph layer
(ticket 03 / 06b) — unbuilt, DEFERRED.

**Decision η — Path B:** source deps by re-parsing the **git-canonical source
`.md`** (Tier-1 md-wins), exactly as `refreshPlanningCard` already does. The
deserialized source card (via the planning serializer) DOES carry
`graph.relations` (`blocked-by`/`cites`/`depends_on`). This is self-contained (no
`memories` migration) and aligns with the md-wins model.

## Scope

T4 = the **staleness dependency-graph compute layer**, sitting on T2's
`card_dep_hash` baseline + T3's `depAggregateHash`. TWO entry points in a new
`planning-staleness.ts`, plus an additive `readSourceCard` helper extracted into
`planning-sync-state.ts`:

- `computeStaleness(store, cardId, fsRoot)` — READ-side: deps from `readSourceCard`
  (NOT `store.getCard`); seed the baseline on first touch; else COMPARE-ONLY.
- `getStaleCards(store, effort?, fsRoot)` — enumerate stale planning-tickets.

## Files

- **Modify:** `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.ts` — (a) **export** `sourcePathForId` (`function` → `export function`; previously module-private); (b) **add** additive `readSourceCard(store, cardId, fsRoot): Promise<Card | null>`; (c) **refactor** `refreshPlanningCard` to call `readSourceCard` (behavior-preserving extract — its 09-impl tests gate the refactor). Existing exports unchanged in behavior.
- **Create:** `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-staleness.ts` — `StaleCard` + `computeStaleness` + `getStaleCards`.
- **Create:** `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-staleness.test.ts` — Path B tests (real source `.md` under a temp fsRoot).

## Interfaces

- **Consumes:** `CardStore` (incl. T2 `getCardDepHash`/`upsertCardDepHash` + `getCardsByKind` + `serializerFor`); `depAggregateHash` + `writeValidatedBaseline` + the new `readSourceCard` from `./planning-sync-state.js`; `Card` from `./card.js`.
- **Produces:**
  - `readSourceCard(store: CardStore, cardId: string, fsRoot: string): Promise<Card | null>` (in planning-sync-state.ts) — resolve the source path via `sourcePathForId`; `readFileSync` utf8 (absent → null); derive `kind` from the id prefix; `store.serializerFor(kind).deserialize(bytes, { filePath: src })`; `find(c => c.id === cardId)` (none → null). The returned card HAS `graph.relations`. Mirrors `refreshPlanningCard`'s pre-T4 resolve→read→deserialize→find body.
  - `StaleCard` (exported) = `{ cardId: string; effort: string; missingDeps?: string[] }` (duplicated across the seam — ADR-0004).
  - `computeStaleness(store, cardId, fsRoot): Promise<{ stale: boolean; missing: string[] }>` — `const card = await readSourceCard(store, cardId, fsRoot)`; unresolvable → `{ stale: false, missing: [] }` (can't validate → not stale; NO baseline written); `depAggregateHash(card, fsRoot)`; `getCardDepHash(cardId)`; FIRST touch (`stored === null`) → `writeValidatedBaseline(store, card, fsRoot)` + return `{ stale: false, missing }`; else `stale = current.hash !== stored.depHash || missing.length > 0` (NO write — a stale card stays flagged until the explicit T5 `refreshStaleness`).
  - `getStaleCards(store, effort?, fsRoot): Promise<StaleCard[]>` — `getCardsByKind("planning-ticket")` (enumeration — card ids only, the store row needs NO graph; deps come from `readSourceCard`); optional `effort` filter via `effortOfTicketCardId` (`planning-ticket:<effort>:<no>` → `<effort>`); `computeStaleness` each; map stale → `StaleCard` (with `missingDeps` only when `missing.length > 0`).

## Test setup (Path B — mirrors `refreshPlanningCard`'s 09-impl test)

Each `it` uses FRESH temp dirs (`root` + `mem`) + cleanup (no cross-test state). A
helper `seedSource(root, effort, citesPath, depPath)` writes a real
`.planning/<effort>/tickets/01-dep-ticket.md` that cites `citesPath` in the body
(`extractCitedPaths`) + declares `depends_on: <depPath>` in frontmatter
(`parseDependsOn`), plus writes BOTH dep files (`v1`). `ticketCard()` therefore
emits a `cites` + a `depends_on` relation → `citedDeps = [citesPath, depPath]`.

- `computeStaleness` reads deps via `readSourceCard` (NOT the store row), so its
  cases need NO store row.
- `getStaleCards` enumerates via `store.getCardsByKind`, so a card is
  `store.upsertCard`'d for that case only (id/kind; the row needs NO graph).

### Cases

1. unresolvable cardId (no source `.md`) → `{ stale: false, missing: [] }` + NO baseline (`getCardDepHash` null).
2. first touch → `{ stale: false }` AND seeds `card_dep_hash` (`getCardDepHash` non-null); second call w/ deps UNCHANGED → `{ stale: false }`.
3. a cited dep file CHANGED (`src/a.ts` → `v2`) → `{ stale: true }`; second call STILL stale (compare-only, NO rebaseline).
4. a `depends_on` dep file MISSING (`rm src/b.ts`) → `{ stale: true, missing: ["src/b.ts"] }`.
5. `getStaleCards`: two efforts w/ OWN dep files; clean-eff → `[]`; drift stale-eff's cited dep → only stale-eff surfaced `{ cardId, effort }` (no `missingDeps` for an edit); effort filter scopes; vanish a dep → `missingDeps` populated.

## DoD (Path B)

Deps sourced from `readSourceCard` (re-parse of source `.md`), NOT
`store.getCard().graph`; unresolvable source → `{ stale: false }` + NO baseline;
first touch seeds baseline (`writeValidatedBaseline`) → `{ stale: false }`;
second unchanged call → `{ stale: false }`; a cited dep changed → `{ stale: true }`
(compare-only, no rebaseline); a `depends_on` dep missing → `{ stale: true, missing: [path] }`;
`getStaleCards` surfaces only stale tickets w/ effort + `missingDeps`, effort
filter scopes, clean effort → `[]`; `refreshPlanningCard` behavior preserved (its
09-impl tests green); full suite green (only the known date-aging time-bomb fail unchanged).
