---
type: task
status: closed
origin: 2026-08-08-subagent-display-glanceable-by-default/tickets/01-subagents-batch-result-collapse-by-default.md
---

## Resolution

Shipped via #1099 (`feat(subagents): collapse batch result by default, expand on Ctrl-O`). The `subagents` fan-out RESULT now renders a terse batch summary + one-line per-child status by default, reusing the context-widget's collapse/expand path; full per-child output expands on Ctrl-O (all children at once, matching the global toggle). 65619da4 on origin/main.

## Question

The `subagents` (fan-out) tool RESULT displays too much by default: it renders the batch header + EACH child's FULL output verbatim. This is verbose, pushes the conversation down, and is hard to scan — a 5-child research fan-out dumps 5 full reports inline.

**Goal:** collapse the per-child output by default — show the batch summary line (`## subagents batch (N ok · M failed · K skipped) — Xs`) + a one-line status per child — and expand a child's full output only in expand mode (Ctrl-O), reusing the context-widget's collapse/expand pattern (#1078, #1097).

**Current verbose output (example):**
```
## subagents batch (2 ok · 0 failed · 0 skipped) — 185.5s

### [0] (wayfind-skill) done
## Summary
I've located and retrieved the full content of the wayfinder skill...
### Location Summary
- **Source code**: `bun-apps/pi-agent-ext-wayfind/`...
(full child output shown by default — this is the problem)
```

**To resolve, investigate + decide:**
1. Where is the `subagents` tool result rendered? Is it a static result string in the conversation, or does the TUI have a render hook for tool results? Determine the collapse mechanism: can a tool-result be collapsed/expanded interactively (like the context-widget), or must the result FORMAT change to be terser by default + offer a separate expansion path?
2. What does the COLLAPSED view show? Proposal: batch summary + per-child one-liner `[i] (id) <status> · <Xs>` (optionally + the first line of each child's output as a preview).
3. Ctrl-O scope: expand ALL children at once (matching the context-widget's global toggle), or per-child?
4. Reuse the context-widget's collapse/expand infrastructure where possible; avoid a second divergent mechanism.

Related: the live context-widget (running subagents) already does collapse-by-default + Ctrl-O expand. This ticket extends that pattern to the COMPLETED batch-result display.
