---
type: task
status: open
blocked by:
findings: P1
---

# 15 — Next-ticket routing doesn't trigger ask-user / wayfind (post-merge succession is ad hoc)

## Problem

After a ticket's PR merges, selecting the next ticket is done manually and
inconsistently: the agent re-reads `map.md` by hand and posts a free-text
"Next? 1/2/3" menu. Nothing fires automatically on merge to route the next
ticket, and the `ask_user_question` tool — which exists for exactly this kind
of structured choice — is underused for routing. Deterministic succession per
the map's order is therefore done by hand, and genuine forks are not reliably
surfaced through the structured-ask path.

Observed while executing this effort: after #1051 (ticket 01) and #1053
(ticket 02) merged, the agent posted free-text next-step menus instead of
(a) auto-continuing per the map's deterministic order, or (b) using
`ask_user_question` at the real fork. The one place the structured ask WAS
used correctly — ticket 01's implement-vs-delete decision — shows the tool
works when invoked; the gap is that nothing triggers it for routing.

## Evidence

- `map.md` defines a deterministic suggested order `01 → 07 → 04+09 → 03 → 10,11 → 12,13 → 05,06,08,14` — i.e. most successions are NOT forks.
- No post-merge hook routes the next ticket: PR merge emits no "consult map → propose next → ask" step.
- The agent has an `ask_user_question` tool but used free-text menus for ticket selection (post-#1051, post-#1053).
- Correct usage exists at real forks: ticket 01's (a)/(b) decision was routed through `ask_user_question`.

## Approach

Two layers:

1. **Agent behavior (immediate, no code)** — adopt the rule:
   - If the map's next step is **deterministic** (no fork), **auto-continue** — do not post a menu.
   - If the next step is a **genuine fork** (mutually-exclusive options with real trade-offs), route via `ask_user_question` (structured options + recommendation), not free text.
   - Reserve free-text "anything else?" for open-ended input only.
2. **Systemic (optional, wayfind-owned)** — a wayfind post-merge routing step that, after a ticket merges, reads the effort map, identifies the next ticket (or the next fork), and either auto-continues or triggers the structured ask. Decide whether this belongs in wayfind or the agent core loop; record as an ADR if pursued.

## Acceptance

- [ ] Agent follows the rule: deterministic map succession → auto-continue; forks → `ask_user_question`. (Observable: no more free-text "Next? 1/2/3" menus for deterministic steps.)
- [ ] This ticket itself is handled per the rule (it is a process note, orthogonal to the code-ticket order — action when convenient).
- [ ] (Optional) Decision recorded on whether wayfind owns a post-merge routing hook.

## Notes

Process finding discovered during execution of the core-task-review, not from
the original H/M/L source review — labeled `P1` (process). Orthogonal to the
code tickets 01–14; can be actioned any time. Layer 1 is a zero-cost
agent-behavior change; layer 2 is a wayfind product decision.
