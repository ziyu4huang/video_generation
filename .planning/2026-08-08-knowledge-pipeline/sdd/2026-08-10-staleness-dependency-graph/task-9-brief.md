# Task 9 — read-side staleness surfacing (10-impl staleness, FINAL impl task)

**Branch:** `knowledge-pipeline/10-impl-staleness`
**Base (parent of T9 commit):** `c561173794d3d8a8f8f1111e2d18da529d400530` (holds T1..T8)
**Plan section:** `### Task 9: read-side surfacing (wayfind)` in
`plans/2026-08-10-staleness-dependency-graph.md` (lines 1585–1782).

## What T9 does

Enrich the wayfind **read surfaces** (`/wayfind list` + `/wayfind status` rendering)
so staleness is **visible early** — a **stale count at the effort level** and a
**per-ticket `stale` marker**. This complements T8's graduation gate (which only
*blocks* at the final `/wayfind done`): with T9 the agent *sees* staleness while
it is still charting and can re-grill proactively.

Consumes the T7 seam `readStaleDecisions(effort, cwd): Promise<StaleCard[] | null>`.

## Surfaces enriched (exact files + functions)

| Surface | File | Pure fn (SYNC, untouched) | Render fn (enriched) | Tool arm (enriched) |
|---|---|---|---|---|
| `/wayfind status` | `src/effort-tool.ts` | `effortStatus(cwd, effort)` | `renderStatus(r)` | `case "status":` |
| `/wayfind list` | `src/effort-tool.ts` (`renderList`) + `src/effort-query.ts` (type) | `listEfforts(cwd)` | `renderList(r)` | `case "list":` |

- `effortStatus` + `listEfforts` stay **SYNC pure** — they read only `map.md` +
  manifests. The `stale` field is enriched at the **TOOL layer** (the tool's async
  `execute` calls `readStaleDecisions` after the sync fn returns). This mirrors the
  plan's pinned design choice: making the pure fns async would ripple into their
  signatures + every existing test; the tool `execute` is already async.

## How stale cardIds map to the ticket view

A `StaleCard.cardId` is a planning-ticket id: `planning-ticket:<effort>:<no>`
(e.g. `planning-ticket:gate-eff:01`). Wayfind's per-ticket line carries `t.id` =
the **bare number** (`"01"`, `"02"` …). The join is:

```ts
const staleNos = new Set(stale.map((s) => s.cardId.split(":").pop() ?? ""));
for (const t of r.tickets) if (staleNos.has(t.id)) t.stale = true;
```

Effort-level stale count = `stale.length` for that effort.

## Type additions (all additive optional fields)

```ts
// effort-tool.ts
EffortStatusResult.stale?: number | null   // null = unavailable (hermes absent); 0 = clean; N = count
EffortStatusTicket.stale?: boolean         // per-ticket stale marker

// effort-query.ts
EffortListItem.stale?: number | null       // same semantics
```

The SYNC pure fns leave `stale` **unset** (`undefined`); the tool `execute` sets it
to `null` (hermes absent) / `0..N` (hermes present) before rendering.

## Render contract (renderStatus / renderList)

`renderStatus` — staleness line right after the `destination:` line:
- `undefined` → **no line** (pure fn result not yet enriched — only happens for the
  `Missing required param 'effort'` ok:false short-circuit, which returns before
  render anyway; otherwise the tool always sets stale before rendering).
- `null` → `staleness: unavailable`
- `0` → `stale: 0 (clean)`
- `N>0` → `stale: N`

Per-ticket marker (next to `blocked-by`): `⚠ stale` when `t.stale === true`.

`renderList` — per-effort line appends a `stale=…` token:
- `undefined` → **no token**
- `null` → `  stale=?`
- `0..N` → `  stale=<N>`

`renderStatus` + `renderList` become **exported** (additive `export` keyword) so the
tests can import them and assert the render contract directly.

## Null-safe rendering (hermes absent)

`readStaleDecisions` returns `null` when hermes is absent (`typeof fn !== "function"`)
**or** the seam throws. The tool wraps each call in `try/catch` → `r.stale = null`.
Net effect:

| State | status | list | per-ticket marker |
|---|---|---|---|
| Hermes **absent** (null) | `staleness: unavailable` | `stale=?` | **none** |
| Hermes present, empty | `stale: 0 (clean)` | `stale=0` | none |
| Hermes present, N stale | `stale: N` | `stale=N` | `⚠ stale` on stale ticket |

**Critical additive invariant:** the existing list/status/ticket output is
**byte-identical to pre-T9** in the regions *outside* the newly added stale
token/line. The stale line/token is purely additive (a new line / a new trailing
token). Hermes-absent renders `staleness: unavailable` / `stale=?` (so absence is
explicit, not alarming) but every other byte is unchanged.

## TDD plan (RED → GREEN)

**Tests** (append to `tests/effort-tool.test.ts`, mirroring the file's `bun:test`
+ real-fs idiom + the `globalThis.__piHermesStaleCheck` seam idiom from
`tests/stale-seam.test.ts` / `tests/wayfinder.test.ts`):

1. **render contract (sync, no seam)** — exactly the plan's Step 1 cases:
   `renderStatus` null → `staleness: unavailable`; 0 → `stale: 0 (clean)`; N →
   `stale: N` + `⚠ stale` per-ticket marker; `renderList` null/0/N → `stale=?` /
   `stale=0` / `stale=N`.
2. **seam-path integration (status arm, via tool execute + globalThis seam):**
   - hermes present, 1 stale (cardId `planning-ticket:<eff>:01`) → `stale: 1` count
     + `⚠ stale` marker on ticket 01.
   - hermes present, empty → `stale: 0` + no marker.
   - **hermes absent → no stale info, output otherwise UNCHANGED** (delete the
     globalThis key → status content has NO `stale:`/`staleness:` line at all,
     because the pure fn path leaves `stale` unset... wait — see adjustment below).
   - non-stale ticket (cardId for 01, ticket 02 present) → marker on 01 only, not 02.

## Pre-implementation adjustment (deviation from the plan's literal test code)

The plan's literal Step-1 test asserts that `renderStatus` with `stale: null`
emits `staleness: unavailable`, and `renderList` with `stale: null` emits `stale=?`.
That is the **render** contract and it is correct — `renderStatus`/`renderList`
treat `null` distinctly from `undefined`.

**But** the seam-path "hermes absent → no stale info" case needs care: when hermes
is absent, `readStaleDecisions` returns `null`, and the tool sets `r.stale = null`
→ `renderStatus` emits `staleness: unavailable`. That is the intended design (the
plan's render contract defines `null → staleness: unavailable`), so "hermes absent"
is NOT byte-identical to pre-T9 for the status arm — it ADDS a `staleness:
unavailable` line. This is the plan's explicit, pinned choice (absence is surfaced,
not hidden). The **byte-identical** guarantee therefore applies to: every byte
*other than* the newly-added stale line/token. The "otherwise UNCHANGED" test
asserts the invariant lines (effort header, destination, frontier, ticket inventory
lines) are unchanged — it does NOT claim zero new output.

This matches the plan's render contract exactly. No code deviation from the plan's
implementer code is expected; this note only documents the precise meaning of
"additive / null-safe".

## Files changed (to stage at commit)

- `bun-apps/pi-agent-ext-wayfind/src/effort-tool.ts` (types + import + status/list
  arms + `renderStatus`/`renderList` enrich + export)
- `bun-apps/pi-agent-ext-wayfind/src/effort-query.ts` (`EffortListItem.stale?`)
- `bun-apps/pi-agent-ext-wayfind/tests/effort-tool.test.ts` (new describe block)

## Master invariant

ADDITIVE. The pure fns (`effortStatus`, `listEfforts`) stay sync + unchanged.
`renderStatus`/`renderList` gain a stale line/token only; existing bytes outside
that are byte-identical. If any non-staleness test breaks → STOP.
