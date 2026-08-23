---
effort: 2026-08-08-subagent-display-ux
title: "Subagent display UX — glanceable-by-default + expanded-view stability + preset fallback"
created: 2026-08-08
last: 2026-08-08
status: complete
---

## Destination

Make every subagent display surface — the live context-widget AND completed
`subagents`/`subagent` tool results — glanceable by default (collapsed one-line
summaries, expand on Ctrl-O), stable when expanded under fast streaming, and
accurate about which model actually ran (preset-aware fallback). Absorbs three
formerly-separate efforts: `2026-08-08-subagent-display-glanceable-by-default`
(the collapsed view's richness/correctness), `2026-08-08-subagent-expanded-display-flicker`
(whole-TUI flicker when the expanded view streams), and
`2026-08-08-subagents-follow-model-preset` (which fallback model actually runs).

## Map

- [x] ticket 01 — `subagents` batch result collapses by default, expands on Ctrl-O — #1099
- [x] ticket 02 — live display hints what it's working on (work-intent strip) — #1101
- [x] ticket 03 — incorrect LLM model id displayed (show actual model on fallback + `requestedModel` audit) — #1103
- [x] ticket 04 — expanded display flickers on fast stream (cap streaming-expanded tail) — #1104
- [x] ticket 05 — fallback to tier (preset) before session default — #1106
- [x] ticket 06 — work-intent context-box strip + batch/model fallback display consistency — #1108
- [x] ticket 07 — context-box trace tail-cap + batch per-slot badge alignment — #1110

## Decisions so far

The three source efforts' `## Decisions so far` blocks were empty; substantive
decisions live in each ticket's `## Findings` / `## Resolution` (root-cause,
approach chosen, constraints honored).

## Cross-effort links

- **Builds-on:** `2026-08-07-continue-improve-pi-ext-subagents-related-still-`
  (verb-led logs + collapse/expand foundation) and
  `2026-08-07-current-subagent-run-show-in-context-and-bottom-` (the persistent
  context widget).
- **Absorbed:** `2026-08-08-subagent-expanded-display-flicker` (→ ticket 04) and
  `2026-08-08-subagents-follow-model-preset` (→ ticket 05); redirect stubs left
  at those paths.
- **Lineage (older display work, archived, not merged — different format):**
  `2026-07-25-pi-ext-subagent-need-improve-it-s-tui-subagent-a`,
  `2026-07-30-subagents-viewer-redesign`,
  `2026-08-01-subagents-live-visibility`,
  `2026-08-02-subagents-completed-visibility-4b`.

## Notes

Consolidated 2026-08-08 from three efforts into one umbrella for efficient
future lookup. The three originals and which tickets they became:

- `2026-08-08-subagent-display-glanceable-by-default` (tickets 01–05) → here
  01 / 02 / 03 / 06 / 07. **Deleted** in full — its content is absorbed (5
  tickets renumbered into the umbrella + map rewritten); name kept here for grep.
- `2026-08-08-subagent-expanded-display-flicker` (ticket 01) → here 04. Left as
  an `Absorbed-by:` redirect stub.
- `2026-08-08-subagents-follow-model-preset` (ticket 01) → here 05. Left as an
  `Absorbed-by:` redirect stub.

These three were already self-described as one cluster — collapsed view
(glanceable), expanded stability (flicker), and the preset behavior behind
ticket 03 (display-vs-actual model + which fallback runs). Folding them together
reflects how they were actually built: a single collapsed/expanded/display-correctness
subsystem, merged across PRs #1099 → #1110.
