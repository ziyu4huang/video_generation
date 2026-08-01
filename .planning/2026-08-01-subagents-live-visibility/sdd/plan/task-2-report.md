# Task 2 — Report (NEEDS_CONTEXT)

**Status:** NEEDS_CONTEXT — the brief's verbatim **test code** and verbatim **render
code** are mutually inconsistent. The render half is implemented verbatim and is
correct (35/35 existing tests pass, tsc clean), but 3 of the 4 new tests cannot
pass with the brief's code as written. **Nothing committed.** Working-tree
changes left as evidence. Awaiting a one-line decision (see
[Recommended resolution](#recommended-resolution)) before committing.

---

## What I implemented

`src/subagent-viewer.ts` — replaced the Running-section loop inside `renderList`
**verbatim per the brief (Step 3)**: precompute `batchCounts`, track `lastBatch`,
emit a `▼ subagents batch · k running` header before each batch group's first
child, indent grouped children (`    …`), and keep the ungrouped branch
byte-identical to the original (` …`). `entries()`, cursor, filter, cap,
`enterFollow`, and the completed section are **untouched**.

`tests/subagent-viewer.test.ts` — appended the brief's 4 tests **verbatim
(Step 1)**, unchanged.

---

## TDD evidence

### RED (Step 2) — before render change
```
$ ( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts -t "batch children under one header" )
AssertionError: one header for the whole batch   0 !== 1   (line 616)
(fail) viewer groups batch children under one header …   1 fail   ← expected RED (no header yet)
```

### GREEN attempt (Step 4) — after verbatim render change
```
$ ( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts -t "batch" )
(fail) viewer groups batch children under one header …           AssertionError: both children present (line 618)
(fail) ungrouped running entries … render flat — no batch header  AssertionError (line 626)
(fail) mixed: ungrouped runs flat, batch children grouped …      AssertionError: ungrouped run stays flat (line 637)
(pass) a batch child is still selectable + followable …
 1 pass, 3 fail
```
Full file (proves no regression):
```
$ ( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts )
 35 pass, 3 fail    ← the 3 failures are ALL new `doing <taskPreview>` tests; every existing test still passes
```
tsc:
```
$ ( cd bun-apps/pi-agent-ext-subagent && bunx tsc --noEmit ) ; echo "tsc exit: $?"
tsc exit: 0
```

---

## Root cause of the conflict (the brief doesn't address this)

All 3 failures are the **same** root cause, and it is **independent of the Task 2
grouping work**:

1. The shared helper `runningEntry(id, overrides)` sets
   `history: [{ role: "assistant", kind: "toolCall", toolName: "read", text: … }]`.
2. The brief's render code (both branches) builds the row with
   `latestAction: summarizeLatestAction(r.history) ?? truncateToWidth(r.taskPreview, 40)`.
   For that history, `summarizeLatestAction` returns the non-null string `▸ read`.
3. `renderActivityRow` renders **one** tail — `latestAction` always wins over
   `detail`/`taskPreview`. So the row shows `▸ read`, **never** the taskPreview
   `doing <id>`.

Empirically, a single ungrouped running entry renders (identity theme):
```
▶ ● implementer x/flash · 1.5s · 1 call — ▸ read
```
`doing solo1` appears **nowhere**. This is the existing, established behavior —
the already-passing test *"viewer Running section shows the agent's latest tool
call instead of the static task preview once it has history"* asserts exactly
this (`▸ read` wins).

Consequence: the brief's assertions
`out.includes("doing solo1")` / `out.includes("doing batchX:0")` / `out.includes("doing solo")`
**cannot** pass with the brief's own verbatim render code. They fail even with
**zero** render changes (verified at RED for the "ungrouped" test, line 626).
The 4th test (cursor/follow, asserts `→ read`) passes — which is also the proof
that the render implementation itself is correct and the cursor/follow path is
intact.

This puts two hard constraints from the brief/task-description in direct conflict:
- **Global constraint:** "The new tests assert on substrings (`subagents batch`,
  `k running`, `doing batchX:0`)" → `doing batchX:0` MUST appear.
- **Render must stay byte-identical for ungrouped** + **existing tests must pass
  unmodified** → `latestAction` (`▸ read`) wins; `taskPreview` never renders when
  history exists.

Both cannot hold with verbatim test entries. The brief does not address this.

---

## Recommended resolution (smallest, intent-preserving)

**Option A (recommended): add `history: []` to the 4 grouping-test `runningEntry`
overrides.** With empty history, `summarizeLatestAction` returns `undefined`, so
the `?? truncateToWidth(r.taskPreview, 40)` fallback renders the taskPreview —
making `doing solo1` / `doing batchX:0` appear in **both** branches. This:
- satisfies the global constraint (`doing batchX:0` appears),
- keeps the render code **100% verbatim**,
- keeps every existing test green (no behavior change — just different fixture
  inputs for the new tests),
- needs no change to `runningEntry` itself,
- and is the only reading consistent with the test comment "both children
  present" (otherwise both children render the identical `▸ read` and are
  indistinguishable).

Concretely, the four calls become:
```ts
runningEntry("batchX:0", { batchId: "batchX", history: [] }),
runningEntry("batchX:1", { batchId: "batchX", history: [] }),
// and for the ungrouped/mixed tests:
runningEntry("solo1", { history: [] }), runningEntry("solo2", { history: [] }),
runningEntry("solo", { history: [] }),
```

Alternatives considered and rejected:
- **B.** Make the grouped branch render `detail: taskPreview` instead of
  `latestAction`. Rejected: deviates from verbatim render, AND still doesn't fix
  the ungrouped `doing solo` assertion (ungrouped stays byte-identical → `▸ read`).
- **C.** Change `doing X` assertions to `▸ read`. Rejected: violates the global
  constraint, and makes "both children present" meaningless (identical strings).
- **D.** Keep everything verbatim, ship failing tests. Rejected: violates
  "existing tests must pass" spirit and leaves 3 red.

---

## Files changed (uncommitted)

```
 M bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts        (+43/-11, render verbatim per brief)
 M bun-apps/pi-agent-ext-subagent/tests/subagent-viewer.test.ts (+49, 4 tests verbatim per brief)
```
Nothing staged, nothing committed. `.planning/…` dirs are pre-existing untracked.

## Self-review

- **Render completeness:** header emitted once per group, count = in-flight
  members at render time, children indented, ungrouped flat & byte-identical.
  `lastBatch` reset on any ungrouped entry so a second batch group re-headers.
- **No regression:** 35/35 existing viewer tests pass with the render change.
- **Cursor/filter/cap/follow untouched** (test 4 green proves follow still works).
- **tsc clean** (exit 0). No new imports needed.
- **YAGNI:** no helper extraction (per the brief's explicit "do NOT factor"
  instruction); the intentional near-duplication is preserved for Task 3.
- **Output pristine:** only the 2 named files touched; no stray probe files
  (verified created+removed in `/tmp`-style scratch, then in-package scratch
  deleted).

## Concerns

1. **Primary:** the verbatim test/render conflict above — needs the user's nod on
   Option A (or an alternate) before commit. This is the only blocker.
2. Minor: header line is visual-only / non-selectable in this task (correct per
   brief — Task 3 makes it selectable + collapsible). No concern, just noting.

---

# Task 2 — Report (DONE) — second implementer

**Status:** DONE — committed `80380fca`. The controller's Option-A resolution
(add `history: []` to the 3 grouping tests; leave test 4 on default history)
resolved the prior conflict exactly as described. Render code is **unchanged**
from the prior attempt — it was already verbatim per the brief Step 3.

## What changed vs the prior (NEEDS_CONTEXT) attempt

- **`src/subagent-viewer.ts`** — **identical** to the prior attempt's verbatim
  Step-3 render change (precompute `batchCounts`, track `lastBatch`, emit the
  `▼ subagents batch · k running` header before each group's first child, indent
  children `    …`, ungrouped branch byte-identical to the original ` …`). I kept
  it as-is after re-verifying (via `git diff` against HEAD) that it matches the
  brief byte-for-byte and that 34/34 pre-existing viewer tests + 4 new ones pass.
  No reason to churn a correct verbatim application.
- **`tests/subagent-viewer.test.ts`** — applied the controller's resolution to
  the 3 grouping tests only (test 4 left verbatim):
  - Test 1 (groups batch children): `runningEntry("batchX:0", { batchId: "batchX", history: [] })` and same for `:1`.
  - Test 2 (ungrouped render flat): `runningEntry("solo1", { history: [] })`, `runningEntry("solo2", { history: [] })`.
  - Test 3 (mixed): `history: []` on ALL three calls (`solo`, `batchX:0`, `batchX:1`) — per the controller's "add `history: []` to EACH `runningEntry(...)` call in those tests".
  - Test 4 (selectable + followable): **unchanged** — keeps the default
    `read`-toolCall history so its `assert.ok(out.includes("→ read"))` follow-trace assertion still holds.

Rationale (confirmed empirically): with empty history, `summarizeLatestAction([])`
returns `undefined`, so `latestAction: summarizeLatestAction(r.history) ??
truncateToWidth(r.taskPreview, 40)` falls through to the taskPreview, letting
`doing batchX:0` / `doing solo1` appear in BOTH render branches. The ungrouped
branch stays byte-identical, so all pre-existing Running-section tests (incl.
the one asserting `▸ read` wins when history exists) stay green unmodified.

## TDD evidence

### RED (reproduced at the prior attempt — Step 2 of brief)
The 3 grouping tests failed with the verbatim (no `history: []`) fixtures,
even with the render change applied, because `latestAction` (`▸ read`) overrode
`taskPreview`. This is the exact conflict the prior report documented.

### GREEN (after the Option-A fixture fix — Step 4)
```
$ ( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts )
  38 pass, 0 fail     ← 34 pre-existing + 4 new grouping tests
```
The 4 new tests:
- (pass) viewer groups batch children under one header in the Running section
- (pass) ungrouped running entries (no batchId) render flat — no batch header
- (pass) mixed: ungrouped runs flat, batch children grouped under one header
- (pass) a batch child is still selectable + followable (cursor unaffected by the header)

### Full pre-commit suite + tsc
```
$ ( cd bun-apps/pi-agent-ext-subagent && bun test )
  370 pass, 0 fail   (145 expect() calls, 33 files)
$ ( cd bun-apps/pi-agent-ext-subagent && bunx tsc --noEmit ) ; echo "tsc exit: $?"
  tsc exit: 0
```

## Files

Committed in `80380fca` (only the 2 named files; no `git add -A`):
```
 bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts   | 54 ++++++++++++++++-----
 bun-apps/pi-agent-ext-subagent/tests/subagent-viewer.test.ts | 49 ++++++++++++++++
 2 files changed, 92 insertions(+), 11 deletions(-)
```

Commit subject (verbatim per brief):
`feat(subagents): group batch children under a header in /subagents Running section`

Working tree post-commit: only the pre-existing untracked `.planning/…` dirs
remain; the 2 source/test files are clean. No stray scratch files.

## Self-review

- **Render verbatim:** the Running-section loop matches brief Step 3 byte-for-byte
  (re-verified via `git diff` vs `b9d61db9`). Grouping is render-only:
  `entries()`, cursor, filter, cap, `enterFollow`, completed-section all
  **unchanged** (cursor/follow proven by green test 4).
- **Ungrouped branch byte-identical** to the original — pre-existing Running-section tests green unmodified.
- **`lastBatch` reset** on any ungrouped entry, so a second batch group re-headers correctly.
- **Header is visual-only / non-selectable** in this task (correct per brief; Task 3's job).
- **tsc clean** (exit 0); no new imports needed (`summarizeLatestAction`,
  `renderActivityRow`, `ActivityRow`, `truncateToWidth` already imported).
- **YAGNI:** no helper extraction — the brief's intentional near-duplication
  between the two branches is preserved for Task 3.
- **Output pristine:** only the 2 named files touched.

## Concerns

None. The controller's Option-A resolution matched the prior report's
recommended fix exactly; both the conflict and its resolution were correctly
characterized. Render code required zero changes from the prior attempt.
