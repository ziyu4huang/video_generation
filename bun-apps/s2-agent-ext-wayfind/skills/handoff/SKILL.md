---
name: handoff
description: Use when a session is ending and a fresh agent must pick up the work — compacts the conversation into a handoff doc in the OS temp dir, redacting secrets and pointing at existing artifacts.
disable-model-invocation: true
---

# Handoff

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save it to the **OS temp dir** (`$TMPDIR` on macOS, `/tmp` elsewhere) — not the workspace — so it rides out a context reset without polluting the repo. Report the path to the user.

Include a **"Suggested skills"** section listing skills the next agent should `read` (by skill name) for the upcoming work.

Do not duplicate content already captured in other artifacts — specs (`.planning/<effort>/spec.md`), plans (`task_plan.md`), ADRs (`docs/adr/`), tickets (`.planning/<effort>/tickets/`), GitHub issues, commits, or diffs. Reference them by path or URL instead.

Redact any sensitive information — API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.

## Wayfind efforts — use `/wayfind handoff` instead

If the session is ending with an active wayfind effort whose tickets are NOT all closed,
do not freehand this doc: run `/wayfind handoff [effort]`. It writes the strict v2
next-goal contract (`output/next-goal-YYYYMMDD-HHMMSS.md`, validated by
`s2-agent-ext-devops/scripts/validate-next-goal.ts`) with the open tickets carried into
Honest gaps / Immediate steps / Done when. This temp-dir handoff may still complement it
for conversational context, but the ticket-carrying next-goal file is mandatory — a
session never just stops with open wayfind tickets.
