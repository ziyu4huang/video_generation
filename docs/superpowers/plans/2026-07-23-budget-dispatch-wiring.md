# Budget Dispatch Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the per-agent `tokenBudget`/`spendBudget` hard cap (shipped in PR #764) into the two dispatch surfaces it is dormant on — the SDD dispatch flow (pi-tools.md + bootstrap) and the `workflow` `agent()` per-call opts.

**Architecture:** Part 1 is doc + bootstrap glue only (mirrors PR #763's `commitScope` wiring). Part 2 forwards two existing fields through `AgentOptions` → `hashAgentCall` (resume correctness) → `agentRunner.run()`; `WorkflowAgent.run` already enforces the cap (PR #764), so Part 2 adds no new enforcement logic.

**Tech Stack:** TypeScript (Bun), `bun:test`, `node:assert/strict`. Monorepo packages `bun-apps/pi-agent-ext-superpowers` and `bun-apps/pi-agent-ext-workflow`.

## Global Constraints

- **Bun only** — never node/npm/yarn. Tests via `( cd bun-apps/<pkg> && bun test )`; typecheck via `bunx tsc`.
- **No top-level `cd`** — use `( cd <dir> && … )` or `--cwd`.
- **Explicit `git add <paths>`** — never `git add -A` (the very failure `commitScope` guards against).
- **Byte-identical SDD skill bodies** — never edit `skills/subagent-driven-development/SKILL.md` or `implementer-prompt.md` (PR #684 fidelity invariant). The convention lives in pi-port glue only (`pi-tools.md`, `superpowers.ts`).
- **CI gate** per package: `bun run build && bun test` (workflow); superpowers runs in the changed-packages job + locally.
- **Spec:** `docs/superpowers/specs/2026-07-23-budget-dispatch-wiring-design.md` (commit `e63eeb8d`).
- **Branch:** `subagent-budget-dispatch-20260723-2051` (already created, spec committed).

---

## File Structure

**Part 1 — `bun-apps/pi-agent-ext-superpowers` (doc + glue):**
- `skills/using-superpowers/references/pi-tools.md` — extend 2 dispatch signatures + add `**Budget (SDD).**` paragraph.
- `src/superpowers.ts` — `piToolMapping()` injected string: add the budget pair to the signature + a soft-guidance sentence.
- `tests/bootstrap.test.ts` — assert the budget guidance strings reach the bootstrap payload.

**Part 2 — `bun-apps/pi-agent-ext-workflow` (source plumbing):**
- `src/workflow.ts` — `AgentOptions` gains `tokenBudget?`/`spendBudget?`; `hashAgentCall` is exported and adds them to the identity; the `agentRunner.run()` call forwards them.
- `src/workflow-tool.ts` — verbose "to bound spend" guideline gains one sentence on the per-agent hard cap.
- `tests/workflow-runtime.test.ts` — `hashAgentCall` unit test (resume invalidation) + `agent()` forwarding test (mirrors the existing `opts.tier` test).

---

## Task 1: SDD dispatch flow — pi-tools.md + bootstrap (superpowers package)

**Files:**
- Modify: `bun-apps/pi-agent-ext-superpowers/skills/using-superpowers/references/pi-tools.md`
- Modify: `bun-apps/pi-agent-ext-superpowers/src/superpowers.ts:153-160` (`piToolMapping()`)
- Test: `bun-apps/pi-agent-ext-superpowers/tests/bootstrap.test.ts:144-154`

**Interfaces:**
- Produces: bootstrap payload now contains `tokenBudget` / `spendBudget` guidance (asserted by test); `pi-tools.md` documents the soft convention.

- [ ] **Step 1: Write the failing test**

In `tests/bootstrap.test.ts`, inside the existing `it("Pi tool mapping names the workflow 'subagent' tool + its documented params", …)` block, add after the `commitScope` assertion (line 152):

```ts
    // tokenBudget/spendBudget: per-agent spend cap (soft guidance — bounds runaway dispatches)
    expect(payload).toContain("tokenBudget");
    expect(payload).toContain("spendBudget");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-superpowers && bun test tests/bootstrap.test.ts )`
Expected: FAIL — `expect(payload).toContain("tokenBudget")` fails (the injected string does not yet mention budget).

- [ ] **Step 3: Extend pi-tools.md (2 signatures + new paragraph)**

Edit `skills/using-superpowers/references/pi-tools.md`:

(a) Table row (line 7) — append the budget pair to the call shape. Old:
```
| Dispatch a subagent (`Subagent (general-purpose):` template) | Use the `subagent` tool provided by `pi-agent-ext-workflow` — `subagent({ task, model, tools, excludeTools, cwd, commitScope })` |
```
New:
```
| Dispatch a subagent (`Subagent (general-purpose):` template) | Use the `subagent` tool provided by `pi-agent-ext-workflow` — `subagent({ task, model, tools, excludeTools, cwd, commitScope, tokenBudget, spendBudget })` |
```

(b) "Subagents" signature (line 13) — add the pair after `commitScope`. Old fragment:
```
(`subagent({ task, model, tools, excludeTools, cwd, commitScope, schema, agentType, timeoutMs, retryOnTransient })`)
```
New fragment:
```
(`subagent({ task, model, tools, excludeTools, cwd, commitScope, tokenBudget, spendBudget, schema, agentType, timeoutMs, retryOnTransient })`)
```

(c) Add a new paragraph immediately AFTER the `**Commit hygiene (SDD).**` paragraph (which ends with "…Ignored for worktree-isolated runs (their commits are discarded at teardown).") and BEFORE the `**Public API (peer-extension code).**` paragraph:

```markdown
**Budget (SDD).** When dispatching an SDD implementer or reviewer that is expensive or open-ended (exploratory research, a large multi-file refactor, an agent with a generous `timeoutMs`), consider passing `tokenBudget` (and/or `spendBudget`) to bound runaway spend — the run aborts mid-run with status `budget` (`details.budget: {kind,limit,actual}`) if exceeded, distinct from `timedout`. This is **soft guidance, not mandatory** (unlike `commitScope`, there is no known recurring SDD token-runaway failure): a well-scoped implementer on a known codebase rarely needs it. Pairs naturally with `timeoutMs` (wall-clock) — budget catches a *looping* agent that wall-clock alone cannot.
```

- [ ] **Step 4: Extend the bootstrap injection (superpowers.ts)**

In `src/superpowers.ts`, inside `piToolMapping()` (the long string at ~line 160):

(a) Add the budget pair to the signature. Old fragment:
```
Use subagent({ task, model, tools, excludeTools, cwd, commitScope }) for Superpowers subagent workflows
```
New fragment:
```
Use subagent({ task, model, tools, excludeTools, cwd, commitScope, tokenBudget, spendBudget }) for Superpowers subagent workflows
```

(b) Add a budget-guidance sentence. Insert it immediately BEFORE the final sentence `If no 'subagent' tool is available, do the work in this session or explain the missing capability instead of inventing Task calls.` — i.e. after `Use [] for a read-only subagent that should commit nothing.`:

```
For expensive or open-ended dispatches (exploratory research, large refactors, generous timeoutMs), consider passing tokenBudget/spendBudget to bound runaway spend - the run aborts mid-run (status 'budget') if exceeded, catching a looping agent that wall-clock timeoutMs alone cannot. Soft guidance: a well-scoped implementer rarely needs it.
```

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-superpowers && bun test tests/bootstrap.test.ts )`
Expected: PASS — both `tokenBudget` and `spendBudget` now present in the payload.

- [ ] **Step 6: Typecheck the package**

Run: `( cd bun-apps/pi-agent-ext-superpowers && bunx tsc )`
Expected: EXIT 0 (string edits only; no type change).

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-superpowers/skills/using-superpowers/references/pi-tools.md bun-apps/pi-agent-ext-superpowers/src/superpowers.ts bun-apps/pi-agent-ext-superpowers/tests/bootstrap.test.ts
git commit -m "feat(superpowers): wire budget into SDD dispatch flow (pi-tools.md + bootstrap)

Mirror the commitScope wiring (PR #763): document tokenBudget/spendBudget
in pi-tools.md (2 dispatch signatures + a 'Budget (SDD)' soft-guidance
paragraph) and live-inject them via piToolMapping() in the bootstrap.
Soft convention (unlike commitScope's 'always'): no known recurring SDD
token-runaway failure, so only expensive/open-ended dispatches are urged
to set a budget. bootstrap.test.ts asserts the guidance reaches the payload."
```

---

## Task 2: workflow agent() per-call tokenBudget/spendBudget hard cap (workflow package)

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow.ts` (`AgentOptions` ~150-185; `hashAgentCall` ~1228-1250; the `agentRunner.run()` opts ~504-530)
- Modify: `bun-apps/pi-agent-ext-workflow/src/workflow-tool.ts` (verbose "to bound spend" guideline ~line 278)
- Test: `bun-apps/pi-agent-ext-workflow/tests/workflow-runtime.test.ts`

**Interfaces:**
- Consumes: `WorkflowAgent.run` already enforces `tokenBudget`/`spendBudget` (PR #764 — `AgentRunOptions.tokenBudget/spendBudget`, `checkBudgetExhaustion`).
- Produces: `AgentOptions.tokenBudget?: number` / `spendBudget?: number`; exported `hashAgentCall(prompt, model, phase, options, agentDefKey)` whose identity includes the budget pair.

- [ ] **Step 1: Write the failing tests**

In `tests/workflow-runtime.test.ts`:

(a) Add `hashAgentCall` to the workflow import (line 5). Old:
```ts
import { type CheckpointOptions, type JournalEntry, runWorkflow } from "../src/workflow.js";
```
New:
```ts
import { type CheckpointOptions, hashAgentCall, type JournalEntry, runWorkflow } from "../src/workflow.js";
```

(b) Add the hash-invalidation unit test (place it just before the existing `opts.tier` test, ~line 308):

```ts
test("hashAgentCall invalidates on tokenBudget/spendBudget change (resume correctness)", () => {
  // A budget is part of an agent's identity: changing it MUST yield a different
  // hash so a resumed run does not replay a result computed under a different cap.
  const h0 = hashAgentCall("p", undefined, undefined, {}, null);
  const hTok1 = hashAgentCall("p", undefined, undefined, { tokenBudget: 1000 }, null);
  const hTok2 = hashAgentCall("p", undefined, undefined, { tokenBudget: 2000 }, null);
  const hSpend = hashAgentCall("p", undefined, undefined, { spendBudget: 0.5 }, null);
  assert.notEqual(hTok1, h0, "tokenBudget present vs absent → different hash");
  assert.notEqual(hTok1, hTok2, "different tokenBudget → different hash");
  assert.notEqual(hSpend, h0, "spendBudget present vs absent → different hash");
  assert.equal(hashAgentCall("p", undefined, undefined, { tokenBudget: 1000 }, null), hTok1, "stable for identical input");
});
```

(c) Add the forwarding test (place it immediately AFTER the `opts.tier` test, ~line 340), mirroring its `runWorkflow(script, { agent, persistLogs: false })` shape:

```ts
test("runWorkflow plumbs opts.tokenBudget/spendBudget through to the agent", async () => {
  // Regression guard: per-agent budget must reach WorkflowAgent.run() (which
  // enforces the hard mid-run cap per PR #764). Mirrors the opts.tier test.
  const seen: Array<{ tokenBudget?: number; spendBudget?: number }> = [];
  const capturingAgent = {
    async run(_prompt: string, options: { tokenBudget?: number; spendBudget?: number }) {
      seen.push({ tokenBudget: options.tokenBudget, spendBudget: options.spendBudget });
      return "ok";
    },
  };

  const script = `export const meta = { name: 'budget_fwd', description: 'budget forwarding', phases: [] }
await agent('p', { label: 'b', tokenBudget: 5000, spendBudget: 0.25 })
return {}`;

  await runWorkflow(script, { agent: capturingAgent, persistLogs: false });

  assert.equal(seen[0]?.tokenBudget, 5000);
  assert.equal(seen[0]?.spendBudget, 0.25);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-runtime.test.ts )`
Expected: FAIL — the hash test fails to import `hashAgentCall` (not exported yet); the forwarding test fails `assert.equal(seen[0]?.tokenBudget, 5000)` (undefined — not forwarded yet).

- [ ] **Step 3: Add the AgentOptions fields (workflow.ts)**

In `src/workflow.ts`, in the `AgentOptions` interface, add after the existing `retries?: number;` field (the last field, ~line 184):

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

- [ ] **Step 4: Export hashAgentCall + add budget to its identity (workflow.ts)**

In `src/workflow.ts`, the `hashAgentCall` function (~line 1228):

(a) Export it. Old:
```ts
function hashAgentCall(
```
New:
```ts
export function hashAgentCall(
```

(b) Add the budget pair to the identity object, after the `isolation: options.isolation ?? null,` line:

```ts
    // Budget is part of an agent's identity — a different cap is a different run
    // (changing it MUST invalidate the cached result on resume).
    tokenBudget: options.tokenBudget ?? null,
    spendBudget: options.spendBudget ?? null,
```

- [ ] **Step 5: Forward the budget in the agentRunner.run() call (workflow.ts)**

In `src/workflow.ts`, in the `agentRunner.run(prompt, { … })` opts object (~line 504-530), add the two fields. Insert them immediately after the `disallowedToolNames: agentDef?.disallowedTools,` line:

```ts
                  tokenBudget: agentOptions.tokenBudget,
                  spendBudget: agentOptions.spendBudget,
```

- [ ] **Step 6: Add the per-agent-cap sentence to workflow-tool.ts**

In `src/workflow-tool.ts`, the verbose "to bound spend" guideline (~line 278). Append one sentence to the existing string. Old (the string ends with):
```
…branch on budget.remaining() to skip optional rounds or choose a lighter tier.",
```
New (append before the closing `",`):
```
…branch on budget.remaining() to skip optional rounds or choose a lighter tier. For a HARD mid-run cap on a single agent, pass tokenBudget/spendBudget on that agent() call — it aborts that agent mid-run (distinct from the run-wide soft Budget above).",
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-runtime.test.ts )`
Expected: PASS — both new tests green; no existing test regresses.

- [ ] **Step 8: Full build + suite**

Run:
```bash
( cd bun-apps/pi-agent-ext-workflow && bunx tsc && bun test )
```
Expected: `tsc` EXIT 0; full suite `0 fail` (was 1238 pass after PR #764; now +2 tests).

- [ ] **Step 9: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow.ts bun-apps/pi-agent-ext-workflow/src/workflow-tool.ts bun-apps/pi-agent-ext-workflow/tests/workflow-runtime.test.ts
git commit -m "feat(workflow): agent() per-call tokenBudget/spendBudget hard cap

Forward the per-agent budget (shipped in WorkflowAgent.run by PR #764)
through workflow's agent(): AgentOptions gains tokenBudget/spendBudget,
agentRunner.run() forwards them, and hashAgentCall includes them in the
call identity so a budget change invalidates the cached result on resume.
Export hashAgentCall for direct unit testing.

Coexists with the run-wide soft Budget + phase sub-budgets (both checked
between agents): the per-agent cap is a HARD mid-run abort on ONE agent,
so it can only tighten — never weaken — the soft gates. workflow-tool.ts
verbose guideline gains one sentence documenting the per-agent form."
```

---

## Final Verification (after both tasks)

- [ ] **V1: Both packages green**
```bash
( cd bun-apps/pi-agent-ext-superpowers && bunx tsc && bun test )
( cd bun-apps/pi-agent-ext-workflow && bunx tsc && bun test )
```
Expected: both EXIT 0 / 0 fail.

- [ ] **V2: Diff sanity** — `git diff origin/main --stat` shows ONLY the 6 files listed in File Structure (3 per package), nothing swept in.

- [ ] **V3: Push + PR**
```bash
git push -u origin subagent-budget-dispatch-20260723-2051
gh pr create --base main --title "feat: wire per-agent budget into SDD dispatch + workflow agent()" --body "<2-commit body: Part 1 superpowers, Part 2 workflow>"
```
