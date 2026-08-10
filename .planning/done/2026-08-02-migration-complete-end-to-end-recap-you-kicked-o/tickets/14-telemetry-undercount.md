## Question

`computeBannerSaved` and `qa/savings.ts` still read the hardcoded `GATES`, so the "saves ~N tok/req" banner undercounts owner-declared tools (FOLLOWUPS #1 — cheap, verified non-breaking). Thread `effectiveGates` into `computeBannerSaved` and its call sites so the banner reflects owner-declared gating. Must land before hardcoded GATES deletion (else savings.ts breaks).

type: task
blocked by:

## Resolution

Threaded the live `effectiveGates` closure variable into both `computeBannerSaved` call sites so the runtime savings banner + telemetry reflect owner-declared gating: `extensions/tool-gate.ts` session_start "saves ~N tok/req" banner (~L468) + before_agent_start telemetry `savedTok` (~L509). The 4th-arg parameterization already existed (ticket 13a); the call sites had omitted it, hitting the empty module `GATES` default → savings 0. `effectiveGates` is computed live via `buildEffectiveGates(getDiscovered())` ~9 lines above each call — no new state/threading needed; all other runtime consumers (filterActive/updateSticky/matchIntent/enable_tool/gatesFired/dormantGates) were already threaded. Added a regression test firing session_start with an owner-declared gated tool → banner N>0 (exact N=measureToolTokens); verified it FAILS pre-fix (Received 0). Scope correction: `qa/savings.ts` was ALREADY correct (ticket 13 routed it through `CORPUS_GATES`, not `GATES`) — only its stale "Stopgap" comment was updated, no logic change. Tests: tool-gate.test.ts 92/0 (+1), full suite 272/0, savings.test.ts 9/0. FLAG for ticket 15: `qa/research-cost.ts` imports `GATES` directly — that is the REAL GATES-deletion blocker (not savings.ts). Commit: c7ba6a63.

status: closed
