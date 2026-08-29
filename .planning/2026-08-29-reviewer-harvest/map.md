---
effort: 2026-08-29-reviewer-harvest
created: 2026-08-29
last: 2026-08-29 (ticket 01 closed — injection WORKS on CLI 2.1.250, ≤45s; notifications revert to primary, harvest tool = fallback + receipt)
status: active
---

# Wayfinder map: 2026-08-29-reviewer-harvest

## Destination

The independent-reviewer gate works as first-class repo tooling: dispatch a
named reviewer, run one command, get the verdict + a citable receipt — no
session ever waits on the broken child→lead injection again. A recorded
probe decides notifications-vs-harvest as primary; the docs make the
procedure discoverable without memory.

## Context

- MEASURED (closed RCA, 2026-08-28, on-disk receipts): stock claude 2.1.247
  completes child subagents correctly (probe task done in 31s,
  SendMessage→team-lead `success:true`) but injects ZERO lead-turn
  notifications; amended the same evening — injection is EXTREMELY DELAYED
  (verdicts arrived >24h late, next session). reviewer-strip's
  REQUEST_CHANGES finished 30s after a nudge yet the parent TaskStop'd it
  blind (19:58:29 vs verdict 19:54:58); 24 unread finder messages sat in
  `~/.claude-glm/teams/session-5964d553/inboxes/team-lead.json` (42 KB);
  #2122 was born from a 24h-late REQUEST_CHANGES against already-merged
  #2098 (both blockers real).
- VALIDATED workaround (first production use PR #2112, 2026-08-28):
  reviewer-addendum dispatched with a name; verdict (APPROVE, 5
  fact-checks) harvested from its transcript at 75s+60s polls; transcript
  path cited in the PR body; TaskStop after. The SOP works — it is just
  not productized.
- Root cause is harness-side (stock claude binary) — NO repo fix exists for
  injection itself; the repo deliverable is probe + productization (D2).
- User re-scope 2026-08-29: the win32-launcher-stdout effort is PARKED to
  the `video_generation__deploy` worktree (PR #2128, its next-goal
  handoff); this worktree owns s2-agent-ext-subagent +
  s2-agent-ext-ultracode.

## Tickets

**Execution order:** 01 → 02 → 03 (fully forced by `blocking:` edges —
01's verdict words 02's docs and decides primary-mode; 02's tool is what
03 wires; confirmed 2026-08-29).

| Ticket | Status | Summary |
|---|---|---|
| `tickets/01-injection-reprobe.md` | closed | CLI 2.1.250 probe: notification OBSERVED ≤45s (RCA baseline 2.1.247 = never/>24h) — notifications revert to primary; harvest tool stays fallback + receipt writer |
| `tickets/02-harvest-tool.md` | open | reviewer-harvest CLI: locate newest subagent transcript by name, extract verdict, write receipt (throw-free JSON contract) |
| `tickets/03-workflow-wiring.md` | open | devops-workflow review phase + skills gates + closeout SOP + CONTEXT.md glossary name the procedure |

## Decisions

- D1 (2026-08-29, grill — user): anchor = reviewer-gate fix, shape =
  probe + SOP productization. (Declined: probe-only; TUI message-bus
  rework.)
- D2 (2026-08-29, grill — user): probe FIRST; its receipt decides
  notifications-vs-harvest primary mode. The harvest tool is built either
  way (fallback + receipt writer).
- D3 (2026-08-29, grill — user): scope = subagent + ultracode families;
  ultracode lanes (/loop resume pty, 900s-FAIL recurrence) stay
  ranked-dormant, not tickets.

## Frontier

Ticket 02 (harvest tool) — ticket 01 closed 2026-08-29 with the verdict
**injection WORKS on CLI 2.1.250 (notification observed ≤45s into the
lead's conversation, mid-turn; probe transcript 8 lines, SendMessage
receipt on disk)**: notifications revert to PRIMARY, so t02's tool lands
as the FALLBACK + durable receipt writer (one command away on any
regression), and t03 wires docs accordingly (primary = reply to the
notification; fallback = harvest; inbox re-read at session start stays —
the >24h delay mode would not show in a 45s window). The RCA memory note
should be annotated by t03 or t02's close-out: 2.1.247→2.1.250 fixed
prompt injection for this probe shape.

## Fog of war

- Current installed claude CLI version at probe time: unknown until t01
  runs (the RCA measured 2.1.247; the binary may have moved).
- Whether s2-agent's OWN TUI child→parent message bus shares the failure:
  no measured incident — parked; probe only if a TUI-side silent reviewer
  is ever observed.
- Ultracode dormant lanes (D3): /loop resume-session live pty lane;
  ultracode-pty 900s-FAIL recurrence capture (trigger-gated on a FAIL).

## Cross-effort links

Shares-decision-with: 2026-08-28-win32-launcher-stdout — sibling outcome of
the same user re-scope 2026-08-29 (that effort parked to the deploy
worktree; this one is what this worktree does instead). Its D4 named this
reviewer fix as "the next effort" — this effort IS that promise kept.
