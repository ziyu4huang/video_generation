---
type: task
blocking: 02
status: open
---

# 03 — Wire the harvest into the workflow docs + glossary

## Question

Does every fresh session discover "dispatch-with-name → harvest → cite
receipt" as THE reviewer-gate procedure without reading a memory note?

## What to build

Docs-as-code wiring, shaped by t01's verdict (primary vs fallback wording,
D2): (a) devops-workflow SKILL.md's review phase names the harvest command
as the gate closer (dispatch reviewer with a name, run the tool, cite the
receipt file in the PR body — TaskStop after harvest); (b) the
using-s2-agent-skills route-gate table's review/dispatch rows point at it;
(c) session-closeout SOP (`docs/agents/session-closeout-sop.md`) gains the
inbox re-read-at-start prompt (the #2122 pattern: delayed verdicts may
carry actionable findings against already-merged code); (d) the owning
package's CONTEXT.md gains glossary terms — **Reviewer harvest** and
**Lead inbox injection** — each with an `_Avoid_` line, plus the
CONTEXT-MAP entry if a new context is created. Where a doc promises
notifications, reconcile it with the t01 verdict.

## Acceptance

- [ ] devops-workflow SKILL.md review phase + using-s2-agent-skills gates
      reference the harvest command by exact invocation.
- [ ] session-closeout SOP carries the inbox re-read prompt.
- [ ] CONTEXT.md glossary entries landed (with `_Avoid_` lines), cited
      terms follow `ADR-<context>-NNNN` style where applicable.
- [ ] No doc still instructs waiting on reviewer notifications
      unreconciled with the t01 verdict.
