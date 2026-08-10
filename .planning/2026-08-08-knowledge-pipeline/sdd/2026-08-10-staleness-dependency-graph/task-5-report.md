# Task 5 Report — on-access refresh + background-sweep hooks (10-impl T5)

> The "what I actually did + evidence" record. Pairs with `task-5-brief.md`.
>
> Branch: `knowledge-pipeline/10-impl-staleness` (CONTINUED off `d17b9dd5`).
> Commit: see "Commit" below.

## What was implemented

Two additive deliverables wiring the T4 staleness compute layer into the runtime:

1. **`refreshStaleness(store, cardId, fsRoot): Promise<boolean>`** — the SOLE
   re-baseline primitive (in `planning-sync-state.ts`). `readSourceCard` (Path B →
   `graph.relations`); unresolvable → `false` + NO write; `depAggregateHash` →
   current; `getCardDepHash` → stored; `wasStale = stored !== null &&
   (current !== stored.depHash || missing.length > 0)`; `writeValidatedBaseline`
   (re-baseline to current → clears the flag); return `wasStale`.
2. **A compare-only staleness sweep folded INTO `schedulePlanningBackfill`'s
   deferred block** (after `walkAndIngest`, before the success notify): open a
   short-lived `CardStore`; `getCardsByKind("planning-ticket")`; `computeStaleness`
   per card (seeds baseline on first touch + flags thereafter — NO re-baseline).
   Best-effort (outer + per-card `try`/`catch` so a staleness failure never breaks
   the mirror/backfill). `src/index.ts` untouched (reuses the existing
   `pi.on("session_start")` hook).

## Deviation from the plan's literal T5 code — and why

The plan's verbatim `refreshStaleness` body used `store.getCard(cardId)` + a raw
`store.upsertCardDepHash(cardId, current)` + a `{ stale, missing }` return. That
body is a **latent bug post-η**: `store.getCard` returns the `memories` row
**without** `graph` (the 06a store does NOT persist `card.graph` — card.ts:28-29;
`rowToCard` emits no `graph`; see the T4 brief's "Why Path B"). So `depAggregateHash`
would read `card.graph?.relations ?? []` → `[]` → hash `hashEntry("")` (a constant)
→ re-validate would hash the empty aggregate → a real stale flag could never be
detected or cleared. The plan's T5 code block predates the η amendment that routed
the READ side (`computeStaleness`) through `readSourceCard`.

The **task-spec CONTRACT** already encodes the η correction; it was adopted
verbatim. Two concrete divergences from the plan's literal body:

- **Card source**: `readSourceCard` (Path B — `graph.relations` present) instead of
  `store.getCard` (row drops `graph`). Without this, re-validate is a no-op.
- **Return type**: `Promise<boolean>` (mirrors the sibling `refreshIfStale`),
  not `Promise<{ stale, missing }>`. The sweep already surfaces `missing` via
  `computeStaleness`/`getStaleCards`; the re-validate op's job is "clear the flag +
  report whether it HAD drifted". T6 is not yet built.

Tests were written to the boolean-return CONTRACT (not the plan's `r.stale`/
`r.missing` assertions).

## Sweep home — folded INTO `schedulePlanningBackfill` (not a sibling)

Chosen fold-in over a sibling `scheduleStalenessSweep`. Rationale (one line): the
sweep must run AFTER the mirror seeds the ticket rows (else
`getCardsByKind("planning-ticket")` is empty on a fresh store), so coupling it to
the backfill's deferred block is the natural sequencing — and it keeps a SINGLE
`session_start` hook (the existing `pi.on("session_start")` already calls
`schedulePlanningBackfill(ctx.cwd, globalDir, …)` at `src/index.ts:356`), so there
is **zero `index.ts` change**, and it matches the plan's sweep test verbatim. A
sibling would have needed its own state + `waitForStalenessSweep` + new
`session_start` wiring + a rewrite of the plan's sweep test.

## Files changed (4, +244 insertions)

```
 .../src/handlers/planning-backfill.test.ts         |  80 ++++++++++
 .../src/handlers/planning-backfill.ts              |  28 ++++
 .../src/store/planning-sync-state.test.ts          | 100 ++++++++++++++
 .../src/store/planning-sync-state.ts               |  36 ++++
```

### `planning-sync-state.ts` — `refreshStaleness`

```diff
+export async function refreshStaleness(
+  store: CardStore,
+  cardId: string,
+  fsRoot: string,
+): Promise<boolean> {
+  const card = await readSourceCard(store, cardId, fsRoot);
+  if (!card) return false;
+  const { hash: current, missing } = await depAggregateHash(card, fsRoot);
+  const stored = await store.getCardDepHash(cardId);
+  const wasStale = stored !== null && (current !== stored.depHash || missing.length > 0);
+  // Re-baseline NOW to the CURRENT bytes: the NEXT change after this point is
+  // what re-flags stale. writeValidatedBaseline recomputes the aggregate once
+  // more (deterministic, idempotent — matches computeStaleness's first-touch path).
+  await writeValidatedBaseline(store, card, fsRoot);
+  return wasStale;
+}
```

### `planning-backfill.ts` — compare-only sweep (folded into the deferred block)

```diff
 import { walkAndIngest } from "../walk-and-ingest.js";
+import { createCardStore } from "../store/card-store.js"; // 10-impl T5 — sweep's short-lived store
+import { computeStaleness } from "../store/planning-staleness.js"; // 10-impl T5 — compare-only sweep
 …
         await walkAndIngest(files, { memoryDir, planningOnly: true, partialWalk: true });
+        // 10-impl T5: staleness sweep — seed dep baselines + FLAG stale (compare-only).
+        // MUST NOT re-baseline drifted cards (would wipe stale state every
+        // session_start, contradicting γ); re-baselining is the explicit
+        // refreshStaleness op. Runs AFTER walkAndIngest so the ticket rows exist.
+        try {
+          const stStore = await createCardStore({ memoryDir });
+          try {
+            const tickets = await stStore.getCardsByKind("planning-ticket");
+            for (const t of tickets) {
+              try {
+                await computeStaleness(stStore, t.id, repoRoot);
+              } catch {
+                /* one bad card must not abort the sweep */
+              }
+            }
+          } finally {
+            await stStore.close();
+          }
+        } catch {
+          /* staleness sweep is best-effort */
+        }
         notifyBestEffort(options.notify, `🧠 Planning backfill complete: …`, "info");
```

The two test files append 5 new cases (3 `refreshStaleness` + 2 sweep) — no
existing assertion modified.

## TDD evidence

- **RED** (`bun test src/store/planning-sync-state.test.ts src/handlers/planning-backfill.test.ts`):
  `refreshStaleness` export not found → `SyntaxError: Export named 'refreshStaleness' not found`
  (planning-sync-state.test.ts module failed to load); the sweep test failed at
  `assert.ok(await pre.getCardDepHash(...), "1st sweep seeded the dep baseline")`
  → `actual: null` (the backfill mirrored the card but the sweep wasn't wired to
  seed a baseline). `4 pass / 2 fail / 1 error` — both failures for the right reason.
- **GREEN** (same command after implementation): `27 pass / 0 fail` — the 3 new
  `refreshStaleness` cases + 2 new sweep cases + all 22 existing
  planning-sync-state/backfill cases pass.

## Full-suite counts

| stage            | pass | skip | fail | notes |
| ---------------- | ---- | ---- | ---- | ----- |
| after-T4 (stated baseline) | 1462 | 1 | 1   | the 1 fail = memworth date-aging time-bomb |
| after-T5                   | 1467 | 1 | 1   | same 1 skip / 1 known-fail UNCHANGED |

Net delta after-T4 → after-T5: **+5 pass**, 0 change to skip/fail. The +5 are the
3 `refreshStaleness` + 2 sweep cases. The single remaining fail is the unchanged
memworth date-aging time-bomb (`numeric isolation — assembled prompt never leaks
memworth … > formatForSystemPrompt never emits memworth (memory + failure blocks —
regression pin)`) — the **exact** test named in the T4 report, NOT a T5 regression.
`bun run check` (tsc --noEmit) clean.

## Self-review

- **Additive**: `refreshStaleness` is new; the sweep is a new pass inside the
  existing deferred block (no signature change to `schedulePlanningBackfill`).
  No `memories`/`card_md_hash`/`card_dep_hash` schema change; no 09 mirror/reconcile/
  hash-compare behavior change. **Master invariant verified**: the 4
  `refreshPlanningCard (09-impl T7)` cases + the `08→09 migration cohort` case +
  `refreshIfStale` + the 3 `schedulePlanningBackfill` 09-impl cases all stay green.
- **`refreshStaleness` is the sole re-baseline op**: it (and only it) calls
  `writeValidatedBaseline` to clear a stale flag. The sweep never calls it nor
  `writeValidatedBaseline`.
- **Sweep is compare-only** (verified empirically): the sweep test's 2nd
  `schedulePlanningBackfill` runs `computeStaleness` on a card whose dep changed
  AFTER the 1st sweep seeded its baseline @ v1; `getStaleCards` then lists that
  card → proving the sweep FLAGGED stale and did NOT re-baseline (a re-baselining
  sweep would have left it clean). A stale card's state therefore **survives**
  across sweeps (γ), and is cleared only by the explicit `refreshStaleness`.
- **Path B contract honored**: `refreshStaleness` sources deps from
  `readSourceCard` (source `.md` → `graph.relations`), NOT `store.getCard().graph`.

## Concerns / deferred

- **First-touch + non-stale double-compute**: `refreshStaleness` always calls
  `writeValidatedBaseline` (which recomputes `depAggregateHash`) even when the
  card is non-stale / already current — a harmless idempotent re-write of the same
  hash (mirrors `computeStaleness`'s first-touch path). The non-stale test asserts
  the `depHash` *value* is unchanged. Left as-is to keep a single write path; a
  precomputed-hash pass-through could avoid the second compute if profiling warrants.
- **Sweep opens its own `CardStore`** over `memoryDir` (separate from the one
  `walkAndIngest` opens internally). Sequential (the sweep runs only after
  `await walkAndIngest(…)` resolves), so no concurrent-connection concern; matches
  the plan's prescribed shape. A future shared-store refactor could fold it in.
- **No `MAX_FILES` bound on the sweep**: planning-ticket card count is small and the
  backfill's own `collectPlanningMdFiles` bound (50) already gates the mirror that
  produces those rows. Deliberate (the dispatch allowed omitting `MAX_FILES`).

## Commit

```
feat(knowledge-pipeline): staleness on-access refresh + background sweep (10-impl T5)
```
