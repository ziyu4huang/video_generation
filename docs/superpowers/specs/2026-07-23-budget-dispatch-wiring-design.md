# Per-subagent budget → dispatch surfaces (design)

**Date:** 2026-07-23
**Branch:** `subagent-budget-dispatch-20260723-2051` off `origin/main` (`52dadfc8`)
**Owner:** Ziyu Huang
**Depends on:** PR #764 — `feat(workflow): per-subagent tokenBudget/spendBudget mid-run cap` (merged)

## 1. Goal

PR #764 shipped the *capability*: the `subagent` tool (and `WorkflowAgent.run`)
now accepts `tokenBudget` / `spendBudget` and **aborts a single run mid-run**
once cumulative token usage or cost exceeds the ceiling — a HARD per-agent cap,
distinct from workflow's run-wide SOFT `Budget`. That capability is currently
**dormant**: nothing tells the SDD dispatch flow (or the `workflow` `agent()`
surface) that these knobs exist or when to use them.

This design wires the budget into the **two dispatch surfaces** so it is
discoverable and usable:

1. **SDD dispatch flow** — the `subagent` tool, as documented in
   `pi-agent-ext-superpowers`'s `pi-tools.md` and live-injected by the
   bootstrap (`src/superpowers.ts` `piToolMapping()`). Mirror exactly how
   `commitScope` was wired (PR #763): doc + bootstrap glue + a bootstrap test.
2. **`workflow` `agent()`** — extend the per-call `AgentOptions` so a workflow
   author can pass `agent(prompt, { tokenBudget, spendBudget })` and that
   single agent gets a hard mid-run cap (forwarded to `WorkflowAgent.run`,
   which already enforces it). Currently `agent()` exposes `timeoutMs` /
   `retries` per-call but **not** the budget.

## 2. Scope

**In scope:**

- `pi-tools.md`: extend the two `subagent` dispatch signatures + add a
  `**Budget (SDD).**` guidance paragraph (soft convention).
- `superpowers.ts` `piToolMapping()`: add `tokenBudget`/`spendBudget` to the
  live-injected dispatch signature.
- `bootstrap.test.ts`: assert the budget guidance is present in the injected
  mapping.
- `workflow.ts`: `AgentOptions` gains `tokenBudget?`/`spendBudget?`;
  `hashAgentCall` includes them (resume correctness); the `agentRunner.run()`
  call forwards them.
- `workflow-tool.ts`: budget help text mentions the per-agent form.
- Tests for the `AgentOptions` forwarding + hash inclusion.

**Out of scope (YAGNI):**

- Changing the convention *strength* of the run-wide `tokenBudget` on the
  `workflow` tool (it stays opt-in / "do not set unless asked").
- Auto-deriving per-agent budgets from effort/routing config.
- A `subagent`-tool-side default budget (the tool stays opt-in; no surprise
  caps).
- Wiring budget into the byte-identical SDD skill bodies (`SKILL.md`,
  `implementer-prompt.md`) — those stay byte-identical upstream (PR #684
  fidelity invariant). The convention lives in the pi-port glue only.

## 3. Background — the three budget knobs and why they do not conflict

There are now **three** distinct spend-control knobs. Making their boundaries
explicit is the core of this design:

| Knob | Surface | Granularity | Semantics | Enforced by |
| --- | --- | --- | --- | --- |
| run-wide `tokenBudget` | `workflow({ tokenBudget })` | whole run | **SOFT**: spent accrues *after* each agent; checked between agents; the NEXT dispatch is blocked; an in-flight agent may overshoot | `workflow.ts` `budget.total` gate at `agent()` entry |
| phase sub-budget | `phase('Name', { budget: N })` | one phase | **SOFT**: a noisy phase exhausts its own ceiling without touching the run total | `workflow.ts` `state.phaseBudgets` gate at `agent()` entry |
| per-agent `tokenBudget`/`spendBudget` | `subagent({…})`, `agent(prompt,{…})` | one agent | **HARD**: aborts the agent **mid-run** (per-turn check) | `WorkflowAgent.run` (PR #764) |

**Coexistence proof.** The per-agent hard cap can only *tighten* a run: it
aborts one agent earlier than its `timeoutMs` would. It never weakens the
run-wide or phase soft gates, because those are checked at `agent()` *entry*
(between agents), while the hard cap fires *during* the run via
`WorkflowAgent.run`. If a per-agent cap exceeds the remaining run-wide budget,
the soft gate's existing "in-flight overshoot" behavior is unchanged — the hard
cap does not introduce a new overshoot path.

## 4. Part 1 — SDD dispatch flow (doc + glue)

Mirror PR #763's `commitScope` wiring precisely. All edits are in the
`pi-agent-ext-superpowers` package.

### 4.1 `pi-tools.md`

- **Table row + "Subagents" signature**: append `tokenBudget` / `spendBudget`
  to the two existing `subagent({ … })` call shapes (they currently list
  `commitScope` last — add the budget pair after it).
- **New paragraph `**Budget (SDD).**`** (parallel to `**Commit hygiene (SDD).**`):

  > When dispatching an SDD implementer or reviewer that is expensive or
  > open-ended (exploratory research, a large multi-file refactor, an agent
  > with a generous `timeoutMs`), consider passing `tokenBudget` (and/or
  > `spendBudget`) to bound runaway spend — the run aborts mid-run with status
  > `budget` (`details.budget: {kind,limit,actual}`) if exceeded, distinct from
  > `timedout`. This is **soft guidance, not mandatory** (unlike `commitScope`,
  > there is no known recurring SDD token-runaway failure): a well-scoped
  > implementer on a known codebase rarely needs it. Pairs naturally with
  > `timeoutMs` (wall-clock) — budget catches a *looping* agent that
  > wall-clock alone cannot.

**Convention strength decision.** `commitScope` is "always pass" because it
fixes a documented recurring failure (the `git add -A` sweep, PR #758→#760).
Budget has **no** analogous recurring SDD failure on record, so a default
budget on every dispatch would be over-cautious (and a too-low default could
abort legitimate work). Soft guidance is the honest fit.

### 4.2 `src/superpowers.ts` — `piToolMapping()`

Add `tokenBudget`/`spendBudget` to the dispatch signature that the bootstrap
live-injects (same place `commitScope` was added). This keeps the injected
guidance byte-aligned with `pi-tools.md`.

### 4.3 `tests/bootstrap.test.ts`

Add an assertion (mirroring the existing `commitScope` guard) that the injected
`piToolMapping()` output contains the budget guidance string, so a regression
that drops it fails the build.

## 5. Part 2 — `workflow` `agent()` per-call hard cap (source plumbing)

All edits in the `pi-agent-ext-workflow` package. `WorkflowAgent.run` already
enforces the cap (PR #764), so this is pure forwarding + resume safety.

### 5.1 `AgentOptions` (workflow.ts)

Add two optional fields with doc comments that explicitly distinguish them
from the run-wide soft Budget and the phase sub-budget:

```ts
/**
 * HARD mid-run token cap for THIS agent only. WorkflowAgent.run aborts the
 * session mid-run (per-turn check) once cumulative tokens exceed it; the run
 * surfaces status "budget". Distinct from the run-wide soft `tokenBudget`
 * (checked between agents) and phase sub-budgets — this fires DURING the run.
 */
tokenBudget?: number;
/** HARD mid-run spend ($) cap for THIS agent only. Pairs with tokenBudget. */
spendBudget?: number;
```

### 5.2 `hashAgentCall` (workflow.ts) — resume correctness (REQUIRED)

`hashAgentCall` builds the agent-call identity from a fixed field set
(`prompt`, `model`, `tier`, `phase`, `agentType`, `agentDef`, `schema`,
`isolation`). A budget is part of an agent's identity — changing it MUST
invalidate the cached result on resume (a run with `tokenBudget: 1000` is not
replayable as `tokenBudget: 5000`). Add to the identity object:

```ts
tokenBudget: options.tokenBudget ?? null,
spendBudget: options.spendBudget ?? null,
```

Without this, a workflow edited to change an agent's budget would silently
replay the stale cached output — a correctness bug.

### 5.3 `agentRunner.run()` forwarding (workflow.ts, ~line 504)

Add to the opts object passed to `agentRunner.run(prompt, { … })`:

```ts
tokenBudget: agentOptions.tokenBudget,
spendBudget: agentOptions.spendBudget,
```

No other change — `WorkflowAgent.run` does the enforcement.

### 5.4 `workflow-tool.ts` — budget help

The budget guidance string (the "do not set tokenBudget unless asked" +
"phase('Name',{budget:N})" text) gains a sentence noting the per-agent form:

> For a HARD mid-run cap on a single agent, pass `tokenBudget`/`spendBudget`
> on that `agent()` call — it aborts that agent mid-run (distinct from the
> run-wide soft Budget above).

## 6. Alternatives considered

1. **SDD dispatch only, skip `agent()`** (my initial recommendation).
   Rejected by the user — they want both surfaces wired. Doing `agent()` now
   is cheap (the run layer already exists) and removes a discoverability gap.
2. **Make per-agent budget the default on every SDD dispatch.** Rejected — no
   recurring failure justifies it, and a low default risks aborting legitimate
   work. Soft guidance is the honest convention.
3. **Derive per-agent budget from effort/routing config.** Out of scope (YAGNI)
   until a real need surfaces.
4. **Edit the byte-identical SDD skill bodies.** Rejected — fidelity invariant
   (PR #684); convention lives in pi-port glue only.

## 7. Testing strategy

- **Part 1**: `bootstrap.test.ts` string assertion (guidance present in
  injected mapping).
- **Part 2**:
  - `hashAgentCall` is a pure function — add a unit test that two calls
    differing only in `tokenBudget` (or `spendBudget`) produce different hashes
    (resume invalidation).
  - `workflow-runtime.test.ts` already has the "runWorkflow plumbs opts.X
    through to the agent" pattern (line 308, `tier`). Mirror it: inject a fake
    runner via `options.agent`, call a workflow whose `agent()` passes
    `tokenBudget`/`spendBudget`, assert they reach `runner.run()` opts.
- The mid-run abort *behavior* itself is already covered by PR #764's
  `agent.test.ts` / `spawn-subagent.test.ts`; Part 2 only forwards, so it does
  not re-test the abort.

## 8. Rollout

One PR (`subagent-budget-dispatch-…`), **two commits** (mirrors PR #763's
shape):

1. `feat(superpowers): wire budget into SDD dispatch flow (pi-tools.md +
   bootstrap)` — Part 1.
2. `feat(workflow): agent() per-call tokenBudget/spendBudget hard cap` — Part 2.

CI gate per package: `bun run build && bun test`. `pi-agent-ext-superpowers`
is not in the CI test matrix (pre-existing); its `bootstrap.test.ts` runs
locally + in the changed-packages job.

## 9. Risks

- **Resume hash churn**: adding fields to `hashAgentCall` changes every existing
  journal's hashes → a resume against an old journal cache-misses everything and
  reruns. This is **correct** (the identity genuinely changed) and matches how
  prior field additions (`isolation`, RCA guard) behaved. Acceptable.
- **Discoverability vs. noise**: the budget help text in `workflow-tool.ts` is
  already long; adding one sentence risks bloat. Mitigation: keep it to one
  sentence, cross-reference rather than re-explain.
