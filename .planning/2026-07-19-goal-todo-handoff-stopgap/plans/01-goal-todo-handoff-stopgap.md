# Goal/Todo Hand-off Stopgap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the wayfind→superpowers hand-off drive the two WORKING TUI layers (`/goal` + `todo` + `goal_complete`) manually at the skill layer, and record that the plan coordinator (middle phase layer) is designed-but-not-built.

**Architecture:** Five surgical prose edits across wayfind (1) + superpowers (3) skills + 1 verification skill, each citing a new ADR-0003. No code/runtime changes — the `__piPlan*` seams stay graceful no-ops by design; this stopgap compensates at the agent-instruction layer until the coordinator is built (deferred Option B).

**Tech Stack:** Markdown skill prose (`SKILL.md`) + one ADR. Verification = package `bun test` (regression guard: `skills.test` loads real `SKILL.md`) + `grep` (content-presence assertions). No red-green TDD — these are prose edits; `grep` is the prose equivalent of a content assertion (honest adaptation per test-driven-development's "spirit not ritual").

## Global Constraints

- **Language:** conversation zh-TW; all written artifacts (skill prose, ADR, commits) in English.
- **Prose only:** edit `SKILL.md` text + one ADR. Do NOT touch `src/`, tests, or runtime — the coordination seams must stay as-is.
- **Every skill edit cites ADR-0003** (the "designed-not-built / manual-for-now" caveat).
- **Tests must stay green:** `pi-agent-ext-wayfind` `bun test` (143) and `pi-agent-ext-superpowers` `bun test` (95) — both load real `SKILL.md`, so a malformed edit fails fast.
- **Key asymmetry to preserve in prose:** `/goal` is a TUI command with NO agent-side setter (agent can only prompt the user + call `goal_complete`); `todo` and `goal_complete` ARE agent tools.
- **No placeholders:** every edit below has exact `oldText` → `newText`; copy verbatim.

---

### Task 1: ADR-0003 — plan coordinator designed, not built

**Files:**
- Create: `bun-apps/pi-agent-ext-wayfind/docs/adr/0003-plan-coordinator-designed-not-built.md`

**Interfaces:**
- Produces: the ADR-0003 document cited verbatim ("ADR-0003") by Tasks 2–5.

- [ ] **Step 1: Create the ADR file**

Write `bun-apps/pi-agent-ext-wayfind/docs/adr/0003-plan-coordinator-designed-not-built.md` with exactly:

````markdown
# ADR-0003: Plan coordinator — designed, not built (goal/todo driven manually for now)

Date: 2026-07-19
Status: Accepted

## Context

The `goal ↔ plan ↔ todo` three-layer coordination model is described in two `CONTEXT.md` files (goal-todo, wayfind) and the wayfind README as a live runtime: a "plan coordinator" (the phase layer) parses `task_plan.md`, drives/tracks phases, publishes `globalThis.__piPlanPhases` / `__piPlanIncomplete` / `__piPlanSummary`, yields to an active `/goal` or grill, and feeds `/wayfind sync` + `goal_complete`'s phase-gate.

grep-verified reality: the coordinator was **designed but never built**.

- No package publishes the `__piPlan*` seams — zero publishers across ts+js, including `pi-agent-cli` and `pi-agent-ext-power-tool`; wayfind (`chain.ts`, `coordination.ts`) and goal-todo (`goal.ts`) only read them.
- `isExternalDriverActive`, the "injection yielded" status string, and plan-injection / auto-continue logic do not exist in code (comments only).
- `goal_complete`'s phase-gate `planningGateBlocking()` reads `__piPlanIncomplete` → `typeof fn !== "function"` → always `undefined` → never blocks.
- The composite status widget (`status-widget.ts`) reserves slot order=3 for "the plan coordinator" — no package registers a section there.

All cross-layer coordination is therefore **graceful no-ops**: the system never fails, it silently does nothing. This hid the gap — the 2026-07-19 "improve wayfind extension" effort ran the full chart→ship flow without ever setting a `/goal` or `todo`; `goal_complete` returned "no active goal".

## Decision

Drive the two WORKING TUI layers (`/goal` + `todo`) **manually at the skill layer** until the coordinator is built. The hand-off skills now instruct the agent to: (1) prompt the user to `/goal <objective>` at hand-off; (2) seed `todo` entries from the plan; (3) drive them through execution; (4) call `goal_complete` at verified completion.

Key asymmetry: `/goal` is a TUI command with no agent-side setter (the agent can only prompt the user + call `goal_complete`); `todo` and `goal_complete` are agent tools.

## Consequences

- `/wayfind sync` and `goal_complete`'s phase-gate remain no-ops until the coordinator exists (graceful — no breakage).
- Manual skill-layer driving is enough to light up the goal+todo widgets and make `goal_complete` closeable.
- Building the coordinator (Option B) is a separate effort: parse `task_plan.md`, drive phases, publish the three `__piPlan*` seams, register widget slot order=3, wire `/wayfind sync` + the `goal_complete` gate. Tracked as a decision ticket on the wayfind map.
- Future option: promote the manual protocol to a canonical `driving-goal-and-todos` skill if it proliferates.
````

- [ ] **Step 2: Verify the ADR is self-consistent**

Run: `test -f bun-apps/pi-agent-ext-wayfind/docs/adr/0003-plan-coordinator-designed-not-built.md && grep -c "designed but never built" bun-apps/pi-agent-ext-wayfind/docs/adr/0003-plan-coordinator-designed-not-built.md`
Expected: prints `1`.

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-wayfind/docs/adr/0003-plan-coordinator-designed-not-built.md
git commit -m "docs(wayfind): ADR-0003 plan coordinator designed-not-built"
```

---

### Task 2: to-tickets — prompt `/goal` at the hand-off

**Files:**
- Modify: `bun-apps/pi-agent-ext-wayfind/skills/to-tickets/SKILL.md` (end of "### Seed the plan" section)

**Interfaces:**
- Consumes: ADR-0003 (Task 1).
- Produces: the `/goal` prompt step (protocol step 1) at the wayfind hand-off terminal — the one point every wayfind-driven execution flow passes through.

- [ ] **Step 1: Make the edit**

`oldText` (the last sentence of the "### Seed the plan" section):

```
This is the bridge from wayfind's decision artifacts into the plan coordinator's execution substrate. Then execute the plan to activate the hooks; when a phase completes, `/wayfind sync` (or any `/wayfind*` touchpoint) closes the originating ticket.
```

`newText`:

```
This is the bridge from wayfind's decision artifacts into the plan coordinator's execution substrate. Then execute the plan to activate the hooks; when a phase completes, `/wayfind sync` (or any `/wayfind*` touchpoint) closes the originating ticket.

### Set the session objective

The destination is now settled — hand it to the user as a trackable objective. **Prompt the user to run** `/goal <one-line destination>` (e.g. `/goal unify planning-artifact homes under .planning/<effort>/`). You cannot set `/goal` yourself — it is a TUI command with no agent-side tool; your job is to hand over the exact command, then seed `todo`s and call `goal_complete` during execution (ADR-0003).
```

- [ ] **Step 2: Verify — grep + wayfind tests**

Run: `grep -c "Prompt the user to run" bun-apps/pi-agent-ext-wayfind/skills/to-tickets/SKILL.md`
Expected: `1`.
Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test ) 2>&1 | tail -3`
Expected: `143 pass` / `0 fail` (unchanged — prose load still valid).

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-wayfind/skills/to-tickets/SKILL.md
git commit -m "feat(wayfind): to-tickets prompts /goal at hand-off (ADR-0003)"
```

---

### Task 3: writing-plans — seed `todo`s at plan finalization

**Files:**
- Modify: `bun-apps/pi-agent-ext-superpowers/skills/writing-plans/SKILL.md` ("## Execution Handoff" section)

**Interfaces:**
- Consumes: ADR-0003 (Task 1).
- Produces: protocol step 2 (seed todos) at the moment the plan is finalized and handed to execution.

- [ ] **Step 1: Make the edit**

`oldText`:

```
## Execution Handoff

After saving the plan, offer execution choice:
```

`newText`:

```
## Execution Handoff

After saving the plan, seed the session's `todo` list from this plan's tasks — one `todo` per Task N, in dependency order — so progress is trackable in the TUI; the executing skill (executing-plans or subagent-driven-development) then drives each `in_progress → completed`. If the user has not already set a session objective, prompt them to `/goal <one-line goal>` first. Until the plan coordinator is built these are driven manually at the skill layer (ADR-0003). Then offer the execution choice:
```

- [ ] **Step 2: Verify — grep + superpowers tests**

Run: `grep -c "seed the session's \`todo\` list" bun-apps/pi-agent-ext-superpowers/skills/writing-plans/SKILL.md`
Expected: `1`.
Run: `( cd bun-apps/pi-agent-ext-superpowers && bun test ) 2>&1 | tail -3`
Expected: `95 pass` / `0 fail`.

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-superpowers/skills/writing-plans/SKILL.md
git commit -m "feat(superpowers): writing-plans seeds todos at finalization (ADR-0003)"
```

---

### Task 4: executing-plans + subagent-driven-development — explicit `todo` tool + `/goal`

**Files:**
- Modify: `bun-apps/pi-agent-ext-superpowers/skills/executing-plans/SKILL.md` (Step 1, point 4)
- Modify: `bun-apps/pi-agent-ext-superpowers/skills/subagent-driven-development/SKILL.md` (after "## Pre-Flight Plan Review")

**Interfaces:**
- Consumes: ADR-0003 (Task 1). Both skills already drive generic "todos"; this makes the `todo` tool explicit + wires `/goal` setup and `goal_complete` close (protocol steps 1 + 4 context for the execution layer).

- [ ] **Step 1: Edit executing-plans**

`oldText` (Step 1 point 4):

```
4. If no concerns: Create todos for the plan items and proceed
```

`newText`:

```
4. If no concerns: Create `todo` entries (via the `todo` tool) for the plan items and proceed. If no `/goal` is active, prompt the user to set one — execution drives that objective to completion and closes it with `goal_complete` when verified (ADR-0003)
```

- [ ] **Step 2: Edit subagent-driven-development**

`oldText` (last lines of "## Pre-Flight Plan Review"):

```
conflicts that only emerge from implementation.
```

`newText`:

```
conflicts that only emerge from implementation.

### Session objective + todos

Seed one `todo` per plan task at the start (via the `todo` tool) and mark each `in_progress → completed` as its review comes back clean — this is what lights up the TUI's step tracker. If no `/goal` is active, prompt the user to set one for the effort; once the whole branch is verified, close it with `goal_complete` (ADR-0003 — the plan coordinator that would automate this is not yet built).
```

- [ ] **Step 3: Verify — grep + superpowers tests**

Run: `grep -c "via the \`todo\` tool" bun-apps/pi-agent-ext-superpowers/skills/executing-plans/SKILL.md && grep -c "Session objective + todos" bun-apps/pi-agent-ext-superpowers/skills/subagent-driven-development/SKILL.md`
Expected: `1` then `1`.
Run: `( cd bun-apps/pi-agent-ext-superpowers && bun test ) 2>&1 | tail -3`
Expected: `95 pass` / `0 fail`.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-superpowers/skills/executing-plans/SKILL.md bun-apps/pi-agent-ext-superpowers/skills/subagent-driven-development/SKILL.md
git commit -m "feat(superpowers): executing-plans + sdd explicit todo tool + /goal (ADR-0003)"
```

---

### Task 5: verification-before-completion — close with `goal_complete`

**Files:**
- Modify: `bun-apps/pi-agent-ext-superpowers/skills/verification-before-completion/SKILL.md` (before "## The Bottom Line")

**Interfaces:**
- Consumes: ADR-0003 (Task 1).
- Produces: protocol step 4 — the `goal_complete` close, gated on fresh verification evidence (this skill's Iron Law).

- [ ] **Step 1: Make the edit**

`oldText`:

```
## The Bottom Line

**No shortcuts for verification.**
```

`newText`:

```
## Closing the session goal

Once your completion claim is backed by fresh evidence (per the Iron Law above) AND all session `todo`s read completed, close the objective with `goal_complete` — but only if a `/goal` is active. If `goal_complete` returns "no active goal", one was never set (the hand-off should have prompted `/goal`; see ADR-0003). Do not call `goal_complete` for partial work or unverified claims.

## The Bottom Line

**No shortcuts for verification.**
```

- [ ] **Step 2: Verify — grep + superpowers tests**

Run: `grep -c "Closing the session goal" bun-apps/pi-agent-ext-superpowers/skills/verification-before-completion/SKILL.md`
Expected: `1`.
Run: `( cd bun-apps/pi-agent-ext-superpowers && bun test ) 2>&1 | tail -3`
Expected: `95 pass` / `0 fail`.

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-superpowers/skills/verification-before-completion/SKILL.md
git commit -m "feat(superpowers): verification-before-completion closes with goal_complete (ADR-0003)"
```

---

## End-to-end verification (after all tasks)

- [ ] `grep -rn "ADR-0003" bun-apps/pi-agent-ext-wayfind/skills bun-apps/pi-agent-ext-superpowers/skills` → 5 skill files cite it.
- [ ] `( cd bun-apps/pi-agent-ext-wayfind && bun test ) 2>&1 | tail -1` → 143 pass / 0 fail.
- [ ] `( cd bun-apps/pi-agent-ext-superpowers && bun test ) 2>&1 | tail -1` → 95 pass / 0 fail.
- [ ] No `src/` or test files changed: `git diff --stat origin/main | grep -v "SKILL.md\|adr/0003\|spec.md\|plans/"` → empty.
