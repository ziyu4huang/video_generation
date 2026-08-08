---
effort: 2026-08-08-subagent-expanded-display-flicker
title: Subagent expanded display flickers on large/fast-updating content
status: active
---

## Question

When Ctrl-O expands a subagent tool box and the content is large + updating fast (streaming), the ENTIRE TUI interface flickers — not just the tool box. Make the expanded view stable under fast streaming.

## Map

- [x] ticket 01 — root-cause + fix: Ctrl-O expand + large/fast stream → whole-TUI flicker

## Fog

- Root cause found + fixed (ticket 01 closed).

## Notes

- Reported while watching a fast-streaming subagent expanded via Ctrl-O. The whole interface flickers, not just the box.
- Related COMPLEMENTARY effort: `2026-08-08-subagent-display-glanceable-by-default` (collapsed-display richness/correctness — tickets 01/02/03 done). That effort makes the COLLAPSED view good; THIS effort makes the EXPANDED view stable. Fix location TBD — may land in pi-agent TUI core, not the subagent extension.
