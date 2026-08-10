# Task 5 Report — conflict-marker detection (effort flag in ingest receipt)

**Branch:** `knowledge-pipeline/09-impl-planning-sync`
**Parent:** `ef5b3f88` (T4 — delete reconciliation)
**Commit subject:** `feat(knowledge-pipeline): conflict-marker detection (effort flag) (09-impl T5)`
**Brief:** `task-5-brief.md` (verbatim source of truth — regex shape, helper signature, populate point, DoD).

## What was implemented

A **pure, additive** per-effort conflict-marker signal, surfaced for human review on the
ingest receipt. T5 is a pure **POPULATE-change** over T3's reserved field — nothing in the
T3 INSERT/UPDATE/skip mirror logic, the `WalkAndIngestReceipt` shape, or the repo-state
`isMidMerge` path was touched.

1. **`src/git-ops.ts`** — added `CONFLICT_MARKER_RE` + `hasMergeConflictMarkers(content)`
   beside `MID_MERGE_SENTINELS`. A pure FILE-CONTENT scan for the git merge-marker idiom,
   distinct from `GitOps.isMidMerge` (REPO-STATE — sentinel files in `.git/`).
2. **`src/walk-and-ingest.ts`** — in `mirrorPlanningToStore`, after reading each planning
   md's bytes (before deserialize), scan with `hasMergeConflictMarkers` and push the effort
   slug (via the already-imported `parsePlanningPath`) into the T3-reserved
   `conflictMarkerEfforts[]`. Deduped by slug; the mirror STILL runs (advisory, non-blocking).

`src/store/planning-id.ts` is **UNCHANGED** — `parsePlanningPath(abs)` already yields
`info.effort` cleanly, so no new helper was needed (brief Step 4's "or reuse parsePlanningPath"
branch). It is therefore NOT staged.

## Key diff hunks

### `src/git-ops.ts` (additive — beside `MID_MERGE_SENTINELS`, before `realGitOps`)
```ts
const CONFLICT_MARKER_RE = /(^|\n)(<<<<<<<[^\n]*|>>>>>>>[^\n]*|={7,}(?=\n|$))/;

export function hasMergeConflictMarkers(content: string): boolean {
  return CONFLICT_MARKER_RE.test(content);
}
```

### `src/walk-and-ingest.ts` (populate point in `mirrorPlanningToStore`)
```ts
      // 09-impl T5: flag efforts whose md has unresolved merge markers (human
      // review). Advisory only — the mirror STILL runs on the bytes (the markers
      // are just body text the serializer parses around). Dedup by effort slug.
      if (hasMergeConflictMarkers(bytes)) {
        const info = parsePlanningPath(abs);
        if (info && !conflictMarkerEfforts.includes(info.effort)) {
          conflictMarkerEfforts.push(info.effort);
        }
      }
```

## Regex deviation from the brief (documented, minimal, justified)

The brief's literal `CONFLICT_MARKER_RE` —
`/(^|\n)(<<<<<<<[^\n]*|>>>>>>>[^\n]*|\n=======(?=\n|$))/` — has an anchoring defect in the
divider branch: the outer `(^|\n)` plus the inner `\n=======` **double-counts** the leading
newline, so a whole-line `=======` divider is only matched when preceded by a **blank line**
(`\n\n=======`). A normal divider `ours\n=======\ntheirs` (divider on its own line, no blank
line before it) is NOT matched. The brief itself acknowledges this with the escape hatch
*"tune anchors as needed so 'some ======= text here' stays false."*

The task header's hard requirement contradicts the literal regex: *"The `=======` divider
MUST match as a WHOLE LINE (7+ `=` on its own line), so normal prose like
`some ======= text here` is NOT flagged."* The literal regex does not satisfy "match as a
whole line"; it satisfies only "match when preceded by a blank line."

**Resolution (chosen to satisfy the header's MUST and all test cases):** the divider branch is
`={7,}(?=\n|$)` — i.e., 7+ `=` immediately after a line start (`^` or `\n`) and immediately
followed by `\n`/end. This is the author's clear intent (a single line-start anchor), with the
duplicate `\n` removed and `=======` generalized to `={7,}` per the header's "7+" wording.

Verification against every brief false-positive / true-positive case:

| Input | Literal regex | Tuned regex | Expected |
|---|---|---|---|
| full block `…<<<<<<< HEAD\n…\n=======\n…\n>>>>>>> branch\n` | true (via `<<<`) | true (via `<<<`) | **true** |
| lone opening `<<<<<<< HEAD\nbody` | true | true | **true** |
| whole-line divider `# t\nours\n=======\ntheirs\n` (no `<<<`/`>>>`) | **FALSE (defect)** | **true** | **true** |
| `# title\n\nsome ======= text here\n` | false | false | **false** |
| frontmatter `---\nstatus: active\n---\n# map\n` | false | false | **false** |
| clean md `# 01 — x\n\n## Resolution\nClean.\n` | false | false | **false** |

The extra true-positive case (whole-line divider without `<<<`/`>>>`) is captured by an
additional focused test (`git-ops-conflict-markers.test.ts` → "flags a whole-line =======
divider even without <<< / >>>") which the literal regex would FAIL. All brief-mandated cases
remain green under the tuned regex. This is the single deliberate deviation; it is narrower
than the brief's (corrects an objective double-counting bug) and is covered by tests.

## TDD evidence

**RED (Step 3)** — `bun test src/git-ops-conflict-markers.test.ts __tests__/walk-and-ingest.test.ts`:
- `src/git-ops-conflict-markers.test.ts`: `SyntaxError: Export named 'hasMergeConflictMarkers'
  not found` (function absent).
- walk-and-ingest T5 case: `AssertionError: effort must be flagged for human review`
  (`r.conflictMarkerEfforts.includes(effort)` → false; receipt stays `[]`).
- 10 pass / 2 fail / 1 error.

**GREEN (Step 5)** — same command after implementation: **16 pass / 0 fail**.

## Full gate (Step 6 — run ONCE)

`( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`
- `tsc --noEmit` → **clean** (no errors).
- `bun test` → **1430 pass / 1 skip / 1 fail**.

The single failure is the **known pre-existing** ticket-04 time-bomb, unrelated to this work:
`formatForSystemPrompt never emits memworth (memory + failure blocks — regression pin)`
(`tests/store/memory-store.test.ts:2630`). Baseline-after-T4 was **1424 pass / 1 skip / 1 fail**;
the +6 passing = the 6 new T5 tests (5 in `git-ops-conflict-markers.test.ts` + 1 walk-and-ingest
case). **Zero new failures; zero regressions.**

## Self-review

- **Additive only.** `git-ops.ts`: 18 inserted, 0 deleted (new const + export between
  `MID_MERGE_SENTINELS` and `realGitOps`). `walk-and-ingest.ts`: 10 inserted, 0 deleted
  (1 import + 1 populate block). No T3 mirror logic, no receipt shape change.
- **`isMidMerge` / `GitOps` interface / `realGitOps` byte-unchanged.** Confirmed by
  `git diff src/git-ops.ts`: the only hunk is an insertion between `MID_MERGE_SENTINELS`
  (ends `] as const;`) and `realGitOps`. The `GitOps` interface block (earlier in file),
  `isMidMerge` (inside `realGitOps`), and `MID_MERGE_SENTINELS` itself are untouched.
  `hasMergeConflictMarkers` is NOT added to the `GitOps` interface and is NOT wired into
  `isMidMerge` — it is a standalone pure export.
- **Non-blocking.** The populate block runs in `mirrorPlanningToStore` before deserialize;
  the deserialize/INSERT/UPDATE/skip path proceeds regardless. Test proves the conflicted
  ticket is still mirrored into the DB (`planningMirrored >= 1` + `getCard` matches `/ours/`).
- **Deduped by effort slug** (`!conflictMarkerEfforts.includes(info.effort)`), so a multi-file
  effort is flagged once.
- **`planning-id.ts` unmodified** → not staged (correct per brief's "prefer reusing
  parsePlanningPath" branch).
- **DoD met:** conflicted ticket md → effort slug in `receipt.conflictMarkerEfforts`;
  clean md → not flagged; mirror still runs (non-blocking); `isMidMerge`/`GitOps` unchanged;
  full suite green (modulo the 1 known pre-existing failure).

## Concerns

- **Regex anchor deviation** (described above). The literal brief regex contains a
  double-`newline` defect that would fail the header's "whole line" MUST and the added
  whole-line-divider test. The tuned regex corrects it and passes all brief cases plus the
  extra true-positive. Flagging for the grill's awareness in case the verbatim form was
  load-bearing for an external contract (it is not, per the DoD's own test set).

## Files changed

- `bun-apps/pi-agent-ext-hermes-memory/src/git-ops.ts` (+18, additive)
- `bun-apps/pi-agent-ext-hermes-memory/src/git-ops-conflict-markers.test.ts` (new, focused)
- `bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts` (+10, additive)
- `bun-apps/pi-agent-ext-hermes-memory/__tests__/walk-and-ingest.test.ts` (+32, new T5 describe)
