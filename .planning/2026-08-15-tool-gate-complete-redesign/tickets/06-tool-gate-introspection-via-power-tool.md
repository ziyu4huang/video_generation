# 06 — Tool-gate introspection via power-tool (and un-gate inspect_*)

type: prototype

## Question

Two cross-extension gaps:

1. **No live view of tool-gate state (F10).** The agent can only call `enable_tool({list})` to see *dormant* gates. It cannot see which gates fired, which are dormant, the per-gate token cost, or *why a tool is missing*. power-tool's `inspect_context` already measures the tools schema generically (and `schema-cost/estimate.ts` is the canonical estimator tool-gate reuses) — but has no tool-gate semantics.
2. **`inspect_*` tools are keyword-gated (F9).** `inspect_context`/`inspect_agent`/`inspect_extensions`/`inspect_pathology`/`inspect_tui` are dormant until the prompt says "schema cost / pathology / extension health" — the exact tools you need *when something is wrong*. Gating diagnostics is a footgun.

Resolve with a prototype:

- Add a `tool_gate_status` (or extend `inspect_context`) surface that reads the effective gate state and reports: active tools count, per-gate `{fired/dormant, keywords, token cost}`, and the current `sticky` set — using the contract shape from ticket 01.
- Decide whether `inspect_*` should be `core:true` (always-on) or stay gated; weigh the ~1.5k tok cost of un-gating the five inspect tools against the diagnostic availability.

Prototype the surface (rough, reactable) and link it as an asset; the decision on un-gating is HITL.

## Acceptance

A working prototype showing live tool-gate state; a cost/benefit note on un-gating `inspect_*`; a recommendation.

blocked by: 01 (introspection reads the settled contract)

## Post-sync note (origin/main `c18f0363`)

`#1464` re-architected power-tool: the six `inspect_*` tools now share **one** `DIAGNOSTIC_GATING` predicate (`src/gating.ts`) instead of six copy-pasted literals, and gained `src/cost.ts` / `src/report.ts` / `src/runner-hooks.ts`. This does **not** change the ticket's core question — the diagnostics are still keyword-gated and still lack live tool-gate semantics — but it changes the *surface*: un-gating the six tools is now a one-predicate flip (`DIAGNOSTIC_GATING`), and the introspection prototype should read the new power-tool modules rather than the pre-`#1464` layout.
