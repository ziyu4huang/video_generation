---
type: grilling
blocked by: []
status: closed
claimed: upstream-05-implementer (2026-07-31)
resolved: 2026-07-31 (DO — implemented: set constrainedSampling {type:"json_schema", strict:"prefer"} on structured-output defineTool; resolved by this PR)
---

# 05 — Decide: `constrainedSampling` on structured_output

**Decision: DO — implement (prefer).** Set
`constrainedSampling: { type: "json_schema", strict: "prefer" }` on the
`structured-output` `defineTool({...})` call. The ticket's shorthand `"prefer"`
maps to the `strict` field of the `json_schema` branch of pi-ai's
`ConstrainedSamplingConfig` (the `grammar` branch is for provider-specific
lark/regex encodings, irrelevant here). `"prefer"` degrades gracefully where a
model lacks strict-tool support — leaving the existing schema-validation +
`maxSchemaRetries` repair loop (`agent.ts`) intact — while guaranteeing
schema-conformance on capable models (Sonnet/Opus/GPT-5+/Gemini). No per-call
override exposed (out of scope; revisit if a subagent ever needs `require`).

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
