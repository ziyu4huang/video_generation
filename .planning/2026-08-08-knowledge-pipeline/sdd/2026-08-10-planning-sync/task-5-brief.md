### Task 5: conflict-marker detection (effort flag, surfaced in the receipt)

**Files:**
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/git-ops.ts` (add `hasMergeConflictMarkers(content)` — the merge-marker home, beside `MID_MERGE_SENTINELS`)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts` (scan md bytes in `mirrorPlanningToStore`; populate `conflictMarkerEfforts`; add the field to `WalkAndIngestReceipt` + both returns)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/src/store/planning-id.ts` (add a tiny `effortOfPlanningId(id)` helper — or reuse `parsePlanningPath`; see Step 4)
- Modify: `bun-apps/pi-agent-ext-hermes-memory/__tests__/walk-and-ingest.test.ts` (conflict-marker test)

> **Design note (pinned):** `git-ops.isMidMerge(gitDir)` is **repo-state** (true when sentinel files exist in `.git/` — i.e. a merge/rebase is actively unresolved, repo-wide). The grill asks for a **per-effort** flag ("if the merge left conflict markers in the md"). The precise per-effort signal is conflict markers IN the md **file bytes** (`<<<<<<<`/`=======`/`>>>>>>>`), which is a DIFFERENT signal from `isMidMerge`. 09 therefore adds a pure `hasMergeConflictMarkers(content)` helper in `git-ops.ts` (the merge-marker idiom's home, next to `MID_MERGE_SENTINELS`) and scans each planning file's bytes. `isMidMerge` is left UNCHANGED and remains available as a complementary repo-level check for future surfacing — 09 does NOT alter the `GitOps` interface or `realGitOps`.

**Interfaces:**
- Produces:
  - `hasMergeConflictMarkers(content: string): boolean` (git-ops.ts) — true when the text contains git conflict-marker lines.
  - `WalkAndIngestReceipt.conflictMarkerEfforts: string[]` — effort slugs whose md contains unresolved conflict markers (for human review; NOT a query, NOT blocking).

- [ ] **Step 1: Write the failing tests**

Create a focused git-ops test for the helper (or append to an existing git-ops test file if one exists): `src/git-ops-conflict-markers.test.ts`:
```ts
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { hasMergeConflictMarkers } from "./git-ops.js";

describe("hasMergeConflictMarkers", () => {
  it("flags a full conflict-marker block", () => {
    const md = "# 08 — x\n\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n";
    assert.equal(hasMergeConflictMarkers(md), true);
  });
  it("flags a lone opening marker (mid-resolution)", () => {
    assert.equal(hasMergeConflictMarkers("<<<<<<< HEAD\nbody"), true);
  });
  it("does NOT flag normal md that merely contains seven chars", () => {
    // '=======' on its own line is a conflict divider, but the word "conflict"
    // or a horizontal-rule in body text must NOT trip a false positive.
    assert.equal(hasMergeConflictMarkers("# title\n\nsome ======= text here\n"), false);
    assert.equal(hasMergeConflictMarkers("---\nstatus: active\n---\n# map\n"), false);
  });
  it("is false for clean planning md", () => {
    assert.equal(hasMergeConflictMarkers("# 08 — x\n\n## Resolution\nClean.\n"), false);
  });
});
```
Append the receipt test to `__tests__/walk-and-ingest.test.ts`:
```ts
describe("walkAndIngest — conflict-marker flag (09-impl T5)", () => {
  it("surfaces an effort with unresolved merge markers in its ticket md", async () => {
    const root = mkdtempSync(join(tmpdir(), "pconf-"));
    const mem = mkdtempSync(join(tmpdir(), "pconf-mem-"));
    try {
      const effort = "conflict-effort";
      mkdirSync(join(root, ".planning", effort, "tickets"), { recursive: true });
      writeFileSync(join(root, ".planning", effort, "tickets", "01-x.md"),
        "---\ntype: task\nstatus: closed\n---\n# 01 — x\n\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> b\n");
      const r = await walkAndIngest(root, { memoryDir: mem });
      assert.ok(r.conflictMarkerEfforts.includes(effort), "effort must be flagged for human review");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(mem, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/git-ops-conflict-markers.test.ts __tests__/walk-and-ingest.test.ts )`
Expected: FAIL — `hasMergeConflictMarkers` not exported; `conflictMarkerEfforts` not on the receipt (or always empty).

- [ ] **Step 3: Add `hasMergeConflictMarkers` to git-ops.ts**

In `src/git-ops.ts`, add (next to `MID_MERGE_SENTINELS`):
```ts
/** Git conflict-marker line patterns (the `<<<<<<<`, `=======`, `>>>>>>>`
 *  markers `git merge` writes when it cannot auto-resolve). This is a FILE-CONTENT
 *  signal (per-file), distinct from {@link GitOps.isMidMerge} which is REPO-STATE
 *  (sentinel files in `.git/`, repo-wide). Anchored to line starts to avoid false
 *  positives on normal prose (a bare `=======` inside a sentence is not a divider). */
const CONFLICT_MARKER_LINE_RE = /(^|\n)(<<<<<<< |>>>>>>> |^=======$)/;
// Split for clarity: opening/closing are space-suffixed (`<<<<<<< HEAD`); the
// divider is the whole-line `=======`.
const CONFLICT_MARKER_RE = /(^|\n)(<<<<<<<[^\n]*|>>>>>>>[^\n]*|\n=======(?=\n|$))/;

/** True when `content` contains unresolved git conflict markers. Pure; no IO. */
export function hasMergeConflictMarkers(content: string): boolean {
  return CONFLICT_MARKER_RE.test(content);
}
```
> Use the single `CONFLICT_MARKER_RE` (the `CONFLICT_MARKER_LINE_RE` line above is an explanatory sketch — delete it and keep only `CONFLICT_MARKER_RE`). The regex matches an opening (`<<<<<<<` …) or closing (`>>>>>>>` …) marker OR a whole-line divider (`\n=======\n`), so it catches a full block AND a lone opening marker, while NOT matching `=======` mid-sentence. Verify against the Step-1 false-positive cases during implementation; tune anchors as needed so "some ======= text here" stays false.

- [ ] **Step 4: Populate `conflictMarkerEfforts` in the mirror**

In `src/walk-and-ingest.ts`, add the import:
```ts
import { hasMergeConflictMarkers } from "./git-ops.js";
```
In `mirrorPlanningToStore`, for each planning file (after reading `bytes`, before/after deserialize), detect + collect the effort slug. Reuse `parsePlanningPath(abs)` (already imported in T4) to derive the effort:
```ts
      // 09-impl T5: flag efforts whose md has unresolved merge markers (human review).
      if (hasMergeConflictMarkers(bytes)) {
        const info = parsePlanningPath(abs);
        if (info && !conflictMarkerEfforts.includes(info.effort)) {
          conflictMarkerEfforts.push(info.effort);
        }
      }
```
(The mirror STILL mirrors the card — conflict markers do NOT block the mirror; the markers are just bytes the serializer parses around. The flag is advisory.) Add `conflictMarkerEfforts: string[]` to the `WalkAndIngestReceipt` interface (if not added in T3) and to BOTH return objects in `walkAndIngest` (the `ok:false` early return gets `conflictMarkerEfforts: []`; the `ok:true` return gets `conflictMarkerEfforts`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun test src/git-ops-conflict-markers.test.ts __tests__/walk-and-ingest.test.ts )`
Expected: PASS.

- [ ] **Step 6: Full package regression + type-check + commit**

Run: `( cd bun-apps/pi-agent-ext-hermes-memory && bun run check && bun test )`
Expected: all green.
```bash
git -C <WT> add bun-apps/pi-agent-ext-hermes-memory/src/git-ops.ts bun-apps/pi-agent-ext-hermes-memory/src/git-ops-conflict-markers.test.ts bun-apps/pi-agent-ext-hermes-memory/src/walk-and-ingest.ts bun-apps/pi-agent-ext-hermes-memory/__tests__/walk-and-ingest.test.ts bun-apps/pi-agent-ext-hermes-memory/src/store/planning-id.ts
git -C <WT> commit -m "feat(knowledge-pipeline): conflict-marker detection — effort flag in ingest receipt (09-impl T5)"
```
> Only `git add` the `planning-id.ts` path if T5 actually modified it (Step 4's "or reuse parsePlanningPath" — prefer reusing `parsePlanningPath`, so `planning-id.ts` is likely UNCHANGED and should NOT be staged). Drop it from the `git add` list if unmodified.

**DoD:** a ticket md with conflict markers → its effort slug in `receipt.conflictMarkerEfforts`; clean md → not flagged; mirror still runs (non-blocking); `isMidMerge`/`GitOps` unchanged; full suite green.

---

