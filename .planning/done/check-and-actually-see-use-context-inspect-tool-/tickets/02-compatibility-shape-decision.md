---
type: grilling
blocking: 01
status: closed
---

# 02 — Which binding shape makes workflow satisfy superpowers' subagent dispatch?

## Question
Ticket 01 established that `pi-agent-ext-workflow` already has the *runner* (`spawnSubagent()`:
isolated child session + model / tools / schema / cwd / timeout / parent-tool-bridging) but no
*surface* superpowers' dispatch can hit. **Which binding shape do we build on top of it?**

## Candidate shapes

**A — register a `subagent` tool INSIDE the workflow extension**, wrapping `spawnSubagent()`
with SDD's contract (`agent`/`task`/`model` → isolated child, report-back status).
- ✅ most direct — matches exactly what `pi-tools.md` tells the agent to look for.
- ❌ the name `subagent` collides if the real `pi-subagents` package is ever installed alongside.

**B — make workflow a delegation-protocol PROVIDER**: subscribe to
`SUBAGENT_DELEGATION_REQUEST_EVENT`, answer with `spawnSubagent()` runs. (The literal "learn
from pi-subagents" path — reuse its protocol verbatim.)
- ✅ decoupled — any emitter (incl. a ported prompt-template bridge) can delegate; coexists with
  a real `pi-subagents` install.
- ❌ heavier — must adopt the delegation adapters; and superpowers' `Subagent (general-purpose):`
  text template won't fire unless something *also* emits the request event (i.e. we'd still need
  a prompt-template bridge, not just the provider).

**C — extend the existing `workflow` tool** with a single-agent dispatch mode
(`agent`/`task`/`model` params → `spawnSubagent()`).
- ✅ no new tool surface — reuses the already-active `workflow` tool.
- ❌ mixes two abstractions (workflow-script runner vs single-agent dispatch); SDD still looks for
  a `subagent` tool, so this needs a mapping note and may not satisfy the literal contract.

**D — a new thin ADAPTER extension** (`pi-agent-ext-subagent-shim`) exposing the `subagent` tool
by delegating to workflow's `spawnSubagent()`.
- ✅ cleanest separation — workflow stays a pure engine, the adapter owns the superpowers contract.
- ❌ another package to build / test / maintain; couples two extensions at runtime.

## Decision tree to grill (resolve in order)

1. **Relationship to real `pi-subagents`** — workflow *owns* the `subagent` name here, or must
   *coexist* with a future real install? (decides whether shapes A/D's tool name is safe, or B is
   forced.)
2. **Invocation surface** — agent *calls a tool* (A/C/D) vs the *event-bus protocol* (B).
3. **Where it lives** — inside the workflow extension (A/C) vs a separate adapter (D).
4. **Parity scope** — minimal (single-agent dispatch + report-back) vs also port `clarify`-TUI /
   `acceptance` / `turnBudget` now.

## Resolution (closed — Shape A chosen)

**Build Shape A:** register a `subagent` tool *inside* `pi-agent-ext-workflow` that wraps
`spawnSubagent()` with SDD's contract (`agent` / `task` / `model` → isolated child → report-back
status + output).

**Rationale:** workflow **owns** the subagent role in this repo (destination: *"make workflow take
the role"*); the real `pi-subagents` package is a studied sibling reference, **not** an installed
dependency, so the `subagent` tool-name collision is a non-issue. Shape A is the most direct
satisfier of what `pi-tools.md` already tells the agent to look for.

- **B** (delegation-protocol provider) — rejected: heavier, and still needs a prompt-template
  bridge for the `Subagent (general-purpose):` text template to fire.
- **D** (separate adapter extension) — rejected: needless package overhead + runtime cross-ext
  coupling for a contract that fits cleanly inside workflow.
- **C** (extend the `workflow` tool) — rejected: doesn't satisfy the literal `subagent` tool name
  SDD searches for.

**Sub-decisions resolved by this pick:** own-vs-coexist = **OWN**; invocation surface = **TOOL**;
location = **IN-WORKFLOW**.

**Remaining (final grilling question):** parity scope — minimal v1 vs also port `clarify`-TUI /
`acceptance` / `turnBudget` / `toolBudget`.

**Parity scope (resolved — MINIMAL v1):** tool params `{agent, task, model, cwd, tools?,
excludeTools?}` → `spawnSubagent()` → return child output. **No** clarify-TUI / acceptance /
turnBudget / toolBudget. Report-back status stays a prompt convention (the implementer writes
DONE/BLOCKED/…; SDD's `NEEDS_CONTEXT` loop handles inline questions via re-dispatch). Port
fidelity only if a real SDD run proves the need.

**Decision tree complete — route is clear.** Hand off to `to-spec` → `writing-plans`.
