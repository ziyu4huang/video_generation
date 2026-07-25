# 03 — opt-in isolated auditor: feasibility

type: research
blocked by: —

## Question

Can core-task adopt an **opt-in** isolated completion auditor (fresh pi
session, no extensions, read-only tools) + regression_shield, the way the
reference does — and is the cost worth it for a *bundled, default-loaded*
cockpit? This gates whether a build ticket (04) exists at all.

## Resolution

Researched 2026-07-25 by reading
`../pi-goal-list-loop-audit/extensions/goal-loop-auditor.ts`,
`goal-loop-shield.ts`, `goal-loop-backoff.ts` + DESIGN/PLAN.
**Verdict: feasible; build is justified *as opt-in*.**

### Findings

1. **Building blocks port cleanly.** `goal-loop-shield.ts`
   (`checkRegressionShield`, `contractItems`, `parseAuditorVerdict`) and the
   backoff/heartbeat predicates are **pure, dependency-free** — copy into
   `goal/shield.ts` and they unit-test under plain node with zero pi imports.
   The reference's 168-test suite is mostly these.
2. **The auditor session is SDK-native.** `createAgentSession` (from
   `@earendil-works/pi-coding-agent`, which core-task already depends on at
   0.82.0) with a custom `ResourceLoader` returning empty
   extensions/skills/prompts/themes + `tools: ["read","grep","find","ls","bash"]`
   + in-memory `SessionManager` + compaction enabled. No private API.
3. **Model-auth wall is REAL but mitigatable.** A fresh session built from
   `auth.json`/`models.json` has **no extension-registered providers** — if the
   user's session model is extension-registered, the auditor can't auth. The
   reference mitigates by passing the **parent's** `modelRuntime`
   (`ctx.modelRegistry.runtime`) into `createAgentSession`.
   **Execution-time check for 04**: verify core-task's tool-execute `ctx`
   exposes `modelRegistry`; if not, fall back to an explicit auditor-model
   override (the reference's `/glla model=provider/id`, here a `/goal` flag or
   config).
4. **Cost = one extra session per *audited* `goal_complete`.** As opt-in
   (default off), only opted-in goals pay. Acceptable. Mandatory-on (every
   goal) is **out of scope** for this map.
5. **Safety floors already engineered upstream** (port them): must-call-a-read-tool,
   silent-failure → error-not-verdict (v0.9.9), 10-min inactivity abort → error
   not verdict, three-way verdict (approved / disapproved / impossible),
   regression_shield evidence enforcement.

### Recommendation handed to 04

Build it **opt-in** (`/goal --audit` or a config flag), default off. Port
`shield.ts` + verdict parser verbatim. Reuse the parent-runtime trick; add an
auditor-model override. Lazy-load the auditor submodule so default sessions
pay no import cost — this keeps core-task lightweight per the destination.

status: closed (research resolved during charting)
