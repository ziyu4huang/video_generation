---
type: grilling
blocked by: []
status: closed
claimed: wayfind-session (2026-07-31)
resolved: 2026-07-31 (DO — smart per-file-budget curation + mandatory truncation flag)
---

# 04 — Decide: L2 large-diff smart curation (replace hard 200KB truncate)

## Question

Decide `do / defer / skip` + strategy for L2 reviewing **large changesets** without
losing coverage. Current behavior: `diffTextForReview` (`repo-diff.ts`) hard-slices
the diff to `200_000` chars — a large changeset gets truncated **mid-file**, and L2
(`model-review.ts` `buildPrompt`) reviews a ragged/partial diff, silently missing the
truncated tail.

Strategy fork:
- **(a) Smart curation** within the budget: per-file budget, drop vendored/generated
  paths, prioritize changed hunks over context — keep one model call, better coverage.
- **(b) Per-file fan-out**: spawn one L2 review per changed file (or small batches)
  instead of one call with the whole diff — full coverage, but N× model calls (cost;
  intersects the sibling effort's deferred rate-limit/concurrency work — see map "Not
  yet specified").
- **(c) Truncate-but-signal**: keep the truncate, but surface a ⚠ when truncation
  happened (L2 reviewed a partial diff) — pairs with sibling 06's visibility theme.
- Defer if real-world changesets rarely exceed the budget.

## Resolution (grilled 2026-07-31)

**Decision: DO — smart curation within budget + truncation flag as a mandatory floor.**

### Grounding (read `repo-diff.ts` + `watchdog.ts`)

- `diffTextForReview` ends with `parts.join("\n").slice(0, 200_000)` — a **flat
  hard-cut** on the whole joined string (tracked `git diff HEAD` + all untracked
  file bodies). Truncation can fall mid-file; files past the cut vanish entirely.
  L2 (`model-review.ts` `buildPrompt`) injects this raw into `<changeset>` with
  **no signal** that anything was dropped.
- **Fan-out rejected**: L2's prompt targets CROSS-FILE integration wiring
  ("implementer committed only the test file", "missed integration wiring
  (imports, registration, exports)"). A per-file L2 loses exactly that cross-file
  view, and multiplies model calls on every subagent dispatch.

### Grilled forks

- **Q1 strategy** → smart curation + signal floor (over fan-out / defer).
- **Q2 noise filter** → **conservative** (lockfiles + generated artifacts only;
  KEEP vendored-source — this repo edits vendor files via `vendor_patches.py`).

### Spec (handoff)

1. **Conservative noise filter** (before budgeting): drop `*.lock`, `bun.lock`,
   `package-lock.json`, `dist/**`, `build/**`, `*.min.*`, `*.map`. Do **NOT** drop
   vendored source (`**/vendor/**`, `vendor_patches.py` targets) — real edits here.
2. **Per-file budget**: distribute the 200K budget across remaining files —
   `perFileCap = max(FLOOR, 200_000 / N)`; cap each file's diff contribution at
   `perFileCap`, keep the head (git diff already centers on changed hunks). No
   single file monopolizes the budget.
3. **Truncation flag (mandatory floor)**: when curation drops ANY content (noise
   file skipped, OR file truncated by per-file cap, OR total over budget), set
   `truncated: true` + a note with counts (`droppedNoiseFiles`, `truncatedFiles`).
4. **Visibility (consistent with sibling 06's escalate-to-top philosophy)**:
   surface the flag in **both** `l2.note` **and** bump the top-level `summary`
   when truncation occurred (e.g. `watchdog: N concern(s); L2 reviewed truncated
   diff (M files affected)`).

### Acceptance criteria (for the implementer)

- (a) Small changeset (<200K, no noise) → behavior **unchanged** (no flag, full
  diff). No regression.
- (b) Large changeset (>200K) → L2 receives a curated per-file-budgeted diff,
  never a ragged mid-file cut; `truncated: true` + note set; summary bumped.
- (c) Changeset with lockfile/generated changes → dropped by noise filter, counted
  in note; budget spent on real code.
- (d) Vendored-source edits are **never** dropped by the noise filter
  ęcks (`vendor_patches.py` edits survive).

### Graduates / defers

- **New ticket 05** — separate L2 coverage bug discovered while grounding:
  `watchdog.ts` uses `tsJs.length ? tsJs : after.changedPaths` for L2's input, so
  when ANY TS/JS file changed, non-TS/JS **code** changes (Python etc.) are
  **invisible to L2** (mixed TS/JS+Python change → Python unseen). Distinct from
  truncation; its own grilling ticket.
- **Per-file fan-out as overflow** — deferred; curation handles the common case.
  Revisit only if real changesets exceed budget even after curation (rare).
- Map fog "L2 curation ↔ cost interaction" → **cleared** (chose curation = one
  call, not fan-out; the cost intersection is moot).
