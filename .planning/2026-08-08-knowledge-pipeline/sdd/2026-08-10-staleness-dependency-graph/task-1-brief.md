# Task 1 Brief — `depends_on` edge: parse + serializer emit (10-impl T1)

> The "what I agreed to build" record. Extracted verbatim from the plan's
> `### Task 1:` section, with pre-implementation adjustments recorded where the
> real source diverged from (or confirmed) the plan.
>
> Plan: `.planning/2026-08-08-knowledge-pipeline/plans/2026-08-10-staleness-dependency-graph.md` (Task 1, lines 44–187).
> Branch: `knowledge-pipeline/10-impl-staleness` (already existed at origin/main — see Adjustment A).
> Base SHA: `c75cbf6a8a528ea4ba7418fc25357c417035200d` (= `origin/main`).

## Files

- **Modify:** `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-parse.ts` — add `parseDependsOn`.
- **Modify:** `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-serializer.ts` — `ticketCard()` reads `depends_on`, emits frontmatter + `depends_on` relations.
- **Modify:** `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-parse.test.ts` — `parseDependsOn` cases.
- **Modify:** `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-serializer.test.ts` — serializer emission (self-contained, inline bytes).

## Interfaces

- **Produces** `parseDependsOn(raw: unknown): string[]` (planning-parse.ts) — mirrors `parseBlockedBy` in SHAPE but NOT semantics: these are repo-relative **PATHS**, not ticket numbers. Accept `string | string[]`; a string is split on commas/newlines; trim; drop empties; **NO zero-pad / NO number-coercion** (paths, not `NN` ticket nos). Wrong types → `[]`.
- **Produces** `ticketCard()` now also reads `data["depends_on"]` via `parseDependsOn`, sets `frontmatter.dependsOn` when non-empty, and pushes `{ s: selfId, rel: "depends_on", o: path }` for each (o = repo-relative path, like `cites`).

## Steps (TDD)

1. **RED — write failing tests first.** Append `parseDependsOn` describe to `planning-parse.test.ts` (cases: explicit array; single string; comma/newline list trimmed+empties dropped; no zero-pad; absent/wrong type → `[]`). Append a `depends_on edge (10-impl T1)` describe to `planning-serializer.test.ts` (self-contained inline md with `blocked by: 01` + a `depends_on:` YAML list): asserts `rel:"depends_on"` relations, `frontmatter.dependsOn`, `blocked-by`+`cites` UNCHANGED, and absent-`depends_on` → no `depends_on` relation + no `frontmatter.dependsOn`.
2. Run tests → FAIL (export absent / relations absent).
3. **GREEN — impl.** Add `parseDependsOn` to planning-parse.ts. Wire it in `ticketCard()`: read `data["depends_on"]`, emit frontmatter + relations (mirror the `blockedBy`/`citedPaths` blocks).
4. Run tests → PASS.
5. Full-package `bun run check` + `bun test` → green (only +new T1 tests change the count).

## DoD

`parseDependsOn` handles array/string/comma-list/absent (no zero-pad); `ticketCard()` emits `frontmatter.dependsOn` + `rel:"depends_on"` relations; existing `blocked-by` + `cites` emission unchanged; full suite green.

---

## Pre-implementation adjustments (after reading the real source)

**A — Branch already existed.** The plan's step 4 said `git checkout -b knowledge-pipeline/10-impl-staleness origin/main`. The branch **already existed** and was checked out at exactly `origin/main` (`c75cbf6a8a528ea4ba7418fc25357c417035200d`) with a clean tree. A `checkout -b` would have errored ("already exists"), so instead I verified `git rev-parse HEAD == origin/main` and proceeded. No deviation from the intended starting state.

**B — Test-file locations confirmed (no drift).** The plan said the parse/serializer tests are co-located `*.test.ts`; `find` confirms:
- `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-parse.test.ts`
- `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-serializer.test.ts`

Both use `node:test` `describe`/`it` + `node:assert/strict` — the plan's test code matches the files' idiom verbatim. The serializer test already imports `PlanningEffortSerializer, PlanningTicketSerializer` from `./planning-serializer.js`; the new describe reuses `PlanningTicketSerializer` (no new import needed).

**C — No signature drift.** The real source matches the plan's Step 3/4 anchors exactly:
- `planning-parse.ts`: `parseBlockedBy(raw: unknown): string[]` (number→zero-pad, string split on `[,\s]+`, array filter) is the pattern to mirror; `extractCitedPaths(body)` dedupes rooted paths; the import block is `import { parse as parseYaml } from "yaml";` (top).
- `planning-serializer.ts`: `ticketCard()` already builds `relations` from `blockedBy` + `citedPaths`, sets `frontmatter.blockedBy`, derives `graph` from `relations.length > 0`. The import block from `./planning-parse.js` lists `splitPlanningFrontmatter, extractTitle, extractResolutionGist, parseBlockedBy, extractCitedPaths` — `parseDependsOn` is added here. The `ticketCard()` anchors (`const citedPaths = …`, the `for (const path of citedPaths)` loop, and the `...(blockedBy.length > 0 ? { blockedBy } : {}),` frontmatter spread) are present exactly as the plan's Step 4 expects.

**D — `blocked by: 01` numeric coercion already exercised.** The plan's serializer-test md uses `blocked by: 01`; YAML core schema parses this as number `1`, and the existing `parseBlockedBy` number-branch zero-pads → `"01"` (already pinned by the fixture-based `08` test asserting `frontmatter.blockedBy === ["01"]`). The new test's `blocked-by`/`frontmatter.blockedBy` assertions therefore pass without touching `parseBlockedBy`. T1 changes nothing here.

**E — Baseline suite (captured on clean origin/main before T1 edits):** `1440 pass / 1 skip / 1 fail` across 124 files (1048 `expect()` calls). The single failure is the **known pre-existing date-aging time-bomb** `formatForSystemPrompt never emits memworth …` (UPSP §7 / ticket 04 regression-pin) — unrelated to T1; must remain the ONLY failure after T1.
