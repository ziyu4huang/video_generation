# Ticket 06 — budget and config (blocked-by: [04,05])

Goal: Token-budget + config hardening.

Scope: per-layer condense budget config (LeanRAG (max_depth-layer)*80 analog); LLM-call counter surfaced in build result; hierarchy config in zk-task-config + hermes config (knob, thresholds, depth cap).

Acceptance: budget gating tests; config validation; zero LLM calls when under threshold.
