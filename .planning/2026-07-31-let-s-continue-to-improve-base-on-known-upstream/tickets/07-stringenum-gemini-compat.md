---
type: grilling
blocked by: []
status: closed
---

# 07 — Decide: `StringEnum` (Gemini/Google compat, 18 sites)

**Source**: 01#2 · axis `upstream-sync` · **Impact 4 / Effort 2 / score 16** (rank 3)

**Gap**: `docs/extensions.md` mandates `StringEnum` from `@earendil-works/pi-ai`
("`Type.Union`/`Type.Literal` do not work on Google's API"). Both extensions use
the union form at **18 sites**: `subagent-runs-tool.ts:16,20`,
`subagent-tool.ts:131`, `watchdog/model-review.ts:10`,
`workflow-control-tool.ts:17–23`, `workflow-tool.ts:117+` (×6). Routing a
sub/workflow agent to a Gemini model breaks these tool schemas.

**Improvement shape**: mechanical swap `Type.Union([Type.Literal(...)],{...})` →
`StringEnum([...])` at all 18 sites + import change.

## Question

**do / defer / skip?** If **do**: confirm this is purely mechanical (no semantic
change) and whether to bundle a Gemini-routing smoke test. Recommend `do` as one
PR — low risk, correctness for a whole provider family.

> Closed 2026-08-16: done — PR #1467 (15-file StringEnum swap, desc+default preserved; file2md pre-existing red noted in PR body). Skips: protocol.ts/zai-mcp/test-fixture/core-task.
