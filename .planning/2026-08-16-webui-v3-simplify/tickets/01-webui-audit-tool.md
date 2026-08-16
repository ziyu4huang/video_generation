---
id: 01
title: "`webui` audit tool in power-tool"
status: open
---

## Goal
Dedicated `webui` tool: single-call automated visual/debug verification of the
live webui (headless Chrome on the browser-tool engine).

## Notes for implementer
- Reuse browser-tool.ts engine parts (chromium launch channel:'chrome'
  headless, run-dir audit under ~/.pi/power-browser/runs/).
- New file src/tools/webui-tool.ts + registration in the power-tool index;
  sibling pattern: inspect-tui.ts / browser-tool.ts.
- Checks (all optional booleans, default all-on): tabs, paneOutline,
  screenshots, consoleErrors, invariants.
- Invariants: exactly-one-active-pane at rest? (no — default state = no pane
  active after v3 t03; v2 = transcript default. Tool must DETECT, not assume:
  report active pane + tab list as-is), ask-* cards in Inbox-equivalent pane,
  viewer cards in Data pane, report articles in Report pane.
- Zero new deps; bun test units for the pure parts (port resolution, report
  formatting); Chrome-gated integration test skip-graceful (pattern exists).

## Done when
- Tool registered + schema-cost measured; units green; integration green on
  machines with Chrome; README row added.
