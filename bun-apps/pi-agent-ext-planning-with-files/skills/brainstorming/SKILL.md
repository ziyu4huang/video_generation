---
name: brainstorming
description: Use when starting any creative or implementation work — creating features, building components, adding capabilities, or changing behavior. Explores intent, requirements, and design through collaborative dialogue BEFORE any code is written. Hard-gated — no implementation skill, code, or scaffolding until a design is shown and approved; brainstorming's only exit is handing off to writing-plans.
---

# Brainstorming: turn ideas into design

Help turn an idea into a complete design and spec through natural collaborative
dialogue.

First understand the current project context, then refine the idea one question at a
time. Once you understand what to build, present the design and get user approval.

<HARD-GATE>
Before you present a design and get user approval, do not call any implementation
skill, write any code, scaffold any project, or take any implementation action. This
applies to every project, no matter how simple it looks.
</HARD-GATE>

## Anti-pattern: "this is too simple to need a design"

Every project goes through this flow. A todo list, a single-function tool, a config
change — all of them. "Simple" projects are exactly where unexamined assumptions waste
the most. The design can be short (a few sentences for genuinely simple projects), but
you must present it and get approval.

> **Position in the chain:** brainstorming is what happens BEFORE `task_plan.md`. Its
> output (an approved design/spec) is the input to the `writing-plans` skill, which
> turns it into the plan content that `planning-with-files` then tracks. For non-trivial
> designs, stress-test the spec first via `grill-me-with-docs` (resolves the decision
> tree → `CONTEXT.md` + ADRs) before writing the plan. See the full build chain in
> `writing-plans`.

## Checklist

Create a `todo` for each of these and complete them in order:

1. **Explore project context** — check files, docs, recent commits
2. **Offer a visual companion** (only if the topic is visual) — a separate message;
   see "Visual companion" below
3. **Ask clarifying questions** — one decision at a time; understand purpose /
   constraints / success criteria
4. **Propose 2-3 options** — with trade-offs and your recommendation
5. **Present the design** — section by section, by complexity; get approval per section
6. **Write the design doc** — save it and commit
7. **Spec self-check** — quick inline scan for placeholders, contradictions, ambiguity,
   scope (below)
8. **User reviews the written spec** — before continuing
9. **Hand off to implementation** — call the `writing-plans` skill

## Process detail

**Understand the idea:**
- First look at the current project state (files, docs, recent commits)
- Before detailed questions, assess scope: if the request describes multiple independent
  subsystems (e.g. "a platform with chat, file storage, billing, and analytics"), call
  it out immediately. Don't spend questions refining a project that needs splitting first.
- If the project is too large for one spec, help decompose it into sub-projects: what
  are the independent parts, how do they relate, in what order should they be built?
  Then brainstorm the first sub-project through the normal flow. Each sub-project gets
  its own spec → plan → implementation cycle.
- For appropriately-scoped projects, refine the idea one question at a time
- Prefer structured choices; open-ended is fine too. Prefer the `ask_user_question` tool
  for concrete either/or decisions (batch up to 4); use free-form exploration otherwise.
- One decision per message — if a topic needs more exploration, split it
- Focus on: purpose, constraints, success criteria

**Explore options:**
- Propose 2-3 distinct options with trade-offs
- Present conversationally, with your recommendation and reasoning
- Lead with your recommended option and why

**Present the design:**
- Once you believe you understand what to build, present the design
- Size each section to its complexity: simple → a few sentences; complex → ≤ 200-300 words
- After each section, ask whether it's correct
- Cover: architecture, components, data flow, error handling, testing
- Be ready to go back and clarify anything unclear

**Design for isolation and clarity:**
- Split the system into smaller units, each with one clear responsibility, communicating
  through well-defined interfaces, independently understandable and testable
- For each unit you should be able to answer: what does it do, how is it used, what does
  it depend on?
- Can someone understand a unit's function without reading its internals? Can you change
  its internals without affecting callers? If not, the boundary needs work.
- Smaller, clearly-bounded units are also easier for YOU to work with — you reason best
  about code that fits in context at once.

**Working in an existing codebase:**
- Explore the existing structure before proposing changes. Follow existing patterns.
- If existing code has problems affecting the current work (oversized files, unclear
  boundaries, tangled responsibilities), include targeted improvements in the design —
  like a good developer improving code they touch. Don't propose unrelated refactors.

## After design

**Document:** write the approved design (the spec) to `.planning/<slug>/design.md`
(paired with the plan that `writing-plans` will produce). For durable, cross-session
specs, also persist to the Obsidian vault (`zk_ingest` / a vault note). Commit it.

**Spec self-check:** after writing the spec, look at it with fresh eyes:

1. **Placeholder scan:** any "TBD", "TODO", unfinished sections, vague requirements? Fix.
2. **Internal consistency:** contradictions between sections? Does the architecture match
   the feature description?
3. **Scope check:** focused enough to cover with one implementation plan, or does it need
   further splitting?
4. **Ambiguity check:** any requirement readable two ways? Pick one and state it.

Fix problems inline. No re-review — fix and move on.

**User review gate:** after the self-check, ask the user to review the written spec:

> "The spec is written and committed to `<path>`. Please review it and tell me if you
> want any changes before we start writing the implementation plan."

Wait. If they want changes, make them and re-run the self-check. Only continue after
approval.

**Implementation:** hand off to the `writing-plans` skill to create the detailed
implementation plan. For non-trivial designs, first stress-test the approved spec through
`grill-me-with-docs` (one-question-at-a-time decision-tree interview; captures resolved
terms to `CONTEXT.md` and hard-to-reverse decisions as ADRs), *then* write the plan and
run `/plan-execute`. For genuinely simple designs, go straight to `writing-plans`. See
the full build chain in `writing-plans`.

## Core principles

- **one decision at a time** — don't fire multiple questions at once
- **prefer structured choices** — easier to answer than open-ended
- **strict YAGNI** — remove unnecessary features from every design
- **explore alternatives** — always 2-3 options before deciding
- **incremental validation** — present design, get approval, then continue
- **stay flexible** — go back and clarify when something is unclear

## Visual companion

A companion tool for showing prototypes, diagrams, and visual options during
brainstorming. It is a tool, not a mode. When you expect upcoming questions to involve
visual content (prototypes, layouts, diagrams), offer it once to get consent:

> "Some of what we discuss next might be clearer shown visually. I can produce
> prototypes, diagrams, side-by-side comparisons. It can be token-heavy. Want to try it?"

**This offer must be its own message** — don't merge it with a clarifying question.
Wait for the reply. If declined, continue text-only.

Per-question decision: judge by "is this easier to *see* than to *read*?" Use the visual
path for inherently visual content (prototypes, wireframes, layout comparisons,
architecture diagrams); use text for conceptual content (requirement questions, concept
choices, trade-off lists).
