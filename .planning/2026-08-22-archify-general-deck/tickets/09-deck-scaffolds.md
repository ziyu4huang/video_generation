---
ticket: 09-deck-scaffolds
effort: archify-general-deck
type: task
status: open
created: 2026-08-22
last: 2026-08-22
blocked-by: [08]
---
# 09 — four reusable deck skeletons

> Spec §4.9, §4.10.

## What to build

`templates/decks/*.outline.md` — four skeletons, written as **outline Markdown** rather than
manifest JSON, because that is the door the agent should be using after ticket 08:

- `technical-review.outline.md` — 現況 → 問題 → 選項 → 建議 → 風險
- `project-kickoff.outline.md` — 目標 → 範圍 → 里程碑 (`timeline`) → 分工 → 下一步
- `incident-review.outline.md` — 時序 (`timeline`) → 影響 (`kpi-row`) → 根因 → 對策 → 追蹤
- `product-proposal.outline.md` — 使用者問題 → 現有方案 (`compare`) → 提案 → 指標 → 要求

Each carries **placeholder prose that demonstrates the writing rules**: action titles that
state a claim, one idea per slide, a `takeaway` and a `source` on every exhibit. A skeleton
whose own titles are topic labels teaches the wrong thing, and `deck-lint` will say so — run
it on all four and expect **clean**.

Report them from `archify_deck_lint`'s catalog alongside the layouts, so an agent that asks
"what can I make?" gets both the pieces and some finished shapes.

## Acceptance

- All four parse, build, and pass `deck-lint` clean.
- Between them the four use every one of the seven new templates at least once.
- Each is under one screen of frontmatter + body; a skeleton nobody reads is not a skeleton.

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`
