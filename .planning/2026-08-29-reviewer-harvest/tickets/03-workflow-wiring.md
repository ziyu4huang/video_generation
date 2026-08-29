---
type: task
blocking: 02
status: closed
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

- [x] devops-workflow SKILL.md review phase + using-s2-agent-skills gates
      reference the harvest command by exact invocation.
      (devops-workflow §2c "Independent reviewer gate" — primary/fallback
      wording, exact invocation, receipt citation, TaskStop-after-harvest,
      inbox re-read note + a "When to use which tool" table row;
      using-s2-agent-skills override-table "dispatch a subagent for writes"
      row points at the same command + §2c.)
- [x] session-closeout SOP carries the inbox re-read prompt.
      (session-closeout-sop §B step 1: re-read
      `~/.claude-glm/teams/session-*/inboxes/team-lead.json` at session
      start, the #2122 delayed-REQUEST_CHANGES pattern.)
- [x] CONTEXT.md glossary entries landed (with `_Avoid_` lines), cited
      terms follow `ADR-<context>-NNNN` style where applicable.
      (devops CONTEXT.md "Reviewer gate" section: **Reviewer harvest** +
      **Lead inbox injection**, each with `_Avoid_`; no ADR-style decisions
      added — the probe verdicts live in this effort's `## Decisions`
      frontier + D1–D3, which is the house rule for non-hard-to-reverse
      outcomes. CONTEXT-MAP already listed devops — no new context.)
- [x] No doc still instructs waiting on reviewer notifications
      unreconciled with the t01 verdict.
      (grep over devops/subagent skills + using-s2-agent-skills + CLAUDE.md:
      the only "wait for notification" wording is s2-agent's OWN in-process
      subagent machinery (`list_subagent_runs wait`, ParentMessageBus) —
      measured healthy, different layer from the harness injection RCA.
      The RCA memory note was already amended by t01's close-out with the
      2.1.250 result — verified, no edit owed.)
