# Task 7 Report — hermes→wayfind staleness reverse seam (10-impl T7)

> The "what I actually did + evidence" record. Pairs with `task-7-brief.md`.
>
> Branch: `knowledge-pipeline/10-impl-staleness` (CONTINUED off `c2ced3bc`).
> Commit: see "Commit" below.
> **FIRST CROSS-PACKAGE task** (hermes publisher + wayfind reader).

## What was implemented

The reverse `globalThis` staleness seam (decision β) — roles flipped vs the
existing `grill-seam.ts`. Hermes PUBLISHES an **async** reader; wayfind READS it.

### Hermes side (publisher) — `bun-apps/pi-agent-ext-hermes-memory/`

1. **`src/stale-seam.ts`** (NEW) —
   - `export const HERMES_STALE_CHECK_KEY = "__piHermesStaleCheck";` (the literal;
     duplicated verbatim in wayfind).
   - `export function publishStaleCheck(memoryDir: string): void` — sets
     `globalThis[KEY]` to `async (effort, cwd) => { stale: StaleCard[] }`. The
     closure opens an **ephemeral** `createCardStore({ memoryDir })` per call,
     calls `getStaleCards(store, effort, cwd)` (T4), and closes the store in a
     `finally`. **Null-safe envelope:** `createCardStore` throw → `{ stale: [] }`
     (nothing to close); `getStaleCards` throw → `{ stale: [] }`; `store.close()`
     throw → swallowed. So a broken hermes NEVER false-blocks a wayfind
     graduation.
   - `export function unpublishStaleCheck(): void` — `delete globalThis[KEY]`.
2. **`src/index.ts`** (MODIFIED, 1 import + 2 lines) —
   - import `publishStaleCheck, unpublishStaleCheck` from `./stale-seam.js`.
   - `publishStaleCheck(globalDir)` at init, immediately after the T6
     `registerPlanningStaleTool(pi, { memoryDir: globalDir });` line (both are the
     staleness surfaces; `globalDir` is in scope).
   - `try { unpublishStaleCheck(); } catch {}` at the TOP of the `session_shutdown`
     handler (clears the seam before the DB drain, so it's gone even if the drain
     throws — mirrors `unpublishWayfindGrill`'s lifecycle).
3. **`src/stale-seam.test.ts`** (NEW, `node:test` + `node:assert/strict`,
   co-located) — 3 cases: publishes the async reader + a drifted card surfaces;
   `unpublishStaleCheck` clears the global; degrades to `{ stale: [] }` (never
   throws) when the store dir is missing.

### Wayfind side (reader) — `bun-apps/pi-agent-ext-wayfind/`

4. **`src/stale-seam.ts`** (NEW) —
   - `const HERMES_STALE_CHECK_KEY = "__piHermesStaleCheck";` (DUPLICATED literal —
     ADR-0004; no import from hermes).
   - `export interface StaleCard { cardId; effort; missingDeps? }` (DUPLICATED
     shape — structurally compatible with hermes's `StaleCard`).
   - `export async function readStaleDecisions(effort, cwd): Promise<StaleCard[] | null>`
     — `typeof fn !== "function"` → `null` (hermes absent); `try { return r?.stale ?? null }`
     `catch { return null }` (seam throws → null). **NEVER crashes the caller.**
5. **`tests/stale-seam.test.ts`** (NEW, `bun:test`, mirrors `tests/grill-seam.test.ts`)
   — 4 cases: null when no seam; returns the list when published; null when the
   fn throws; null when the result has no `stale` field.

## Deviation from the plan's literal T7 code — and why

### #1 — the plan's hermes TEST seed is Path-B-wrong (deps come from the source `.md`, NOT the store row)

The plan's verbatim hermes test does `store.upsertCard(card WITH graph.relations)`
+ `computeStaleness(store, cardId, root)` with **no source `.md` on disk**, then
expects the card to surface as stale. That is the SAME latent bug T6's report
flagged (and the committed T4 test fixed): post-η, `computeStaleness` reads deps
from `readSourceCard(store, id, fsRoot)` — a re-parse of the git-canonical source
`.md` — NOT from `store.getCard(id).graph.relations` (the 06a store does NOT
persist `card.graph`; `rowToCard` emits no `graph`). With no source `.md`,
`readSourceCard` → `null` → `computeStaleness` → `{ stale:false }` + writes **no**
baseline → `getStaleCards` would never flag the card; the "surfaces the stale
card" assertion would fail for the wrong reason.

**Fix:** mirror the committed T4 test's `seedSource` / `writeDep` idiom verbatim
(`src/store/planning-staleness.test.ts`): write a REAL source `.md` under
`<root>/.planning/seam/tickets/01-seam-ticket.md` with a `depends_on:` frontmatter
dep + a `cites <path>` body line, write both dep files, `upsertCard` the ticket
id (id only, NO graph — needed for `getStaleCards` enumeration), `computeStaleness`
to seed the baseline @ v1, then edit the cited dep to `v2-EDITED`, then call the
published seam fn and assert the card surfaces. **Test semantics are unchanged**
— only the seed mechanics are corrected to match the committed Path-B reality.
This is exactly the brief's STEP-6 anticipation ("prefer a real ephemeral store
like T6" / "set up a stale card via the T4/T6 source-.md + dep-file idiom").

### #2 — publisher null-safe envelope implemented verbatim

The plan's publisher wraps BOTH `createCardStore` (→ `{stale:[]}`) AND
`getStaleCards` (→ `{stale:[]}`, `finally { store.close() }` best-effort). I
implemented it verbatim — `store` declared outside the `try` so `finally` can
close it; the `createCardStore`-throw path has nothing to close. No deviation.

### #3 — wire location in `src/index.ts`

Publish at init immediately after the T6 `registerPlanningStaleTool` line (both
are the staleness surfaces; `globalDir` in scope). Unpublish at the TOP of
`session_shutdown` (before the DB drain). Matches the plan's intent; the plan
said "near the top of the shutdown handler" — done.

## Evidence

### RED (modules absent → fail for the right reason)

```
HERMES:  error: Cannot find module './stale-seam.js' from '.../src/stale-seam.test.ts'   (0 pass / 1 fail)
WAYFIND: error: Cannot find module '../src/stale-seam.js' from '.../tests/stale-seam.test.ts' (0 pass / 1 fail)
```

### GREEN (after implementing both `stale-seam.ts` + wiring `index.ts`)

```
HERMES  src/stale-seam.test.ts:  3 pass / 0 fail
WAYFIND tests/stale-seam.test.ts: 4 pass / 0 fail / 4 expect() calls
```

### Full-suite regression

**Hermes** (`bun run check` = `tsc --noEmit`, clean; `bun test`):

| stage | pass | skip | fail | note |
|---|---|---|---|---|
| after-T6 (stated baseline) | 1477 | 1 | 1 | the 1 fail = `memworth`/numeric-isolation date-aging bomb (pre-existing) |
| **after-T7** | **1480** | **1** | **1** | +3 (my new hermes seam tests); tsc clean; SAME 1 known-fail UNCHANGED |

**Wayfind** (`bun run check` = biome; `bunx tsc --noEmit`; `bun test`) — **baseline
proven by moving my 2 additive files aside** (no git/stash touched):

| stage | pass | skip | fail | err | biome errors | tsc | note |
|---|---|---|---|---|---|---|---|
| baseline (c2ced3bc, no T7 files) | 469 | 1 | 1 | 1 | 1 (`tests/map.test.ts` format) | exit 0 | pre-existing: `architecture-render.test.ts` ENOENT (missing `.planning/.../sample-report.md` fixture) + `map.test.ts` biome debt |
| **after-T7** | **471** | **1** | **1** | **1** | **1 (same `map.test.ts`)** | **exit 0** | +4 (my new wayfind seam tests, all pass); my 2 new files are biome-clean; the 1 fail/1 error/biome-error are ALL unchanged baseline |

> **Zero regressions on either side.** Wayfind's 1 fail + 1 error + biome error
> are PRE-EXISTING baseline (proven by the mv-aside run), not introduced by T7.
> T7 is purely additive (`src/stale-seam.ts` + `tests/stale-seam.test.ts` —
> neither imported by any existing wayfind file). They are out of T7's scope to
> fix (the contract says "wayfind existing behavior UNCHANGED"; touching
> `map.test.ts` / the missing fixture would be unrelated scope creep).

## Self-review (master invariants)

- ✅ **Additive BOTH sides.** Hermes: new `stale-seam.ts` + 1 import + 2 wiring
  lines in `index.ts`; grill-seam + every existing tool/handler UNCHANGED. Wayfind:
  new `stale-seam.ts` + test; nothing reads it yet (T8/T9 will); no existing wayfind
  file modified.
- ✅ **Null-safe.** Reader returns `null` (hermes absent OR seam throws); publisher
  returns `{ stale: [] }` (store won't open OR compute throws). T8's gate degrades
  to a no-op; never crashes; never false-blocks. Both proven by tests.
- ✅ **Async.** The seam fn is `async (effort, cwd) => { stale }`; the reader is
  `Promise<StaleCard[] | null>`. (β — `getStaleCards` is async; T8 will make
  `closeEffortReflection` async — NOT this task.)
- ✅ **ADR-0004 — no cross-package import.** The `__piHermesStaleCheck` literal +
  `StaleCard` shape are DUPLICATED in both packages (verified: no `import` across
  the `pi-agent-ext-hermes-memory`/`pi-agent-ext-wayfind` boundary in either new
  file).
- ✅ **grill-seam unchanged** (hermes `src/grill-seam.ts` + wayfind
  `coordination.ts`/`constants.ts` untouched).
- ✅ **Ephemeral store idiom** — the publisher opens+closes a `CardStore` per call,
  exactly like `mirrorPlanningToStore` / `runStaleQuery` (T6). Hermes holds no
  long-lived planning store.

## Files changed

```
bun-apps/pi-agent-ext-hermes-memory/src/stale-seam.ts        (NEW, publisher)
bun-apps/pi-agent-ext-hermes-memory/src/stale-seam.test.ts   (NEW, node:test, 3 cases)
bun-apps/pi-agent-ext-hermes-memory/src/index.ts             (MODIFIED: +import, +publish at init, +unpublish on shutdown)
bun-apps/pi-agent-ext-wayfind/src/stale-seam.ts              (NEW, reader)
bun-apps/pi-agent-ext-wayfind/tests/stale-seam.test.ts       (NEW, bun:test, 4 cases)
```

## Concerns

- **Wayfind pre-existing baseline failures** (1 test fail `architecture-render.test.ts`
  ENOENT on a missing `.planning/.../sample-report.md`; 1 biome error
  `tests/map.test.ts` format debt) — both confirmed pre-existing at c2ced3bc via
  an mv-aside baseline run. Not T7-caused, not T7's to fix. Flagged for awareness.
- **Hermes 1 known-fail** (`memworth` numeric-isolation date-aging bomb) —
  unchanged from T6; documented in T6's report.
- The seam is landed but **not yet consumed** — T8 (graduation gate) + T9
  (read-side surfacing) will `await readStaleDecisions(...)`. This task only
  delivers the connection; nothing reads it yet by design.

## Commit

```
feat(knowledge-pipeline): hermes→wayfind staleness reverse seam (10-impl T7)
```
