# Task 1 Report — `depends_on` edge: parse + serializer emit (10-impl T1)

TDD audit-trail artifact. Mirrors the 09-impl `task-1-report.md` shape.

- **Branch:** `knowledge-pipeline/10-impl-staleness`
- **Base SHA:** `c75cbf6a8a528ea4ba7418fc25357c417035200d` (= `origin/main`)
- **Commit:** filled post-hoc — see the REPORT BACK summary (single commit, `--amend --no-edit` intentionally NOT used per task guidance; the SHA is recorded in the returned summary, not self-referentially in this file).
- **Plan:** `.planning/2026-08-08-knowledge-pipeline/plans/2026-08-10-staleness-dependency-graph.md` § Task 1 (lines 44–187).
- **Brief:** `.planning/2026-08-08-knowledge-pipeline/sdd/2026-08-10-staleness-dependency-graph/task-1-brief.md`.

## What was implemented

The `depends_on` dependency edge for planning-ticket cards (decision → source-file),
additive to the existing `blocked-by` (ticket→ticket) and `cites` (decision→source-file,
body-scanned) edges from 08-impl.

1. **`parseDependsOn(raw: unknown): string[]`** (`planning-parse.ts`) — mirrors `parseBlockedBy`
   in shape but NOT in semantics: these are repo-relative **paths**, so there is NO
   number-coercion and NO zero-pad. A `string` is split on commas/newlines (a single path
   stays whole); entries are trimmed and empties dropped. An `array` is filtered to strings,
   trimmed, empties dropped. Wrong/absent types → `[]`.
2. **`ticketCard()`** (`planning-serializer.ts`) — reads `data["depends_on"]` via
   `parseDependsOn`; pushes `{ s: selfId, rel: "depends_on", o: path }` per path into
   `relations` (o = repo-relative path, same shape as `cites`); spreads
   `dependsOn` into `frontmatter` when non-empty. `graph` derives from
   `relations.length > 0`, so the new edges extend it automatically. `blocked-by` and
   `cites` emission is untouched.

## Files changed (4, +86 / −0, purely additive)

```
 .../src/store/planning-parse.test.ts               | 28 ++++++++++++++++++++
 .../src/store/planning-parse.ts                    | 22 ++++++++++++++++
 .../src/store/planning-serializer.test.ts          | 30 ++++++++++++++++++++++
 .../src/store/planning-serializer.ts               |  6 +++++
 4 files changed, 86 insertions(+)
```

### Impl hunks

`planning-parse.ts` (+22) — new export after `parseBlockedBy`:
```ts
export function parseDependsOn(raw: unknown): string[] {
  if (typeof raw === "string") {
    return raw
      .split(/[,\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (Array.isArray(raw)) {
    return raw
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}
```

`planning-serializer.ts` (+6) — `parseDependsOn` added to the `./planning-parse.js` import
block; in `ticketCard()`:
```ts
const blockedBy = parseBlockedBy(data["blocked by"]);
const dependsOn = parseDependsOn(data["depends_on"]);   // +
...
for (const path of dependsOn) {                          // +
  relations.push({ s: selfId, rel: "depends_on", o: path });
}
...
...(blockedBy.length > 0 ? { blockedBy } : {}),
...(dependsOn.length > 0 ? { dependsOn } : {}),          // +
```

## RED evidence (tests fail for the right reason)

Tests written first (5 `parseDependsOn` cases + 4 serializer `depends_on` cases), run before
any impl. Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/store/planning-parse.test.ts src/store/planning-serializer.test.ts )`.

- `planning-parse.test.ts` failed to load: `SyntaxError: Export named 'parseDependsOn' not found in module '…/planning-parse.ts'` → all 5 `parseDependsOn` cases error (export absent). Expected: `parseDependsOn` does not exist yet.
- Serializer `depends_on` cases: `frontmatter.dependsOn` is `undefined` (`ERR_ASSERTION` `deepStrictEqual`, `actual: undefined, expected: ["bun-apps/hermes/src/store/card.ts","docs/spec.md"]`); the `rel:"depends_on"` relations assertions fail likewise. Expected: `ticketCard()` does not emit `depends_on` yet.
- The 2 serializer cases asserting UNCHANGED `blocked-by`/`cites` and the absent-`depends_on` case **passed** in RED — confirming the ONLY missing behavior was the `depends_on` emission, not collateral damage to `blocked-by`/`cites`.

Summary line (RED): `9 pass / 3 fail / 1 error, Ran 12 tests` (parse file aborted at module load, so its post-import tests were not individually scored).

## GREEN evidence (tests pass after impl)

Same run after implementation:
```
(parseDependsOn) accepts an explicit array … / a single string path … /
  a comma/newline list … / does NOT zero-pad … / returns [] when absent/wrong type   — 5 pass
(PlanningTicketSerializer — depends_on edge) emits depends_on relations /
  emits frontmatter.dependsOn / blocked-by + cites UNCHANGED /
  absent depends_on → no relation + no frontmatter.dependsOn                          — 4 pass
(planning-parse existing 6 + PlanningEffortSerializer 4 + PlanningTicketSerializer 3) — 13 pass
22 pass / 0 fail, Ran 22 tests across 2 files
```

All 22 pass. The `blocked-by`/`cites`/effort/gist existing assertions are unchanged.

## Full-suite regression + type-check (master invariant)

- **`bun run check`** (= `tsc --noEmit`): **clean, exit 0** (no diagnostics).
- **`bun test`** (full package):

| | pass | skip | fail | total | files | expect() |
|---|---|---|---|---|---|---|
| **baseline** (clean `origin/main`) | 1440 | 1 | 1 | 1442 | 124 | 1048 |
| **after T1** | 1449 | 1 | 1 | 1451 | 124 | 1048 |
| **net delta** | **+9** | 0 | 0 | +9 | 0 | 0 |

- The +9 is EXACTLY the new T1 tests (5 `parseDependsOn` + 4 serializer `depends_on`).
  `expect()` count unchanged because the new tests use `assert`, not `expect`.
- The single failure is **unchanged from baseline** and IS the known pre-existing date-aging
  time-bomb: `numeric isolation — assembled prompt never leaks memworth (UPSP §7 / DO ticket 04) >
  formatForSystemPrompt never emits memworth (memory + failure blocks — regression pin)`. It is
  unrelated to T1 (T1 touches planning-card parsing only; this is the memory/failure prompt
  formatter). The skip (`md_id schema > SQLite: md_id is unique among non-NULL values`) is also
  unchanged. **Master invariant holds: memory/user/failure/knowledge/planning cards did NOT regress.**

## Self-review notes

- **Scope: exactly T1, no creep.** The diff is 4 files / +86 / −0, all within T1's declared
  Files list. No other package touched. No `.planning/` scratch (progress.md/findings.md etc.)
  created — only the brief + this report under the SDD workspace. No stash disturbed (16
  preserved). No push, no PR.
- **No deviation from the plan's T1 code.** The impl is byte-for-byte the plan's Step 3/4
  code; the tests are byte-for-byte the plan's Step 1 code. The only "deviations" are
  pre-implementation adjustments recorded in the brief (A–E), none of which change the code:
  the branch already existed at origin/main (verified HEAD == origin/main instead of a
  redundant `checkout -b`), test-file locations matched the plan's claim (no path drift), and
  no signature drift existed in the real source.
- **`parseDependsOn` vs `parseBlockedBy` semantic difference is honoured:** `parseBlockedBy`
  coerces YAML-numeric `blocked by: 01` → `"01"` (zero-pad); `parseDependsOn` does NOT — a
  number arg (e.g. `42`) falls through to `[]`, and a path like `src/v0/thing.ts` is kept
  verbatim (the `does NOT zero-pad` test pins this). This is correct: paths are never ticket
  numbers.
- **`graph` extension is automatic** — `ticketCard()` derives `graph` from
  `relations.length > 0`; adding `depends_on` edges needs no other change, exactly as the plan
  stated.

## Concerns

None. T1 is purely additive (new export, new relation rel, new optional frontmatter field),
introduces no schema/DB change, and changes zero existing behavior. Ready for T2
(`card_dep_hash` table).
