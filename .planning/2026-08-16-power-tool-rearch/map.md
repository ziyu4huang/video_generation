---
status: active
---
# power-tool re-architecture + ask-user TUI side-car review

## Destination

Simplify and re-architect `bun-apps/pi-agent-ext-power-tool` (breaking changes allowed
where the benefit is real), and produce a side-car TUI review of
`bun-apps/pi-agent-ext-core-task/src/ask-user/`.

## Notes

- **power-tool has never had a wayfind two-axis review.** Every prior effort
  (`2026-07-18-power-tool-run-test-unification`,
  `done/2026-07-25-inspect-hooks-hook-observability`,
  `2026-08-09-inspect-hooks-phase2-firing-counts`,
  `done/2026-08-02-taxonomy-gating-field-migration`) added a feature. None looked at
  the package's shape. `REVIEW-2026-08-15-ext-four-packages.md` covers
  wayfind / superpowers / subagent / core-task — power-tool is the missing fifth.
- Baseline at effort start: `bun test` = 181 pass / 4 skip / 0 fail (16 files).
- Doc policy for this effort (user directive 2026-08-16): **facts that drift live in
  code, not in prose.** PRD.md / CONTEXT.md / package.json keep only what never
  changes; anything derivable (tool lists, counts) is derived at runtime or dropped.

## Decisions so far

- **D1 — one cost estimator.** `schema-cost/estimateToolCost` is the canonical
  measurement; the inspect_* tools stop hand-rolling
  `desc.length + JSON.stringify(params).length`. They already disagreed on
  `parameters: undefined` (2 chars vs 0).
- **D2 — derive, don't restate.** The CLI allowlist, the package description, PRD and
  CONTEXT stop enumerating tools. Five places claimed 4/4/5/4/6 tools; only the code
  was right.
- **D3 — registration entry.** `package.json` `pi.extensions` moves to
  `./extensions/power-tool.ts` per the CLAUDE.md convention. The `src/index.ts` value
  there was a phantom second entry (the wayfind #1 shape).
- **D4 — ask-user is review-only this effort.** Findings are recorded as a ticket; no
  code change to core-task here.

## Not yet specified

- Whether ask-user's notes feature should be un-gated from `preview` presence, or the
  multi-select notes plumbing deleted instead (ticket 02, A2).

## Out of scope

- `pathology/` and `schema-cost/` internals — both already have a clean shape.
- The open `2026-08-09-inspect-hooks-phase2-firing-counts` effort (firing counts
  shipped; that folder still needs closing out separately).
