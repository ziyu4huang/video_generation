# Solution-Extension Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the wayfind ↔ superpowers methodology duplication into a single superpowers vocabulary, slim wayfind to a pure decide/wayfinder engine, and relocate the misplaced `architecture-render` docs tooling into `pi-agent-ext-archify`.

**Architecture:** Five phases: (1) merge methodology content from 6 wayfind skills into their superpowers counterparts; (2) delete the 6 wayfind skills, add one-release redirect stubs in `ask-matt`, trim `to-spec`/`to-tickets` to artifact contracts + chain wiring; (3) split wayfind `src/commands.ts` and `src/effort-tool.ts` into focused modules behind stable entry points; (4) move `architecture-render.ts` + mermaid/tailwind vendoring + tests + goldens into archify; (5) run all package gates, the schema-cost canary, the ADR gate, and update ADRs.

**Tech Stack:** Bun workspaces (TypeScript, Biome, tsc), pi extension packages (`@earendil-works/pi-coding-agent`), Markdown skill files with YAML frontmatter, mermaid ^11 + Tailwind ^4 vendoring (moves to archify).

**Source spec:** `docs/superpowers/specs/2026-08-16-solution-extension-simplification-design.md` (Approved-in-principle). All ADR citations use full IDs (`ADR-wayfind-NNNN`, `ADR-superpowers-NNNN`) — bare numbers are banned repo-wide.

## Global Constraints

- wayfind quality gate: `( cd bun-apps/pi-agent-ext-wayfind && bun run check && bun run typecheck && bun test )` — `check` is Biome; tsc lives in `typecheck`; `test` = `check` + `bun test`.
- superpowers quality gate: `( cd bun-apps/pi-agent-ext-superpowers && bun test )`.
- archify quality gate: `( cd bun-apps/pi-agent-ext-archify && bun test )` (its canonical `test` script).
- ADR gate: `( cd bun-apps && bun run test:adr )` — every `ADR-<context>-NNNN` citation must resolve; update `bun-apps/docs/adr/INDEX.md` when adding an ADR.
- Keep wayfind invariants (spec §4.4): `src/model.ts` stays fs-free; globalThis seams stay (`__piPlan*`, `__piCoreTaskStatusWidget`, `__piHermesStaleCheck`, `webui:render`, `GATE_DEFS` per ADR-wayfind-0004); static registration in `extensions/wayfind.ts` untouched; `.planning/` state model unchanged.
- One registration entry per extension package: never add a second entry; lib face stays `src/index.ts` (wayfind) — archify has no `src/`, its lib lives in `lib/`.
- Sole allowed cross-package import in wayfind `src/`: `@repo/pi-agent-core-interface`. Do not add new cross-package imports.
- All written output (skills, code comments, commits, ADRs) in English.
- Commit steps below are executed by the devops-wrapped flow (see `bun-apps/pi-agent-ext-devops/skills/devops-workflow/SKILL.md`); if executing inline, make the same small, per-task commits.
- `DEFAULT_SKILL_EXCLUDE` in `bun-apps/pi-agent-ext-superpowers/src/superpowers.ts:46` stays `["verification-before-completion", "using-superpowers"]` — unchanged by this effort (spec §3.2).

---

### Task 1: Merge dispatch guardrails + research pattern into `dispatching-parallel-agents`

**Files:**
- Modify: `bun-apps/pi-agent-ext-superpowers/skills/dispatching-parallel-agents/SKILL.md`
- Test: `( cd bun-apps/pi-agent-ext-superpowers && bun test )` (existing suite must stay green)

**Interfaces:**
- Consumes: content of `bun-apps/pi-agent-ext-wayfind/skills/subagent-dispatch-discipline/SKILL.md` (52 lines) and `bun-apps/pi-agent-ext-wayfind/skills/research/SKILL.md` (23 lines) — read both before editing; they are deleted in Task 6.
- Produces: a superpowers skill whose description triggers on "about to dispatch a subagent" (guardrails) and "research against primary sources" (findings-artifact pattern); Phase 2's redirect table (Task 6) points `subagent-dispatch-discipline` and `research` here by name.

- [x] **Step 1: Extend the frontmatter description**

Replace the `description:` line in `dispatching-parallel-agents/SKILL.md` with:

```yaml
description: Use when facing 2+ independent tasks that can be worked on without shared state or sequential dependencies, OR when about to dispatch any subagent (run the pre-dispatch guardrails first), OR when a question needs primary-source research captured as a cited Markdown findings file.
```

- [x] **Step 2: Append the "Pre-dispatch guardrails" section**

Append to the end of the skill (condensed from wayfind `subagent-dispatch-discipline`, preserving its numbers and knob paths verbatim):

```markdown
## Pre-dispatch guardrails (run before EVERY dispatch)

Subagent dispatch is the largest source of token waste in this stack. Run-history
analysis (2026-08-09, ~30 subagent runs): **budget exhaustion is the dominant
failure** — 15 of ~30 runs; per-run usage 130k–3.4M tokens. A "write 2 memory
entries" task cost **927k tokens** because the subagent lacked the `memory` tool
and reverse-engineered a workaround instead of failing fast.

1. **Budget — always set it.** Pass `tokenBudget` + `spendBudget`, calibrated:
   read-only research/inventory → 30k–60k; single SDD implementer slice →
   80k–150k; big synthesis/multi-file → 150k–300k. Raise above these only with a
   stated reason — the uncapped default is the bug, not the baseline.
2. **Scope — always set `commitScope`.** Exact paths the subagent may touch;
   `[]` for read-only. State the same exact paths in the task prose. Never ask a
   subagent to `git add` selectively on its own.
3. **Tool-fit — never delegate an impossible task.** Confirm every tool the task
   needs is in the subagent's allowlist; otherwise do it in the orchestrator,
   add the tool, or reshape the task.
4. **Bound the task.** If it would plausibly exceed the tier budget, split into
   staged dispatches. One subagent = one bounded outcome.
5. **Pick the right tool.** read-only parallel fan-out → `subagents` (plural);
   one focused task with side effects → `subagent` (singular); a trivial single
   write/call → do it in the orchestrator.
6. **Tag the tier.** small (search/inventory) · medium (balanced) · big
   (synthesis/judgment).

### Anti-patterns

- Dispatching with no `tokenBudget`.
- `git add -A` / `git add .` inside a subagent.
- Delegating a task that needs a tool the child lacks.
- Re-verifying from a detached HEAD, or redundant confirmation loops.
- One giant task where bounded dispatches would do.

### Knob locations

- `tokenBudget` / `spendBudget` params — `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts`
- `commitScope` guard — `bun-apps/pi-agent-ext-subagent/src/git-scope.ts`
- `DEFAULT_TIMEOUT_MS` (15 min) — `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts`
```

- [x] **Step 3: Append the "Research as a background subagent" section**

Append (condensed from wayfind `research`):

```markdown
## Research as a background subagent (markdown-findings artifact)

When a question needs investigating against high-trust primary sources, dispatch
a **background subagent** (apply the guardrails above) and keep working while it
reads. Give it the question, the output path, and the citation rule:

1. Investigate against **primary sources** — official docs, source code, specs,
   first-party APIs, the code under your feet. A blog paraphrasing the docs is a
   lead, not a citation; the docs are the citation.
2. Write the findings to a **single Markdown file, citing each claim's source** —
   a link, a `file:line`, a commit, an API response. An uncited claim is a hunch;
   either find its source or mark it explicitly as the agent's inference.
3. Save it where the repo already keeps such notes; if there is none, put it
   under `.planning/<effort>/` (a `findings.md` or a `research/` note next to the
   decision it informs) and say where.

Research gathers *facts*; if the question is a *decision*, take what it found
into the decision process and resolve it there — don't let the research subagent
decide.
```

- [x] **Step 4: Run the superpowers gate**

Run: `( cd bun-apps/pi-agent-ext-superpowers && bun test )`
Expected: PASS (all existing tests; skills are Markdown — the suite guards packaging/registration, not prose).

- [x] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-superpowers/skills/dispatching-parallel-agents/SKILL.md
git commit -m "feat(superpowers): merge dispatch guardrails + research pattern from wayfind"
```

---

### Task 2: Merge reproduction-loop engineering into `systematic-debugging`

**Files:**
- Create: `bun-apps/pi-agent-ext-superpowers/skills/systematic-debugging/scripts/hitl-loop.template.sh` (copied verbatim from `bun-apps/pi-agent-ext-wayfind/skills/diagnosing-bugs/scripts/hitl-loop.template.sh`)
- Modify: `bun-apps/pi-agent-ext-superpowers/skills/systematic-debugging/SKILL.md`
- Test: `( cd bun-apps/pi-agent-ext-superpowers && bun test )`

**Interfaces:**
- Consumes: `bun-apps/pi-agent-ext-wayfind/skills/diagnosing-bugs/SKILL.md` (142 lines; six phases: build feedback loop → reproduce+minimise → hypothesise → instrument → fix+regression test → cleanup+post-mortem) — deleted in Task 6.
- Produces: superpowers `systematic-debugging` owning loop-engineering depth; Task 6's redirect table points `diagnosing-bugs` here; Task 7's ask-matt rewrite drops the separate `diagnosing-bugs` pointer.

- [x] **Step 1: Copy the HITL template**

```bash
mkdir -p bun-apps/pi-agent-ext-superpowers/skills/systematic-debugging/scripts
cp bun-apps/pi-agent-ext-wayfind/skills/diagnosing-bugs/scripts/hitl-loop.template.sh \
   bun-apps/pi-agent-ext-superpowers/skills/systematic-debugging/scripts/hitl-loop.template.sh
```

- [x] **Step 2: Append the "Engineering the reproduction loop" section**

Append to `systematic-debugging/SKILL.md` (condensed from wayfind `diagnosing-bugs`; keep the numbered list and the completion checklist verbatim in substance):

```markdown
## Engineering the reproduction loop

When the hard part is **building the loop itself** — a flaky bug, a
non-deterministic timing failure, a multi-component chain, or a bug that needs a
human to click — spend disproportionate effort on the loop. Be aggressive, be
creative, refuse to give up. **Redact every secret first** (`<REDACTED>`); build
loops against env vars so credentials stay in the environment.

### Ten ways to construct a signal (roughly in order)

1. **Failing test** at whatever seam reaches the bug — unit, integration, e2e.
2. **Curl / HTTP script** against a running dev server.
3. **CLI invocation** with a fixture input, diffing stdout against a known-good snapshot.
4. **Headless browser script** (Playwright/Puppeteer) — asserts on DOM/console/network.
5. **Replay a captured trace.** Save a real request/payload/event log; replay it in isolation.
6. **Throwaway harness.** Minimal subset of the system exercising the bug path with one call.
7. **Property / fuzz loop.** 1000 random inputs, watch for the failure mode.
8. **Bisection harness.** Automate "boot at state X, check, repeat" for `git bisect run`.
9. **Differential loop.** Same input through old vs new version; diff outputs.
10. **HITL bash script.** Last resort — drive the human with
    `scripts/hitl-loop.template.sh` so the loop stays structured.

### Tighten the loop

Treat the loop as a product: faster (cache setup, narrow scope), sharper (assert
the specific symptom, not "didn't crash"), more deterministic (pin time, seed
RNG, isolate fs, freeze network). For non-deterministic bugs the goal is a
**higher reproduction rate** — loop the trigger 100×, parallelise, stress,
narrow timing windows. If you genuinely cannot build a loop, stop and say so;
list what you tried; ask for an environment, a redacted artifact, or permission
for temporary instrumentation. No red-capable command, no hypothesising.

### Loop completion criterion

The loop is done when it is **tight and red-capable**: one named command you
have already run at least once that is — red-capable (drives the actual bug path
and asserts the user's exact symptom), deterministic (or a pinned high repro
rate), fast (seconds), and agent-runnable (a human only via the HITL template).

Then: reproduce → **minimise** (cut inputs/callers/config one at a time,
re-running after each cut; done when every remaining element is load-bearing) →
hypothesise 3–5 **ranked, falsifiable** hypotheses (show the user the ranking
before testing; don't block if AFK) → instrument one variable at a time (tag
debug logs `[DEBUG-xxxx]`; perf bugs: measure a baseline first, bisect, never
log-and-grep) → fix with a regression test written **before** the fix, but only
at a **correct seam** — if no correct seam exists, that absence is itself the
finding (hand off to architecture improvement) → cleanup (re-run the loop, grep
the debug prefix, delete throwaway prototypes, state the winning hypothesis in
the commit message).
```

- [x] **Step 3: Extend the frontmatter description**

Add loop-engineering trigger words to `systematic-debugging`'s `description:` (keep its existing text, append): `… Also when the wall is building the reproduction loop itself — flaky, non-deterministic, multi-component, or human-in-the-loop bugs.`

- [x] **Step 4: Run the superpowers gate**

Run: `( cd bun-apps/pi-agent-ext-superpowers && bun test )`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-superpowers/skills/systematic-debugging/
git commit -m "feat(superpowers): fold reproduction-loop engineering into systematic-debugging"
```

---

### Task 3: Merge Standards-vs-Spec dual axis into `requesting-code-review` + `receiving-code-review`

**Files:**
- Modify: `bun-apps/pi-agent-ext-superpowers/skills/requesting-code-review/SKILL.md`
- Modify: `bun-apps/pi-agent-ext-superpowers/skills/receiving-code-review/SKILL.md`
- Test: `( cd bun-apps/pi-agent-ext-superpowers && bun test )`

**Interfaces:**
- Consumes: `bun-apps/pi-agent-ext-wayfind/skills/code-review/SKILL.md` (127 lines) — deleted in Task 6.
- Produces: both superpowers review skills carry the two-axis vocabulary; Task 6's redirect table points `code-review` here; Task 7's ask-matt main-flow step cites `requesting-code-review`/`receiving-code-review` instead of `code-review`.

- [x] **Step 1: Append the dual-axis section to `requesting-code-review`**

Append:

```markdown
## The two review axes: Standards vs Spec

Review along two **deliberately-separate axes**, never merged or re-ranked:

- **Standards** — does the code follow this repo's *documented* conventions?
  (Are we building the thing right?) Sources: `CLAUDE.md`, global
  `~/.pi/agent/AGENTS.md`, the nearest per-package `CONTEXT.md`, `docs/adr/`.
  Repo docs override any generic smell baseline; skip what Biome/tsc already
  enforce.
- **Spec** — does the code faithfully implement the originating issue/ticket/
  spec? (Are we building the *right* thing?) Report four failure shapes, each
  quoting the spec line: **Missing**, **Partial**, **Scope creep**,
  **Implemented wrongly**. "No spec available" is a valid Spec-axis outcome.

A change can sail through one axis and fail the other — clean code implementing
the wrong requirement, or correct behavior breaking every convention. Emit two
blocks (`## Standards` / `## Spec`), each finding citing its source (repo doc +
rule, named smell + quoted hunk, or quoted spec line). An uncited finding is a
hunch — leave it out. End with one line per axis: total count + the single worst
issue *within that axis*. Never crown a cross-axis winner.
```

- [x] **Step 2: Add the receiving-side mirror to `receiving-code-review`**

Append to `receiving-code-review/SKILL.md`:

```markdown
## Receiving two-axis feedback

Reviews you receive may report **Standards** and **Spec** as separate blocks —
keep them separate when triaging. A Standards finding is fixed by conforming to
the cited repo doc; a Spec finding is fixed by reconciling with the quoted spec
line (fix the code, or fix the spec — never silently split the difference). Do
not let a clean Standards block mask a Spec failure (or vice versa): address
both lists before declaring the review handled.
```

- [x] **Step 3: Run the superpowers gate**

Run: `( cd bun-apps/pi-agent-ext-superpowers && bun test )`
Expected: PASS.

- [x] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-superpowers/skills/requesting-code-review/SKILL.md bun-apps/pi-agent-ext-superpowers/skills/receiving-code-review/SKILL.md
git commit -m "feat(superpowers): fold Standards-vs-Spec dual axis into review skills"
```

---

### Task 4: Add the prototype pointer to `brainstorming`

**Files:**
- Modify: `bun-apps/pi-agent-ext-superpowers/skills/brainstorming/SKILL.md`
- Test: `( cd bun-apps/pi-agent-ext-superpowers && bun test )`

**Interfaces:**
- Consumes: the prototype *concept* from `bun-apps/pi-agent-ext-wayfind/skills/prototype/SKILL.md` (26 lines + `LOGIC.md` + `UI.md` — all deleted in Task 6; pointer only, per spec disposition #18).
- Produces: brainstorming routes design questions that need runnable answers to a prototype detour; Task 7's ask-matt main-flow branch 2 points here.

- [ ] **Step 1: Append the prototype section**

Append to `brainstorming/SKILL.md`:

```markdown
## When a question needs a prototype

Some design questions can't be settled in conversation — a state model that has
to be *felt*, a UI that has to be *seen*. When brainstorming surfaces such a
question, spin it off as a **prototype**: throwaway code that answers exactly
one question.

- Name it so a casual reader sees it's a prototype; locate it next to the code
  it informs; obey the project's existing routing conventions.
- Trivial to run (one command / one double-click); no persistence by default;
  no tests, no polish — the point is to learn something fast.
- Surface the full relevant state after every action or variant switch.
- When done: fold the validated decision into the real code, capture the
  throwaway code on a branch out of main, and leave a pointer on the
  originating ticket/decision under `.planning/<effort>/`. The main branch
  keeps only the validated decision.

A logic demo (single shareable HTML file driving the state machine through hard
cases) and switchable UI variants on one route are the two canonical shapes —
pick by which question is being answered.
```

- [ ] **Step 2: Run the superpowers gate**

Run: `( cd bun-apps/pi-agent-ext-superpowers && bun test )`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-superpowers/skills/brainstorming/SKILL.md
git commit -m "feat(superpowers): add prototype pointer to brainstorming"
```

---

### Task 5: Generalize `writing-skills` to all agent-consumed docs

**Files:**
- Create: `bun-apps/pi-agent-ext-superpowers/skills/writing-skills/SKILL-MECHANICS.md` (adapted copy of `bun-apps/pi-agent-ext-wayfind/skills/writing-for-agents/SKILL-MECHANICS.md`)
- Modify: `bun-apps/pi-agent-ext-superpowers/skills/writing-skills/SKILL.md`
- Test: `( cd bun-apps/pi-agent-ext-superpowers && bun test )`

**Interfaces:**
- Consumes: `bun-apps/pi-agent-ext-wayfind/skills/writing-for-agents/SKILL.md` (83 lines) + its `SKILL-MECHANICS.md` — both deleted in Task 6.
- Produces: superpowers `writing-skills` as the craft reference for any agent-consumed doc; Task 6's redirect table points `writing-for-agents` here.

- [ ] **Step 1: Copy and adapt SKILL-MECHANICS.md**

```bash
cp bun-apps/pi-agent-ext-wayfind/skills/writing-for-agents/SKILL-MECHANICS.md \
   bun-apps/pi-agent-ext-superpowers/skills/writing-skills/SKILL-MECHANICS.md
```

Then edit the copy: replace any wayfind-specific relative links so they resolve inside `writing-skills/` (the file is self-contained frontmatter/invocation/router guidance; verify with `( cd bun-apps/pi-agent-ext-superpowers && grep -n "writing-for-agents\|\.\./" skills/writing-skills/SKILL-MECHANICS.md )` — Expected: no hits referencing the old package).

- [ ] **Step 2: Append the generalization section to `writing-skills/SKILL.md`**

Append (condensed from wayfind `writing-for-agents`):

```markdown
## Beyond skills: any document an agent consumes

The same craft applies to `AGENTS.md`, `CONTEXT.md`, and any doc reached by a
pointer — the packaging differs, the writing does not. The levers:

- **Context pointers** — a reference in the agent's context naming out-of-context
  material plus the condition for reaching it. Front-load the leading word; one
  trigger per branch (synonyms renaming one branch are that branch written
  twice); cut identity the body already carries. A must-have target behind a
  weakly worded pointer is a variance bug.
- **Two loads** — context load (always-loaded material spends tokens/attention
  every turn) vs cognitive load (which docs exist and when to reach for each —
  the human is the index; spend it where human judgement matters). Pointer-only
  material escapes context load at the price of the pointer's line.
- **Information hierarchy** — in-file step → in-file reference → disclosed
  reference (behind a pointer). Progressive disclosure protects the hierarchy:
  inline what every branch needs, push behind a pointer what only some branches
  reach. Co-locate a concept's definition/rules/caveats under one heading.
  Sprawl (a doc simply too long) is cured by the ladder, not by trimming words.
- **Completion criteria** — every step ends on one; clarity (agent can tell done
  from not-done; vague bounds invite premature completion) and demand
  ("every modified model accounted for" forces legwork that "produce a change
  list" does not). The strongest criteria are both checkable and exhaustive.
- **Leading words** — compact pretrained concepts (_tight_, _red_, _fog of war_)
  repeated as tokens, never as sentences; they anchor execution in the body and
  invocation in pointers. Refactor restatements into them. Steer positive, not
  by negation — prohibition drags the forbidden behavior into context.
- **Pruning** — one meaning, one source of truth; the environment (scripts,
  configs, `--help`) is a source of truth too, and restating it is a cache that
  earns its load only when the lookup is expensive. Hunt no-op sentences (does
  it change behavior versus the model's default? delete the whole sentence when
  it fails). Without pruning, documents sediment.

Skill-specific mechanics (frontmatter, invocation choice, router skills):
see [SKILL-MECHANICS.md](SKILL-MECHANICS.md).
```

- [ ] **Step 3: Extend the frontmatter description**

Append to `writing-skills`'s `description:`: `… Also use when creating or editing any document an agent consumes — AGENTS.md, CONTEXT.md, pointed-at docs.`

- [ ] **Step 4: Run the superpowers gate**

Run: `( cd bun-apps/pi-agent-ext-superpowers && bun test )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-superpowers/skills/writing-skills/
git commit -m "feat(superpowers): generalize writing-skills to agent-consumed docs"
```

---

### Task 6: Delete the 6 merged wayfind skills + add ask-matt redirect stubs

**Files:**
- Delete: `bun-apps/pi-agent-ext-wayfind/skills/research/` (SKILL.md)
- Delete: `bun-apps/pi-agent-ext-wayfind/skills/prototype/` (SKILL.md, LOGIC.md, UI.md)
- Delete: `bun-apps/pi-agent-ext-wayfind/skills/subagent-dispatch-discipline/` (SKILL.md)
- Delete: `bun-apps/pi-agent-ext-wayfind/skills/code-review/` (SKILL.md)
- Delete: `bun-apps/pi-agent-ext-wayfind/skills/diagnosing-bugs/` (SKILL.md, scripts/hitl-loop.template.sh — copied in Task 2)
- Delete: `bun-apps/pi-agent-ext-wayfind/skills/writing-for-agents/` (SKILL.md, SKILL-MECHANICS.md — copied in Task 5)
- Modify: `bun-apps/pi-agent-ext-wayfind/skills/ask-matt/SKILL.md` (redirect stubs + drop deleted-skill prose)
- Modify (only if grep hits): any `procedures/*.md`, `src/*.ts`, or tests referencing the deleted names
- Test: `( cd bun-apps/pi-agent-ext-wayfind && bun run check && bun run typecheck && bun test )` — notably `tests/skills.test.ts` and `tests/skill-weight.test.ts` enumerate skills and must pass against the 16-skill set.

**Interfaces:**
- Consumes: merged content landed in Tasks 1–5 (the redirect targets must exist before the stubs point at them).
- Produces: wayfind `skills/` = 16 dirs (13 untouched + `to-spec`/`to-tickets`/`ask-matt` trimmed in Tasks 7–8); `ask-matt` carrying the one-release redirect table consumed by muscle-memory users.

- [ ] **Step 1: Find every reference to the deleted names**

Run: `( cd bun-apps/pi-agent-ext-wayfind && grep -rn -e research -e prototype -e subagent-dispatch-discipline -e code-review -e diagnosing-bugs -e writing-for-agents --include='*.md' --include='*.ts' skills/ src/ tests/ procedures/ 2>/dev/null | grep -v node_modules )`
Expected: hits in `skills/ask-matt/SKILL.md` (research, prototype, code-review, diagnosing-bugs, writing-for-agents prose) and possibly `procedures/` or tests; each hit is either rewritten in Step 3 or verified as a false positive (e.g. the word "research" as a ticket type in `src/effort-tool.ts` `typeFilter` enum and `tests/` — those stay: ticket *types* are data, not skill references).

- [ ] **Step 2: Delete the 6 skill directories**

```bash
git rm -r bun-apps/pi-agent-ext-wayfind/skills/research \
          bun-apps/pi-agent-ext-wayfind/skills/prototype \
          bun-apps/pi-agent-ext-wayfind/skills/subagent-dispatch-discipline \
          bun-apps/pi-agent-ext-wayfind/skills/code-review \
          bun-apps/pi-agent-ext-wayfind/skills/diagnosing-bugs \
          bun-apps/pi-agent-ext-wayfind/skills/writing-for-agents
```

- [ ] **Step 3: Add the redirect table to `ask-matt/SKILL.md`**

Insert a new section right after the "Skill index rebuilt for this port" note:

```markdown
## Redirects (skills merged into superpowers)

These wayfind skills were removed; their methodology now lives in the sibling
**superpowers** extension. One release of grace — the table is deleted at the
next wayfind release marker:

| If you reached for… | Use instead (superpowers) |
|---|---|
| `research` | `dispatching-parallel-agents` (background research subagent + cited findings artifact) |
| `prototype` | `brainstorming` (prototype pointer section) |
| `subagent-dispatch-discipline` | `dispatching-parallel-agents` (pre-dispatch guardrails) |
| `code-review` | `requesting-code-review` + `receiving-code-review` (Standards-vs-Spec dual axis) |
| `diagnosing-bugs` | `systematic-debugging` (reproduction-loop engineering) |
| `writing-for-agents` | `writing-skills` (generalized to all agent-consumed docs) |
```

Then remove/rewrite the now-dangling prose in `ask-matt/SKILL.md`:
- Main flow step 2 (prototype detour): replace the `prototype` skill reference with "a prototype (see the **brainstorming** skill's prototype section in superpowers)".
- Main flow step 3 (`code-review` closing reference): replace with "then closes out by requesting a code review (superpowers **requesting-code-review**/**receiving-code-review** — Standards + Spec dual axis)".
- On-ramps ("Something's broken"): delete the `diagnosing-bugs` sentence; keep the `systematic-debugging` pointer and append "(including its reproduction-loop engineering for flaky/HITL bugs)".
- Standalone list: delete the `research`, `prototype`, and `writing-for-agents` bullets entirely (the redirect table above now covers them).

- [ ] **Step 4: Fix remaining references found in Step 1**

For every non-false-positive hit outside `ask-matt/SKILL.md`: rewrite the reference to the superpowers counterpart per the table in Step 3. If a hit is in a test that asserts the deleted skill's existence, update the test to assert the 16-skill set.

- [ ] **Step 5: Run the wayfind gate**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun run check && bun run typecheck && bun test )`
Expected: PASS with 16 skill dirs. If `tests/skills.test.ts` hardcodes the 22-skill list, this is the failure that tells you — update it in this task.

- [ ] **Step 6: Commit**

```bash
git add -A bun-apps/pi-agent-ext-wayfind/skills/
git commit -m "refactor(wayfind): delete 6 methodology skills merged into superpowers; add ask-matt redirects"
```

---

### Task 7: Trim `to-spec` and `to-tickets` to artifact contracts + chain wiring

**Files:**
- Modify: `bun-apps/pi-agent-ext-wayfind/skills/to-spec/SKILL.md` (61 lines → trimmed)
- Modify: `bun-apps/pi-agent-ext-wayfind/skills/to-tickets/SKILL.md` (90 lines → trimmed)
- Test: `( cd bun-apps/pi-agent-ext-wayfind && bun run check && bun run typecheck && bun test )`

**Interfaces:**
- Consumes: superpowers `brainstorming` + `writing-plans` skills (interview/methodology prose now lives there).
- Produces: two engine skills whose remaining content is exactly the artifact contracts + chain wiring: `CONTEXT.md → spec.md → tickets/ → task_plan.md → /wayfind seed → /wayfind sync`. `src/commands.ts` handlers `handleToSpec`/`handleToTickets` steer agents to these skills — the steers reference "Load the `to-spec` skill" / "Load the `to-tickets` skill" and must keep resolving.

- [ ] **Step 1: Trim `to-spec/SKILL.md`**

Keep (verbatim, they are the contract):
- The frontmatter `name`/`description` (tighten the description to "Turn what's already on the table into `.planning/<effort>/spec.md` — synthesis only, no interview; artifact contract + chain wiring.").
- The spec.md artifact contract: where the file goes, required sections, the rule to use `CONTEXT.md` glossary vocabulary and respect area ADRs.
- The chain wiring: what precedes (`grill-me-with-docs` / wayfinder map collapse) and what follows (`/wayfind tickets` → `/wayfind seed` → executing-plans/subagent-driven-development).

Delete: interview technique, question-asking craft, and any how-to-brainstorm prose — replace with one pointer line: `Interview and idea-development methodology: see the superpowers **brainstorming** and **writing-plans** skills.`
Expected result: ≤ 35 lines.

- [ ] **Step 2: Trim `to-tickets/SKILL.md`**

Keep (verbatim, they are the contract):
- Frontmatter `name`/`description` (tighten similarly: "Break a spec into tracer-bullet tickets under `.planning/<effort>/tickets/` — artifact contract + chain wiring.").
- The UNIFIED ticket format: YAML frontmatter (`type`/`blocking`/`status`) + `## Question` + `## What to build` + `## Acceptance` — the same schema `parseTicketFile` reads (this exact phrasing already appears in `src/commands.ts` `handleToTickets`; the skill and the steer must keep naming the same fields).
- One file per ticket (`NN-slug.md`), vertical slices, blocking edges declared, worked blockers-first.
- Chain wiring: input `spec.md`/map decisions; output consumed by `/wayfind seed` → `task_plan.md` → executing-plans per ticket.

Delete: decomposition methodology prose — replace with one pointer line: `Slicing and planning methodology: see the superpowers **writing-plans** and **subagent-driven-development** skills.`
Expected result: ≤ 45 lines.

- [ ] **Step 3: Run the wayfind gate**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun run check && bun run typecheck && bun test )`
Expected: PASS (`tests/plan-seed-contract.test.ts` and `tests/skills.test.ts` must stay green — they guard the chain contracts being kept).

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-wayfind/skills/to-spec/SKILL.md bun-apps/pi-agent-ext-wayfind/skills/to-tickets/SKILL.md
git commit -m "refactor(wayfind): trim to-spec/to-tickets to artifact contracts + chain wiring"
```

---

### Task 8: Slim `ask-matt` to wayfind-family routing

**Files:**
- Modify: `bun-apps/pi-agent-ext-wayfind/skills/ask-matt/SKILL.md` (88 lines post-Task-6 → slim)
- Test: `( cd bun-apps/pi-agent-ext-wayfind && bun run check && bun run typecheck && bun test )`

**Interfaces:**
- Consumes: Task 6's redirect table (stays in place).
- Produces: `ask-matt` routing the wayfind family only; methodology questions redirect to superpowers `using-superpowers`.

- [ ] **Step 1: Rewrite the router scope**

Edit `ask-matt/SKILL.md`:
- Frontmatter `description` becomes: `Use when you don't remember which wayfind skill or flow fits your situation — a router over the wayfind family (grilling, wayfinder, to-spec, to-tickets, handoff, triage, codebase health). Methodology questions route to the superpowers using-superpowers skill.` (keep `disable-model-invocation: true`).
- Near the top, add one line: `> **Methodology (brainstorm → plan → TDD → debug → review)?** That vocabulary lives in superpowers — use the **using-superpowers** skill. This router covers the wayfind family only.`
- Keep: the main flow's wayfind legs (grill-me-with-docs, to-spec, to-tickets, handoff, wayfinder on-ramp), Codebase health, Vocabulary underneath, Phase boundaries (+ `PHASE-BOUNDARIES.md` link), Standalone wayfind skills, and the Task 6 redirect table.
- Delete: any remaining prose that explains superpowers methodology steps in depth (e.g. long elaborations of what executing-plans/TDD do internally) — compress each to its routing sentence.

- [ ] **Step 2: Run the wayfind gate**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun run check && bun run typecheck && bun test )`
Expected: PASS. `( cd bun-apps/pi-agent-ext-wayfind && grep -c 'using-superpowers' skills/ask-matt/SKILL.md )` — Expected: ≥ 2 (router line + redirects context).

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-wayfind/skills/ask-matt/SKILL.md
git commit -m "refactor(wayfind): slim ask-matt to wayfind-family routing"
```

---

### Task 9: Split `src/commands.ts` into per-command handler modules behind a thin dispatcher

**Files:**
- Create: `bun-apps/pi-agent-ext-wayfind/src/commands/keywords.ts`
- Create: `bun-apps/pi-agent-ext-wayfind/src/commands/help.ts`
- Create: `bun-apps/pi-agent-ext-wayfind/src/commands/shared.ts`
- Create: `bun-apps/pi-agent-ext-wayfind/src/commands/grill-handlers.ts`
- Create: `bun-apps/pi-agent-ext-wayfind/src/commands/wayfind-handlers.ts`
- Modify: `bun-apps/pi-agent-ext-wayfind/src/commands.ts` (625 lines → thin dispatcher + re-exports)
- Test: `bun-apps/pi-agent-ext-wayfind/tests/commands.test.ts` (existing; must pass unmodified except import paths if it imports internals)

**Interfaces:**
- Consumes: the current exports of `src/commands.ts` — `resolveWayfindEffortId(trimmed: string, getActive: () => string | undefined): string | undefined`, `renderWayfindHelp(cwd: string, activeEffort: string | undefined): string`, `registerCommands(pi: ExtensionAPI, state: RuntimeState, overlay: WayfindOverlay): void`, `endGrillForSession(state: RuntimeState, sessionId: string): void` — plus internal helpers `startGrill`, `resolveEffortOrWarn`, handlers `handleGrillMe/GrillDocs/GrillDone/GrillDomain`, `handleChainSync`, `handleWayfindDone/Seed/Statusbar/Help/Validate`, `handleToSpec`, `handleToTickets`, `handleWayfinderStatus`, `handleWayfinderChart`, and constants `WAYFIND_KEYWORDS`, `NO_BANNER_KEYWORDS`, `PLACEHOLDER_DESTINATIONS`.
- Produces: **identical** public surface on `src/commands.ts` (same four exports, same signatures) so `src/index.ts` and `tests/commands.test.ts` keep working; module map:
  - `commands/keywords.ts` → `export const WAYFIND_KEYWORDS: Set<string>`, `NO_BANNER_KEYWORDS: Set<string>`, `PLACEHOLDER_DESTINATIONS: Set<string>`
  - `commands/help.ts` → `export function renderWayfindHelp(...)`, `export function resolveWayfindEffortId(...)`
  - `commands/shared.ts` → `export function makeCommandHelpers(state: RuntimeState, overlay: WayfindOverlay)` returning `{ startGrill(ctx, topic, withDocs): void; resolveEffortOrWarn(command, args, ctx, sessionId): string | undefined }`
  - `commands/grill-handlers.ts` → `export function makeGrillHandlers(pi, state, overlay)` returning `{ handleGrillMe, handleGrillDocs, handleGrillDone, handleGrillDomain }`
  - `commands/wayfind-handlers.ts` → `export function makeWayfindHandlers(pi, state, overlay)` returning `{ chart, status, spec, tickets, seed, sync, done, validate, statusbar, help }`

- [ ] **Step 1: Baseline the current tests**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test tests/commands.test.ts )`
Expected: PASS — record the count; it must be identical after the split.

- [ ] **Step 2: Move constants and pure helpers first**

Create `commands/keywords.ts` and `commands/help.ts` by moving (cut-paste, no rewording) the three `Set` constants, `resolveWayfindEffortId`, and `renderWayfindHelp` out of `commands.ts`; `commands.ts` re-exports `resolveWayfindEffortId` and `renderWayfindHelp` (`export { resolveWayfindEffortId, renderWayfindHelp } from "./commands/help.js";`) so existing imports resolve.

- [ ] **Step 3: Run tests**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test tests/commands.test.ts )`
Expected: PASS, same count as Step 1.

- [ ] **Step 4: Move the grill family**

Create `commands/shared.ts` (`startGrill`, `resolveEffortOrWarn` — they close over `pi`, `state`, `overlay`, hence the factory) and `commands/grill-handlers.ts` (the four grill handlers + `endGrillForSession`). Rewire `commands.ts` to use them. Move handler bodies verbatim; only the closure wiring changes.

- [ ] **Step 5: Run tests**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test tests/commands.test.ts )`
Expected: PASS, same count.

- [ ] **Step 6: Move the wayfind family**

Create `commands/wayfind-handlers.ts` with factory `makeWayfindHandlers(pi, state, overlay)` exposing `chart/status/spec/tickets/seed/sync/done/validate/statusbar/help` (bodies moved verbatim from `handleWayfinderChart`, `handleWayfinderStatus`, `handleToSpec`, `handleToTickets`, `handleWayfindSeed`, `handleChainSync`, `handleWayfindDone`, `handleWayfindValidate`, `handleWayfindStatusbar`, `handleWayfindHelp`). `commands.ts` shrinks to: imports, the two `pi.registerCommand` routing blocks (grill switch + wayfind keyword switch with the ambiguous-phrase guard, banner logic, and `--` force-chart escape — routing stays in the dispatcher), and the re-exports. Guards (banner, placeholder, ambiguous-phrase) live once in the dispatcher — do not duplicate them per-handler.

- [ ] **Step 7: Run the full wayfind gate**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun run check && bun run typecheck && bun test )`
Expected: PASS. `wc -l bun-apps/pi-agent-ext-wayfind/src/commands.ts` — Expected: ≤ 220 lines (dispatcher + re-exports).

- [ ] **Step 8: Commit**

```bash
git add bun-apps/pi-agent-ext-wayfind/src/commands.ts bun-apps/pi-agent-ext-wayfind/src/commands/
git commit -m "refactor(wayfind): split commands.ts into per-command handler modules"
```

---

### Task 10: Extract renderers + webui emit + hermes enrichment from `src/effort-tool.ts`

**Files:**
- Create: `bun-apps/pi-agent-ext-wayfind/src/effort-render.ts`
- Create: `bun-apps/pi-agent-ext-wayfind/src/effort-enrich.ts`
- Modify: `bun-apps/pi-agent-ext-wayfind/src/effort-tool.ts` (502 lines → gate def + 5 actions)
- Modify: `bun-apps/pi-agent-ext-wayfind/src/commands/wayfind-handlers.ts` (or `commands.ts` pre-Task-9 order — this task assumes Task 9 landed) — update its import of `renderValidate` to `./effort-render.js`
- Test: `bun-apps/pi-agent-ext-wayfind/tests/effort-tool.test.ts` (existing; must pass)

**Interfaces:**
- Consumes: current `effort-tool.ts` exports `createEffort`, `validateEffort`, `effortStatus`, `renderValidate`, `renderStatus`, `renderList`, `makeWayfindEffortTool(events?: EventBus)`; `renderCreate`/`renderSearch` are private; hermes enrichment calls `readStaleDecisions(effort, cwd)` from `./stale-seam.js`; webui emit is `events?.emit("webui:render", { content, mode: "md", view: "wayfind", title: "Wayfind" })`.
- Produces:
  - `src/effort-render.ts` → `export function renderCreate(r: EffortCreateResult): string`, `renderValidate(r: EffortValidateResult): string`, `renderStatus(r: EffortStatusResult): string`, `renderList(r: EffortListResult): string`, `renderSearch(r: EffortSearchResult): string` (bodies moved verbatim — byte-identical output is the acceptance bar; the `stale` undefined/null/0/N rendering branches must survive untouched)
  - `src/effort-enrich.ts` → `export async function enrichStatusStaleness(r: EffortStatusResult, cwd: string): Promise<void>` (the try/catch `readStaleDecisions` + `r.stale` + per-ticket `⚠` marking block) and `export async function enrichListStaleness(r: EffortListResult, cwd: string): Promise<void>` (the per-effort loop), plus `export function emitWayfindView(events: EventBus | undefined, content: string): void` (the guarded `webui:render` emit)
  - `src/effort-tool.ts` keeps: the `GATE_DEFS["wayfind_effort"]` registration, `createEffort`/`validateEffort`/`effortStatus` (pure cwd-based ops), their result interfaces, and `makeWayfindEffortTool` with all 5 actions dispatching to the extracted modules.

- [ ] **Step 1: Baseline**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test tests/effort-tool.test.ts )`
Expected: PASS — record the count.

- [ ] **Step 2: Move the renderers**

Create `effort-render.ts`; move `renderCreate`, `renderValidate`, `renderStatus`, `renderList`, `renderSearch` verbatim (making `renderCreate`/`renderSearch` exported); move the renderer-owned type imports (`EffortListResult`, `EffortSearchResult` from `./effort-query.js`; the result interfaces stay in `effort-tool.ts` — import them type-only). `effort-tool.ts` imports the renderers; re-export `renderValidate`/`renderStatus`/`renderList` from `effort-tool.ts` (`export { renderValidate, renderStatus, renderList } from "./effort-render.js";`) so `commands.ts`/`wayfind-handlers.ts` and tests keep resolving.

- [ ] **Step 3: Run tests**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test tests/effort-tool.test.ts )`
Expected: PASS, same count.

- [ ] **Step 4: Move enrichment + webui emit**

Create `effort-enrich.ts` with the three functions above (bodies moved verbatim from the `status` and `list` action cases). In `makeWayfindEffortTool`, the `status` case becomes: guard → `effortStatus` → `await enrichStatusStaleness(r, cwd)` → `if (r.ok) emitWayfindView(events, renderStatus(r))` → return; the `list` case likewise with `enrichListStaleness`. The 5-action switch, parameter schema, and gate wiring stay in `effort-tool.ts`.

- [ ] **Step 5: Run the full wayfind gate**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun run check && bun run typecheck && bun test )`
Expected: PASS. `wc -l bun-apps/pi-agent-ext-wayfind/src/effort-tool.ts` — Expected: ≤ 260 lines.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-wayfind/src/effort-render.ts bun-apps/pi-agent-ext-wayfind/src/effort-enrich.ts bun-apps/pi-agent-ext-wayfind/src/effort-tool.ts
git commit -m "refactor(wayfind): extract renderers + webui emit + hermes enrichment from effort-tool"
```

---

### Task 11: Relocate `architecture-render` + vendoring to archify

**Files:**
- Move: `bun-apps/pi-agent-ext-wayfind/src/architecture-render.ts` → `bun-apps/pi-agent-ext-archify/lib/architecture-render.ts`
- Move: `bun-apps/pi-agent-ext-wayfind/src/architecture.css` → `bun-apps/pi-agent-ext-archify/lib/architecture.css`
- Move: `bun-apps/pi-agent-ext-wayfind/vendor/mermaid.min.js`, `vendor/tailwind.css` → `bun-apps/pi-agent-ext-archify/vendored/mermaid.min.js`, `vendored/tailwind.css`
- Move: `bun-apps/pi-agent-ext-wayfind/scripts/vendor-mermaid.ts` → `bun-apps/pi-agent-ext-archify/scripts/vendor-mermaid.ts`
- Move: `bun-apps/pi-agent-ext-wayfind/tests/architecture-render.test.ts`, `tests/architecture-mermaid.test.ts` → `bun-apps/pi-agent-ext-archify/__tests__/architecture-render.test.ts`, `__tests__/architecture-mermaid.test.ts`
- Move: `bun-apps/pi-agent-ext-wayfind/tests/fixtures/architecture-render.golden.html` → `bun-apps/pi-agent-ext-archify/__tests__/fixtures/architecture-render.golden.html`
- Modify: `bun-apps/pi-agent-ext-wayfind/package.json` (remove `architecture:render`/`architecture:vendor`/`architecture:css`/`pretest`; drop `mermaid` dep and tailwind devDeps if unused elsewhere)
- Modify: `bun-apps/pi-agent-ext-archify/package.json` (add the scripts + deps)
- Test: `( cd bun-apps/pi-agent-ext-archify && bun test )` and `( cd bun-apps/pi-agent-ext-wayfind && bun run check && bun run typecheck && bun test )`

**Interfaces:**
- Consumes: `renderReport` (exported by `architecture-render.ts`, imported today only by the two test files); the CLI entry `bun run src/architecture-render.ts`; `vendor/tailwind.css` read at `src/architecture-render.ts:312` (relative path must be re-anchored to `../vendored/tailwind.css` after the move); the golden file compared by `architecture-render.test.ts`.
- Produces: archify owns the docs-diagram CLI (`bun run architecture:render` inside archify); wayfind has zero architecture-render surface. No src-level compat re-export is needed (verified: zero wayfind src importers — spec §4.3).

- [ ] **Step 1: Confirm zero importers (safety re-check)**

Run: `( cd bun-apps/pi-agent-ext-wayfind && grep -rn "architecture-render" src/ extensions/ --include='*.ts' | grep -v "src/architecture-render.ts:" )`
Expected: no hits (the spec's verification log says zero; re-verify at execution time — if a hit appears, stop and re-scope per OPEN-1).

- [ ] **Step 2: Move the files with git mv**

```bash
git mv bun-apps/pi-agent-ext-wayfind/src/architecture-render.ts bun-apps/pi-agent-ext-archify/lib/architecture-render.ts
git mv bun-apps/pi-agent-ext-wayfind/src/architecture.css bun-apps/pi-agent-ext-archify/lib/architecture.css
mkdir -p bun-apps/pi-agent-ext-archify/vendored
git mv bun-apps/pi-agent-ext-wayfind/vendor/mermaid.min.js bun-apps/pi-agent-ext-archify/vendored/mermaid.min.js
git mv bun-apps/pi-agent-ext-wayfind/vendor/tailwind.css bun-apps/pi-agent-ext-archify/vendored/tailwind.css
git mv bun-apps/pi-agent-ext-wayfind/scripts/vendor-mermaid.ts bun-apps/pi-agent-ext-archify/scripts/vendor-mermaid.ts
git mv bun-apps/pi-agent-ext-wayfind/tests/architecture-render.test.ts bun-apps/pi-agent-ext-archify/__tests__/architecture-render.test.ts
git mv bun-apps/pi-agent-ext-wayfind/tests/architecture-mermaid.test.ts bun-apps/pi-agent-ext-archify/__tests__/architecture-mermaid.test.ts
mkdir -p bun-apps/pi-agent-ext-archify/__tests__/fixtures
git mv bun-apps/pi-agent-ext-wayfind/tests/fixtures/architecture-render.golden.html bun-apps/pi-agent-ext-archify/__tests__/fixtures/architecture-render.golden.html
```

- [ ] **Step 3: Re-anchor paths in the moved files**

In `lib/architecture-render.ts`: change the `vendor/tailwind.css` read (line ~312) to resolve `../vendored/tailwind.css` relative to the new file location. In `scripts/vendor-mermaid.ts`: re-anchor its output path from `vendor/mermaid.min.js` to `vendored/mermaid.min.js` relative to the archify package root. In the two moved tests: change `renderReport` import paths from `../src/architecture-render.js` to `../lib/architecture-render.js`, and any fixture path from `tests/fixtures/…`/`./fixtures/…` to `./fixtures/…` under `__tests__/`. In `lib/architecture.css` handling inside `architecture:css` script (Step 4) the `-i` input moves to `lib/architecture.css`.

- [ ] **Step 4: Update both package.json files**

wayfind `package.json`: delete the `architecture:render`, `architecture:vendor`, `architecture:css`, and `pretest` scripts. archify `package.json` `scripts` gains:

```json
"architecture:render": "bun run lib/architecture-render.ts",
"architecture:vendor": "bun run scripts/vendor-mermaid.ts",
"architecture:css": "bunx @tailwindcss/cli -i lib/architecture.css -o vendored/tailwind.css --minify"
```

Dependencies: run `( cd bun-apps/pi-agent-ext-wayfind && grep -rn "mermaid\|tailwind" src/ scripts/ tests/ --include='*.ts' | grep -v architecture )` — if empty, `git rm`-level removal of `mermaid` from wayfind `dependencies` and `@tailwindcss/cli` + `tailwindcss` from wayfind `devDependencies` (via `bun remove` inside `bun-apps/pi-agent-ext-wayfind`); add `mermaid: ^11` to archify `dependencies` and `@tailwindcss/cli: ^4` + `tailwindcss: ^4` to archify `devDependencies` (via `bun add` inside `bun-apps/pi-agent-ext-archify`). Wayfind keeps `marked` (used by `src/markdown.ts` — verify with the same grep pattern for `marked`).

- [ ] **Step 5: Run both gates + golden byte-identity**

Run: `( cd bun-apps/pi-agent-ext-archify && bun test )`
Expected: PASS including the two moved suites; the golden comparison in `architecture-render.test.ts` passing **is** the byte-identity acceptance bar (spec OPEN-2 resolution — archify's `__tests__/fixtures/` convention matches).
Run: `( cd bun-apps/pi-agent-ext-wayfind && bun run check && bun run typecheck && bun test )`
Expected: PASS (wayfind no longer vendors in `pretest`; its suite must not reference the moved files).
Run: `( cd bun-apps/pi-agent-ext-archify && bun run architecture:render --help 2>&1 | head -5 )`
Expected: the CLI runs from its new home (exact flag surface per the file's own arg parsing; a usage/error banner is fine — the point is it executes, resolving OPEN-1: archify exposes the same CLI verb).

- [ ] **Step 6: Commit**

```bash
git add -A bun-apps/pi-agent-ext-wayfind/ bun-apps/pi-agent-ext-archify/
git commit -m "refactor(archify): relocate architecture-render + mermaid/tailwind vendoring from wayfind"
```

---

### Task 12: Verify archify registration + re-run schema-cost canary

**Files:**
- Verify only (modify nothing unless a check fails): `bun-apps/pi-agent-ext-archify/extensions/archify.ts`, `bun-apps/pi-agent/run-dir/manifest.json`, `bun-apps/pi-agent/src/cli/commands/schema-cost.ts`
- Test: schema-cost canary (see OPEN-4 for invocation)

**Interfaces:**
- Consumes: Task 11's relocation (lib-only move; no new extension surface added).
- Produces: recorded confirmation that the archify registration entry convention holds and measured schema cost after the merge (spec §3.2 requires the canary re-run).

- [ ] **Step 1: Verify registration entry conventions**

Run: `( cd bun-apps/pi-agent-ext-archify && ls extensions/ && cat package.json | grep -A4 '"pi"' )`
Expected: exactly one registration entry dir/file (`extensions/archify.ts`), `pi.extensions` pointing at it — the relocation added no extension surface, so no new entry and no double registration. Cross-check `bun-apps/pi-agent/run-dir/manifest.json` still lists archify once.

- [ ] **Step 2: Re-run the schema-cost canary**

Run the canary per OPEN-4 (read `bun-apps/pi-agent/src/cli/commands/schema-cost.ts` for its exact invocation — likely `bun bun-apps/pi-agent/src/cli/commands/schema-cost.ts` from repo root, or a `pi-agent` CLI subcommand; prefer the pi-agent wrapper `bun bun-apps/pi-agent/src/cli.ts`).
Expected: runs to completion; wayfind's measured cost drops or holds (6 fewer skill dirs); record before/after numbers in the commit message of Task 14 if actionable. Any regression beyond noise → investigate before proceeding.

- [ ] **Step 3: Commit (only if a fix was needed)**

If (and only if) a check failed and you modified a file:
```bash
git add -A bun-apps/pi-agent-ext-archify/ bun-apps/pi-agent/
git commit -m "fix(archify): registration/canary adjustment after architecture-render relocation"
```
Otherwise no commit — verification-only task.

---

### Task 13: ADR updates + new decision record

**Files:**
- Create: `bun-apps/pi-agent-ext-wayfind/docs/adr/0007-solution-extension-simplification.md`
- Modify: `bun-apps/pi-agent-ext-superpowers/docs/adr/0008-default-skill-exclusion-policy.md`
- Modify: `bun-apps/docs/adr/INDEX.md`
- Test: `( cd bun-apps && bun run test:adr )`

**Interfaces:**
- Consumes: spec `docs/superpowers/specs/2026-08-16-solution-extension-simplification-design.md`; ADR-wayfind-0003 (reverse seam), ADR-wayfind-0004 (globalThis seams), ADR-superpowers-0008 (exclusion policy).
- Produces: a resolvable decision record for the merge; ADR citations elsewhere in the repo keep resolving (`test:adr` gate).

- [ ] **Step 1: Write ADR-wayfind-0007**

Create `bun-apps/pi-agent-ext-wayfind/docs/adr/0007-solution-extension-simplification.md` with the standard ADR shape used by `0002`–`0006` in that dir (Status/Context/Decision/Consequences). Content requirements: full merge of 6 wayfind skills into superpowers counterparts (name the six and their targets, matching the Task 6 redirect table); wayfind = pure decide/wayfinder engine with artifact chain `CONTEXT.md → spec.md → tickets/ → task_plan.md → /wayfind seed → /wayfind sync`; `architecture-render` relocated to `@repo/pi-agent-ext-archify` with zero src importers and byte-identical goldens; invariants preserved per ADR-wayfind-0004 (globalThis seams) and ADR-wayfind-0003 (reverse seam); one-release redirect stubs in `ask-matt` with deletion scheduled per `docs/versioning.md` (ties to OPEN-3). Cite all ADRs with full IDs.

- [ ] **Step 2: Amend ADR-superpowers-0008**

Append to `bun-apps/pi-agent-ext-superpowers/docs/adr/0008-default-skill-exclusion-policy.md` a short "Interplay (2026-08 solution-extension simplification)" note: the methodology vocabulary is now consolidated in superpowers (6 wayfind skills merged — name them); `DEFAULT_SKILL_EXCLUDE` remains `["verification-before-completion", "using-superpowers"]` and requires no change; wayfind `ask-matt` redirects deleted-skill lookups here. Cite the spec by path.

- [ ] **Step 3: Update the ADR index and run the gate**

Add the new ADR row to `bun-apps/docs/adr/INDEX.md` (match its existing column format).
Run: `( cd bun-apps && bun run test:adr )`
Expected: PASS — all citations resolve, no bare-number citations anywhere in the touched files.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-wayfind/docs/adr/0007-solution-extension-simplification.md bun-apps/pi-agent-ext-superpowers/docs/adr/0008-default-skill-exclusion-policy.md bun-apps/docs/adr/INDEX.md
git commit -m "docs(adr): record solution-extension simplification (ADR-wayfind-0007, ADR-superpowers-0008 interplay)"
```

---

### Task 14: Final gate sweep (all packages)

**Files:**
- Verify only — no modifications expected.

**Interfaces:**
- Consumes: all prior tasks landed.
- Produces: green gates across every touched package + repo-level gates; the effort is done when this task passes.

- [ ] **Step 1: wayfind gate**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun run check && bun run typecheck && bun test )`
Expected: PASS (Biome clean, tsc clean, full suite).

- [ ] **Step 2: superpowers + archify gates**

Run: `( cd bun-apps/pi-agent-ext-superpowers && bun test )`
Expected: PASS.
Run: `( cd bun-apps/pi-agent-ext-archify && bun test && bun run typecheck )`
Expected: PASS (golden byte-identity included).

- [ ] **Step 3: Repo-level gates**

Run: `( cd bun-apps && bun run test:adr )`
Expected: PASS.
Run: schema-cost canary (same invocation resolved in Task 12 / OPEN-4).
Expected: completes; compare against Task 12's numbers — no unexplained growth.

- [ ] **Step 4: Sanity-grep the end state**

Run: `( cd bun-apps/pi-agent-ext-wayfind && ls skills/ | wc -l && wc -l src/commands.ts src/effort-tool.ts )`
Expected: `16` skill dirs; `src/commands.ts` ≤ 220 lines; `src/effort-tool.ts` ≤ 260 lines; `src/architecture-render.ts`, `vendor/`, and the three `architecture*` scripts absent from `package.json`.
Run: `( cd bun-apps/pi-agent-ext-wayfind && grep -rn "subagent-dispatch-discipline\|writing-for-agents" skills/ src/ tests/ )`
Expected: hits only inside `ask-matt`'s redirect table.

- [ ] **Step 5: No commit**

Verification-only; if anything failed, fix forward in the owning task's files and re-run this sweep.

---

## OPEN items (resolve during execution)

- **OPEN-1 — `architecture:render` CLI verb:** the spec leaves "archify exposes the same verb vs wayfind keeps a one-release alias" open. This plan resolves it as **archify exposes the verb** (Task 11 Step 4/5) and adds no wayfind alias; if muscle memory demands it later, add `"architecture:render": "bun run ../pi-agent-ext-archify/lib/architecture-render.ts"` to wayfind for one release and note it in ADR-wayfind-0007.
- **OPEN-2 — golden snapshot ownership:** resolved by Task 11 Step 5 — archify's `__tests__/fixtures/` convention matches wayfind's `tests/fixtures/`; the moved test passing against the unchanged golden **is** the byte-identity bar.
- **OPEN-3 — redirect-stub expiry:** "one release" needs a wayfind release marker. Resolve by reading `bun-apps/pi-agent-ext-wayfind/docs/versioning.md` at execution time and recording the concrete marker in ADR-wayfind-0007's Consequences (e.g. "stubs deleted at the first version bump after 0.x.y"). Until then the Task 6 table stands.
- **OPEN-4 — schema-cost canary invocation:** exact CLI for `bun-apps/pi-agent/src/cli/commands/schema-cost.ts` unverified. Resolve by reading that file's arg parsing (or its wiring in `bun-apps/pi-agent/src/cli/`) before Task 12 Step 2; prefer the pi-agent wrapper `bun bun-apps/pi-agent/src/cli.ts`. Note: per repo conventions it auto-derives registered extension entries from `bun-apps/pi-agent/run-dir/manifest.json`, so no `EXTRA_ENTRIES` row is needed for this effort (no new registration entries).
- **OPEN-5 — wayfind `procedures/` references:** Task 6 Step 1 greps `procedures/`; if the dir holds prose referencing deleted skills, rewrite per the redirect table. `src/procedures.ts` exports `procedurePath()` — only prose files need edits, not the path helper.

## Self-Review (run at plan time — done)

- **Spec coverage:** §3.1 dispositions → Tasks 1–8 (6 deletes in Task 6, 13 keeps untouched by design, 3 trims in Tasks 7–8); §3.2 migration (stubs, ADR-superpowers-0008, canary) → Tasks 6/12/13; §4.1 commands split → Task 9; §4.2 effort-tool split → Task 10; §4.3 relocation → Tasks 11–12; §4.4 keeps → Global Constraints; §5 gates → per-task Run steps + Task 14. No spec section lacks a task.
- **Placeholder scan:** every code/prose step carries verbatim content or an exact move/rewrite instruction with expected line counts and grep assertions; no TODO/TBD/"add appropriate" anywhere. Unknowns are consolidated in OPEN items with resolution paths, as permitted.
- **Type consistency:** `resolveWayfindEffortId`/`renderWayfindHelp`/`registerCommands`/`endGrillForSession` signatures identical before/after Task 9; `renderValidate`/`renderStatus`/`renderList` re-exported from `effort-tool.ts` after Task 10 so `commands.ts`/`wayfind-handlers.ts` imports resolve; `makeWayfindHandlers`/`makeGrillHandlers`/`makeCommandHelpers` factories defined in Task 9 Interfaces and consumed only there.
