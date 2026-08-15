---
type: research
status: closed
claimed: chart-session-2026-07-22
---

## Question

Survey EVERY claude-code (superpowers) skill reference to subagent dispatch, so "fulfill the same usage requirements" is exhaustive and nothing is missed at chart time. What exactly does each skill expect of a subagent surface?

## Resolution

Grepped `bun-apps/pi-agent-ext-superpowers/skills/**/*.md` for `subagent`. Seven skills touch subagent dispatch; the full requirement surface:

| Skill | What it needs from the subagent surface |
|---|---|
| `subagent-driven-development` | Fresh implementer per task; per-role model selection ("always specify model"); **status contract** `DONE\|DONE_WITH_CONCERNS\|BLOCKED\|NEEDS_CONTEXT` reported back; report written to a REPORT_FILE; reviewer dispatched with a diff file; durable progress ledger (`.superpowers/sdd/progress.md`); re-review loops; final whole-branch review. Templates: `implementer-prompt.md`, `task-reviewer-prompt.md`. Scripts: `task-brief`, `review-package`, `sdd-workspace`. |
| `dispatching-parallel-agents` | N concurrent subagent dispatches issued in **one response** = parallel execution. One agent per independent problem domain. |
| `requesting-code-review` | Dispatch a `general-purpose` subagent with `code-reviewer.md` template; reviewer gets crafted context, never session history. |
| `brainstorming` | `spec-document-reviewer-prompt.md` — dispatch a spec reviewer subagent. |
| `writing-plans` | `plan-document-reviewer-prompt.md` — dispatch a plan reviewer subagent. Recommends `subagent-driven-development` as the execution sub-skill. |
| `writing-skills` | `testing-skills-with-subagents.md` — pressure-test a skill by dispatching subagents with/without it; baseline vs compliant behaviour. |
| `using-superpowers` | `references/pi-tools.md` is the **pi-port glue** (byte-identical exception): "Use the `subagent` tool provided by `pi-agent-ext-workflow` — `subagent({ task, model, tools, excludeTools, cwd })`. It covers SDD's implementer/reviewer dispatch; it does NOT provide chains/parallel/async/clarify in v1." |

**Key shape of the status contract** (from `implementer-prompt.md` "Report Format"): the implementer writes a full report to a file, then returns a **≤15-line prose block** whose first structured line is literally `- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT`. So today the contract is a prose prefix the controller parses — there is no machine-readable field.

**Implication for the map:** "fulfill" = (a) make that status machine-readable, (b) make the file-handoff helpers work on pi, (c) add the durable ledger, (d) route parallel through the workflow engine, (e) keep the reviewer dispatch working, (f) update the `pi-tools.md` glue as gaps close. These become tickets 04–11.
