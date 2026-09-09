# t01 — Machine-checked arc ledger + guard (RED proven on a duplicate-claim fixture)

## Goal

Arc numbers stop being protected by discipline. A committed
`.planning/arc-ledger.json` is the single registry of claimed arc numbers per
series; a wayfind guard test turns any duplicate claim (in-tree, or parallel
vs `origin/main`) into a red CI run. Historical duplicate numbers are encoded
as grandfathered entries — the guard looks forward, without lying about the
past.

## Files

- `.planning/arc-ledger.json` (new, committed) — header comment documents the
  claim procedure (see below).
- `bun-apps/s2-agent-ext-wayfind/src/arc-ledger.ts` (new) — pure logic:
  `loadLedger(root)`, `validateLedger(root, opts)`; no fs mutation.
- `bun-apps/s2-agent-ext-wayfind/tests/arc-ledger.test.ts` (new).
- `bun-apps/s2-agent-ext-wayfind/tests/fixtures/arc-ledger-duplicate/` (new) —
  synthetic tree: a ledger with two non-grandfathered entries claiming the
  same `(series, number)` at different paths, plus the two fixture map dirs
  those entries point at (minimal `map.md` files with matching frontmatter).
- `.planning/CONVENTIONS.md` — add the claim step (append entry at branch
  time; guard enforces; renumber = edit entry + note, never delete history).

## Ledger schema (version 1)

```json
{
  "version": 1,
  "adopted": "2026-09-10",
  "entries": [
    { "series": "self-arc", "number": 19,
      "path": ".planning/2026-09-10-self-arc-19", "status": "active",
      "claimedAt": "2026-09-10", "branch": "self-arc-19-loop-integrity",
      "mergedPr": null, "note": "first machine-checked claim" },
    { "series": "self-arc", "number": 14,
      "path": ".planning/2026-09-06-self-arc-14", "status": "done",
      "claimedAt": "2026-09-08", "grandfathered": true,
      "note": "pre-ledger historical claim; number shared with 2026-09-08-self-arc-14 (collision residue, shipped as-is)" }
  ]
}
```

Bootstrap: ONE entry per existing `.planning/<date>-self-arc-*/` dir — 19 dirs
measured 2026-09-10 (numbers 3–18; six share numbers pairwise: 13, 14, 15 ×2).
All pre-adoption entries get `grandfathered: true`; only arc-19's entry is a
live claim.

## Guard checks (validateLedger)

1. **Schema**: parses; required fields present; paths are under `.planning/`.
2. **Completeness**: every `.planning/<date>-self-arc-*/` dir has an entry
   (kills untracked claims); every entry's path exists.
3. **Frontmatter agreement**: entry.path's `map.md` frontmatter `effort`
   matches the folder name; entry `status` matches frontmatter `status`.
4. **Uniqueness (the rule)**: no duplicate `(series, number)` among entries
   WITHOUT `grandfathered`/`renumberedTo`. `grandfathered: true` is legal ONLY
   for `claimedAt <= adopted` (new claims can never opt out).
5. **origin/main cross-check** (the dual-arc-18 parallel-session class): when
   `git -C <root> show origin/main:.planning/arc-ledger.json` succeeds, any
   `(series, number)` ACTIVE in main claimed by a different path in this tree
   without a recorded renumber/supersede ⇒ FAIL. When origin/main (or its
   ledger) is unreachable ⇒ skip LOUDLY (stderr note), never silently.

## Steps

1. Read `tests/map-frontmatter.test.ts` FIRST — extend rather than duplicate
   any check it already owns (Fog note in map).
2. Commit A (RED): land `src/arc-ledger.ts` with schema/completeness/frontmatter
   checks but WITHOUT the uniqueness rule; land the fixture + test asserting
   the fixture is REJECTED. Run `bun test` in wayfind ⇒ test RED (validate
   passes the duplicate). Receipt the red run verbatim to
   `.planning/2026-09-10-self-arc-19/evidence/t01-red-bar.txt` (t04 commits
   it — capture it now).
3. Commit B (GREEN): implement the uniqueness rule + grandfathering
   constraints + origin/main cross-check ⇒ test GREEN, and the REAL tree
   validates clean (bootstrap ledger committed in this commit or A).
4. `bun run --cwd bun-apps/s2-agent-ext-wayfind check && bun run --cwd
   bun-apps/s2-agent-ext-wayfind typecheck && bun test` (wayfind's canonical
   gate triple) plus devops contract tests stay green.

## Acceptance

- Guard test green on the real tree; fixture-REJECTED assertion permanent in
  CI (weakening the rule re-reddens).
- Red-bar receipt exists (the red run happened BEFORE the fix was trusted).
- Ledger committed with arc-19 claimed at branch time; six grandfathered
  entries carry notes naming their collision partners.
- No shipped behavior touched (new src file imported only by tests).

## Out of scope

- Auto-claim tooling or git hooks (claim stays an explicit append).
- Renaming/deleting the duplicate historical folders.
- Ledger entries for non-self-arc series (schema supports `series`; only
  self-arc is populated).
