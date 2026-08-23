---
type: task
status: closed
claimed: pi-session-2026-08-04-superpowers-wt
resolution: "Fixed + merged via PR #1029 (merge commit e2e15705) — fence-first frontmatter in skills/to-tickets/SKILL.md + regression test in tests/map.test.ts"
---
# to-tickets skill template silently drops ticket frontmatter

## Question

The `to-tickets` skill's `<local-ticket-template>` (`skills/to-tickets/SKILL.md`) writes the H1 *before* the frontmatter fence, but `parseTicketFile` (`src/map.ts`) anchors frontmatter at start-of-string (`/^---\r?\n/`). Verified live: a ticket authored from the verbatim template parses as `type: "grilling"` (default) with `blocking: []` instead of the declared `type: task` + `["02","05"]`. The dependency graph the whole chain depends on silently vanishes → `computeFrontier` can't gate, `flattenTicketsToPlan` topo-sort is wrong, sync mis-matches.

Resolve: fix the template (fence first, single H1) **and** add a regression test that `parseTicketFile`s the verbatim template string and asserts the declared type + blocking edges survive.
