# codebase-design Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `codebase-design` shared deep-module design vocabulary skill to the superpowers package and wire it into `brainstorming` and `writing-plans`, validated via the writing-skills RED→GREEN→REFACTOR cycle.

**Architecture:** A new model-invoked pattern skill (`codebase-design/`) adapted faithfully from the upstream Matt Pocock source, plus positive-recipe wiring edits to two consumer skills. Skill validity is established TDD-style: baseline design scenarios run WITHOUT the skill (RED), then WITH it (GREEN), then loopholes are plugged (REFACTOR). The "tests" are subagent dispatches (recognition/application scenarios + wording micro-tests), not unit tests.

**Tech Stack:** Markdown skills in `bun-apps/pi-agent-ext-superpowers`; subagents (read-only fan-out / single dispatch) for skill testing.

## Global Constraints

- All written artifacts in English.
- New skill is model-invoked (no `disable-model-invocation` frontmatter); type = pattern/reference (NOT discipline-enforcing).
- Wiring edits are positive recipes (no prohibitions — the failure is informal design talk, a shaping problem); they reference `superpowers:codebase-design` by name, never via `@` force-load (token-careful).
- Keep the TS code examples in the adapted skill content (clearest for interface concepts; deliberate).
- The upstream source is readable on disk at `/Users/huangziyu/proj/pi-ext-matt-skills/skills/engineering/codebase-design/{SKILL.md,DEEPENING.md,DESIGN-IT-TWICE.md}` — adapt from there, applying the concrete deltas each task specifies.
- Skills live under `bun-apps/pi-agent-ext-superpowers/skills/`. Test-evidence docs go under `.planning/specs/`.
- Shell discipline: never top-level `cd`; use `( cd <dir> && ... )` subshells.
- Test tasks (1, 3, 4, 6) dispatch subagents; the executor must grant those tasks the `subagent`/`subagents` tools (or the orchestrator runs the dispatches at the checkpoint).

---

### Task 1: RED — baseline design behavior without the skill

**Files:**
- Create: `.planning/specs/codebase-design-baseline-RED.md`

**Interfaces:**
- Consumes: nothing
- Produces: a documented baseline of how agents currently do module-interface design talk (no shared vocabulary, no deletion test, no design-it-twice)

- [ ] **Step 1: Dispatch 3 parallel subagents** (isolated context; these subagents must NOT be given the codebase-design skill or any of its vocabulary — no "deep module", "seam", "deletion test", "design-it-twice"). Each gets the identical task: "Design the interface for a module that batches requests to a flaky remote API and retries failed ones with exponential backoff. Describe the module, its interface, and your design reasoning."
- [ ] **Step 2: Document the baseline.** In `.planning/specs/codebase-design-baseline-RED.md`, record verbatim per subagent: (a) the design vocabulary used (expect "unit/component/API/boundary" or none), (b) whether any deletion-test-style reasoning appears (expect none), (c) whether any agent explored 2-3 alternative interfaces (expect none), (d) whether seams/adapters were discussed (expect none or informal).
- [ ] **Step 3: Commit.** `( cd /Users/huangziyu/proj/video_generation__superpowers && git add .planning/specs/codebase-design-baseline-RED.md && git commit -m "test(codebase-design): RED baseline — design talk without the skill" )`

This is the failing test that proves the gap the skill must close.

---

### Task 2: GREEN part 1 — create the three skill files (adapt from upstream)

**Files:**
- Create: `bun-apps/pi-agent-ext-superpowers/skills/codebase-design/SKILL.md`
- Create: `bun-apps/pi-agent-ext-superpowers/skills/codebase-design/DEEPENING.md`
- Create: `bun-apps/pi-agent-ext-superpowers/skills/codebase-design/DESIGN-IT-TWICE.md`
- Source: `/Users/huangziyu/proj/pi-ext-matt-skills/skills/engineering/codebase-design/`

**Interfaces:**
- Consumes: the three upstream source files
- Produces: the three adapted skill files

- [ ] **Step 1: Read the upstream source.** Read `/Users/huangziyu/proj/pi-ext-matt-skills/skills/engineering/codebase-design/SKILL.md`, `.../DEEPENING.md`, and `.../DESIGN-IT-TWICE.md` in full.
- [ ] **Step 2: Write `SKILL.md`** adapted with these deltas from upstream:
  - Keep frontmatter `name: codebase-design` and the `description:` line verbatim (it already begins "Shared vocabulary for designing deep modules. Use when...").
  - Keep glossary, deep-vs-shallow ASCII diagrams, principles, designing-for-testability TS examples, relationships, rejected framings, and the "Going deeper" links to DEEPENING.md / DESIGN-IT-TWICE.md — verbatim.
  - This is a faithful port; no structural changes; TS examples retained.
- [ ] **Step 3: Write `DEEPENING.md`** verbatim from upstream.
- [ ] **Step 4: Write `DESIGN-IT-TWICE.md`** verbatim from upstream. (Its "spawn sub-agents in parallel" maps to the pi `subagents`/`subagent` tools; the wording is harness-agnostic — keep it.)
- [ ] **Step 5: Verify.** `( cd bun-apps/pi-agent-ext-superpowers && ls skills/codebase-design/ && head -5 skills/codebase-design/SKILL.md )` — expect three files and correct frontmatter.
- [ ] **Step 6: Commit.** `( cd /Users/huangziyu/proj/video_generation__superpowers && git add bun-apps/pi-agent-ext-superpowers/skills/codebase-design/ && git commit -m "feat(superpowers): add codebase-design skill (adapted from upstream)" )`

---

### Task 3: GREEN part 2 — verify the skill changes behavior

**Files:**
- Create: `.planning/specs/codebase-design-GREEN.md`

**Interfaces:**
- Consumes: the skill files from Task 2
- Produces: evidence that, with the skill loaded, agents use the vocabulary + deletion test + design-it-twice

- [ ] **Step 1: Dispatch 3 parallel subagents** with the SAME design task as Task 1 Step 1, but include the full `codebase-design/SKILL.md` content (plus DEEPENING.md and DESIGN-IT-TWICE.md) in each subagent's instructions, and tell them to follow the skill.
- [ ] **Step 2: Document** in `.planning/specs/codebase-design-GREEN.md`, per subagent: (a) used module/interface/seam/depth/leverage/locality vocabulary? (b) applied the deletion test? (c) invoked design-it-twice (explored multiple interfaces)?
- [ ] **Step 3: Gate.** Pass if ≥2 of 3 use the vocabulary AND ≥1 applies the deletion test AND ≥1 invokes design-it-twice. If not, revise the skill wording (return to Task 2 Step 2) and re-run.
- [ ] **Step 4: Commit.** `( cd /Users/huangziyu/proj/video_generation__superpowers && git add .planning/specs/codebase-design-GREEN.md && git commit -m "test(codebase-design): GREEN — skill changes design behavior" )`

---

### Task 4: RED — baseline for the wiring edits

**Files:**
- Create: `.planning/specs/codebase-design-wiring-RED.md`

**Interfaces:**
- Consumes: the CURRENT `brainstorming/SKILL.md` and `writing-plans/SKILL.md`
- Produces: baseline showing current skills don't invoke codebase-design vocabulary during their design phases

- [ ] **Step 1: Brainstorming baseline.** Dispatch a subagent the CURRENT `bun-apps/pi-agent-ext-superpowers/skills/brainstorming/SKILL.md` content as its process, and a feature to brainstorm that involves module boundaries (e.g., "brainstorm a caching layer for the GUI's model-loading"). Have it produce its design. Record whether it uses codebase-design vocabulary or reaches for deletion test / design-it-twice (expect: informal "units/boundaries", no skill invocation).
- [ ] **Step 2: Writing-plans baseline.** Dispatch a subagent the CURRENT `writing-plans/SKILL.md` and ask it to draft the File Structure section for a feature with a contested module boundary. Record baseline (expect: "files that change together live together", no deletion test, no design-it-twice, no codebase-design reference).
- [ ] **Step 3: Document both baselines** verbatim in `.planning/specs/codebase-design-wiring-RED.md`.
- [ ] **Step 4: Commit.** `( cd /Users/huangziyu/proj/video_generation__superpowers && git add .planning/specs/codebase-design-wiring-RED.md && git commit -m "test(codebase-design): RED baseline for wiring edits" )`

---

### Task 5: Apply the wiring edits

**Files:**
- Modify: `bun-apps/pi-agent-ext-superpowers/skills/brainstorming/SKILL.md` — the bullets under `**Design for isolation and clarity:**`
- Modify: `bun-apps/pi-agent-ext-superpowers/skills/writing-plans/SKILL.md` — the bullets under `## File Structure`

**Interfaces:**
- Consumes: the exact "After" text below (from the spec, Section 4)
- Produces: the two wired skills

- [ ] **Step 1: Edit brainstorming.** In `brainstorming/SKILL.md`, replace the four bullets under `**Design for isolation and clarity:**` with exactly these six bullets (keep the `**Design for isolation and clarity:**` heading and surrounding text unchanged):

```
- Break the system into modules that each have one clear purpose behind a small interface at a clean seam, testable through that interface
- For each module apply the **deletion test**: imagine deleting it — if complexity vanishes it's a pass-through (fold it in), if it reappears across callers it earns its keep
- Can someone use a module without reading its internals? Can you change the internals without breaking consumers? If not, the interface/seam needs work
- When the design hinges on a core interface, run **design-it-twice** (`superpowers:codebase-design`): explore 2-3 radically different interfaces and pick on depth and leverage
- **REQUIRED SUB-SKILL:** Use `superpowers:codebase-design` for the shared vocabulary (module/interface/seam/depth/leverage/locality) whenever a design involves module boundaries
- Smaller, well-bounded modules are also easier for you to work with - you reason better about code you can hold in context at once, and your edits are more reliable when files are focused. When a file grows large, that's often a signal that it's doing too much.
```

- [ ] **Step 2: Edit writing-plans.** In `writing-plans/SKILL.md`, replace the four bullets under `## File Structure` (the ones beginning "Design units with clear boundaries...") with exactly these five bullets (keep the `## File Structure` heading, the "Before defining tasks..." intro paragraph, and the "This structure informs the task decomposition..." line unchanged):

```
- Design modules with small interfaces at clean seams (`superpowers:codebase-design`). Each file should have one clear responsibility; apply the **deletion test** to any module — if removing it makes complexity vanish, fold it back in
- You reason best about code you can hold in context at once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large files that do too much.
- Files that change together should live together (**locality**) — split by responsibility, not by technical layer
- When a file grows large or a module boundary is contested, reach for **design-it-twice** (`superpowers:codebase-design`) to compare interface options
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.
```

- [ ] **Step 3: Verify.** `( cd /Users/huangziyu/proj/video_generation__superpowers && grep -n "codebase-design" bun-apps/pi-agent-ext-superpowers/skills/brainstorming/SKILL.md bun-apps/pi-agent-ext-superpowers/skills/writing-plans/SKILL.md )` — expect references in both files.
- [ ] **Step 4: Commit.** `( cd /Users/huangziyu/proj/video_generation__superpowers && git commit -am "feat(superpowers): wire codebase-design vocabulary into brainstorming + writing-plans" )`

---

### Task 6: GREEN — wording micro-test for the wiring

**Files:**
- Create: `.planning/specs/codebase-design-wiring-GREEN.md`

**Interfaces:**
- Consumes: the wired skills from Task 5
- Produces: micro-test evidence that the wiring measurably increases codebase-design invocation vs a no-guidance control

- [ ] **Step 1: Micro-test.** Per `writing-skills`, dispatch 5 subagents (fresh context each) the brainstorming design-phase task WITH the wired `brainstorming/SKILL.md` (the wired arm), and a control of 5 subagents the SAME task with NO skill guidance.
- [ ] **Step 2: Score.** For each output: did it reference/use codebase-design vocabulary or reach for the deletion test / design-it-twice? Read every flagged match manually (template echoes masquerade as hits).
- [ ] **Step 3: Gate.** The wired arm must show meaningfully higher invocation than the control. If not, tighten the wiring wording (return to Task 5) and re-run. Note: if the control already exhibits the behavior, there is nothing to prove — record and proceed.
- [ ] **Step 4: Document** in `.planning/specs/codebase-design-wiring-GREEN.md`; commit. `( cd /Users/huangziyu/proj/video_generation__superpowers && git add .planning/specs/codebase-design-wiring-GREEN.md && git commit -m "test(codebase-design): GREEN micro-test for wiring" )`

---

### Task 7: REFACTOR — plug loopholes

**Files:**
- Modify: skill files / wiring as needed

- [ ] **Step 1: Hunt loopholes** in the GREEN outputs (Tasks 3 & 6): agents name-dropping vocabulary without applying it; invoking design-it-twice on a trivial interface; over-introducing seams (treating a single adapter as a real seam).
- [ ] **Step 2: Add counters** if found. E.g., in `SKILL.md` principles: "Invoke design-it-twice only when the interface is genuinely non-obvious; one adapter is a hypothetical seam, not a real one — don't introduce it prematurely." Re-run the relevant scenario to confirm the counter holds.
- [ ] **Step 3: Commit** any refinements: `( cd /Users/huangziyu/proj/video_generation__superpowers && git commit -am "refactor(codebase-design): close loopholes from GREEN testing" )`

---

### Task 8: Self-review + final verification

- [ ] **Step 1: Plan self-review.** Per writing-plans: spec coverage (every spec section → a task?), placeholder scan, name/type consistency across tasks.
- [ ] **Step 2: Final verification.** The 5 deliverable files exist; `grep` confirms `codebase-design` referenced in `brainstorming/SKILL.md` and `writing-plans/SKILL.md`; RED/GREEN/REFACTOR evidence docs exist under `.planning/specs/`.
- [ ] **Step 3: Test suite.** `( cd bun-apps/pi-agent-ext-superpowers && bun test )` — confirm nothing broke (the package has a tests/ dir).
- [ ] **Step 4: Report done** with the list of commits and file paths.

---

## Execution Handoff

Plan complete. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**2. Inline Execution** — run tasks in this session via executing-plans with checkpoints. REQUIRED SUB-SKILL: superpowers:executing-plans.

> **PIVOT (2026-08-07):** Tasks 2/5/7 were executed against `pi-agent-ext-superpowers`, which is a byte-identical `obra/superpowers` port (ADR-0004) — those edits were reverted. `codebase-design` was re-homed to `pi-agent-ext-wayfind` (`skills/codebase-design/`, commit 31feaffb), validated GREEN. The `brainstorming`/`writing-plans` wiring was dropped (superpowers forbids editing pinned bodies); the skill is globally auto-invocable by description instead. See the spec's "Post-validation pivot" section.
