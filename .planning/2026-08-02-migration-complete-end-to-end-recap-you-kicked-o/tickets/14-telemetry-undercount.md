## Question

`computeBannerSaved` and `qa/savings.ts` still read the hardcoded `GATES`, so the "saves ~N tok/req" banner undercounts owner-declared tools (FOLLOWUPS #1 — cheap, verified non-breaking). Thread `effectiveGates` into `computeBannerSaved` and its call sites so the banner reflects owner-declared gating. Must land before hardcoded GATES deletion (else savings.ts breaks).

type: task
blocked by:
