---
type: task
status: closed
origin: 2026-08-08-subagent-display-glanceable-by-default/tickets/02-live-display-hint-what-its-working-on.md
---

## Resolution

Added `workIntentPreview()` display-only helper in `subagent-tool.ts` that strips a leading "Working dir:"/"Cwd:"/"Repo:" preamble line from subagent tasks, surfacing the first actual work-intent line instead of boilerplate. Applied it in `renderSubagentCall()` — because `subagent-context-widget.ts` reuses `renderSubagentCall`, this single edit fixes both the inline live-display header AND the docked context-widget header. Raw `taskPreview()` usages in `execute()`'s persisted run records and `/subagents` viewer remain verbatim. +8 tests (7 for `workIntentPreview`, 1 for `renderSubagentCall` integration); gate green at 532 pass.

## Question

The LIVE subagent display (the inline tool-execution panel shown while a `subagent`/`subagents` dispatch runs in the foreground) is too sparse — "just a simple box(panel)" that doesn't convey what the subagent is actually working on.

**Current (example):**
```
subagent ▸ shipper ▸ tier:small ▸ deepseek/deepseek-v4-flash ▸ "Working dir: /Users/huangziyu/proj/video_generation__subage…"
↳ bash → done
  ↳ 30.8s elapsed · 7 tool calls
```

**Problems:**
1. Task preview shows BOILERPLATE — `"Working dir: /Users/.../subage…"`. Most subagent tasks start with "Working dir: <path>", so the first ~60 chars (the preview) never reveal the actual work intent — the user can't tell what the subagent is doing.
2. Activity line `↳ bash → done` is terse — doesn't say what the command was. A verb-led phrase (`Running: git status`, via the formatToolAction engine from #1077) would be clearer. Investigate WHY the live path shows `bash → done` instead of the verb-led phrase — is the streaming renderer different from the completed one?
3. Progress `30.8s elapsed · 7 tool calls` is mechanics only — no "current focus."

**Goal:** the live display should HINT what the subagent is working on at a glance — the work intent (not boilerplate), a richer current-activity line, maybe a one-line "current focus" — so the user knows what each running subagent is doing without expanding.

**To resolve, investigate + decide:**
1. Where does the task preview come from (`slot.task`/`taskPreview`, truncated ~60 chars)? How to surface the actual WORK INTENT instead of the "Working dir:" boilerplate — strip the prefix? show a later/summary line of the task? derive a short label?
2. What does the streaming (`isPartial`) renderCall/renderResult currently produce? (`subagent-tool.ts` renderCall ~867, renderResult ~882 → renderSubagentResult ~444; the 2-line progress header.) Why does the activity show `bash → done` (terse) instead of the verb-led phrase — is the live path using a different renderer than the completed path?
3. Does the docked context-widget (background runs, #1077-1097) have the SAME boilerplate-preview issue? (It renders `subagent ▸ agent ▸ model ▸ "taskPreview"` — same truncation.) Should this fix apply to BOTH the inline live display AND the context-widget (shared task-preview helper)?
4. Reuse `formatToolAction` (#1077) for the activity line; reuse `latestMessageLine` (#1097) patterns where applicable.

Related: ticket 01 collapses the COMPLETED batch result (too VERBOSE). This ticket is the opposite — the LIVE display is too SPARSE, needs richer hints. Both are subagent-display surfaces under this effort.
