---
type: research
status: closed
---

# 01 — Skills inventory: weight, usage, retire mechanism

## Question

What is each skill's prompt-weight contribution, which skills are referenced or
used, and what mechanism exists for retiring/excluding skills — so the
retirement and compression decisions (tickets 04, 05) rest on facts, not guesses?

## Findings (charted 2026-07-26)

**Line counts (weight proxy), markdown only** — 15 skills, ~8.5k lines total:

| skill | lines | share |
|---|---|---|
| writing-skills | 2589 | 30% |
| systematic-debugging | 1017 | 12% |
| subagent-driven-development | 936 | 11% |
| test-driven-development | 619 | 7% |
| brainstorming | 491 | 6% |
| requesting-code-review | 267 | 3% |
| writing-plans | 217 | 3% |
| receiving-code-review | 205 | 2% |
| finishing-a-development-branch | 201 | 2% |
| using-superpowers | 192 | 2% |
| using-git-worktrees | 167 | 2% |
| dispatching-parallel-agents | 167 | 2% |
| verification-before-completion | 120 | 1% |
| executing-plans | 64 | 1% |

`writing-skills` is the dominant target — it alone is ~30% of all skill weight.

**Cross-references** — all 15 skills are referenced by *something* (no orphan by
reference graph). Most-referenced: `test-driven-development` (5×),
`finishing-a-development-branch` (5×), `using-git-worktrees` (3×),
`subagent-driven-development` (3×). Reference count ≠ runtime usage, so
"unused" must be judged on capability/value, not graph degree.

**Retire mechanism already exists** (`src/superpowers.ts`):
- `DEFAULT_SKILL_EXCLUDE = ["verification-before-completion"]` — one skill is
  already excluded by default (saves ~139 tok/req; rationale: the model resists
  confidence-escalation even without it).
- `PI_SUPERPOWERS_SKILL_EXCLUDE` env — comma-list of skill dir-names to unregister.
- `PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS` env — disable the defaults for a fat-run.

➡️ Retiring a skill = adding its dir-name to `DEFAULT_SKILL_EXCLUDE`. Reversible
via env, low-risk. Compression (vs full retire) still needs in-file editing.
