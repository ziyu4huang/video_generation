# CC-Style Subagent TUI in core-task

> STATUS: COMPLETE — all 8 tickets shipped (#1410/#1412/#1414/#1416/#1425/#1432/#1437/#1441)

## Goal

Deliver Claude-Code-parity (and beyond) subagent TUI on pi-agent: a live **subagents section**
in core-task's composite status widget (always-on per-task rows for foreground AND background
runs), a **completion notification** line, **RunView tokens/cost** projection, **Ctrl-B
backgrounding** (detach a foreground subagent; child survives, RunView stays live), and a
**focusable dock** (Ctrl-G s focus-claim with j/k scroll, x abort, e trace overlay, Ctrl-B
detach, Enter → `/subagents` viewer). The subagent package opens its registry/trace as a
**public surface** consumed by core-task; `subagent-context-widget.ts` retires. Zero
pi-core upstream changes.

- **Sole display home**: the core-task composite widget (new section, order 4) is the single
  below-editor home for subagent run rows; the subagent package owns data/public surface only.
- **Import direction**: core-task imports the subagent package's PUBLIC lib surface (registry
  `views()` + `renderActivityRow` via `@repo/pi-agent-ext-core-runtime`, `formatSubagentTrace`
  via `@repo/pi-agent-ext-subagent/src/subagent-tool-render.js`) — NOT `globalThis` seams.
  The existing `__pi*` seams are legacy; new work uses typed imports.

## Evidence base

- `.planning/REVIEW-2026-08-15-ext-four-packages.md` (REVIEW #1390): §4 subagent TUI surface
  inventory, §5 CC→pi gap map, §7 effort sketch, subagent findings #1/#3 (non-focusable widget
  + `\x0f` byte-sniff; four render vocabularies).

## Cross-references

- `docs/research-tui-agent-webui-hybrids.md` (#1384) — sibling research on display transport;
  the focusable-dock design must stay consistent with it.
- `.planning/2026-08-15-snapshot-row-single-source/` — RunView Phase 2 presentation precedent
  (ActivityRow/RunView discipline this effort extends, not replaces).

## Tickets

Wave 1 (§2): 01 subagents section (DONE #1410) · 02 completion notify (DONE #1412) · 03 RunView tokens/cost
(DONE #1414) · 04 context-widget retirement (DONE #1416) — wave 1 complete 2026-08-15.
Wave 2 (§3): 05 detach pipeline (DONE #1425) · 06 Ctrl-B shortcut (DONE #1432) — wave 2
complete 2026-08-15 (06 also shipped accidentally as #1433, a content-identical duplicate;
no net effect).
Wave 3 (§4): 07 focus-claim ADR + protocol (#1437) · 08 dock implementation (#1441).
