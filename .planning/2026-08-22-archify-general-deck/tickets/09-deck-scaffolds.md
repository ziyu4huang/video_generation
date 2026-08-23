---
ticket: 09-deck-scaffolds
effort: archify-general-deck
type: task
status: closed
created: 2026-08-22
last: 2026-08-23
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

## Resolution

2026-08-23 — shipped in this PR. Four outline-dialect skeletons in `templates/decks/`
(technical-review / project-kickoff / incident-review / product-proposal), each under one
screen (42–45 lines measured): claim titles (all content titles pass the label check), one idea
per slide (≤2 bullets, no nesting), takeaway + source on every content slide (end/quote slides
mirror the deck-general convention: source only — those templates suppress the title band and
takeaway chrome), all seven shipped templates used at least once across the four. The catalog
(no-args `archify_deck_lint`) lists them beside the layouts via the new `discoverDeckSkeletons`.

Also shipped because the skeletons surfaced them:
- outline.ts authoring inference now sets `layout: "bullets"` for bullets-only slides (the
  dialect previously rejected them; mirrors resolveLayout's ladder).
- `templates/timeline.layout.json` rule-box inset bottom 2.44 → 2.39: with a takeaway the
  content well is 5.0 in and the old insets (2.6 + 2.44) made the rule box −0.04 in → ooxml
  emu-invalid; root-caused at regionBox (layout-template.ts) and reproduced minimal; golden
  regenerated (UPDATE_TEMPLATE_GOLDENS=1). Both wells stay positive (0.11 / 0.01 in).
- quote/end catalog descriptions document the suppressed title band/takeaway.

Reviewer pass: RELEASE-WITH-NITS — M1 (end/quote slides teaching never-rendered `^`/`~`)
fixed in-ticket; nits landed (dead env param dropped, H1-after-frontmatter, tool description,
comment typo); the shippedDir seam and the chrome-suppressed title-overflow exemption recorded
as fold-back for ticket 10. Verified: typecheck clean, 619 pass / 21 skip / 0 fail; all four
decks lint clean (content + ooxml) via the CLI and pinned by tests/deck-skeletons.test.ts.
