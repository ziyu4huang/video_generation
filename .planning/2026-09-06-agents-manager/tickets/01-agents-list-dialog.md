# 01 — `/agents` read-only list dialog

## Done when
- `pi.registerCommand("agents", …)` in s2-agent-ext-subagent opens a
  `ui.custom` dialog (the `/subagents` pattern: stateful component +
  render/invalidate/handleInput).
- Lists ALL registered agentTypes grouped by source — project, user, pack,
  builtin — each row: name + description (width-capped) + model/tier +
  tools-count + isolation glyph; cursor (▶) with j/k or arrows.
- enter → detail pane: full frontmatter fields + the prompt body (wrapped to
  render width); esc returns to list; esc again closes.
- Static content → NO live timer (hasLiveContent-style rule); BUN_PI_SUBAGENT=0
  registers nothing; no global key claimed (ADR-subagent-0004 untouched).
- Unit tests: grouping order (project > user > pack > builtin), render
  totality on partial frontmatter, command registration + disable-gate.
