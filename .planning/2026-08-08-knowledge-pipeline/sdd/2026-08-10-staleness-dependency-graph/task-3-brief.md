# Task 3 Brief — dep aggregate hash + validated-baseline writer (10-impl T3)

> The "what I agreed to build" record. Extracted from the plan's `### Task 3:`
> section, with pre-implementation adjustments recorded where the real source
> diverged from (or confirmed) the plan.
>
> Plan: `.planning/2026-08-08-knowledge-pipeline/plans/2026-08-10-staleness-dependency-graph.md` (Task 3).
> Branch: `knowledge-pipeline/10-impl-staleness` (CONTINUED — NOT created/rebased/switched).
> Base SHA: `717f92d07cf3065548052b9236eedf3d33669221` (the T2 commit, already on the branch).

## Scope

T3 = the **dep-aggregate-hash computation layer** that sits on T2's `card_dep_hash`
storage. THREE new additive exports in `planning-sync-state.ts`:

- `citedDeps(card)` — collect the card's dep source-file paths from its
  `graph.relations`.
- `depAggregateHash(card, fsRoot)` — hash each dep's current file bytes; flag
  missing deps.
- `writeValidatedBaseline(store, card, fsRoot)` — compute the aggregate + write
  it as the `card_dep_hash` baseline (the staleness reference).

This is the layer T4 (staleness compute) reads from to decide stale-or-not. It
mirrors 09's `planningContentHash` shape (reuses `hashEntry`: sha256 → 16 hex)
but hashes the bytes of the files a card's decision DEPENDS ON — distinct from
09's `card_md_hash`, which hashes the CARD's own bytes.

## Files

- **Modify:** `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.ts` — append `citedDeps` + `depAggregateHash` + `writeValidatedBaseline`. Additive only: existing exports (`planningContentHash`, `getStoredHash`, `upsertHash`, `deleteHash`, `refreshPlanningCard`, `refreshIfStale`) UNCHANGED.
- **Modify:** `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-sync-state.test.ts` — append a `describe("dep aggregate hash (10-impl T3)", ...)` block mirroring the file's existing temp-`fsRoot` setup.

## Interfaces

- **Consumes:** `Card` (+ `CardGraph.relations?: Array<{ s, rel, o }>`) from `./card.js`; `hashEntry` from `./merge-plan.js` (already imported); `readFileSync` + `join` (already imported); the T2 `CardStore.upsertCardDepHash` / `CardStore.getCardDepHash`.
- **Produces:**
  - `citedDeps(card: Card): string[]` — distinct repo-relative dep paths from `card.graph.relations` where `rel ∈ {"cites","depends_on"}`. First-occurrence dedupe → stable order (matches the plan's concrete test `["src/a.ts","docs/b.md","src/c.ts"]`; aggregate determinism is provided separately by the internal `entries.sort()` below).
  - `depAggregateHash(card: Card, fsRoot: string): Promise<{ hash: string; missing: string[] }>` — for each dep path: resolve `join(fsRoot, path)`; present → `hashEntry(readFileSync(path, "utf8"))`; absent → pushed to `missing[]` AND contributes the token `"<missing>"`. Aggregate = `hashEntry(sorted("${path}:${hashOrToken}").join("\n"))` (deterministic over the dep SET regardless of relation order). A card with NO deps → `hashEntry("")` (stable → never dep-stale; correct: nothing to depend on).
  - `writeValidatedBaseline(store: CardStore, card: Card, fsRoot: string): Promise<{ hash: string; missing: string[] }>` — `const { hash, missing } = await depAggregateHash(card, fsRoot); await store.upsertCardDepHash(card.id, hash); return { hash, missing };`

### Aggregate byte-form (canonical)

```
hashEntry(
  citedDeps(card)
    .map(path => `${path}:${ readFileSync(join(fsRoot,path),"utf8") succeeds
                       ? hashEntry(fileBytes)
                       : "<missing>" }`)
    .sort()
    .join("\n")
)
```

- `hashEntry(s) = sha256(s, "utf8").hex().slice(0,16)` (verified in `merge-plan.ts`).
- Empty dep set → `hashEntry("")` (a fixed 16-hex value); `missing = []`.

## Steps (TDD)

1. **RED — write failing tests first.** Append a describe block to `planning-sync-state.test.ts` (reuse the file's already-imported `mkdirSync`/`mkdtempSync`/`rmSync`/`writeFileSync`/`join`/`tmpdir`/`assert`/`createCardStore`/`Card`; add the three new symbols to the existing `./planning-sync-state.js` import block):
   - `citedDeps` returns distinct cites + depends_on (first-occurrence order); blocked-by excluded; a path cited twice dedupes.
   - `depAggregateHash` is deterministic (same deps + same contents → same hash, regardless of relation order); hash is 16 hex; `missing` empty when all present.
   - a changed dep file → different aggregate.
   - a missing dep → `missing` non-empty AND the aggregate changes (vs the file present) because of the `<missing>` token.
   - `writeValidatedBaseline` writes via `upsertCardDepHash`; `getCardDepHash(card.id)` returns `{ depHash: <aggregate>, validatedAt: <today> }`.
2. Run tests → FAIL (`citedDeps` / `depAggregateHash` / `writeValidatedBaseline` not exported).
3. **GREEN — impl.** Append the three functions to `planning-sync-state.ts`.
4. Run tests → PASS (new aggregate tests + existing content-hash/refresh tests still green — additive).
5. Full-package `bun run check` + `bun test` → green. Expected after-T3 = after-T2 baseline (1452 pass / 1 skip / 1 fail) + (new T3 tests) pass, same 1 skip / 1 known-fail (memworth leak — date-aging time-bomb, unrelated) UNCHANGED.

## DoD

`citedDeps` dedupes cites + depends_on; `depAggregateHash` is deterministic, changes on a dep edit, and reflects `<missing>` for absent deps; `writeValidatedBaseline` writes via `upsertCardDepHash`; full suite green; existing planning-sync-state exports byte-identical.

---

## Pre-implementation adjustments (after reading the real source)

**A — `citedDeps` order: first-occurrence (per the plan's concrete test), NOT sorted.**
The brief's CONTRACT prose says "preserve a stable order (sort) so the
aggregate is deterministic", but the plan's concrete `citedDeps` test asserts
first-occurrence order: `assert.deepEqual(citedDeps(mkCard()), ["src/a.ts", "docs/b.md", "src/c.ts"])`
(sorted would be `["docs/b.md", ...]`). The plan provides the concrete code +
tests and is authoritative, so `citedDeps` uses first-occurrence dedupe.
Aggregate determinism is provided SEPARATELY by `entries.sort()` inside
`depAggregateHash`, so both properties hold. This is the one deviation from the
brief's prose; it follows the plan's tests exactly.

**B — `hashEntry` takes a `string`, not raw bytes.** Verified
`hashEntry(encoded: string): EntryHash` in `merge-plan.ts` — it does
`createHash("sha256").update(encoded, "utf8")`. So deps are read as utf8
strings (`readFileSync(path, "utf8")`) and passed straight to `hashEntry`. The
brief's "file bytes" is loose; the effective byte-form is the utf8-encoded
string content (consistent with `planningContentHash`, which also hashes a
canonical string). No deviation from the plan — recorded for traceability.

**C — File-read errors (beyond ENOENT) → treated as missing.** The plan uses a
bare `catch {` (no ENOENT guard) around `readFileSync`. This is BROADER than
the brief's "ENOENT → missing; other errors also missing" — every read failure
(permission, EISDIR, …) records the dep in `missing[]` and contributes
`"<missing>"`, never throws. Confirmed correct: a dep that can't be read is, for
staleness purposes, indistinguishable from an absent dep.

**D — All imports already present in both files.** `readFileSync`, `join`,
`hashEntry`, `Card`, `CardStore` are imported in `planning-sync-state.ts`; the
test file already imports `mkdirSync`/`mkdtempSync`/`rmSync`/`writeFileSync`/
`join`/`tmpdir`/`assert`/`createCardStore`/`Card`. The only import edit is
adding the three new symbols to the test's `./planning-sync-state.js` block.

**E — `CardStore.upsertCardDepHash` / `getCardDepHash` signatures confirmed (T2).**
`upsertCardDepHash(cardId: string, depHash: string): Promise<void>` and
`getCardDepHash(cardId): Promise<{ depHash: string; validatedAt: string } | null>`.
`validatedAt = today()` is set inside the upsert (T2 impl), so
`writeValidatedBaseline` does NOT pass a timestamp. Matches the plan.

---

## Contract decision (α — pinned)

Aggregate dep-hash is ONE row per card in the T2 `card_dep_hash` table (kind-less,
`card_id` PRIMARY KEY), NOT a `kind='validated'` row in 09's `card_md_hash` —
that table's `card_id` is the SOLE PRIMARY KEY (verified in `src/store/sqlite/schema.ts`),
so a second row for the same card would collide. T2 created the additive table;
T3 writes to it via `store.upsertCardDepHash`.
