# planning-audit — baseline → reconciled (2026-09-09)

Census of record: the effort-audit tool (D8). Baseline run at origin/main
6d225ca2 + this effort's opening commit; reconciled run after t04+t05 edits.

| | baseline | reconciled |
|---|---|---|
| scanned | 76 (75 + this effort) | 76 |
| red | 48 (54 before the provenance-vocabulary fix) | **0** |
| info | 6 | 6 (duplicate-arc rounds 13/14/15 — by design) |
| exit | 1 (expected, recorded) | **0** |

Executor-vs-planner census delta (D8 measured row): executor hand-sweep said
72 dirs / 12 missing-status; tool says 76 / 12 (planner's own 75/10 counted
before this effort's dir existed and before two fence repairs were known
needed). Hand tallies are not a census — this gap is why the tool exists.

## Red-class dispositions (all 48 rows)

- **terminal-no-provenance (26)** — every one got a `## Shipped-as` section
  citing git-log-verified merged PRs (verification: `git log --grep "#N"`
  resolving to a merged commit). Includes 6 early self-arc maps (3,4 among
  the flagged; 5–7,9 cleared by the `## Shipped` vocabulary fix) and
  file2md-render-hardening, whose close-out #2228 flipped status but never
  landed the section it named.
- **missing-status (12)** — classified individually (two read-only Explore
  passes + git evidence): 8 done (frontmatter added + Shipped-as), 2 paused
  with dated notes + Shipped-so-far (cards-ux2 ticket 03, simplify PR4), 2
  fence-repaired (frontmatter existed but the opening `---` was missing:
  core-runtime-width, pi-agent-sh-full-profile → complete + Shipped-as).
- **stale-non-terminal (7)** — 2 done (webui-tui-parity #1495;
  portable-bun-scripts #1857/58/61/62 — body already said Closed 2026-08-23),
  2 active-with-dated-deferral (archify-webui-html fog ticket 05;
  tool-gate-complete-redesign blocked tickets 03–06), 3 paused with dated
  notes (zk-spawn — its undated note dated; tool-gate-qa-harness opened
  #1519 never worked; set-goal-async findings never recorded).
- **paused-without-note (1)** — zk-spawn (also stale): note dated.
- **no-date (1)** — power-tool-rearch: dates added; paused with dated note +
  Shipped-so-far (#1464; ticket 02 findings A2/A6–A9 open — HANDOFF.md is
  the resume point).
- **unmerged-citation (1)** — this effort's own map prose mentioned the OPEN
  pull request 2237 in `PR #` shape; reworded (it was never a ship claim).

## The pilot contradiction (t04)

`2026-09-06-self-arc-13` planning→done and `-14` active→done flipped citing
their merged PRs (#2218/#2219, #2223/#2225). Plan deviation, recorded: the
planner's acceptance said "tool red-count drops by exactly those rows" —
both rows were FRESH-dated (last: 2026-09-09/09-08), so they were never
stale-reds; the flips are still the correct reconciliation, and red-count is
unchanged by t04 specifically.

## Still open (honest, non-red)

Fresh non-terminal efforts inside the 14d window are recorded in the
reconciled table as their live statuses (knowledge-pipeline, hermes,
subagent-dynamic-budgets, archify-rich-decks, cc-parity-task-powertool,
win32-launcher-stdout, archify-deck-html, learnings-hardening,
subagent-tui-cc-parity-2, webui-view-notifications). Live-session dirs
self-arc-17/18: untouched (verified `git diff --stat origin/main` empty).
