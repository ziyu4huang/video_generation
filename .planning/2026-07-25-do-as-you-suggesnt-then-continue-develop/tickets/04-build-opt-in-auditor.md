# 04 — build the opt-in isolated auditor, or park it?

type: grilling
blocked by: 03 — feasibility (closed: feasible), 01 — goal.ts modularization (lands on the clean base)

## Question

Given T03 says it's feasible and worth it as opt-in: **do we build it now, or
park it** (leave as fog until the hardening lands and there's real appetite)?

### Recommendation

**Build it, opt-in, after T01.** It is the single highest-value capability gap
vs the reference — it closes the "self-report bamboozle" that `goal_complete`
currently is — and T03 de-risked the hard parts. Gate it strictly:

- **Default off.** `goal_complete` stays a self-report unless the goal opted
  into audit (`/goal --audit "<objective>"` or a config flag). The bundled
  cockpit's default contract is unchanged.
- **Lands on the post-T01 module base** (blocked by 01) — the auditor becomes
  `goal/auditor.ts` (the `createAgentSession` runner) + `goal/shield.ts`
  (pure, findings ported in 03), imported by the orchestrator.
- **Opt-in model override** + parent-runtime reuse (per T03 finding #3).
- **All safety floors ported** (must-read-tool, silent-failure → error,
  10-min stall abort, three-way verdict, evidence shield).

### What this ticket resolves

Build-now vs park. If **park**: close this ticket, move "opt-in auditor" to
**Not yet specified**, reopen after the hardening tail. If **build**: close
with the opt-in contract above → execution plan.

### The real call

The destination is "stay lightweight." The auditor is opt-in precisely *so*
that stays true. The question is whether opt-in auditor belongs in *this*
map's scope or to the post-hardening tail. Lean: in-scope — it's the
capability the reference exists to teach, and T03 already front-loaded the
risk.
