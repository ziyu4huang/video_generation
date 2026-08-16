# Skill candidate: dispatch-cost-audit

**trigger/symptom**: Asked to measure what agent efforts/dispatches actually cost (tokens, sessions) in this repo — before optimizing, or to verify an optimization landed; runs-DB numbers needed as evidence.

**lesson**: The runs DB is a 200-dispatch rolling window (~hours), $ reads 0.00 on zai/glm routes, and main-session tokens are invisible — so every "cost" claim must state its coverage. No single source suffices; the working method triangulates three sources with stated fuzz.

**proposed procedure**:
1. Sample ~/.pi/subagents/runs/*.json key structure first; then aggregate: run count, token usage fields, terminal status (budget/turns/failed aborts = waste class).
2. Attribute runs to efforts by keyword grep over task text (state coverage: ~144/200 attributable; hermes-family ambiguous).
3. Session proxy: git log --follow --oneline -- .planning/<effort>/ (+ commit dates/authors); stage split via ticket files' Resolution markers.
4. Always report: window size, share of truncated dispatches (the dominant waste class — 76% in the 2026-08-16 baseline), $-unrecoverability, main-session invisibility, ±fuzz.
5. Re-audit immediately before trusting any trend (window rotates fast).

**evidence**: Executed 2026-08-16 as .planning/done/2026-08-16-optimize-planning-pipeline-aka-extension/tickets/01-baseline-cost-audit.md (200 runs, 34.3M tok, 76% truncated-share finding); caveats cross-checked against ~/.pi/subagents/runs retention + $0.00 cost fields. (Memory-id field unavailable — memory tool absent from session; source artifacts cited instead.)

**candidate skill-name**: dispatch-cost-audit
