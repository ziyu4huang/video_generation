---
type: grilling
blocked by: []
status: open
---

# 05 — Decide: `constrainedSampling` on structured_output

**Source**: 01#1 · axis `upstream-sync` · **Impact 4 / Effort 1 / score 20** (rank 1)

**Gap**: pi 0.82.0 added `Tool.constrainedSampling ("prefer"|"require")` + capability
flags `supportsStrictTools`/`supportsOpenAIGrammarTools`. `structured-output.ts:27`
`defineTool({...})` omits it — validity is enforced via schema validation + a
`maxSchemaRetries` repair loop (`agent.ts`), which is exactly the fallback
`constrainedSampling` is meant to eliminate.

**Improvement shape**: set `constrainedSampling:"prefer"` (or `"require"`, which pi
auto-blocks for models lacking the capability) so final calls guarantee
schema-conformance on Sonnet/Opus/GPT-5+/Gemini, shrinking the retry path.

## Question

**do / defer / skip?** If **do**: lock `"prefer"` vs `"require"` (recommend
`"prefer"` — degrades gracefully on non-capable models), and decide whether to also
expose a per-call override. This is the cheapest high-impact item in the pool —
likely a clean `do` + ~1-line spec.
