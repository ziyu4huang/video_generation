# Task 9 — report: read-side staleness surfacing (10-impl staleness, FINAL impl task)

**Branch:** `knowledge-pipeline/10-impl-staleness`
**Base (parent):** `c561173794d3d8a8f8f1111e2d18da529d400530` (held T1..T8, clean)
**Task:** T9 — enrich wayfind read surfaces (`/wayfind list` + `/wayfind status`) with
an effort-level **stale count** + a per-ticket **`⚠ stale` marker**, consuming the T7
seam `readStaleDecisions(effort, cwd): Promise<StaleCard[] | null>`. Staleness becomes
VISIBLE early so the agent can re-grill proactively (complementing T8's graduation gate).

## What was implemented

| Surface | File | Pure fn (SYNC, untouched) | Render fn (enriched) | Tool arm (enriched) |
|---|---|---|---|---|
| `/wayfind status` | `src/effort-tool.ts` | `effortStatus(cwd, effort)` | `renderStatus(r)` | `case "status":` |
| `/wayfind list` | `src/effort-tool.ts` (`renderList`) + `src/effort-query.ts` (type) | `listEfforts(cwd)` | `renderList(r)` | `case "list":` |

- **Types (additive optional fields):** `EffortStatusResult.stale?: number | null`,
  `EffortStatusTicket.stale?: boolean` (effort-tool.ts); `EffortListItem.stale?: number | null`
  (effort-query.ts).
- **Async enrichment at the TOOL layer** (the tool `execute` is already async): the `status`
  arm + `list` arm call `readStaleDecisions` after the SYNC pure fn returns. The pure fns
  (`effortStatus`/`listEfforts`) stay SYNC + unchanged (the plan's pinned design choice —
  making them async would ripple signatures + all their tests).
- **Per-ticket marker join:** `staleNos = new Set(stale.map(s => s.cardId.split(":").pop()))`
  → `cardId = planning-ticket:<eff>:<no>` → `.pop()` yields the bare ticket number (`"01"`),
  which matches `t.id`. Marker `⚠ stale` appended next to `blocked-by`.
- **Exports (additive):** `renderStatus` + `renderList` gained `export` so the render contract
  is unit-testable without the seam.

### Null-safe rendering (the master additive invariant)

| State | tool sets | status render | list render | per-ticket |
|---|---|---|---|---|
| Hermes **absent** (seam → `null`) | `stale` **UNSET** (`undefined`) | nothing | no token | none |
| Hermes present, empty (`[]`) | `stale = 0` | `stale: 0 (clean)` | `stale=0` | none |
| Hermes present, N stale | `stale = N` | `stale: N` | `stale=N` | `⚠ stale` on matched tickets |

**Critical:** when hermes is absent the tool leaves `stale` **UNSET** (not `null`) → the
renderers' `undefined` branch emits nothing → the list/status output is **byte-identical to
pre-T9**. The `null` render branch (`staleness: unavailable` / `stale=?`) is preserved for
explicit-null callers (defensive + documented by a test) but the tool never produces it.

## Files changed (diff hunk summary)

```
 bun-apps/pi-agent-ext-wayfind/src/effort-query.ts  |   5 +     (EffortListItem.stale?)
 bun-apps/pi-agent-ext-wayfind/src/effort-tool.ts   |  62 +++--  (import + 2 types + status/list arms + renderStatus/renderList + export)
 bun-apps/pi-agent-ext-wayfind/tests/effort-tool.test.ts | 222 +++++ (13 new tests: render contract + seam integration)
 3 files changed, 283 insertions(+), 6 deletions(-)
```

### effort-tool.ts
- `+ import { readStaleDecisions } from "./stale-seam.js";`
- `EffortStatusTicket.stale?: boolean` (doc'd).
- `EffortStatusResult.stale?: number | null` (doc'd: null=explicit unavailable, undefined=not
  enriched/hermes-absent, 0=clean, N=count).
- `export function renderStatus` + staleness line after `destination:` (`undefined` → "",
  `null` → `staleness: unavailable`, `0` → `stale: 0 (clean)`, `N` → `stale: N`); per-ticket
  `const stl = t.stale ? " ⚠ stale" : "";` appended to the ticket line.
- `export function renderList` + `staleToken` appended per-effort (`undefined` → "", `null` →
  `  stale=?`, `N` → `  stale=N`).
- `status` arm: `try { const stale = await readStaleDecisions(...); if (stale !== null) {
  r.stale = stale.length; mark tickets; } } catch {}` (leave unset on null/throw).
- `list` arm: per-effort `readStaleDecisions(e.slug, cwd)` → `e.stale = stale.length`
  (leave unset on null/throw).

### effort-query.ts
- `EffortListItem.stale?: number | null` (doc'd). `listEfforts` stays SYNC (leaves it unset).

### tests/effort-tool.test.ts
- `afterEach` added to the `bun:test` import; `renderList`/`renderStatus` + type imports added.
- New describe **"renderStatus / renderList — stale render contract (10-impl T9)"** (7 tests):
  undefined/null/0/N + non-stale-ticket-no-marker + list undefined/null/0/N.
- New describe **"wayfind_effort tool — stale seam integration (10-impl T9)"** (6 tests):
  status hermes-present-1-stale (count + marker on 01 not 02), status hermes-present-empty
  (`stale: 0 (clean)` + no marker), status hermes-ABSENT (NO stale info, byte-identical),
  status exactly-one-marker join, list hermes-present (`stale=1`), list hermes-ABSENT (no token).

## RED → GREEN evidence

- **RED** (`bun test tests/effort-tool.test.ts`): **9 fail / 29 pass** — the 9 failures are
  exactly the tests asserting stale output IS present (renderers don't emit stale yet; tool
  doesn't enrich). The 4 "absence/invariant" tests (undefined→nothing, hermes-absent→nothing)
  passed trivially both before and after — they assert byte-identical output, which holds
  either way. (Also fixed a missing `afterEach` import that initially caused a top-level
  `ReferenceError` preventing the seam describe from running.)
- **GREEN** (`bun test tests/effort-tool.test.ts`): **38 pass / 0 fail**.

## Full-suite counts

| | pass | skip | fail | error | total |
|---|---|---|---|---|---|
| after-T8 (baseline) | 475 | 1 | 1 | 1 | 477 |
| **after-T9** | **488** | **1** | **1** | **1** | **490** |
| **delta** | **+13** | 0 | 0 | 0 | +13 |

Net delta = **+13 pass** (the new tests), **fail/error UNCHANGED**:
- the 1 **fail** + 1 **error** are the **pre-existing architecture-render ENOENT**
  (`import { renderReport } from "../src/architecture-render"` + Mermaid-in-headless-browser) —
  identical to baseline, NOT touched by T9.
- the 1 **skip** is the same architecture-render mermaid paint — UNCHANGED.

**Typecheck:** `bunx tsc --noEmit` → **exit 0**.
**Biome (`bun run check`):** my 3 changed files are **biome-clean**; the ONLY remaining biome
error is the **pre-existing `tests/map.test.ts` quote-style debt** (UNCHANGED — 1 error,
identical to baseline). Scoped `biome check --write` to ONLY my two src/test files so the
pre-existing `map.test.ts` debt was not touched.

## Self-review

- **Additive:** only optional `stale` fields + the stale line/token/marker + the async
  enrichment + two `export` keywords. No existing field/function altered; no signature
  ripple (pure fns stay SYNC).
- **hermes-absent → byte-identical to pre-T9:** when `readStaleDecisions` returns `null`,
  the tool leaves `stale` UNSET → renderers' `undefined` branch emits nothing → NO `stale:`
  line, NO `staleness:` line, NO `stale=` token, NO `⚠ stale` marker. Asserted by 4 tests
  (render-contract undefined ×2 + seam-integration hermes-absent ×2). Code inspection
  confirms: `staleStr` is `""` (not pushed) and `stl` is `""` when `t.stale` is undefined.
- **stale count + marker shown when hermes present:** asserted by the seam-integration tests
  (`stale: 1` + `⚠ stale` on 01; `stale: 0 (clean)` + no marker when empty; `stale=1` on list).
- **Null-safe, never crashes:** `readStaleDecisions` already catches internally → returns
  `null`; the tool also wraps each call in `try/catch` → leaves `stale` unset on throw.
- **pre-existing fail/err UNCHANGED:** architecture-render ENOENT + map.test.ts biome debt —
  both identical to baseline.

## Deviation from the plan's T9 code (one, justified)

The plan's literal tool code sets `r.stale = stale ? stale.length : null` when the seam
returns `null` (hermes absent), and its render contract maps `null → "staleness:
unavailable"` / `stale=?`. That would make hermes-absent ADD a `staleness: unavailable`
line — **violating the contract's repeated, non-negotiable "hermes-absent → output
byte-identical to pre-T9 (no stale info)" constraint** (it appears 5+ times: CONSTRAINTS,
STEP 2 #7, REPORT BACK).

**Resolution:** the tool leaves `stale` **UNSET** (`undefined`) when hermes is absent
(`if (stale !== null) { … }` instead of `r.stale = stale ? stale.length : null`), so the
renderer's `undefined` branch emits nothing → byte-identical. The plan's render contract
(`null → staleness: unavailable`) is preserved **verbatim** for explicit-null callers and is
covered by a render-contract test; only the tool's null-vs-unset choice deviates. This
satisfies BOTH the plan's render design AND the contract's byte-identical invariant. The
contract itself flags this choice ("prefer omitting so absence is silent").

No other deviation. The pure-fn-stays-sync design, the per-ticket join (`cardId.split(":").pop()`),
the additive optional fields, and the two `export` keywords all match the plan.

## Concerns

- **List makes N seam calls** (one per effort) — each opens an ephemeral hermes store. The
  plan explicitly accepts this ("acceptable for a manual list, not a hot path"). No change.
- `renderStatus`/`renderList` are now exported (was module-private). This is the plan's own
  Step 3.5 instruction (additive, enables testing). No behavior change.
- T9 is the **FINAL implementation task** of the 10-impl staleness plan. After this commit the
  branch holds T1..T9 and is feature-complete pending a final whole-branch review + plan
  amendment + PR (per the task contract — not done here: no push/PR).
