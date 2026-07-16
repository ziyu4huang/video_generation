---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task and need to write the implementation plan content — before writing any code. Covers plan QUALITY (file-structure-first, small TDD steps, no placeholders, self-check). The task_plan.md file mechanics, hooks, and progress tracking are owned by planning-with-files; this skill is about what makes the plan's content good.
---

# Writing Plans

## Overview

Write a comprehensive implementation plan assuming the engineer who executes it has
**zero context** about your codebase and questionable taste. Record everything they
need: for every task — which files to change, the code, the tests, the docs to consult,
how to verify. Break the whole thing into small steps. DRY. YAGNI. TDD. Commit often.

Assume they are an experienced developer who knows almost nothing about your toolchain
and problem domain, and is not great at test design.

> **Scope boundary:** planning-with-files owns *where* plans live (`task_plan.md` /
> `findings.md` / `progress.md` under `.planning/<slug>/`), the hooks, the nags, the
> `/plan execute` gate, and progress tracking. This skill owns *what* makes the plan's
> content good. Do not duplicate the substrate here.

**Announce at the start:** "I am using the writing-plans skill to author the plan content."

## Scope check

If the spec spans multiple independent subsystems, it should have been split during
brainstorming. If it wasn't, propose splitting into separate plans — one per subsystem.
Each plan must independently produce working, testable software.

## File structure — decide it before tasks

Before defining tasks, list the files you will create or modify and each one's
responsibility. This is where you lock the decomposition.

- Design well-bounded units with defined interfaces; one clear responsibility per file.
- You reason best about code that fits in context at once; focused files make edits
  reliable. Prefer small, focused files over oversized catch-alls.
- Files that change together live together. Split by responsibility, not by tech layer.
- In an existing codebase, follow established patterns. Don't refactor unilaterally —
  but if a file you're touching has become unmanageable, including a split in the plan
  is legitimate.

This structure drives the task breakdown. Each task should produce a standalone,
meaningful change.

## Small-step granularity

**Each step is one action (2-5 min):**

- "write the failing test" — one step
- "run it, confirm it fails" — one step
- "write the minimal code to pass" — one step
- "run the test, confirm it passes" — one step
- "commit" — one step

Use the `todo` tool to track steps within a task in-session; the phase lives in
`task_plan.md` across sessions.

## Plan document header

Every plan body must open with:

```markdown
# [Feature] Implementation Plan

**Goal:** [one sentence — what is being built]
**Architecture:** [2-3 sentences — the approach]
**Tech stack:** [key technologies / libraries]

---
```

(The `task_plan.md` template from planning-with-files already carries Goal / Phases /
Decisions / Errors. Keep this header's Architecture + Tech stack section distinct and
non-duplicative.)

## Task structure

````markdown
### Task N: [Component]

**Files:**
- create: `exact/path/to/file.ts`
- modify: `exact/path/to/existing.ts:123-145`
- test: `tests/exact/path/to/file.test.ts`

- [ ] **Step 1: write the failing test**

```typescript
test("specific behavior", () => {
  const result = fn(input);
  expect(result).toEqual(expected);
});
```

- [ ] **Step 2: run the test, confirm it fails**

Run: `bun test tests/path/file.test.ts`
Expected: FAIL, "fn is not defined"

- [ ] **Step 3: write the minimal implementation**

```typescript
export function fn(input: T): U {
  return expected;
}
```

- [ ] **Step 4: run the test, confirm it passes**

Run: `bun test tests/path/file.test.ts`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add tests/path/file.test.ts src/path/file.ts
git commit -m "feat: add specific feature"
```
````

## No placeholders

Every step must contain the actual content the engineer needs. The following are
**plan defects** — never write them:

- "TBD", "TODO", "implement later", "fill in details"
- "add proper error handling" / "add validation" / "handle edge cases"
- "write tests for the above" (without the actual test code)
- "similar to Task N" (duplication — engineers may read tasks out of order)
- steps that describe *what* without showing *how* (code steps need code blocks)
- references to types, functions, or methods defined in no task

## Self-check

After writing the full plan, re-read the spec with fresh eyes and check the plan
against it. This is a self-checklist, not a subagent dispatch.

1. **Spec coverage:** walk every section/requirement in the spec. Can you point to the
   task that implements it? List every gap.
2. **Placeholder scan:** search for the red flags above. Fix them.
3. **Type consistency:** do the types, signatures, and property names used in later
   tasks match those defined in earlier tasks? `clearLayers()` in Task 3 but
   `clearFullLayers()` in Task 7 is a bug.

Fix problems inline. No re-review needed — fix and move on. If a spec requirement has
no corresponding task, add the task.

## Execution handoff

Once the plan is saved, hand off to execution. Two paths:

- **Inline** — `executing-plans`: batch tasks with review checkpoints, in the current session.
- **Subagent-driven** (recommended when tasks are independent) — `subagent-driven-development`:
  a fresh, context-isolated subagent per task via the `subagent` / `workflow` tools, each with a
  two-phase review (spec compliance, then code quality).

Either path should first establish an isolated workspace (`using-git-worktrees`) and end with
`finishing-a-development-branch`.

## Notes

- Always use exact file paths.
- Every step includes complete code — if a step involves a code change, show the code.
- Exact commands and expected output.
- DRY, YAGNI, TDD, commit often.
