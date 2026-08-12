# Task 3 Report — dep aggregate hash + validated-baseline writer (10-impl T3)

TDD audit-trail artifact. Mirrors the T1/T2 `task-{1,2}-report.md` shape.

- **Branch:** `knowledge-pipeline/10-impl-staleness` (CONTINUED — not created/rebased/switched)
- **Base SHA (before T3):** `717f92d07cf3065548052b9236eedf3d33669221` (the T2 commit, already on the branch)
- **Commit:** `feat(knowledge-pipeline): dep-aggregate hash + validated baseline writer (10-impl T3)` — SHA recorded in REPORT BACK summary (not self-referentially here).
- **Plan:** `.planning/2026-08-08-knowledge-pipeline/plans/2026-08-10-staleness-dependency-graph.md` § Task 3.
- **Brief:** `.planning/2026-08-08-knowledge-pipeline/sdd/2026-08-10-staleness-dependency-graph/task-3-brief.md`.

## What was implemented

The **dep-aggregate-hash computation layer** that sits on T2's `card_dep_hash`
storage. THREE new additive exports in `planning-sync-state.ts`:

1. **`citedDeps(card: Card): string[]`** — distinct repo-relative dep paths from
   `card.graph?.relations` where `rel ∈ {"cites","depends_on"}`. First-occurrence
   dedupe → stable order (matches the plan's concrete test
   `["src/a.ts","docs/b.md","src/c.ts"]`).
2. **`depAggregateHash(card, fsRoot): Promise<{ hash; missing }>`** — for each
   dep, `readFileSync(join(fsRoot, path), "utf8")` → `hashEntry`; absent → pushed
   to `missing[]` AND contributes the token `"<missing>"`. Aggregate =
   `hashEntry(sorted("${path}:${hashOrToken}").join("\n"))`. A no-deps card →
   `hashEntry("")` (stable → never dep-stale). Bare `catch` → ALL read errors
   (not just ENOENT) treated as missing.
3. **`writeValidatedBaseline(store, card, fsRoot): Promise<{ hash; missing }>`**
   — `depAggregateHash` → `store.upsertCardDepHash(card.id, hash)`; returns
   `{ hash, missing }`.

This is the layer T4 (staleness compute) reads from to decide stale-or-not.
Mirrors 09's `planningContentHash` (reuses `hashEntry`: sha256 → 16 hex) but
hashes the bytes of the files a card's decision DEPENDS ON — distinct from 09's
`card_md_hash`, which hashes the CARD's own bytes.

## Files changed (2 src + 2 SDD, +146 / −0 in src, purely additive)

```
 .../src/store/planning-sync-state.ts               | 66 ++++++++++++++++++
 .../src/store/planning-sync-state.test.ts          | 80 ++++++++++++++++++++++
 2 files changed, 146 insertions(+)
```
Plus SDD workspace (this brief + this report) under `.planning/2026-08-08-knowledge-pipeline/sdd/2026-08-10-staleness-dependency-graph/`.

### Impl hunks

`planning-sync-state.ts` (+66) — appended after `refreshIfStale`, NO edits above the append line. All existing imports reused (`readFileSync`, `join`, `hashEntry`, `Card`, `CardStore`):

```ts
// ─── 10-impl staleness: dep aggregate hash + validated baseline ─────────────
//
// The staleness baseline is ONE aggregate row per card in card_dep_hash =
// hashEntry(sorted(cited+depends_on source-file bytes)). Distinct from 09's
// card_md_hash (which hashes the CARD's own bytes); this hashes the bytes of
// the files the card's decision DEPENDS ON, so a change to a cited/declared
// source file flips the card stale even when the card's own md is unchanged.

/** Distinct repo-relative dep paths carried by a card's graph.relations
 *  (rel ∈ {"cites","depends_on"}). First-occurrence dedupe → stable order. */
export function citedDeps(card: Card): string[] {
  const rels = card.graph?.relations ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rels) {
    if ((r.rel === "cites" || r.rel === "depends_on") && !seen.has(r.o)) {
      seen.add(r.o);
      out.push(r.o);
    }
  }
  return out;
}

/** Aggregate content-hash of a card's deps under fsRoot. For each dep path,
 *  read join(fsRoot, path): present → hashEntry(bytes); absent → recorded in
 *  `missing` AND contributes the token "<missing>" (so a file reappearing or
 *  vanishing changes the aggregate). Aggregate = hashEntry of the sorted
 *  `${path}:${hashOrToken}` entries joined by "\n" — deterministic over the
 *  dep SET regardless of relation order. A card with NO deps hashes the empty
 *  string (stable → never stale by dep-change, which is correct: nothing to
 *  depend on). */
export async function depAggregateHash(
  card: Card,
  fsRoot: string,
): Promise<{ hash: string; missing: string[] }> {
  const deps = citedDeps(card);
  const missing: string[] = [];
  const entries = deps.map((path) => {
    let fileHash: string;
    try {
      fileHash = hashEntry(readFileSync(join(fsRoot, path), "utf8"));
    } catch {
      missing.push(path);
      fileHash = "<missing>";
    }
    return `${path}:${fileHash}`;
  });
  entries.sort();
  return { hash: hashEntry(entries.join("\n")), missing };
}

/** Compute the dep aggregate + UPSERT it as the card's validated baseline
 *  (the staleness reference). This is the RE-VALIDATE write — call it when an
 *  agent re-grills + re-validates a decision (clears stale). The on-access
 *  computeStaleness (T4) uses depAggregateHash WITHOUT writing except the
 *  first-touch seed. */
export async function writeValidatedBaseline(
  store: CardStore,
  card: Card,
  fsRoot: string,
): Promise<{ hash: string; missing: string[] }> {
  const { hash, missing } = await depAggregateHash(card, fsRoot);
  await store.upsertCardDepHash(card.id, hash);
  return { hash, missing };
}
```

`planning-sync-state.test.ts` (+80) — 3 new symbols added to the existing `./planning-sync-state.js` import block; a new `describe("dep aggregate hash (10-impl T3)", …)` block appended at EOF, mirroring the file's existing temp-`fsRoot` setup (`mkdtempSync` + `mkdirSync`/`writeFileSync`/`rmSync`). 5 cases:
- `citedDeps` distinct cites+depends_on first-occurrence order; blocked-by excluded; dup collapses.
- `depAggregateHash` deterministic (same deps+contents → same hash); 16 hex; `missing` empty.
- a changed dep file → different aggregate.
- a missing dep → `missing` non-empty AND aggregate changes (vs file present) via the `<missing>` token.
- `writeValidatedBaseline` writes via `upsertCardDepHash`; `getCardDepHash(card.id)` returns `{ depHash: <aggregate>, validatedAt }`.

## TDD evidence

- **RED** (`bun test src/store/planning-sync-state.test.ts`, before impl):
  `SyntaxError: Export named 'citedDeps' not found in module '.../planning-sync-state.ts'.` → `0 pass / 1 fail / 1 error`. Failed for the RIGHT reason (symbols not yet exported), exactly as the plan predicted.
- **GREEN** (same command, after impl): `19 pass / 0 fail` — 5 new T3 cases pass + the 14 pre-existing content-hash / `card_md_hash` round-trip / `refreshPlanningCard` cases still green (additive).

## Full-package regression (master invariant)

`bun run check` (tsc --noEmit): **clean** (no diagnostics).

`bun test` (full suite):

| | pass | skip | fail |
|---|---|---|---|
| after-T2 (baseline) | 1452 | 1 | 1 |
| **after-T3** | **1457** | **1** | **1** |
| **net delta** | **+5** | 0 | 0 |

- **+5 pass** = the 5 new T3 cases.
- The **1 skip** (`md_id schema > SQLite: md_id is unique among non-NULL values`) and the **1 fail** (`numeric isolation — assembled prompt never leaks memworth … formatForSystemPrompt never emits memworth …`) are BOTH unchanged from the T2 baseline — the known date-aging time-bomb, unrelated to T3 (planning-sync-state / card_dep_hash).
- No non-T3 test broke. 1048 `expect()` calls (unchanged from T2 — the new T3 cases use `node:assert`, not `expect`).

## Self-review (additivity)

- **Existing `planning-sync-state.ts` exports UNCHANGED:** `planningContentHash`, `getStoredHash`, `upsertHash`, `deleteHash`, `refreshPlanningCard`, `refreshIfStale`, and the `RefreshAction` type + private `sortKeysDeep`/`canonicalCardBytes`/`sourcePathForId` helpers are byte-identical. The diff is a pure append after `refreshIfStale` (no edits above the `@@ -177,3 +177,69 @@` hunk's context line). Verified by `git diff --stat`: `…/planning-sync-state.ts | 66 +++++` (all insertions, 0 deletions).
- **No new imports** in `planning-sync-state.ts` — `readFileSync`/`readdirSync`, `join`, `hashEntry`, `Card`, `CardStore` were already imported at the top.
- **T2 `card_dep_hash` accessors consumed, not modified:** `depAggregateHash` writes via `store.upsertCardDepHash(card.id, hash)` (T2's 2-arg signature); the test reads back via `store.getCardDepHash(card.id)` and asserts `{ depHash, validatedAt }`. `validatedAt = today()` is set inside T2's upsert — T3 does not pass a timestamp.
- **Aggregate byte-form** (canonical, deterministic): `hashEntry(citedDeps(card).map(p => "${p}:${ readFileSync(join(fsRoot,p),"utf8") ok ? hashEntry(bytes) : "<missing>" }").sort().join("\n"))`. `hashEntry = sha256(s,"utf8").hex().slice(0,16)` (verified in `merge-plan.ts`). No-deps → `hashEntry("")`.

## Deviations from the plan's T3 code

None in the IMPLEMENTATION — it is byte-identical to the plan's §Task 3 Step 3
block. One deviation from the brief's CONTRACT prose, resolved in favour of the
plan's concrete tests (recorded in `task-3-brief.md` adjustment A):

- **`citedDeps` order = first-occurrence, NOT sorted.** The brief's prose said
  "preserve a stable order (sort)"; the plan's concrete test asserts
  `["src/a.ts","docs/b.md","src/c.ts"]` (sorted would be `["docs/b.md",…]`).
  Followed the plan's test: first-occurrence dedupe. Aggregate determinism is
  provided SEPARATELY by `entries.sort()` inside `depAggregateHash`, so BOTH the
  brief's determinism intent AND the plan's `citedDeps` ordering hold.
- **File-read error handling:** the plan's bare `catch {` (no ENOENT guard) is
  BROADER than the brief's "ENOENT → missing; other errors also missing" — it
  treats EVERY read failure (permission, EISDIR, …) as missing and contributes
  `"<missing>"`, never throws. Confirmed correct for staleness (an unreadable
  dep is indistinguishable from an absent one).
- **"File bytes" vs utf8 string:** `hashEntry` takes a `string` and hashes its
  utf8 bytes (`createHash("sha256").update(encoded, "utf8")`), so deps are read
  as `readFileSync(path, "utf8")` and passed straight to `hashEntry`. The
  brief's "file bytes" is loose; the effective byte-form is the utf8 string
  content. Consistent with `planningContentHash` (also hashes a canonical
  string). No deviation from the plan.

## Concerns

None. The implementation is a pure append; full suite is green except the
pre-existing unrelated time-bomb; the one brief-vs-plan tension is resolved in
favour of the plan's concrete tests and documented in the brief.
