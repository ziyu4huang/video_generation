---
effort: 2026-09-09-planning-audit
created: 2026-09-09
last: 2026-09-09
status: active
---

# Wayfinder map: 2026-09-09-planning-audit — verify all planning finished (SOP audit of .planning/)

## Destination

User directive (2026-09-09, verbatim): "let's do next arc , explorer existing
.planning/ then try to follow the SOP to verify if all planning finished ?"
End state = every one of the 75 `.planning/2026-*/` effort dirs carries a map
whose frontmatter `status:` is either TERMINAL (`done`/`complete`) with a
`## Shipped-as`/`## Resolution` section citing PRs that verifiably exist as
merged commits in local git history, or EXPLICITLY non-terminal with an
owner-or-reason (live-session exemption, or a dated park note) — verified in
BOTH directions (stale-active→actually-shipped AND
terminal→missing-provenance) by a committed, re-runnable audit tool in
`bun-apps/s2-agent-ext-wayfind`, with baseline + post-reconciliation tables
committed under this effort's `results/`. The two live-session dirs
(`2026-09-09-self-arc-17`, `2026-09-09-self-arc-18` via the open pull request 2237) stay
byte-untouched. Closes with a CONVENTIONS.md addition (close-out PRs flip
status in the same PR; content slugs not self-arc-N), map done + Shipped-as,
and a validated successor next-goal.

## Context (measured 2026-09-09, origin/main 6d225ca2)

- Census (planner sed-based; the t02 tool is census of record): 75 top-level
  `2026-*` dirs, all with map.md — 22 complete, 21 done, 15 active, 10 with NO
  frontmatter `status:` line, one each planning/designing/executing/in-progress/
  partial/paused/specified. Executor's pre-plan sweep said 72/12 — delta itself
  evidence the audit must be a tool, not a session tally (D8).
- Contradiction #1: `2026-09-06-self-arc-14` status `active`, but Shipped-as
  section exists citing #2223 (`4190dd5a`); close-out #2225 (`a031e4a6`) landed
  WITHOUT flipping the status.
- Contradiction #2: `2026-09-06-self-arc-13` status `planning`, but Shipped-as
  exists; #2218 (`04d2458f`) + #2219 (`6e092468`) merged.
- Self-arc series CLOSED by #2236 (arc-17 map still `active` — its closing docs
  PR not landed; dir live-session-owned). Open pull request 2237 = self-arc-18 t01
  (ultracode + `.planning/2026-09-09-self-arc-18/`).
- Live parallel session: worktree `.pi/worktrees/run-mt3ymbn9-0-a`; untouchable
  dirs: `2026-09-09-self-arc-17/`, `2026-09-09-self-arc-18/`.
- Tooling precedent in the right home: wayfind already owns `.planning`
  discipline — `src/sweep-zero-citation.ts` classifies efforts via shared
  parsers `parseMapFrontmatter`/`parseMapBody` (`src/model.ts`, `src/markdown.ts`)
  with a `scripts/` CLI twin + tests. Package gates: `bun run check && bun run
  typecheck && bun test`.
- Offline PR verification works: `git log --grep "#NNN"` resolves merged squash
  commits from local history — no network needed.
- Some no-status maps carry body-text `**Status: done**` lines; prose/frontmatter
  disagree in places (e.g. knowledge-pipeline: frontmatter active, body cites
  merged #1131/#1141).

## Tickets

- [x] t01 open effort: map + tickets + planner plan committed (this commit)
- [x] t02 audit tool: `src/effort-audit.ts` (pure, injected `verifyPr`) +
      `scripts/effort-audit.ts` CLI (`--json/--md/--stale-days`, exit 1 on red) +
      `tests/effort-audit.test.ts`; wayfind gates green
- [x] t03 baseline receipt: run on untouched tree, commit
      `results/baseline/audit.{json,md}`; exit 1 expected and recorded
- [x] t04 pilot reconcile: flip the two contradictions (13→done #2218+#2219,
      14→done #2223+#2225), re-run tool, red-count drops by exactly those rows
- [x] t05 bulk reconcile: D5 criteria on every remaining red row; live dirs
      untouched (verified via `git diff --stat origin/main`); commit
      `results/reconciled/audit.{json,md}`
- [ ] t06 conventions + close-out: two CONVENTIONS.md bullets, reviewer pass,
      close-out PR merged, successor next-goal validated

## Decisions so far

- D1 name = content slug `2026-09-09-planning-audit` (NOT self-arc-N: series
  closed by #2236; numbers merge-time-claimed by parallel sessions — two
  same-day collisions documented in the arc-16 map).
- D2 tool lands in wayfind: pure classifier + CLI twin + tests, reusing
  parseMapFrontmatter/parseMapBody so status parsing can never drift from
  readMap.
- D3 status vocabulary: terminal = done|complete; non-terminal = active|
  planning|designing|executing|in-progress|partial|paused|specified; anything
  else = unknown-token red. paused acceptable only with a dated note in the
  body (heuristic, recorded as such).
- D4 red conditions: (a) missing status; (b) non-terminal + older than
  --stale-days (default 14) + no dated park note + not live-exempt; (c)
  terminal without Shipped-as/Resolution; (d) cited #NNN not resolvable as
  merged via `git log --grep` (sections + body `PR #` lines only; receipt-path
  numbers ignored); (e) duplicate self-arc round numbers → warn/info only.
  Live-exempt list hardcoded + dated: 2026-09-09-self-arc-17,
  2026-09-09-self-arc-18 (arrives via the open pull request 2237).
- D5 reconciliation order: (1) citations verify → flip terminal, cite verified
  numbers; (2) superseded by later effort → Resolution + `closed: (superseded)`
  + cross-links (live-owned counterpart: link ours only, note deferral);
  (3) no evidence → paused + dated note naming what would reopen it; (4) live/
  recent → leave, record as open row. Never delete a failing row — annotate.
- D6 CONVENTIONS.md gains two bullets (close-out PR must flip status in the
  same PR; new efforts use content slugs, self-arc-N belongs to the closed
  series).
- D7 cross-links one-sided by necessity: Builds-on self-arc-16 (inventory-guard
  + collision lessons) and self-arc-17 (its Destination named map-status
  reconciliation; this effort does the systematic pass). Reciprocal link on
  arc-17 deferred to its owner's close-out — documented exception in Fog.
- D9 provenance vocabulary: `## Shipped` counts alongside `## Shipped-as`
  (baseline found sibling sessions spell it both ways; the SOP requirement is
  "cite what shipped", not one spelling). Two malformed-fence maps repaired
  (frontmatter without the opening `---`).
- D8 census of record = the tool (t02) output; the 75-vs-72 / 10-vs-12 executor
  delta is written into the baseline table as a measured row.

## Frontier

- Scope = top-level `.planning/2026-*` only; done/, archive/, knowledge/,
  specs/, plans/ out of scope. No dir moves (CONVENTIONS forbids mass-move).
- Duplicate self-arc-13/14/15 dirs are by-design parallel-session artifacts —
  tool marks info, never merges or renumbers them.
- Audit stops at "PR cited = PR merged in git history"; deployed-artifact
  health of a merged PR is a different effort.

## Fog of war

- Pre-squash/rebased-away PR citations may be grep-unresolvable even when
  genuinely merged → recorded as unverifiable-offline gap rows, never guessed
  green.
- Some Aug maps may cite different PRs than the work actually landed under —
  D5(1) flips only on citations that verify; the rest go paused-with-note.
- The live session may land arc-17's close-out mid-effort and flip rows we
  also targeted — reconciliation is per-row idempotent; re-run the tool before
  each PR.
- prepare-feature-branch-cli reported create-failed for a branch that did not
  exist; the equivalent manual `git checkout -b feat/planning-audit
  origin/main` succeeded — CLI phases after this one (rebase/force-push/PR)
  remain CLI-owned; revisit if it recurs.

## Cross-effort links

- Builds-on: 2026-09-09-self-arc-16 — inventory-guard + numbering-collision
  lessons directly shaped D1/D2.
- Builds-on: 2026-09-09-self-arc-17 — its Destination named "reconciles
  shipped-but-active map statuses"; this effort is the systematic pass its
  close-out can cite. Reciprocal link deferred (live-owned dir).

## Executor deviations (recorded 2026-09-09)

- t04 acceptance adjusted: the two pilot rows were fresh-dated, never stale —
  flips correct, red-count unchanged by t04 (details results/summary.md).
- Two edit-script hiccups (unflushed-write race; a fence that only looked
  present) — both caught by the tool re-run before commit, fixed, re-audited.
- prepare-feature-branch-cli reported create-failed on a nonexistent branch
  name; the equivalent checkout ran manually, later phases stay CLI-owned.
