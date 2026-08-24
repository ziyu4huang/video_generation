# Ticket 02 — SUBAGENT_TIME_BUDGET_* env knobs: the time envelope gains the token family's env surface

Status: in progress (2026-08-25, resumed from the parked fog list — fog item
"Env knob extension to time (`SUBAGENT_TIME_BUDGET_*`)"; queue head named by
next-goal-20260825-045630)

## Why now

The token side of the dispatch envelope has a complete runtime env surface —
`SUBAGENT_TOKEN_BUDGET_{DISABLE,SMALL,MEDIUM,BIG,MULTIPLIER}` over the tier
ceilings plus `SUBAGENT_MAX_TURNS` over the role turn cap (budget-defaults.ts
`ENV_KEYS`; README "Token budgets" table). The time side has NONE: the wall of
the role envelope (`ROLE_AWARE_DISPATCH_BOUNDS[role].timeoutMs` — recon 5 min,
writer 20 min) is a frozen constant with no runtime valve, so the only way to
move it is a code change. Every other currency can be tuned per-host/per-run
without a rebuild; time cannot. This is the map's fog item "Env knob extension
to time", the smallest unstarted item of the effort's symmetric-three-currency
destination.

## Decision (this ticket)

Mirror the token family's knob SHAPE exactly, scoped to where time actually
resolves — the ROLE envelope (there are no per-tier time defaults today; time
is role-scoped only):

| Env var | Effect |
| --- | --- |
| `SUBAGENT_TIME_BUDGET_DISABLE=1\|true` | Strip ONLY the role envelope's wall-clock bound. Token + turn caps stay applied. At the tool seam the downstream `DEFAULT_TIMEOUT_MS` (15 min) still lands; at direct-call seams (`roleAwareDirectCall` → `spawnSubagent`) wall-clock becomes genuinely unbounded — token/turn caps remain the runaway bound. Never conflated with `SUBAGENT_TOKEN_BUDGET_DISABLE` (that one still strips the whole envelope). |
| `SUBAGENT_TIME_BUDGET_RECON` / `SUBAGENT_TIME_BUDGET_WRITER` | Replace that role's `timeoutMs` (positive integer, ms — the internal unit and the `timeoutMs` param surface's unit). Applies only when the envelope applies. |
| `SUBAGENT_TIME_BUDGET_MULTIPLIER` | Multiply the role wall after any absolute override (positive finite float); result floored to ≥1 ms. |

Semantics pinned (all mirror the token family):

- Disable wins over overrides AND multiplier (token disable's precedence).
- Overrides/multiplier apply AFTER the all-or-nothing opt-out check — explicit
  params (`tokenBudget`/`maxTurns`/`timeoutMs` of ANY kind) still opt the whole
  envelope out; env knobs never resurrect it (same as `SUBAGENT_MAX_TURNS`).
- Persistent (named live-agent) dispatches keep NO time default by design
  (cc-parity-2 ticket 05 / F2) — the time knobs are inert there.
- Numeric bounds UNCHANGED: recon 5 min / writer 20 min frozen until the ≥100
  post-#2012 re-measure gate opens (this ticket is policy-only).
- Env read at call time, no caching; invalid values silently ignored.

Rejected: a separate global `SUBAGENT_TIMEOUT_MS` (duplicates
`DEFAULT_TIMEOUT_MS`'s job and the caller's `timeoutMs` param — a third way to
set the same wall); minute/second-suffixed units ("300s", "5m" — parsing
surface for zero benefit over ms, which the param surface already uses);
per-tier time knobs (no tier time defaults exist to override).

## Scope

1. `s2-agent-core-runtime/src/budget-defaults.ts`: extend `ENV_KEYS` with the
   three time knobs (`timeDisable`, `timeRecon`, `timeWriter`,
   `timeMultiplier`); in `roleAwareDefaults`' non-persistent branch resolve
   `timeoutMs` through env-absolute → multiplier → floor, with disable last
   (wins) — mirroring how `envMaxTurns` wraps `bounds.maxTurns`.
2. Tests (`s2-agent-core-runtime/tests/budget-defaults.test.ts`): add the new
   knobs to the hermetic ENV_KNOBS save/restore list; pin (a) per-role
   absolute override, (b) multiplier after override + floor clamp, (c) disable
   strips time only (token/turn caps + `applied:true` intact; token DISABLE
   still strips everything), (d) invalid values ignored, (e) explicit params
   still opt out, (f) `roleAwareDirectCall` passes the env-shaped wall through.
3. `s2-agent-ext-subagent/README.md`: add the three rows to the env-var table
   under "Token budgets" (section retitled "Token budgets" → keep title; rows
   appended).
4. Map: fog item "Env knob extension to time" resolved; decision recorded.

No ADR — the decision is a small reversible surface addition mirroring an
existing family; it belongs in the map's Decisions (per CLAUDE.md ADR bar).

## Done-when

- [ ] Three time knobs resolve in `roleAwareDefaults` with token-family
      precedence (disable > override > multiplier), bounds unchanged.
- [ ] s2-agent-core-runtime + s2-agent-ext-subagent canonical gates green.
- [ ] README env table documents the three knobs.
- [ ] Map fog item closed with the decision; PR merged CLEAN via the devops
      chain.
