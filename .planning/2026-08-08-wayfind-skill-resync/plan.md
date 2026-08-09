# Wayfind skill re-sync — 2026-08-08

> **Status:** done — merged via PR #1134 (`grilling` adopted upstream frontier-interview model; `to-spec` / `domain-modeling` / `to-tickets` verified no-change).

## Context
`pi-agent-ext-wayfind` is a Pi-native port of Matt Pocock's skills (upstream `/Users/huangziyu/proj/pi-ext-matt-skills`). A drift check (port cut 2026-07-15; upstream moved 2026-07-16) evaluated 4 candidate skills.

## Outcome
- **grilling — CHANGED.** Port was on the old "one-question-at-a-time" model; adopted upstream's round-by-round **frontier-interview** model (design tree, frontier = settled-prerequisite questions, rounds asking the whole frontier as numbered Q+A with recommended answers, sub-agent fact-finding, "frontier is empty" termination). The pi branch-currency guardrail (`/wayfind` + `git rev-list --count HEAD..origin/<default>`) is spliced into the fact-finding paragraph.
- **to-spec / domain-modeling / to-tickets — NO CHANGE (verified).** The port is already AHEAD of upstream here: local-only `.planning/<effort>/` layout, issue-tracker refs already dropped, `_Source:` validation, `/goal` handoff — landed via prior PRs #676 / #754 / #678 / #620. Current upstream still ships the older issue-tracker versions, so adopting upstream would regress the port.

## Out of scope (deferred)
- 27 new upstream skills not yet ported (separate scope-expansion decision).
- Superpowers extension (verified in sync at v6.2.0).
- Unexamined content drift in code-review / codebase-design / improve-codebase-architecture.

## Verification
`( cd bun-apps/pi-agent-ext-wayfind && bun test )` → 311 pass, 0 fail.
