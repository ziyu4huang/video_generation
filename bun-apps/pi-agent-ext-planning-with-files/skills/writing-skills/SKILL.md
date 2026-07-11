---
name: writing-skills
description: Use when creating a new skill, editing an existing skill, or validating a skill before deploy. Applies TDD to documentation (red = baseline failure without the skill; green = write the skill; refactor = plug rationalizations). Governs description wording (trigger-only "Use when…", never a workflow summary), naming, keyword coverage, and the rationalization-table + red-line-list pattern for discipline skills.
---

# Writing Skills

## Overview

**Writing a skill is TDD applied to process documentation.**

You write tests (stress scenarios), watch them fail (baseline behavior), write the
skill (the doc), watch them pass (the agent now follows the rule), then refactor (plug
the holes).

**Core principle: if you haven't seen the agent fail WITHOUT the skill, you don't know
whether the skill teaches the right thing.**

> **Position in the chain:** this is the meta-skill that governs the whole suite — how
> to author, edit, and maintain skills. The CSO rules below are exactly what
> `tests/skills.test.ts` in this package encodes deterministically. Treat that test as
> the executable spec for this skill.

## What a skill is

A **skill** is a verified technique, pattern, or reference guide. It helps future
instances find and apply what works.

- **A skill IS:** a reusable technique, pattern, tool reference.
- **A skill is NOT:** a narrative about how you once solved a problem.

## TDD mapped to skills

| TDD concept | Skill creation |
|------------|----------------|
| test case | a stress scenario (run with a subagent) |
| production code | the skill document (SKILL.md) |
| test failure (red) | the agent violates the rule WITHOUT the skill (baseline) |
| test passes (green) | the agent follows the rule WITH the skill |
| refactor | plug new rationalizations while keeping compliance |
| write test first | run the baseline scenario before writing the skill |
| minimal code | write the skill against the SPECIFIC observed violations |

The whole process is red-green-refactor.

## When to create a skill

**Create when:**
- the technique isn't intuitively obvious to you
- you'll reference it across projects
- the pattern is broadly applicable (not project-specific)
- others would benefit

**Don't create:**
- one-off solutions
- standard practices documented elsewhere
- project-specific conventions (those go in CLAUDE.md)
- mechanical constraints (if a regex/validator can enforce it, automate it; reserve
  docs for things that need judgment)

## Directory structure

```
skills/
  skill-name/
    SKILL.md              # main reference (required)
    supporting-file.*     # only when needed
```

Flat namespace — all skills in one searchable space. Split a file out only for (1)
large reference content (100+ lines) or (2) a reusable tool/template. Keep principles,
short code patterns (<50 lines), and everything else inline.

## SKILL.md structure

**Frontmatter (YAML):**
- two required fields: `name` and `description` (full spec: agentskills.io)
- total ≤ 1024 chars
- `name`: letters, digits, hyphens only (no brackets/special chars)
- `description`: third person, describes WHEN TO USE only (never what it does)
  - starts "Use when…", focused on triggers
  - includes concrete symptoms, scenarios, context
  - **never summarizes the skill's workflow/process** (see CSO below)
  - keep under ~500 chars

```markdown
---
name: skill-name-with-hyphens
description: Use when [concrete triggers and symptoms]
---

# Skill Name

## Overview — what it is, 1-2 sentences, core principle.
## When to use — symptoms, use cases, when NOT to use.
## Core pattern — before/after code.
## Quick reference — table or bullets for scanning.
## Implementation — inline for simple; link a file for large reference.
## Common mistakes — frequent problems + fixes.
```

## Claude/Pi Search Optimization (CSO) — discovery is everything

Future instances must FIND your skill.

### 1. Rich description field

The model reads descriptions to decide which skills to load for a task. Answer:
"should I load this skill right now?"

**Key: description = WHEN, not WHAT.** Describe triggers only. Never summarize the
workflow — testing showed that when a description summarizes the workflow, the model
follows the description shortcut and SKIPS the skill body. A description like "executes
plans, dispatches a subagent per task with review between tasks" made the model do only
one review, even though the skill's flowchart clearly showed two.

When the description was changed to trigger-only ("Use when executing implementation
plans with independent tasks"), the model read the flowchart and followed the two-phase
review correctly.

**The trap:** a workflow-summarizing description creates a shortcut the model takes.
The skill body becomes documentation the model skips.

```yaml
# WRONG: summarizes the workflow — the model may follow the description, not the skill
description: Use for TDD — write test first, watch it fail, write minimal code, refactor

# RIGHT: trigger only, no workflow summary
description: Use when implementing any feature or bugfix, before writing implementation code
```

### 2. Keyword coverage

Use words the model will search for: error messages ("Hook timed out", "ENOTEMPTY"),
symptoms ("flaky", "hanging", "race condition"), synonyms, tool/command names.

### 3. Descriptive naming

Verb-first, active: `creating-skills` not `skill-creation`; `condition-based-waiting`
not `async-test-helpers`. Gerunds (-ing) read as active processes.

### 4. Token efficiency (critical)

Skills that get referenced often cost tokens every load. Targets:
- frequently-loaded skills: <200 words total
- others: <500 words (still concise)

Push detail to supporting files or `--help`. Cross-reference other skills by NAME ONLY
(`verification-before-completion`) — never `@`-link them (forces eager load, burns
context).

## Flowcharts

Use a small inline flowchart ONLY for non-obvious decision points or loops where you
might stop early. Never for reference material (→ tables), code (→ code blocks), or
linear instructions (→ numbered lists).

## Code examples

One excellent example beats several mediocre ones. Pick the most relevant language
(testing → TypeScript; system → shell/python). Good examples: complete, runnable,
well-commented, from real scenarios, directly adaptable. Don't ship 5-language variants
or fill-in-the-blank templates.

## Rationalization resistance (discipline skills)

Discipline skills (TDD, verification, brainstorming's hard-gate) must resist
rationalization. The model is clever and finds loopholes under pressure.

- **Plug each loophole explicitly** — don't just state the rule; forbid the specific
  workaround.
- **Lead with the principle** — "violating the letter violates the spirit" cuts off a
  whole class of "I followed the spirit" excuses.
- **Build a rationalization table** — every excuse observed in baseline testing goes in
  ("excuse | reality").
- **Create a red-line list** — make self-check easy ("if you're thinking X, stop").

See `test-driven-development` and `verification-before-completion` in this suite for
worked examples of all four.

## The Iron Rule (same as TDD)

```
No skill without a failing test.
```

Applies to new skills AND edits. Wrote the skill before testing? Delete it. Start over.
No exceptions for "simple additions", "just one section", or "doc updates". Don't keep
untested changes "as reference".

For a PORT (adapting a skill validated elsewhere, e.g. from superpowers), the baseline
is already validated — but Pi-specific adaptation should still be spot-checked: does
the adapted skill still make the agent follow the rule in a Pi scenario?

## Skill creation checklist (TDD-adapted)

Create a `todo` per item.

**Red — write the failing test:**
- [ ] create the stress scenario (3+ combined pressures for discipline skills)
- [ ] run it WITHOUT the skill — record baseline behavior verbatim
- [ ] spot the patterns in the rationalizations

**Green — write the minimal skill:**
- [ ] name is letters/digits/hyphens only
- [ ] frontmatter has `name` + `description` (≤1024 chars)
- [ ] description starts "Use when…" with concrete triggers
- [ ] description is third person, no workflow summary
- [ ] body carries searchable keywords (errors, symptoms, tools)
- [ ] clear overview with the core principle
- [ ] addresses the SPECIFIC baseline failures from red
- [ ] code inline or linked to a file
- [ ] one excellent example
- [ ] run the scenario WITH the skill — verify compliance

**Refactor — plug the holes:**
- [ ] identify new rationalizations from testing
- [ ] add explicit rebuttals (discipline skills)
- [ ] build the rationalization table from all test iterations
- [ ] create the red-line list
- [ ] re-test until bulletproof

**In this package specifically:**
- [ ] `tests/skills.test.ts` passes for the new skill (frontmatter guard — the
      executable form of the CSO rules above)
- [ ] if it's a discipline skill, it ships a rationalization table + red-line list

## Common excuses for skipping tests

| Excuse | Reality |
|--------|---------|
| "the skill is clearly written" | clear to you ≠ clear to other instances; test it |
| "it's just reference material" | reference can have gaps; test retrieval |
| "testing is overkill" | untested skills always have issues; 15 min saves hours |
| "test it if problems arise" | problems = the agent can't use the skill; test before deploy |
| "I'm confident it's good" | overconfidence guarantees issues |
| "no time to test" | deploying untested costs more than fixing later |

**All mean: test before deploy. No exceptions.**

## Anti-patterns

- **narrative examples** ("on 2025-10-03 we found…") — too specific, not reusable
- **multi-language dilution** (example-js.js, example-py.py) — mediocre, heavy维护
- **code in flowcharts** — not copy-pasteable, hard to read
- **generic labels** (helper1, step3) — labels must be semantic

## Summary

Creating a skill is TDD for process docs. Same iron rule: no skill without a failing
test. Same cycle: red (baseline) → green (write skill) → refactor (plug holes). If you
TDD your code, TDD your skills.
