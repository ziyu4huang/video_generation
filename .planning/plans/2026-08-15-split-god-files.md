# Split Three God Files — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `core-runtime/src/agent.ts` (1,146), `pi-agent/run-dir/resolve.ts` (822), and `core-task/src/goal/goal.ts` (1,522) into focused modules while every original file remains a facade that re-exports what it used to define.

**Architecture:** Pure relocation. Each original file keeps its public surface by re-exporting extracted symbols, so no consumer and no test changes. The binding constraint throughout is **import cycles**: every group extracts its shared substrate *first*, which forces a one-way dependency graph. Cycles were mapped empirically (results embedded below) — do not re-derive them, and do not reorder tasks.

**Tech Stack:** TypeScript, Bun, biome. No new dependencies.

Source spec: `.planning/specs/2026-08-15-core-packages-simplification-design.md`

---

## Deviation from the spec (read this first)

The spec's 1b said three new modules. Empirical dependency mapping found **two cycles the spec missed**, so 1b needs five:

1. `resolveStructuredOutput` (agent.ts:114-175) calls `throwIfProviderLimit` (agent.ts:72-100), and `agent.ts` already imports `structured-output.js`. Moving the former into `structured-output.ts` creates `structured-output → agent → structured-output`. **Fix:** extract `provider-limit.ts` first.
2. `agent-model` code (agent.ts:176-260) uses four symbols from `model-tier-config.js`, while `model-tier-config.ts:12` imports `listAvailableModelSpecs` from `agent.js`. **Fix:** extract `listAvailableModelSpecs` into its own `available-models.ts` first, which both then import.

`resolve.ts` has a third, smaller one: `warn()` is called 10× *after* line 315, so it cannot simply travel with the deps-probe block. It moves to `deps-probe.ts` and `resolve.ts` imports it back — direction stays one-way because `resolve.ts` already calls `maybeAutoInstall` / `emitMissingDepsGuide`.

Update the spec's 1b table as part of Task A7.

## File structure

### Group A — `bun-apps/pi-agent-ext-core-runtime/src/`

| File | Status | Source lines | Responsibility |
|---|---|---|---|
| `provider-limit.ts` | create | agent.ts:72-100 | detect a provider-limit stop reason and throw the typed error |
| `available-models.ts` | create | agent.ts:298-311 | list model specs available in the agent dir |
| `agent-budget.ts` | create | agent.ts:312-631 | token/cost budget accounting and the budget guard |
| `agent-turns.ts` | create | agent.ts:632-717 | turn counting and the turn guard |
| `agent-model.ts` | create | agent.ts:176-260 | model-spec resolution and tier fallback |
| `structured-output.ts` | modify | agent.ts:22-71, 101-175 | the structured-output tool **and** extracting/validating its result |
| `agent.ts` | modify | keeps 1-21, 261-297, 719-1146 | `CoreAgent` + its option types, plus the facade re-exports |
| `index.ts` | modify | — | re-export sources updated; public surface unchanged |

Verified preconditions: `agent.ts` has **zero** module-level mutable state; **no** package deep-imports core-runtime internals (every consumer goes through `index.ts`); lines 312-631 reference **no** cross-section symbol at all.

### Group B — `bun-apps/pi-agent/run-dir/`

| File | Status | Source lines | Responsibility |
|---|---|---|---|
| `lazy-extensions.ts` | create | resolve.ts:687-822 | alias detection and lazy extension resolution |
| `deps-probe.ts` | create | resolve.ts:55-315 | probe missing extension deps, auto-install, emit the guide |
| `resolve.ts` | modify | keeps 1-54, 316-686 | run-dir layout detection + argv building, plus re-exports |

Verified: the lazy block (687-822) is referenced **0×** before line 687 — the safest extraction in this plan, which is why it goes first.

### Group C — `bun-apps/pi-agent-ext-core-task/src/goal/`

| File | Status | Source lines | Responsibility |
|---|---|---|---|
| `internals.ts` | create | goal.ts:1304-1522 | the shared tail helpers every other section calls |
| `goal-complete-tool.ts` | create | goal.ts:182-480 | the `goal_complete` tool definition |
| `timers.ts` | create | goal.ts:1153-1245 | status-refresh timer + heartbeat timer |
| `prompting.ts` | create | goal.ts:1246-1303 | the `send*Prompt` family |
| `lifecycle.ts` | create | goal.ts:940-1152 | start / pause / resume / clear / edit / show |
| `register-commands.ts` | create | goal.ts:483-664 | the `/goal` and `/list` command registrations |
| `hooks.ts` | create | goal.ts:665-938 | the six `pi.on(...)` handlers |
| `goal.ts` | modify | keeps 1-181, 481-482 | facade, `StatusContext`, `default function goal()`, `isGoalActive`, plan-peer readers |

The continuation-marker helpers (originally 1409-1462) travel with `internals.ts`,
not with `prompting.ts` — they are called from the hooks block as well.

`register-commands.ts` is **not** in the spec's 1a table. Without it `goal.ts` lands
at ~350 lines rather than the ~200 the spec promises, because the 182-line command
registration block has no other home. Task C7 corrects the spec.

Measured helper fan-out (why `internals.ts` must be first):

| helper | tool block | hooks block | lifecycle block |
|---|---:|---:|---:|
| `setAndPersistGoal` | 6 | 7 | 7 |
| `currentTokenTotal` | 2 | 1 | 3 |
| `clearGoalRecovery` | 0 | 4 | 4 |
| `updateStatus` | 0 | 5 | 0 |
| `clearActiveGoal` | 3 | 0 | 1 |

Resulting one-way graph: `goal.ts → hooks / lifecycle / timers / prompting / goal-complete-tool → internals → state`.

## Four corrections learned from Task A1 — apply to every remaining task

**1. Line numbers are anchors, not boundaries.** Every range in this plan came from
`grep -n` on the **declaration** line (`export function foo`). A doc comment sits
*above* its declaration, so each stated range starts one comment too late and ends
one comment too far — it drops the item's own doc comment and swallows the next
item's. Cut by **named symbol + its own doc comment**, stopping before the next
symbol's comment. Confirmed on A1: the stated 72-100 was actually 66-98, and line
100 belonged to an unrelated interface. If the content at a stated range is not what
the task describes, that is expected — follow the symbols. Report `NEEDS_CONTEXT`
only if the named symbols cannot be found at all.

**2. biome is not clean on `core-runtime`.** `bun run check` reports 5 pre-existing
errors, in `src/agent-row-display.ts`, `src/subagent-in-flight.ts`, and four test
files. The gate is **"no new findings"**, not "zero" — compare before/after with
`git stash`.

**3. A re-export needs no import.** `export { x } from "./m.js"` makes `x` public
without binding it locally. Import only what the file still **calls**; importing a
symbol you merely re-export trips biome's `noUnusedImports`.

**4. Grep for stale `agent.ts` pointers — a required step in every task.** Comments
that name the file the code just left rot invisibly, and six splits multiply it. A1
found `errors.ts:138`. Already known to be waiting: `model-tier-config.ts:10`
("which always wins — see agent.ts") for Task A5, and `structured-output.ts:40`
("repair-loop fallback (agent.ts)") for Task A6. Before committing, run:

```bash
grep -rnE '(agent|available-models|agent-budget|agent-turns|agent-model|structured-output|provider-limit)\.(ts|js)' \
  bun-apps/pi-agent-ext-core-runtime/src/
```

and fix any pointer that now names the wrong file.

**Both extensions matter.** The first version of this sweep matched only
`agent\.ts`, so it structurally could not see `model-role-config.ts:5`, which said
`agent.js` — and that is exactly how A2 shipped with a stale reciprocal pointer.
Prose in this package uses both specifier styles.

**Check the reciprocal, not just the file you edited.** When module X stops
importing Y, it is usually *Y's* header (or a third sibling's) that becomes false.
The model cluster produced two rounds of this: `errors.ts:138` after A1, then
`model-role-config.ts:5` after A2 — the second one *created* by fixing the first.
Whenever a header claims "split so consumers avoid pulling in Z", re-verify that Z
is still what gets avoided.

**A header must state present facts, not plans.** A2's first header described its
cycle in the future tense ("would otherwise cycle once agent-model.ts is
extracted") when the cycle already existed, and named a file that does not exist
yet. Assert only what is true and checkable at commit time.

**Facade re-export convention (set by A1, follow it):** put every re-export in the
single annotated block below the import list in `agent.ts` — not at the old
definition site. After six extractions, positional placement would scatter six
re-exports through the body.

## Gates (exact commands)

Run from the repo root. **`core-runtime`'s `check` is biome, not tsc** — both are required.

```bash
bun run --cwd bun-apps/pi-agent-ext-core-runtime check
bun run --cwd bun-apps/pi-agent-ext-core-runtime typecheck
bun run --cwd bun-apps/pi-agent-ext-core-runtime test

bun run --cwd bun-apps/pi-agent typecheck
bun run --cwd bun-apps/pi-agent test

bun run --cwd bun-apps/pi-agent-ext-core-task typecheck
bun run --cwd bun-apps/pi-agent-ext-core-task test
```

**The load-bearing invariant for every task in this plan:** no test file may be edited. If a test needs a change, the facade is wrong — revert and fix the facade, do not edit the test.

---

## Group A — `agent.ts` (do this group first: safest, tests already aligned)

### Task A1: Extract `provider-limit.ts`

**Files:**
- Create: `bun-apps/pi-agent-ext-core-runtime/src/provider-limit.ts`
- Modify: `bun-apps/pi-agent-ext-core-runtime/src/agent.ts`

- [ ] **Step 1: Record the current green baseline**

```bash
bun run --cwd bun-apps/pi-agent-ext-core-runtime test 2>&1 | tail -3
```

Expected: a pass count with 0 failures. Write the number down; every later task must match or exceed it.

- [ ] **Step 2: Create the new module**

Create `src/provider-limit.ts` containing **verbatim** `agent.ts` lines 72-100 (`lastAssistantError` and `throwIfProviderLimit`, including their doc comments), with this import header:

```ts
import { classifyProviderLimit, WorkflowError, WorkflowErrorCode } from "./errors.js";
```

Do not retype the function bodies — cut and paste them.

- [ ] **Step 3: Replace the originals with a re-export**

Delete lines 72-100 from `agent.ts` and add to its import block:

```ts
import { lastAssistantError, throwIfProviderLimit } from "./provider-limit.js";
```

and to its export section:

```ts
export { lastAssistantError, throwIfProviderLimit } from "./provider-limit.js";
```

Both are needed: the re-export preserves the public surface, the import keeps the two call sites inside `agent.ts` (line ~149 and ~1066) working.

- [ ] **Step 4: Verify**

```bash
bun run --cwd bun-apps/pi-agent-ext-core-runtime typecheck
bun run --cwd bun-apps/pi-agent-ext-core-runtime test 2>&1 | tail -3
```

Expected: typecheck silent (exit 0); test count identical to Step 1. Zero test files changed — confirm with `git status --short | grep test` returning nothing.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-core-runtime/src/provider-limit.ts bun-apps/pi-agent-ext-core-runtime/src/agent.ts
git commit -m "refactor(core-runtime): extract provider-limit.ts from agent.ts

Breaks the cycle that would otherwise form in the next task:
resolveStructuredOutput calls throwIfProviderLimit, and agent.ts
already imports structured-output.js."
```

### Task A2: Extract `available-models.ts`

**Files:**
- Create: `bun-apps/pi-agent-ext-core-runtime/src/available-models.ts`
- Modify: `bun-apps/pi-agent-ext-core-runtime/src/agent.ts`, `src/model-tier-config.ts`

- [ ] **Step 1: Create the new module**

Create `src/available-models.ts` containing verbatim `agent.ts` lines 298-311 (`listAvailableModelSpecs`), with:

```ts
import { getAgentDir, ModelRegistry } from "@earendil-works/pi-coding-agent";
```

- [ ] **Step 2: Repoint the one internal consumer**

In `src/model-tier-config.ts`, change line 12 from:

```ts
import { listAvailableModelSpecs } from "./agent.js";
```

to:

```ts
import { listAvailableModelSpecs } from "./available-models.js";
```

This is the cycle break: `agent-model.ts` (Task A5) needs `model-tier-config.js`, so `model-tier-config.ts` must stop reaching back into `agent.js`.

- [ ] **Step 3: Delete the original and re-export**

Delete lines 298-311 from `agent.ts`; add:

```ts
export { listAvailableModelSpecs } from "./available-models.js";
```

- [ ] **Step 4: Verify**

```bash
bun run --cwd bun-apps/pi-agent-ext-core-runtime typecheck
bun run --cwd bun-apps/pi-agent-ext-core-runtime test 2>&1 | tail -3
```

Expected: typecheck exit 0; `model-tier-config.test.ts` (151 lines) still passes unchanged.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-core-runtime/src/available-models.ts bun-apps/pi-agent-ext-core-runtime/src/agent.ts bun-apps/pi-agent-ext-core-runtime/src/model-tier-config.ts
git commit -m "refactor(core-runtime): extract available-models.ts and cut the model-tier-config back-edge"
```

### Task A3: Extract `agent-budget.ts`

**Files:**
- Create: `bun-apps/pi-agent-ext-core-runtime/src/agent-budget.ts`
- Modify: `bun-apps/pi-agent-ext-core-runtime/src/agent.ts`, `src/index.ts`

- [ ] **Step 1: Create the new module**

Create `src/agent-budget.ts` containing verbatim `agent.ts` lines 312-631. This block references **no** symbol from any other section (verified), so its only import is:

```ts
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
```

Drop that import line if biome reports it unused — check with `bun run --cwd bun-apps/pi-agent-ext-core-runtime check`.

The block's public symbols, all of which must be re-exported: `AgentUsage`, `BudgetExhaustion`, `checkBudgetExhaustion`, `BudgetWarning`, `BUDGET_WARNING_RATIO`, `checkBudgetWarning`, `BudgetSessionSurface`, `isUsageObservation`, `BudgetSeam`, `BUDGET_WRAP_UP_MESSAGE`, `BUDGET_GRACE_CEILING_RATIO`, `BudgetGuard`, `createBudgetGuard`.

- [ ] **Step 2: Delete the original and re-export**

Delete lines 312-631 from `agent.ts` and add:

```ts
export {
  BUDGET_GRACE_CEILING_RATIO,
  BUDGET_WARNING_RATIO,
  BUDGET_WRAP_UP_MESSAGE,
  checkBudgetExhaustion,
  checkBudgetWarning,
  createBudgetGuard,
  isUsageObservation,
} from "./agent-budget.js";
export type {
  AgentUsage,
  BudgetExhaustion,
  BudgetGuard,
  BudgetSeam,
  BudgetSessionSurface,
  BudgetWarning,
} from "./agent-budget.js";
```

If `CoreAgent` (still in `agent.ts`) calls `createBudgetGuard`, also add a matching `import` line — the re-export alone does not bring the name into scope.

- [ ] **Step 3: Verify**

```bash
bun run --cwd bun-apps/pi-agent-ext-core-runtime typecheck
bun run --cwd bun-apps/pi-agent-ext-core-runtime test 2>&1 | tail -3
```

Expected: `budget-guard.test.ts` (422 lines) and `agent-budget.test.ts` (247 lines) pass **without being edited**. These two files are the reason this seam is trustworthy — they were already split along it.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-core-runtime/src/agent-budget.ts bun-apps/pi-agent-ext-core-runtime/src/agent.ts
git commit -m "refactor(core-runtime): extract agent-budget.ts from agent.ts"
```

### Task A4: Extract `agent-turns.ts`

**Files:**
- Create: `bun-apps/pi-agent-ext-core-runtime/src/agent-turns.ts`
- Modify: `bun-apps/pi-agent-ext-core-runtime/src/agent.ts`

- [ ] **Step 1: Create the new module**

Create `src/agent-turns.ts` containing verbatim `agent.ts` lines 632-717, with:

```ts
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
```

Public symbols: `TurnSessionSurface`, `TurnExhaustion`, `isTurnStartObservation`, `isTurnEndObservation`, `TurnGuard`, `createTurnGuard`, `turnExhaustionError`.

- [ ] **Step 2: Delete the original and re-export**

Delete lines 632-717 from `agent.ts` and add:

```ts
export { createTurnGuard, isTurnEndObservation, isTurnStartObservation, turnExhaustionError } from "./agent-turns.js";
export type { TurnExhaustion, TurnGuard, TurnSessionSurface } from "./agent-turns.js";
```

Add an `import` of the same value exports if `CoreAgent` calls them.

- [ ] **Step 3: Verify**

```bash
bun run --cwd bun-apps/pi-agent-ext-core-runtime typecheck
bun run --cwd bun-apps/pi-agent-ext-core-runtime test 2>&1 | tail -3
```

Expected: `agent-turns.test.ts` (325 lines) passes unedited.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-core-runtime/src/agent-turns.ts bun-apps/pi-agent-ext-core-runtime/src/agent.ts
git commit -m "refactor(core-runtime): extract agent-turns.ts from agent.ts"
```

### Task A5: Extract `agent-model.ts`

**Files:**
- Create: `bun-apps/pi-agent-ext-core-runtime/src/agent-model.ts`
- Modify: `bun-apps/pi-agent-ext-core-runtime/src/agent.ts`

- [ ] **Step 1: Create the new module**

Create `src/agent-model.ts` containing verbatim `agent.ts` lines 176-260 (`resolveAgentModelSpec`, `FallbackDecision`, `resolveFallbackModel`), with:

```ts
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadModelTierConfig, type ModelTierConfig, resolveTierModel, sortedTierNames } from "./model-tier-config.js";
```

This import is only safe because Task A2 already removed `model-tier-config.ts`'s edge back into `agent.js`. If A2 was skipped, this task creates a cycle.

- [ ] **Step 2: Delete the original and re-export**

Delete lines 176-260 from `agent.ts` and add:

```ts
export { resolveAgentModelSpec, resolveFallbackModel } from "./agent-model.js";
export type { FallbackDecision } from "./agent-model.js";
```

- [ ] **Step 3: Verify**

```bash
bun run --cwd bun-apps/pi-agent-ext-core-runtime typecheck
bun run --cwd bun-apps/pi-agent-ext-core-runtime test 2>&1 | tail -3
```

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-core-runtime/src/agent-model.ts bun-apps/pi-agent-ext-core-runtime/src/agent.ts
git commit -m "refactor(core-runtime): extract agent-model.ts from agent.ts"
```

### Task A6: Fold structured-output extraction into `structured-output.ts`

**Files:**
- Modify: `bun-apps/pi-agent-ext-core-runtime/src/structured-output.ts`, `src/agent.ts`

- [ ] **Step 1: Move the code**

Append to `src/structured-output.ts`, verbatim, `agent.ts` lines 22-71 (`findJsonBlock`'s doc comment through `extractValidated`) and lines 101-175 (`StructuredSession`, `resolveStructuredOutput`). Extend its import header to:

```ts
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Check, Convert } from "typebox/value";
import { throwIfProviderLimit } from "./provider-limit.js";
```

The `provider-limit.js` import is what Task A1 made possible.

- [ ] **Step 2: Delete the originals and re-export**

Delete lines 22-71 and 101-175 from `agent.ts` and add:

```ts
export { extractValidated, resolveStructuredOutput } from "./structured-output.js";
export type { StructuredSession } from "./structured-output.js";
```

`agent.ts` already imports `createStructuredOutputTool` from this module; extend that existing import rather than adding a second one.

- [ ] **Step 3: Verify**

```bash
bun run --cwd bun-apps/pi-agent-ext-core-runtime check
bun run --cwd bun-apps/pi-agent-ext-core-runtime typecheck
bun run --cwd bun-apps/pi-agent-ext-core-runtime test 2>&1 | tail -3
```

Expected: `structured-output.test.ts` (116 lines) passes unedited; `agent.ts` is now roughly 500 lines.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-core-runtime/src/structured-output.ts bun-apps/pi-agent-ext-core-runtime/src/agent.ts
git commit -m "refactor(core-runtime): move structured-output extraction beside its tool"
```

### Task A7: Repoint the barrel and update the spec

**Files:**
- Modify: `bun-apps/pi-agent-ext-core-runtime/src/index.ts`, `CONTEXT.md`
- Modify: `.planning/specs/2026-08-15-core-packages-simplification-design.md`

- [ ] **Step 1: Repoint `index.ts`**

`index.ts` lines 5-40 currently re-export everything from `./agent.js`. Change each symbol's source to its new owning module (`./agent-budget.js`, `./agent-turns.js`, `./agent-model.js`, `./available-models.js`, `./provider-limit.js`, `./structured-output.js`), leaving only `CoreAgent` and its option/result types on `./agent.js`.

The exported **names** must not change. Verify with:

```bash
git diff bun-apps/pi-agent-ext-core-runtime/src/index.ts | grep -E '^[-+].*export' | grep -oE '\b[A-Za-z_]+\b' | sort | uniq -c | awk '$1 % 2 == 1'
```

Expected: no output (every name appears an even number of times — once removed, once re-added).

- [ ] **Step 2: Record the new layout in `CONTEXT.md`**

Add to `bun-apps/pi-agent-ext-core-runtime/CONTEXT.md`, in the existing term-definition style:

```markdown
**Module layout** — `agent.ts` owns `CoreAgent` only. Budget accounting lives in
`agent-budget.ts`, turn counting in `agent-turns.ts`, model/tier resolution in
`agent-model.ts`, spec listing in `available-models.ts`, provider-limit detection in
`provider-limit.ts`, structured-output extraction beside its tool in
`structured-output.ts`. Two edges are load-bearing and must stay one-way:
`model-tier-config.ts` must NOT import from `agent.js` (use `available-models.js`),
and `structured-output.ts` must NOT import from `agent.js` (use
`provider-limit.js`). Both were cycles before the 2026-08-15 split.
```

- [ ] **Step 3: Correct the spec's 1b table**

In `.planning/specs/2026-08-15-core-packages-simplification-design.md`, replace the 1b table's three rows with the five actual modules and add a sentence recording the two cycles found during implementation. The spec's "new focused modules: 11" line becomes 13.

- [ ] **Step 4: Full-group verification**

```bash
bun run --cwd bun-apps/pi-agent-ext-core-runtime check
bun run --cwd bun-apps/pi-agent-ext-core-runtime typecheck
bun run --cwd bun-apps/pi-agent-ext-core-runtime test 2>&1 | tail -3
git status --short | grep -c test
```

Expected: all three gates green, test count matches Task A1's baseline, and the last command prints `0`.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-core-runtime/src/index.ts bun-apps/pi-agent-ext-core-runtime/CONTEXT.md .planning/specs/2026-08-15-core-packages-simplification-design.md
git commit -m "refactor(core-runtime): repoint the barrel; record the two cycles the split had to break"
```

---

## Group B — `resolve.ts`

### Task B1: Extract `lazy-extensions.ts`

**Files:**
- Create: `bun-apps/pi-agent/run-dir/lazy-extensions.ts`
- Modify: `bun-apps/pi-agent/run-dir/resolve.ts`

- [ ] **Step 1: Record the baseline**

```bash
bun run --cwd bun-apps/pi-agent test 2>&1 | tail -3
```

- [ ] **Step 2: Create the new module**

Create `run-dir/lazy-extensions.ts` containing verbatim `resolve.ts` lines 687-822 (`LazySettings`, `looksLikeAlias`, `resolveLazyExtension`, `rewriteArgvLazyExtensions`, and the lazy-registry re-export at line 687). Carry over only the imports those lines actually use.

This block is referenced **0×** before line 687, so nothing in `resolve.ts` needs an import back.

- [ ] **Step 3: Delete the originals and re-export**

Delete lines 687-822 from `resolve.ts` and add:

```ts
export { looksLikeAlias, resolveLazyExtension, rewriteArgvLazyExtensions } from "./lazy-extensions.ts";
export type { LazySettings } from "./lazy-extensions.ts";
```

Note the `.ts` extension: `run-dir/` uses explicit `.ts` specifiers (see `patches/load-run-dir-resources.ts:13`), unlike `core-runtime`'s `.js`.

- [ ] **Step 4: Verify**

```bash
bun run --cwd bun-apps/pi-agent typecheck
bun run --cwd bun-apps/pi-agent test 2>&1 | tail -3
```

Expected: `run-dir/resolve.test.ts` and `src/__tests__/e2e-extensions.test.ts` pass unedited. `patches/load-run-dir-resources.ts` imports `rewriteArgvLazyExtensions` from `../../run-dir/resolve.ts` — the re-export is what keeps that working, so a failure there means Step 3 was skipped.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent/run-dir/lazy-extensions.ts bun-apps/pi-agent/run-dir/resolve.ts
git commit -m "refactor(pi-agent): extract lazy-extensions.ts from run-dir/resolve.ts"
```

### Task B2: Extract `deps-probe.ts`

**Files:**
- Create: `bun-apps/pi-agent/run-dir/deps-probe.ts`
- Modify: `bun-apps/pi-agent/run-dir/resolve.ts`

- [ ] **Step 1: Create the new module**

Create `run-dir/deps-probe.ts` containing verbatim `resolve.ts` lines 55-315: `warn`, `probeMissingNpm`, `runtimeDependencyNames`, `probeMissingExtensionDeps`, `missingExtensionPackages`, `maybeAutoInstall`, `emitMissingDepsGuide`, plus the `PackageJsonWithDeps` type they use.

Export `warn` even though it was file-local — `resolve.ts` calls it 10× after line 315.

- [ ] **Step 2: Delete the originals, import back, re-export**

Delete lines 55-315 from `resolve.ts` and add:

```ts
import { emitMissingDepsGuide, maybeAutoInstall, warn } from "./deps-probe.ts";

export { missingExtensionPackages, probeMissingExtensionDeps, runtimeDependencyNames } from "./deps-probe.ts";
```

The `import` covers `resolve.ts`'s own remaining calls (`warn` ×10, `maybeAutoInstall` ×2, `emitMissingDepsGuide` ×2); the `export` preserves what `src/index.ts` re-exports. `probeMissingNpm` was file-local and is referenced 0× after line 315 — do not export it.

- [ ] **Step 3: Verify**

```bash
bun run --cwd bun-apps/pi-agent typecheck
bun run --cwd bun-apps/pi-agent test 2>&1 | tail -3
```

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent/run-dir/deps-probe.ts bun-apps/pi-agent/run-dir/resolve.ts
git commit -m "refactor(pi-agent): extract deps-probe.ts from run-dir/resolve.ts"
```

### Task B3: Record the layout

**Files:**
- Modify: `bun-apps/pi-agent/CONTEXT.md`

- [ ] **Step 1: Document it**

Add to `bun-apps/pi-agent/CONTEXT.md`:

```markdown
**run-dir module layout** — `resolve.ts` owns run-dir layout detection and argv
building only. Dependency probing / auto-install / the missing-deps guide live in
`deps-probe.ts`; alias and lazy-extension resolution in `lazy-extensions.ts`.
`resolve.ts` re-exports both so `src/index.ts` and
`patches/load-run-dir-resources.ts` keep their existing import paths. `warn()`
lives in `deps-probe.ts` because `resolve.ts` calls it 10× — the edge is one-way.
```

- [ ] **Step 2: Verify and commit**

```bash
bun run --cwd bun-apps/pi-agent typecheck
bun run --cwd bun-apps/pi-agent test 2>&1 | tail -3
git add bun-apps/pi-agent/CONTEXT.md
git commit -m "docs(pi-agent): record the run-dir module layout"
```

---

## Group C — `goal.ts` (do last: highest cycle risk)

### Task C1: Extract `internals.ts` — **must be first in this group**

**Files:**
- Create: `bun-apps/pi-agent-ext-core-task/src/goal/internals.ts`
- Modify: `bun-apps/pi-agent-ext-core-task/src/goal/goal.ts`

- [ ] **Step 1: Record the baseline**

```bash
bun run --cwd bun-apps/pi-agent-ext-core-task test 2>&1 | tail -3
```

- [ ] **Step 2: Move the three module-level bindings into `goalState`**

`goal.ts` has exactly three module-level mutable bindings — `goalOverlay` (line 112), `piRef` (116), `auditRunner` (137). Add them to the `GoalRuntimeState` interface in `src/goal/state.ts` (line 145) and to the `goalState` object literal (line 194), and extend `__resetGoalState()` (line 221) to clear them.

The extracted modules cannot see `goal.ts`'s file-local bindings, and `goalState` is the singleton that already exists for exactly this purpose.

- [ ] **Step 3: Create `internals.ts`**

Create `src/goal/internals.ts` containing verbatim `goal.ts` lines 1304-1522 — the ~35 shared helpers, including `updateStatus`, `setAndPersistGoal`, `hasPendingMessages`, `abortCurrentTurn`, `blockStaleGoalToolCalls`, `clearStaleGoalToolCallBlock`, `resetHardeningCounters`, `safeStringify`, `clearGoalRecovery`, `clearGoalRecoveryForGoal`, `isPiOwnedCompactionRetry`, `clearContinuationTracking`, `cancelContinuationPending`, `rememberCancelledContinuationMarker`, `consumeCancelledContinuationPrompt`, `markContinuationDelivered`, `continuationMarker`, `escapeRegExpText`, `extractContinuationMarker`, `formatError`, `truncateNotification`, `currentTokenTotal`, `clearActiveGoal`, `showCompletionStatus`.

Export every one of them — later tasks in this group need them across three different modules. Import `goalState` from `./state.js`.

- [ ] **Step 4: Delete the originals and import back**

Delete lines 1304-1522 from `goal.ts` and import the names it still uses from `./internals.js`.

- [ ] **Step 5: Verify**

```bash
bun run --cwd bun-apps/pi-agent-ext-core-task typecheck
bun run --cwd bun-apps/pi-agent-ext-core-task test 2>&1 | tail -3
```

Expected: `goal.test.ts` (1,360 lines) and `state.test.ts` (238 lines) pass unedited.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/goal/internals.ts bun-apps/pi-agent-ext-core-task/src/goal/goal.ts bun-apps/pi-agent-ext-core-task/src/goal/state.ts
git commit -m "refactor(core-task): extract goal/internals.ts and move the three module bindings into goalState

internals.ts must be extracted first: setAndPersistGoal is called 6/7/7 times
across the tool, hooks, and lifecycle blocks, so any other order produces a cycle."
```

### Task C2: Extract `timers.ts`

**Files:**
- Create: `bun-apps/pi-agent-ext-core-task/src/goal/timers.ts`
- Modify: `bun-apps/pi-agent-ext-core-task/src/goal/goal.ts`

- [ ] **Step 1: Create the new module**

Create `src/goal/timers.ts` containing verbatim `goal.ts` lines 1153-1245: `tickActiveGoalStatus`, `stopStatusRefreshTimer`, `syncStatusRefreshTimer`, `stopHeartbeatTimer`, `syncHeartbeatTimer`. Import what it needs from `./internals.js` and `./state.js`.

- [ ] **Step 2: Delete, import back, re-export**

Delete lines 1153-1245 from `goal.ts` and add:

```ts
import { stopHeartbeatTimer, stopStatusRefreshTimer, syncHeartbeatTimer, syncStatusRefreshTimer } from "./timers.js";
```

None of these five were exported from `goal.ts`, so no re-export is needed — confirm with `grep -n 'export.*syncStatusRefreshTimer' src/goal/goal.ts` returning nothing before you delete.

- [ ] **Step 3: Verify**

```bash
bun run --cwd bun-apps/pi-agent-ext-core-task typecheck
bun run --cwd bun-apps/pi-agent-ext-core-task test 2>&1 | tail -3
```

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/goal/timers.ts bun-apps/pi-agent-ext-core-task/src/goal/goal.ts
git commit -m "refactor(core-task): extract goal/timers.ts"
```

### Task C3: Extract `prompting.ts`

**Files:**
- Create: `bun-apps/pi-agent-ext-core-task/src/goal/prompting.ts`
- Modify: `bun-apps/pi-agent-ext-core-task/src/goal/goal.ts`

- [ ] **Step 1: Create the new module**

Create `src/goal/prompting.ts` containing verbatim `goal.ts` lines 1246-1303: `sendGoalPrompt`, `sendObjectiveUpdatedPrompt`, `sendResumePrompt`, `sendLengthContinue`, `sendContinuationPrompt`, `sendPrompt`. Import from `./internals.js`, `./state.js`, and `./prompts.js`.

The continuation-marker helpers that were originally at lines 1409-1462 already moved to `internals.ts` in Task C1; import them from there rather than moving them again.

- [ ] **Step 2: Delete and import back**

Delete lines 1246-1303 from `goal.ts` and add:

```ts
import {
  sendContinuationPrompt,
  sendGoalPrompt,
  sendLengthContinue,
  sendObjectiveUpdatedPrompt,
  sendResumePrompt,
} from "./prompting.js";
```

`sendPrompt` is the shared private helper the other five call — keep it inside `prompting.ts` and do not import it into `goal.ts` unless a remaining call site needs it.

- [ ] **Step 3: Verify**

```bash
bun run --cwd bun-apps/pi-agent-ext-core-task typecheck
bun run --cwd bun-apps/pi-agent-ext-core-task test 2>&1 | tail -3
```

Expected: `length-continue.test.ts` and `repetition.test.ts` pass unedited.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/goal/prompting.ts bun-apps/pi-agent-ext-core-task/src/goal/goal.ts
git commit -m "refactor(core-task): extract goal/prompting.ts"
```

### Task C4: Extract `lifecycle.ts`

**Files:**
- Create: `bun-apps/pi-agent-ext-core-task/src/goal/lifecycle.ts`
- Modify: `bun-apps/pi-agent-ext-core-task/src/goal/goal.ts`

- [ ] **Step 1: Create the new module**

Create `src/goal/lifecycle.ts` containing verbatim `goal.ts` lines 940-1152: `startGoal`, `toggleGoalAudit`, `pauseGoal`, `resumeGoal`, `clearGoal`, `editGoal`, `showGoal`, `pauseGoalAfterAgentEnd`, `updateGoalUsage`. Import from `./internals.js`, `./timers.js`, `./prompting.js`, `./state.js`.

- [ ] **Step 2: Delete and import back**

Delete lines 940-1152 from `goal.ts` and add:

```ts
import {
  clearGoal,
  editGoal,
  pauseGoal,
  pauseGoalAfterAgentEnd,
  resumeGoal,
  showGoal,
  startGoal,
  toggleGoalAudit,
  updateGoalUsage,
} from "./lifecycle.js";
```

All nine are called from the command registrations (still in `goal.ts` until Task C6) and from the hooks block (until Task C7), so every name is needed at this point.

- [ ] **Step 3: Verify**

```bash
bun run --cwd bun-apps/pi-agent-ext-core-task typecheck
bun run --cwd bun-apps/pi-agent-ext-core-task test 2>&1 | tail -3
```

Expected: `persistence.test.ts` (331) and `quota-retry.test.ts` (82) pass unedited.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/goal/lifecycle.ts bun-apps/pi-agent-ext-core-task/src/goal/goal.ts
git commit -m "refactor(core-task): extract goal/lifecycle.ts"
```

### Task C5: Extract `goal-complete-tool.ts`

**Files:**
- Create: `bun-apps/pi-agent-ext-core-task/src/goal/goal-complete-tool.ts`
- Modify: `bun-apps/pi-agent-ext-core-task/src/goal/goal.ts`

- [ ] **Step 1: Create the new module**

Create `src/goal/goal-complete-tool.ts` containing verbatim `goal.ts` lines 182-480 — the whole `goalCompleteTool` definition. Import from `./internals.js`, `./lifecycle.js`, `./state.js`, and `./commands.js`.

Export it as a factory if it closes over `pi`; otherwise export the constant directly. Read line 182 to see which shape it already has and preserve it — do not change the tool's construction.

- [ ] **Step 2: Delete and import back**

Delete lines 182-480 from `goal.ts`; add `import { goalCompleteTool } from "./goal-complete-tool.js";` so the `pi.registerTool(goalCompleteTool)` call at what is now a much earlier line still resolves.

- [ ] **Step 3: Verify**

```bash
bun run --cwd bun-apps/pi-agent-ext-core-task typecheck
bun run --cwd bun-apps/pi-agent-ext-core-task test 2>&1 | tail -3
```

Expected: `audit-wiring.test.ts` (396) and `hardening-loop.test.ts` (658) pass unedited. Also confirm the tool's schema is byte-identical:

```bash
bun run --cwd bun-apps/pi-agent cli schema-cost 2>&1 | grep goal_complete
```

Expected: `99` approx-tokens, matching `bun-apps/pi-agent/baselines/schema-cost-baseline.json`. A different number means the tool definition changed during the move.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/goal/goal-complete-tool.ts bun-apps/pi-agent-ext-core-task/src/goal/goal.ts
git commit -m "refactor(core-task): extract goal/goal-complete-tool.ts"
```

### Task C6: Extract `register-commands.ts`

**Files:**
- Create: `bun-apps/pi-agent-ext-core-task/src/goal/register-commands.ts`
- Modify: `bun-apps/pi-agent-ext-core-task/src/goal/goal.ts`

This task covers the 182-line block the spec's 1a table omitted.

- [ ] **Step 1: Create the new module**

Create `src/goal/register-commands.ts` exporting one function that takes the extension API and registers both commands:

```ts
export function registerGoalCommands(pi: ExtensionAPI): void {
  // verbatim goal.ts lines 483-664: pi.registerCommand("goal", {...})
  //                                 and pi.registerCommand("list", {...})
}
```

Import from `./lifecycle.js`, `./internals.js`, `./commands.js` (the existing pure parser module), `./list.js`, and `./state.js`.

Do not merge this into the existing `commands.ts`: that file holds the **pure** parsers (`parseCommand`, `parseTokenBudget`, `validateObjective`, `completeGoalArguments`) and is tested as pure code in `commands.test.ts`. Registration is I/O wiring and belongs in its own module.

- [ ] **Step 2: Delete and call**

Delete lines 483-664 from `goal.ts` and replace them with a single call inside `default function goal()`:

```ts
registerGoalCommands(pi);
```

- [ ] **Step 3: Verify**

```bash
bun run --cwd bun-apps/pi-agent-ext-core-task typecheck
bun run --cwd bun-apps/pi-agent-ext-core-task test 2>&1 | tail -3
```

Expected: `commands.test.ts` (223), `list.test.ts` (94), `list-wiring.test.ts` (335) and `list-advance.test.ts` (241) all pass unedited.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/goal/register-commands.ts bun-apps/pi-agent-ext-core-task/src/goal/goal.ts
git commit -m "refactor(core-task): extract goal/register-commands.ts

The spec's 1a table omitted this 182-line block; without it goal.ts lands at
~350 lines instead of the ~200 the spec targets."
```

### Task C7: Extract `hooks.ts`

**Files:**
- Create: `bun-apps/pi-agent-ext-core-task/src/goal/hooks.ts`
- Modify: `bun-apps/pi-agent-ext-core-task/src/goal/goal.ts`

- [ ] **Step 1: Create the new module**

Create `src/goal/hooks.ts` exporting a single function that takes the extension API and registers all six handlers:

```ts
export function registerGoalHooks(pi: ExtensionAPI): void {
  // verbatim goal.ts lines 665-938: the six pi.on(...) registrations
}
```

The six events are `session_start`, `session_shutdown`, `session_before_compact`, `session_compact`, `input`, `tool_call`, `tool_execution_end`, `before_agent_start`, `agent_end`. Import from `./internals.js`, `./lifecycle.js`, `./timers.js`, `./prompting.js`, `./state.js`.

`agent_end` (lines 780-938) is 160 lines on its own. Keep it inside `hooks.ts` for this task — splitting it further is a separate decision, not part of this plan.

- [ ] **Step 2: Delete and call**

Delete lines 665-938 from `goal.ts` and replace them with a single call inside `default function goal()`:

```ts
registerGoalHooks(pi);
```

- [ ] **Step 3: Verify**

```bash
bun run --cwd bun-apps/pi-agent-ext-core-task typecheck
bun run --cwd bun-apps/pi-agent-ext-core-task test 2>&1 | tail -3
```

Expected: every `goal/__tests__/*.ts` file passes unedited. This is the task most likely to break `goal.test.ts` — the hooks are where the tests exercise ordering.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/goal/hooks.ts bun-apps/pi-agent-ext-core-task/src/goal/goal.ts
git commit -m "refactor(core-task): extract goal/hooks.ts"
```

### Task C8: Record the layout and close out

**Files:**
- Modify: `bun-apps/pi-agent-ext-core-task/CONTEXT.md`

- [ ] **Step 1: Confirm the size target**

```bash
wc -l bun-apps/pi-agent-ext-core-task/src/goal/goal.ts
```

Expected: roughly 200. If it is materially larger, something was left behind — check which of the original blocks 182-480 (tool), 483-664 (commands), 665-938 (hooks), 940-1303 (lifecycle/timers/prompting), 1304-1522 (internals) is still present.

- [ ] **Step 1b: Correct the spec's 1a table**

In `.planning/specs/2026-08-15-core-packages-simplification-design.md`, add the `register-commands.ts` row (goal.ts:483-664, ~182 lines) to the 1a table and note that `prompting.ts` takes only 1246-1303 because the continuation-marker helpers travel with `internals.ts`. The spec's total of 11 new modules becomes **14**: Group A 5 (spec said 3, plus the two cycle-breakers from Task A7), Group B 2 (unchanged), Group C 7 (spec said 6, plus `register-commands.ts`).

- [ ] **Step 2: Document it**

Add to `bun-apps/pi-agent-ext-core-task/CONTEXT.md`:

```markdown
**Goal module layout** — `goal.ts` is a facade: it re-exports the subsystem's
public surface, defines `StatusContext`, and wires `default function goal()`.
The pieces live in `goal-complete-tool.ts` (the tool), `register-commands.ts`
(the `/goal` and `/list` registrations), `hooks.ts` (the six lifecycle handlers),
`lifecycle.ts` (start/pause/resume/clear/edit/show), `timers.ts` (status refresh
+ heartbeat), `prompting.ts` (the send*Prompt family), and `internals.ts` (the
shared helpers). Note `commands.ts` is different from `register-commands.ts`: the
former holds the PURE parsers and is unit-tested as such; the latter is the I/O
wiring. The dependency graph is strictly one-way — `goal.ts → hooks / lifecycle /
timers / prompting / register-commands / goal-complete-tool → internals → state`
— and `internals.ts` exists precisely to
keep it that way: `setAndPersistGoal` alone is called from all three of the
tool, hook, and lifecycle blocks.
```

- [ ] **Step 3: Full verification**

```bash
bun run --cwd bun-apps/pi-agent-ext-core-task typecheck
bun run --cwd bun-apps/pi-agent-ext-core-task test 2>&1 | tail -3
git status --short | grep -c test
```

Expected: gates green, test count matches Task C1's baseline, last command prints `0`.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/CONTEXT.md .planning/specs/2026-08-15-core-packages-simplification-design.md
git commit -m "docs(core-task): record the goal module layout and its one-way graph"
```

---

## Closing out the whole step

- [ ] **Run the regression gates** (the same set the pre-push hook runs):

```bash
bash scripts/ci-local.sh --gates
```

Expected: 15/15 PASS.

- [ ] **Confirm no test file was touched across all three groups:**

```bash
git diff --name-only origin/main... | grep -E '(test|__tests__)' | wc -l
```

Expected: `0`. A non-zero count means a facade was broken somewhere; find it before opening the PR.

- [ ] **Open the PR** via the devops chain (`prepare-cli` → push → `gh pr create`), one PR per group if they are being reviewed separately.
