---
name: writing-skills
description: Use when creating new skills, editing existing skills, or verifying skills work before deployment. Also use when creating or editing any document an agent consumes — AGENTS.md, CONTEXT.md, pointed-at docs.
---

# Writing Skills

## Overview

**Writing skills IS Test-Driven Development applied to process documentation.**
Write test cases (pressure scenarios with subagents), watch them fail (baseline
behavior), write the skill, watch tests pass, refactor (close loopholes).

**Core principle:** If you didn't watch an agent fail without the skill, you
don't know if the skill teaches the right thing.

**REQUIRED BACKGROUND:** superpowers:test-driven-development (the
RED-GREEN-REFACTOR cycle this skill adapts). Official authoring practices:
[anthropic-best-practices.md](anthropic-best-practices.md).

Personal skills live in your runtime's skills directory (`~/.claude/skills/`
on Claude Code; see [codex-tools.md](../using-superpowers/references/codex-tools.md)
/ [gemini-tools.md](../using-superpowers/references/gemini-tools.md);
`~/.agents/skills/` is a cross-runtime alias).

## What is a Skill?

A **skill** is a reference guide for proven techniques, patterns, or tools —
reusable, broadly applicable, referenced across projects. NOT a narrative about
how you solved a problem once.

**Create when:** the technique wasn't obvious; you'd reference it again; it
applies broadly; others benefit.
**Don't create for:** one-offs; standard practices documented elsewhere;
project-specific conventions (instructions file); mechanical constraints
(automate with validation — save documentation for judgment calls).

**Types:** Technique (concrete steps), Pattern (mental model), Reference
(API/syntax docs).

## TDD Mapping

| TDD | Skill creation |
|---|---|
| Test case | Pressure scenario with subagent |
| Production code | SKILL.md |
| RED | Agent violates rule without skill (baseline) |
| GREEN | Agent complies with skill present |
| Refactor | Close loopholes, maintain compliance |

Write the test first: run the baseline BEFORE writing the skill; document exact
rationalizations; write the minimal skill addressing them; verify compliance;
iterate.

## SKILL.md Structure

```
skills/skill-name/SKILL.md   # required; supporting files only if needed
```

Frontmatter: `name` (letters/numbers/hyphens) + `description` (required; max
1024 chars total). Description: third-person, ONLY when to use — start with
"Use when...", include specific triggers/symptoms/contexts, NEVER summarize the
process (see SDO).

Body skeleton: Overview (core principle 1-2 sentences) → When to Use
(symptoms; when NOT to) → Core Pattern (before/after comparison) → Quick
Reference (table) → Implementation (inline code <50 lines; link separate files
for heavy reference 100+ lines or reusable tools) → Common Mistakes.

## Skill Discovery Optimization (SDO)

Future agents must FIND the skill. Discovery flow: problem → search
descriptions → match → scan overview → read quick reference → load example only
when implementing. Put searchable terms early and often.

### Description = When to Use, NOT What the Skill Does

A description that summarizes workflow creates a shortcut agents take — the
body becomes documentation agents skip. Tested case: a description saying
"code review between tasks" made an agent do ONE review where the flowchart
mandated TWO; changing to triggering-conditions-only fixed it.

```yaml
# BAD: summarizes workflow — agents follow this instead of reading the skill
description: Use when executing plans - dispatches subagent per task with code review between tasks
# GOOD: triggering conditions only
description: Use when executing implementation plans with independent tasks in the current session
```

Describe the *problem* (race conditions, inconsistent behavior), not
language-specific symptoms — unless the skill is technology-specific, then say
so explicitly. Third person. Keywords an agent would search: error messages
("ENOTEMPTY"), symptoms ("flaky", "hanging"), synonyms ("timeout/hang/freeze"),
real tool/command names.

### Naming

Active voice, verb-first, gerunds for processes: `condition-based-waiting` >
`async-test-helpers`; `root-cause-tracing` > `debugging-techniques`; name by
what you DO or the core insight.

### Token Efficiency

Frequently-loaded skills spend tokens every turn. Targets: getting-started
<150 words; frequently-loaded <200; others <500.

- Move details to `--help` ("supports multiple modes and filters — run
  --help") instead of documenting every flag.
- Cross-reference instead of repeating ("REQUIRED: use [other-skill] for
  workflow") — but never `@path` links: they force-load files, burning context.
- Compress examples (dialogue to one line each); one example per pattern.
- Eliminate redundancy with cross-referenced skills and with what's obvious
  from the command.
- Verify: `wc -w skills/path/SKILL.md`.

## Flowcharts

Use ONLY for: non-obvious decision points; loops where you might stop too
early; A-vs-B choices. Never for reference material (tables), code examples
(markdown blocks), or linear steps (numbered lists). Style:
[graphviz-conventions.dot](graphviz-conventions.dot); render with
`./render-graphs.js ../skill [--combine]`.

## Code Examples

One excellent example beats many mediocre ones: complete, runnable, commented
on WHY, from a real scenario, ready to adapt. Choose the most relevant language
(testing→TS/JS, systems→shell/python). Never implement in 5+ languages or write
fill-in-the-blank templates.

## File Organization

Self-contained (everything inline) | + reusable tool (SKILL.md + example code)
| + heavy reference (SKILL.md + 600-line API docs + scripts). Heavy reference
(100+ lines) and reusable tools get separate files; principles and short
patterns stay inline.

## The Iron Law

```
NO SKILL WITHOUT A FAILING TEST FIRST
```

Applies to NEW skills AND EDITS. Wrote it before testing? Delete it, start
over. No exceptions: not for "simple additions", "just a section",
"documentation updates"; don't keep untested changes as "reference"; don't
"adapt" while running tests; delete means delete.

## Match the Form to the Failure

Classify the baseline failure BEFORE writing guidance — the form that
bulletproofs one failure type measurably backfires on another.

| Baseline failure | Right form | Wrong form |
|---|---|---|
| Violates rule under pressure (knows better) | Prohibition + rationalization table + red flags | Soft guidance ("prefer…", "consider…") |
| Output has wrong shape (bloat, buried verdict) | Positive recipe: state what the output IS, its parts in order | Prohibition list ("don't restate") |
| Omits required element | Structural: REQUIRED slot in the template | Prose reminders |
| Behavior depends on condition | Conditional on observable predicate ("if the brief exists, reference it") | Unconditional rule + exemption clauses |

Prohibitions backfire on shaping problems: under a competing incentive, agents
negotiate with "don't X" — head-to-head wording tests showed the prohibition
arm produced MORE of the unwanted content than even the no-guidance control.
A recipe leaves nothing to negotiate: output matches the stated shape or not.

Rules for any form:
- **No nuance clauses** — "don't X unless it matters" reopens negotiation (a
  single nuance clause degraded a winning recipe from consistent to noisy).
- **Exemption clauses don't scope** — "this limit doesn't apply to code blocks"
  still suppresses code blocks; restructure so the rule can't reach it.

## Bulletproofing (discipline skills only)

For discipline failures (knows the rule, skips it under pressure). For
shape/omission failures use Match-the-Form — prohibition toolkits backfire.

- **Close every loophole explicitly**: state the rule AND forbid specific
  workarounds ("delete means delete; don't keep as reference; don't adapt
  while testing").
- **Cut spirit-vs-letter arguments early**: "Violating the letter of the rules
  is violating the spirit of the rules."
- **Rationalization table**: every excuse from baseline testing, with its
  reality.
- **Red flags list**: self-check triggers ("This is different because…" →
  STOP, start over).
- **Update the description** with about-to-violate symptoms.

Psychology foundation: [persuasion-principles.md](persuasion-principles.md)
(Cialdini 2021; Meincke et al. 2025).

## Testing by Skill Type

| Type | Test with | Success |
|---|---|---|
| Discipline (TDD, verification) | Academic questions; pressure scenarios; combined pressures; rationalization counters | Follows rule under max pressure |
| Technique (how-to) | Application, variation, missing-info scenarios | Applies technique to new scenario |
| Pattern (mental model) | Recognition, application, counter-examples | Knows when/how — and when NOT — to apply |
| Reference (API docs) | Retrieval, application, gap tests | Finds and correctly applies info |

Complete methodology (pressure types, plugging holes, meta-testing):
[testing-skills-with-subagents.md](testing-skills-with-subagents.md).

## Rationalizations for Skipping Tests

| Excuse | Reality |
|---|---|
| "Obviously clear" | Clear to you ≠ clear to other agents. Test it. |
| "Just a reference" | References have gaps. Test retrieval. |
| "Overkill" | Untested skills have issues. Always. |
| "I'll test if problems emerge" | Problems = agents can't use it. Test BEFORE deploying. |
| "No time" | Deploying untested wastes more time fixing later. |

All mean: test before deploying. No exceptions.

## RED-GREEN-REFACTOR

- **RED:** run pressure scenarios WITHOUT the skill; document choices, verbatim
  rationalizations, triggering pressures.
- **GREEN:** write the minimal skill addressing exactly those rationalizations;
  re-run scenarios; verify compliance.
- **REFACTOR:** new rationalization → explicit counter → re-test until
  bulletproof.

**Micro-test wording before full scenarios** (scenarios are slow; wording is
cheap to verify):
1. One fresh-context sample per call (raw API or single-shot subagent); system
   prompt = the REALISTIC context the guidance will live in; user message = a
   task tempting the failure.
2. Always include a no-guidance control — if the control doesn't exhibit the
   failure, there is nothing to fix; stop.
3. 5+ reps per variant — single samples lie.
4. Manually read every flagged match — echoes and quoted counter-examples
   masquerade as hits.
5. Variance is a metric — five different interpretations across five reps
   means the wording isn't binding; tighten the form before adding words.

Micro-tests verify wording; they do not replace pressure scenarios for
discipline skills.

## Anti-Patterns

- ❌ Narrative examples ("in session 2025-10-03 we…") — too specific, not
  reusable.
- ❌ Multi-language dilution — mediocre quality, maintenance burden.
- ❌ Code in flowcharts — can't copy-paste.
- ❌ Generic labels (helper1, step2) — labels carry meaning.
- ❌ Batching skills without testing each — deploying untested skills =
  deploying untested code.

## Checklist (create a todo per item)

RED: baseline scenarios (3+ combined pressures for discipline skills) run;
verbatim failures documented; rationalization patterns identified.
GREEN: name uses letters/numbers/hyphens; frontmatter `name`+`description`
(max 1024 chars), "Use when…" + triggers, third person; keywords for search;
overview with core principle; addresses the specific baseline failures; form
matches failure type (Match-the-Form); behavior-shaping wording micro-tested
vs no-guidance control (N/A for pure reference); code inline or linked; ONE
excellent example; scenarios WITH skill verify compliance.
REFACTOR: new rationalizations countered; rationalization table built; red
flags list; re-test until bulletproof.
Quality: flowchart only if decision non-obvious; quick-reference table; common
mistakes section; no storytelling; supporting files only for tools/heavy
reference.
Deploy: commit + push; consider upstream PR if broadly useful. NEVER move to
the next skill before this one is verified.

## Beyond skills: any document an agent consumes

Same craft for AGENTS.md, CONTEXT.md, pointed-at docs — packaging differs,
writing doesn't:

- **Context pointers** — out-of-context material named in-context plus the
  condition for reaching it. Front-load the leading word; one trigger per
  branch; a must-have behind a weakly-worded pointer is a variance bug.
- **Two loads** — context load (always-loaded tokens spent every turn) vs
  cognitive load (which docs exist when; the human is the index). Pointers
  escape context load at the pointer's price.
- **Information hierarchy** — in-file step → in-file reference → disclosed
  reference (behind a pointer). Progressive disclosure: inline what every
  branch needs; push behind pointers what few reach; co-locate a concept's
  definition/rules/caveats. Sprawl is cured by the ladder, not by trimming
  words.
- **Completion criteria** — every step ends on one; checkable AND exhaustive
  ("every modified model accounted for" beats "produce a change list"); vague
  bounds invite premature completion.
- **Leading words** — compact pretrained concepts (_tight_, _red_) repeated as
  tokens, never sentences; refactor restatements into them. Steer positive —
  prohibition drags the forbidden behavior into context.
- **Pruning** — one meaning, one source of truth; the environment (`--help`,
  scripts, configs) is a source of truth too — restating it is a cache that
  earns its load only when lookup is expensive. Hunt no-op sentences (changes
  nothing vs the model's default → delete the whole sentence). Without
  pruning, documents sediment.

Skill-specific mechanics (frontmatter, invocation choice, router skills):
[SKILL-MECHANICS.md](SKILL-MECHANICS.md).
