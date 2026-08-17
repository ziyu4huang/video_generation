# Ticket 06 — budget and config (blocked-by: [04,05])

Goal: Token-budget + config hardening.

Scope: per-layer condense budget config (LeanRAG (max_depth-layer)*80 analog); LLM-call counter surfaced in build result; hierarchy config in zk-task-config + hermes config (knob, thresholds, depth cap).

Acceptance: budget gating tests; config validation; zero LLM calls when under threshold.

## Resolution
DONE. HIERARCHY_DEFAULTS (threshold .72, maxDepth 3, baseBudget 10k chars-proxy) in zk-task-config; per-layer budget schedule layerBudgetOf = max(1200, base>>depth) (LeanRAG (max_depth−layer)×80 analog, chars-scaled, floor); chatJson-backed default summarizer (LmChatOptions injectable, fenced-json tolerant) with deterministic truncation fallback; gating proven through the DEFAULT path (huge budget → llmCalls 0, fetch never called). 4 tests; zk suite 473/0, typecheck clean.

## Resolution
DONE. HIERARCHY_DEFAULTS (threshold .72, maxDepth 3, baseBudget 10k chars-proxy) in zk-task-config; per-layer budget schedule layerBudgetOf = max(1200, base>>depth) (LeanRAG (max_depth−layer)×80 analog, chars-scaled, floor); chatJson-backed default summarizer (LmChatOptions injectable, fenced-json tolerant) with deterministic truncation fallback; gating proven through the DEFAULT path (huge budget → llmCalls 0, fetch never called). 4 tests; zk suite 473/0, typecheck clean.
